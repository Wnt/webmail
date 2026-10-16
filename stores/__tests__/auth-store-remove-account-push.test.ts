import { beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// Audit bulwark-1: removing one signed-in account on purpose ends its Web
// Push before its client and credentials go; a removal the user did not ask
// for (an unrenewable session) leaves push alone.

const events: string[] = [];
const teardown = vi.hoisted(() => vi.fn());

vi.mock('@/lib/push-signout', () => ({
  teardownPushOnSignOut: teardown,
  clearPushSignedOut: async () => {},
}));

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'i', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return 'Basic eA=='; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() { events.push(`disconnect ${this.username}`); }
    getAccountId() { return `jmap-${this.username}`; }
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { useAuthStore } from '@/stores/auth-store';
import { reservedCookieSlots, useAccountStore } from '@/stores/account-store';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';

const acct = (username: string, host: string, slot: number) => ({
  id: `${username}@${host}`, label: username, serverUrl: `https://${host}`, username, authMode: 'basic' as const,
  rememberMe: true, cookieSlot: slot, displayName: username, email: username, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const A = acct('a@x.test', 'mail.x.test', 0);
const B = acct('b@y.test', 'mail.y.test', 1);

beforeEach(async () => {
  events.length = 0;
  localStorage.removeItem('bulwark.cookieSlotReservations.v1');
  teardown.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'DELETE') events.push(`DELETE ${url}`);
    if (init?.method === 'POST' && url.startsWith('/api/auth/session')) events.push(`POST ${url}`);
    const m = url.match(/\/api\/auth\/session\?slot=(\d)/);
    if (m && (init?.method ?? 'GET') !== 'DELETE') {
      const a = [A, B][Number(m[1])];
      return new Response(JSON.stringify({ serverUrl: a.serverUrl, username: a.username, password: 'pw' }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  useAccountStore.setState({ accounts: [A, B] as never, activeAccountId: A.id, defaultAccountId: A.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: A.id, client: null });
  // Connect both logins (network path), ending on A.
  await useAuthStore.getState().switchAccount(B.id);
  await useAuthStore.getState().switchAccount(A.id);
  events.length = 0;
});

it('an explicit removal tears down the account push first, then its client and credentials', async () => {
  let finish!: () => void;
  teardown.mockImplementation(() => new Promise<void>((resolve) => {
    events.push('teardown');
    finish = () => { events.push('teardown done'); resolve(); };
  }));
  useAuthStore.getState().removeAccount(B.id);
  expect(teardown).toHaveBeenCalledTimes(1);
  const [{ clients, loginIds, everyAccount }] = teardown.mock.calls[0];
  expect(clients.map((c: { getAccountId: () => string }) => c.getAccountId())).toEqual(['jmap-b@y.test']);
  expect(loginIds).toEqual([B.id]);
  expect(everyAccount).toBe(false);
  // Nothing is revoked or disconnected while the teardown still needs them.
  // The account leaves the list at once, but its cookie slot stays reserved:
  // a new sign-in cannot take it over.
  await new Promise((r) => setTimeout(r, 10));
  expect(events).toEqual(['teardown']);
  expect(useAccountStore.getState().getAccountById(B.id)).toBeUndefined();
  expect(useAccountStore.getState().getNextCookieSlot()).not.toBe(B.cookieSlot);
  finish();
  await vi.waitFor(() => expect(events).toContain('DELETE /api/auth/session?slot=1'));
  expect(events.indexOf('disconnect b@y.test')).toBeGreaterThan(events.indexOf('teardown done'));
  expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([A.id]);
  await vi.waitFor(() => expect(useAccountStore.getState().getNextCookieSlot()).toBe(B.cookieSlot));
});

it('a removal the user did not ask for leaves push alone', async () => {
  useAuthStore.getState().removeAccount(B.id, { endProviderSession: false });
  await vi.waitFor(() => expect(events).toContain('DELETE /api/auth/session?slot=1'));
  expect(teardown).not.toHaveBeenCalled();
  expect(events).toContain('disconnect b@y.test');
});

it('signing out of the active account while another stays tears down only that account', async () => {
  teardown.mockResolvedValue(undefined);
  await useAuthStore.getState().logout();
  expect(teardown).toHaveBeenCalledTimes(1);
  const [{ clients, everyAccount }] = teardown.mock.calls[0];
  expect(clients.map((c: { getAccountId: () => string }) => c.getAccountId())).toEqual(['jmap-a@x.test']);
  expect(everyAccount).toBe(false);
  expect(useAuthStore.getState().activeAccountId).toBe(B.id);
});

it('remembers which push account each connected login is', () => {
  expect(localStorage.getItem(`bulwark.push.loginAccount.v1.${A.id}`)).toBe('jmap-a@x.test');
  expect(localStorage.getItem(`bulwark.push.loginAccount.v1.${B.id}`)).toBe('jmap-b@y.test');
});

it('the cookie slot stays reserved until the credential DELETEs have answered', async () => {
  teardown.mockResolvedValue(undefined);
  let answer!: () => void;
  const held = new Promise<void>((resolve) => { answer = resolve; });
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/auth/session?slot=1' && init?.method === 'DELETE') {
      events.push('DELETE held');
      await held;
    }
    return base(input as never, init);
  }));
  useAuthStore.getState().removeAccount(B.id);
  await vi.waitFor(() => expect(events).toContain('DELETE held'));
  expect(useAccountStore.getState().getNextCookieSlot()).not.toBe(B.cookieSlot);
  // A new sign-in now (this login again, too) gets another slot.
  answer();
  await vi.waitFor(() => expect(useAccountStore.getState().getNextCookieSlot()).toBe(B.cookieSlot));
});

it('signing out of every account keeps every slot reserved until its DELETE has answered', async () => {
  teardown.mockResolvedValue({ suppressed: true, worker: 'settled', browserUnsubscribed: false });
  let answer!: () => void;
  const held = new Promise<void>((resolve) => { answer = resolve; });
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/auth/session?all=true' && init?.method === 'DELETE') {
      events.push('DELETE all held');
      await held;
    }
    return base(input as never, init);
  }));
  void useAuthStore.getState().logoutAll();
  await vi.waitFor(() => expect(events).toContain('DELETE all held'));
  // That DELETE clears every slot's cookies: no slot is free for a new sign-in.
  expect(reservedCookieSlots().sort((a, b) => a - b)).toEqual(Array.from({ length: MAX_ACCOUNT_SLOTS }, (_, i) => i));
  answer();
  await vi.waitFor(() => expect(reservedCookieSlots()).toEqual([]));
});

it('signing the active login in again while its sign-out runs waits for it, and never shares its slot', async () => {
  let finish!: () => void;
  teardown.mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve({ suppressed: true, worker: 'settled', browserUnsubscribed: false });
  }));
  const signingOut = useAuthStore.getState().logout();
  await vi.waitFor(() => expect(teardown).toHaveBeenCalled());
  let signedIn = false;
  const signingIn = useAuthStore.getState().login('https://mail.x.test', 'a@x.test', 'pw', undefined, true)
    .then((r) => { signedIn = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  expect(signedIn).toBe(false);
  finish();
  await signingOut;
  await signingIn;
  const posts = events.filter((e) => e.startsWith('POST /api/auth/session?slot=0'));
  if (posts.length > 0) {
    expect(events.indexOf('DELETE /api/auth/session?slot=0')).toBeLessThan(events.indexOf(posts[0]));
  }
  expect(signedIn).toBe(true);
});
