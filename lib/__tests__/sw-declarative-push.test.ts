import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FULL_EMAIL_BODY_OPTIONS, FULL_EMAIL_PROPERTIES } from '@/lib/jmap/full-email';
import { parseTapRecord } from '@/lib/tap-trace-beacon';

// Fork patch (Wnt/webmail): on 2026-10-19 the owner's iPhone, with the Home
// Screen app not running, showed a new-mail notification only when the next
// push (the summary, 35 s later) arrived: iOS launched the app for the first
// push, but its worker got that push only with the next one. The gateway now
// sends the new-mail push to Apple as a Declarative Web Push message, which
// iOS shows by itself (no worker, and no data kept), and the worker takes
// that notification over when the quiet summary push arrives. Every push
// also carries a preview ticket, so the worker keeps the message for the tap
// when its session-backed preview lookup fails (an idle phone: 401).
// public/sw.js is served raw, so it runs in a VM like the other sw-*.test.ts.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://mail.example.com';
const KEPT = `${ORIGIN}/__push-state/prefetched/`;
const SHOWN = `${ORIGIN}/__push-state/shown/`;
const TRACE = `${ORIGIN}/__push-state/tap-trace/`;
const NOTIFIED = `${ORIGIN}/__push-state/notified/`;
const WEBKIT_MIN_LIFETIME_MS = 30_000;

type Note = { title: string; options: Record<string, unknown>; closed: boolean; at: number; byBrowser?: boolean };
type Reply = { ok: boolean; status: number; body?: unknown };

