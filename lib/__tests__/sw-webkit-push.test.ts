import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// WebKit (web apps on the iOS Home Screen), from its source:
//  - a notification with the tag of one on screen does not replace it;
//  - close() is refused for a notification younger than 30 s;
//  - a push event that shows no notification counts towards removing the
//    push subscription (three strikes, never reset).
// public/sw.js is served raw, so run it in a VM like the other sw-*.test.ts.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

type Note = { title: string; options: Record<string, unknown>; closed: boolean; at: number };

const WEBKIT_MIN_LIFETIME_MS = 30_000;

function loadWorker({
  webkit,
  preview = { ok: false, status: 401 },
  dataRoundTrips = true,
}: {
  webkit: boolean;
  preview?: { ok: boolean; status?: number; body?: unknown };
  dataRoundTrips?: boolean;
}) {
  const listeners = new Map<string, (event: unknown) => void>();
  // Every notification ever shown, in order; `closed` once closed or replaced.
  const all: Note[] = [];
  const cacheStore = new Map<string, string>();
  const onScreen = () => all.filter((n) => !n.closed);
  let subscription: { endpoint: string; unsubscribe: () => Promise<boolean> } | null = {
    endpoint: webkit ? 'https://web.push.apple.com/QGx0abc' : 'https://fcm.googleapis.com/fcm/send/abc',
    unsubscribe: async () => { subscription = null; return true; },
  };
  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [] },
    crypto: globalThis.crypto,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        if (!webkit && options.tag) {
          for (const n of onScreen()) if (n.options.tag === options.tag) n.closed = true;
        }
        all.push({ title, options, closed: false, at: Date.now() });
      },
      getNotifications: async (filter?: { tag?: string }) => onScreen()
        .filter((n) => !filter?.tag || n.options.tag === filter.tag)
        .map((n) => ({
          title: n.title, body: n.options.body, tag: n.options.tag,
          data: dataRoundTrips ? n.options.data : null,
          close: () => {
            if (webkit && Date.now() - n.at < WEBKIT_MIN_LIFETIME_MS) return; // refused
            n.closed = true;
          },
        })),
      pushManager: { getSubscription: async () => subscription },
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
  const fetchMock = async () => ({ ok: preview.ok, status: preview.status ?? 200, json: async () => preview.body });
  const context = vm.createContext({
    self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console,
    setTimeout, clearTimeout, AbortController,
  });
  vm.runInContext(SW_SOURCE, context);

  /** Dispatch a push; resolves when its handling (not its delayed work) is done, as seen by the shade. */
  function startPush(payload: unknown): Promise<unknown> {
    const waits: Promise<unknown>[] = [];
    const before = all.length;
    listeners.get('push')?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    const done = Promise.all(waits);
    (done as Promise<unknown> & { shownCount?: () => number }).shownCount = () => all.length - before;
    return done;
  }
  /** Dispatch a push and let all of its work, delayed closes included, finish. */
  async function push(payload: unknown) {
    const before = all.length;
    const done = startPush(payload);
    await vi.advanceTimersByTimeAsync(40_000);
    await done;
    return all.length - before;
  }
  const marker = (path: string) => cacheStore.set(`https://mail.example.com/__push-state/${path}`, '{"at":1}');
  return { push, startPush, all, onScreen, marker, hasSubscription: () => subscription !== null };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  kind: 'email',
  accountLabel: 'me@example.com',
  accountId: 'acc1',
  emailIds: ['e1'],
  changed: { acc1: { EmailDelivery: 's1' } },
  // The gateway's send time (fork: notifications are ordered by it); a quiet replacement names its first push's.
  ...(extra.renotify === false ? {} : { sentAt: Date.now() }),
  ...extra,
});
const email = { from: 'Examplesensor <noreply@examplesensor.example>', subject: 'Weekly report', preview: 'Your sensors this week' };
const withSummary = { ...email, summary: 'Examplesensor sent the weekly sensor report.' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WebKit: one notification per email', () => {
  it('the summary replaces the preview although the tag does not', async () => {
    const { push, onScreen } = loadWorker({ webkit: true });
    await push(payload({ email }));
    await push(payload({ email: withSummary, renotify: false }));
    expect(onScreen()).toHaveLength(1);
    expect(onScreen()[0].title).toBe('Examplesensor <noreply@examplesensor.example>');
    expect(onScreen()[0].options.body).toBe('Weekly report\nExamplesensor sent the weekly sensor report.');
    expect(onScreen()[0].options).toMatchObject({ silent: true, tag: 'bulwark-mail:acc1' });
  });

  it('a summary that comes within 30 s closes the preview as soon as WebKit allows', async () => {
    const { startPush, onScreen } = loadWorker({ webkit: true });
    await vi.advanceTimersByTimeAsync(0);
    const first = startPush(payload({ email }));
    await first;
    await vi.advanceTimersByTimeAsync(20_000);
    const second = startPush(payload({ email: withSummary, renotify: false }));
    await vi.advanceTimersByTimeAsync(100);
    // shown at once (the push counts as user-visible), the preview still refuses to close
    expect(onScreen()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(11_000);
    await second;
    expect(onScreen().map((n) => n.options.body)).toEqual(['Weekly report\nExamplesensor sent the weekly sensor report.']);
  });

  it('a delayed close does not hold up the next push for the account', async () => {
    const { startPush, all } = loadWorker({ webkit: true });
    await startPush(payload({ email }));
    await vi.advanceTimersByTimeAsync(5_000);
    void startPush(payload({ email: withSummary, renotify: false }));
    await vi.advanceTimersByTimeAsync(100);
    void startPush(payload({ emailIds: ['e2'], email: { from: 'B', subject: 'Second' } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(all.map((n) => n.options.body)).toEqual([
      'Weekly report\nYour sensors this week',
      'Weekly report\nExamplesensor sent the weekly sensor report.',
      'Second',
    ]);
  });

  it('a newer mail replaces the older one there too, as the shared tag intends', async () => {
    const { push, onScreen } = loadWorker({ webkit: true });
    await push(payload({ email }));
    await push(payload({ emailIds: ['e2'], email: { from: 'B', subject: 'Second' } }));
    expect(onScreen().map((n) => n.options.body)).toEqual(['Second']);
  });

  it('leaves an older notification alone when its data does not come back (cannot tell them apart)', async () => {
    const { push, onScreen } = loadWorker({ webkit: true, dataRoundTrips: false });
    await push(payload({ email }));
    await push(payload({ emailIds: ['e2'], email: { from: 'B', subject: 'Second' } }));
    expect(onScreen()).toHaveLength(2);
  });

  it('browsers that replace by tag see the same notifications as before, and nothing extra', async () => {
    const { push, all, onScreen } = loadWorker({ webkit: false });
    await push(payload({ email }));
    await push(payload({ email: withSummary, renotify: false }));
    expect(all).toHaveLength(2);
    expect(onScreen()).toHaveLength(1);
    expect(onScreen()[0].options).toMatchObject({ body: 'Weekly report\nExamplesensor sent the weekly sensor report.', silent: true, renotify: false });
  });
});

describe('WebKit: every push shows a notification', () => {
  it('a summary whose preview was dismissed shows the summary, silently', async () => {
    const { push, all, onScreen } = loadWorker({ webkit: true });
    await push(payload({ email }));
    onScreen()[0].closed = true; // swiped away by the user
    expect(await push(payload({ email: withSummary, renotify: false }))).toBe(1);
    expect(onScreen()).toHaveLength(1);
    expect(onScreen()[0].options).toMatchObject({ body: 'Weekly report\nExamplesensor sent the weekly sensor report.', silent: true });
    expect(onScreen()[0].options.data).toMatchObject({ kind: 'email', emailId: 'e1', accountId: 'acc1' });
    expect(all).toHaveLength(2);
  });

  it('a summary for a message that is no longer the headline re-shows the current notification', async () => {
    const { push, onScreen } = loadWorker({ webkit: true });
    await push(payload({ email }));
    await push(payload({ emailIds: ['e2'], email: { from: 'B', subject: 'Second' } }));
    expect(await push(payload({ email: withSummary, renotify: false }))).toBe(1);
    expect(onScreen().map((n) => [n.options.body, n.options.silent])).toEqual([['Second', true]]);
  });

  it('a redelivered push re-shows what is on screen, silently, still one notification', async () => {
    const { push, onScreen } = loadWorker({ webkit: true });
    await push(payload({ email }));
    expect(await push(payload({ email }))).toBe(1);
    expect(onScreen()).toHaveLength(1);
    expect(onScreen()[0].options).toMatchObject({ body: 'Weekly report\nYour sensors this week', silent: true });
  });

  it('mail read in the meantime still shows the mail, silently', async () => {
    const read = { ok: true, body: { unreadTotal: 0, email: null } };
    const { push, onScreen } = loadWorker({ webkit: true, preview: read });
    expect(await push(payload({ email }))).toBe(1);
    expect(onScreen()[0].options).toMatchObject({ body: 'Weekly report\nYour sensors this week', silent: true });
  });

  it('an account signed out on purpose shows a plain "New mail" without any of its content', async () => {
    const { push, all, marker } = loadWorker({ webkit: true });
    marker('signed-out/acc1');
    expect(await push(payload({ email }))).toBe(1);
    expect(all[0].title).toBe('New mail');
    expect(all[0].options.tag).toBe('bulwark-push-ack');
    expect(JSON.stringify(all)).not.toMatch(/Examplesensor|Weekly|sensor/);
    // and a second one replaces the first
    await push(payload({ email }));
    expect(all.filter((n) => !n.closed)).toHaveLength(1);
  });

  it('after a sign-out of every account the subscription is dropped and nothing is shown', async () => {
    const { push, all, marker, hasSubscription } = loadWorker({ webkit: true });
    marker('signed-out-all');
    expect(await push(payload({ email }))).toBe(0);
    expect(all).toHaveLength(0);
    expect(hasSubscription()).toBe(false);
  });

  it('other push services keep the silent paths silent', async () => {
    const read = { ok: true, body: { unreadTotal: 0, email: null } };
    const { push, all, marker } = loadWorker({ webkit: false, preview: read });
    await push(payload({ email }));
    marker('signed-out/acc1');
    await push(payload({ emailIds: ['e2'], email }));
    expect(all).toHaveLength(0);
  });

  it('every kind of push shows exactly one notification on WebKit', async () => {
    const { push } = loadWorker({ webkit: true });
    expect(await push(payload({ email }))).toBe(1);
    expect(await push(payload({ email: withSummary, renotify: false }))).toBe(1);
    expect(await push(payload({ email: withSummary, renotify: false }))).toBe(1);
    expect(await push(payload({ email }))).toBe(1);
    expect(await push(payload({ emailIds: [], changed: { acc1: {} } }))).toBe(1);
  });
});
