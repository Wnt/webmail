import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';

// A free-text search that timed out (the server was still reading every
// message) left an empty list under "No results found", although the mail
// was there. A failed search now says it failed.

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({ client: null, identities: [], username: null, activeAccountId: 'acct-1' })),
  };
});
vi.mock('@/stores/account-store', () => {
  const state = { getAccountById: () => undefined };
  return {
    useAccountStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const initial = useEmailStore.getState();
beforeEach(() => {
  useEmailStore.setState(initial, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', searchQuery: 'Sample', isLoading: false });
});

describe('an empty search result list', () => {
  it('says the search failed when it did', () => {
    useEmailStore.setState({ searchFailed: true });
    render(<EmailList emails={[]} />);
    expect(screen.getByTestId('search-failed')).toBeTruthy();
    expect(screen.getByText('search_failed')).toBeTruthy();
    expect(screen.queryByText('no_search_results')).toBeNull();
  });

  it('says "No results found" when the search found nothing', () => {
    render(<EmailList emails={[]} />);
    expect(screen.queryByTestId('search-failed')).toBeNull();
    expect(screen.getByText('no_search_results')).toBeTruthy();
  });

  it('forgets the failure once the query is edited', () => {
    useEmailStore.setState({ searchFailed: true });
    useEmailStore.getState().setSearchQuery('Sampl');
    render(<EmailList emails={[]} />);
    expect(screen.queryByTestId('search-failed')).toBeNull();
  });
});
