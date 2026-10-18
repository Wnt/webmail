import { act, render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Performance regression budget (2026-10-19): with "mark as read: instantly"
// the reading pane marked an unread message read as soon as it had the
// message - before its body was on screen - so the write, its store update
// and the refreshes it set off competed with the first paint (measured on a
// page opened at a notification's link: the Email/set left before the body
// was painted). It now marks it once the body is on screen (1.5 s at most),
// as the mail app's own instant mark does; moving on before that still
// marks it.

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
const { useSettingsStore } = await import('@/stores/settings-store');
const { bodyReady, __resetOpenTiming } = await import('@/lib/open-timing');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const unread = (id: string): Email => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {},
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ name: 'Bob', email: 'bob@example.test' }],
  subject: 'Synthetic', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hi', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<p>Hello <b>there</b></p>', isTruncated: false } },
} as unknown as Email);

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  __resetOpenTiming();
  useSettingsStore.setState({ markAsReadDelay: 0 });
});

describe('reading pane: instant mark-as-read waits for the body on screen', () => {
  it('does not mark the message read before its body is painted', async () => {
    const onMarkAsRead = vi.fn();
    render(<EmailViewer email={unread('m1')} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onMarkAsRead={onMarkAsRead} />);
    await settle();
    expect(onMarkAsRead).not.toHaveBeenCalled();
    act(() => bodyReady('m1'));
    await settle();
    expect(onMarkAsRead).toHaveBeenCalledTimes(1);
    expect(onMarkAsRead).toHaveBeenCalledWith('m1', true);
  });

  it('moving on to another message before the paint still marks the first one', async () => {
    const onMarkAsRead = vi.fn();
    const view = render(<EmailViewer email={unread('m2')} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onMarkAsRead={onMarkAsRead} />);
    await settle();
    view.rerender(<EmailViewer email={unread('m3')} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onMarkAsRead={onMarkAsRead} />);
    await settle();
    expect(onMarkAsRead.mock.calls.map((c) => c[0])).toEqual(['m2']);
  });
});
