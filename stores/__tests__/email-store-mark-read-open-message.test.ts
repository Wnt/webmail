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
// is only kept or prepared (not open) is never marked. What the server
// confirmed reaches the list and the counters through the server (a list
// fetched before the write is caught up from its own state; the counters are
// fetched again), never across an account switch or into another account's
// message with the same id.

const inbox = (unread: number): Mailbox => ({
  id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 0, parentId: null,
  totalEmails: 10, unreadEmails: unread, totalThreads: 10, unreadThreads: unread,
  isSubscribed: true, isShared: false,
}) as unknown as Mailbox;

const mail = (id: string, keywords: Record<string, boolean> = {}, extra: Partial<Email> = {}): Email => ({
  id, threadId: `t-${id}`, blobId: `b-${id}`, subject: `Synthetic ${id}`,
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }],
  receivedAt: '2026-10-20T10:00:00Z', keywords, mailboxIds: { inbox: true }, ...extra,
}) as unknown as Email;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type MockClient = IJMAPClient & {
  markAsRead: ReturnType<typeof vi.fn>;
  getEmails: ReturnType<typeof vi.fn>;
  getEmailChanges: ReturnType<typeof vi.fn>;
  getSomeEmails: ReturnType<typeof vi.fn>;
  getAllMailboxesWithState: ReturnType<typeof vi.fn>;
};
let client: MockClient;
let fetchMailboxes: ReturnType<typeof vi.fn>;
let fetchTagCounts: ReturnType<typeof vi.fn>;
let fetchAccountMailboxes: ReturnType<typeof vi.fn>;
let refreshCurrentMailbox: ReturnType<typeof vi.fn>;

function makeClient(): MockClient {
  return {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    getAccountId: () => 'acc',
    getEmails: vi.fn(),
    getEmailChanges: vi.fn(),
    getSomeEmails: vi.fn(),
    getAllMailboxesWithState: vi.fn(),
    getMaxObjectsInGet: () => 500,
  } as unknown as MockClient;
}

function seed(state: Partial<ReturnType<typeof useEmailStore.getState>>) {
  useEmailStore.setState({
    emails: [], selectedEmail: null, mailboxes: [], accountMailboxes: {}, selectedMailbox: 'inbox',
    processingReadStatus: new Set(), threadEmailsCache: new Map(), tagCounts: {},
    isUnifiedView: false, isScheduledView: false, selectedKeyword: null, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, listOrder: [], retainedInViewIds: new Set(),
    viewingAccountId: null, emailListSync: null, crossView: null, unifiedRole: null,
    fetchMailboxes, fetchTagCounts, fetchAccountMailboxes, refreshCurrentMailbox,
    fetchThreadEmailCounts: vi.fn().mockResolvedValue(undefined),
    ...state,
  } as never);
}

/** The Inbox page as the server answers it, at Email state `state`. */
const page = (emails: Email[], state = 's-before') => ({ emails, hasMore: false, total: emails.length, state });
const noChanges = (oldState: string) => ({ oldState, newState: oldState, created: [], updated: [], destroyed: [], hasMoreChanges: false });
const seenRow = (id: string) => useEmailStore.getState().emails.find((e) => e.id === id)?.keywords?.$seen;
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // Each test is its own account epoch.
  bumpStoreEpoch();
  client = makeClient();
  fetchMailboxes = vi.fn().mockResolvedValue(undefined);
  fetchTagCounts = vi.fn().mockResolvedValue(undefined);
  fetchAccountMailboxes = vi.fn().mockResolvedValue(undefined);
  refreshCurrentMailbox = vi.fn().mockResolvedValue(undefined);
  useAuthStore.setState({ activeAccountId: 'login', client: client as never, getClientForAccount: () => client as never } as never);
});

