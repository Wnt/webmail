import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// Fork (Wnt/webmail) perf gate: a page start at a message link (a tapped
// notification on WebKit, a cold start) used to make two round trips before
// the app counted as signed in - PUT /api/auth/token, then GET
// /.well-known/jmap - and asked for the message only after the first signed-in
// render. Now:
//  - the session kept from the last visit makes the client ready after the
//    token alone (checked against the server right after);
//  - the token request the page's head script already sent is taken, not sent
//    again;
//  - the linked message is asked for as soon as the session is up, and the
//    contacts, calendars and the rest wait for its body on screen.
// The page starts at a message link (read when lib/start-link loads, below).
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import type { useAuthStore as AuthStore } from '@/stores/auth-store';
import type { useAccountStore as AccountStore } from '@/stores/account-store';
import { readCachedSession, writeCachedSession, forgetAllCachedSessions } from '@/lib/jmap/session-cache';
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
  if (url.endsWith('/jmap') && method === 'POST') {
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
  if (url.endsWith('/jmap') && init?.method === 'POST') {
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

describe('page start at a message link', { timeout: 20_000 }, () => {
  it('with the kept session: signed in after the token alone; the session is checked after', async () => {
    writeCachedSession(account.id, SERVER, account.username, session());
    let release!: () => void;
    holdSessionGet = new Promise<void>((resolve) => { release = resolve; });
    // The server's session does not answer: signing in must not wait for it.
    const done = await Promise.race([
      useAuthStore.getState().checkAuth().then(() => 'signed in'),
      new Promise((resolve) => setTimeout(() => resolve('waited for the session'), 3000)),
    ]);
    release();
    expect(done).toBe('signed in');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(calls.filter((c) => c.what.startsWith('PUT /api/auth/token'))).toHaveLength(1);
    await settle();
    expect(calls.map((c) => c.what), 'the kept session is checked against the server').toContain('GET /.well-known/jmap');
    expect(reload).not.toHaveBeenCalled();
  });

  it('without one: fetches the session, and keeps it for the next start', async () => {
    await useAuthStore.getState().checkAuth();
    expect(calls.filter((c) => !c.signedIn).map((c) => c.what)).toContain('GET /.well-known/jmap');
    expect(readCachedSession(account.id, SERVER, account.username)).toMatchObject({ apiUrl: `${SERVER}/jmap`, state: 's1' });
  });

  it('a kept session of another user or server is not used', async () => {
    writeCachedSession(account.id, SERVER, 'mallory@example.test', session());
    await useAuthStore.getState().checkAuth();
    expect(calls.filter((c) => !c.signedIn).map((c) => c.what)).toContain('GET /.well-known/jmap');
  });

  it('a different mail account on the server starts the page again with the new session', async () => {
    writeCachedSession(account.id, SERVER, account.username, session('acct-old'));
    serverSession = session('acct-new', 's2');
    await useAuthStore.getState().checkAuth();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readCachedSession(account.id, SERVER, account.username)).toMatchObject({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-new' } });
  });

  it('a response naming another session state fetches the session again', async () => {
    writeCachedSession(account.id, SERVER, account.username, session('acct-a', 's1'));
    await useAuthStore.getState().checkAuth();
    await settle();
    const sessionGets = () => calls.filter((c) => c.what === 'GET /.well-known/jmap').length;
    const before = sessionGets();
    serverSession = session('acct-a', 's2');
    await useAuthStore.getState().client!.getEmail('m-other');
    await settle();
    expect(sessionGets()).toBe(before + 1);
    expect(readCachedSession(account.id, SERVER, account.username)).toMatchObject({ state: 's2' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('removing the login forgets its session', async () => {
    writeCachedSession(account.id, SERVER, account.username, session());
    useAccountStore.getState().removeAccount(account.id);
    expect(readCachedSession(account.id, SERVER, account.username)).toBeNull();
  });

  it("takes the head script's token request instead of sending its own", async () => {
    writeCachedSession(account.id, SERVER, account.username, session());
    (window as unknown as Record<string, unknown>)[EARLY_TOKEN_GLOBAL] = {
      slot: 0, at: Date.now(), response: Promise.resolve(json({ access_token: 'early', expires_in: 3600 })), abort: () => {},
    };
    await useAuthStore.getState().checkAuth();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(calls.filter((c) => c.what.startsWith('PUT /api/auth/token'))).toHaveLength(0);
    expect(useAuthStore.getState().client!.getAuthHeader()).toBe('Bearer early');
  });

  it("ignores the head script's request for another login slot", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_TOKEN_GLOBAL] = {
      slot: 3, at: Date.now(), response: Promise.resolve(json({ access_token: 'other', expires_in: 3600 })), abort: () => {},
    };
    await useAuthStore.getState().checkAuth();
    expect(calls.filter((c) => c.what.startsWith('PUT /api/auth/token'))).toHaveLength(1);
    expect(useAuthStore.getState().client!.getAuthHeader()).toBe('Bearer access-1');
  });

  it('asks for the linked message at the session, and holds the contacts until its body is on screen', async () => {
    writeCachedSession(account.id, SERVER, account.username, session());
    await useAuthStore.getState().checkAuth();
    await settle();
    const order = calls.map((c) => c.what);
    const linked = calls.findIndex((c) => c.what.includes('Email/get(linked)'));
    expect(linked, 'the linked message is asked for').toBeGreaterThanOrEqual(0);
    expect(calls[linked].signedIn, 'before the first signed-in render').toBe(false);
    expect(order.some((w) => w.includes('AddressBook/get') || w.includes('ContactCard/')), 'contacts wait for the body').toBe(false);
    // The deep link's own fetch takes the prefetched copy: no second Email/get.
    const email = await useAuthStore.getState().client!.getEmail('m-linked');
    expect(email?.id).toBe('m-linked');
    expect(calls.filter((c) => c.what.includes('Email/get(linked)'))).toHaveLength(1);
    bodyReady('m-linked');
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(calls.map((c) => c.what).some((w) => w.includes('AddressBook/get') || w.includes('ContactCard/')), 'contacts load after the body').toBe(true);
  });
});
