import { render, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Fork (Wnt/webmail), review swipe-preload r1 (R1, R2, R4; the reviewer's
// probes kept as regression tests):
// - per-message state of the reading pane - "Load images", the extracted
//   bodies of plugins, TNEF and message/rfc822 - never carries over to the
//   next message, not even for the renders before the reset effect: the next
//   message is never sanitized or framed under the other's permission;
// - a lite swipe neighbour reads nothing of its body beyond its first lines
//   (no DOM parse of an over-limit body for its attachment chips);
// - the sanitized-body cache hands out a body only for the very text it was
//   made from: another login's message with the same id gets its own body.

const sanitize = vi.hoisted(() => ({ calls: 0, inputs: [] as { html: string; block: boolean }[] }));
vi.mock('@/lib/email-sanitization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email-sanitization')>();
  return {
    ...actual,
    sanitizeEmailBodyForIframe: (...args: Parameters<typeof actual.sanitizeEmailBodyForIframe>) => {
      sanitize.calls++; sanitize.inputs.push({ html: args[0], block: args[1] });
      return actual.sanitizeEmailBodyForIframe(...args);
    },
  };
});
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('@/components/email/email-viewer');
const { __clearEmailContentCache } = await import('@/lib/email-content-cache');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const htmlEmail = (id: string, seen: boolean): Email => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: seen },
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ name: 'Bob', email: 'bob@example.test' }],
  subject: 'Synthetic', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hi', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<table width="100%"><tr><td><p>Hello <b>there</b></p></td></tr></table>', isTruncated: false } },
} as unknown as Email);

const viewer = (email: Email, tick: number) => (
  <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
    onReply={() => tick} onDelete={() => tick} onToggleStar={() => tick} onMarkAsRead={() => tick} />
);


const { useSettingsStore } = await import('@/stores/settings-store');
const { renderHooks } = await import('@/lib/plugin-hooks');
beforeEach(() => {
  sanitize.inputs = []; __clearEmailContentCache();
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: ['trusted@example.test'] });
});
describe('per-message state and the sanitized-body cache', () => {
it('ordinary Load images permission does not carry to another message', () => {
  const a = htmlEmail('ordinary-a', true);
  a.bodyValues!['1'].value = '<img src="https://tracker.example.test/ordinary-a">';
  const view = render(viewer(a, 0));
  fireEvent.click(view.getByText('load_external_content'));
  const b = htmlEmail('ordinary-b', true);
  b.bodyValues!['1'].value = '<img src="https://tracker.example.test/ordinary-b">';
  sanitize.inputs = [];
  view.rerender(viewer(b, 1));
  expect(sanitize.inputs.filter(x => x.html.includes('/ordinary-b')).every(x => x.block)).toBe(true);
});
it('outgoing plugin body is never rendered under incoming trusted sender permission', async () => {
  const oldBody = '<p>EXTRACTED-OLD-BODY</p><img src="https://tracker.example.test/old">';
  const plugin = vi.spyOn(renderHooks.onRenderEmailBody, 'transform').mockImplementation(async (_v, ctx) =>
    (ctx as { id?: string }).id === 'plugin-a' ? { html: oldBody, handledBy: 'test', text: '', attachments: [] } : { html: '', text: '', attachments: [] });
  try {
    const view = render(viewer(htmlEmail('plugin-a', true), 0));
    await act(async () => { await Promise.resolve(); });
    expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-OLD-BODY');
    sanitize.inputs = [];
    const committed = vi.spyOn(Element.prototype, 'setAttribute');
    const b = htmlEmail('trusted-b', true);
    b.from = [{ email: 'trusted@example.test' }];
    view.rerender(viewer(b, 1));
    const staleDocs = committed.mock.calls.filter(([name, value]) => name.toLowerCase() === 'srcdoc' && value.includes('EXTRACTED-OLD-BODY') && value.includes("img-src data: blob: http: https:"));
    committed.mockRestore();
    expect(staleDocs.map(() => 'old body committed with permissive CSP')).toEqual([]);
  } finally { plugin.mockRestore(); }
});

it('lite neighbours do not parse their over-limit HTML for attachment chips', async () => {
  const { SwipePeek } = await import('@/components/email/swipe-peek');
  useSettingsStore.setState({ hideInlineImageAttachments: true, showVerificationCodes: false });
  const e = htmlEmail('large-neighbour', true);
  e.bodyValues!['1'].value = '<p>OVERSIZED-NEIGHBOUR' + 'x'.repeat(210_000) + '</p>';
  e.textBody = [{ partId: '2', type: 'text/plain' }] as Email['textBody'];
  e.bodyValues!['2'] = { value: 'short text', isTruncated: false } as never;
  e.attachments = [{ partId: '3', blobId: 'att', type: 'image/png', size: 10, cid: 'image' }] as Email['attachments'];
  const parser = vi.spyOn(DOMParser.prototype, 'parseFromString');
  try {
    const view = render(<SwipePeek neighbour={{ row: e, email: e }} isDark={false} />);
    expect(view.container.querySelector('[data-swipe-peek="lite"]')).not.toBeNull();
    const oversized = parser.mock.calls.filter(([html]) => String(html).includes('OVERSIZED-NEIGHBOUR') && String(html).length > 200_000);
    expect(oversized.map(([html]) => String(html).length)).toEqual([]);
  } finally { parser.mockRestore(); }
});

it('a neighbour from a different login cannot reuse the first login body', async () => {
  const { SwipePeek } = await import('@/components/email/swipe-peek');
  const a = htmlEmail('overlapping-id', true);
  a.bodyValues!['1'].value = '<p>PRIVATE-LOGIN-A-BODY</p>';
  const first = render(<SwipePeek neighbour={{ row: { ...a, accountId: 'login-a' }, email: a }} isDark={false} />);
  expect(first.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('PRIVATE-LOGIN-A-BODY');
  first.unmount();
  const b = htmlEmail('overlapping-id', true);
  b.bodyValues!['1'].value = '<p>LOGIN-B-BODY</p>';
  const second = render(<SwipePeek neighbour={{ row: { ...b, accountId: 'login-b' }, email: b }} isDark={false} />);
  expect(second.container.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('PRIVATE-LOGIN-A-BODY');
});
});
