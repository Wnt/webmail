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
}

export interface TappedNotificationCheck {
  /** The one notification that disappeared, if exactly one did. */
  tapped: TappedNotification | null;
  /** Ledger entries before the check. */
  kept: number;
  /** Mail notifications the browser lists now. */
  listed: number;
  /** Entries whose notification disappeared (and could have been a tap). */
  vanished: number;
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
 * did not close it itself, and it is under a day old - that is the tap.
 * Several gone at once (Clear All) open nothing. A listing that fails changes
 * nothing.
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
    const ledger = await readLedger(cache);
    if (ledger.length === 0) return none;
    let notes: Notification[];
    try {
      notes = await registration.getNotifications();
    } catch {
      return { ...none, kept: ledger.length };
    }
    const present = new Set<string>();
    let listed = 0;
    for (const n of notes) {
      const data = n.data as { kind?: unknown; shownId?: unknown } | null;
      if (data && data.kind === 'email') listed += 1;
      if (data && typeof data.shownId === 'string') present.add(data.shownId);
    }
    const candidates: ShownEntry[] = [];
    let vanished = 0;
    for (const { request, entry } of ledger) {
      if (!entry) {
        await cache.delete(request);
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
      await cache.delete(request);
      if (entry.closed || !entry.listed) continue;
      if (!Number.isFinite(entry.at) || entry.at > now + 60_000 || now - entry.at > SHOWN_MAX_AGE_MS) continue;
      vanished += 1;
      candidates.push(entry);
    }
    const one = candidates.length === 1 ? candidates[0] : null;
    return {
      tapped: one ? { emailId: one.emailId, slot: one.slot } : null,
      kept: ledger.length,
      listed,
      vanished,
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
