// Fork (Wnt/webmail): straight to the passkey sign-in.
//
// With OAuth as the only sign-in and auto-SSO on (one identity provider, one
// server), the login form has nothing to offer: every signed-out visit goes to
// the provider. Upstream gets there from the client - the app boots, finds no
// session, loads /login, which loads its config and the provider metadata and
// then navigates away - so the login page renders (and flashes) on every
// visit, and its 30 s loop guard leaves it standing with an SSO button. Here
// the proxy answers a signed-out page request with a redirect before any HTML
// (passkeyEntryRedirect) to /api/auth/sso/begin, which starts the same
// server-side SSO flow as /api/auth/sso/start and sends the browser on to the
// provider. The page the visit asked for rides along in the encrypted
// sso_pending cookie and is where the app opens after the callback.
//
// The login page itself becomes a small branded page with one button
// (components/auth/passkey-entry-page.tsx), shown only where an automatic
// sign-in would be wrong: after an explicit sign-out (no loop back in), after
// a failed or cancelled sign-in, and while a session cookie exists that the
// app could not use.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers } from '@/lib/admin/jmap-servers';
import { IS_LITE } from '@/lib/lite';
import { locales } from '@/i18n/routing';
import { SIGNED_OUT_COOKIE, safeReturnPath } from '@/lib/auth/passkey-entry-shared';

export { SIGNED_OUT_COOKIE };

export const SSO_BEGIN_PATH = '/api/auth/sso/begin';

/** The refresh-token cookies (lib/oauth/tokens.ts): `jmap_rt` and `jmap_rt_<slot>`. */
const SESSION_COOKIE = /^jmap_rt(?:_\d+)?$/;

/** OAuth-only with auto-SSO and at most one server: no choice for a login page to offer. */
export function passkeyEntryEnabled(): boolean {
  if (IS_LITE) return false;
  const oauthEnabled = configManager.get<boolean>('oauthEnabled', false);
  if (!oauthEnabled || !configManager.get<boolean>('oauthOnly', false)) return false;
  if (!configManager.get<boolean>('autoSsoEnabled', false)) return false;
  return parseJmapServers(configManager.get<unknown>('jmapServers', [])).length <= 1;
}

/** The server entry the flow signs in to: the single list entry, or none (global config). */
export function passkeyEntryServerId(): string | null {
  const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  return servers.length === 1 ? servers[0].id : null;
}

export function hasSessionCookie(names: Iterable<string>): boolean {
  for (const name of names) if (SESSION_COOKIE.test(name)) return true;
  return false;
}

/** OAuth error codes are `[a-z_]` (RFC 6749 §4.1.2.1); anything else is collapsed. */
export function ssoErrorCode(raw: string | null): string {
  return raw && /^[a-z_]{1,64}$/.test(raw) ? raw : 'sso_failed';
}

/**
 * A relative redirect from a route handler: behind the reverse proxy the
 * server's own origin (`request.nextUrl.origin`) is not the one the browser
 * uses. 303 makes the target a GET; no-store because the answer depends on
 * cookies.
 */
export function relativeRedirect(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/**
 * The proxy's redirect. Next's middleware adapter needs an absolute Location
 * and turns one on the request's own origin back into a relative one, so the
 * internal origin never reaches the browser.
 */
function redirect(request: NextRequest, path: string, params: Record<string, string | null>): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = '';
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url, 303);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * The proxy's answer to a page request under `/<locale>/...` in passkey-entry
 * mode, or null to render the page. `pathname` is the decoded route path
 * (without the base path). Only top-level document loads are redirected: RSC
 * fetches and prefetches of a signed-in app pass through untouched.
 */
export function passkeyEntryRedirect(request: NextRequest, pathname: string, locale: string): NextResponse | null {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (request.headers.has('rsc') || request.headers.has('next-router-prefetch')) return null;
  const rest = pathname.slice(locale.length + 1).replace(/\/+$/, '');
  const loginPath = `/${locale}/login`;

  // The provider sends errors (access_denied, ...) back to the callback: to
  // the branded page with its button, never to an automatic retry.
  if (rest === '/auth/callback') {
    if (!request.nextUrl.searchParams.has('error')) return null;
    return redirect(request, loginPath, { sso_error: ssoErrorCode(request.nextUrl.searchParams.get('error')) });
  }
  if (rest.startsWith('/auth/')) return null;

  if (hasSessionCookie(request.cookies.getAll().map((c) => c.name))) return null;
  const signedOut = request.cookies.has(SIGNED_OUT_COOKIE);
  const basePath = request.nextUrl.basePath ?? '';

  if (rest === '/login') {
    const q = request.nextUrl.searchParams;
    // Shown as a page: after a sign-out or a failed sign-in, and the upstream
    // flows this mode does not take over (adding an account, the mobile app).
    if (signedOut || q.has('sso_error') || q.has('mode') || q.has('mobile_redirect_uri')) return null;
    return redirect(request, SSO_BEGIN_PATH, { locale, return: safeReturnPath(q.get('return'), basePath) });
  }

  const here = safeReturnPath(`${basePath}${request.nextUrl.pathname}${request.nextUrl.search}`, basePath);
  // A visit after an explicit sign-out shows the page with the button, still
  // remembering where the visit was going.
  if (signedOut) return redirect(request, loginPath, { return: here });
  return redirect(request, SSO_BEGIN_PATH, { locale, return: here });
}

/** `locale` if the app has it, else null. */
export function knownLocale(locale: string | null): string | null {
  return locale && (locales as readonly string[]).includes(locale) ? locale : null;
}
