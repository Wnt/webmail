import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOpenTiming, afterBodyPainted, beginOpen, bodyReady, markOpen } from '../open-timing';
import { parseOpenBeacon } from '../perf-beacon';

// Fork (Wnt/webmail): the open timing behind the speed beacon. The beacon
// carries stage names and ms, the source and a coarse device class only.

let sent: { url: string; body: string }[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  __resetOpenTiming();
  sent = [];
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: (url: string, blob: Blob) => { void blob.text().then((body) => sent.push({ url, body })); return true; },
  });
});
afterEach(() => { vi.useRealTimers(); });

async function flush(ms = 1100) {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe('open timing', () => {
  it('times an open from its start to the painted body and sends one beacon without ids', async () => {
    beginOpen('message-id-123', 'list', { t0: performance.now() - 50, unread: true });
    markOpen('message-id-123', 'data');
    bodyReady('message-id-123');
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/perf/open');
    const body = JSON.parse(sent[0].body);
    expect(Object.keys(body).sort()).toEqual(['dev', 'eng', 'pwa', 'src', 'st', 'unread', 'v'].concat(body.build ? ['build'] : []).sort());
    expect(body).toMatchObject({ v: 1, src: 'list', unread: true });
    expect(Object.keys(body.st).sort()).toEqual(['data', 'painted']);
    expect(body.st.painted).toBeGreaterThanOrEqual(50);
    expect(sent[0].body).not.toContain('message-id-123');
    // What the server accepts is exactly that.
    expect(parseOpenBeacon(body)).not.toBeNull();
  });

  it('stages of another message, or after the paint, are ignored; a new open replaces an unfinished one', async () => {
    beginOpen('a', 'tap');
    markOpen('b', 'data');
    beginOpen('b', 'list');
    markOpen('a', 'data');
    bodyReady('a');
    await flush();
    expect(sent).toHaveLength(0);
    bodyReady('b');
    await flush();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).src).toBe('list');
  });

  it('afterBodyPainted waits for that body, or the timeout', async () => {
    const fn = vi.fn();
    afterBodyPainted('x', fn, 1500);
    bodyReady('other');
    await flush(10);
    expect(fn).not.toHaveBeenCalled();
    bodyReady('x');
    await flush(10);
    expect(fn).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    afterBodyPainted('y', late, 1500);
    await flush(1600);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('a cancelled wait never runs', async () => {
    const fn = vi.fn();
    const cancel = afterBodyPainted('z', fn, 1500);
    cancel();
    bodyReady('z');
    await flush(1600);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('page start stages (an open timed from the page start)', () => {
  it('adds the document, paint, boot and hydration times of a page opened at a message link', async () => {
    const entries: Record<string, unknown[]> = {
      navigation: [{ responseStart: 120.4, responseEnd: 180.2, domContentLoadedEventEnd: 410.7, workerStart: 0 }],
      paint: [{ name: 'first-contentful-paint', startTime: 233.3 }],
    };
    const marks: Record<string, unknown[]> = { 'mm:start:boot': [{ startTime: 300.2 }], 'mm:start:hydrated': [{ startTime: 650.9 }] };
    const spyType = vi.spyOn(performance, 'getEntriesByType').mockImplementation((t: string) => (entries[t] ?? []) as PerformanceEntryList);
    const spyName = vi.spyOn(performance, 'getEntriesByName').mockImplementation((n: string) => (marks[n] ?? []) as PerformanceEntryList);
    try {
      beginOpen('m1', 'link', { t0: 0 });
      markOpen('m1', 'session', 700);
      bodyReady('m1');
      await flush();
      const body = JSON.parse(sent[0].body);
      expect(body.st).toMatchObject({ ttfb: 120, html: 180, fcp: 233, dcl: 411, boot: 300, hyd: 651, session: 700 });
      expect(body.st.sw).toBeUndefined(); // no worker took part
      expect(parseOpenBeacon(body)).not.toBeNull();
    } finally {
      spyType.mockRestore();
      spyName.mockRestore();
    }
  });

  it('a list open carries no page start stages', async () => {
    beginOpen('m2', 'list', { t0: performance.now() });
    bodyReady('m2');
    await flush();
    expect(Object.keys(JSON.parse(sent[0].body).st).sort()).toEqual(['painted']);
  });
});

describe('beacon validation (server side)', () => {
  const ok = { v: 1, src: 'tap', dev: 'phone', pwa: true, eng: 'webkit', unread: null, st: { msg: 3, data: 120, painted: 410 } };
  it('accepts the documented shape and stores only its fields', () => {
    const line = parseOpenBeacon({ ...ok, extra: 'dropped' }, new Date('2026-10-18T12:34:56.789Z'));
    expect(line).toEqual({ t: '2026-10-18T12:34:56Z', src: 'tap', dev: 'phone', pwa: true, eng: 'webkit', unread: null, st: ok.st });
  });
  it.each([
    ['an unknown stage', { ...ok, st: { ...ok.st, subject: 5 } }],
    ['a non-integer time', { ...ok, st: { painted: 1.5 } }],
    ['no painted stage', { ...ok, st: { data: 5 } }],
    ['an unknown source', { ...ok, src: 'other' }],
    ['a free-text device', { ...ok, dev: 'iPhone 15 Pro' }],
    ['a free-text build', { ...ok, build: 'not a commit' }],
    ['another version', { ...ok, v: 2 }],
  ])('refuses %s', (_what, body) => {
    expect(parseOpenBeacon(body)).toBeNull();
  });
});
