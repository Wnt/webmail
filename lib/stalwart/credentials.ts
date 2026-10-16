import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { assertBasicAuthMatchesUsername, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { sessionAuthHeader, type SessionCredentials } from '@/lib/auth/crypto';

export interface StalwartCredentials {
  /** URL of the JMAP server (used for JMAP + management method calls) */
  serverUrl: string;
  authHeader: string;
  username: string;
  hasSessionCookie: boolean;
  slot: number;
  /**
   * Whether `serverUrl` matches an admin-configured server. A `false` here
   * means the user picked the URL themselves (`allowCustomJmapEndpoint`), so
   * server-side requests to it must use the rebinding-safe fetch - see
   * `fetchJmapServer` in `@/lib/stalwart/server-fetch`.
   */
  trusted: boolean;
}

function parseSlot(raw: string | null): number | null {
  if (raw === null) return null;
  const slot = parseInt(raw, 10);
  return Number.isNaN(slot) || slot < 0 || slot >= MAX_ACCOUNT_SLOTS ? null : slot;
}

const ALL_SLOTS = Array.from({ length: MAX_ACCOUNT_SLOTS }, (_, i) => i);

function getCandidateSlots(request: NextRequest): number[] {
  const requestedSlot = parseSlot(request.headers.get('X-JMAP-Cookie-Slot'))
    ?? parseSlot(request.nextUrl.searchParams.get('slot'));

  return requestedSlot === null ? ALL_SLOTS : [requestedSlot];
}

export async function getStalwartCredentials(request: NextRequest): Promise<StalwartCredentials | null> {
  const cookieStore = await cookies();

  for (const slot of getCandidateSlots(request)) {
    const context = readStalwartAuthContextFromStore(cookieStore, slot);
    if (!context) continue;

    const serverUrl = context.serverUrl.replace(/\/+$/, '');
    return {
      serverUrl,
      authHeader: context.authHeader,
      username: context.username,
      hasSessionCookie: !!cookieStore.get(sessionCookieName(slot))?.value,
      slot,
      trusted: await isTrustedJmapServerUrl(serverUrl),
    };
  }

  return null;
}

// Fork (Wnt/webmail), audit bulwark-4: capabilities that act only on this
// server (a public fetch proxy, instance details, plugin approvals, synced
// settings, translation) never present the credential to the mail server, so
// decrypting a cookie proved nothing about it being live: a copied cookie kept
// working after sign-out and grant revocation. These callers check the
// credential with the mail server first, as the account archive does. A
// success is remembered briefly so a burst of requests costs one round trip;
// a failure is never cached. Routes that forward the credential to the mail
// server are checked by the mail server itself and need none of this.
const VERIFIED_TTL_MS = 60 * 1000;
const VERIFIED_MAX_ENTRIES = 256;
const verifiedCredentials = new Map<string, number>();

export interface CredentialToVerify {
  serverUrl: string;
  authHeader: string;
  username: string;
  /** Computed from the configured servers when not given. */
  trusted?: boolean;
}

/** Whether the mail server accepts this credential right now (cached for a minute on success). */
export async function isLiveCredential(cred: CredentialToVerify): Promise<boolean> {
  const serverUrl = cred.serverUrl.replace(/\/+$/, '');
  const key = createHash('sha256').update(`${serverUrl}\0${cred.authHeader}\0${cred.username}`).digest('base64url');
  const now = Date.now();
  const verifiedUntil = verifiedCredentials.get(key);
  if (verifiedUntil !== undefined && verifiedUntil > now) return true;
  verifiedCredentials.delete(key);
  try {
    assertBasicAuthMatchesUsername(cred.authHeader, cred.username);
    const trusted = cred.trusted ?? await isTrustedJmapServerUrl(serverUrl);
    await verifyJmapAuth(serverUrl, cred.authHeader, { trusted });
  } catch {
    return false;
  }
  if (verifiedCredentials.size >= VERIFIED_MAX_ENTRIES) {
    for (const [k, until] of verifiedCredentials) if (until <= now) verifiedCredentials.delete(k);
    if (verifiedCredentials.size >= VERIFIED_MAX_ENTRIES) {
      verifiedCredentials.delete(verifiedCredentials.keys().next().value!);
    }
  }
  verifiedCredentials.set(key, now + VERIFIED_TTL_MS);
  return true;
}

/** A remembered-session cookie's credentials, only while the mail server still accepts them. */
export async function isLiveSession(session: SessionCredentials): Promise<boolean> {
  return isLiveCredential({
    serverUrl: session.serverUrl,
    username: session.username,
    authHeader: sessionAuthHeader(session),
  });
}

/**
 * {@link getStalwartCredentials}, but only when the mail server still accepts
 * the credential. Null when there is none, or it is expired or revoked.
 */
export async function getVerifiedStalwartCredentials(request: NextRequest): Promise<StalwartCredentials | null> {
  const creds = await getStalwartCredentials(request);
  if (!creds) return null;
  return (await isLiveCredential(creds)) ? creds : null;
}
