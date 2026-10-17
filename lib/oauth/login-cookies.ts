// Fork (Wnt/webmail): the cookies a completed OAuth sign-in leaves for its
// cookie slot - refresh token, the server entry that minted it, the id token
// for sign-out. Shared by the redirect flow's /api/auth/sso/complete and the
// first-party passkey sign-in's /api/auth/sso/code, so both sign in the same.

import { refreshTokenCookieName, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { storeIdToken } from '@/lib/oauth/end-session';

import type { cookies } from 'next/headers';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export function writeLoginCookies(
  cookieStore: CookieStore,
  slot: number,
  tokens: { refresh_token?: string; id_token?: unknown },
  serverId: string | null,
  basePath: string | undefined,
): void {
  if (tokens.refresh_token) {
    cookieStore.set(refreshTokenCookieName(slot), tokens.refresh_token, getCookieOptions());
  }
  const serverCookieName = refreshTokenServerCookieName(slot);
  if (serverId) {
    cookieStore.set(serverCookieName, serverId, getCookieOptions());
  } else {
    cookieStore.delete(serverCookieName);
  }
  storeIdToken(cookieStore, slot, tokens.id_token, basePath, [tokens.refresh_token, serverId]);
}
