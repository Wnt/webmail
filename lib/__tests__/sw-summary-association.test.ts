import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

// Audit bulwark-5 (summary bound to its message, overlapping handlers) and the
// service-worker side of bulwark-1 (explicit sign-out markers), next to the
// required behaviour on a merely expired session. public/sw.js is served raw,
// so run it in a VM like sw-push-quiet-window.test.ts does.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Shown = { title: string; options: Record<string, unknown> };
type PreviewResponse = { ok: boolean; status?: number; body?: unknown } | 'throw';

function loadWorker(preview: PreviewResponse) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  // Notifications currently on screen, by tag (a new one with the same tag replaces the old).
  const active = new Map<string, Shown>();
  const cacheStore = new Map<string, string>();

  const unsubscribe = vi.fn(async () => true);
  let lookupHold: Promise<void> = Promise.resolve();
  const holdNotificationLookups = () => {
    let release!: () => void;
    lookupHold = new Promise<void>((resolve) => { release = resolve; });
    return () => release();
  };
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
      getNotifications: async (filter?: { tag?: string }) => {
        // A snapshot taken now, handed back once any hold is released.
        const snapshot = [...active.values()]
          .filter((n) => !filter?.tag || n.options.tag === filter.tag)
          .map((n) => ({ title: n.title, body: n.options.body, tag: n.options.tag, data: n.options.data }));
        await lookupHold;
        return snapshot;
      },
      pushManager: { getSubscription: async () => ({ unsubscribe }) },
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

  function startPush(payload: unknown): Promise<unknown> {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({
      data: { json: () => payload },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    return Promise.all(waits);
  }
  async function push(payload: unknown) {
    await startPush(payload);
  }
  const marker = (path: string) => cacheStore.set(`https://mail.example.com/__push-state/${path}`, '{"at":1}');
  return { push, startPush, shown, active, fetchMock, context, marker, unsubscribe, holdNotificationLookups };
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

describe('push security boundaries', () => {
  it('preserves the required payload preview after ordinary session expiry', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: { from: 'Doctor', subject: 'Private result', preview: 'Confidential detail' } }));
    expect(shown[0].options.body).toContain('Confidential detail');
  });
  it('does not attach a late summary for A to the newer notification for B', async () => {
    const preview = { ok: true, body: { unreadTotal: 1, slot: 0, email: { id: 'e1', from: [{ name: 'A' }], subject: 'A subject' } } };
    const { push, shown } = loadWorker(preview);
    await push(payload({ email: summary }));
    preview.body.email = { id: 'e2', from: [{ name: 'B' }], subject: 'B subject' };
    await push(payload({ emailIds: ['e2'], email: { from: 'B', subject: 'B subject' } }));
    await push(payload({ email: { ...summary, summary: 'A summary' }, renotify: false }));
    expect(shown.at(-1)!.options.body).not.toContain('A summary');
    expect(shown.at(-1)!.options.data).toMatchObject({ emailId: 'e2' });
  });
  it('a summary handler overlapping a newer push cannot overwrite the newer notification', async () => {
    const preview = { ok: true, body: { unreadTotal: 1, slot: 0, email: { id: 'e1', from: [{ name: 'A' }], subject: 'A subject' } } };
    const { push, startPush, active, holdNotificationLookups } = loadWorker(preview);
    await push(payload({ email: summary }));
    // The summary handler has looked up A's notification and waits; B's push runs meanwhile.
    const release = holdNotificationLookups();
    const late = startPush(payload({ email: { ...summary, summary: 'A summary' }, renotify: false }));
    preview.body.email = { id: 'e2', from: [{ name: 'B' }], subject: 'B subject' };
    const newer = startPush(payload({ emailIds: ['e2'], email: { from: 'B', subject: 'B subject' } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([late, newer]);
    expect(active.get('bulwark-mail:acc1')!.options.data).toMatchObject({ emailId: 'e2', headlineEmailId: 'e2' });
    expect(active.get('bulwark-mail:acc1')!.options.body).toBe('B subject');
  });
  it('replaces the notification when the summary is for its headline message', async () => {
    const { push, shown } = loadWorker({ ok: false, status: 401 });
    await push(payload({ emailIds: ['e0', 'e1'], email: summary }));
    await push(payload({ emailIds: ['e0', 'e1'], email: { ...summary, summary: 'A summary' }, renotify: false }));
    expect(shown).toHaveLength(2);
    expect(shown[1].options.body).toBe('Lunch?\nA summary');
    expect(shown[1].options.data).toMatchObject({ accountId: 'acc1', headlineEmailId: 'e1' });
  });
  it('shows nothing for an account the user signed out of on purpose', async () => {
    const { push, shown, marker, unsubscribe } = loadWorker({ ok: false, status: 401 });
    marker('signed-out/acc1');
    await push(payload({ email: summary }));
    await push(payload({ accountId: 'acc2', changed: { acc2: {} }, emailIds: ['x1'], email: summary }));
    expect(shown.map((n) => n.options.tag)).toEqual(['bulwark-mail:acc2']);
    expect(unsubscribe).not.toHaveBeenCalled();
  });
  it('after an explicit sign-out of every account, drops pushes and the browser subscription', async () => {
    const { push, shown, marker, unsubscribe } = loadWorker({ ok: false, status: 401 });
    marker('signed-out-all');
    await push(payload({ email: summary }));
    expect(shown).toHaveLength(0);
    expect(unsubscribe).toHaveBeenCalled();
  });
  it('attacker URLs in IDs remain same-origin click paths', () => {
    const { context } = loadWorker({ ok: false });
    const build = vm.runInContext('buildClickUrl', context);
    for (const id of ['https://evil.invalid', '//evil.invalid', 'javascript:alert(1)', '../x?y#z']) {
      expect(new URL(build({ kind: 'email', emailId: id }), 'https://mail.example.com').origin).toBe('https://mail.example.com');
    }
  });
});
