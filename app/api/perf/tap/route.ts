// Fork (Wnt/webmail): the tap diagnostics (lib/tap-trace.ts, public/sw.js).
//
// The signed-in user's own app and service worker post the links of a
// notification tap's chain: stage names and yes/no facts on a fixed list
// (lib/tap-trace-beacon.ts), never an id, address, subject or content.
// Accepted only from a signed-in, same-origin session (the proxy's origin
// gate), appended as JSON lines to TELEMETRY_DATA_DIR/tap-trace.jsonl (the
// data volume). Read with tools/perf-beacon --taps in the ops repo.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { logger } from '@/lib/logger';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { parseTapBatch } from '@/lib/tap-trace-beacon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINES_PER_MINUTE = 240;
let windowStart = 0;
let windowCount = 0;
function overRate(nowMs: number, lines: number): boolean {
  if (nowMs - windowStart >= 60_000) { windowStart = nowMs; windowCount = 0; }
  windowCount += lines;
  return windowCount > MAX_LINES_PER_MINUTE;
}

function traceFile(): string {
  return path.join(process.env.TELEMETRY_DATA_DIR || path.join(process.cwd(), 'data', 'telemetry'), 'tap-trace.jsonl');
}

async function signedIn(): Promise<boolean> {
  const cookieStore = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    if (readStalwartAuthContextFromStore(cookieStore, slot)) return true;
  }
  return false;
}

export async function POST(request: NextRequest) {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  if (!(await signedIn())) return new NextResponse(null, { status: 401 });
  let text: string;
  try {
    text = await request.text();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const lines = parseTapBatch(parsed);
  if (!lines) return new NextResponse(null, { status: 400 });
  if (overRate(Date.now(), lines.length)) return new NextResponse(null, { status: 429 });
  if (lines.length === 0) return new NextResponse(null, { status: 204 });
  for (const line of lines) logger.info('perf: tap', { ev: line.ev, src: line.src, ...line.f });
  try {
    const file = traceFile();
    await mkdir(path.dirname(file), { recursive: true });
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size > MAX_FILE_BYTES) await rename(file, `${file}.1`).catch(() => {});
    await appendFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
  } catch (error) {
    logger.warn('perf: tap trace not stored', { error: error instanceof Error ? error.message : String(error) });
  }
  return new NextResponse(null, { status: 204 });
}
