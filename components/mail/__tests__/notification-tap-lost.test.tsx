import React, { Suspense, lazy } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { useAccountStore } from '@/stores/account-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// Fork (Wnt/webmail): the owner's iPhone, 2026-10-19. A tap on a mail
// notification brought the Home Screen app back from the background on the
// Inbox: WebKit dropped the notification's `navigate` URL and fired no
// notificationclick, so neither the URL nor the worker carried the message.
// The tap still removed the notification from the list, and the worker's
// ledger names what it showed. The app, coming up (a fresh page start) or
// back to the front (the same page resumed), opens the one that is gone.
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

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const store = new Map<string, string>();
const shownPrefix = () => `${window.location.origin}/__push-state/shown/`;
/** The shownIds the notification list holds right now. */
let listed: string[] = [];
let fetchEmailContent: ReturnType<typeof vi.fn>;
let fetchEmails: ReturnType<typeof vi.fn>;

function shown(shownId: string, emailId: string, at = Date.now() - 90 * 60_000) {
  store.set(`${shownPrefix()}${shownId}`, JSON.stringify({ shownId, emailId, accountId: 'acc', slot: 0, at, listed: true }));
}

function asPhoneApp(ua: string, standalone: boolean) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  store.clear();
  __resetTapHandover();
  listed = [];
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
      addEventListener: () => {},
      removeEventListener: () => {},
      getRegistration: async () => ({
        getNotifications: async () => listed.map((id) => ({ data: { kind: 'email', shownId: id } })),
      }),
    },
  });
  asPhoneApp(IPHONE, true);
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.test',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  // The one login, in cookie slot 0 (the slot a notification names).
  useAccountStore.setState({ accounts: [{ id: 'login', cookieSlot: 0 }] } as never);
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', interfaceLayout: 'default' } as never);
  useUIStore.setState({ activeView: 'list' } as never);
  fetchEmails = vi.fn().mockResolvedValue(undefined);
  fetchEmailContent = vi.fn(async (_client: unknown, id: string) => ({ id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {} }));
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: inbox.id, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails,
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as unknown as { standalone?: boolean }).standalone;
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
});

/** Lets the app's start-up effects and their cache reads settle. */
async function settle(ms = 50) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

describe('a notification tap WebKit lost (no URL, no notificationclick)', () => {
  it('cold: the app restarting on the Inbox opens the tapped message', async () => {
    shown('s1', 'm-tapped');
    render(<MailApp />);
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm-tapped'));
    expect(fetchEmailContent).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().activeView).toBe('viewer');
    expect([...store.keys()].filter((k) => k.startsWith(shownPrefix()))).toEqual([]);
    // Found while the session came up: the message comes first, as at a
    // message link; the Inbox list follows (its body painted, 1.5 s at most).
    await waitFor(() => expect(fetchEmails).toHaveBeenCalled(), { timeout: 3000 });
    expect(fetchEmailContent.mock.invocationCallOrder[0]).toBeLessThan(fetchEmails.mock.invocationCallOrder[0]);
    await settle(100);
    expect(fetchEmailContent).toHaveBeenCalledTimes(1);
  });

  it('background: the same page coming back to the front opens it', async () => {
    shown('s1', 'm-tapped');
    listed = ['s1'];
    render(<MailApp />);
    await settle();
    expect(fetchEmailContent).not.toHaveBeenCalled();
    // Into the background; the user taps the notification; WebKit restores the page.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    listed = [];
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm-tapped'));
  });

  it('background: the list lagging the tap a moment is looked at again', async () => {
    shown('s1', 'm-tapped');
    listed = ['s1'];
    render(<MailApp />);
    await settle();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(fetchEmailContent).not.toHaveBeenCalled();
    listed = [];
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm-tapped'), { timeout: 3000 });
  });

  // iOS Simulator (WebKit, iOS 26.3), 2026-10-19: WebKit shows the old page
  // first (it sees the notification gone and takes the ledger entry), then
  // replaces it - with its reload at the Inbox when the tap's URL is lost -
  // before the old page has opened the message.
  it('background: the page that found the tap is replaced before it opens it; the new page opens it', async () => {
    shown('s1', 'm-tapped');
    listed = ['s1'];
    let releaseFirst!: () => void;
    fetchEmailContent.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve(null); }));
    const old = render(<MailApp />);
    await settle();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    listed = [];
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledTimes(1));
    expect([...store.keys()].filter((k) => k.startsWith(shownPrefix()))).toEqual([]);
    // Replaced mid-open: a new page (fresh module state) at the Inbox.
    old.unmount();
    __resetTapHandover();
    render(<MailApp linkSegments={['folder', 'inbox']} />);
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledTimes(2));
    expect(fetchEmailContent).toHaveBeenLastCalledWith(expect.anything(), 'm-tapped');
    releaseFirst();
  });

  it('an older notification tapped while a newer one is still on screen opens the older message', async () => {
    shown('s-old', 'm-old', Date.now() - 3 * 3_600_000);
    shown('s-new', 'm-new');
    listed = ['s-new'];
    render(<MailApp />);
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm-old'));
    expect(fetchEmailContent).not.toHaveBeenCalledWith(expect.anything(), 'm-new');
  });

  it('the app opened from its icon (every notification still listed) stays on the Inbox', async () => {
    shown('s1', 'm1');
    listed = ['s1'];
    render(<MailApp />);
    await settle(100);
    expect(fetchEmailContent).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeView).toBe('list');
  });

  it('Clear All (several gone at once) opens nothing', async () => {
    shown('s1', 'm1');
    shown('s2', 'm2');
    render(<MailApp />);
    await settle(100);
    expect(fetchEmailContent).not.toHaveBeenCalled();
  });

  it('a page WebKit did open at the message link opens it once', async () => {
    shown('s1', 'm-tapped');
    render(<MailApp linkSegments={['message', 'm-tapped']} />);
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm-tapped'));
    await settle(100);
    expect(fetchEmailContent).toHaveBeenCalledTimes(1);
  });

  it('a page opened at another message link keeps to it (an older found tap is dropped)', async () => {
    const foundKey = `${window.location.origin}/__push-state/tap-found`;
    store.set(foundKey, JSON.stringify({ emailId: 'm-older', slot: 0, at: Date.now() - 30_000 }));
    render(<MailApp linkSegments={['message', 'm-link']} />);
    await waitFor(() => expect(fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm-link'));
    // Looked at once the Inbox is in (its body painted, 1.5 s at most).
    await waitFor(() => expect(store.has(foundKey)).toBe(false), { timeout: 4000 });
    await settle(100);
    expect(fetchEmailContent).not.toHaveBeenCalledWith(expect.anything(), 'm-older');
  });

  it('never guesses outside the Home Screen app (Chrome delivers its clicks)', async () => {
    asPhoneApp(CHROME, true);
    shown('s1', 'm1');
    render(<MailApp />);
    await settle(100);
    expect(fetchEmailContent).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });
});
