import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseTapBatch, parseTapRecord } from '@/lib/tap-trace-beacon';
import { SW_REVISION } from '@/lib/sw-revision';

// Fork (Wnt/webmail): the tap diagnostics store stage names and yes/no facts
// only. Anything off the fixed list - an id, an address, a subject, free
// text - is refused.
const AT = 1_800_000_000_000;
const now = new Date('2026-10-19T10:00:00Z');

const rec = (extra: Record<string, unknown> = {}) => ({
  id: 'a1b2c3d4e5f60718', src: 'page', ev: 'found', at: AT, dev: 'phone', pwa: true, eng: 'webkit', build: 'b2265d30',
  f: { how: 'vanished', when: 'start', kept: 1, listed: 0, vanished: 1 },
  ...extra,
});

describe('parseTapRecord', () => {
  it('takes a well-formed record and stamps the server time', () => {
    expect(parseTapRecord(rec(), now)).toEqual({
      t: '2026-10-19T10:00:00Z', id: 'a1b2c3d4e5f60718', src: 'page', ev: 'found', at: AT,
      build: 'b2265d30', dev: 'phone', pwa: true, eng: 'webkit',
      f: { how: 'vanished', when: 'start', kept: 1, listed: 0, vanished: 1 },
    });
  });

  it('takes the worker records', () => {
    expect(parseTapRecord({ id: 'abcdef12', src: 'sw', ev: 'push', at: AT, sw: SW_REVISION, eng: 'webkit',
      f: { target: true, preview: 'ok', shown: 'new', nav: true, listed: true, win: 1, vis: false } }, now)).not.toBeNull();
    expect(parseTapRecord({ id: 'abcdef12', src: 'sw', ev: 'click', at: AT, f: { target: true, win: 0, act: 'open', age: 5400 } }, now)).not.toBeNull();
    expect(parseTapRecord({ id: 'abcdef12', src: 'sw', ev: 'close', at: AT, f: { age: 12 } }, now)).not.toBeNull();
  });

  it('refuses free text anywhere', () => {
    expect(parseTapRecord(rec({ f: { how: 'vanished', when: 'start', kept: 1, listed: 0, vanished: 1, emailId: 'Mabc' } }), now)).toBeNull();
    expect(parseTapRecord(rec({ f: { how: 'info@examplepaja.test', when: 'start' } }), now)).toBeNull();
    expect(parseTapRecord(rec({ id: 'Invented subject' }), now)).toBeNull();
    expect(parseTapRecord(rec({ build: 'not-hex' }), now)).toBeNull();
    expect(parseTapRecord(rec({ sw: 'Invented Subject!' }), now)).toBeNull();
    expect(parseTapRecord(rec({ url: '/mail/message/Mabc' }), now)).toMatchObject({ ev: 'found' });
    expect(JSON.stringify(parseTapRecord(rec({ url: '/mail/message/Mabc' }), now))).not.toContain('Mabc');
  });

  it('refuses an unknown event, the wrong source, or a fact of the wrong shape', () => {
    expect(parseTapRecord(rec({ ev: 'nope' }), now)).toBeNull();
    expect(parseTapRecord(rec({ src: 'sw' }), now)).toBeNull();
    expect(parseTapRecord(rec({ f: { how: 'vanished', kept: 1000 } }), now)).toBeNull();
    expect(parseTapRecord(rec({ f: { how: 'vanished', kept: 1.5 } }), now)).toBeNull();
    expect(parseTapRecord(rec({ at: 12 }), now)).toBeNull();
    expect(parseTapRecord(rec({ f: [] }), now)).toBeNull();
    expect(parseTapRecord(null, now)).toBeNull();
  });
});

describe('parseTapBatch', () => {
  it('keeps the good records and drops the bad ones', () => {
    const lines = parseTapBatch({ v: 1, events: [rec(), rec({ ev: 'nope' }), rec({ id: 'b1b2c3d4' })] }, now);
    expect(lines?.map((l) => l.id)).toEqual(['a1b2c3d4e5f60718', 'b1b2c3d4']);
  });

  it('refuses a malformed or oversized batch', () => {
    expect(parseTapBatch({ v: 2, events: [] }, now)).toBeNull();
    expect(parseTapBatch({ v: 1, events: 'x' }, now)).toBeNull();
    expect(parseTapBatch({ v: 1, events: Array.from({ length: 31 }, () => rec()) }, now)).toBeNull();
  });
});

describe('worker revision', () => {
  it('public/sw.js and lib/sw-revision.ts name the same revision', () => {
    const sw = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
    expect(sw).toContain(`const SW_REVISION = "${SW_REVISION}";`);
  });
});
