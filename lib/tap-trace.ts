// Fork (Wnt/webmail): the tap diagnostics, the app's half.
//
// Real Web Push cannot reach a simulator, so a tap on the owner's iPhone has
// to say itself where its chain broke. Each link is one small record: a stage
// name and yes/no facts, never an id, address, subject or content.
//   worker (public/sw.js):  push (received, with or without a target, shown,
//                           with a `navigate` URL), click (notificationclick
//                           and what it did), close (dismissed)
//   app (here):             start (the document's start: did its URL name a
//                           message, which worker runs), session (restored or
//                           a sign-in was needed), found (how the app learned
//                           of the tap), open (the message opened, or why not)
// Records wait in the push-state cache (keys shared with the worker) and go to
// /api/perf/tap once the app is signed in; tools/perf-beacon --taps in the ops
// repo prints them as a timeline.

import { deviceClass } from '@/lib/open-timing';
import { tapFallbackApplies } from '@/lib/notification-open';

const PUSH_STATE_CACHE = 'bulwark-push-state-v1';
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const TRACE_KEEP = 60;
const BATCH = 30;

export type TapTraceEvent = 'start' | 'session' | 'found' | 'open';
export type TapFacts = Record<string, boolean | number | string>;

function prefix(): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/tap-trace/`;
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
  } catch {
    // Fall back below.
  }
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
}

// Records wait in memory first and reach the cache a few seconds later (or
// when the page is hidden): at a start the cache also holds the push
// worker's kept copy of the tapped message, which the start reads against a
// short deadline (stores/auth-store.ts KEPT_COPY_WAIT_MS), so the
// diagnostics must not compete with it.
const PERSIST_DELAY_MS = 2500;
const queue: Record<string, unknown>[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let hideHooked = false;

function hookPageHide(): void {
  if (hideHooked || typeof document === 'undefined') return;
  hideHooked = true;
  const persistNow = () => { if (document.visibilityState === 'hidden') void persistQueue(); };
  document.addEventListener('visibilitychange', persistNow);
  window.addEventListener('pagehide', () => { void persistQueue(); });
}

/** Writes the waiting records into the cache (the worker's keys), oldest beyond TRACE_KEEP out. */
async function persistQueue(): Promise<void> {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  const records = queue.splice(0);
  if (records.length === 0 || typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    for (const record of records) {
      await cache.put(`${prefix()}${record.at}-${record.id}`, new Response(JSON.stringify(record), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    const kept = (await cache.keys()).filter((r) => r.url.startsWith(prefix()));
    for (const r of kept.slice(0, Math.max(0, kept.length - TRACE_KEEP))) await cache.delete(r);
  } catch {
    // Diagnostics only.
  }
}

/** Records one link of the app's side of a tap. Never throws. */
export function traceTap(ev: TapTraceEvent, facts: TapFacts): void {
  if (typeof window === 'undefined' || typeof caches === 'undefined') return;
  const build = (process.env.NEXT_PUBLIC_GIT_COMMIT ?? '').slice(0, 8);
  queue.push({ id: randomId(), src: 'page', ev, at: Date.now(), ...(build ? { build } : {}), ...deviceClass(), f: facts });
  hookPageHide();
  if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; void flushTapTrace(); }, PERSIST_DELAY_MS);
}

let flushing: Promise<void> | null = null;

/**
 * Sends the waiting records (the worker's too) while signed in. Records the
 * server took, or refused for good, are dropped; a 401 or a network error
 * keeps them for the next try.
 */
export function flushTapTrace(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    if (typeof window === 'undefined' || typeof caches === 'undefined' || typeof fetch !== 'function') return;
    try {
      await persistQueue();
      const cache = await caches.open(PUSH_STATE_CACHE);
      for (let round = 0; round < 3; round++) {
        const keys = (await cache.keys()).filter((r) => r.url.startsWith(prefix())).slice(0, BATCH);
        if (keys.length === 0) return;
        const events: unknown[] = [];
        for (const r of keys) {
          try {
            const res = await cache.match(r);
            if (res) events.push(await res.json());
          } catch {
            // Unreadable: dropped with the batch.
          }
        }
        const res = await fetch(`${BASE_PATH}/api/perf/tap`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: 1, events }),
        });
        if (!(res.ok || res.status === 400 || res.status === 413)) return;
        for (const r of keys) await cache.delete(r);
      }
    } catch {
      // Offline: next time.
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Sends the records a little later, after what the user is waiting for. */
export function scheduleTapTraceFlush(delayMs = 3000): void {
  if (typeof window === 'undefined') return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushTimer = null; void flushTapTrace(); }, delayMs);
}

/** How this document was loaded (Navigation Timing), as a fixed word. */
export function navigationKind(): 'navigate' | 'reload' | 'back_forward' | 'prerender' | 'other' {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    const type = nav?.type;
    return type === 'navigate' || type === 'reload' || type === 'back_forward' || type === 'prerender' ? type : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Only devices that can get a push notification trace their starts: notifications
 * allowed, or the iPhone/iPad Home Screen app, whose page can read the permission
 * as "default" after WebKit restarted it (iOS Simulator, 2026-10-19).
 */
export function tapTraceApplies(): boolean {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') return true;
  } catch {
    // Fall through.
  }
  return tapFallbackApplies();
}

/** Tests only. */
export function __resetTapTrace(): void {
  flushing = null;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  queue.length = 0;
}