function loadWorker({ webkit = true, onShow, markerReadsThrow = false, onList, beforePut, noSubscription = false, listFails }: {
  /** getNotifications() rejects on these 1-based listings. */
  listFails?: (count: number) => boolean;
  webkit?: boolean;
  /** Runs after each getNotifications() listing (its 1-based count). */
  onList?: (count: number) => void;
  /** Awaited before a cache write lands (its key). */
  beforePut?: (key: string) => Promise<void> | void;
  /** The browser subscription is already gone (the page unsubscribed). */
  noSubscription?: boolean;
  /** Runs while the worker's showNotification is in progress (e.g. iOS showing another one meanwhile). */
  onShow?: () => void;
  /** Reading a sign-out marker fails (Cache Storage error). */
  markerReadsThrow?: boolean;
} = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const all: Note[] = [];
  const onScreen = () => all.filter((n) => !n.closed);
  let listings = 0;
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
    clients: { claim: () => {}, matchAll: async () => [] },
    crypto: globalThis.crypto,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        if (!webkit && options.tag) {
          for (const n of onScreen()) if (n.options.tag === options.tag) n.closed = true;
        }
        all.push({ title, options, closed: false, at: Date.now() });
        onShow?.();
      },
      getNotifications: async (filter?: { tag?: string }) => {
        if (listFails?.(listings + 1)) {
          listings++;
          throw new Error('listing failed');
        }
        const listed = onScreen()
        .filter((n) => !filter?.tag || n.options.tag === filter.tag)
        .map((n) => ({
          title: n.title, body: n.options.body, tag: n.options.tag,
          // WebKit keeps no data for a notification it showed from a declarative message.
          data: n.byBrowser ? null : n.options.data,
          navigate: n.options.navigate ?? '',
          close: () => {
            if (webkit && Date.now() - n.at < WEBKIT_MIN_LIFETIME_MS) return; // refused
            n.closed = true;
          },
        }));
        listings++;
        onList?.(listings);
        return listed;
      },
      pushManager: { getSubscription: async () => (noSubscription ? null : subscription) },
    },
  };
  const caches = {
    open: async () => ({
      match: async (key: string | { url: string }) => {
        const url = typeof key === 'string' ? key : key.url;
        if (markerReadsThrow && url.includes('/__push-state/signed-out')) throw new Error('cache read failed');
        const value = cacheStore.get(url);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => {
        const text = await res.text();
        await beforePut?.(key);
        cacheStore.delete(key);
        cacheStore.set(key, text);
      },
      keys: async () => [...cacheStore.keys()].map((url) => ({ url })),
      delete: async (key: string | { url: string }) => cacheStore.delete(typeof key === 'string' ? key : key.url),
    }),
  };
  let previewReply: Reply = { ok: false, status: 401 };
  let ticketReply: (body: Record<string, unknown>) => Reply | Promise<Reply> = () => ({ ok: false, status: 403 });
  const ticketRequests: { url: string; init: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const previewRequests: string[] = [];
  const posted: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init: Record<string, unknown> = {}) => {
    const u = String(url);
    if (u.includes('/api/perf/tap')) {
      posted.push(...(JSON.parse(String(init.body)) as { events: Record<string, unknown>[] }).events);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (u === `${ORIGIN}/relay/api/push/preview`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      ticketRequests.push({ url: u, init, body });
      const r = await ticketReply(body);
      return { ok: r.ok, status: r.status, json: async () => r.body };
    }
    if (u.includes('/api/push/preview')) {
      previewRequests.push(u);
      return { ok: previewReply.ok, status: previewReply.status, json: async () => previewReply.body };
    }
    throw new Error(`unexpected fetch ${u}`);
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
  async function push(payload: unknown, advanceMs = 40_000) {
    const waits: Promise<unknown>[] = [];
    listeners.get('push')?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await vi.advanceTimersByTimeAsync(advanceMs);
    await Promise.all(waits);
  }
  /** What iOS's webpushd does with a declarative message: shows it itself, with no worker and no data. */
  function showByBrowser(message: { notification: Record<string, unknown> }) {
    const { title, ...options } = message.notification;
    all.push({ title: String(title), options, closed: false, at: Date.now(), byBrowser: true });
  }
  const entries = (prefix: string) => [...cacheStore.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => JSON.parse(v));
  return {
    push, fire, showByBrowser, all, onScreen, cacheStore, ticketRequests, previewRequests,
    kept: () => entries(KEPT), ledger: () => entries(SHOWN), notified: () => entries(NOTIFIED),
    /** The push records, sent or still waiting. */
    traces: () => [...posted, ...entries(TRACE)].filter((r) => r.ev === 'push') as { f: Record<string, unknown> }[],
    setPreview: (r: Reply) => { previewReply = r; },
    setTicket: (fn: (body: Record<string, unknown>) => Reply | Promise<Reply>) => { ticketReply = fn; },
    listeners,
    marker: (path: string) => cacheStore.set(`${ORIGIN}/__push-state/${path}`, '{"at":1}'),
  };
}

const SENT_AT = Date.parse('2026-10-19T12:06:06Z');
const email = { from: 'Examplepaja <info@examplepaja.test>', subject: 'Order confirmed', preview: 'Thanks for your order' };
const summary = 'Examplepaja confirms the order and ships it tomorrow.';
const payload = (extra: Record<string, unknown> = {}) => ({
  kind: 'email', accountLabel: 'me@example.test', accountId: 'acc1', emailIds: ['e1'],
  changed: { acc1: { EmailDelivery: 's1' } }, email, sentAt: SENT_AT, previewTicket: 'ticket-e1-abc',
  ...extra,
});
/** The gateway's declarative message for `payload()` (webmail-gateway payload.ts declarativePayload). */
const declarative = (extra: Record<string, unknown> = {}) => ({
  web_push: 8030,
  notification: {
    title: email.from, body: `${email.subject}\n${email.preview}`, navigate: `${ORIGIN}/mail/message/e1`,
    tag: 'bulwark-mail:acc1', silent: false,
    data: { kind: 'email', emailId: 'e1', accountId: 'acc1', headlineEmailId: 'e1' },
  },
  ...payload(extra),
});
const fullEmail = (id = 'e1') => ({
  id, threadId: `t-${id}`, subject: email.subject, from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }],
  bodyValues: { 1: { value: 'Invented body.', isTruncated: false } }, textBody: [{ partId: '1', type: 'text/plain' }],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SENT_AT + 1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a notification iOS showed itself (declarative push)', () => {
  it('is taken over by the summary push: quiet, with the tap data, the ledger entry and the message kept', async () => {
    const w = loadWorker();
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    w.showByBrowser(declarative());
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, sentAt: SENT_AT + 35_500, firstSentAt: SENT_AT }));

    expect(w.onScreen()).toHaveLength(1);
    const mine = w.onScreen()[0];
    expect(mine.byBrowser).toBeUndefined();
    expect(mine.title).toBe(email.from);
    expect(mine.options).toMatchObject({
      body: `${email.subject}\n${summary}`, silent: true, renotify: false, tag: 'bulwark-mail:acc1',
      navigate: `${ORIGIN}/mail/message/e1`,
    });
    expect(mine.options.data).toMatchObject({ kind: 'email', emailId: 'e1', accountId: 'acc1', headlineEmailId: 'e1' });
    // the ledger knows it (a lost tap can be found), the message counts as announced and is kept for the tap
    expect(w.ledger()).toEqual([expect.objectContaining({ emailId: 'e1', accountId: 'acc1' })]);
    expect(w.notified()).toEqual([{ ids: ['e1'] }]);
    expect(w.kept()).toEqual([expect.objectContaining({ accountId: 'acc1', email: fullEmail() })]);
    expect(w.ticketRequests).toHaveLength(1);
    expect(w.ticketRequests[0].body).toEqual({ ticket: 'ticket-e1-abc', properties: [...FULL_EMAIL_PROPERTIES], ...FULL_EMAIL_BODY_OPTIONS });
    expect(w.ticketRequests[0].init).toMatchObject({ method: 'POST', credentials: 'omit' });
    // no session lookup was needed for it
    expect(w.previewRequests).toEqual([]);
    const [trace] = w.traces();
    expect(trace.f).toMatchObject({ shown: 'summary', over: true, kept: 'ticket' });
    expect(parseTapRecord(trace)).not.toBeNull();
  });

  it('a summary push that comes before WebKit allows closing it still ends with one notification', async () => {
    const w = loadWorker();
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    w.showByBrowser(declarative());
    await vi.advanceTimersByTimeAsync(5_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false }));
    expect(w.onScreen()).toHaveLength(1);
    expect(w.onScreen()[0].byBrowser).toBeUndefined();
  });

  it('a quiet push for a message whose notification is gone (dismissed, or never shown) shows it without a sound', async () => {
    const w = loadWorker();
    w.showByBrowser(declarative());
    w.onScreen()[0].closed = true; // swiped away
    await w.push(payload({ email: { ...email, summary }, renotify: false }));
    expect(w.onScreen()).toHaveLength(1);
    expect(w.onScreen()[0].options).toMatchObject({ silent: true, renotify: false, body: `${email.subject}\n${summary}` });
  });

  it('a summary for a message iOS showed nothing for replaces an older notification, quietly', async () => {
    // The gateway summarises only the newest message it pushed, so what is on
    // screen is older: e.g. the phone was offline and the push service kept
    // only the latest push of the account's topic.
    const w = loadWorker();
    w.showByBrowser(declarative({ emailIds: ['e0'] }));
    (w.onScreen()[0].options as { navigate: string }).navigate = `${ORIGIN}/mail/message/e0#sent=${SENT_AT - 60_000}`;
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT }));
    expect(w.onScreen()).toHaveLength(1);
    expect(w.onScreen()[0].options.data).toMatchObject({ kind: 'email', emailId: 'e1' });
    expect(w.onScreen()[0].options).toMatchObject({ silent: true, renotify: false, body: `${email.subject}\n${summary}` });
  });

  it('a late summary for an older message the worker announced re-shows the newer notification iOS showed', async () => {
    const w = loadWorker();
    await w.push(payload({ emailIds: ['e1'] }));
    w.showByBrowser(declarative({ emailIds: ['e2'] }));
    (w.onScreen()[1].options as { navigate: string }).navigate = `${ORIGIN}/mail/message/e2#sent=${SENT_AT + 10_000}`;
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT }));
    const mine = w.onScreen().filter((n) => !n.byBrowser);
    expect(mine.map((n) => (n.options.data as { emailId: string }).emailId)).toEqual(['e2']);
    expect(mine[0].options.navigate).toBe(`${ORIGIN}/mail/message/e2`);
    expect(mine[0].options.silent).toBe(true);
  });

  it('only a message link of this origin counts', async () => {
    const w = loadWorker();
    w.showByBrowser(declarative());
    (w.onScreen()[0].options as { navigate: string }).navigate = 'https://elsewhere.example/mail/message/e1';
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false }));
    const trace = w.traces()[0];
    expect(trace.f.over).toBeUndefined();
  });

  it('a declarative message that reaches the worker (a browser without declarative push) is a normal push', async () => {
    const w = loadWorker({ webkit: false });
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    await w.push(declarative());
    expect(w.onScreen()).toHaveLength(1);
    expect(w.onScreen()[0].options).toMatchObject({ body: `${email.subject}\n${email.preview}`, silent: false });
    expect(w.kept()).toHaveLength(1);
  });
});

