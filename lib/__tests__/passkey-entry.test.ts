/**
 * @vitest-environment node
 *
 * Fork (Wnt/webmail): the passkey entry (lib/auth/passkey-entry.ts). With
 * OAuth-only + auto-SSO, a signed-out page load is answered with a redirect to
 * /api/auth/sso/begin before any HTML, which sends the browser on to the
 * provider with the requested page carried in the pending cookie. After an
 * explicit sign-out or a failed sign-in the login route shows the branded
 * page with one button instead, so nothing loops.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key in config ? config[key] : fallback)),
    getPolicy: vi.fn(() => ({ features: { pluginsEnabled: false } })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  // Like the real one with localePrefix "always": add the locale.
  return { default: () => (req: NextRequest) => NextResponse.redirect(new URL(`/en${req.nextUrl.pathname}`, req.url)) };
});
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64), hasSessionSecret: () => true }));

let metadata: { authorization_endpoint?: string } | null = { authorization_endpoint: 'https://mail.example.org/oauth/authorize' };
vi.mock('@/lib/oauth/discovery', () => ({ discoverOAuth: vi.fn(async () => metadata) }));
vi.mock('@/lib/oauth/token-exchange', () => ({
  getRequiredConfig: () => ({ clientId: 'bulwark', discoveryUrl: 'https://mail.example.org' }),
  getDiscoveryValidator: () => undefined,
}));

import { proxy } from '@/proxy';
import { safeReturnPath } from '@/lib/auth/passkey-entry-shared';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { GET as begin } from '@/app/api/auth/sso/begin/route';

const ORIGIN = 'http://localhost:3000';

function directMode(on = true) {
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, { oauthEnabled: on, oauthOnly: on, autoSsoEnabled: on, jmapServers: [] });
}

function load(path: string, { cookies = '', headers = {}, method = 'GET' }: { cookies?: string; headers?: Record<string, string>; method?: string } = {}) {
  return proxy(new NextRequest(ORIGIN + path, {
    method,
    headers: {
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
      ...(cookies ? { cookie: cookies } : {}),
      ...headers,
    },
  }));
}

function location(res: Response): { path: string; q: URLSearchParams } {
  // Absolute: Next's middleware adapter refuses a relative Location (and
  // makes a same-origin one relative itself).
  const url = new URL(res.headers.get('location') ?? '');
  return { path: url.pathname, q: url.searchParams };
}

beforeEach(() => {
  vi.clearAllMocks();
  directMode();
  metadata = { authorization_endpoint: 'https://mail.example.org/oauth/authorize' };
});

describe('safeReturnPath', () => {
  it.each([
    ['/en', '/en'],
    ['/en/mail/message/M123?slot=0', '/en/mail/message/M123?slot=0'],
    ['/zh-TW/settings/security', '/zh-TW/settings/security'],
    ['/en/mail/inbox#frag', '/en/mail/inbox'],
    ['/en/mail/../settings', '/en/settings'],
  ])('keeps %s', (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it.each([
    'https://evil.example/en', '//evil.example/en', '/\\evil.example/en', '/en\\..\\x', 'en/mail',
    '/xx/mail', '/mail', '/', '', '/en/login', '/en/login?x=1', '/en/auth/callback?code=1',
    '/en/%2e%2e/admin', '/en/mail%2f..%2fx', '/en/mail\nx', '/en/mail x', 'javascript:alert(1)',
    `/en/${'a'.repeat(3000)}`, `/en/mail/${'漢'.repeat(1500)}`, 42, null, undefined,
  ])('refuses %s', (raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it('keeps a path under the mount prefix only', () => {
    expect(safeReturnPath('/webmail/en/mail', '/webmail')).toBe('/webmail/en/mail');
    expect(safeReturnPath('/en/mail', '/webmail')).toBeNull();
    expect(safeReturnPath('/webmailx/en/mail', '/webmail')).toBeNull();
  });
});

describe('proxy: signed-out page loads go to the passkey sign-in before any HTML', () => {
  it('redirects the app root to the SSO begin route with no body', async () => {
    const res = await load('/en');
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { path, q } = location(res);
    expect(path).toBe('/api/auth/sso/begin');
    expect(q.get('locale')).toBe('en');
    expect(q.get('return')).toBe('/en');
    expect(await res.text()).toBe('');
  });

  it('carries a deep link along', async () => {
    const { path, q } = location(await load('/en/mail/message/M123?slot=0'));
    expect(path).toBe('/api/auth/sso/begin');
    expect(q.get('return')).toBe('/en/mail/message/M123?slot=0');
  });

  it('adds the locale first for paths without one (one more redirect, still no HTML)', async () => {
    const res = await load('/mail/message/M1');
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/en/mail/message/M1');
  });

  it('sends the login page on too, keeping a valid return and dropping a foreign one', async () => {
    expect(location(await load('/en/login')).path).toBe('/api/auth/sso/begin');
    expect(location(await load('/en/login?return=%2Fen%2Fmail%2Finbox')).q.get('return')).toBe('/en/mail/inbox');
    expect(location(await load('/en/login?return=%2F%2Fevil.example%2Fen')).q.has('return')).toBe(false);
  });

  it.each(['jmap_rt=x', 'jmap_rt_2=x', 'a=1; jmap_rt_1=y'])('renders the page when a session cookie exists (%s)', async (cookies) => {
    const res = await load('/en/mail/inbox', { cookies });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('leaves router fetches, prefetches and non-GET requests alone', async () => {
    expect((await load('/en/mail/inbox', { headers: { rsc: '1' } })).status).toBe(200);
    expect((await load('/en/mail/inbox', { headers: { 'next-router-prefetch': '1' } })).status).toBe(200);
    expect((await load('/en/mail/inbox', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  it('serves the branded page after a failed sign-in instead of starting another', async () => {
    const res = await load('/en/login?sso_error=access_denied');
    expect(res.status).toBe(200);
  });

  it('keeps the upstream flows it does not take over', async () => {
    expect((await load('/en/login?mode=add-account')).status).toBe(200);
    expect((await load('/en/login?mobile_redirect_uri=bulwarkmobile%3A%2F%2Fx')).status).toBe(200);
  });

  it('after an explicit sign-out: the branded page, no automatic sign-in, the deep link kept', async () => {
    const cookies = 'bulwark_signed_out=1';
    expect((await load('/en/login', { cookies })).status).toBe(200);
    const res = await load('/en/mail/message/M9', { cookies });
    expect(res.status).toBe(303);
    const { path, q } = location(res);
    expect(path).toBe('/en/login');
    expect(q.get('return')).toBe('/en/mail/message/M9');
  });

  it('sends provider errors at the callback to the branded page, with a sanitised code', async () => {
    const denied = location(await load('/en/auth/callback?error=access_denied&state=s'));
    expect(denied.path).toBe('/en/login');
    expect(denied.q.get('sso_error')).toBe('access_denied');
    expect(location(await load('/en/auth/callback?error=%3Cscript%3E')).q.get('sso_error')).toBe('sso_failed');
    // A successful callback renders (its page completes the sign-in).
    expect((await load('/en/auth/callback?code=c&state=s')).status).toBe(200);
  });

  it('keeps the deep link of the sign-in that failed, for the retry - only for that flow', async () => {
    const pending = (extra: Record<string, unknown> = {}) => `sso_pending=${encodeURIComponent(encryptPayload({
      state: 'st-1', code_verifier: 'v', redirect_uri: `${ORIGIN}/en/auth/callback`, created_at: Date.now(),
      return_to: '/en/mail/message/M1?slot=2', ...extra,
    }, 'sso-pending'))}`;
    const ok = location(await load('/en/auth/callback?error=access_denied&state=st-1', { cookies: pending() }));
    expect(ok.path).toBe('/en/login');
    expect(ok.q.get('return')).toBe('/en/mail/message/M1?slot=2');
    // another flow's state, an expired flow, an unsafe value: no destination
    expect(location(await load('/en/auth/callback?error=access_denied&state=other', { cookies: pending() })).q.has('return')).toBe(false);
    expect(location(await load('/en/auth/callback?error=access_denied&state=st-1', { cookies: pending({ created_at: Date.now() - 6 * 60_000 }) })).q.has('return')).toBe(false);
    expect(location(await load('/en/auth/callback?error=access_denied&state=st-1', { cookies: pending({ return_to: '//evil.example/en' }) })).q.has('return')).toBe(false);
    expect(location(await load('/en/auth/callback?error=access_denied&state=st-1', { cookies: 'sso_pending=garbage' })).q.has('return')).toBe(false);
  });

  it('is off unless OAuth-only with auto-SSO and a single server', async () => {
    directMode(false);
    expect((await load('/en/mail/inbox')).status).toBe(200);
    directMode();
    config.autoSsoEnabled = false;
    expect((await load('/en/mail/inbox')).status).toBe(200);
    directMode();
    config.jmapServers = [
      { id: 'a', name: 'A', url: 'https://a.example' },
      { id: 'b', name: 'B', url: 'https://b.example' },
    ];
    expect((await load('/en/mail/inbox')).status).toBe(200);
  });
});

describe('GET /api/auth/sso/begin', () => {
  function call(query: string, headers: Record<string, string> = {}) {
    return begin(new NextRequest(`${ORIGIN}/api/auth/sso/begin${query}`, {
      headers: { 'x-forwarded-host': 'mail.example.org', 'x-forwarded-proto': 'https', host: '0.0.0.0:3000', ...headers },
    }));
  }

  function pendingCookie(res: Response): Record<string, unknown> {
    const set = res.headers.getSetCookie().find((c) => c.startsWith('sso_pending='));
    expect(set, 'sso_pending cookie').toBeTruthy();
    const value = decodeURIComponent(set!.split(';')[0].slice('sso_pending='.length));
    return decryptPayload(value, 'sso-pending') as Record<string, unknown>;
  }

  it('redirects to the provider with PKCE, state and the callback on the public origin', async () => {
    const res = await call('?locale=en&return=%2Fen%2Fmail%2Fmessage%2FM1');
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://mail.example.org/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('bulwark');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mail.example.org/en/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('ui_locales')).toBe('en');
    const pending = pendingCookie(res);
    expect(pending.state).toBe(url.searchParams.get('state'));
    expect(pending.redirect_uri).toBe('https://mail.example.org/en/auth/callback');
    expect(pending.return_to).toBe('/en/mail/message/M1');
    expect(typeof pending.code_verifier).toBe('string');
  });

  it('clears the explicit sign-out marker', async () => {
    const res = await call('?locale=en', { cookie: 'bulwark_signed_out=1' });
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('bulwark_signed_out='));
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('drops an unsafe return path and an unknown locale', async () => {
    const res = await call('?locale=xx&return=https%3A%2F%2Fevil.example%2F');
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('redirect_uri')).toBe('https://mail.example.org/en/auth/callback');
    expect(pendingCookie(res).return_to).toBeUndefined();
  });

  it('lands on the branded page when the provider cannot be discovered', async () => {
    metadata = null;
    const res = await call('?locale=en');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/login?sso_error=temporarily_unavailable');
    // ...keeping the page it was for.
    const kept = await call('?locale=en&return=%2Fen%2Fmail%2Fmessage%2FM1');
    expect(kept.headers.get('location')).toBe('/en/login?sso_error=temporarily_unavailable&return=%2Fen%2Fmail%2Fmessage%2FM1');
  });

  it('never sets a pending cookie a browser would not keep', async () => {
    const res = await call(`?locale=en&return=${encodeURIComponent(`/en/mail/${'漢'.repeat(600)}`)}`);
    const set = res.headers.getSetCookie().find((c) => c.startsWith('sso_pending='))!;
    expect(set.length).toBeLessThan(4096);
    expect(pendingCookie(res).return_to).toBeUndefined();
  });

  it('does not exist outside passkey-entry mode', async () => {
    directMode(false);
    expect((await call('?locale=en')).status).toBe(404);
  });
});
