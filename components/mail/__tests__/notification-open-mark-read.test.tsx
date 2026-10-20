import React, { Suspense, lazy } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { useAccountStore } from '@/stores/account-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { bumpStoreEpoch } from '@/lib/store-epoch';

// Fork (Wnt/webmail), the owner's iPhone, 2026-10-20: a message opened from a
// notification stayed unread. Every tap path opens its message before the
// list holds it - a cold start loads the folder list and the Inbox once the
// body is on screen; a page coming back from the background may not have the
// new message in its list yet - and the read mark, sent once the body is on
// screen, was dropped because the list did not hold the message (the
// gateway log of the owner's tap: Email/get of the message, the Inbox, no
// Email/set). Each path marks the message it opened exactly once, once its
// body is on screen; a notification that was only received, and a kept copy
// that was not opened, are never marked.
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
  useMediaQuery: () => false,
  useIsDesktop: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));
vi.mock('@/components/ui/welcome-banner', () => ({ WelcomeBanner: () => null }));

const { MailApp } = await import('../mail-app');
const { __resetTapHandover } = await import('@/lib/notification-open');
const { bodyReady, __resetOpenTiming } = await import('@/lib/open-timing');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1';
const inbox = (unread: number) => ({ id: 'inbox', name: 'Inbox', role: 'inbox', unreadEmails: unread, totalEmails: 9, unreadThreads: unread, totalThreads: 9 }) as Mailbox;
const store = new Map<string, string>();
const origin = () => window.location.origin;
const shownPrefix = () => `${origin()}/__push-state/shown/`;
let listed: string[] = [];
let visibility: DocumentVisibilityState = 'visible';
let swListeners: Array<(e: MessageEvent) => void> = [];
let markAsRead: ReturnType<typeof vi.fn>;
let primeEmail: ReturnType<typeof vi.fn>;
let fetchEmailContent: ReturnType<typeof vi.fn>;
let fetchEmails: ReturnType<typeof vi.fn>;
let fetchMailboxes: ReturnType<typeof vi.fn>;

const message = (id: string, keywords: Record<string, boolean> = {}): Email => ({
  id, threadId: `t-${id}`, blobId: `b-${id}`, mailboxIds: { inbox: true }, keywords,
  subject: `Synthetic ${id}`, from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }],
  receivedAt: '2026-10-20T10:00:00Z', bodyValues: { '1': { value: 'Hello', isTruncated: false } },
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [],
}) as unknown as Email;

/** The worker's ledger: a mail notification it showed. */
function shown(shownId: string, emailId: string, at = Date.now() - 90 * 60_000) {
  store.set(`${shownPrefix()}${shownId}`, JSON.stringify({ shownId, emailId, accountId: 'acc', slot: 0, at, listed: true }));
}
/** The worker kept the message for the tap (the preview lookup or the preview ticket). */
function kept(emailId: string) {
  store.set(`${origin()}/__push-state/prefetched/acc/${emailId}`, JSON.stringify({ at: Date.now() - 60_000, email: message(emailId) }));
}
const marks = () => markAsRead.mock.calls.map((c) => [c[0], c[1]]);
const row = (id: string) => useEmailStore.getState().emails.find((e) => e.id === id);

async function settle(ms = 50) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
/** The reading pane has the message's body on screen. */
async function painted(id: string) {
  await waitFor(() => expect(useEmailStore.getState().selectedEmail?.id).toBe(id));
  act(() => bodyReady(id));
  await settle();
}

beforeEach(() => {
  bumpStoreEpoch();
  __resetOpenTiming();
  store.clear();
  __resetTapHandover();
  listed = [];
  swListeners = [];
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (k: string | Request) => {
        const url = typeof k === 'string' ? k : k.url;
        return store.has(url) ? { json: async () => JSON.parse(store.get(url)!) } : undefined;
      },
      put: async (k: string | Request, res: Response) => { store.set(typeof k === 'string' ? k : k.url, await res.text()); },
      keys: async () => [...store.keys()].map((url) => ({ url }) as Request),
      delete: async (k: string | Request) => store.delete(typeof k === 'string' ? k : k.url),
    }),
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: null,
      addEventListener: (type: string, fn: (e: MessageEvent) => void) => { if (type === 'message') swListeners.push(fn); },
      removeEventListener: (type: string, fn: (e: MessageEvent) => void) => { swListeners = swListeners.filter((f) => f !== fn); },
      getRegistration: async () => ({
        getNotifications: async () => listed.map((id) => ({ data: { kind: 'email', shownId: id } })),
      }),
    },
  });
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
  Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  markAsRead = vi.fn().mockResolvedValue(undefined);
  primeEmail = vi.fn();
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.test',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    markAsRead, primeEmail,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  useAccountStore.setState({ accounts: [{ id: 'login', cookieSlot: 0 }] } as never);
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', interfaceLayout: 'default', markAsReadDelay: 0 } as never);
  useUIStore.setState({ activeView: 'list' } as never);
  // As the store's own: the message becomes the open one.
  fetchEmailContent = vi.fn(async (_client: unknown, id: string) => {
    const email = message(id);
    useEmailStore.setState({ selectedEmail: email });
    return email;
  });
  fetchMailboxes = vi.fn(async () => { useEmailStore.setState({ mailboxes: [inbox(3)] }); });
  // The Inbox page, fetched alongside the read mark: it still shows the tapped message unread.
  fetchEmails = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 30));
    useEmailStore.setState({ emails: [message('m-tapped'), message('m-other')] });
  });
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'inbox', mailboxes: [],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(), processingReadStatus: new Set(), threadEmailsCache: new Map(), tagCounts: {},
    retainedInViewIds: new Set(), listOrder: [],
    fetchMailboxes, fetchEmails,
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as unknown as { standalone?: boolean }).standalone;
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
});