describe('keeping the message with the push\'s preview ticket', () => {
  it('after the session lookup fails (401), the ticket keeps the message, after the notification is up', async () => {
    const w = loadWorker();
    let shownWhenKept = -1;
    w.setTicket(() => {
      shownWhenKept = w.onScreen().length;
      return { ok: true, status: 200, body: { email: fullEmail() } };
    });
    await w.push(payload());
    expect(w.previewRequests).toHaveLength(1);
    expect(shownWhenKept).toBe(1);
    expect(w.onScreen()[0].options).toMatchObject({ body: `${email.subject}\n${email.preview}` });
    expect(w.kept()).toEqual([expect.objectContaining({ email: fullEmail() })]);
    const [trace] = w.traces();
    expect(trace.f).toMatchObject({ preview: 'fail', shown: 'new', kept: 'ticket', lag: 1 });
    expect(typeof trace.f.show).toBe('number');
    expect(parseTapRecord(trace)).not.toBeNull();
  });

  it('a lookup that gave the whole message needs no ticket', async () => {
    const w = loadWorker();
    w.setPreview({ ok: true, status: 200, body: { email: { id: 'e1', from: [{ name: 'Examplepaja' }], subject: email.subject }, unreadTotal: 1, full: fullEmail() } });
    await w.push(payload());
    expect(w.ticketRequests).toHaveLength(0);
    expect(w.traces()[0].f.kept).toBe('preview');
  });

  it('a refused ticket keeps nothing and costs nothing else', async () => {
    const w = loadWorker();
    await w.push(payload());
    expect(w.onScreen()).toHaveLength(1);
    expect(w.kept()).toEqual([]);
    expect(w.traces()[0].f.kept).toBe('none');
  });

  it('a message other than the one the push named is not kept', async () => {
    const w = loadWorker();
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail('other') } }));
    await w.push(payload());
    expect(w.kept()).toEqual([]);
  });

  it('nothing is kept, and no ticket used, for an account signed out on purpose', async () => {
    const w = loadWorker();
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    w.marker('signed-out/acc1');
    await w.push(payload());
    expect(w.ticketRequests).toHaveLength(0);
    expect(w.kept()).toEqual([]);
  });

  it('a push without a ticket (another relay) works as before', async () => {
    const w = loadWorker();
    const { previewTicket: _t, sentAt: _s, ...classic } = payload();
    await w.push(classic);
    expect(w.onScreen()).toHaveLength(1);
    expect(w.ticketRequests).toHaveLength(0);
    const f = w.traces()[0].f;
    expect(f.lag).toBeUndefined();
    expect(f.kept).toBeUndefined();
  });
});

