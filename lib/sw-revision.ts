// Fork (Wnt/webmail): the service worker revision this build ships.
//
// public/sw.js carries the same string (SW_REVISION; lib/__tests__/sw-revision
// keeps the two equal). An iPhone can keep running an older worker long after
// a deploy, and the worker decides how a notification tap reaches the app, so
// the app asks the worker in charge for its revision, reports it in the tap
// diagnostics (lib/tap-trace.ts) and asks the browser for the new worker when
// it is not this one.

export const SW_REVISION = '2026-10-19.push4';

export type WorkerRevisionState = 'same' | 'old' | 'none';

/** The revision of the worker controlling this page: null when none answers (no worker, or one too old to know the question). */
export async function controllerRevision(timeoutMs = 1000): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker || typeof MessageChannel !== 'function') return null;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.onmessage = null; resolve(null); }, timeoutMs);
    channel.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      const revision = (e.data as { revision?: unknown } | null)?.revision;
      resolve(typeof revision === 'string' ? revision : null);
    };
    try {
      controller.postMessage({ type: 'sw-revision' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Which worker is in charge, compared with this build's; asks the browser to
 * look for a newer worker when it is not the current one. Never throws.
 */
export async function checkWorkerRevision(): Promise<WorkerRevisionState> {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return 'none';
    const revision = await controllerRevision();
    if (revision === SW_REVISION) return 'same';
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      void registration?.update().catch(() => {});
    } catch {
      // The next navigation checks again.
    }
    return 'old';
  } catch {
    return 'none';
  }
}
