import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fork patch (Wnt/webmail): a tap on a new-mail notification opens the email
// it announced whenever an id is known - with the preview, without it (the
// session expired), for a "+N more" group, after the AI-summary replacement
// and on the iOS "every push shows something" paths. public/sw.js is served
// raw, so run it in a VM like the other sw-*.test.ts.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://mail.example.com';
const OPEN_KEY = `${ORIGIN}/__push-state/notification-open`;

type Note = { title: string; options: Record<string, unknown>; closed: boolean; at: number };
type Preview = { ok: boolean; status?: number; body?: unknown } | 'throw';

interface FakeClient {
  id: string;
  url: string;
  focused?: boolean;
  visibilityState?: string;
  messages: unknown[];
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: (m: unknown, transfer?: MessagePort[]) => void;
}

/**
 * `answer`: what the running app replies on the port the worker hands it
 * (`undefined`: it never replies, like an older app or one not signed in).
 */
function fakeClient(id: string, opts: { navigateFails?: boolean; answer?: unknown; focused?: boolean; visibilityState?: string } = {}): FakeClient {
  const client: FakeClient = {
    id,
    url: `${ORIGIN}/mail/folder/inbox`,
    focused: opts.focused,
    visibilityState: opts.visibilityState,
    messages: [],
    focus: vi.fn(async () => client),
    navigate: vi.fn(async (url: string) => {
      if (opts.navigateFails) throw new TypeError('not controlled');
      client.url = new URL(url, ORIGIN).href;
      return client;
    }),
    postMessage: (m: unknown, transfer?: MessagePort[]) => {
      client.messages.push(m);
      if (transfer?.[0] && opts.answer !== undefined) transfer[0].postMessage(opts.answer);
    },
  };
  return client;
}

