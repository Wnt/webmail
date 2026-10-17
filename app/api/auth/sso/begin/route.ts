// Fork (Wnt/webmail): the top-level entry into server-side SSO for the
// passkey entry (lib/auth/passkey-entry.ts). The same flow as
// /api/auth/sso/start - PKCE, state and the encrypted sso_pending cookie,
// completed by /api/auth/sso/complete from the callback page - but reached by
// a plain navigation (the proxy's redirect, or the branded page's button), so
// it answers with a redirect to the provider instead of JSON, and no page
// renders on the way.
//
// Being a GET, any site can send a browser here. That only starts a sign-in:
// the provider asks for the user's own passkey, the code comes back to this
// origin's callback, and the pending cookie only ever names this origin's
// callback and a validated same-origin return path.

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { encryptPayload } from '@/lib/auth/crypto';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { generateCodeVerifierServer, generateCodeChallengeServer, generateStateServer } from '@/lib/oauth/pkce-server';
import { getRequiredConfig, getDiscoveryValidator } from '@/lib/oauth/token-exchange';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { getOauthScopes } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { configManager } from '@/lib/admin/config-manager';
import { wopiBrowserOrigin } from '@/lib/wopi/origin';
import { routing } from '@/i18n/routing';
import { safeReturnPath } from '@/lib/auth/passkey-entry-shared';
import {
  SIGNED_OUT_COOKIE,
  knownLocale,
  passkeyEntryEnabled,
  passkeyEntryServerId,
  relativeRedirect,
} from '@/lib/auth/passkey-entry';

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE = 300; // 5 minutes, as /api/auth/sso/start

function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

export async function GET(request: NextRequest) {
  await configManager.ensureLoaded();
  if (!passkeyEntryEnabled()) return new NextResponse('Not Found', { status: 404 });
  const basePath = request.nextUrl.basePath ?? '';
  const locale = knownLocale(request.nextUrl.searchParams.get('locale')) ?? routing.defaultLocale;
  const toLoginPage = (error: string) => noStore(relativeRedirect(`${basePath}/${locale}/login?sso_error=${error}`));

  try {
    if (!hasSessionSecret()) {
      logger.error('SSO begin: SESSION_SECRET is required for SSO');
      return toLoginPage('server_error');
    }
    const serverId = passkeyEntryServerId();
    const { clientId, discoveryUrl } = getRequiredConfig(serverId);
    const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator(discoveryUrl) });
    if (!metadata?.authorization_endpoint) {
      logger.warn('SSO begin: OAuth discovery failed');
      return toLoginPage('temporarily_unavailable');
    }

    // The callback on the origin the browser has this webmail open on (the
    // proxy forwards it; see wopiBrowserOrigin). The provider only accepts
    // the callbacks registered for this client, so a forged Host gets nowhere.
    const redirectUri = `${wopiBrowserOrigin(request)}${basePath}/${locale}/auth/callback`;
    const returnTo = safeReturnPath(request.nextUrl.searchParams.get('return'), basePath);

    const codeVerifier = generateCodeVerifierServer();
    const state = generateStateServer();
    const pending = {
      state,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      created_at: Date.now(),
      ...(serverId ? { server_id: serverId } : {}),
      ...(returnTo ? { return_to: returnTo } : {}),
    };

    const authorizeOverride =
      configManager.get<string>('oauthAuthorizeUrl', '') || process.env.OAUTH_AUTHORIZE_URL;
    const authUrl = new URL(authorizeOverride?.trim() || metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', getOauthScopes());
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', generateCodeChallengeServer(codeVerifier));
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('ui_locales', locale);

    const res = noStore(NextResponse.redirect(authUrl, 303));
    res.cookies.set(SSO_PENDING_COOKIE, encryptPayload(pending, 'sso-pending'), {
      ...getCookieOptions(),
      maxAge: SSO_PENDING_MAX_AGE,
    });
    // The user asked to sign in again: the sign-out no longer holds.
    res.cookies.delete({ name: SIGNED_OUT_COOKIE, path: `${basePath}/` });
    return res;
  } catch (error) {
    logger.error('SSO begin error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return toLoginPage('server_error');
  }
}
