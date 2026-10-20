import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// Fork (Wnt/webmail): the push worker's kept copy of a message counts only for
// the mail account it was looked up for. Review pwa-start r3 (N4): the session
// can name another primary account while the Cache Storage lookup is out (a
// revalidation), and the copy of account A was then handed to the client as
// account B's message - at a page start within the 150 ms wait, and for a row
// the pointer rests on. The harness is auth-store-cold-start's; the page
// starts at a message link (read when lib/start-link loads). Review r4: the
// same for a session whose API URL changes under the same account ID - copies
// are bound to the client's session generation.
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import type { useAuthStore as AuthStore } from '@/stores/auth-store';
import type { useAccountStore as AccountStore } from '@/stores/account-store';
import { writeCachedSession, forgetAllCachedSessions } from '@/lib/jmap/session-cache';
import { EARLY_TOKEN_GLOBAL } from '@/lib/early-auth';

// Fresh modules per test: the auth store keeps its connected clients in module state.
let useAuthStore: typeof AuthStore;
let useAccountStore: typeof AccountStore;
let bodyReady: (id: string) => void;

const SERVER = 'https://mail.example.test';
const account = {
  id: 'alice@example.test@mail.example.test', label: 'Alice', serverUrl: SERVER, username: 'alice@example.test',
  authMode: 'oauth' as const, rememberMe: true, cookieSlot: 0, displayName: 'Alice', email: 'alice@example.test',
  isConnected: false, hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};

