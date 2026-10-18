import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Performance regression budget (2026-10-18): the reading pane sanitizes a
// message body once. Marking the message read (or any keyword change)
// replaces the message object; that re-ran DOMPurify over the whole body right
// after the open, measured at about 110 ms per pass on the lab host. A parent
// re-render with fresh callbacks re-renders nothing, and a repeat open of a
// message shown a moment ago reuses the sanitized body.

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

beforeEach(() => { sanitize.calls = 0; });

describe('reading pane: one sanitize pass per body', () => {
  it('marking the open message read does not sanitize it again', () => {
    const unread = htmlEmail('s1', false);
    const view = render(viewer(unread, 0));
    expect(sanitize.calls).toBe(1);
    // What markAsRead stores: the same message with $seen set.
    view.rerender(viewer({ ...unread, keywords: { ...unread.keywords, $seen: true } }, 1));
    expect(sanitize.calls).toBe(1);
  });

  it('a parent re-render with fresh callbacks does not sanitize again', () => {
    const email = htmlEmail('s2', true);
    const view = render(viewer(email, 0));
    view.rerender(viewer(email, 1));
    view.rerender(viewer(email, 2));
    expect(sanitize.calls).toBe(1);
  });

  it('a repeat open of a recent message reuses its sanitized body', () => {
    const a = htmlEmail('s3', true);
    const b = htmlEmail('s4', true);
    const view = render(viewer(a, 0));
    view.rerender(viewer(b, 1));
    view.rerender(viewer({ ...a }, 2));
    expect(sanitize.calls).toBe(2);
  });
});
