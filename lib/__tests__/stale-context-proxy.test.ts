// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Audit bulwark-4: the calendar fetch proxy needs a live credential, and the
// context envelope expires. No remote traffic: the credential check goes to
// the mocked global fetch (the configured server is trusted), the feed fetch
// to the mocked fetchPublicUrl.

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: (name: string) => jar.has(name) ? { name, value: jar.get(name)! } : undefined,
  set: (name: string, value: string) => { jar.set(name, value); },
  delete: (name: string) => { jar.delete(name); },
}) }));
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64) }));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: {
  ensureLoaded: async () => {},
  get: (key: string, fallback: unknown) => key === 'jmapServerUrl' ? 'https://mail.example.test' : fallback,
} }));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/security/url-guard', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/security/url-guard')>(),
  fetchPublicUrl: publicFetch,
}));

const SESSION = { apiUrl: 'https://mail.example.test/jmap/', username: 'owner@example.test', accounts: { a: {} }, primaryAccounts: {} };

beforeEach(() => {
  vi.resetModules();
  publicFetch.mockReset();
  publicFetch.mockResolvedValue(new Response('BEGIN:VCALENDAR\nEND:VCALENDAR\n'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); jar.clear(); });

async function seal(authHeader: string) {
  const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
  const { cookies } = await import('next/headers');
  setStalwartAuthContextInStore(await cookies(), 0, {
    serverUrl: 'https://mail.example.test', username: 'owner@example.test', authHeader,
  });
}

/** The mail server's verdict on the credential (its JMAP session endpoint). */
function mailServer(status: number) {
  const fn = vi.fn(async () => new Response(status === 200 ? JSON.stringify(SESSION) : '{}', {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function fetchFeed() {
  const { POST } = await import('@/app/api/fetch-ical/route');
  return POST(new NextRequest('https://webmail.example/api/fetch-ical', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ url: 'https://calendar.example.test/feed.ics' }),
  }));
}

it('does not authorize calendar proxy use with a year-old OAuth context and no live grant', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await seal('Bearer revoked-access-token');
  // A stolen copy can be replayed after browser deletion; Cookie Max-Age
  // is not an expiry check on the server. No refresh/session cookies remain.
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  mailServer(401);
  const res = await fetchFeed();
  expect([401, 403]).toContain(res.status);
  expect(publicFetch).not.toHaveBeenCalled();
});

describe('live credential', () => {
  it('serves the feed while the mail server accepts the credential', async () => {
    await seal('Bearer live-token');
    const server = mailServer(200);
    const res = await fetchFeed();
    expect(res.status).toBe(200);
    expect(publicFetch).toHaveBeenCalledTimes(1);
    expect(server).toHaveBeenCalledWith('https://mail.example.test/.well-known/jmap', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer live-token' }),
    }));
  });

  it('refuses a fresh context whose grant was revoked', async () => {
    await seal('Bearer revoked-access-token');
    mailServer(401);
    const res = await fetchFeed();
    expect(res.status).toBe(401);
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('checks once per minute, and never remembers a refusal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await seal('Bearer live-token');
    const server = mailServer(200);
    await fetchFeed();
    await fetchFeed();
    expect(server).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await seal('Bearer live-token');
    server.mockImplementation(async () => new Response('{}', { status: 401 }));
    expect((await fetchFeed()).status).toBe(401);
    expect((await fetchFeed()).status).toBe(401);
    expect(server).toHaveBeenCalledTimes(3);
  });
});

describe('context envelope expiry', () => {
  it('a Bearer context expires after 12 hours, a Basic one after 7 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { readStalwartAuthContext } = await import('@/lib/stalwart/auth-context');
    const start = Date.now();
    await seal('Bearer token');
    vi.setSystemTime(start + 11 * 3600_000);
    expect(await readStalwartAuthContext(0)).not.toBeNull();
    vi.setSystemTime(start + 13 * 3600_000);
    expect(await readStalwartAuthContext(0)).toBeNull();

    vi.setSystemTime(start);
    await seal(`Basic ${Buffer.from('owner@example.test:pw').toString('base64')}`);
    vi.setSystemTime(start + 6 * 86400_000);
    expect(await readStalwartAuthContext(0)).not.toBeNull();
    vi.setSystemTime(start + 8 * 86400_000);
    expect(await readStalwartAuthContext(0)).toBeNull();
  });

  it('refuses an envelope sealed before expiries existed', async () => {
    const { encryptPayload } = await import('@/lib/auth/crypto');
    const { readStalwartAuthContext } = await import('@/lib/stalwart/auth-context');
    jar.set('jmap_stalwart_ctx', encryptPayload({
      serverUrl: 'https://mail.example.test', username: 'owner@example.test', authHeader: 'Bearer token',
    }, 'session-context'));
    expect(await readStalwartAuthContext(0)).toBeNull();
  });

  it('refuses an expiry further out than the bound allows', async () => {
    const { encryptPayload } = await import('@/lib/auth/crypto');
    const { readStalwartAuthContext } = await import('@/lib/stalwart/auth-context');
    jar.set('jmap_stalwart_ctx', encryptPayload({
      serverUrl: 'https://mail.example.test', username: 'owner@example.test', authHeader: 'Bearer token',
      exp: Date.now() + 365 * 86400_000,
    }, 'session-context'));
    expect(await readStalwartAuthContext(0)).toBeNull();
  });
});
