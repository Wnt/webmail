// Fork (Wnt/webmail): what the tap diagnostics may carry (app/api/perf/tap,
// lib/tap-trace.ts, public/sw.js traceTap). Every event, source and fact is
// on a fixed list with a fixed value shape; anything else is dropped, so no
// id, address, subject or other free text can be stored.

type Check = (v: unknown) => boolean;

const bool: Check = (v) => typeof v === 'boolean';
const count: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 99;
const seconds: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000_000;
const ms: Check = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 600_000;
const oneOf = (...values: string[]): Check => (v) => typeof v === 'string' && values.includes(v);

const HOW = oneOf('link', 'pending', 'vanished', 'handover', 'inplace', 'ambiguous', 'none');

const FACTS: Record<string, { src: 'sw' | 'page'; facts: Record<string, Check> }> = {
  push: {
    src: 'sw',
    facts: {
      target: bool, preview: oneOf('ok', 'fail', 'skip'), shown: oneOf('new', 'summary', 'ack', 'none'),
      nav: bool, listed: bool, win: count, vis: bool,
    },
  },
  click: { src: 'sw', facts: { target: bool, win: count, act: oneOf('inplace', 'focus', 'navigate', 'open', 'none', 'error'), age: seconds } },
  close: { src: 'sw', facts: { age: seconds } },
  start: {
    src: 'page',
    facts: {
      link: bool, nav: oneOf('navigate', 'reload', 'back_forward', 'prerender', 'other'), ctl: bool, vis: bool,
      swrev: oneOf('same', 'old', 'none'),
    },
  },
  session: { src: 'page', facts: { how: oneOf('restored', 'login') } },
  found: {
    src: 'page',
    facts: { how: HOW, when: oneOf('start', 'resume', 'recheck', 'message'), kept: count, listed: count, vanished: count, hidden: seconds },
  },
  open: {
    src: 'page',
    facts: {
      how: HOW, ok: bool,
      reason: oneOf('ok', 'not_found', 'account', 'moved_on', 'no_client', 'error', 'embedded'), ms,
    },
  },
};

const DEVICES = new Set(['phone', 'tablet', 'desktop']);
const ENGINES = new Set(['webkit', 'blink', 'gecko', 'other']);

export interface TapTraceLine {
  /** Server time the record arrived. */
  t: string;
  /** Random per record (not tied to any message): drops a record the worker and the app both sent. */
  id: string;
  src: 'sw' | 'page';
  ev: string;
  /** The device's clock when it happened (ms since the epoch). */
  at: number;
  sw?: string;
  build?: string;
  dev?: string;
  pwa?: boolean;
  eng?: string;
  f: Record<string, boolean | number | string>;
}

/** One record, or null when anything is off. */
export function parseTapRecord(raw: unknown, now = new Date()): TapTraceLine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ev !== 'string' || !Object.prototype.hasOwnProperty.call(FACTS, r.ev)) return null;
  const spec = FACTS[r.ev];
  if (r.src !== spec.src) return null;
  if (typeof r.id !== 'string' || !/^[0-9a-z]{6,16}$/.test(r.id)) return null;
  if (typeof r.at !== 'number' || !Number.isInteger(r.at) || r.at < 1_600_000_000_000 || r.at > 4_000_000_000_000) return null;
  if (r.sw !== undefined && (typeof r.sw !== 'string' || !/^[0-9a-z.-]{1,24}$/.test(r.sw))) return null;
  if (r.build !== undefined && (typeof r.build !== 'string' || !/^[0-9a-f]{1,12}$/.test(r.build))) return null;
  if (r.dev !== undefined && (typeof r.dev !== 'string' || !DEVICES.has(r.dev))) return null;
  if (r.pwa !== undefined && typeof r.pwa !== 'boolean') return null;
  if (r.eng !== undefined && (typeof r.eng !== 'string' || !ENGINES.has(r.eng))) return null;
  if (!r.f || typeof r.f !== 'object' || Array.isArray(r.f)) return null;
  const f: Record<string, boolean | number | string> = {};
  for (const [k, v] of Object.entries(r.f as Record<string, unknown>)) {
    const check = Object.prototype.hasOwnProperty.call(spec.facts, k) ? spec.facts[k] : undefined;
    if (!check || !check(v)) return null;
    f[k] = v as boolean | number | string;
  }
  return {
    t: now.toISOString().slice(0, 19) + 'Z',
    id: r.id,
    src: spec.src,
    ev: r.ev,
    at: r.at,
    ...(typeof r.sw === 'string' ? { sw: r.sw } : {}),
    ...(typeof r.build === 'string' ? { build: r.build } : {}),
    ...(typeof r.dev === 'string' ? { dev: r.dev } : {}),
    ...(typeof r.pwa === 'boolean' ? { pwa: r.pwa } : {}),
    ...(typeof r.eng === 'string' ? { eng: r.eng } : {}),
    f,
  };
}

/** A batch `{ v: 1, events: [...] }`: the valid records (invalid ones are dropped), or null when the batch itself is off. */
export function parseTapBatch(raw: unknown, now = new Date()): TapTraceLine[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.v !== 1 || !Array.isArray(b.events) || b.events.length > 30) return null;
  const lines: TapTraceLine[] = [];
  for (const e of b.events) {
    const line = parseTapRecord(e, now);
    if (line) lines.push(line);
  }
  return lines;
}
