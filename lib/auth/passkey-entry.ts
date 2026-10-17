// Fork (Wnt/webmail): the passkey entry - signing in where the user is.
//
// With OAuth as the only sign-in and auto-SSO on (one identity provider, one
// server), the login form has nothing to offer. Upstream gets to the provider
// from the client: the app boots, finds no session, loads /login, which loads
// its config and the provider metadata and then navigates away - a page that
// flashes, then four redirects to the provider's page.
//
// Here the page the user opened stays. The locale layout mounts the passkey
// gate (components/auth/passkey-gate.tsx) with what the server knows
// (passkeyGateConfig): whether a session cookie exists at all - so a
// signed-out load has the passkey screen in its first HTML - an explicit
// sign-out, and the provider's first-party endpoints. Against those (same
// origin, draft-ietf-oauth-first-party-apps) the page runs the passkey
// ceremony itself, trades the assertion for a code and redeems it at
// /api/auth/sso/code: signed in with no redirect and no second document. The
// stores' "go to the login page" shows the gate instead
// (stores/passkey-gate-store.ts).
//
// Without first-party endpoints the gate falls back to the redirect flow:
// /api/auth/sso/begin (the same server-side SSO as /api/auth/sso/start, as a
// navigation) with the page's path carried in the encrypted pending cookie.
// That flow's provider errors come back to the callback, which the proxy
// sends to the login route (passkeyEntryRedirect), where the gate offers the
// retry.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers } from '@/lib/admin/jmap-servers';
import { IS_LITE } from '@/lib/lite';
import { decryptPayload } from '@/lib/auth/crypto';
import { locales } from '@/i18n/routing';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { getDiscoveryValidator, getRequiredConfig } from '@/lib/oauth/token-exchange';
import { getOauthScopes } from '@/lib/oauth/tokens';
import { SIGNED_OUT_COOKIE, safeReturnPath } from '@/lib/auth/passkey-entry-shared';

export { SIGNED_OUT_COOKIE };

export const SSO_BEGIN_PATH = '/api/auth/sso/begin';

/** /api/auth/sso/start and .../complete: the encrypted PKCE/state cookie and its lifetime. */
export const SSO_PENDING_COOKIE = 'sso_pending';
export const SSO_PENDING_MAX_AGE_MS = 5 * 60 * 1000;

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
 * mode, or null to render the page: only the redirect flow's provider errors
 * at the callback (access_denied, ...) go to the login route, keeping the
 * page that sign-in was for. Every other page renders, signed in or not.
 */
export function passkeyEntryRedirect(request: NextRequest, pathname: string, locale: string): NextResponse | null {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (request.headers.has('rsc') || request.headers.has('next-router-prefetch')) return null;
  const rest = pathname.slice(locale.length + 1).replace(/\/+$/, '');
  if (rest !== '/auth/callback') return null;
  const q = request.nextUrl.searchParams;
  if (!q.has('error')) return null;
  return redirect(request, `/${locale}/login`, {
    sso_error: ssoErrorCode(q.get('error')),
    return: pendingReturnPath(request, q.get('state')),
  });
}

/**
 * The page the sign-in that just failed was for, so the retry still opens
 * it: from the encrypted pending cookie, only for the flow this callback
 * answers (same state, not expired), and re-checked.
 */
function pendingReturnPath(request: NextRequest, state: string | null): string | null {
  const cookie = request.cookies.get(SSO_PENDING_COOKIE)?.value;
  if (!cookie || !state) return null;
  const pending = decryptPayload(cookie, 'sso-pending');
  if (!pending || pending.state !== state) return null;
  const createdAt = Number(pending.created_at);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > SSO_PENDING_MAX_AGE_MS) return null;
  return safeReturnPath(pending.return_to, request.nextUrl.basePath ?? '');
}

/** `locale` if the app has it, else null. */
export function knownLocale(locale: string | null): string | null {
  return locale && (locales as readonly string[]).includes(locale) ? locale : null;
}

/** What the in-page passkey sign-in needs from the server (components/auth/passkey-gate.tsx). */
export interface PasskeyGateConfig {
  appName: string;
  logoUrl: string;
  locale: string;
  /** The redirect flow's entry (fallback): `<base>/api/auth/sso/begin`. */
  beginAction: string;
  /** The provider's first-party passkey sign-in on this origin, or null (then the redirect flow). */
  firstParty: {
    optionsPath: string;
    authorizePath: string;
    clientId: string;
    scope: string;
    redirectUri: string;
  } | null;
  /** No session cookie at all: the passkey screen is part of the first HTML. */
  noSession: boolean;
  /** Signed out on purpose: the screen waits for the tap. */
  signedOut: boolean;
  /**
   * The user opened this page themselves or from this origin
   * (Sec-Fetch-Site none/same-origin): only then may it ask for the passkey
   * without a tap - another site linking here gets the button.
   */
  autostart: boolean;
}

/** The origin the browser has this page open on (the edge forwards it; cf. wopiBrowserOrigin). */
function browserOrigin(h: Headers): string | null {
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0].trim();
  const proto = (h.get('x-forwarded-proto') ?? '').split(',')[0].trim() || 'http';
  if (!host || (proto !== 'http' && proto !== 'https')) return null;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/** A provider endpoint as a path on `origin`, or null when it lives anywhere else. */
function sameOriginPath(endpoint: string | undefined, origin: string): string | null {
  if (!endpoint) return null;
  try {
    const u = new URL(endpoint);
    if (u.origin !== origin || u.search || u.hash || u.username || u.password) return null;
    // `//host/...` would be a network-path reference to another origin in the browser.
    return u.pathname.startsWith('/') && !u.pathname.startsWith('//') ? u.pathname : null;
  } catch {
    return null;
  }
}

/** For the locale layout; null outside passkey-entry mode. */
export async function passkeyGateConfig(locale: string): Promise<PasskeyGateConfig | null> {
  await configManager.ensureLoaded();
  if (!passkeyEntryEnabled()) return null;
  const { headers, cookies } = await import('next/headers');
  const h = await headers();
  const jar = await cookies();
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
  const asset = (url: string) => (url.startsWith('/') && !url.startsWith('//') ? `${basePath}${url}` : url);
  const site = h.get('sec-fetch-site');

  let firstParty: PasskeyGateConfig['firstParty'] = null;
  const origin = browserOrigin(h);
  if (origin) {
    try {
      const serverId = passkeyEntryServerId();
      const { clientId, discoveryUrl } = getRequiredConfig(serverId);
      const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator(discoveryUrl) });
      const optionsPath = sameOriginPath(metadata?.passkey_challenge_endpoint, origin);
      const authorizePath = sameOriginPath(metadata?.authorization_challenge_endpoint, origin);
      if (optionsPath && authorizePath && clientId) {
        firstParty = {
          optionsPath,
          authorizePath,
          clientId,
          scope: getOauthScopes(),
          redirectUri: `${origin}${basePath}/${locale}/auth/callback`,
        };
      }
    } catch {
      firstParty = null; // the redirect flow still works
    }
  }

  return {
    appName: configManager.get<string>('appName', '') || process.env.NEXT_PUBLIC_APP_NAME || 'Webmail',
    logoUrl: asset(configManager.get<string>('faviconUrl', '') || '/branding/Bulwark_Favicon.svg'),
    locale,
    beginAction: `${basePath}${SSO_BEGIN_PATH}`,
    firstParty,
    noSession: !hasSessionCookie(jar.getAll().map((c) => c.name)),
    signedOut: jar.has(SIGNED_OUT_COOKIE),
    autostart: site === 'none' || site === 'same-origin',
  };
}