describe('marking the open message read when the loaded list does not hold it', () => {
  it('cold start (no folder list, no list yet): one Email/set, the open copy reads as read', async () => {
    seed({ selectedEmail: mail('m-tapped') });
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
    expect(client.markAsRead).toHaveBeenCalledWith('m-tapped', true, undefined);
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBe(true);
    expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
    // The folder list was not asked for yet: the start's own fetch comes after the write.
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });

  it('app already open, the new message not in the list yet: marked; the counters and the list come from the server', async () => {
    seed({
      selectedEmail: mail('m-new'), emails: [mail('m-old', { $seen: true })], mailboxes: [inbox(4)],
      emailListSync: { state: 's-before', accountId: 'acc', mailboxId: 'inbox' },
    });
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', created: ['m-new'], updated: ['m-new'] });
    client.getSomeEmails.mockResolvedValue([mail('m-new', { $seen: true })]);
    await useEmailStore.getState().markAsRead(client, 'm-new', true);
    expect(client.markAsRead).toHaveBeenCalledWith('m-new', true, undefined);
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBe(true);
    // No local -1: the folder's count may not include the new message yet.
    expect(useEmailStore.getState().mailboxes[0].unreadEmails).toBe(4);
    expect(fetchMailboxes).toHaveBeenCalledWith(client);
    // The list on screen predates the write: caught up from its own state. The
    // new message entered the folder, which a delta cannot place: re-queried.
    await settle();
    expect(client.getEmailChanges).toHaveBeenCalledWith('s-before', undefined, expect.any(Number));
    await vi.waitFor(() => expect(refreshCurrentMailbox).toHaveBeenCalledWith(client));
  });

  it('a list fetched before the write landed: caught up with the server; the row reads as read', async () => {
    seed({ selectedEmail: mail('m-tapped'), mailboxes: [inbox(3)] });
    const list = deferred<ReturnType<typeof page>>();
    client.getEmails.mockReturnValueOnce(list.promise);
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    // The Inbox page goes out alongside the read mark...
    const fetching = useEmailStore.getState().fetchEmails(client, 'inbox', { background: true });
    const marking = useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    write.resolve();
    await marking;
    // ...and answers from before the write.
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-tapped'] });
    client.getSomeEmails.mockResolvedValue([mail('m-tapped', { $seen: true })]);
    list.resolve(page([mail('m-tapped'), mail('m-other')]));
    await fetching;
    await vi.waitFor(() => expect(seenRow('m-tapped')).toBe(true));
    expect(client.getEmailChanges).toHaveBeenCalledWith('s-before', undefined, expect.any(Number));
    expect(client.getSomeEmails).toHaveBeenCalledWith(['m-tapped'], undefined);
    expect(seenRow('m-other')).toBeUndefined();
    expect(useEmailStore.getState().emailListSync?.state).toBe('s-after');
    expect(client.markAsRead).toHaveBeenCalledTimes(1);
  });

  it('two lists fetched before the write: each is caught up, whichever lands last', async () => {
    seed({ selectedEmail: mail('m-tapped'), mailboxes: [inbox(3)] });
    const first = deferred<ReturnType<typeof page>>();
    const second = deferred<ReturnType<typeof page>>();
    client.getEmails.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = useEmailStore.getState().fetchEmails(client, 'inbox', { background: true });
    const b = useEmailStore.getState().fetchEmails(client, 'inbox', { background: true });
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    client.getEmailChanges.mockImplementation(async (since: string) => ({ ...noChanges(since), newState: 's-after', updated: ['m-tapped'] }));
    client.getSomeEmails.mockResolvedValue([mail('m-tapped', { $seen: true })]);
    first.resolve(page([mail('m-tapped')], 's-before-1'));
    await a;
    await vi.waitFor(() => expect(seenRow('m-tapped')).toBe(true));
    second.resolve(page([mail('m-tapped')], 's-before-2'));
    await b;
    await vi.waitFor(() => expect(client.getEmailChanges).toHaveBeenCalledWith('s-before-2', undefined, expect.any(Number)));
    await vi.waitFor(() => expect(seenRow('m-tapped')).toBe(true));
  });

  it('a list fetched after the server confirmed it is the server\'s own: no catch-up', async () => {
    seed({ selectedEmail: mail('m-tapped'), mailboxes: [inbox(3)] });
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    client.getEmails.mockResolvedValueOnce(page([mail('m-tapped', { $seen: true })], 's-after'));
    await useEmailStore.getState().fetchEmails(client, 'inbox', { background: true });
    await settle();
    expect(client.getEmailChanges).not.toHaveBeenCalled();
    expect(seenRow('m-tapped')).toBe(true);
  });

  it('marked unread again afterwards: the list keeps the newer state', async () => {
    seed({ selectedEmail: mail('m-tapped'), mailboxes: [inbox(3)] });
    const list = deferred<ReturnType<typeof page>>();
    client.getEmails.mockReturnValueOnce(list.promise);
    const fetching = useEmailStore.getState().fetchEmails(client, 'inbox', { background: true });
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-tapped'] });
    client.getSomeEmails.mockResolvedValue([mail('m-tapped', { $seen: true })]);
    list.resolve(page([mail('m-tapped')]));
    await fetching;
    await vi.waitFor(() => expect(seenRow('m-tapped')).toBe(true));
    // The user marks it unread (an ordinary in-list write); a later list says so too.
    await useEmailStore.getState().markAsRead(client, 'm-tapped', false);
    expect(seenRow('m-tapped')).toBe(false);
    useEmailStore.setState({ emails: [mail('m-tapped', { $seen: false })] });
    await settle();
    expect(seenRow('m-tapped')).toBe(false);
    expect(client.markAsRead.mock.calls.map((c) => c[1])).toEqual([true, false]);
  });

  it('an account switch while the write is out: the next account\'s stores are left alone', async () => {
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    seed({ selectedEmail: mail('m-same'), mailboxes: [inbox(1)] });
    const marking = useEmailStore.getState().markAsRead(client, 'm-same', true);
    // Switched: the next account has a message with the same id, unread.
    bumpStoreEpoch();
    const other = makeClient();
    useAuthStore.setState({ activeAccountId: 'login-b', client: other as never } as never);
    seed({ selectedEmail: mail('m-same'), emails: [mail('m-same')], mailboxes: [inbox(1)] });
    write.resolve();
    await marking;
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBeUndefined();
    expect(seenRow('m-same')).toBeUndefined();
    expect(fetchMailboxes).not.toHaveBeenCalled();
    expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
    // A list landing for the next account is not caught up for the old write.
    other.getEmails.mockResolvedValueOnce(page([mail('m-same')]));
    await useEmailStore.getState().fetchEmails(other as never, 'inbox', { background: true });
    await settle();
    expect(other.getEmailChanges).not.toHaveBeenCalled();
    expect(client.getEmailChanges).not.toHaveBeenCalled();
  });

  it('a queued folder-list run does not start after an account switch', async () => {
    seed({ selectedEmail: mail('m-tapped'), mailboxes: [inbox(2)] });
    // The real folder-list fetch: one run in flight, one queued behind it.
    useEmailStore.setState({ fetchMailboxes: useEmailStore.getInitialState().fetchMailboxes } as never);
    const firstRun = deferred<{ mailboxes: Mailbox[]; states: Record<string, string> }>();
    client.getAllMailboxesWithState.mockReturnValueOnce(firstRun.promise).mockResolvedValue({ mailboxes: [inbox(9)], states: {} });
    const running = useEmailStore.getState().fetchMailboxes(client);
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    bumpStoreEpoch();
    useAuthStore.setState({ activeAccountId: 'login-b', client: makeClient() as never } as never);
    seed({ mailboxes: [] });
    firstRun.resolve({ mailboxes: [inbox(1)], states: {} });
    await running;
    expect(client.getAllMailboxesWithState).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().mailboxes).toEqual([]);
  });

  it('the same id in another JMAP account is another message: its row is not touched', async () => {
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    seed({ selectedEmail: mail('m', {}, { sourceClientAccountId: 'login', sourceAccountId: 'shared-a' }), mailboxes: [inbox(2)] });
    const marking = useEmailStore.getState().markAsRead(client, 'm', true);
    // While the write is out, a row "m" of another shared account lands.
    useEmailStore.setState({ emails: [mail('m', {}, { sourceClientAccountId: 'login', sourceAccountId: 'shared-b' })] });
    write.resolve();
    await marking;
    expect(client.markAsRead).toHaveBeenCalledWith('m', true, 'shared-a');
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBe(true);
    expect(seenRow('m')).toBeUndefined();
  });

  it('a message of another connected login: that login\'s folders are fetched again', async () => {
    const other = makeClient();
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-b' ? other : client) as never } as never);
    seed({
      selectedEmail: mail('m-b', {}, { sourceClientAccountId: 'login-b', sourceAccountId: 'acc-b' }),
      accountMailboxes: { 'login-b': [inbox(1)] }, mailboxes: [inbox(5)],
    });
    await useEmailStore.getState().markAsRead(client, 'm-b', true);
    expect(other.markAsRead).toHaveBeenCalledWith('m-b', true, 'acc-b');
    expect(fetchAccountMailboxes).toHaveBeenCalledWith(other, 'login-b');
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });

  it('a tagged message also refreshes the tag counts', async () => {
    seed({ selectedEmail: mail('m-tag', { '$label:work': true }), mailboxes: [inbox(1)], tagCounts: { work: { total: 1, unread: 1 } } });
    await useEmailStore.getState().markAsRead(client, 'm-tag', true);
    expect(fetchTagCounts).toHaveBeenCalledTimes(1);
  });

  it('the reading pane and the mail app marking it at once send one Email/set', async () => {
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    seed({ selectedEmail: mail('m-tapped') });
    const first = useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    const second = useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    write.resolve();
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
    expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    expect(client.markAsRead).toHaveBeenCalledTimes(2);
  });

  it('in the list (a normal open): the row and the folder count change locally, as before, with no extra request', async () => {
    seed({ selectedEmail: mail('m1'), emails: [mail('m1')], mailboxes: [inbox(2)], emailListSync: { state: 's', accountId: 'acc', mailboxId: 'inbox' } });
    await useEmailStore.getState().markAsRead(client, 'm1', true);
    expect(seenRow('m1')).toBe(true);
    expect(useEmailStore.getState().mailboxes[0].unreadEmails).toBe(1);
    await settle();
    expect(fetchMailboxes).not.toHaveBeenCalled();
    expect(client.getEmailChanges).not.toHaveBeenCalled();
  });
});