// Codex Astra review round 1 (audit/reviews/late-push-bulwark-r1.md).
describe('ordering, sign-out and fail-closed keeping (review round 1)', () => {
  /** A notification iOS showed by itself for `id`, its push sent at `sentAt`. */
  const shownByIos = (w: ReturnType<typeof loadWorker>, id: string, sentAt: number) => {
    w.showByBrowser({ notification: {
      title: `Sender ${id}`, body: `Subject ${id}`, navigate: `${ORIGIN}/mail/message/${id}#sent=${sentAt}`, tag: 'bulwark-mail:acc1', silent: false,
    } });
  };
  const emailIdsOnScreen = (w: ReturnType<typeof loadWorker>) => w.onScreen().map((n) => {
    const d = n.options.data as { emailId?: string } | undefined;
    return d?.emailId ?? /\/mail\/message\/([^#]+)/.exec(String(n.options.navigate))?.[1];
  });

  it('issue 1A: a late summary for an older message iOS showed keeps the newer one iOS showed after it', async () => {
    const w = loadWorker();
    shownByIos(w, 'e1', SENT_AT);
    shownByIos(w, 'e2', SENT_AT + 10_000);
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT, sentAt: SENT_AT + 36_000 }));
    expect(emailIdsOnScreen(w), 'e1 (older) is closed or never re-shown').not.toContain('e1_summary');
    const mine = w.onScreen().filter((n) => !n.byBrowser);
    expect(mine.every((n) => (n.options.data as { emailId: string }).emailId === 'e2'), 'only e2 is re-shown').toBe(true);
    expect(w.onScreen().some((n) => String(n.options.body).includes(summary)), 'the stale summary is not shown').toBe(false);
  });

  it('issue 1A: a summary for a message newer than the one on screen still replaces it', async () => {
    const w = loadWorker();
    shownByIos(w, 'e0', SENT_AT - 60_000);
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT }));
    expect(emailIdsOnScreen(w)).toEqual(['e1']);
  });

  it('issue 1B: a notification iOS shows while the worker replaces another is left alone', async () => {
    let injected = false;
    const w = loadWorker({
      onShow: () => {
        if (injected) return;
        injected = true;
        shownByIos(w, 'e2', SENT_AT + 30_000);
      },
    });
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    shownByIos(w, 'e1', SENT_AT);
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT }));
    expect(new Set(emailIdsOnScreen(w))).toEqual(new Set(['e1', 'e2']));
    expect(w.onScreen().find((n) => n.byBrowser)?.options.navigate).toContain('/mail/message/e2');
  });

  it('issue 2: a sign-out closes a young notification iOS showed once WebKit allows it', async () => {
    const w = loadWorker();
    shownByIos(w, 'e1', SENT_AT);
    w.marker('signed-out/acc1');
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 40_000);
    // Not settled while WebKit refuses the close (the page then drops the subscription); closed once it may.
    expect(port.postMessage).toHaveBeenCalledWith({ done: false });
    expect(w.onScreen()).toEqual([]);
  });

  it('issue 3: an unreadable sign-out state keeps nothing and uses no ticket', async () => {
    const w = loadWorker({ markerReadsThrow: true });
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    await w.push(payload());
    expect(w.onScreen()).toHaveLength(1);
    expect(w.onScreen()[0].title).toBe('New mail');
    expect(w.ticketRequests).toHaveLength(0);
    expect(w.kept()).toEqual([]);
  });

  it('issue 3: a session-backed whole message is not kept when the sign-out state is unreadable', async () => {
    const w = loadWorker({ markerReadsThrow: true });
    w.setPreview({ ok: true, status: 200, body: { email: { id: 'e1', from: [{ name: 'Examplepaja' }], subject: email.subject }, unreadTotal: 1, full: fullEmail() } });
    await w.push(payload());
    expect(w.kept()).toEqual([]);
  });

  it('a slow ticket read does not hold up the account\'s next push', async () => {
    const w = loadWorker();
    let release!: (r: Reply) => void;
    w.setTicket(() => new Promise<Reply>((r) => { release = r; }));
    const first = w.push(payload(), 0);
    await vi.advanceTimersByTimeAsync(100);
    const second = w.push(payload({ emailIds: ['e2'], previewTicket: undefined }), 0);
    await vi.advanceTimersByTimeAsync(100);
    // Shown while the first push's ticket read still waits.
    expect(w.all.map((n) => (n.options.data as { emailId: string }).emailId)).toEqual(['e1', 'e2']);
    release({ ok: true, status: 200, body: { email: fullEmail() } });
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.all([first, second]);
    expect(w.kept()).toEqual([expect.objectContaining({ email: fullEmail() })]);
  });
});

