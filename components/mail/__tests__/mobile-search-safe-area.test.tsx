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

// The phone's full-screen search panel is fixed to the viewport, so it
// escaped the app root's safe-area padding: in the installed iOS app its
// header (back arrow and title) sat under the status bar. The panel must
// take the top inset itself, exactly once.
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

/** The Tailwind classes of `el` and every ancestor that mention the top inset. */
function topInsetClasses(el: Element | null): string[] {
  const found: string[] = [];
  for (let node = el; node; node = node.parentElement) {
    for (const cls of Array.from(node.classList)) {
      if (cls.includes(TOP_INSET)) found.push(cls);
    }
  }
  return found;
}

describe('phone search panel and the iOS status bar', () => {
  it('starts below the top safe-area inset, applied once', () => {
    render(<MailApp />);
    // The list itself sits in the app root, which pads the inset.
    expect(topInsetClasses(screen.getByText('message list'))).toEqual([`pt-[${TOP_INSET}]`]);

    fireEvent.click(screen.getByRole('button', { name: 'open search' }));

    const back = screen.getByRole('button', { name: 'sidebar.mobile.go_back' });
    const panel = back.closest('.fixed');
    expect(panel).not.toBeNull();
    // The panel is fixed to the viewport, so the root's padding does not
    // reach it. It is offset by the inset rather than padded: it scrolls,
    // and padding would scroll away and let content slide under the status bar.
    expect(panel).toHaveClass(`top-[${TOP_INSET}]`, 'bottom-0', 'inset-x-0', 'overflow-y-auto');
    expect(panel).not.toHaveClass('inset-0');
    // Once: nothing inside the panel adds the inset again.
    const inside = Array.from(panel!.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.classList))
      .filter((cls) => cls.includes(TOP_INSET));
    expect(inside).toEqual([]);
    // The search field shares the panel with the header, below it.
    expect(panel).toContainElement(screen.getByRole('textbox', { name: 'search field' }));
  });
});