function loadWorker({ preview = { ok: false, status: 401 } as Preview, webkit = false, channels = false } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const all: Note[] = [];
  const onScreen = () => all.filter((n) => !n.closed);
  const cacheStore = new Map<string, string>();
  const clients: FakeClient[] = [];
  const openWindow = vi.fn(async (url: string) => ({ url }));
  const subscription = {
    endpoint: webkit ? 'https://web.push.apple.com/QGx0abc' : 'https://fcm.googleapis.com/fcm/send/abc',
    unsubscribe: async () => true,
  };
  const self = {
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => clients, openWindow },
    crypto: globalThis.crypto,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        // Chromium replaces by tag; WebKit never does.
        if (!webkit && options.tag) {
          for (const n of onScreen()) if (n.options.tag === options.tag) n.closed = true;
        }
        all.push({ title, options, closed: false, at: Date.now() });
      },
      getNotifications: async (filter?: { tag?: string }) => onScreen()
        .filter((n) => !filter?.tag || n.options.tag === filter.tag)
        .map((n) => ({
          title: n.title, body: n.options.body, tag: n.options.tag, data: n.options.data,
          close: () => { n.closed = true; },
        })),
      pushManager: { getSubscription: async () => subscription },
    },
  };
  const caches = {
    open: async () => ({
      match: async (key: string | { url: string }) => {
        const value = cacheStore.get(typeof key === 'string' ? key : key.url);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => {
        cacheStore.delete(key);
        cacheStore.set(key, await res.text());
      },
      keys: async () => [...cacheStore.keys()].map((url) => ({ url })),
      delete: async (key: string | { url: string }) => cacheStore.delete(typeof key === 'string' ? key : key.url),
    }),
  };
  const fetchMock = vi.fn(async () => {
    if (preview === 'throw') throw new TypeError('network down');
    return { ok: preview.ok, status: preview.status ?? 200, json: async () => preview.body };
  });
  const context = vm.createContext({
    self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console,
    setTimeout, clearTimeout, AbortController,
    ...(channels ? { MessageChannel } : {}),
  });
  vm.runInContext(SW_SOURCE, context);

  async function push(payload: unknown) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.all(waits);
  }
  async function click(note: Note, { advanceMs = 0 } = {}) {
    const waits: Promise<unknown>[] = [];
    listeners.get('notificationclick')?.({
      notification: { data: note.options.data, tag: note.options.tag, close: () => { note.closed = true; } },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    if (advanceMs) {
      // Let a reply on a real MessagePort arrive (event loop), then run the timers.
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(advanceMs);
    }
    await Promise.all(waits);
  }
  const pendingOpen = () => {
    const raw = cacheStore.get(OPEN_KEY);
    return raw === undefined ? null : JSON.parse(raw);
  };
  const latest = () => onScreen()[onScreen().length - 1];
  return { push, click, all, onScreen, latest, clients, openWindow, pendingOpen, context, cacheStore };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  kind: 'email',
  accountLabel: 'me@example.com',
  accountId: 'acc1',
  emailIds: ['e1', 'e2'],
  changed: { acc1: { EmailDelivery: 's1' } },
  ...extra,
});
const email = { from: 'Alice <alice@example.com>', subject: 'Lunch?', preview: 'Are you free at noon?' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-17T08:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('notification data: every tap that can name an email opens it', () => {
  it('a "+N more" group opens its newest (headline) email, not the inbox', async () => {
    const w = loadWorker({
      preview: {
        ok: true,
        body: { email: { id: 'e2', threadId: 't2', from: [{ name: 'Alice' }], subject: 'Lunch?' }, unreadTotal: 3, slot: 0 },
      },
    });
    await w.push(payload());
    const n = w.latest();
    expect(n.options.body).toBe('Lunch?\n+2 more messages');
    expect(n.options.data).toMatchObject({ kind: 'email', emailId: 'e2', threadId: 't2', slot: 0, accountId: 'acc1', headlineEmailId: 'e2' });
    expect(n.options.navigate).toBe(`${ORIGIN}/mail/message/e2?slot=0`);
  });

  it('a single unread email still deep-links (unchanged)', async () => {
    const w = loadWorker({
      preview: { ok: true, body: { email: { id: 'e2', threadId: 't2', from: [{ name: 'Alice' }], subject: 'Hi' }, unreadTotal: 1, slot: 1 } },
    });
    await w.push(payload());
    expect(w.latest().options.data).toMatchObject({ kind: 'email', emailId: 'e2', slot: 1 });
    expect(w.latest().options.navigate).toBe(`${ORIGIN}/mail/message/e2?slot=1`);
  });

  it('the preview API failing (401: session expired) still deep-links to the newest id from the push', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 } });
    await w.push(payload({ email }));
    const n = w.latest();
    expect(n.title).toBe('Alice <alice@example.com>');
    expect(n.options.data).toMatchObject({ kind: 'email', emailId: 'e2', accountId: 'acc1', headlineEmailId: 'e2' });
    expect(n.options.navigate).toBe(`${ORIGIN}/mail/message/e2`);
  });

  it('a network failure without the payload email still deep-links', async () => {
    const w = loadWorker({ preview: 'throw' });
    await w.push(payload());
    expect(w.latest().title).toBe('New mail (me@example.com)');
    expect(w.latest().options.data).toMatchObject({ kind: 'email', emailId: 'e2' });
  });

  it('only a push with no id at all (bare state change, no preview) opens the list', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 } });
    await w.push(payload({ emailIds: undefined }));
    expect(w.latest().options.data).toMatchObject({ kind: 'mail-list', accountId: 'acc1' });
    expect(w.latest().options.navigate).toBe(`${ORIGIN}/?openLatestUnread=1`);
  });

  it('ids are encoded into a same-origin path', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 } });
    await w.push(payload({ emailIds: ['a/b?c#d'] }));
    expect(w.latest().options.navigate).toBe(`${ORIGIN}/mail/message/a%2Fb%3Fc%23d`);
  });

  it('the quiet AI-summary replacement keeps the deep link', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 } });
    await w.push(payload({ email }));
    await w.push(payload({ email: { ...email, summary: 'Alice asks about lunch.' }, renotify: false }));
    const n = w.latest();
    expect(n.options.body).toBe('Lunch?\nAlice asks about lunch.');
    expect(n.options.data).toMatchObject({ kind: 'email', emailId: 'e2' });
    expect(n.options.navigate).toBe(`${ORIGIN}/mail/message/e2`);
  });

  it('iOS: the summary replacement (close-then-show) keeps the deep link', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 }, webkit: true });
    await w.push(payload({ email }));
    await w.push(payload({ email: { ...email, summary: 'Alice asks about lunch.' }, renotify: false }));
    expect(w.onScreen()).toHaveLength(1);
    expect(w.latest().options.data).toMatchObject({ kind: 'email', emailId: 'e2' });
    expect(w.latest().options.navigate).toBe(`${ORIGIN}/mail/message/e2`);
  });

  it('iOS: a push that would show nothing (redelivery) re-shows the deep link', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 }, webkit: true });
    await w.push(payload({ email }));
    await w.push(payload({ email })); // same ids again
    expect(w.all.length).toBe(2);
    expect(w.latest().options.data).toMatchObject({ kind: 'email', emailId: 'e2' });
    expect(w.latest().options.navigate).toBe(`${ORIGIN}/mail/message/e2`);
  });

  it('iOS: a summary for a notification already gone is shown with its own deep link', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 }, webkit: true });
    await w.push(payload({ email }));
    for (const n of w.onScreen()) n.closed = true; // the user dismissed it
    await w.push(payload({ email: { ...email, summary: 'Alice asks about lunch.' }, renotify: false }));
    expect(w.latest().options.data).toMatchObject({ kind: 'email', emailId: 'e2' });
    expect(w.latest().options.navigate).toBe(`${ORIGIN}/mail/message/e2`);
  });
});

