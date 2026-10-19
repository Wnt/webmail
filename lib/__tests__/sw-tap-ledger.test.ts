import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SW_REVISION } from '@/lib/sw-revision';

// Fork patch (Wnt/webmail): a tap on the owner's iPhone (2026-10-19) opened
// the Inbox: the notification had a `navigate` URL, so WebKit fired no
// notificationclick, and it brought the backgrounded app back without that
// URL. The worker now keeps a ledger of the mail notifications it shows, so
// the app can tell which one the tap removed (lib/notification-open.ts), and
// records each link of a tap's chain without ids (the tap diagnostics).
// public/sw.js is served raw, so it runs in a VM like the other sw-*.test.ts.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://mail.example.com';
const SHOWN = `${ORIGIN}/__push-state/shown/`;
const TRACE = `${ORIGIN}/__push-state/tap-trace/`;

type Note = { title: string; options: Record<string, unknown>; closed: boolean; at?: number };

function loadWorker({ webkit = true, traceStatus = 204, listLagMs = 0 } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const all: Note[] = [];
  const onScreen = () => all.filter((n) => !n.closed);
  const cacheStore = new Map<string, string>();
  const subscription = {
    endpoint: webkit ? 'https://web.push.apple.com/QGx0abc' : 'https://fcm.googleapis.com/fcm/send/abc',
    unsubscribe: async () => true,
  };
  const self = {
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    navigator: { userAgent: webkit ? 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/26.4 Mobile/15E148 Safari/604.1' : 'Chrome/150' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [], openWindow: vi.fn(async (url: string) => ({ url })) },
    crypto: globalThis.crypto,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        if (!webkit && options.tag) {
          for (const n of onScreen()) if (n.options.tag === options.tag) n.closed = true;
        }
        all.push({ title, options, closed: false, at: Date.now() });
      },
      // `listLagMs`: the browser lists a notification only that long after showing it.
      getNotifications: async (filter?: { tag?: string }) => onScreen()
        .filter((n) => Date.now() - (n.at ?? 0) >= listLagMs)
        .filter((n) => !filter?.tag || n.options.tag === filter.tag)
        .map((n) => ({ title: n.title, body: n.options.body, tag: n.options.tag, data: n.options.data, close: () => { n.closed = true; } })),
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
  const posted: unknown[] = [];
  let preview: { ok: boolean; status?: number; body?: unknown } = { ok: false, status: 401 };
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes('/api/perf/tap')) {
      posted.push(JSON.parse(String(init?.body)));
      return { ok: traceStatus >= 200 && traceStatus < 300, status: traceStatus, json: async () => ({}) };
    }
    return { ok: preview.ok, status: preview.status ?? 200, json: async () => preview.body };
  });
  const context = vm.createContext({
    self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console,
    setTimeout, clearTimeout, AbortController, MessageChannel,
  });
  vm.runInContext(SW_SOURCE, context);

  async function fire(type: string, event: Record<string, unknown>, advanceMs = 40_000) {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await vi.advanceTimersByTimeAsync(advanceMs);
    await Promise.all(waits);
  }
  const push = (payload: unknown, advanceMs?: number) => fire('push', { data: { json: () => payload } }, advanceMs);
  const click = (note: Note) => fire('notificationclick', {
    notification: { data: note.options.data, tag: note.options.tag, close: () => { note.closed = true; } },
  }, 0);
  const dismiss = (note: Note) => {
    note.closed = true;
    return fire('notificationclose', { notification: { data: note.options.data, tag: note.options.tag } }, 0);
  };
  const ledger = () => [...cacheStore.entries()].filter(([k]) => k.startsWith(SHOWN)).map(([, v]) => JSON.parse(v));
  const traces = () => [...cacheStore.entries()].filter(([k]) => k.startsWith(TRACE)).map(([, v]) => JSON.parse(v));
  const setPreview = (p: typeof preview) => { preview = p; };
  return { push, click, dismiss, fire, all, onScreen, ledger, traces, posted, cacheStore, setPreview, listeners };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  kind: 'email', accountLabel: 'me@example.test', accountId: 'acc1', emailIds: ['e1'],
  changed: { acc1: { EmailDelivery: 's1' } },
  email: { from: 'Examplepaja <info@examplepaja.test>', subject: 'Invented subject', preview: 'Invented preview' },
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the ledger of shown notifications (lost iPhone taps)', () => {
  it('records each mail notification it shows, with whether the browser listed it', async () => {
    const w = loadWorker();
    await w.push(payload());
    const shown = w.onScreen()[0];
    expect(shown.options.navigate).toBe(`${ORIGIN}/mail/message/e1`);
    expect(w.ledger()).toEqual([expect.objectContaining({
      shownId: (shown.options.data as { shownId: string }).shownId, emailId: 'e1', accountId: 'acc1', listed: true,
    })]);
    expect(w.ledger()[0].closed).toBeUndefined();
  });

  it('marks the older notification closed when a newer one replaces it (WebKit keeps both until closed)', async () => {
    const w = loadWorker();
    await w.push(payload());
    await w.push(payload({ emailIds: ['e2'] }));
    const byEmail = Object.fromEntries(w.ledger().map((e) => [e.emailId, e]));
    expect(w.onScreen().map((n) => (n.options.data as { emailId: string }).emailId)).toEqual(['e2']);
    expect(byEmail.e1.closed).toBe(true);
    expect(byEmail.e2.closed).toBeUndefined();
  });

  it('keeps the older one open in the ledger while WebKit refuses to close it (under 30 s old)', async () => {
    const w = loadWorker();
    await w.push(payload(), 1000);
    // The newer push arrives 1 s later; the close waits for the 30 s rule.
    const second = w.push(payload({ emailIds: ['e2'] }), 0);
    await vi.advanceTimersByTimeAsync(100);
    const early = Object.fromEntries(w.ledger().map((e) => [e.emailId, e]));
    expect(early.e1.closed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(40_000);
    await second;
    const late = Object.fromEntries(w.ledger().map((e) => [e.emailId, e]));
    expect(late.e1.closed).toBe(true);
  });

  it('a summary replacement is a new entry for the same message, the preview one is closed', async () => {
    const w = loadWorker();
    await w.push(payload());
    await w.push(payload({ renotify: false, email: { ...payload().email, summary: 'Invented summary' } }));
    const open = w.ledger().filter((e) => !e.closed);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ emailId: 'e1' });
    expect(w.ledger()).toHaveLength(2);
  });

  it('a click that reaches the worker takes its entry out (the page must not open it again)', async () => {
    const w = loadWorker();
    await w.push(payload());
    await w.click(w.onScreen()[0]);
    expect(w.ledger()).toEqual([]);
  });

  it('a dismissal takes its entry out', async () => {
    const w = loadWorker();
    await w.push(payload());
    await w.dismiss(w.onScreen()[0]);
    expect(w.ledger()).toEqual([]);
  });

  it('an explicit sign-out of the account forgets its entries', async () => {
    const w = loadWorker();
    await w.push(payload());
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 0);
    expect(w.ledger()).toEqual([]);
  });

  it('a notification the browser lists only a moment later is confirmed as listed', async () => {
    const w = loadWorker({ listLagMs: 1000 });
    await w.push(payload());
    expect(w.ledger()).toEqual([expect.objectContaining({ emailId: 'e1', listed: true })]);
    const events = w.posted.flatMap((b) => (b as { events: { ev: string; f: Record<string, unknown> }[] }).events);
    expect(events[0].f).toMatchObject({ listed: true });
  });

  it('one the browser never lists stays unconfirmed (its absence proves nothing)', async () => {
    const w = loadWorker({ listLagMs: 600_000 });
    await w.push(payload());
    expect(w.ledger()).toEqual([expect.objectContaining({ emailId: 'e1', listed: false })]);
  });

  it('records nothing for a generic "New mail" toast with no message', async () => {
    const w = loadWorker();
    await w.push(payload({ emailIds: [], email: undefined }));
    expect(w.ledger()).toEqual([]);
  });
});

