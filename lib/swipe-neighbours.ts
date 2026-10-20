// Fork (Wnt/webmail): the phone's swipe between messages shows the previous
// and the next message themselves while the finger moves - their subject,
// sender and rendered body, in panes on both sides of the open message
// (hooks/use-message-swipe.ts, components/email/swipe-peek.tsx). These are
// the rules for what is prepared ahead and how much.
//
// - Only the two neighbours of the open message in the list as shown (the
//   folder, search or filter, and the conversation setting: the very rows
//   the swipe opens), after the open message's body is on screen, when the
//   browser is idle, and not while the page is hidden or the browser asks to
//   save data.
// - A neighbour is fetched with the Email/get an open sends (no Email/set:
//   fetching never marks it read; only the message actually opened is marked,
//   by the reading pane's own rule), or taken from memory: the message just
//   left, the push worker's kept copy.
// - The last few full messages stay in memory (NEIGHBOUR_CACHE_SIZE), so a
//   swipe back needs no fetch either.
// - A neighbour is rendered in full (the sanitized body in the same
//   sandboxed, script-free frame and CSP as the reading pane) only below the
//   size caps; a bigger one, a cut body, or one the reading pane would first
//   unwrap or decrypt shows a light preview (sender, subject, first lines).

import type { Email } from '@/lib/jmap/types';

/** Full messages kept for the swipe (the open one, its neighbours, the one before). */
export const NEIGHBOUR_CACHE_SIZE = 4;
/** How long a prepared neighbour stands in for the open's Email/get. */
export const NEIGHBOUR_PRIME_MAX_AGE_MS = 5 * 60_000;
/** A shown body larger than this (UTF-16 code units of its value) is previewed light, not rendered. */
export const NEIGHBOUR_FULL_MAX_CHARS = 200_000;
/** An HTML body with more elements than this is previewed light, not rendered. */
export const NEIGHBOUR_FULL_MAX_TAGS = 6_000;
/** The light preview's text, at most. */
export const NEIGHBOUR_LITE_PREVIEW_CHARS = 400;

export type PeekKind = 'full' | 'lite';

/** Rows whose message the swipe may fetch ahead: the open login's own, not drafts (they open in the composer). */
export function neighbourFetchable(row: Pick<Email, 'id' | 'keywords' | 'sourceAccountId' | 'sourceClientAccountId'> | null | undefined): boolean {
  if (!row?.id) return false;
  if (row.sourceClientAccountId || row.sourceAccountId) return false;
  return !row.keywords?.$draft;
}

const SPECIAL_TYPES = new Set([
  // Decrypted by a plugin first.
  'application/pkcs7-mime', 'application/x-pkcs7-mime',
  // Outlook's winmail.dat, unpacked first.
  'application/ms-tnef', 'application/vnd.ms-tnef',
]);

/** Counts elements in `html` up to `max + 1` (a cheap scan, no parsing). */
export function countTags(html: string, max: number): number {
  let n = 0;
  const re = /<[a-zA-Z]/g;
  while (re.exec(html)) {
    if (++n > max) break;
  }
  return n;
}

/**
 * How a neighbour is shown in its pane: `full` (its rendered body, as the
 * reading pane will show it) or `lite` (sender, subject, first lines).
 */
export function peekKind(email: Email | null | undefined): PeekKind {
  if (!email?.bodyValues) return 'lite';
  const values = email.bodyValues;
  const htmlPart = email.htmlBody?.[0]?.partId;
  const textPart = email.textBody?.[0]?.partId;
  const html = htmlPart ? values[htmlPart] : undefined;
  const text = textPart ? values[textPart] : undefined;
  if (html?.isTruncated || text?.isTruncated) return 'lite';
  if (!html && !text && ((email.htmlBody?.length ?? 0) > 0 || (email.textBody?.length ?? 0) > 0)) return 'lite';
  if ((html?.value.length ?? 0) > NEIGHBOUR_FULL_MAX_CHARS || (text?.value.length ?? 0) > NEIGHBOUR_FULL_MAX_CHARS) return 'lite';
  if (html && countTags(html.value, NEIGHBOUR_FULL_MAX_TAGS) > NEIGHBOUR_FULL_MAX_TAGS) return 'lite';
  for (const a of email.attachments ?? []) {
    const type = (a.type || '').toLowerCase();
    if (SPECIAL_TYPES.has(type) || (a.name || '').toLowerCase() === 'winmail.dat') return 'lite';
    // A forwarded message as the whole content is unwrapped by the reading pane first.
    if (type === 'message/rfc822' && !html && !(text?.value.trim())) return 'lite';
  }
  return 'full';
}

/** The browser asks to save data, or the connection is very slow: prepare nothing ahead. */
export function saveDataRequested(): boolean {
  try {
    const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    return !!c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g');
  } catch {
    return false;
  }
}

const peekCosts = new Map<string, number>();

/**
 * Main-thread ms spent preparing the pane of message `id` (sanitizing, the
 * code detector, the frame document, wiring the frame up); read by the
 * open-speed beacon when the swipe opens it. The last few only.
 */
export function addPeekCost(id: string, ms: number): void {
  if (!id || !(ms >= 0)) return;
  peekCosts.set(id, (peekCosts.get(id) ?? 0) + ms);
  while (peekCosts.size > 8) {
    const oldest = peekCosts.keys().next().value;
    if (oldest === undefined) break;
    peekCosts.delete(oldest);
  }
}

export function peekCost(id: string): number | undefined {
  return peekCosts.get(id);
}

/** Without requestIdleCallback (WebKit): this long after the call stands in for "idle". */
export const IDLE_FALLBACK_MS = 120;

/** `fn` when the browser is idle (at most `timeoutMs` later). Returns a cancel function. */
export function whenIdle(fn: () => void, timeoutMs = 1000): () => void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => fn(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, IDLE_FALLBACK_MS);
  return () => clearTimeout(id);
}
