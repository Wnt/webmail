import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { takeNotificationOpen, NOTIFICATION_OPEN_MAX_AGE_MS } from '@/lib/notification-open';

// Fork patch (Wnt/webmail): the page side of the tapped-notification entry
// public/sw.js writes (see sw-notification-click.test.ts for the writer).
const store = new Map<string, string>();
const key = () => `${window.location.origin}/__push-state/notification-open`;

beforeEach(() => {
  store.clear();
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (k: string) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)!) } : undefined),
      delete: async (k: string) => store.delete(k),
    }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('takeNotificationOpen', () => {
  it('returns the tap once, then nothing', async () => {
    const now = 1_000_000;
    store.set(key(), JSON.stringify({ emailId: 'e2', slot: 0, url: '/mail/message/e2?slot=0', at: now - 1000 }));
    expect(await takeNotificationOpen(now)).toEqual({ emailId: 'e2', slot: 0, at: now - 1000 });
    expect(await takeNotificationOpen(now)).toBeNull();
  });

  it('two racing takers open it once', async () => {
    const now = 1_000_000;
    store.set(key(), JSON.stringify({ emailId: 'e2', at: now }));
    const results = await Promise.all([takeNotificationOpen(now), takeNotificationOpen(now)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('drops a stale tap', async () => {
    const now = 10_000_000;
    store.set(key(), JSON.stringify({ emailId: 'e2', at: now - NOTIFICATION_OPEN_MAX_AGE_MS - 1 }));
    expect(await takeNotificationOpen(now)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('ignores malformed entries and a bad slot', async () => {
    const now = 1_000_000;
    store.set(key(), JSON.stringify({ emailId: '', at: now }));
    expect(await takeNotificationOpen(now)).toBeNull();
    store.set(key(), JSON.stringify({ emailId: 'e3', slot: -1, at: now }));
    expect(await takeNotificationOpen(now)).toEqual({ emailId: 'e3', slot: undefined, at: now });
  });

  it('is null without Cache Storage', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await takeNotificationOpen()).toBeNull();
  });
});