describe('notificationclick', () => {
  it('app running: records the tap, tells the app, focuses, then navigates to the email', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 } });
    await w.push(payload({ email }));
    const client = fakeClient('c1');
    w.clients.push(client);
    await w.click(w.latest());
    expect(w.pendingOpen()).toMatchObject({ emailId: 'e2', url: '/mail/message/e2', at: Date.now() });
    expect(client.messages).toEqual([expect.objectContaining({ kind: 'notificationclick', data: expect.objectContaining({ kind: 'email', emailId: 'e2' }) })]);
    expect(client.focus).toHaveBeenCalledBefore(client.navigate);
    expect(client.navigate).toHaveBeenCalledWith('/mail/message/e2');
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('app running but navigate() fails: the recorded tap is still there for the app', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 } });
    await w.push(payload({ email }));
    const client = fakeClient('c1', { navigateFails: true });
    w.clients.push(client);
    await w.click(w.latest());
    expect(client.focus).toHaveBeenCalled();
    expect(w.pendingOpen()).toMatchObject({ emailId: 'e2' });
    expect(client.messages).toHaveLength(1);
  });

  it('cold start: opens a window at the email and records the tap', async () => {
    const w = loadWorker({
      preview: { ok: true, body: { email: { id: 'e2', threadId: 't2', from: [{ name: 'Alice' }], subject: 'Hi' }, unreadTotal: 4, slot: 0 } },
    });
    await w.push(payload());
    await w.click(w.latest());
    expect(w.openWindow).toHaveBeenCalledWith('/mail/message/e2?slot=0');
    expect(w.pendingOpen()).toMatchObject({ emailId: 'e2', slot: 0 });
  });

  it('signed-in app in front answers: it opens the email in place, so the worker focuses it and does not navigate', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 }, channels: true });
    await w.push(payload({ email }));
    const client = fakeClient('c1', { answer: { opening: true }, focused: true });
    w.clients.push(client);
    const t0 = Date.now();
    await w.click(w.latest(), { advanceMs: 5 });
    expect(client.messages).toEqual([expect.objectContaining({ kind: 'notificationclick', open: true, data: expect.objectContaining({ emailId: 'e2' }) })]);
    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
    // The recorded tap stays the app's source of truth for the id.
    expect(w.pendingOpen()).toMatchObject({ emailId: 'e2' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('an app that does not answer (older version, not signed in, frozen) is navigated after the wait', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 }, channels: true });
    await w.push(payload({ email }));
    const client = fakeClient('c1');
    w.clients.push(client);
    await w.click(w.latest(), { advanceMs: 1100 });
    expect(client.focus).toHaveBeenCalledBefore(client.navigate);
    expect(client.navigate).toHaveBeenCalledWith('/mail/message/e2');
  });

  it('an app that answers it will not open it is navigated at once', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 }, channels: true });
    await w.push(payload({ email }));
    const client = fakeClient('c1', { answer: { opening: false } });
    w.clients.push(client);
    await w.click(w.latest(), { advanceMs: 5 });
    expect(client.navigate).toHaveBeenCalledWith('/mail/message/e2');
  });

  it('the front-most window is the one asked and focused; the others only hear about the tap', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 }, channels: true });
    await w.push(payload({ email }));
    const behind = fakeClient('c1', { answer: { opening: true }, visibilityState: 'hidden' });
    const front = fakeClient('c2', { answer: { opening: true }, focused: true, visibilityState: 'visible' });
    w.clients.push(behind, front);
    await w.click(w.latest(), { advanceMs: 5 });
    expect(front.messages).toEqual([expect.objectContaining({ open: true })]);
    expect(behind.messages).toEqual([expect.not.objectContaining({ open: true })]);
    expect(front.focus).toHaveBeenCalled();
    expect(behind.focus).not.toHaveBeenCalled();
    expect(front.navigate).not.toHaveBeenCalled();
    expect(behind.navigate).not.toHaveBeenCalled();
  });

  it('a list notification records nothing and opens the latest unread', async () => {
    const w = loadWorker({ preview: { ok: false, status: 401 } });
    await w.push(payload({ emailIds: undefined }));
    await w.click(w.latest());
    expect(w.openWindow).toHaveBeenCalledWith('/?openLatestUnread=1');
    expect(w.pendingOpen()).toBeNull();
  });
});


