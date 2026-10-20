// Fork (Wnt/webmail): one cache for the images the public branding routes
// render on request (/api/pwa-icon, /api/pwa-screenshot, /api/og-image).
//
// Each route used to cache only finished renders in a Map that never
// expired: overlapping first requests each fetched, decoded and encoded the
// same source; a failing source was re-rendered on every request; and a
// branding image replaced under the same URL was served stale until restart
// (review of perf/pwa-start, R1/R3). Here:
//  - a render in flight is shared by every request for the same key;
//  - at most MAX_RENDERS run at once, at most MAX_WAITING wait; more get an
//    overload error (the route answers 503);
//  - a failed render is not retried for FAILURE_BACKOFF_MS;
//  - a render is kept TTL_MS at most, MAX_ENTRIES entries in all, and the key
//    carries the source's revision (a local file's size and modification
//    time), so a re-upload under the same URL renders again at once;
//  - sources are read with a byte cap (lib/admin/branding-asset.ts) and decoded
//    with a pixel cap (SOURCE_PIXEL_LIMIT).

import { stat } from 'node:fs/promises';
import { localBrandingPath } from '@/lib/admin/branding-asset';

export const TTL_MS = 60 * 60 * 1000;
export const FAILURE_BACKOFF_MS = 30 * 1000;
export const MAX_ENTRIES = 64;
export const MAX_RENDERS = 2;
export const MAX_WAITING = 16;
/** sharp's limitInputPixels for branding sources (sharp's own default is ~268 Mpx). */
export const SOURCE_PIXEL_LIMIT = 40_000_000;

export class ImageOverloadError extends Error {
  constructor() { super('Too many image renders at once'); }
}
export class ImageRenderBackoffError extends Error {
  constructor() { super('The image failed to render a moment ago'); }
}

type Entry = { blob: Blob; at: number } | { failedAt: number };

const done = new Map<string, Entry>();
const inflight = new Map<string, Promise<Blob>>();
let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < MAX_RENDERS) { running++; return; }
  if (waiting.length >= MAX_WAITING) throw new ImageOverloadError();
  // The permit is handed over by release(), already counted in `running`.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // the permit passes straight to the next waiter: no gap for a newcomer
  else running--;
}

function remember(key: string, entry: Entry): void {
  done.delete(key);
  done.set(key, entry);
  while (done.size > MAX_ENTRIES) done.delete(done.keys().next().value as string);
}

/**
 * The image for `key`: the kept render (TTL_MS at most), the render in flight,
 * or a new `render()`. Throws ImageOverloadError when too many renders wait,
 * ImageRenderBackoffError within FAILURE_BACKOFF_MS of a failed one, or the
 * render's own error.
 */
export function cachedImage(key: string, render: () => Promise<Blob>, now: () => number = Date.now): Promise<Blob> {
  const entry = done.get(key);
  if (entry && 'blob' in entry && now() - entry.at < TTL_MS) return Promise.resolve(entry.blob);
  if (entry && 'failedAt' in entry && now() - entry.failedAt < FAILURE_BACKOFF_MS) {
    return Promise.reject(new ImageRenderBackoffError());
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = (async () => {
    await acquire();
    try {
      const blob = await render();
      remember(key, { blob, at: now() });
      return blob;
    } catch (err) {
      remember(key, { failedAt: now() });
      throw err;
    } finally {
      release();
    }
  })();
  const shared = work.finally(() => { if (inflight.get(key) === shared) inflight.delete(key); });
  inflight.set(key, shared);
  return shared;
}

/**
 * A revision of the branding source behind `url` for cache keys: size and
 * modification time of a local file (public/ or an admin upload), '' for a
 * remote URL (TTL_MS bounds those) or a file that cannot be read.
 */
export async function brandingSourceRevision(url: string): Promise<string> {
  if (url.startsWith('http://') || url.startsWith('https://')) return '';
  const file = localBrandingPath(url);
  if (!file) return '';
  try {
    const s = await stat(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '';
  }
}

/** The status a route answers for a failed cachedImage. */
export function imageErrorStatus(err: unknown): number {
  return err instanceof ImageOverloadError ? 503 : 500;
}

/** Tests only. */
export function __resetGeneratedImageCache(): void {
  done.clear();
  inflight.clear();
  running = 0;
  waiting.length = 0;
}
