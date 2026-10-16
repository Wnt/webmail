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

function loadWorker(preview: PreviewResponse, { timers = false } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  // Notifications currently on screen, by tag (a new one with the same tag replaces the old).
  const active = new Map<string, Shown>();
  const cacheStore = new Map<string, string>();

  const unsubscribe = vi.fn(async () => true);
  let onShow: () => Promise<void> | void = () => {};
  const whenShown = (fn: () => Promise<void> | void) => { onShow = fn; };
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
        await onShow();
      },
      getNotifications: async (filter?: { tag?: string }) => {
        // A snapshot taken now, handed back once any hold is released.
        const snapshot = [...active.values()]
          .filter((n) => !filter?.tag || n.options.tag === filter.tag)
          .map((n) => ({
            title: n.title, body: n.options.body, tag: n.options.tag, data: n.options.data,
            close: () => { if (active.get(String(n.options.tag)) === n) active.delete(String(n.options.tag)); },
          }));
        await lookupHold;
        return snapshot;
      },
      pushManager: { getSubscription: async () => ({ unsubscribe }) },
    },
  };
  let unreadableMarkers = false;
  const breakMarkerReads = () => { unreadableMarkers = true; };
  let markerReadHold: Promise<void> | null = null;
  let markerReadsToPass = 0;
  let markerReadHeld: () => void = () => {};
  /** Hold account-marker reads after the first `pass` ones; resolves `held` when one is held. */
  const holdMarkerReads = (pass: number) => {
    let release!: () => void;
    markerReadsToPass = pass;
    markerReadHold = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<void>((resolve) => { markerReadHeld = resolve; });
    return { held, release: () => { markerReadHold = null; release(); } };
  };
  const caches = {
    open: async () => ({
      match: async (key: string) => {
        if (unreadableMarkers && key.includes('/signed-out')) throw new Error('storage broken');
        if (markerReadHold && key.includes('/signed-out/')) {
          if (markerReadsToPass > 0) markerReadsToPass--;
          else { markerReadHeld(); await markerReadHold; }
        }
        const value = cacheStore.get(key);
        return value === undefined ? undefined : { json: async () => JSON.parse(value) };
      },
      put: async (key: string, res: { text: () => Promise<string> }) => {
        cacheStore.set(key, await res.text());
      },
    }),
  };
  const fetchMock = vi.fn(async (_url?: unknown, _init?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    if (preview === 'throw') throw new TypeError('network down');
    return { ok: preview.ok, status: preview.status ?? 200, json: async () => preview.body };
  });

  const context = vm.createContext({
    self, caches, fetch: fetchMock, URL, URLSearchParams, Response, Date, console,
    ...(timers ? { setTimeout, clearTimeout, AbortController } : {}),
  });
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
  /** The page's explicit sign-out asking the worker to settle; resolves with its answer. */
  function signOut(accountIds: string[], everyAccount = false, persisted = true): Promise<unknown> {
    return new Promise((resolve) => {
      const waits: Promise<unknown>[] = [];
      listeners.get('message')?.({
        data: { type: 'push-signout', accountIds, everyAccount, persisted },
        ports: [{ postMessage: (msg: unknown) => resolve(msg) }],
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      });
    });
  }
  const marker = (path: string) => cacheStore.set(`https://mail.example.com/__push-state/${path}`, '{"at":1}');
  return { push, startPush, shown, active, fetchMock, context, marker, unsubscribe, holdNotificationLookups, whenShown, signOut, holdMarkerReads, breakMarkerReads };
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
  it('a push already being handled shows nothing once the user signs out', async () => {
    const { startPush, shown, active, marker, fetchMock } = loadWorker({ ok: false, status: 401 });
    let release!: () => void;
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: false, status: 401, json: async () => ({}) };
    });
    const pending = startPush(payload({ email: { from: 'Doctor', subject: 'Private', preview: 'Confidential' } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    marker('signed-out/acc1');
    release();
    await pending;
    expect(shown).toHaveLength(0);
    expect(active.size).toBe(0);
  });
  it('a notification shown while the sign-out lands closes itself', async () => {
    const { push, active, marker, whenShown } = loadWorker({ ok: false, status: 401 });
    // The page writes its marker (and closes what it saw) while this show is under way.
    whenShown(() => { marker('signed-out/acc1'); });
    await push(payload({ email: { from: 'Doctor', subject: 'Private', preview: 'Confidential' } }));
    expect(active.size).toBe(0);
  });
  it('a summary replacement racing the sign-out leaves nothing on screen', async () => {
    const { push, startPush, active, marker, holdNotificationLookups } = loadWorker({ ok: false, status: 401 });
    await push(payload({ email: summary }));
    const release = holdNotificationLookups();
    const late = startPush(payload({ email: { ...summary, summary: 'A summary' }, renotify: false }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    marker('signed-out/acc1');
    active.clear(); // the page closed the account's notifications
    release();
    await late;
    expect(active.size).toBe(0);
  });
  it('the sign-out is answered only after a display already under way has finished and been closed', async () => {
    const { startPush, active, marker, whenShown, signOut } = loadWorker({ ok: false, status: 401 }, { timers: true });
    let releaseShow!: () => void;
    let showing!: () => void;
    const showStarted = new Promise<void>((resolve) => { showing = resolve; });
    whenShown(() => { showing(); return new Promise<void>((resolve) => { releaseShow = resolve; }); });
    const pending = startPush(payload({ email: { from: 'Doctor', subject: 'Private', preview: 'Confidential' } }));
    await showStarted;
    marker('signed-out/acc1');
    let answered = false;
    const answer = signOut(['acc1']).then((msg) => { answered = true; return msg; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    releaseShow();
    expect(await answer).toEqual({ done: true });
    await pending;
    expect(active.size).toBe(0);
  });
  it('a sign-out arriving while a handler reads the marker stops that display outright', async () => {
    const { startPush, shown, signOut, holdMarkerReads } = loadWorker({ ok: false, status: 401 }, { timers: true });
    // The first read is the handler's check on arrival; the second, its check right before showing.
    const { held, release } = holdMarkerReads(1);
    const pending = startPush(payload({ email: { from: 'Doctor', subject: 'Private', preview: 'Confidential' } }));
    await held;
    const answer = signOut(['acc1']);
    release();
    await answer;
    await pending;
    expect(shown).toHaveLength(0);
  });
  it('a display the browser has not completed by the deadline is reported as not settled, then closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { startPush, active, marker, whenShown, signOut } = loadWorker({ ok: false, status: 401 }, { timers: true });
      let releaseShow!: () => void;
      let showing!: () => void;
      const showStarted = new Promise<void>((resolve) => { showing = resolve; });
      whenShown(() => { showing(); return new Promise<void>((resolve) => { releaseShow = resolve; }); });
      const pending = startPush(payload({ email: { from: 'Doctor', subject: 'Private', preview: 'Confidential' } }));
      await showStarted;
      marker('signed-out/acc1');
      const answer = signOut(['acc1']);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await answer).toEqual({ done: false });
      releaseShow();
      await pending;
      await vi.advanceTimersByTimeAsync(1);
      expect(active.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('when the page could not store the markers, the worker keeps suppressing the account', async () => {
    const { push, shown, signOut } = loadWorker({ ok: false, status: 401 }, { timers: true });
    // No marker in Cache Storage: the page reported persisted: false.
    expect(await signOut(['acc1'], false, false)).toEqual({ done: true });
    await push(payload({ email: { from: 'Doctor', subject: 'Private', preview: 'Confidential' } }));
    expect(shown).toHaveLength(0);
    await push(payload({ accountId: 'acc2', changed: { acc2: {} }, emailIds: ['x1'], email: summary }));
    expect(shown.map((n) => n.options.tag)).toEqual(['bulwark-mail:acc2']);
  });
  it('an unreadable sign-out state shows nothing private', async () => {
    const { push, shown, breakMarkerReads } = loadWorker({ ok: false, status: 401 }, { timers: true });
    breakMarkerReads();
    await push(payload({ email: { from: 'Doctor', subject: 'Private result', preview: 'Confidential detail' } }));
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('New mail');
    expect(JSON.stringify(shown[0].options)).not.toMatch(/Doctor|Private|Confidential/);
  });
  it('the sign-out cuts a pending preview lookup short instead of waiting for it', async () => {
    const { startPush, shown, marker, signOut, fetchMock } = loadWorker({ ok: false, status: 401 }, { timers: true });
    fetchMock.mockImplementationOnce(async (_url?: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }) as never);
    const pending = startPush(payload({ email: { from: 'Doctor', subject: 'Private', preview: 'Confidential' } }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    marker('signed-out/acc1');
    const started = Date.now();
    expect(await signOut(['acc1'])).toEqual({ done: true });
    expect(Date.now() - started).toBeLessThan(2000);
    await pending;
    expect(shown).toHaveLength(0);
  });
  it('a preview whose body stalls times out and the next push for the account goes ahead', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { startPush, shown, fetchMock } = loadWorker({ ok: false, status: 401 }, { timers: true });
      fetchMock.mockImplementationOnce(async (_url?: unknown, init?: { signal?: AbortSignal }) => ({
        ok: true, status: 200,
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      }) as never);
      const first = startPush(payload({ email: { from: 'A', subject: 'First', preview: 'one' } }));
      const second = startPush(payload({ emailIds: ['e2'], email: { from: 'B', subject: 'Second', preview: 'two' } }));
      await vi.advanceTimersByTimeAsync(10_001);
      await Promise.all([first, second]);
      expect(shown.map((n) => n.options.body)).toEqual(['First\none', 'Second\ntwo']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('attacker URLs in IDs remain same-origin click paths', () => {
    const { context } = loadWorker({ ok: false });
    const build = vm.runInContext('buildClickUrl', context);
    for (const id of ['https://evil.invalid', '//evil.invalid', 'javascript:alert(1)', '../x?y#z']) {
      expect(new URL(build({ kind: 'email', emailId: id }), 'https://mail.example.com').origin).toBe('https://mail.example.com');
    }
  });
});
