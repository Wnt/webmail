// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Audit bulwark-6: the favicon proxy bounds what one cache miss can cost. No
// DuckDuckGo request is sent; fetch is mocked.

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

const req = (domain: string) => new NextRequest(`https://webmail.example/api/favicon?domain=${domain}`);
const png = (bytes: number) => new Uint8Array(bytes).fill(7);

it('does not buffer and cache an oversized favicon response', async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  const fetchMock = vi.fn(async () => new Response(bytes, {
    headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const { GET } = await import('@/app/api/favicon/route');
  const first = await GET(req('example.test'));
  const second = await GET(req('example.test'));
  // An icon does not need multi-megabyte responses. A rejection or the
  // normal missing-icon placeholder is acceptable; neither may cache it.
  expect((await first.arrayBuffer()).byteLength).toBeLessThanOrEqual(1024 * 1024);
  expect((await second.arrayBuffer()).byteLength).toBeLessThanOrEqual(1024 * 1024);
});

it('stops reading a body without a declared length once it is too large', async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(png(64 * 1024));
      if (pulled > 1000) controller.close();
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'image/png' } })));
  const { GET } = await import('@/app/api/favicon/route');
  const res = await GET(req('example.test'));
  expect(res.headers.get('X-Bulwark-Favicon')).toBe('missing');
  // 512 KiB limit / 64 KiB chunks: stops right after crossing it.
  expect(pulled).toBeLessThan(16);
});

it('serves and caches a normal icon', async () => {
  const fetchMock = vi.fn(async () => new Response(png(4096), { headers: { 'content-type': 'image/x-icon' } }));
  vi.stubGlobal('fetch', fetchMock);
  const { GET } = await import('@/app/api/favicon/route');
  expect((await (await GET(req('example.test'))).arrayBuffer()).byteLength).toBe(4096);
  expect((await (await GET(req('example.test'))).arrayBuffer()).byteLength).toBe(4096);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    'https://icons.duckduckgo.com/ip3/example.test.ico',
    expect.objectContaining({ redirect: 'error' }),
  );
});

it('identical concurrent misses share one upstream request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchMock = vi.fn(async () => {
    await gate;
    return new Response(png(2048), { headers: { 'content-type': 'image/png' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const { GET } = await import('@/app/api/favicon/route');
  const all = Promise.all(Array.from({ length: 20 }, () => GET(req('example.test'))));
  release();
  const responses = await all;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  for (const res of responses) expect((await res.arrayBuffer()).byteLength).toBe(2048);
});

it('runs a bounded number of upstream requests at once', async () => {
  let running = 0;
  let peak = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return new Response(png(100), { headers: { 'content-type': 'image/png' } });
  }));
  const { GET } = await import('@/app/api/favicon/route');
  await Promise.all(Array.from({ length: 40 }, (_, i) => GET(req(`d${i}.example`))));
  expect(peak).toBeLessThanOrEqual(8);
});

it('keeps the cache within its byte budget', async () => {
  // 100 distinct icons of 500 KiB = ~49 MiB requested; the cache holds at most 32 MiB.
  const fetchMock = vi.fn(async () => new Response(png(500 * 1024), { headers: { 'content-type': 'image/png' } }));
  vi.stubGlobal('fetch', fetchMock);
  const { GET } = await import('@/app/api/favicon/route');
  for (let i = 0; i < 100; i++) await GET(req(`d${i}.example`));
  fetchMock.mockClear();
  // Newest first, so no refetch evicts an icon before it is counted.
  for (let i = 99; i >= 0; i--) await GET(req(`d${i}.example`));
  const cached = 100 - fetchMock.mock.calls.length;
  expect(cached).toBe(Math.floor((32 * 1024 * 1024) / (500 * 1024)));
});

it('does not follow a redirect away from the provider', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.redirect === 'error') throw new TypeError('fetch failed: redirect');
    return new Response(png(100), { headers: { 'content-type': 'image/png' } });
  }));
  const { GET } = await import('@/app/api/favicon/route');
  expect((await GET(req('example.test'))).status).toBe(502);
});
