// Fork (Wnt/webmail), review swipe-trust r1: the parity cases with a stable
// translation function, as the app has. With a new function per render the
// old reading pane re-ran its body memo by accident and set its "blocked"
// flag again after the reset effect cleared it; with a stable one (the app)
// the banner vanished while the pictures stayed blocked - four of these five
// fail on 6fd6d1eb. The reviewer's file, kept as a regression test.
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Fork (Wnt/webmail), owner report 2026-10-20 on Bulwark 6fd6d1eb: while
// swiping, the neighbour pane showed "Images and external content have been
// blocked" for a message that opened without it (the pane had decided before
// the trusted-senders address book loaded and never decided again). The pane
// and the reading pane now share one decision (hooks/use-external-content.ts)
// and one banner rule (showsBlockedContentBanner): for the same message they
// show the same banner and block the same remote content, in every trust
// state, also when the trust data arrives after the pane was drawn.

vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t, useLocale: () => 'en' };
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
const { SwipePeek } = await import('../swipe-peek');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useContactStore } = await import('@/stores/contact-store');
const { __clearEmailContentCache } = await import('@/lib/email-content-cache');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
// Invented senders and a remote image on an invented host.
const UNKNOWN = 'news@unknown-sender.test';
const TRUSTED = 'letters@trusted-sender.test';
const mail = (id: string, from: string): Email => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Examplepaja', email: from }], to: [], subject: `Subject ${id}`, receivedAt: '2026-01-01T00:00:00Z',
  preview: 'p', hasAttachment: false, size: 10, textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: `<p>Body ${id}</p><img src="https://images.example.test/${id}.png">`, isTruncated: false } },
} as unknown as Email);

/** What a view shows for the message: the banner, and whether its frame may load the remote image. */
function state(container: HTMLElement) {
  const frame = container.querySelector('iframe') as HTMLIFrameElement | null;
  const doc = frame?.getAttribute('srcdoc') ?? '';
  return {
    banner: (container.textContent ?? '').includes('external_content_warning'),
    remoteAllowed: /img-src data: blob: http: https:/.test(doc),
    // A blocked image keeps its URL only in data-blocked-src (for "Load images").
    imageLive: / src="https:\/\/images\.example\.test\//.test(doc),
  };
}

function both(email: Email) {
  const peek = render(<SwipePeek neighbour={{ row: { ...email, bodyValues: undefined } as unknown as Email, email }} isDark={false} />);
  const reader = render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  return { peek, reader };
}

beforeEach(() => {
  __clearEmailContentCache();
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [], trustedSendersAddressBook: false } as never);
  useContactStore.setState({ trustedSenderEmails: [], trustedSendersLoaded: false } as never);
});

describe('the swipe neighbour pane and the reading pane decide alike', () => {
  it('an unknown sender with a remote image: banner and blocked image in both', async () => {
    const { peek, reader } = both(mail('u1', UNKNOWN));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(state(peek.container)).toEqual({ banner: true, remoteAllowed: false, imageLive: false });
    expect(state(reader.container)).toEqual(state(peek.container));
  });

  it('a trusted sender (the trusted-sender list): no banner, the image allowed in both', async () => {
    useSettingsStore.setState({ trustedSenders: [TRUSTED] } as never);
    const { peek, reader } = both(mail('t1', TRUSTED));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(state(peek.container)).toEqual({ banner: false, remoteAllowed: true, imageLive: true });
    expect(state(reader.container)).toEqual(state(peek.container));
  });

  it('the trusted-senders address book arriving after the pane was drawn: the pane decides again and matches the reader', async () => {
    useSettingsStore.setState({ trustedSendersAddressBook: true } as never);
    const email = mail('t2', TRUSTED);
    const peek = render(<SwipePeek neighbour={{ row: { ...email, bodyValues: undefined } as unknown as Email, email }} isDark={false} />);
    // Drawn before the book loaded: an unknown sender for now.
    expect(state(peek.container)).toEqual({ banner: true, remoteAllowed: false, imageLive: false });
    act(() => { useContactStore.setState({ trustedSenderEmails: [TRUSTED], trustedSendersLoaded: true } as never); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const reader = render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(state(peek.container)).toEqual({ banner: false, remoteAllowed: true, imageLive: true });
    expect(state(reader.container)).toEqual(state(peek.container));
  });

  it('the "allow" setting: no banner, the image allowed in both; "block": the banner in both', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' } as never);
    let views = both(mail('a1', UNKNOWN));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(state(views.peek.container)).toEqual({ banner: false, remoteAllowed: true, imageLive: true });
    expect(state(views.reader.container)).toEqual(state(views.peek.container));
    views.peek.unmount(); views.reader.unmount();
    useSettingsStore.setState({ externalContentPolicy: 'block' } as never);
    views = both(mail('b1', UNKNOWN));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(state(views.peek.container).banner).toBe(true);
    expect(state(views.reader.container)).toEqual(state(views.peek.container));
  });

  it('the reading pane keeps its banner while the content stays blocked, from one message to the next', async () => {
    const view = render(<EmailViewer email={mail('r1', UNKNOWN)} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(state(view.container).banner).toBe(true);
    view.rerender(<EmailViewer email={mail('r2', UNKNOWN)} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(state(view.container)).toEqual({ banner: true, remoteAllowed: false, imageLive: false });
  });
});
