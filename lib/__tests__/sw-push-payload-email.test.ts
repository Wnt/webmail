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
  // Notifications currently on screen, by tag (a new one with the same tag replaces the old).
  const active = new Map<string, Shown>();
  const cacheStore = new Map<string, string>();

  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        active.set(String(options.tag), { title, options });
      },
      getNotifications: async (filter?: { tag?: string }) =>
        [...active.values()]
          .filter((n) => !filter?.tag || n.options.tag === filter.tag)
          .map((n) => ({ title: n.title, body: n.options.body, tag: n.options.tag, data: n.options.data })),
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
  return { push, shown, active, fetchMock, context };
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

describe('service worker AI summary replacement', () => {
  const withSummary = { ...summary, summary: 'Alice asks if you are free for lunch at noon.' };

  it('replaces the announced notification in place, silently, keeping its tag and click data', async () => {
    const { push, shown, fetchMock } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));
    await push(payload({ email: withSummary, renotify: false }));

    expect(shown).toHaveLength(2);
    expect(shown[1].title).toBe('Alice <alice@example.com>');
    expect(shown[1].options).toMatchObject({
      body: 'Lunch?\nAlice asks if you are free for lunch at noon.',
      tag: 'bulwark-mail:acc1',
      renotify: false,
      silent: true,
    });
    // the same click data; only the per-display id and time are new (see showReplacing)
    const clickData = (n: { options: Record<string, unknown> }) => {
      const { shownId: _id, shownAt: _at, ...rest } = n.options.data as Record<string, unknown>;
      return rest;
    };
    expect(clickData(shown[1])).toEqual(clickData(shown[0]));
    expect((shown[1].options.data as { shownId: string }).shownId).not.toBe((shown[0].options.data as { shownId: string }).shownId);
    // the replacement needs no preview lookup
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the deep link of a notification built from the preview API', async () => {
    const { push, shown } = loadWorker({
      ok: true,
      body: { unreadTotal: 1, slot: 2, email: { id: 'e1', threadId: 't1', from: [{ name: 'Alice' }], subject: 'Lunch?' } },
    });
    await push(payload({ email: summary }));
    await push(payload({ email: withSummary, renotify: false }));
    expect(shown).toHaveLength(2);
    expect(shown[1].options.data).toEqual({
      kind: 'email', emailId: 'e1', threadId: 't1', slot: 2, accountId: 'acc1', headlineEmailId: 'e1',
      shownId: expect.any(String), shownAt: expect.any(Number),
    });
    expect(shown[1].options.silent).toBe(true);
  });

  it('does not bring back a notification that was dismissed or opened', async () => {
    const { push, shown, active } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));
    active.clear();
    await push(payload({ email: withSummary, renotify: false }));
    expect(shown).toHaveLength(1);
  });

  it('announces normally, with the summary, when the first push never arrived', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: withSummary, renotify: false }));
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Alice <alice@example.com>');
    expect(shown[0].options).toMatchObject({
      body: 'Lunch?\nAlice asks if you are free for lunch at noon.',
      renotify: true,
      silent: false,
    });
    // a redelivery only re-renders it silently
    await push(payload({ email: withSummary, renotify: false }));
    expect(shown).toHaveLength(2);
    expect(shown[1].options).toMatchObject({ body: shown[0].options.body, renotify: false, silent: true });
  });

  it('ignores a summary without the renotify:false flag (redelivery is deduped)', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));
    await push(payload({ email: withSummary }));
    expect(shown).toHaveLength(1);
  });

  it('replaces nothing when the replacement has no usable summary', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));
    await push(payload({ email: { ...summary, summary: '   ' }, renotify: false }));
    expect(shown).toHaveLength(1);
  });

  it('trims the summary to 200 characters', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));
    await push(payload({ email: { ...summary, summary: 'y'.repeat(500) }, renotify: false }));
    expect(shown[1].options.body).toBe('Lunch?\n' + 'y'.repeat(200));
  });
});
