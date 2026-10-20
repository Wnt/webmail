// Fork (Wnt/webmail): how long opening a message took, stage by stage, on the
// user's own device.
//
// One open is tracked at a time: it starts at the click (a list row), the
// notification tap (the service worker's click time) or the page start (a
// document opened at a message link), and ends when the body has been
// painted - the frame after the reading pane's body was ready. The stages are
// also User Timing marks (`mm:open:*`), so a trace or a harness can read them.
//
// When the open ends, one small beacon goes to /api/perf/open: the stage
// names with their times in ms, where the open came from, and a coarse device
// class. Never a message id, address, subject or any content. The id passed
// in here only matches the stages of one open to each other, in memory.
//
// A sideways swipe on the phone (hooks/use-message-swipe.ts) notes its
// gesture just before it opens the neighbour (noteSwipeCommit); the open
// that follows at once is then a `swipe` open timed from the finger's
// release when the page saw it (a touch that started outside the body
// frame: WebKit runs no listener inside it), else from the track settling.

export type OpenSource = 'list' | 'tap' | 'link' | 'swipe';

/**
 * What the swipe's neighbour pane showed when the swipe was released:
 * `full` the neighbour's own rendered body (its message was in memory),
 * `lite` its sender, subject and first lines, `none` nothing of it yet.
 */
export type SwipePreload = 'full' | 'lite' | 'none';

/**
 * Stages, in the order they normally happen. `data`: the message is in memory; `painted`: its body is on screen.
 * A page opened at a message link (`link`) also carries its start: `ttfb` / `html` the document's first and last
 * byte, `fcp` the first frame the page drew (Paint Timing), `dcl` DOMContentLoaded, `boot` the app's own code
 * started, `hyd` the server's markup hydrated, `session` signed in; `sw` when a service worker took part in
 * loading the document (its workerStart, absent when none did).
 */
/**
 * A swipe (`swipe`, from the release): `snap` the track settled, `data` / `painted` as above, `done` the new
 * message at rest on screen (no animation left).
 */
export type OpenStage = 'msg' | 'ttfb' | 'html' | 'fcp' | 'dcl' | 'boot' | 'hyd' | 'sw' | 'session' | 'snap' | 'data' | 'painted' | 'done';

/** User Timing marks of the page start (lib/start-marks.ts). */
export const START_MARK_BOOT = 'mm:start:boot';
export const START_MARK_HYDRATED = 'mm:start:hydrated';

interface OpenRun {
  emailId: string;
  source: OpenSource;
  /** performance.now() of the start (may be negative: a tap before this page existed). */
  t0: number;
  unread: boolean | null;
  stages: Partial<Record<OpenStage, number>>;
  done: boolean;
  /** The beacon left: nothing more is recorded. */
  sent?: boolean;
  pre?: SwipePreload;
}

interface SwipeNote {
  /** performance.now() of the finger's release, when the page saw it. */
  release?: number;
  /** performance.now() when the track settled on the neighbour. */
  snap: number;
  pre: SwipePreload;
  at: number;
}

export const OPEN_BODY_PAINTED_EVENT = 'mm-open-body-painted';
const BEACON_URL = `${(process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '')}/api/perf/open`;
/** An open that has not painted after this long is dropped (the user moved on, or the body never rendered). */
const MAX_OPEN_MS = 60_000;

let current: OpenRun | null = null;
let swipeNote: SwipeNote | null = null;
/** A swipe note counts for an open that begins this soon after it. */
const SWIPE_NOTE_MS = 100;
const listeners = new Set<(emailId: string) => void>();
let lastPaintedId: string | null = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function mark(name: string, at?: number) {
  try {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
    performance.mark(name, at !== undefined && at >= 0 ? { startTime: at } : undefined);
  } catch {
    // User Timing is a nicety.
  }
}

/**
 * Starts timing the open of `emailId`. `t0` is the start in performance.now()
 * time (default: now). A later open replaces an unfinished one.
 */
export function beginOpen(emailId: string, source: OpenSource, opts: { t0?: number; unread?: boolean | null } = {}): void {
  const note = swipeNote;
  swipeNote = null;
  if (note && source === 'list' && now() - note.at <= SWIPE_NOTE_MS) {
    // The open a swipe set off: timed from its release (or its settling).
    const t0 = note.release !== undefined && note.release <= note.snap ? note.release : note.snap;
    current = { emailId, source: 'swipe', t0, unread: opts.unread ?? null, stages: {}, done: false, pre: note.pre };
    lastPaintedId = null;
    mark('mm:open:start:swipe', t0);
    if (t0 !== note.snap) markOpen(emailId, 'snap', note.snap);
    return;
  }
  const t0 = opts.t0 ?? now();
  current = { emailId, source, t0, unread: opts.unread ?? null, stages: {}, done: false };
  lastPaintedId = null;
  mark(`mm:open:start:${source}`, t0);
}

/**
 * A swipe is about to open its neighbour (hooks/use-message-swipe.ts): the
 * open that begins right after is timed as a `swipe` from `release` (or
 * `snap`). Times are performance.now() values.
 */
export function noteSwipeCommit(note: { release?: number; snap: number; pre: SwipePreload }): void {
  swipeNote = { ...note, at: now() };
}

/**
 * The swiped-to message is at rest on screen (stage `done`; a swipe open
 * only). Counts after the paint, until the beacon leaves.
 */
export function markSwipeDone(emailId: string, at: number = now()): void {
  const run = current;
  if (!run || run.sent || run.source !== 'swipe' || run.emailId !== emailId || run.stages.done !== undefined) return;
  if (at - run.t0 > MAX_OPEN_MS) return;
  run.stages.done = Math.max(0, Math.round(at - run.t0));
  mark('mm:open:done', at);
}