/** A page already up on the Inbox (its list loaded, without the new message). */
async function openOnInbox() {
  fetchEmails.mockImplementation(async () => {
    useEmailStore.setState({ emails: [message('m-older', { $seen: true })] });
  });
  const view = render(<MailApp />);
  await settle(100);
  await waitFor(() => expect(row('m-older')).toBeTruthy());
  return view;
}

describe('a message opened from a notification is marked read once its body is on screen', () => {
  it('cold start at the notification link, kept copy: one Email/set for that message, after the paint; the list row reads as read', async () => {
    shown('s1', 'm-tapped');
    kept('m-tapped');
    render(<MailApp linkSegments={['message', 'm-tapped']} />);
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm-tapped'));
    expect(primeEmail).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-tapped' }));
    await settle();
    expect(markAsRead).not.toHaveBeenCalled();
    await painted('m-tapped');
    await waitFor(() => expect(marks()).toEqual([['m-tapped', true]]));
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBe(true);
    // The Inbox, loaded after the body and fetched alongside the write.
    await waitFor(() => expect(row('m-tapped')).toBeTruthy());
    expect(row('m-tapped')?.keywords?.$seen).toBe(true);
    expect(row('m-other')?.keywords?.$seen).toBeUndefined();
    await settle(1700);
    expect(marks()).toEqual([['m-tapped', true]]);
  });

  it('cold start, the tap WebKit lost (vanished from the list), the Inbox slower than the body: marked once', async () => {
    shown('s1', 'm-tapped');
    // Here the Inbox loads alongside the message (no link to wait for); the
    // owner's Inbox page took about a second, the kept message less.
    let releaseList!: () => void;
    fetchEmails.mockImplementation(() => new Promise<void>((resolve) => {
      releaseList = () => { useEmailStore.setState({ emails: [message('m-tapped'), message('m-other')] }); resolve(); };
    }));
    render(<MailApp />);
    await painted('m-tapped');
    await waitFor(() => expect(marks()).toEqual([['m-tapped', true]]));
    await waitFor(() => expect(fetchEmails).toHaveBeenCalled());
    act(() => releaseList());
    expect(row('m-tapped')?.keywords?.$seen).toBe(true);
    await settle(1700);
    expect(marks()).toEqual([['m-tapped', true]]);
  });

  it('hand-over: a page WebKit replaced found the tap; the new page opens and marks it once', async () => {
    store.set(`${origin()}/__push-state/tap-found`, JSON.stringify({ emailId: 'm-tapped', slot: 0, at: Date.now() - 5_000 }));
    render(<MailApp linkSegments={['folder', 'inbox']} />);
    await painted('m-tapped');
    await waitFor(() => expect(marks()).toEqual([['m-tapped', true]]));
    await settle(1700);
    expect(marks()).toEqual([['m-tapped', true]]);
  });

  it('resume: the same page back from the background opens the tapped message and marks it once', async () => {
    shown('s1', 'm-tapped');
    listed = ['s1'];
    await openOnInbox();
    expect(markAsRead).not.toHaveBeenCalled();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    listed = [];
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await painted('m-tapped');
    await waitFor(() => expect(marks()).toEqual([['m-tapped', true]]));
    // The page's folder list is up: its counters come from the server again.
    expect(fetchMailboxes).toHaveBeenCalledTimes(2);
    await settle(1700);
    expect(marks()).toEqual([['m-tapped', true]]);
  });

  it('already open: the worker asks the page to open it in place; marked once', async () => {
    await openOnInbox();
    store.set(`${origin()}/__push-state/notification-open`, JSON.stringify({ emailId: 'm-tapped', slot: 0, at: Date.now() }));
    act(() => {
      for (const fn of swListeners) fn({ data: { kind: 'notificationclick', open: true, at: performance.timeOrigin + performance.now(), data: { kind: 'email', emailId: 'm-tapped' } }, ports: [] } as unknown as MessageEvent);
    });
    await painted('m-tapped');
    await waitFor(() => expect(marks()).toEqual([['m-tapped', true]]));
    await settle(1700);
    expect(marks()).toEqual([['m-tapped', true]]);
  });

  it('back to the list: the row reads as read and nothing is marked again', async () => {
    render(<MailApp linkSegments={['message', 'm-tapped']} />);
    await painted('m-tapped');
    await waitFor(() => expect(marks()).toEqual([['m-tapped', true]]));
    await waitFor(() => expect(row('m-tapped')).toBeTruthy());
    act(() => {
      useEmailStore.getState().selectEmail(null);
      useUIStore.getState().setActiveView('list');
    });
    await settle();
    expect(row('m-tapped')?.keywords?.$seen).toBe(true);
    // Opened again from the list: it is read, no Email/set.
    act(() => { useEmailStore.getState().selectEmail(row('m-tapped')!); });
    act(() => bodyReady('m-tapped'));
    await settle(100);
    expect(marks()).toEqual([['m-tapped', true]]);
  });
});

describe('never marked read', () => {
  it('a notification only received (still listed), its message kept: nothing opens, nothing is marked', async () => {
    shown('s1', 'm-received');
    kept('m-received');
    listed = ['s1'];
    render(<MailApp />);
    await settle(1800);
    expect(fetchEmailContent).not.toHaveBeenCalled();
    expect(markAsRead).not.toHaveBeenCalled();
  });

  it('a kept copy that is not the open message is never marked, even asked for by id', async () => {
    kept('m-received');
    await openOnInbox();
    await act(async () => { await useEmailStore.getState().markAsRead(useAuthStore.getState().client!, 'm-received', true); });
    expect(markAsRead).not.toHaveBeenCalled();
  });
});