// Codex Astra review round 2 (audit/reviews/late-push-bulwark-r2.md).
describe('ordering, sign-out and detached keeps (review round 2)', () => {
  const shownByIos = (w: ReturnType<typeof loadWorker>, id: string, sentAt?: number) => {
    w.showByBrowser({ notification: {
      title: `Sender ${id}`, body: `Subject ${id}`, tag: 'bulwark-mail:acc1', silent: false,
      navigate: `${ORIGIN}/mail/message/${id}${sentAt ? `#sent=${sentAt}` : ''}`,
    } });
  };
  const ids = (w: ReturnType<typeof loadWorker>) => w.onScreen().map((n) => {
    const d = n.options.data as { emailId?: string } | undefined;
    return d?.emailId ?? /\/mail\/message\/([^#]+)/.exec(String(n.options.navigate))?.[1];
  });

  it('1A: a notification iOS shows after the push was decided on is never closed by it', async () => {
    let w!: ReturnType<typeof loadWorker>;
    let injected = false;
    w = loadWorker({
      onList: (count) => {
        if (count === 1 && !injected) {
          injected = true;
          shownByIos(w, 'e2', SENT_AT + 30_000);
        }
      },
    });
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    shownByIos(w, 'e1', SENT_AT);
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT }));
    expect(new Set(ids(w))).toEqual(new Set(['e1', 'e2']));
  });

  it('1B: the newest by send time counts, not the one listed last', async () => {
    const w = loadWorker();
    shownByIos(w, 'e2', SENT_AT + 10_000);
    shownByIos(w, 'e1', SENT_AT); // delivered late, listed after e2
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT }));
    expect(ids(w)).toEqual(['e2']);
    expect(w.onScreen().some((n) => String(n.options.body).includes(summary))).toBe(false);
  });

  it('1: another message whose push time is unknown is left up, not replaced', async () => {
    const w = loadWorker();
    shownByIos(w, 'e9');
    await vi.advanceTimersByTimeAsync(35_000);
    await w.push(payload({ email: { ...email, summary }, renotify: false, firstSentAt: SENT_AT }));
    expect(ids(w)).toContain('e9');
    expect(ids(w)).not.toContain('e1');
  });

  it('2: a sign-out whose page already dropped the subscription still closes a young notification later', async () => {
    const w = loadWorker({ noSubscription: true });
    shownByIos(w, 'e1', SENT_AT);
    w.marker('signed-out/acc1');
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 40_000);
    expect(port.postMessage).toHaveBeenCalledWith({ done: false });
    expect(w.onScreen()).toEqual([]);
  });

  it('2: a sign-out with nothing left up reports settled', async () => {
    const w = loadWorker();
    shownByIos(w, 'e1', SENT_AT);
    await vi.advanceTimersByTimeAsync(31_000); // old enough to close at once
    w.marker('signed-out/acc1');
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 0);
    expect(port.postMessage).toHaveBeenCalledWith({ done: true });
    expect(w.onScreen()).toEqual([]);
  });

  it('3: a ticket keep whose write lands after a sign-out does not stay kept', async () => {
    let releasePut!: () => void;
    const paused = new Promise<void>((r) => { releasePut = r; });
    const w = loadWorker({ beforePut: (key) => (key.includes('/__push-state/prefetched/') ? paused : undefined) });
    w.setTicket(() => ({ ok: true, status: 200, body: { email: fullEmail() } }));
    const pushed = w.push(payload(), 0);
    await vi.advanceTimersByTimeAsync(200); // the notification is up, the keep's write is held
    w.marker('signed-out/acc1');
    const port = { postMessage: vi.fn() };
    const signout = w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 0);
    await vi.advanceTimersByTimeAsync(100);
    releasePut();
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.all([pushed, signout]);
    expect(w.kept()).toEqual([]);
  });
});

