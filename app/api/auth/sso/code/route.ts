// Fork (Wnt/webmail): the first-party passkey sign-in's half of the code
// exchange (components/auth/passkey-gate.tsx). The page signed in at the
// provider's first-party endpoint (same origin, draft-ietf-oauth-first-party-
// apps) and holds an authorization code plus the PKCE verifier it made for
// it; this route redeems them exactly as /api/auth/sso/complete redeems a code
// from the redirect flow (client secret, redirect URI, verifier) and leaves
// the same cookies. No pending cookie is needed: the verifier never left the
// page, and the provider bound the code to its challenge, the client and the
// callback URI below.

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { exchangeCodeForTokens } from '@/lib/oauth/token-exchange';
import { writeLoginCookies } from '@/lib/oauth/login-cookies';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { wopiBrowserOrigin } from '@/lib/wopi/origin';
import { SIGNED_OUT_COOKIE } from '@/lib/auth/passkey-entry-shared';
import { knownLocale, passkeyEntryEnabled, passkeyEntryServerId } from '@/lib/auth/passkey-entry';

/** RFC 7636 verifier: 43-128 unreserved characters. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** The callback URI the page signed in for: this origin's `<base>/<locale>/auth/callback`, nothing else. */
function callbackUri(request: NextRequest, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.href !== raw || url.search || url.hash || url.username || url.password) return null;
  if (url.origin !== wopiBrowserOrigin(request)) return null;
  const basePath = request.nextUrl.basePath ?? '';
  const m = url.pathname.match(/^(.*)\/([^/]+)\/auth\/callback$/);
  if (!m || m[1] !== basePath || !knownLocale(m[2])) return null;
  return raw;
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): the cookies written here are SameSite=Lax.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  await configManager.ensureLoaded();
  if (!passkeyEntryEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const code = typeof body.code === 'string' && body.code.length <= 512 ? body.code : '';
  const codeVerifier = typeof body.code_verifier === 'string' && CODE_VERIFIER.test(body.code_verifier) ? body.code_verifier : '';
  const redirectUri = callbackUri(request, body.redirect_uri);
  if (!code || !codeVerifier || !redirectUri) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  // Same slot rule as /api/auth/sso/complete.
  const slot = typeof body.slot === 'number' && Number.isInteger(body.slot) && body.slot >= 0 && body.slot < MAX_ACCOUNT_SLOTS ? body.slot : 0;

  const cookieStore = await cookies();
  try {
    const serverId = passkeyEntryServerId();
    const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri, serverId);
    writeLoginCookies(cookieStore, slot, tokens, serverId, request.nextUrl.basePath);
    // Signed in again: an explicit sign-out no longer holds.
    cookieStore.delete({ name: SIGNED_OUT_COOKIE, path: `${request.nextUrl.basePath ?? ''}/` });
    return NextResponse.json(
      { access_token: tokens.access_token, expires_in: tokens.expires_in },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logger.error('SSO code exchange error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 401 });
  }
}
