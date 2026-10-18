import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Performance regression budget (2026-10-19): a body sanitized ahead of its
// open (the pointer resting on its row, the push worker's kept copy:
// lib/email-content-cache.ts prewarmEmailContent) is shown without a sanitize
// pass at the open - the same result the pane would have made itself.

const sanitize = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/email-sanitization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email-sanitization')>();
  return {
    ...actual,
    sanitizeEmailBodyForIframe: (...args: Parameters<typeof actual.sanitizeEmailBodyForIframe>) => {
      sanitize.calls++;
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

const { EmailViewer } = await import('../email-viewer');
const { prewarmEmailContent, __clearEmailContentCache } = await import('@/lib/email-content-cache');

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

beforeEach(() => { sanitize.calls = 0; __clearEmailContentCache(); });
const idle = () => new Promise((r) => setTimeout(r, 20));

describe('reading pane: a body sanitized ahead of the open', () => {
  it('opens without a sanitize pass', async () => {
    const email = htmlEmail('p1', false);
    prewarmEmailContent(email);
    await idle();
    expect(sanitize.calls).toBe(1);
    render(viewer(email, 0));
    expect(sanitize.calls, 'no pass at the open').toBe(1);
  });

  it('is what the pane would have made itself', async () => {
    const email = htmlEmail('p2', false);
    prewarmEmailContent(email);
    await idle();
    const view = render(viewer(email, 0));
    const shown = view.container.querySelector('iframe[title="Email content"]')?.getAttribute('srcdoc');
    expect(shown).toContain('Hello');
    __clearEmailContentCache();
    view.unmount();
    const fresh = render(viewer({ ...email }, 1));
    expect(fresh.container.querySelector('iframe[title="Email content"]')?.getAttribute('srcdoc')).toBe(shown);
  });

  it('a truncated body is not sanitized ahead', async () => {
    const email = htmlEmail('p3', false);
    (email.bodyValues as Record<string, { value: string; isTruncated: boolean }>)['1'].isTruncated = true;
    prewarmEmailContent(email);
    await idle();
    expect(sanitize.calls).toBe(0);
  });
});
