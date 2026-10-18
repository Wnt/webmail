import React, { Suspense, lazy } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// A search typed into the phone's search panel ran only on the keyboard's
// Search key; with the keyboard down the panel stayed blank, and nothing said
// whether a search was running, had found nothing or had failed. The panel
// now has a row that runs the search, and a status line over the list tells
// the three states apart (text typed but not searched gets none).
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({
  MobileHeader: ({ onOpenSearch }: { onOpenSearch?: () => void }) => (
    <button type="button" onClick={onOpenSearch}>open search</button>
  ),
}));
vi.mock('@/components/email/message-list-tabs', () => ({ MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input aria-label="search field" /> }));
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

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const TOP_INSET = 'env(safe-area-inset-top)';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', interfaceLayout: 'default' } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: inbox.id, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const searchEmails = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  searchEmails.mockClear();
  useEmailStore.setState({ searchEmails, searchFailed: false, searchedQuery: null } as never);
});

const status = () => screen.queryByTestId('search-status');

describe('phone search panel: running a typed search', () => {
  it('a row under the field runs the typed search and closes the panel', () => {
    useEmailStore.setState({ searchQuery: 'Zorblatt' } as never);
    render(<MailApp />);
    fireEvent.click(screen.getByRole('button', { name: 'open search' }));
    const run = screen.getByTestId('mobile-search-submit');
    expect(run).toHaveTextContent('email_list.search_for');
    fireEvent.click(run);
    expect(searchEmails).toHaveBeenCalledWith(expect.anything(), 'Zorblatt');
    expect(screen.queryByTestId('mobile-search-submit')).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar.mobile.go_back' })).toBeNull();
  });

  it('no row without a query', () => {
    render(<MailApp />);
    fireEvent.click(screen.getByRole('button', { name: 'open search' }));
    expect(screen.queryByTestId('mobile-search-submit')).toBeNull();
  });
});

describe('search status line', () => {
  it('typed but not searched: no line (the list is still the folder)', () => {
    useEmailStore.setState({ searchQuery: 'Zorblatt', searchedQuery: null } as never);
    render(<MailApp />);
    expect(status()).toBeNull();
  });

  it('running: a visible "Searching…" line', () => {
    useEmailStore.setState({ searchQuery: 'Zorblatt', searchedQuery: 'Zorblatt', isLoading: true } as never);
    render(<MailApp />);
    expect(status()).toHaveAttribute('data-state', 'running');
    expect(status()).toHaveTextContent('email_list.searching');
  });

  it('finished with no results: the count line', () => {
    useEmailStore.setState({ searchQuery: 'Zorblatt', searchedQuery: 'Zorblatt', isLoading: false, emails: [] } as never);
    render(<MailApp />);
    expect(status()).toHaveAttribute('data-state', 'done');
    expect(status()).toHaveTextContent('advanced_search.results_found');
  });

  it('failed: "Search didn\'t finish"', () => {
    useEmailStore.setState({ searchQuery: 'Zorblatt', searchedQuery: 'Zorblatt', isLoading: false, emails: [], searchFailed: true } as never);
    render(<MailApp />);
    expect(status()).toHaveAttribute('data-state', 'failed');
    expect(status()).toHaveTextContent('email_list.search_failed');
  });
});
