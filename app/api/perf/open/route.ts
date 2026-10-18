// Fork (Wnt/webmail): the open-speed beacon (lib/open-timing.ts).
//
// The signed-in user's own browser posts, after each message open, how long
// the stages took. Accepted only from a signed-in, same-origin session (the
// proxy's origin gate), checked field by field, and appended as one JSON line
// to TELEMETRY_DATA_DIR/open-timings.jsonl (the data volume) plus one log
// line. A line holds stage names and ms, the source of the open, a coarse
// device class and the app build - never an id, address, subject or content.
// Read the medians with tools/perf-beacon in the ops repo.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { logger } from '@/lib/logger';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { parseOpenBeacon } from '@/lib/perf-beacon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 2048;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PER_MINUTE = 120;
let windowStart = 0;
let windowCount = 0;
function overRate(nowMs: number): boolean {
  if (nowMs - windowStart >= 60_000) { windowStart = nowMs; windowCount = 0; }
  windowCount += 1;
  return windowCount > MAX_PER_MINUTE;
}

function beaconFile(): string {
  return path.join(process.env.TELEMETRY_DATA_DIR || path.join(process.cwd(), 'data', 'telemetry'), 'open-timings.jsonl');
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
  if (overRate(Date.now())) return new NextResponse(null, { status: 429 });
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
  const line = parseOpenBeacon(parsed);
  if (!line) return new NextResponse(null, { status: 400 });
  logger.info('perf: open', { ...line });
  try {
    const file = beaconFile();
    await mkdir(path.dirname(file), { recursive: true });
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size > MAX_FILE_BYTES) await rename(file, `${file}.1`).catch(() => {});
    await appendFile(file, JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch (error) {
    logger.warn('perf: open beacon not stored', { error: error instanceof Error ? error.message : String(error) });
  }
  return new NextResponse(null, { status: 204 });
}
