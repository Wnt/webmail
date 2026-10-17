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
