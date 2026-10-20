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

// Astra r2 (audit/reviews/notif-mark-read-r2.md): the catch-up and the counts
// it refreshes stay within their account epoch and list, a newer write wins
// over an answer that predates it, other list publishers are caught up too,
// and a failed catch-up re-queries the list.
describe('after the write: account epochs, identity, newer writes, every list', () => {
  const sharedBox = (id: string, accountId: string): Mailbox => ({ ...inbox(1), id, name: id, role: null, isShared: true, accountId } as unknown as Mailbox);
  const realStore = () => useEmailStore.getInitialState();

  it('a catch-up answered after an account switch changes nothing in the next account', async () => {
    seed({
      selectedEmail: mail('m-tapped'), emails: [mail('m-other')], mailboxes: [inbox(2)],
      emailListSync: { state: 's-before', accountId: 'acc', mailboxId: 'inbox' },
    });
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-other'] });
    const answer = deferred<Email[]>();
    client.getSomeEmails.mockReturnValueOnce(answer.promise);
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    await vi.waitFor(() => expect(client.getSomeEmails).toHaveBeenCalled());
    // Switched: the next account shows its own "m-other".
    bumpStoreEpoch();
    useAuthStore.setState({ activeAccountId: 'login-b', client: makeClient() as never } as never);
    const sync = { state: 'b-state', accountId: 'acc-b', mailboxId: 'inbox' };
    seed({ emails: [mail('m-other', {}, { subject: 'B private message' })], mailboxes: [inbox(5)], emailListSync: sync });
    answer.resolve([mail('m-other', { $seen: true }, { subject: 'A private message' })]);
    await settle();
    await settle();
    expect(useEmailStore.getState().emails[0].subject).toBe('B private message');
    expect(seenRow('m-other')).toBeUndefined();
    expect(useEmailStore.getState().emailListSync).toBe(sync);
    expect(refreshCurrentMailbox).not.toHaveBeenCalled();
  });

  it('tag counts answered after an account switch are dropped', async () => {
    useEmailStore.setState({ fetchTagCounts: realStore().fetchTagCounts } as never);
    const { useSettingsStore } = await import('../settings-store');
    useSettingsStore.setState({ emailKeywords: [{ id: 'work', name: 'Work' }] } as never);
    const counts = deferred<Record<string, { total: number; unread: number }>>();
    const tagClient = { ...makeClient(), getTagCounts: vi.fn().mockReturnValue(counts.promise) } as unknown as IJMAPClient;
    useEmailStore.setState({ tagCounts: { work: { total: 7, unread: 7 } }, mailboxes: [inbox(1)] } as never);
    const running = useEmailStore.getState().fetchTagCounts(tagClient);
    bumpStoreEpoch();
    useEmailStore.setState({ tagCounts: { work: { total: 7, unread: 7 } } } as never);
    counts.resolve({ work: { total: 1, unread: 0 } });
    await running;
    expect(useEmailStore.getState().tagCounts).toEqual({ work: { total: 7, unread: 7 } });
  });

  it('an unstamped message of another shared folder, opened while the write was out, is not marked', async () => {
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    const boxes = [inbox(1), sharedBox('shared-a-box', 'shared-a'), sharedBox('shared-b-box', 'shared-b')];
    seed({ selectedEmail: mail('m'), selectedMailbox: 'shared-a-box', mailboxes: boxes });
    const marking = useEmailStore.getState().markAsRead(client, 'm', true);
    expect(client.markAsRead).toHaveBeenCalledWith('m', true, 'shared-a');
    // The user opens shared-b: its own unstamped "m" is listed and opened.
    useEmailStore.setState({ selectedMailbox: 'shared-b-box', emails: [mail('m')], selectedEmail: mail('m') } as never);
    write.resolve();
    await marking;
    expect(seenRow('m')).toBeUndefined();
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBeUndefined();
  });

  it('the open message is written, not a list row of another account with the same id', async () => {
    seed({
      selectedEmail: mail('m', {}, { sourceClientAccountId: 'login', sourceAccountId: 'shared-a' }),
      emails: [mail('m', { $seen: true }, { sourceClientAccountId: 'login', sourceAccountId: 'shared-b' })],
      mailboxes: [inbox(2)],
    });
    await useEmailStore.getState().markAsRead(client, 'm', true);
    expect(client.markAsRead).toHaveBeenCalledWith('m', true, 'shared-a');
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBe(true);
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBe(true); // shared-b's own state, untouched
  });

  it('marked unread while the catch-up is out: the newer state stays', async () => {
    seed({ selectedEmail: mail('m-tapped'), mailboxes: [inbox(3)] });
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    const marking = useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    // The row arrives before the write is confirmed; the list is a plain folder.
    useEmailStore.setState({ emails: [mail('m-tapped')], emailListSync: { state: 's-before', accountId: 'acc', mailboxId: 'inbox' } } as never);
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-tapped'] });
    const snapshot = deferred<Email[]>();
    client.getSomeEmails.mockReturnValueOnce(snapshot.promise);
    write.resolve();
    await marking;
    await vi.waitFor(() => expect(client.getSomeEmails).toHaveBeenCalled());
    // The user marks it unread; then the catch-up's earlier snapshot (read) arrives.
    await useEmailStore.getState().markAsRead(client, 'm-tapped', false);
    expect(seenRow('m-tapped')).toBe(false);
    snapshot.resolve([mail('m-tapped', { $seen: true })]);
    await settle();
    await settle();
    expect(seenRow('m-tapped')).toBe(false);
  });

  it('a next page fetched before the write is caught up when it lands', async () => {
    seed({
      selectedEmail: mail('m-old'), emails: [mail('m-1', { $seen: true })], mailboxes: [inbox(3)], hasMoreEmails: true,
      emailListSync: { state: 's-before', accountId: 'acc', mailboxId: 'inbox' },
    } as never);
    useEmailStore.setState({ loadMoreEmails: realStore().loadMoreEmails, isLoadingMore: false } as never);
    const page2 = deferred<ReturnType<typeof page>>();
    client.getEmails.mockReturnValueOnce(page2.promise);
    const loading = useEmailStore.getState().loadMoreEmails(client);
    client.getEmailChanges.mockResolvedValue(noChanges('s-before'));
    await useEmailStore.getState().markAsRead(client, 'm-old', true);
    await settle();
    client.getEmailChanges.mockClear();
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-old'] });
    client.getSomeEmails.mockResolvedValue([mail('m-old', { $seen: true })]);
    page2.resolve({ ...page([mail('m-old')]), hasMore: false });
    await loading;
    await vi.waitFor(() => expect(seenRow('m-old')).toBe(true));
    expect(client.getEmailChanges).toHaveBeenCalled();
  });

  it('a failed catch-up re-queries the list', async () => {
    seed({
      selectedEmail: mail('m-new'), emails: [mail('m-old', { $seen: true })], mailboxes: [inbox(2)],
      emailListSync: { state: 's-before', accountId: 'acc', mailboxId: 'inbox' },
    });
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-old'] });
    client.getSomeEmails.mockRejectedValue(new Error('Email/get failed'));
    await useEmailStore.getState().markAsRead(client, 'm-new', true);
    await vi.waitFor(() => expect(refreshCurrentMailbox).toHaveBeenCalledWith(client));
  });

  it('another login\'s folders: one request at a time, the last answer is the newest', async () => {
    useEmailStore.setState({ fetchAccountMailboxes: realStore().fetchAccountMailboxes } as never);
    const other = makeClient() as MockClient & { getMailboxes: ReturnType<typeof vi.fn> };
    const first = deferred<Mailbox[]>();
    other.getMailboxes = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([inbox(0)]);
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-b' ? other : client) as never } as never);
    seed({
      fetchAccountMailboxes: realStore().fetchAccountMailboxes,
      selectedEmail: mail('m-b', {}, { sourceClientAccountId: 'login-b', sourceAccountId: 'acc-b' }),
      accountMailboxes: { 'login-b': [inbox(1)] }, mailboxes: [inbox(5)],
    });
    // A load of login-b's folders is already out (from before the write).
    const earlier = useEmailStore.getState().fetchAccountMailboxes(other, 'login-b');
    await useEmailStore.getState().markAsRead(client, 'm-b', true);
    first.resolve([inbox(1)]);
    await earlier;
    await vi.waitFor(() => expect(other.getMailboxes).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useEmailStore.getState().accountMailboxes['login-b'][0].unreadEmails).toBe(0));
  });

  it('the same client back in a new account epoch gets its own folder-list run', async () => {
    useEmailStore.setState({ fetchMailboxes: realStore().fetchMailboxes, mailboxes: [] } as never);
    const old = deferred<{ mailboxes: Mailbox[]; states: Record<string, string> }>();
    client.getAllMailboxesWithState.mockReturnValueOnce(old.promise).mockResolvedValue({ mailboxes: [inbox(4)], states: {} });
    const first = useEmailStore.getState().fetchMailboxes(client);
    bumpStoreEpoch(); // away and back: the same connected client
    const second = useEmailStore.getState().fetchMailboxes(client);
    await second;
    expect(client.getAllMailboxesWithState).toHaveBeenCalledTimes(2);
    expect(useEmailStore.getState().mailboxes[0]?.unreadEmails).toBe(4);
    old.resolve({ mailboxes: [inbox(1)], states: {} });
    await first;
    expect(useEmailStore.getState().mailboxes[0]?.unreadEmails).toBe(4);
  });
});

