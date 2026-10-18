// Fork (Wnt/webmail): the message link a page was opened at - a tapped
// notification's URL (WebKit loads it as a new document; Chromium's
// openWindow on a cold start), a bookmark - read from the URL the page
// started with. The auth store uses it to start fetching that message as soon
// as the session is up (stores/auth-store.ts prefetchStartMessage).

import { locales } from '@/i18n/routing';
import { getPathPrefix } from '@/lib/browser-navigation';
import { parseMailPath } from '@/lib/deep-links';

const START = typeof window !== 'undefined'
  ? { pathname: window.location.pathname, search: window.location.search }
  : null;
let taken = false;

/** The message the page's start URL names, if it is a message link of this browser's own login. */
export function startMessageLink(start: { pathname: string; search: string } | null = START): { id: string; slot?: number } | null {
  if (!start) return null;
  try {
    const prefix = getPathPrefix();
    let path = start.pathname;
    if (prefix) {
      if (path !== prefix && !path.startsWith(prefix + '/')) return null;
      path = path.slice(prefix.length);
    }
    const segments = path.split('/').filter(Boolean).map((s) => s);
    if (segments.length > 0 && (locales as readonly string[]).includes(segments[0])) segments.shift();
    if (segments[0] !== 'mail') return null;
    const link = parseMailPath(segments.slice(1), new URLSearchParams(start.search));
    // A link naming another login (?account=) waits for that login to connect.
    if (!link || link.kind !== 'message' || link.accountId) return null;
    return { id: link.id, slot: link.slot };
  } catch {
    return null;
  }
}

/**
 * The start URL's message link, once per page, when it is for the login in
 * `slot` (a notification names its login by cookie slot; a link without one
 * is for the login the page starts with).
 */
export function takeStartMessageLink(slot: number | undefined): { id: string } | null {
  if (taken) return null;
  taken = true;
  const link = startMessageLink();
  if (!link) return null;
  if (link.slot !== undefined && link.slot !== slot) return null;
  return { id: link.id };
}

/** Tests only. */
export function __resetStartMessageLink(): void {
  taken = false;
}
