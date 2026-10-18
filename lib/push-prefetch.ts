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

/**
 * Reads the kept copy of `emailId` without taking it (a list row the pointer
 * rests on, the sanitizing ahead of an open). Same checks as takePrefetchedEmail.
 */
export async function peekPrefetchedEmail(accountId: string, emailId: string, now: number = Date.now()): Promise<Email | null> {
  if (typeof window === 'undefined' || typeof caches === 'undefined' || !emailId) return null;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(entryUrl(accountId, emailId));
    if (!res) return null;
    const raw = (await res.json()) as { at?: unknown; email?: Partial<Email> } | null;
    const at = Number(raw?.at);
    const email = raw?.email;
    if (!email || email.id !== emailId || !email.bodyValues) return null;
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > PREFETCH_MAX_AGE_MS) return null;
    return email as Email;
  } catch {
    return null;
  }
}

/** The messages the push worker keeps, as keptEmailKey(accountId, emailId). */
export async function keptEmailKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  if (typeof window === 'undefined' || typeof caches === 'undefined') return out;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const prefix = `${window.location.origin}${BASE_PATH}/__push-state/prefetched/`;
    for (const req of await cache.keys()) {
      if (!req.url.startsWith(prefix)) continue;
      const [account, id] = req.url.slice(prefix.length).split('/');
      if (!account || !id) continue;
      out.add(`${decodeURIComponent(account)}\u0000${decodeURIComponent(id)}`);
    }
  } catch {
    // Nothing kept.
  }
  return out;
}

/** The key keptEmailKeys lists a kept message under. */
export function keptEmailKey(accountId: string, emailId: string): string {
  return `${accountId || 'default'}\u0000${emailId}`;
}
