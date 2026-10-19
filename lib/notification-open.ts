// Fork (Wnt/webmail): the message a tapped push notification asked for.
//
// public/sw.js writes it on notificationclick, before it tries to bring the
// app there with navigate() or openWindow(). Either can fail to land: WebKit
// may open a Home Screen web app at its start page instead of the URL
// (bugs.webkit.org 259212), navigate() rejects for a client the worker does
// not control, and a sign-in in between replaces the page. The mail app takes
// the entry once it is signed in and showing (start, focus, the worker's
// message) and opens the message itself. Same cache as the worker's other
// push state; the key must match notificationOpenKey() in sw.js.

const PUSH_STATE_CACHE = 'bulwark-push-state-v1';
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/** How long a tap stays pending: long enough for a passkey sign-in in between. */
export const NOTIFICATION_OPEN_MAX_AGE_MS = 5 * 60 * 1000;

export interface NotificationOpen {
  emailId: string;
  /** Cookie slot of the login the message belongs to, when the worker knew it. */
  slot?: number;
  /** When the notification was tapped (ms since the epoch). */
  at: number;
}

function entryUrl(): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/notification-open`;
}

/**
 * Takes the pending tap, if any: returns it once and removes it, so several
 * triggers (and tabs) racing for one tap open the message once. Entries
 * older than NOTIFICATION_OPEN_MAX_AGE_MS are dropped unread.
 */
export async function takeNotificationOpen(now: number = Date.now()): Promise<NotificationOpen | null> {
  if (typeof window === 'undefined' || typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(entryUrl());
    if (!res) return null;
    const raw = (await res.json()) as Record<string, unknown> | null;
    // Only the caller whose delete removed it gets the entry.
    if (!(await cache.delete(entryUrl()))) return null;
    if (!raw || typeof raw.emailId !== 'string' || !raw.emailId) return null;
    const at = Number(raw.at);
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > NOTIFICATION_OPEN_MAX_AGE_MS) return null;
    const slot = Number.isInteger(raw.slot) && (raw.slot as number) >= 0 ? (raw.slot as number) : undefined;
    return { emailId: raw.emailId, slot, at };
  } catch {
    return null;
  }
}

// Fork (Wnt/webmail): a tap that reached neither the worker nor this page.
//
// On an iPhone a notification with a `navigate` URL never fires
// notificationclick, and when the Home Screen app was in the background (the
// phone asleep), WebKit brings its window back without loading that URL
// (bugs.webkit.org 268797, comments 37-38; seen on the owner's iPhone on
// 2026-10-19: the app came up on the Inbox). The tap still removes that
// notification from the list. public/sw.js keeps a ledger of the mail
// notifications it showed (rememberShown, same cache and keys); the one that
// is gone from registration.getNotifications() without the worker closing it,
// a click or a dismissal reaching the worker, is the one that was tapped.

/** A ledger entry older than this is never taken for a tap. */
export const SHOWN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ShownEntry {
  shownId: string;
  emailId: string;
  accountId?: string;
  slot?: number;
  at: number;
  listed?: boolean;
  closed?: boolean;
}

export interface TappedNotification {
  emailId: string;
  slot?: number;
  /** When the tap was found: names its hand-over entry (settleTap). */
  at: number;
  /** Found by an earlier page of this app that WebKit replaced before it could open it. */
  handover?: boolean;
}

export interface TappedNotificationCheck {
  /** The one notification that disappeared, if exactly one did (or a tap an earlier page found). */
  tapped: TappedNotification | null;
  /** Ledger entries before the check. */
  kept: number;
  /** Mail notifications the browser lists now. */
  listed: number;
  /** Entries whose notification disappeared (and could have been a tap). */
  vanished: number;
}

// Fork (Wnt/webmail): the hand-over. WebKit brings the backgrounded app's
// old page to the front first and replaces it a moment later (its reload,
// or its navigation): the old page sees the notification gone, and is
// unloaded before it can open the message (iOS Simulator, 2026-10-19:
// visible at -188 ms, ledger read at -69 ms, the new page at 0). So a found
// tap is written down before the ledger entries go, and it stays until a
// page opened its message and kept it for TAP_FOUND_GRACE_MS (or it could
// not be opened, or it is TAP_FOUND_MAX_AGE_MS old). A page that replaces
// the finder takes it over.
export const TAP_FOUND_MAX_AGE_MS = 2 * 60 * 1000;
export const TAP_FOUND_GRACE_MS = 10_000;

interface TapFound {
  emailId: string;
  slot?: number;
  at: number;
  openedAt?: number;
}

/** Taps this page has taken (by `at`): it never opens one twice itself. */
const takenHere = new Set<number>();

function foundKey(): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/tap-found`;
}

async function readFound(cache: Cache, now: number): Promise<TapFound | null> {
  try {
    const res = await cache.match(foundKey());
    if (!res) return null;
    const raw = (await res.json()) as Record<string, unknown> | null;
    const at = Number(raw?.at);
    const openedAt = raw?.openedAt === undefined ? undefined : Number(raw.openedAt);
    const fresh = raw && typeof raw.emailId === 'string' && raw.emailId && Number.isFinite(at)
      && at <= now + 60_000 && now - at <= TAP_FOUND_MAX_AGE_MS
      && (openedAt === undefined || (Number.isFinite(openedAt) && now - openedAt <= TAP_FOUND_GRACE_MS));
    if (!fresh) {
      await cache.delete(foundKey());
      return null;
    }
    const slot = Number.isInteger(raw.slot) && (raw.slot as number) >= 0 ? (raw.slot as number) : undefined;
    return { emailId: raw.emailId as string, slot, at, ...(openedAt !== undefined ? { openedAt } : {}) };
  } catch {
    return null;
  }
}