/** Records a stage of the open of `emailId`, if that is the open being timed. */
export function markOpen(emailId: string, stage: OpenStage, at: number = now()): void {
  const run = current;
  if (!run || run.done || run.emailId !== emailId || run.stages[stage] !== undefined) return;
  if (at - run.t0 > MAX_OPEN_MS) { current = null; return; }
  run.stages[stage] = Math.max(0, Math.round(at - run.t0));
  mark(`mm:open:${stage}`, at);
}

/** The open being timed is for `emailId` and has not painted yet. */
export function isOpening(emailId: string): boolean {
  return !!current && !current.done && current.emailId === emailId;
}

/**
 * The reading pane has the body of `emailId` ready: the next frame shows it.
 * Ends the open (stage `painted`), tells the listeners, and sends the beacon.
 */
export function bodyReady(emailId: string): void {
  const finish = () => {
    lastPaintedId = emailId;
    const run = current;
    if (run && !run.done && run.emailId === emailId) {
      markOpen(emailId, 'painted');
      run.done = true;
      scheduleBeacon(run);
    }
    for (const fn of listeners) {
      try { fn(emailId); } catch { /* a listener's problem */ }
    }
    try {
      window.dispatchEvent(new CustomEvent(OPEN_BODY_PAINTED_EVENT));
    } catch {
      // No window (tests).
    }
  };
  // The frame after this one is the first to show the body: a rAF runs just
  // before the frame is produced, and a task queued from it runs after.
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    requestAnimationFrame(() => setTimeout(finish, 0));
  } else {
    setTimeout(finish, 0);
  }
}

/** Whether the body of `emailId` is the last one painted. */
export function bodyPainted(emailId: string): boolean {
  return lastPaintedId === emailId;
}

/**
 * Calls `fn` once the body of `emailId` is on screen, or after `timeoutMs` at
 * the latest. Returns a cancel function.
 */
export function afterBodyPainted(emailId: string, fn: () => void, timeoutMs: number): () => void {
  let done = false;
  const run = () => { if (done) return; done = true; cleanup(); fn(); };
  const onPainted = (id: string) => { if (id === emailId) run(); };
  const timer = setTimeout(run, timeoutMs);
  const cleanup = () => { clearTimeout(timer); listeners.delete(onPainted); };
  if (bodyPainted(emailId)) { setTimeout(run, 0); } else listeners.add(onPainted);
  return () => { done = true; cleanup(); };
}

/** Coarse device class: never the user agent itself. */
export function deviceClass(): { dev: 'phone' | 'tablet' | 'desktop'; pwa: boolean; eng: 'webkit' | 'blink' | 'gecko' | 'other' } {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return { dev: 'desktop', pwa: false, eng: 'other' };
  const ua = navigator.userAgent || '';
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const short = Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0);
  const dev = coarse ? (short && short < 600 ? 'phone' : 'tablet') : 'desktop';
  const pwa = (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const eng = /Firefox\//.test(ua) ? 'gecko' : /Chrome\/|Chromium\/|Edg\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua) ? 'blink' : /AppleWebKit\//.test(ua) ? 'webkit' : 'other';
  return { dev, pwa, eng };
}

function scheduleBeacon(run: OpenRun) {
  // Sent a second later, so it never competes with the open it measures.
  setTimeout(() => { run.sent = true; sendBeacon(run); }, 1000);
}

/** The page's own start stages (ms from its navigation start), for an open timed from the page start. */
export function pageStartStages(): Partial<Record<OpenStage, number>> {
  const out: Partial<Record<OpenStage, number>> = {};
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return out;
  const at = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const put = (stage: OpenStage, v: number | undefined) => { const ms = at(v); if (ms !== undefined) out[stage] = ms; };
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      put('ttfb', nav.responseStart);
      put('html', nav.responseEnd);
      put('dcl', nav.domContentLoadedEventEnd);
      put('sw', nav.workerStart);
    }
    put('fcp', performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime);
    put('boot', performance.getEntriesByName(START_MARK_BOOT)[0]?.startTime);
    put('hyd', performance.getEntriesByName(START_MARK_HYDRATED)[0]?.startTime);
  } catch {
    // Timing entries are a nicety.
  }
  return out;
}

function sendBeacon(run: OpenRun) {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return;
  // A page opened at the message link: its start stages (only now: the first paint and
  // DOMContentLoaded can come after the session).
  if (run.source === 'link' && run.t0 === 0) {
    for (const [stage, ms] of Object.entries(pageStartStages()) as [OpenStage, number][]) {
      if (run.stages[stage] === undefined) run.stages[stage] = ms;
    }
  }
  const body = JSON.stringify({
    v: 1,
    src: run.source,
    ...deviceClass(),
    unread: run.unread,
    st: run.stages,
    ...(run.source === 'swipe' && run.pre ? { pre: run.pre } : {}),
    build: (process.env.NEXT_PUBLIC_GIT_COMMIT ?? '').slice(0, 8) || undefined,
  });
  try {
    if (typeof navigator.sendBeacon === 'function'
      && navigator.sendBeacon(BEACON_URL, new Blob([body], { type: 'application/json' }))) return;
  } catch {
    // Fall back to fetch below.
  }
  void fetch(BEACON_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true }).catch(() => {});
}

/** Tests only. */
export function __resetOpenTiming(): void {
  current = null;
  swipeNote = null;
  lastPaintedId = null;
  listeners.clear();
}
