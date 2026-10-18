import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EARLY_TOKEN_GLOBAL, earlyTokenScript, takeEarlyAccessToken } from '@/lib/early-auth';

// The root layout's head script sends a page start's token request before the
// app's scripts have loaded (lib/early-auth.ts). Only for a mail page, only for
// the OAuth login the restore starts with, and the restore takes it once.

const registry = (accounts: unknown[], extra: Record<string, unknown> = {}) =>
  localStorage.setItem('account-registry', JSON.stringify({ state: { accounts, activeAccountId: null, defaultAccountId: null, ...extra }, version: 0 }));
const oauth = (id: string, slot: number) => ({ id, authMode: 'oauth', cookieSlot: slot });

function runAt(path: string, script = earlyTokenScript('')) {
  window.history.replaceState(null, '', path);
  new Function(script)();
}

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}'));
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>)[EARLY_TOKEN_GLOBAL];
});
afterEach(() => window.history.replaceState(null, '', '/'));

describe('head script', () => {
  it('sends the token request of the login the restore starts with, on a message link', () => {
    registry([oauth('a', 0), oauth('b', 2)], { defaultAccountId: 'b' });
    runAt('/mail/message/m1?slot=2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/auth/token?slot=2', expect.objectContaining({ method: 'PUT' })]);
    expect(takeEarlyAccessToken(2)).not.toBeNull();
  });

  it('prefers the active login from the auth store', () => {
    registry([oauth('a', 0), oauth('b', 1)], { defaultAccountId: 'a' });
    localStorage.setItem('auth-storage', JSON.stringify({ state: { activeAccountId: 'b' } }));
    runAt('/');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/token?slot=1');
  });

  it('honours the base path and a locale segment', () => {
    registry([oauth('a', 0)]);
    runAt('/webmail/en/mail/folder/inbox', earlyTokenScript('/webmail'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/webmail/api/auth/token?slot=0');
  });

  it.each([
    ['a settings page', '/settings', [oauth('a', 0)]],
    ['a password login', '/mail/message/m1', [{ id: 'a', authMode: 'basic', cookieSlot: 0 }]],
    ['a login waiting for sign-in', '/mail/message/m1', [{ ...oauth('a', 0), awaitingSignIn: true }]],
    ['no login', '/mail/message/m1', []],
  ])('sends nothing for %s', (_label, path, accounts) => {
    registry(accounts as unknown[]);
    runAt(path as string);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>)[EARLY_TOKEN_GLOBAL]).toBeUndefined();
  });
});

describe('takeEarlyAccessToken', () => {
  const put = (slot: number, at: number) => {
    (window as unknown as Record<string, unknown>)[EARLY_TOKEN_GLOBAL] = { slot, at, response: Promise.resolve(new Response('{}')), abort: () => {} };
  };
  it('is taken once', () => {
    put(0, Date.now());
    expect(takeEarlyAccessToken(0)).not.toBeNull();
    expect(takeEarlyAccessToken(0)).toBeNull();
  });
  it('is not used for another slot, or when too old', () => {
    put(1, Date.now());
    expect(takeEarlyAccessToken(0)).toBeNull();
    put(0, Date.now() - 60_000);
    expect(takeEarlyAccessToken(0)).toBeNull();
  });
});
