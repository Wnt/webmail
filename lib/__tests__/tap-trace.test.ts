import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetTapTrace, flushTapTrace, traceTap } from '@/lib/tap-trace';

// Fork (Wnt/webmail): the app's half of the tap diagnostics. Records wait in
// memory while the app starts (the push worker's kept message is read from
// the same cache against a short deadline then), reach the cache a few
// seconds later, and are sent - with the worker's - once the server takes
// them.
const store = new Map<string, string>();
const prefix = () => `${window.location.origin}/__push-state/tap-trace/`;
let status = 204;
let posted: { v: number; events: Record<string, unknown>[] }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  posted = [];
  status = 204;
  __resetTapTrace();
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (k: string | Request) => {
        const url = typeof k === 'string' ? k : k.url;
        return store.has(url) ? { json: async () => JSON.parse(store.get(url)!) } : undefined;
      },
      put: async (k: string | Request, res: Response) => { store.set(typeof k === 'string' ? k : k.url, await res.text()); },
      keys: async () => [...store.keys()].map((url) => ({ url }) as Request),
      delete: async (k: string | Request) => store.delete(typeof k === 'string' ? k : k.url),
    }),
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return { ok: status >= 200 && status < 300, status } as Response;
  }));
});
afterEach(() => {
  __resetTapTrace();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('traceTap', () => {
  it('touches no cache while the app starts, then stores and sends', async () => {
    traceTap('session', { how: 'restored' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.size).toBe(0);
    expect(posted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(posted).toHaveLength(1);
    expect(posted[0].events).toEqual([expect.objectContaining({ src: 'page', ev: 'session', f: { how: 'restored' } })]);
    expect(store.size).toBe(0);
  });

  it('sends the worker records waiting in the cache too', async () => {
    store.set(`${prefix()}1-abcdef12`, JSON.stringify({ id: 'abcdef12', src: 'sw', ev: 'push', at: 1, f: {} }));
    traceTap('found', { how: 'vanished', when: 'start', kept: 1, listed: 0, vanished: 1 });
    await flushTapTrace();
    expect(posted[0].events.map((e) => e.ev).sort()).toEqual(['found', 'push']);
    expect(store.size).toBe(0);
  });

  it('keeps them while the server refuses (no session yet)', async () => {
    status = 401;
    traceTap('session', { how: 'login' });
    await flushTapTrace();
    expect(posted).toHaveLength(1);
    expect(store.size).toBe(1);
    status = 204;
    await flushTapTrace();
    expect(store.size).toBe(0);
  });
});