// Astra r3 (audit/reviews/notif-mark-read-r3.md, final scoped round).
describe('after the write: queued deltas, viewed logins, per-keyword merge', () => {
  it('a catch-up queued behind another delta and run after an account switch does nothing', async () => {
    seed({
      selectedEmail: mail('m-tapped'), emails: [mail('m-other')], mailboxes: [inbox(2)],
      emailListSync: { state: 's-before', accountId: 'acc', mailboxId: 'inbox' },
    });
    // A push delta is out; the read's catch-up queues behind it.
    const first = deferred<ReturnType<typeof noChanges>>();
    client.getEmailChanges.mockReturnValueOnce(first.promise);
    const pushDelta = useEmailStore.getState().applyEmailDelta(client, 's-push');
    await useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    bumpStoreEpoch();
    useAuthStore.setState({ activeAccountId: 'login-b', client: makeClient() as never } as never);
    const sync = { state: 's-before', accountId: 'acc', mailboxId: 'inbox' };
    seed({ emails: [mail('m-other', {}, { subject: 'B private message' })], mailboxes: [inbox(5)], emailListSync: sync });
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-other'] });
    client.getSomeEmails.mockResolvedValue([mail('m-other', { $seen: true }, { subject: 'A private message' })]);
    first.resolve(noChanges('s-before'));
    await pushDelta;
    await settle();
    await settle();
    expect(client.getEmailChanges).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails[0].subject).toBe('B private message');
    expect(useEmailStore.getState().emailListSync).toBe(sync);
  });

  it('an unstamped message of another login viewed while the write was out is not marked', async () => {
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    const other = makeClient();
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-b' ? other : client) as never } as never);
    seed({ selectedEmail: mail('m'), mailboxes: [inbox(1)] });
    const marking = useEmailStore.getState().markAsRead(client, 'm', true);
    // The user views login-b's Inbox and opens its own unstamped "m".
    useEmailStore.setState({ viewingAccountId: 'login-b', emails: [mail('m')], selectedEmail: mail('m') } as never);
    write.resolve();
    await marking;
    expect(seenRow('m')).toBeUndefined();
    expect(useEmailStore.getState().selectedEmail?.keywords?.$seen).toBeUndefined();
  });

  it('starred while the catch-up is out: the star stays and the server\'s read state is taken', async () => {
    seed({ selectedEmail: mail('m-tapped'), mailboxes: [inbox(3)] });
    const write = deferred<void>();
    client.markAsRead.mockReturnValueOnce(write.promise);
    const marking = useEmailStore.getState().markAsRead(client, 'm-tapped', true);
    write.resolve();
    await marking;
    // Its catch-up's answer is held.
    client.getEmailChanges.mockResolvedValue({ ...noChanges('s-before'), newState: 's-after', updated: ['m-tapped'] });
    const snapshot = deferred<Email[]>();
    client.getSomeEmails.mockReturnValueOnce(snapshot.promise);
    // The list as it landed from before the write, and its catch-up delta.
    useEmailStore.setState({ emails: [mail('m-tapped')], emailListSync: { state: 's-before', accountId: 'acc', mailboxId: 'inbox' } } as never);
    void useEmailStore.getState().applyEmailDelta(client, 's-push');
    await vi.waitFor(() => expect(client.getSomeEmails).toHaveBeenCalled());
    // Starred here meanwhile.
    useEmailStore.setState((st) => ({ emails: st.emails.map((e) => ({ ...e, keywords: { ...e.keywords, $flagged: true } })) }) as never);
    snapshot.resolve([mail('m-tapped', { $seen: true })]);
    await settle();
    await settle();
    const row = useEmailStore.getState().emails[0];
    expect(row.keywords?.$seen).toBe(true);
    expect(row.keywords?.$flagged).toBe(true);
  });

  it('a message of the login being viewed: that login\'s folders are fetched again, not the active one\'s', async () => {
    const other = makeClient();
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-b' ? other : client) as never } as never);
    seed({ viewingAccountId: 'login-b', selectedEmail: mail('m-b'), accountMailboxes: { 'login-b': [inbox(1)] }, mailboxes: [inbox(5)] });
    await useEmailStore.getState().markAsRead(client, 'm-b', true);
    expect(other.markAsRead).toHaveBeenCalledWith('m-b', true, undefined);
    expect(fetchAccountMailboxes).toHaveBeenCalledWith(other, 'login-b');
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });
});