describe('the tap diagnostics (worker side)', () => {
  it('records a push with its facts and sends it at once', async () => {
    const w = loadWorker();
    await w.push(payload());
    expect(w.posted).toHaveLength(1);
    const batch = w.posted[0] as { v: number; events: { ev: string; src: string; sw: string; f: Record<string, unknown> }[] };
    expect(batch.v).toBe(1);
    expect(batch.events).toEqual([expect.objectContaining({
      ev: 'push', src: 'sw', sw: SW_REVISION, eng: 'webkit',
      f: { target: true, preview: 'fail', shown: 'new', nav: true, listed: true, win: 0, vis: false },
    })]);
    // Sent: nothing waits for the app.
    expect(w.traces()).toEqual([]);
  });

  it('keeps the records for the app when the post is refused (no session cookie in the worker)', async () => {
    const w = loadWorker({ traceStatus: 401 });
    await w.push(payload());
    expect(w.traces().map((t) => t.ev)).toEqual(['push']);
  });

  it('a summary replacement is traced as such, with no preview lookup', async () => {
    const w = loadWorker();
    await w.push(payload());
    await w.push(payload({ renotify: false, email: { ...payload().email, summary: 'Invented summary' } }));
    const events = w.posted.flatMap((b) => (b as { events: { ev: string; f: Record<string, unknown> }[] }).events);
    expect(events[1]).toMatchObject({ ev: 'push', f: { shown: 'summary', preview: 'skip', nav: true } });
  });

  it('records the click and what it did, and leaves sending it to the app or the next push', async () => {
    const w = loadWorker();
    await w.push(payload());
    await w.click(w.onScreen()[0]);
    expect(w.traces()).toEqual([expect.objectContaining({ ev: 'click', f: { target: true, win: 0, act: 'open', age: 40 } })]);
    expect(w.posted).toHaveLength(1);
    await w.push(payload({ emailIds: ['e2'] }));
    const events = w.posted.flatMap((b) => (b as { events: { ev: string; f: Record<string, unknown> }[] }).events);
    expect(events.map((e) => e.ev)).toEqual(['push', 'click', 'push']);
  });

  it('records a dismissal', async () => {
    const w = loadWorker();
    await w.push(payload());
    await w.dismiss(w.onScreen()[0]);
    const events = w.posted.flatMap((b) => (b as { events: { ev: string }[] }).events);
    expect(events.map((e) => e.ev)).toEqual(['push', 'close']);
  });

  it('never carries an id, address, subject or preview', async () => {
    const w = loadWorker({ traceStatus: 401 });
    w.setPreview({ ok: true, body: { email: { id: 'e1', threadId: 't1', from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], subject: 'Invented subject' }, unreadTotal: 1 } });
    await w.push(payload());
    await w.click(w.onScreen()[0]);
    const text = JSON.stringify(w.traces()) + JSON.stringify(w.posted);
    for (const secret of ['e1', 't1', 'acc1', 'examplepaja', 'Invented', 'me@example.test']) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers the page with its revision', async () => {
    const w = loadWorker();
    const port = { postMessage: vi.fn() };
    w.listeners.get('message')?.({ data: { type: 'sw-revision' }, ports: [port], waitUntil: () => {} });
    expect(port.postMessage).toHaveBeenCalledWith({ revision: SW_REVISION });
  });
});