// Fork (Wnt/webmail): the whole message a notification opens is kept for the
// tap (lib/push-prefetch.ts), fetched with the preview.
describe('the message kept for the tap', () => {
  const PREFIX = `${ORIGIN}/__push-state/prefetched/acc1/`;
  const whole = (id: string) => ({ id, threadId: `t-${id}`, bodyValues: { '1': { value: 'Hello', isTruncated: false } } });
  const kept = (w: { cacheStore: Map<string, string> }) => [...w.cacheStore.keys()].filter((k) => k.startsWith(PREFIX));

  it('asks the preview for the whole message and keeps it once the notification is up', async () => {
    const w = loadWorker({
      preview: { ok: true, body: { email: { id: 'e2', threadId: 't2', from: [{ name: 'Alice' }], subject: 'Hi' }, unreadTotal: 1, slot: 0, full: whole('e2') } },
    });
    await w.push(payload());
    expect(w.latest().options.data).toMatchObject({ emailId: 'e2' });
    const fetchMock = (w.context as unknown as { fetch: { mock: { calls: [string][] } } }).fetch;
    expect(String(fetchMock.mock.calls[0][0])).toContain('full=1');
    expect(kept(w)).toEqual([`${PREFIX}e2`]);
    expect(JSON.parse(w.cacheStore.get(`${PREFIX}e2`)!)).toMatchObject({ accountId: 'acc1', email: { id: 'e2' } });
  });

  it('keeps nothing for a different message than the notification opens', async () => {
    const w = loadWorker({
      preview: { ok: true, body: { email: { id: 'e2', threadId: 't2', from: [{ name: 'Alice' }], subject: 'Hi' }, unreadTotal: 1, full: whole('other') } },
    });
    await w.push(payload());
    expect(kept(w)).toEqual([]);
  });

  it('keeps the newest five', async () => {
    let n = 0;
    const w = loadWorker({ preview: { ok: true, body: {} } });
    const fetchMock = (w.context as unknown as { fetch: { mockImplementation: (f: () => unknown) => void } }).fetch;
    fetchMock.mockImplementation(async () => {
      const id = `m${n++}`;
      return { ok: true, status: 200, json: async () => ({ email: { id, threadId: `t${id}`, from: [{ name: 'A' }], subject: 'S' }, unreadTotal: 1, full: whole(id) }) };
    });
    for (let i = 0; i < 7; i++) await w.push(payload({ emailIds: [`m${i}`] }));
    expect(kept(w)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6'].map((id) => `${PREFIX}${id}`));
  });
});
