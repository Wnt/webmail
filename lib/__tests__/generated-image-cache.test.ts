import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedImage, __resetGeneratedImageCache, ImageOverloadError, ImageRenderBackoffError,
  TTL_MS, FAILURE_BACKOFF_MS, MAX_ENTRIES, MAX_RENDERS, MAX_WAITING, imageErrorStatus, brandingSourceRevision,
} from '../admin/generated-image-cache';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Fork (Wnt/webmail): the public branding image routes (/api/pwa-icon,
// /api/pwa-screenshot, /api/og-image) render on request. Review of
// perf/pwa-start (R1/R3): overlapping first requests each rendered the same
// source, a failing source was rendered again on every request, and a render
// was kept forever (a re-upload under the same URL stayed stale).

const blob = (s: string) => new Blob([s], { type: 'image/png' });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetGeneratedImageCache());

describe('generated image cache', () => {
  it('overlapping requests for one key share one render', async () => {
    let release!: () => void;
    const render = vi.fn(() => new Promise<Blob>((r) => { release = () => r(blob('a')); }));
    const all = Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => cachedImage('k', render)));
    await tick();
    release();
    const out = await all;
    expect(render).toHaveBeenCalledTimes(1);
    expect(new Set(out).size).toBe(1);
  });

  it(`runs at most ${MAX_RENDERS} renders at once, queues ${MAX_WAITING}, refuses more`, async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const render = () => new Promise<Blob>((r) => { active++; peak = Math.max(peak, active); releases.push(() => { active--; r(blob('x')); }); });
    const n = MAX_RENDERS + MAX_WAITING;
    const ok = Array.from({ length: n }, (_, i) => cachedImage(`k${i}`, render));
    await expect(cachedImage('one-too-many', render)).rejects.toBeInstanceOf(ImageOverloadError);
    expect(imageErrorStatus(new ImageOverloadError())).toBe(503);
    while (releases.length || active) { await tick(); releases.shift()?.(); }
    await Promise.all(ok);
    expect(peak).toBe(MAX_RENDERS);
  });

  it('a freed permit goes to the waiting render, not to a newcomer (review r4 N5)', async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const render = () => new Promise<Blob>((resolve) => {
      active++;
      peak = Math.max(peak, active);
      releases.push(() => { active--; resolve(blob('ok')); });
    });
    const a = cachedImage('a', render);
    const b = cachedImage('b', render);
    const c = cachedImage('c', render);
    await tick();
    let d!: Promise<Blob>;
    releases.shift()!();
    // Another request arrives just as the slot is freed.
    queueMicrotask(() => { d = cachedImage('d', render); });
    await tick();
    const observed = { active, peak };
    while (active || releases.length) { releases.shift()?.(); await tick(); }
    await Promise.all([a, b, c, d]);
    expect(observed).toEqual({ active: MAX_RENDERS, peak: MAX_RENDERS });
  });

  it('a failed render is not retried within the back-off, then is', async () => {
    let t = 1_000_000;
    const now = () => t;
    const render = vi.fn(async () => { throw new Error('broken source'); });
    await expect(cachedImage('k', render, now)).rejects.toThrow('broken source');
    await expect(cachedImage('k', render, now)).rejects.toBeInstanceOf(ImageRenderBackoffError);
    expect(render).toHaveBeenCalledTimes(1);
    t += FAILURE_BACKOFF_MS;
    await expect(cachedImage('k', render, now)).rejects.toThrow('broken source');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('a render expires after the TTL; the cache keeps a bounded number of entries', async () => {
    let t = 1_000_000;
    const now = () => t;
    const render = vi.fn(async () => blob('v'));
    await cachedImage('k', render, now);
    await cachedImage('k', render, now);
    expect(render).toHaveBeenCalledTimes(1);
    t += TTL_MS;
    await cachedImage('k', render, now);
    expect(render).toHaveBeenCalledTimes(2);
    for (let i = 0; i < MAX_ENTRIES + 5; i++) await cachedImage(`fill${i}`, render, now);
    const before = render.mock.calls.length;
    await cachedImage('k', render, now); // pushed out by the newer entries
    expect(render.mock.calls.length).toBe(before + 1);
  });

  it("a local source's revision changes when the file is replaced under the same URL; remote sources have none", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const file = path.join(dir, 'public', 'logo.png');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'red');
      utimesSync(file, 1000, 1000);
      const first = await brandingSourceRevision('/logo.png');
      writeFileSync(file, 'blue!');
      utimesSync(file, 2000, 2000);
      const second = await brandingSourceRevision('/logo.png');
      expect(first).not.toBe('');
      expect(second).not.toBe(first);
      expect(await brandingSourceRevision('https://cdn.example.test/logo.png')).toBe('');
      expect(await brandingSourceRevision('/missing.png')).toBe('');
    } finally {
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
