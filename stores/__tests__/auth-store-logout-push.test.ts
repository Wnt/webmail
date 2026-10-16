import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';

// Audit bulwark-1: an explicit sign-out ends Web Push on the device; a session
// or token that merely expired must keep it (push without a session is a core
// requirement). All remote calls are mocked.

const RELAY = 'https://mail.example.com/relay';
vi.mock('@/lib/push-relay-current', () => ({ currentRelayUrl: async () => 'https://mail.example.com/relay' }));

type FetchInit = Parameters<typeof fetch>[1];
type Handler = (init?: FetchInit) => unknown;

const IDP_LOGOUT = 'https://id.example.com/realms/mail/protocol/openid-connect/logout?client_id=webmail&id_token_hint=eyJ.x.y';
const ok = (body: object = {}) => ({ ok: true, status: 200, json: async () => body });

/** Route fetch calls by "METHOD url"; records every call in order into `log`. */
function mockFetch(routes: Record<string, Handler>, log: string[]) {
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: FetchInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    log.push(key);
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected fetch call: ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
  return {
    id: 'alice@example.com@mail.example.com',
    label: 'Alice',
    serverUrl: 'https://mail.example.com',
    username: 'alice@example.com',
    authMode: 'oauth',
    cookieSlot: 0,
    rememberMe: true,
    providerSession: true,
    displayName: 'Alice',
    email: 'alice@example.com',
    avatarColor: '#336699',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: true,
    ...overrides,
  };
}

/** Cache Storage stand-in: the service worker reads the sign-out markers from it. */
function stubCaches() {
  const store = new Map<string, string>();
  vi.stubGlobal('caches', {
    open: async () => ({
      put: async (key: string, res: Response) => { store.set(key, await res.text()); },
      delete: async (key: string) => store.delete(key),
      match: async (key: string) => store.has(key) ? new Response(store.get(key)) : undefined,
    }),
  });
  return store;
}

function setup(log: string[]) {
  let subscribed = true;
  const unsubscribe = vi.fn(async () => { log.push('browser unsubscribe'); subscribed = false; return true; });
  const notification = { tag: 'bulwark-mail:acc1', close: vi.fn() };
  const other = { tag: 'unrelated', close: vi.fn() };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    getRegistration: vi.fn(async () => ({
      pushManager: { getSubscription: async () => (subscribed ? { unsubscribe } : null) },
      getNotifications: async () => [notification, other],
    })),
  }});
  const acct = account();
  useAccountStore.setState({ accounts: [acct], activeAccountId: acct.id, defaultAccountId: acct.id });
  useAuthStore.setState({
    isAuthenticated: true, authMode: 'oauth', activeAccountId: acct.id,
    username: acct.username, serverUrl: acct.serverUrl,
  });
  localStorage.setItem('bulwark.push.deviceClientId.v1.acc1', 'device1');
  localStorage.setItem('bulwark.push.subscriptionId.v1.acc1', 'subscription1');
  localStorage.setItem('bulwark.push.subscriptionRelay.v1.acc1', RELAY);
  const client = {
    disconnect: vi.fn(() => { log.push('disconnect'); }),
    getAccountId: () => 'acc1',
    listPushSubscriptions: async () => [{ id: 'subscription1', deviceClientId: 'device1' }],
    destroyPushSubscription: vi.fn(async (id: string) => { log.push(`destroy ${id}`); }),
  };
  useAuthStore.setState({ client: client as never });
  const caches = stubCaches();
  return { client, unsubscribe, notification, other, caches, isSubscribed: () => subscribed };
}