// Codex Astra review round 3 (audit/reviews/late-push-bulwark-r3.md).
describe('ordering for worker notifications, failed listings, other accounts (review round 3)', () => {
  const ids = (w: ReturnType<typeof loadWorker>) => w.onScreen().map((n) => {
    const d = n.options.data as { emailId?: string } | undefined;
    return d?.emailId ?? /\/mail\/message\/([^#]+)/.exec(String(n.options.navigate))?.[1];
  });
  const iosNote = (w: ReturnType<typeof loadWorker>, id: string, sentAt: number, tag = 'bulwark-mail:acc1') => {
    w.showByBrowser({ notification: {
      title: `Sender ${id}`, body: `Subject ${id}`, tag, silent: false, navigate: `${ORIGIN}/mail/message/${id}#sent=${sentAt}`,
    } });
  };

  for (const webkit of [true, false]) {
    it(`1: a delayed push for older mail leaves the newer one the worker showed (${webkit ? 'WebKit' : 'tag-replacing browser'})`, async () => {
      const w = loadWorker({ webkit });
      await w.push(payload({ emailIds: ['e2'], sentAt: SENT_AT + 10_000, previewTicket: undefined }));
      await w.push(payload({ emailIds: ['e1'], sentAt: SENT_AT, previewTicket: undefined }));
      expect(ids(w)).toEqual(['e2']);
    });
  }

  it('1: the empty acknowledgement path never closes a notification iOS shows meanwhile', async () => {
    let w!: ReturnType<typeof loadWorker>;
    let injectAfter = 0;
    w = loadWorker({
      onList: (count) => {
        if (injectAfter && count === injectAfter) iosNote(w, 'e2', SENT_AT + 30_000);
      },
    });
    // The session lookup says there is no unread mail: nothing to announce, but WebKit must show something.
    w.setPreview({ ok: true, status: 200, body: { email: null, unreadTotal: 0 } });
    injectAfter = 2; // right after the acknowledgement's own listing
    await w.push(payload({ emailIds: [], previewTicket: undefined }));
    expect(ids(w)).toContain('e2');
  });

  it('2: a first listing that fails makes the sign-out unsettled, and the notification is closed later', async () => {
    const w = loadWorker({ noSubscription: true, listFails: (n) => n === 1 });
    iosNote(w, 'e1', SENT_AT);
    w.marker('signed-out/acc1');
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 40_000);
    expect(port.postMessage).toHaveBeenCalledWith({ done: false });
    expect(w.onScreen()).toEqual([]);
  });

  it('2: a verifying listing that fails is not reported as settled', async () => {
    const w = loadWorker({ listFails: (n) => n === 2 });
    iosNote(w, 'e1', SENT_AT);
    await vi.advanceTimersByTimeAsync(31_000);
    w.marker('signed-out/acc1');
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 40_000);
    expect(port.postMessage).toHaveBeenCalledWith({ done: false });
  });

  it('4: signing one account out never closes another account\'s identical notification', async () => {
    const w = loadWorker();
    iosNote(w, 'same', SENT_AT, 'bulwark-mail:acc1');
    iosNote(w, 'same', SENT_AT, 'bulwark-mail:acc2');
    w.marker('signed-out/acc1');
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['acc1'] }, ports: [port] }, 40_000);
    expect(w.onScreen().map((n) => n.options.tag)).toEqual(['bulwark-mail:acc2']);
  });

  it('3: the worker revision moved on from the earlier rounds', async () => {
    const { SW_REVISION } = await import('@/lib/sw-revision');
    expect(SW_REVISION).not.toBe('2026-10-19.push2');
    expect(SW_SOURCE).toContain(`const SW_REVISION = "${SW_REVISION}";`);
  });
});

