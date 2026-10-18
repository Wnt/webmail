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

export type OpenSource = 'list' | 'tap' | 'link';

/** Stages, in the order they normally happen. `data`: the message is in memory; `painted`: its body is on screen. */
export type OpenStage = 'msg' | 'ttfb' | 'dcl' | 'session' | 'data' | 'painted';

interface OpenRun {
  emailId: string;
  source: OpenSource;
  /** performance.now() of the start (may be negative: a tap before this page existed). */
  t0: number;
  unread: boolean | null;
  stages: Partial<Record<OpenStage, number>>;
  done: boolean;
}

export const OPEN_BODY_PAINTED_EVENT = 'mm-open-body-painted';
const BEACON_URL = `${(process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '')}/api/perf/open`;
/** An open that has not painted after this long is dropped (the user moved on, or the body never rendered). */
const MAX_OPEN_MS = 60_000;

let current: OpenRun | null = null;
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
  const t0 = opts.t0 ?? now();
  current = { emailId, source, t0, unread: opts.unread ?? null, stages: {}, done: false };
  lastPaintedId = null;
  mark(`mm:open:start:${source}`, t0);
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
  setTimeout(() => sendBeacon(run), 1000);
}

function sendBeacon(run: OpenRun) {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return;
  const body = JSON.stringify({
    v: 1,
    src: run.source,
    ...deviceClass(),
    unread: run.unread,
    st: run.stages,
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
  lastPaintedId = null;
  listeners.clear();
}
