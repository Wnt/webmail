import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Fork (Wnt/webmail), the owner's iPhone, 2026-10-20: a message opened from a
// notification stayed unread. A tap opens its message before the folder list
// and the Inbox page are fetched (a cold start loads them once the body is on
// screen), and the read mark - sent once the body is on screen - looked the
// message up in the loaded list only, found nothing and sent no Email/set.
// The open message is marked whether or not the list holds it; a copy that
// is only kept or prepared (not open) is never marked.

const inbox = (unread: number): Mailbox => ({
  id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 0, parentId: null,
  totalEmails: 10, unreadEmails: unread, totalThreads: 10, unreadThreads: unread,
  isSubscribed: true, isShared: false,
}) as unknown as Mailbox;

const mail = (id: string, keywords: Record<string, boolean> = {}): Email => ({
  id, threadId: `t-${id}`, blobId: `b-${id}`, subject: `Synthetic ${id}`,
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }],
  receivedAt: '2026-10-20T10:00:00Z', keywords, mailboxIds: { inbox: true },
}) as unknown as Email;

let client: IJMAPClient & { markAsRead: ReturnType<typeof vi.fn> };
let fetchMailboxes: ReturnType<typeof vi.fn>;
let fetchTagCounts: ReturnType<typeof vi.fn>;

function seed(state: Partial<ReturnType<typeof useEmailStore.getState>>) {
  useEmailStore.setState({
    emails: [], selectedEmail: null, mailboxes: [], accountMailboxes: {}, selectedMailbox: 'inbox',
    processingReadStatus: new Set(), threadEmailsCache: new Map(), tagCounts: {},
    isUnifiedView: false, isScheduledView: false, selectedKeyword: null, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, listOrder: [], retainedInViewIds: new Set(),
    viewingAccountId: null,
    fetchMailboxes, fetchTagCounts,
    ...state,
  } as never);
}

beforeEach(() => {
  // Each test is its own account epoch: nothing confirmed in one carries over.
  bumpStoreEpoch();
  client = {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    getAccountId: () => 'acc',
  } as unknown as IJMAPClient & { markAsRead: ReturnType<typeof vi.fn> };
  fetchMailboxes = vi.fn().mockResolvedValue(undefined);
  fetchTagCounts = vi.fn().mockResolvedValue(undefined);
  useAuthStore.setState({ activeAccountId: 'login', client: client as never, getClientForAccount: () => client as never } as never);
});

describe('marking the open message read when the loaded list does not hold it', () => {
  it('cold start (no folder list, no list yet): one Email/set, the open copy reads as read', async () => {
    seed({ selectedEmail: mail('m-tapped') });
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
    expect(client.markAsRead).toHaveBeenCalledWith('m-tapped', true, undefined);
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBe(true);
    // The folder list was not asked for yet: the start's own fetch comes after the write.
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });

  it('a list page fetched before the write landed shows the row read; later lists are the server\'s', async () => {
    seed({ selectedEmail: mail('m-tapped') });
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    // The Inbox page lands with the row as it was before the write.
    useEmailStore.setState({ emails: [mail('m-tapped'), mail('m-other')], mailboxes: [inbox(3)] });
    const rows = useEmailStore.getState().emails;
    expect(rows.find((e) => e.id === 'm-tapped')?.keywords?.$seen).toBe(true);
    expect(rows.find((e) => e.id === 'm-other')?.keywords?.$seen).toBeUndefined();
    // Marked unread on another device afterwards: that list is taken as it is.
    useEmailStore.setState({ emails: [mail('m-tapped', {}), mail('m-other')] });
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeUndefined();
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
  });

  it('app already open, the new message not in the list yet: marked, and the counters come from the server', async () => {
    seed({ selectedEmail: mail('m-new'), emails: [mail('m-old', { $seen: true })], mailboxes: [inbox(4)] });
    await useEmailStore.getState().markAsRead(client, 'm-new', true);
    expect(client.markAsRead).toHaveBeenCalledWith('m-new', true, undefined);
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBe(true);
    // No local -1: the folder's count may not include the new message yet.
    expect(useEmailStore.getState().mailboxes[0].unreadEmails).toBe(4);
    expect(fetchMailboxes).toHaveBeenCalledTimes(1);
    expect(fetchMailboxes).toHaveBeenCalledWith(client);
  });

  it('another account (an account switch) never takes the confirmed state of a same-id message', async () => {
    seed({ selectedEmail: mail('m-same') });
    await useEmailStore.getState().markAsRead(client, 'm-same', true);
    bumpStoreEpoch();
    useEmailStore.setState({ emails: [mail('m-same')] });
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeUndefined();
  });

  it('a tagged message also refreshes the tag counts', async () => {
    seed({ selectedEmail: mail('m-tag', { '$label:work': true }), mailboxes: [inbox(1)], tagCounts: { work: { total: 1, unread: 1 } } });
    await useEmailStore.getState().markAsRead(client, 'm-tag', true);
    expect(fetchTagCounts).toHaveBeenCalledTimes(1);
  });

  it('the reading pane and the mail app marking it at once send one Email/set', async () => {
    let release!: () => void;
    client.markAsRead.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    seed({ selectedEmail: mail('m-tapped') });
    const first = useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    const second = useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    release();
    await Promise.all([first, second]);
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
  });

  it('already read (on another device, say): no Email/set', async () => {
    seed({ selectedEmail: mail('m-read', { $seen: true }) });
    await useEmailStore.getState().markAsRead(client, 'm-read', true);
    expect(client.markAsRead).not.toHaveBeenCalled();
  });

  it('a message that is neither open nor in the list (a kept or prepared copy) is never marked', async () => {
    seed({ selectedEmail: mail('m-open', { $seen: true }) });
    await useEmailStore.getState().markAsRead(client, 'm-kept', true);
    expect(client.markAsRead).not.toHaveBeenCalled();
    seed({ selectedEmail: null });
    await useEmailStore.getState().markAsRead(client, 'm-kept', true);
    expect(client.markAsRead).not.toHaveBeenCalled();
  });

  it('a failed Email/set leaves it unread and can be tried again', async () => {
    client.markAsRead.mockRejectedValueOnce(new Error('Failed to update read status'));
    seed({ selectedEmail: mail('m-tapped') });
    await expect(useEmailStore.getState().markAsRead(client, 'm-tapped', true)).rejects.toThrow();
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBeUndefined();
    useEmailStore.setState({ emails: [mail('m-tapped')] });
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeUndefined();
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    expect(client.markAsRead).toHaveBeenCalledTimes(2);
  });

  it('in the list (a normal open): the row and the folder count change locally, as before', async () => {
    seed({ selectedEmail: mail('m1'), emails: [mail('m1')], mailboxes: [inbox(2)] });
    await useEmailStore.getState().markAsRead(client, 'm1', true);
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBe(true);
    expect(useEmailStore.getState().mailboxes[0].unreadEmails).toBe(1);
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });
});