// Codex Astra review round 4 (audit/reviews/late-push-bulwark-r4.md).
describe('unknown order, failed selection listings, a literal "default" account (review round 4)', () => {
  const ids = (w: ReturnType<typeof loadWorker>) => w.onScreen().map((n) => {
    const d = n.options.data as { emailId?: string } | undefined;
    return d?.emailId ?? /\/mail\/message\/([^#]+)/.exec(String(n.options.navigate))?.[1];
  });

  it('1: a worker notification without a send time is not replaced by a timestamped push (WebKit)', async () => {
    const w = loadWorker();
    const { sentAt: _s, ...old } = payload({ emailIds: ['e2'], previewTicket: undefined });
    await w.push(old);
    await w.push(payload({ emailIds: ['e1'], sentAt: SENT_AT, previewTicket: undefined }));
    expect(new Set(ids(w))).toEqual(new Set(['e1', 'e2']));
  });

  it('1: a push without a send time does not replace a timestamped notification (WebKit)', async () => {
    const w = loadWorker();
    await w.push(payload({ emailIds: ['e2'], sentAt: SENT_AT + 10_000, previewTicket: undefined }));
    const { sentAt: _s, ...old } = payload({ emailIds: ['e1'], previewTicket: undefined });
    await w.push(old);
    expect(new Set(ids(w))).toEqual(new Set(['e1', 'e2']));
  });

  it('1: the acknowledgement fallback keeps the push\'s send time, so a later older push leaves it', async () => {
    const w = loadWorker();
    // nothing to announce, but WebKit must show something: the fallback shows e2 itself
    w.setPreview({ ok: true, status: 200, body: { email: null, unreadTotal: 0 } });
    await w.push(payload({ emailIds: ['e2'], sentAt: SENT_AT + 10_000, previewTicket: undefined }));
    expect((w.onScreen()[0].options.data as { sentAt?: number }).sentAt).toBe(SENT_AT + 10_000);
    w.setPreview({ ok: false, status: 401 });
    await w.push(payload({ emailIds: ['e1'], sentAt: SENT_AT, previewTicket: undefined }));
    expect(ids(w)).toContain('e2');
  });

  it('1: a selection listing that fails replaces nothing on WebKit', async () => {
    let w!: ReturnType<typeof loadWorker>;
    w = loadWorker({ listFails: (n) => n >= 3 && n <= 4 });
    await w.push(payload({ emailIds: ['e2'], sentAt: SENT_AT + 10_000, previewTicket: undefined })); // listings 1-2
    await w.push(payload({ emailIds: ['e1'], sentAt: SENT_AT + 20_000, previewTicket: undefined })); // 3-4 fail
    expect(new Set(ids(w))).toEqual(new Set(['e1', 'e2']));
  });

  it('1: a selection listing that fails on a tag-replacing browser keeps upstream\'s one notification per account', async () => {
    // Review round 5 (late-push-bulwark-r5 issues 2-4): no separate fallback notification (it escaped the
    // sign-out cleanup); the browser replaces by tag itself, as upstream.
    const w = loadWorker({ webkit: false, listFails: (n) => n >= 3 && n <= 4 });
    await w.push(payload({ emailIds: ['e2'], sentAt: SENT_AT + 10_000, previewTicket: undefined }));
    await w.push(payload({ emailIds: ['e1'], sentAt: SENT_AT + 20_000, previewTicket: undefined }));
    expect(w.onScreen().map((n) => n.options.tag)).toEqual(['bulwark-mail:acc1']);
    expect(ids(w)).toEqual(['e1']);
    expect(w.all.some((n) => n.options.tag === 'bulwark-push-ack')).toBe(false);
  });

  it('2: delayed sign-out cleanup also works for an account literally named "default"', async () => {
    const w = loadWorker({ noSubscription: true });
    w.showByBrowser({ notification: {
      title: 'Sender', body: 'Subject', tag: 'bulwark-mail:default', silent: false, navigate: `${ORIGIN}/mail/message/x#sent=${SENT_AT}`,
    } });
    w.marker('signed-out/default');
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'push-signout', accountIds: ['default'] }, ports: [port] }, 100_000);
    expect(w.onScreen()).toEqual([]);
  });
});

