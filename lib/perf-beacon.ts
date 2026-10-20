// Fork (Wnt/webmail): what the open-speed beacon may carry (app/api/perf/open,
// lib/open-timing.ts). Unknown stage names and values are refused; other
// top-level fields are dropped (only the fields below are stored).

const STAGES = new Set(['msg', 'ttfb', 'html', 'fcp', 'dcl', 'boot', 'hyd', 'sw', 'session', 'snap', 'data', 'painted', 'done']);
const SOURCES = new Set(['list', 'tap', 'link', 'swipe']);
/** A swipe: what its neighbour pane showed at the release (lib/open-timing.ts SwipePreload). */
const PRELOADS = new Set(['full', 'lite', 'none']);
const DEVICES = new Set(['phone', 'tablet', 'desktop']);
const ENGINES = new Set(['webkit', 'blink', 'gecko', 'other']);

export interface OpenBeaconLine {
  t: string;
  src: string;
  dev: string;
  pwa: boolean;
  eng: string;
  unread: boolean | null;
  st: Record<string, number>;
  build?: string;
  pre?: string;
}

/** The beacon's fields, or null when anything is off (unknown field values are not stored). */
export function parseOpenBeacon(raw: unknown, now = new Date()): OpenBeaconLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (b.v !== 1) return null;
  if (typeof b.src !== 'string' || !SOURCES.has(b.src)) return null;
  if (typeof b.dev !== 'string' || !DEVICES.has(b.dev)) return null;
  if (typeof b.eng !== 'string' || !ENGINES.has(b.eng)) return null;
  if (typeof b.pwa !== 'boolean') return null;
  if (b.unread !== null && typeof b.unread !== 'boolean' && b.unread !== undefined) return null;
  if (!b.st || typeof b.st !== 'object' || Array.isArray(b.st)) return null;
  const st: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.st as Record<string, unknown>)) {
    if (!STAGES.has(k)) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 120_000) return null;
    st[k] = v;
  }
  if (st.painted === undefined) return null;
  if (b.build !== undefined && (typeof b.build !== 'string' || !/^[0-9a-f]{1,12}$/.test(b.build))) return null;
  if (b.pre !== undefined && (b.src !== 'swipe' || typeof b.pre !== 'string' || !PRELOADS.has(b.pre))) return null;
  return {
    t: now.toISOString().slice(0, 19) + 'Z',
    src: b.src, dev: b.dev, pwa: b.pwa, eng: b.eng,
    unread: typeof b.unread === 'boolean' ? b.unread : null,
    st,
    ...(typeof b.build === 'string' ? { build: b.build } : {}),
    ...(typeof b.pre === 'string' ? { pre: b.pre } : {}),
  };
}