function session(accountId = 'acct-a', state = 's1') {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:contacts': {} },
    accounts: { [accountId]: { name: 'alice@example.test', isPersonal: true, isReadOnly: false,
      accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:contacts': {} } } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': accountId, 'urn:ietf:params:jmap:contacts': accountId },
    username: 'alice@example.test',
    apiUrl: `${SERVER}/jmap`,
    downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${SERVER}/jmap/upload/{accountId}`,
    eventSourceUrl: `${SERVER}/jmap/eventsource`,
    state,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { what: string; signedIn: boolean };
let calls: Call[] = [];
let serverSession = session();
// When set, GET /.well-known/jmap answers only once this settles.
let holdSessionGet: Promise<void> | null = null;

function describeCall(input: unknown, init?: RequestInit): string {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if ((url.endsWith('/jmap') || url.endsWith('/new-jmap')) && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { methodCalls?: [string, Record<string, unknown>][] };
    return (body.methodCalls ?? []).map(([name, args]) => (name === 'Email/get' && Array.isArray(args.ids) && args.ids.includes('m-linked') ? 'Email/get(linked)' : name)).join('+');
  }
  return `${method} ${url.replace(SERVER, '')}`;
}

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const what = describeCall(input, init);
  calls.push({ what, signedIn: useAuthStore.getState().isAuthenticated });
  const url = String(input);
  if (url.includes('/api/auth/token')) return json({ access_token: 'access-1', expires_in: 3600 });
  if (url.includes('/api/config')) return json(createConfig());
  if (url.endsWith('/.well-known/jmap')) {
    if (holdSessionGet) await holdSessionGet;
    return json(serverSession);
  }
  if ((url.endsWith('/jmap') || url.endsWith('/new-jmap')) && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    return json({
      sessionState: serverSession.state,
      methodResponses: body.methodCalls.map(([name, args, id]) => {
        if (name === 'Email/get') {
          return [name, { accountId: args.accountId, state: 'e1', notFound: [], list: (args.ids as string[]).map((eid) => ({
            id: eid, threadId: 't', mailboxIds: { inbox: true }, keywords: {}, size: 10, receivedAt: '2026-10-01T00:00:00Z',
            subject: 'Invented', from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }],
            textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
            bodyValues: { 1: { value: 'Hello', isTruncated: false } }, attachments: [],
          })) }, id];
        }
        return [name, { accountId: args.accountId, state: 'x', list: [], ids: [], notFound: [] }, id];
      }),
    });
  }
  return json({});
});

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const reload = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  holdSessionGet = null;
  calls = [];
  serverSession = session();
  fetchMock.mockClear();
  reload.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload, pathname: '/mail/message/m-linked', search: '', origin: 'http://localhost', href: 'http://localhost/mail/message/m-linked' } });
  forgetAllCachedSessions();
  delete (window as unknown as Record<string, unknown>)[EARLY_TOKEN_GLOBAL];
  ({ useAuthStore } = await import('@/stores/auth-store'));
  ({ useAccountStore } = await import('@/stores/account-store'));
  ({ bodyReady } = await import('@/lib/open-timing'));
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, error: null });
  useAccountStore.setState({ accounts: [account] as never, activeAccountId: account.id, defaultAccountId: account.id });
}, 60_000);

afterEach(() => {
  useAuthStore.getState().client?.disconnect();
});


const copies = vi.hoisted(() => ({ take: vi.fn(), peek: vi.fn() }));
vi.mock('@/lib/push-prefetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/push-prefetch')>(),
  takePrefetchedEmail: (...args: unknown[]) => copies.take(...args),
  peekPrefetchedEmail: (...args: unknown[]) => copies.peek(...args),
  keptEmailKeys: async () => new Set(['acct-a\u0000m-hover']),
}));
let releaseCopy!: (email: unknown) => void;
beforeEach(() => { sessionStorage.clear(); copies.take.mockReset(); copies.take.mockReturnValue(new Promise((r) => { releaseCopy = r; })); copies.peek.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });
const keptCopy = (id: string) => ({
  id, threadId: 't', subject: 'Kept copy of account A', bodyValues: { 1: { value: 'old body', isTruncated: false } },
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], keywords: {}, mailboxIds: { inbox: true },
});

describe('kept copies and the mail account', { timeout: 30_000 }, () => {
  it('control: a copy for the client\'s own account opens with no Email/get', async () => {
    writeCachedSession(account.id, SERVER, account.username, session('acct-a'));
    const done = useAuthStore.getState().checkAuth();
    await settle();
    releaseCopy(keptCopy('m-linked'));
    await done;
    await settle();
    const client = useAuthStore.getState().client!;
    expect(copies.take).toHaveBeenCalledWith('acct-a', 'm-linked');
    expect((await client.getEmail('m-linked'))?.subject).toBe('Kept copy of account A');
    expect(calls.filter((c) => c.what.includes('Email/get(linked)'))).toHaveLength(0);
  });

  it("a page start: the session names another account during the wait - the copy is not that account's message, and the page restarts", async () => {
    const { JMAPClient } = await import('@/lib/jmap/client');
    const original = JMAPClient.prototype.revalidateSession;
    // Cache Storage answers just after the session check, inside the 150 ms wait.
    vi.spyOn(JMAPClient.prototype, 'revalidateSession').mockImplementation(function (this: InstanceType<typeof JMAPClient>) {
      const pending = original.call(this);
      void pending.then(() => releaseCopy(keptCopy('m-linked')));
      return pending;
    });
    writeCachedSession(account.id, SERVER, account.username, session('acct-a'));
    serverSession = session('acct-b', 's2');
    await useAuthStore.getState().checkAuth();
    await settle();
    const client = useAuthStore.getState().client!;
    expect(copies.take).toHaveBeenCalledWith('acct-a', 'm-linked');
    expect(client.getAccountId()).toBe('acct-b');
    expect((await client.getEmail('m-linked'))?.subject, "account B's message, fetched").toBe('Invented');
    expect(reload, 'the page starts again with the new session').toHaveBeenCalled();
  });

  it('a row the pointer rests on: the session changes account while its copy is read', async () => {
    writeCachedSession(account.id, SERVER, account.username, session('acct-a'));
    copies.take.mockResolvedValue(null);
    await useAuthStore.getState().checkAuth();
    await settle();
    const client = useAuthStore.getState().client!;
    let releaseHover!: (email: unknown) => void;
    copies.peek.mockReturnValue(new Promise((r) => { releaseHover = r; }));
    const { watchKeptEmails, prefetchForOpen } = await import('@/lib/open-prefetch');
    watchKeptEmails();
    await Promise.resolve();
    prefetchForOpen(client, { id: 'm-hover', keywords: {}, mailboxIds: { inbox: true } } as never);
    expect(copies.peek).toHaveBeenCalledWith('acct-a', 'm-hover');
    serverSession = session('acct-b', 's2');
    await client.getEmail('m-trigger'); // a response naming a new session state: the client revalidates
    await settle();
    expect(client.getAccountId()).toBe('acct-b');
    releaseHover(keptCopy('m-hover'));
    await settle();
    expect((await client.getEmail('m-hover'))?.subject).toBe('Invented');
  });
});

describe('kept copies when the API changes with the same mail account ID', { timeout: 30_000 }, () => {
  it("a page start: the API changes during the wait while the account ID stays the same", async () => {
    const { JMAPClient } = await import('@/lib/jmap/client');
    const original = JMAPClient.prototype.revalidateSession;
    // Cache Storage answers just after the session check, inside the 150 ms wait.
    vi.spyOn(JMAPClient.prototype, 'revalidateSession').mockImplementation(function (this: InstanceType<typeof JMAPClient>) {
      const pending = original.call(this);
      void pending.then(() => releaseCopy(keptCopy('m-linked')));
      return pending;
    });
    writeCachedSession(account.id, SERVER, account.username, session('acct-a'));
    serverSession = { ...session('acct-a', 's2'), apiUrl: `${SERVER}/new-jmap` };
    await useAuthStore.getState().checkAuth();
    await settle();
    const client = useAuthStore.getState().client!;
    expect(copies.take).toHaveBeenCalledWith('acct-a', 'm-linked');
    expect(client.getAccountId()).toBe('acct-a');
    expect(reload, 'replacement before client registration still restarts').toHaveBeenCalled();
    expect(client.getSessionSnapshot?.()?.apiUrl).toBe(`${SERVER}/new-jmap`);
    expect((await client.getEmail('m-linked'))?.subject, "the replacement API's message, fetched").toBe('Invented');
    expect(reload, 'the page starts again with the new session').toHaveBeenCalled();
  });

  it('a row the pointer rests on: the API changes while its copy is read', async () => {
    writeCachedSession(account.id, SERVER, account.username, session('acct-a'));
    copies.take.mockResolvedValue(null);
    await useAuthStore.getState().checkAuth();
    await settle();
    const client = useAuthStore.getState().client!;
    let releaseHover!: (email: unknown) => void;
    copies.peek.mockReturnValue(new Promise((r) => { releaseHover = r; }));
    const { watchKeptEmails, prefetchForOpen } = await import('@/lib/open-prefetch');
    watchKeptEmails();
    await Promise.resolve();
    prefetchForOpen(client, { id: 'm-hover', keywords: {}, mailboxIds: { inbox: true } } as never);
    expect(copies.peek).toHaveBeenCalledWith('acct-a', 'm-hover');
    serverSession = { ...session('acct-a', 's2'), apiUrl: `${SERVER}/new-jmap` };
    await client.getEmail('m-trigger'); // a response naming a new session state: the client revalidates
    await settle();
    expect(client.getAccountId()).toBe('acct-a');
    expect(client.getSessionSnapshot?.()?.apiUrl).toBe(`${SERVER}/new-jmap`);
    releaseHover(keptCopy('m-hover'));
    await settle();
    expect((await client.getEmail('m-hover'))?.subject).toBe('Invented');
  });
});

describe('client insertion APIs across a session replacement (same account ID, new API URL)', { timeout: 30_000 }, () => {
  it('a copy looked up before the replacement is not primed after it (the running app\'s deep link)', async () => {
    writeCachedSession(account.id, SERVER, account.username, session('acct-a'));
    copies.take.mockResolvedValue(null);
    await useAuthStore.getState().checkAuth();
    await settle();
    const client = useAuthStore.getState().client!;
    const capturedAccount = client.getAccountId();
    const capturedGeneration = client.getSessionGeneration?.();
    const copy = keptCopy('m-prime');
    serverSession = { ...session('acct-a', 's2'), apiUrl: `${SERVER}/new-jmap` };
    expect(await (client as unknown as { revalidateSession: () => Promise<string> }).revalidateSession()).toBe('replaced');
    client.primeEmail?.(copy as never, capturedAccount, { generation: capturedGeneration });
    expect((await client.getEmail('m-prime'))?.subject).toBe('Invented');
  });
  it('an already primed entry is not reused after an API replacement', async () => {
    writeCachedSession(account.id, SERVER, account.username, session('acct-a'));
    copies.take.mockResolvedValue(null);
    await useAuthStore.getState().checkAuth();
    await settle();
    const client = useAuthStore.getState().client!;
    await client.prefetchEmail?.('m-existing', keptCopy('m-existing') as never, { keptAccountId: client.getAccountId(), keptGeneration: client.getSessionGeneration?.() });
    expect(calls.filter((c) => c.what.includes('m-existing')), 'primed, not fetched').toHaveLength(0);
    serverSession = { ...session('acct-a', 's2'), apiUrl: `${SERVER}/new-jmap` };
    expect(await (client as unknown as { revalidateSession: () => Promise<string> }).revalidateSession()).toBe('replaced');
    expect((await client.getEmail('m-existing'))?.subject).toBe('Invented');
  });
});
