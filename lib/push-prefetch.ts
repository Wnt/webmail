// Fork (Wnt/webmail): the whole message a push notification opens, kept by
// the service worker when it showed the notification (public/sw.js
// rememberPrefetchedEmail, fetched with /api/push/preview?full=1). A tap on
// the notification then shows the message without another Email/get: the app
// takes the entry once and hands it to its JMAP client (primeEmail). Same
// cache as the worker's other push state; the key layout must match
// prefetchedKey() in sw.js.
import type { Email } from '@/lib/jmap/types';

const PUSH_STATE_CACHE = 'bulwark-push-state-v1';
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
/** Older entries are dropped unread (the worker also keeps them a day at most). */
export const PREFETCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function entryUrl(accountId: string, emailId: string): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/prefetched/${encodeURIComponent(accountId || 'default')}/${encodeURIComponent(emailId)}`;
}

/** Takes (reads and removes) the kept copy of `emailId` in `accountId`, if any. */
export async function takePrefetchedEmail(accountId: string, emailId: string, now: number = Date.now()): Promise<Email | null> {
  if (typeof window === 'undefined' || typeof caches === 'undefined' || !emailId) return null;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const url = entryUrl(accountId, emailId);
    const res = await cache.match(url);
    if (!res) return null;
    const raw = (await res.json()) as { at?: unknown; email?: Partial<Email> } | null;
    await cache.delete(url);
    const at = Number(raw?.at);
    const email = raw?.email;
    if (!email || email.id !== emailId || !email.bodyValues) return null;
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > PREFETCH_MAX_AGE_MS) return null;
    return email as Email;
  } catch {
    return null;
  }
}