/**
 * How the tap `tap` ended in this page: `opened` keeps its hand-over entry a
 * little longer (a page replacing this one in that time opens it again),
 * anything else drops it.
 */
export async function settleTap(tap: TappedNotification, opened: boolean, now: number = Date.now()): Promise<void> {
  if (typeof window === 'undefined' || typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const found = await readFound(cache, now);
    if (!found || found.at !== tap.at) return;
    if (!opened) {
      await cache.delete(foundKey());
      return;
    }
    await cache.put(foundKey(), new Response(JSON.stringify({ ...found, openedAt: now }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    setTimeout(() => { void settleTap(tap, false); }, TAP_FOUND_GRACE_MS);
  } catch {
    // It ages out.
  }
}

function shownPrefix(): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/shown/`;
}

/** Where the lost-tap check runs: the iPhone/iPad Home Screen app (WebKit, standalone), where taps get lost. */
export function tapFallbackApplies(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const webkit = /AppleWebKit\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua);
  const standalone = (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return webkit && standalone;
}

async function readLedger(cache: Cache): Promise<{ request: Request; entry: ShownEntry | null }[]> {
  const out: { request: Request; entry: ShownEntry | null }[] = [];
  for (const request of await cache.keys()) {
    if (!request.url.startsWith(shownPrefix())) continue;
    let entry: ShownEntry | null = null;
    try {
      const res = await cache.match(request);
      const raw = res ? (await res.json()) as Record<string, unknown> : null;
      if (raw && typeof raw.shownId === 'string' && typeof raw.emailId === 'string' && raw.emailId) {
        entry = {
          shownId: raw.shownId,
          emailId: raw.emailId,
          accountId: typeof raw.accountId === 'string' ? raw.accountId : undefined,
          slot: Number.isInteger(raw.slot) && (raw.slot as number) >= 0 ? (raw.slot as number) : undefined,
          at: Number(raw.at),
          listed: raw.listed === true,
          closed: raw.closed === true,
        };
      }
    } catch {
      entry = null;
    }
    out.push({ request, entry });
  }
  return out;
}

/**
 * Compares the worker's ledger with what `registration` still lists. Every
 * entry whose notification is gone leaves the ledger (it is looked at once);
 * when exactly one of them could have been tapped - the worker saw it listed,
 * did not close it itself, and it is under a day old - that is the tap, and
 * it is written down for the hand-over first. Several gone at once (Clear
 * All) open nothing. Without a new one, a tap an earlier page found and did
 * not keep open is taken over. A listing that fails changes nothing. The tap
 * returned is this page's to open; settle it with settleTap.
 */
export async function findTappedNotification(
  registration: Pick<ServiceWorkerRegistration, 'getNotifications'> | null | undefined,
  now: number = Date.now(),
): Promise<TappedNotificationCheck> {
  const none: TappedNotificationCheck = { tapped: null, kept: 0, listed: 0, vanished: 0 };
  if (typeof window === 'undefined' || typeof caches === 'undefined' || !registration
    || typeof registration.getNotifications !== 'function') return none;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const found = await readFound(cache, now);
    const handover = (): TappedNotification | null => {
      if (!found || takenHere.has(found.at)) return null;
      takenHere.add(found.at);
      return { emailId: found.emailId, slot: found.slot, at: found.at, handover: true };
    };
    const ledger = await readLedger(cache);
    if (ledger.length === 0) return { ...none, tapped: handover() };
    let notes: Notification[];
    try {
      notes = await registration.getNotifications();
    } catch {
      return { ...none, kept: ledger.length, tapped: handover() };
    }
    const present = new Set<string>();
    let listed = 0;
    for (const n of notes) {
      const data = n.data as { kind?: unknown; shownId?: unknown } | null;
      if (data && data.kind === 'email') listed += 1;
      if (data && typeof data.shownId === 'string') present.add(data.shownId);
    }
    const candidates: ShownEntry[] = [];
    const gone: Request[] = [];
    for (const { request, entry } of ledger) {
      if (!entry) {
        gone.push(request);
        continue;
      }
      if (present.has(entry.shownId)) {
        // Still on screen: a close the browser refused (too young) did not take.
        if (entry.closed) {
          await cache.put(request, new Response(JSON.stringify({ ...entry, closed: false }), {
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        continue;
      }
      gone.push(request);
      if (entry.closed || !entry.listed) continue;
      if (!Number.isFinite(entry.at) || entry.at > now + 60_000 || now - entry.at > SHOWN_MAX_AGE_MS) continue;
      candidates.push(entry);
    }
    let tapped: TappedNotification | null = null;
    if (candidates.length === 1) {
      const one = candidates[0];
      tapped = { emailId: one.emailId, slot: one.slot, at: now };
      // Written down before the ledger entries go: this page may be replaced any moment.
      await cache.put(foundKey(), new Response(JSON.stringify({ emailId: one.emailId, slot: one.slot, at: now }), {
        headers: { 'Content-Type': 'application/json' },
      }));
      takenHere.add(now);
    }
    for (const request of gone) await cache.delete(request);
    return {
      tapped: tapped ?? handover(),
      kept: ledger.length,
      listed,
      vanished: candidates.length,
    };
  } catch {
    return none;
  }
}

/** The message is open in the app: its notifications are no taps waiting any more. */
export async function forgetShownNotificationsFor(emailId: string): Promise<void> {
  if (typeof window === 'undefined' || typeof caches === 'undefined' || !emailId) return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    for (const { request, entry } of await readLedger(cache)) {
      if (entry && entry.emailId === emailId) await cache.delete(request);
    }
  } catch {
    // Best effort.
  }
}

/** Tests only. */
export function __resetTapHandover(): void {
  takenHere.clear();
}
