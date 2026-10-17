// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Fork (Wnt/webmail): POST /api/auth/sso/code - the first-party passkey
// sign-in's code exchange (components/auth/passkey-gate.tsx).

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key in config ? config[key] : fallback)),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } }));
const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string) => { jar.set(name, value); },
  delete: (arg: string | { name: string }) => { jar.delete(typeof arg === 'string' ? arg : arg.name); },
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
};
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
const exchangeCodeForTokens = vi.fn();
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
}));

import { POST } from '@/app/api/auth/sso/code/route';

const ORIGIN = 'https://mail.example.org';
const VERIFIER = 'v'.repeat(43);
const CALLBACK = `${ORIGIN}/en/auth/callback`;

function call(body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest('http://0.0.0.0:3000/api/auth/sso/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

beforeEach(() => {
  jar.clear();
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, { oauthEnabled: true, oauthOnly: true, autoSsoEnabled: true, jmapServers: [] });
  exchangeCodeForTokens.mockReset().mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 600 });
});

describe('/api/auth/sso/code', () => {
  it('redeems the code with the page\'s verifier and the callback URI, and signs in like the callback does', async () => {
    jar.set('bulwark_signed_out', '1');
    const res = await call({ code: 'gwc_1', code_verifier: VERIFIER, redirect_uri: CALLBACK, slot: 0 });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ access_token: 'at', expires_in: 600 });
    expect(exchangeCodeForTokens).toHaveBeenCalledWith('gwc_1', VERIFIER, CALLBACK, null);
    expect(jar.get('jmap_rt')).toBe('rt');
    expect(jar.has('bulwark_signed_out')).toBe(false);
  });

  it('writes the requested slot', async () => {
    await call({ code: 'c', code_verifier: VERIFIER, redirect_uri: CALLBACK, slot: 3 });
    expect(jar.get('jmap_rt_3')).toBe('rt');
  });

  it.each([
    ['another origin', { redirect_uri: 'https://evil.example/en/auth/callback' }],
    ['an unknown locale', { redirect_uri: `${ORIGIN}/xx/auth/callback` }],
    ['a query', { redirect_uri: `${CALLBACK}?x=1` }],
    ['another path', { redirect_uri: `${ORIGIN}/en/mail` }],
    ['a non-canonical URI', { redirect_uri: `${ORIGIN}/en/x/../auth/callback` }],
    ['no verifier', { code_verifier: undefined }],
    ['a short verifier', { code_verifier: 'short' }],
    ['no code', { code: '' }],
  ])('refuses %s without calling the provider', async (_label, over) => {
    const res = await call({ code: 'c', code_verifier: VERIFIER, redirect_uri: CALLBACK, ...over });
    expect(res.status).toBe(400);
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(jar.has('jmap_rt')).toBe(false);
  });

  it('refuses a cross-origin request', async () => {
    const res = await call({ code: 'c', code_verifier: VERIFIER, redirect_uri: CALLBACK }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('answers 401 and writes nothing when the provider refuses the code (reused, expired, wrong verifier)', async () => {
    exchangeCodeForTokens.mockRejectedValue(new Error('invalid_grant'));
    const res = await call({ code: 'c', code_verifier: VERIFIER, redirect_uri: CALLBACK });
    expect(res.status).toBe(401);
    expect(jar.has('jmap_rt')).toBe(false);
  });

  it('does not exist outside passkey-entry mode', async () => {
    config.oauthOnly = false;
    expect((await call({ code: 'c', code_verifier: VERIFIER, redirect_uri: CALLBACK })).status).toBe(404);
  });
});
