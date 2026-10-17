// Fork (Wnt/webmail): the passkey entry's pieces that the browser needs too
// (lib/auth/passkey-entry.ts is server-only).
//
// Where a sign-in returns to:
// The passkey entry (lib/auth/passkey-entry.ts) carries the page a signed-out
// visit asked for - a deep link from a notification, a bookmark - through the
// OAuth round trip, so the app opens there afterwards. The value comes from a
// URL, so it is only ever a path on this origin, inside the localized app
// tree, and never a sign-in page (which would start the round trip again).
// Pure: used by the proxy, the SSO routes and the auth store alike.

import { locales } from '@/i18n/routing';

/** Set by the client on an explicit sign-out (stores/auth-store.ts); cleared by the next sign-in. */
export const SIGNED_OUT_COOKIE = 'bulwark_signed_out';
export const SIGNED_OUT_MAX_AGE = 30 * 24 * 60 * 60;

const MAX_RETURN_PATH = 2048;

/**
 * `raw` as a same-origin app path (`<basePath>/<locale>[/...][?query]`), or
 * null. `basePath` is the mount prefix without a trailing slash ('' at the
 * root). Fragments are dropped: the server never sees them anyway.
 */
export function safeReturnPath(raw: unknown, basePath = ''): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_PATH) return null;
  // Only a root-relative path: not `//host`, not `/\host` (browsers read a
  // backslash as a slash), no scheme, no control characters or whitespace.
  if (raw[0] !== '/' || raw[1] === '/' || raw.includes('\\')) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(raw, 'http://return.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://return.invalid') return null;
  let path = url.pathname;
  const base = basePath.replace(/\/+$/, '');
  if (base) {
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    path = path.slice(base.length) || '/';
  }
  // Dot segments were resolved by URL(); encoded ones must not sneak back in.
  if (/%2e|%2f|%5c/i.test(path)) return null;
  const segments = path.split('/');
  const locale = segments[1];
  if (!locale || !(locales as readonly string[]).includes(locale)) return null;
  const rest = segments.slice(2).join('/');
  if (rest === 'login' || rest.startsWith('login/') || rest === 'auth' || rest.startsWith('auth/')) return null;
  return `${base}${path}${url.search}`;
}
