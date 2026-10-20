// Fork (Wnt/webmail): a message the user is about to open is fetched and its
// body sanitized before the click, so the open itself needs neither.
//
// - The pointer resting on a list row (a mouse, HOVER_DWELL_MS), or a finger
//   held still on it (PRESS_DWELL_MS, before the tap's click arrives), asks
//   for that message: the push worker's kept copy when it has one (with the
//   row's current flags and folders), else one Email/get. The click's
//   getEmail then takes it, or waits for it (JMAPClient.prefetchEmail).
// - When it arrives, its body is sanitized for the reading pane at idle
//   (lib/email-content-cache.ts prewarmEmailContent).
// - When the push worker keeps a new message (a notification), an open app
//   sanitizes that body at idle too, ready for the tap or the list click.
//
// Fetching a body does not mark the message read (JMAP Email/get), and
// sanitizing loads nothing: images are fetched only when the pane shows them.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email } from '@/lib/jmap/types';
import { keptEmailKey, keptEmailKeys, peekPrefetchedEmail } from '@/lib/push-prefetch';
import { prewarmEmailContent } from '@/lib/email-content-cache';

/** How long the mouse rests on a row before its message is fetched. */
export const HOVER_DWELL_MS = 80;
/** How long a finger rests on a row, unmoved, before its message is fetched (a tap's click comes later). */
export const PRESS_DWELL_MS = 50;
/** A press that moves this far is a scroll, not a tap. */
const PRESS_SLOP_PX = 8;
/** How long a fetched message stands in for the open's Email/get. */
export const OPEN_PREFETCH_MAX_AGE_MS = 20_000;

const recent = new Map<string, number>();
let kept: Set<string> | null = null;
let keptListening = false;

function seenRecently(key: string, now: number): boolean {
  const at = recent.get(key);
  if (at !== undefined && now - at < OPEN_PREFETCH_MAX_AGE_MS) return true;
  recent.set(key, now);
  if (recent.size > 200) {
    for (const [k, t] of recent) if (now - t >= OPEN_PREFETCH_MAX_AGE_MS) recent.delete(k);
  }
  return false;
}

/**
 * Fetches the message of list row `row` ahead of its open (see above). Rows of
 * another login or a shared account (source-stamped rows of the unified and
 * cross-account views) and drafts (they open in the composer) are left alone.
 */
export function prefetchForOpen(client: IJMAPClient | null | undefined, row: Email | null | undefined): void {
  if (!client?.prefetchEmail || !row?.id) return;
  if (row.sourceClientAccountId || row.sourceAccountId || row.keywords?.$draft) return;
  const accountId = client.getAccountId();
  if (seenRecently(`${accountId}\u0000${row.id}`, Date.now())) return;
  void fetchAhead(client, row, OPEN_PREFETCH_MAX_AGE_MS)?.then((email) => { if (email) prewarmEmailContent(email); });
}

/**
 * The message of list row `row`, fetched ahead of its open: the push
 * worker's kept copy (with the row's current flags and folders) when it has
 * one, else one Email/get (JMAPClient.prefetchEmail; the open then takes it
 * within `maxAgeMs`). Null when the client cannot prefetch. Also used by the
 * phone swipe's neighbours (hooks/use-swipe-neighbours.ts).
 */
export function fetchAhead(client: IJMAPClient, row: Email, maxAgeMs: number): Promise<Email | null> | null {
  if (!client.prefetchEmail || !row.id) return null;
  const accountId = client.getAccountId();
  if (kept?.has(keptEmailKey(accountId, row.id))) {
    return peekPrefetchedEmail(accountId, row.id).then((copy) => {
      // The kept copy is from the push; the row's flags and folders are current.
      const current = copy ? { ...copy, keywords: row.keywords ?? copy.keywords, mailboxIds: row.mailboxIds ?? copy.mailboxIds } : null;
      return client.prefetchEmail?.(row.id, current, { maxAgeMs }) ?? null;
    });
  }
  return client.prefetchEmail(row.id, null, { maxAgeMs });
}

/**
 * Starts knowing which messages the push worker keeps, and sanitizing each
 * new one's body at idle. Once per page.
 */
export function watchKeptEmails(): void {
  if (keptListening || typeof window === 'undefined') return;
  keptListening = true;
  void keptEmailKeys().then((keys) => {
    kept = new Set([...(kept ?? []), ...keys]);
  });
  try {
    navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { kind?: unknown; accountId?: unknown; emailId?: unknown } | null;
      if (!data || data.kind !== 'push-kept' || typeof data.emailId !== 'string' || !data.emailId) return;
      const accountId = typeof data.accountId === 'string' ? data.accountId : '';
      (kept ??= new Set()).add(keptEmailKey(accountId, data.emailId));
      void peekPrefetchedEmail(accountId, data.emailId).then((copy) => { if (copy) prewarmEmailContent(copy); });
    });
  } catch {
    // No service worker: nothing is kept.
  }
}

/**
 * Wires a list's scroll container: the mouse resting on a message row, or a
 * finger held still on one, prefetches its message (prefetchForOpen). `rowFor`
 * maps a row's message id to its list entry. Returns the cleanup.
 */
export function attachOpenPrefetch(
  container: HTMLElement,
  rowFor: (emailId: string) => Email | undefined,
  clientFor: () => IJMAPClient | null | undefined,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hoverId: string | null = null;
  let press: { id: string; x: number; y: number } | null = null;
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const rowId = (target: EventTarget | null): string | null => {
    const el = (target as Element | null)?.closest?.('[data-testid="email-list-item"][data-email-id]') as HTMLElement | null;
    return el && container.contains(el) ? el.getAttribute('data-email-id') : null;
  };
  const go = (id: string) => prefetchForOpen(clientFor(), rowFor(id));

  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const id = rowId(e.target);
    if (id === hoverId) return;
    clear();
    hoverId = id;
    if (id) timer = setTimeout(() => { timer = null; go(id); }, HOVER_DWELL_MS);
  };
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    clear();
    hoverId = null;
  };
  const onDown = (e: PointerEvent) => {
    const id = rowId(e.target);
    if (!id) return;
    clear();
    if (e.pointerType === 'mouse') { if (e.button === 0) go(id); return; }
    press = { id, x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { timer = null; if (press) go(press.id); }, PRESS_DWELL_MS);
  };
  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerType === 'mouse') return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP_PX) { press = null; clear(); }
  };
  const onEnd = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    // A tap that ends before the dwell is still a tap: fetch now (the click follows).
    if (e.type === 'pointerup' && press && timer !== null) { clear(); go(press.id); }
    if (e.type === 'pointercancel') clear();
    press = null;
  };
  container.addEventListener('pointerover', onOver);
  container.addEventListener('pointerleave', onLeave);
  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove, { passive: true });
  container.addEventListener('pointerup', onEnd);
  container.addEventListener('pointercancel', onEnd);
  return () => {
    clear();
    container.removeEventListener('pointerover', onOver);
    container.removeEventListener('pointerleave', onLeave);
    container.removeEventListener('pointerdown', onDown);
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerup', onEnd);
    container.removeEventListener('pointercancel', onEnd);
  };
}

/** Tests only. */
export function __resetOpenPrefetch(): void {
  recent.clear();
  kept = null;
  keptListening = false;
}
