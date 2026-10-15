import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

// Fork patch (Wnt/webmail): when /api/push/preview fails, sw.js falls back to
// the optional `email` summary carried in the push payload. public/sw.js is
// served raw, so run it in a VM like sw-push-quiet-window.test.ts does.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Shown = { title: string; options: Record<string, unknown> };
type PreviewResponse = { ok: boolean; status?: number; body?: unknown } | 'throw';

function loadWorker(preview: PreviewResponse) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const cacheStore = new Map<string, string>();

  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
      getNotifications: async () => [],
    },
  };
  const caches = {
    open: async () => ({
      match: async (key: string) => {
        const value = cacheStore.get(key);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => {
        cacheStore.set(key, await res.text());
      },
    }),
  };
  const fetchMock = vi.fn(async () => {
    if (preview === 'throw') throw new TypeError('network down');
    return { ok: preview.ok, status: preview.status ?? 200, json: async () => preview.body };
  });

  const context = vm.createContext({ self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console });
  vm.runInContext(SW_SOURCE, context);

  async function push(payload: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data: { json: () => payload },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  }
  return { push, shown, context };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  kind: 'email',
  accountLabel: 'me@example.com',
  accountId: 'acc1',
  emailIds: ['e1'],
  changed: { acc1: { EmailDelivery: 's1' } },
  ...extra,
});
const summary = { from: 'Alice <alice@example.com>', subject: 'Lunch?', preview: 'Are you free at noon?' };

describe('service worker push payload email fallback', () => {
  it('uses the payload email when the preview API returns 401', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));

    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Alice <alice@example.com>');
    expect(shown[0].options).toMatchObject({
      body: 'Lunch?\nAre you free at noon?',
      tag: 'bulwark-mail:acc1',
      data: { kind: 'mail-list', accountId: 'acc1' },
    });
  });

  it('uses the payload email when the preview fetch throws', async () => {
    const { push, shown } = loadWorker('throw');
    await push(payload({ email: summary }));
    expect(shown[0].title).toBe('Alice <alice@example.com>');
  });

  it('trims the preview to 200 characters', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: { ...summary, preview: 'x'.repeat(500) } }));
    expect(shown[0].options.body).toBe('Lunch?\n' + 'x'.repeat(200));
  });

  it('keeps the generic "New mail" toast without a payload email', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload());
    expect(shown[0].title).toBe('New mail (me@example.com)');
    expect(shown[0].options.body).toBe('You have new mail');
  });

  it('prefers the preview API result when it succeeds', async () => {
    const { push, shown } = loadWorker({
      ok: true,
      body: {
        unreadTotal: 1,
        email: { id: 'e1', threadId: 't1', from: [{ name: 'Bob' }], subject: 'From API', preview: '' },
      },
    });
    await push(payload({ email: summary }));
    expect(shown[0].title).toBe('Bob (me@example.com)');
    expect(shown[0].options.body).toBe('From API');
  });

  it('still dedupes a redelivered push', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));
    await push(payload({ email: summary }));
    expect(shown).toHaveLength(1);
  });

  it('buildPayloadEmailContent ignores unusable summaries', () => {
    const { context } = loadWorker({ ok: false });
    const build = vm.runInContext('buildPayloadEmailContent', context) as (e: unknown) => unknown;
    expect(build(undefined)).toBeNull();
    expect(build('nope')).toBeNull();
    expect(build({ from: 1, subject: null })).toBeNull();
    expect(build({ subject: 'Only subject' })).toEqual({ title: 'New mail', body: 'Only subject' });
    expect(build({ from: 'A' })).toEqual({ title: 'A', body: '(no subject)' });
  });
});