const credentialRoutes = {
  'DELETE /api/auth/session?slot=0': () => ok(),
  'DELETE /api/auth/token?slot=0&end_session=true': () => ok({ ok: true, end_session_url: IDP_LOGOUT }),
  'DELETE /api/auth/token?slot=0': () => ok({ ok: true }),
  [`DELETE ${RELAY}/api/push/register/device1`]: () => ok(),
};

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  window.history.pushState({}, '', '/en/mail');
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({
    isAuthenticated: false, isLoading: false, error: null, serverUrl: null, username: null,
    client: null, identities: [], primaryIdentity: null, authMode: 'basic', rememberMe: false,
    accessToken: null, tokenExpiresAt: null, connectionLost: false, activeAccountId: null, isDemoMode: false,
  });
  vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('explicit sign-out', () => {
  it('unsubscribes the browser from future mail pushes', async () => {
    const log: string[] = [];
    const { unsubscribe, isSubscribed } = setup(log);
    mockFetch(credentialRoutes, log);
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(isSubscribed()).toBe(false);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('removes the server and relay records before the client disconnects and the token is revoked', async () => {
    const log: string[] = [];
    setup(log);
    mockFetch(credentialRoutes, log);
    await useAuthStore.getState().logout();
    const at = (entry: string) => log.indexOf(entry);
    expect(at('destroy subscription1')).toBeGreaterThanOrEqual(0);
    expect(at(`DELETE ${RELAY}/api/push/register/device1`)).toBeGreaterThanOrEqual(0);
    for (const step of ['destroy subscription1', `DELETE ${RELAY}/api/push/register/device1`]) {
      expect(at(step)).toBeLessThan(at('disconnect'));
      expect(at(step)).toBeLessThan(at('DELETE /api/auth/token?slot=0&end_session=true'));
    }
    // No later session restore may re-enable push for the account.
    expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBeNull();
  });

  it('closes the account notifications and leaves markers for the service worker', async () => {
    const log: string[] = [];
    const { notification, other, caches } = setup(log);
    mockFetch(credentialRoutes, log);
    await useAuthStore.getState().logout();
    expect(notification.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
    expect([...caches.keys()].sort()).toEqual([
      `${window.location.origin}/__push-state/signed-out-all`,
      `${window.location.origin}/__push-state/signed-out/acc1`,
    ]);
  });

  it('finishes even when the push teardown cannot reach the network', async () => {
    const log: string[] = [];
    const { client, caches } = setup(log);
    client.destroyPushSubscription.mockImplementation(() => new Promise(() => {}));
    mockFetch(credentialRoutes, log);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(caches.has(`${window.location.origin}/__push-state/signed-out/acc1`)).toBe(true);
    expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBeNull();
  });

  it('sign out of every account tears push down too', async () => {
    const log: string[] = [];
    const { unsubscribe, caches } = setup(log);
    mockFetch({
      'DELETE /api/auth/session?all=true': () => ok(),
      'DELETE /api/auth/token?all=true&end_session_slot=0': () => ok({ ok: true }),
      'DELETE /api/auth/token?all=true': () => ok({ ok: true }),
      [`DELETE ${RELAY}/api/push/register/device1`]: () => ok(),
    }, log);
    await useAuthStore.getState().logoutAll();
    expect(unsubscribe).toHaveBeenCalled();
    expect(caches.has(`${window.location.origin}/__push-state/signed-out-all`)).toBe(true);
    expect(log.indexOf('destroy subscription1')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('destroy subscription1')).toBeLessThan(log.findIndex((e) => e.startsWith('DELETE /api/auth/token?all=true')));
  });
});

describe('a session that merely expired keeps push', () => {
  it('logout({ endProviderSession: false }) leaves every push record alone', async () => {
    const log: string[] = [];
    const { client, unsubscribe, notification, caches } = setup(log);
    mockFetch(credentialRoutes, log);
    await useAuthStore.getState().logout({ endProviderSession: false });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
    expect(log.some((e) => e.includes('/api/push/register/'))).toBe(false);
    expect(notification.close).not.toHaveBeenCalled();
    expect(caches.size).toBe(0);
    expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBe('subscription1');
  });

  it('a refresh token the server rejects (401) signs out without touching push', async () => {
    const log: string[] = [];
    const { client, unsubscribe, caches } = setup(log);
    mockFetch({
      ...credentialRoutes,
      'PUT /api/auth/token?slot=0&force=true': () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }) }),
    }, log);
    await useAuthStore.getState().refreshAccessToken();
    await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false));
    await vi.waitFor(() => expect(log).toContain('DELETE /api/auth/token?slot=0'));
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
    expect(caches.size).toBe(0);
    expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBe('subscription1');
  });
});

describe('accounts without a connected client', () => {
  it('explicitly removing one still silences its push on this device', async () => {
    const log: string[] = [];
    const { caches } = setup(log);
    const other = account({ id: 'bob@example.com@mail.example.com', username: 'bob@example.com', cookieSlot: 1, isConnected: false, isDefault: false });
    useAccountStore.setState({ accounts: [account(), other] });
    // Recorded when bob's client was last connected here.
    const { rememberPushAccount } = await import('@/lib/push-signout-state');
    rememberPushAccount(other.id, 'acc2');
    localStorage.setItem('bulwark.push.deviceClientId.v1.acc2', 'device2');
    localStorage.setItem('bulwark.push.subscriptionId.v1.acc2', 'subscription2');
    mockFetch({
      ...credentialRoutes,
      'DELETE /api/auth/session?slot=1': () => ok(),
      'DELETE /api/auth/token?slot=1': () => ok(),
      [`DELETE ${RELAY}/api/push/register/device2`]: () => ok(),
    }, log);
    useAuthStore.getState().removeAccount(other.id);
    await vi.waitFor(() => expect(log).toContain('DELETE /api/auth/token?slot=1'));
    expect(useAccountStore.getState().accounts.map((a) => a.id)).not.toContain(other.id);
    expect(caches.has(`${window.location.origin}/__push-state/signed-out/acc2`)).toBe(true);
    expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc2')).toBeNull();
    // The relay forgets this browser for bob before his credentials go.
    expect(log.indexOf(`DELETE ${RELAY}/api/push/register/device2`)).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`DELETE ${RELAY}/api/push/register/device2`)).toBeLessThan(log.indexOf('DELETE /api/auth/token?slot=1'));
    // alice keeps push: her record, the browser subscription and her account are untouched.
    expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBe('subscription1');
    expect(caches.has(`${window.location.origin}/__push-state/signed-out/acc1`)).toBe(false);
  });

  it('signing out of everything covers every account with a push opt-in here', async () => {
    const log: string[] = [];
    const { caches } = setup(log);
    localStorage.setItem('bulwark.push.deviceClientId.v1.acc9', 'device9');
    localStorage.setItem('bulwark.push.subscriptionId.v1.acc9', 'subscription9');
    mockFetch({ ...credentialRoutes, [`DELETE ${RELAY}/api/push/register/device9`]: () => ok() }, log);
    await useAuthStore.getState().logout();
    expect(caches.has(`${window.location.origin}/__push-state/signed-out/acc9`)).toBe(true);
    expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc9')).toBeNull();
    expect(log).toContain(`DELETE ${RELAY}/api/push/register/device9`);
  });
});
