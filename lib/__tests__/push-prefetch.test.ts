import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { takePrefetchedEmail, PREFETCH_MAX_AGE_MS } from '../push-prefetch';

// Fork (Wnt/webmail): the page takes the push worker's kept copy of a tapped
// notification's message once (public/sw.js rememberPrefetchedEmail).

const store = new Map<string, string>();
const key = (acc: string, id: string) => `${window.location.origin}/__push-state/prefetched/${acc}/${id}`;
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { caches: unknown }).caches = {
    open: async () => ({
      match: async (url: string) => (store.has(url) ? { json: async () => JSON.parse(store.get(url)!) } : undefined),
      delete: async (url: string) => store.delete(url),
    }),
  };
});
afterEach(() => { delete (globalThis as unknown as { caches?: unknown }).caches; });

const whole = { id: 'e1', threadId: 't1', bodyValues: { '1': { value: 'Hello', isTruncated: false } } };

describe('takePrefetchedEmail', () => {
  it('returns the kept message once', async () => {
    store.set(key('acc', 'e1'), JSON.stringify({ at: Date.now(), accountId: 'acc', email: whole }));
    expect(await takePrefetchedEmail('acc', 'e1')).toEqual(whole);
    expect(await takePrefetchedEmail('acc', 'e1')).toBeNull();
  });

  it('ignores another account, an old entry and one without a body', async () => {
    store.set(key('acc', 'e1'), JSON.stringify({ at: Date.now(), email: whole }));
    expect(await takePrefetchedEmail('other', 'e1')).toBeNull();
    store.set(key('acc', 'e1'), JSON.stringify({ at: Date.now() - PREFETCH_MAX_AGE_MS - 1, email: whole }));
    expect(await takePrefetchedEmail('acc', 'e1')).toBeNull();
    store.set(key('acc', 'e1'), JSON.stringify({ at: Date.now(), email: { id: 'e1' } }));
    expect(await takePrefetchedEmail('acc', 'e1')).toBeNull();
  });
});
