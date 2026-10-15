import { cookies } from 'next/headers';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { getCookieOptions } from '@/lib/oauth/cookie-config';

const STALWART_AUTH_CONTEXT_COOKIE = 'jmap_stalwart_ctx';

export interface StalwartAuthContext {
  serverUrl: string;
  username: string;
  authHeader: string;
  /**
   * The account the credential belongs to, when it differs from the login
   * name the client claimed (see ResolvedJmapIdentity.accountName). Per-user
   * data such as synced settings is keyed on this.
   */
  accountName?: string;
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export function stalwartAuthContextCookieName(slot: number): string {
  return slot === 0 ? STALWART_AUTH_CONTEXT_COOKIE : `${STALWART_AUTH_CONTEXT_COOKIE}_${slot}`;
}

function isValidContext(payload: unknown): payload is StalwartAuthContext {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  // A session context is exactly these three strings. The envelope purpose
  // already keeps blobs minted elsewhere out; rejecting the markers those
  // blobs carry is the second lock, so an office editor token or a pairing
  // proof cannot be read back as a signed-in session even if it reaches this
  // function by some other route (GHSA-cqqx-mjcf-mh55).
  if (candidate.t !== undefined || candidate.purpose !== undefined) {
    return false;
  }
  return typeof candidate.serverUrl === 'string'
    && typeof candidate.username === 'string'
    && typeof candidate.authHeader === 'string'
    && (candidate.accountName === undefined || typeof candidate.accountName === 'string');
}

// Fork (Wnt/webmail), audit bulwark-4: the envelope carries its own expiry.
// The cookie is a browser-session cookie, but a copied value used to stay
// valid for ever: decrypting it was all the server checked. A live client
// re-seals the context on every sign-in, session restore, account switch and
// token renewal, so these bounds only cut off copies that nobody renews. A
// Bearer context is renewed with its access token; a Basic one only on
// page loads, hence the longer bound.
const BEARER_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;
const BASIC_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function contextTtlMs(authHeader: string): number {
  return /^Bearer\s/i.test(authHeader) ? BEARER_CONTEXT_TTL_MS : BASIC_CONTEXT_TTL_MS;
}

/**
 * True while the envelope's expiry lies ahead (and no further out than its
 * kind allows). An envelope without one predates the bound and is refused:
 * the client re-seals it on its next session restore.
 */
function isUnexpired(payload: Record<string, unknown>, authHeader: string): boolean {
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  const now = Date.now();
  return exp > now && exp <= now + contextTtlMs(authHeader);
}

function getSessionCookieOptions() {
  const { maxAge: _maxAge, ...cookieOptions } = getCookieOptions();
  return cookieOptions;
}

export function readStalwartAuthContextFromStore(
  cookieStore: CookieStore,
  slot: number,
): StalwartAuthContext | null {
  const token = cookieStore.get(stalwartAuthContextCookieName(slot))?.value;
  if (!token) return null;

  const payload = decryptPayload(token, 'session-context');
  if (!isValidContext(payload)) return null;
  if (!isUnexpired(payload as unknown as Record<string, unknown>, payload.authHeader)) return null;

  // Hand back exactly the declared shape: the envelope's own bookkeeping
  // stays in the envelope rather than riding along into the credentials.
  const { serverUrl, username, authHeader, accountName } = payload;
  return accountName ? { serverUrl, username, authHeader, accountName } : { serverUrl, username, authHeader };
}

export async function readStalwartAuthContext(slot: number): Promise<StalwartAuthContext | null> {
  const cookieStore = await cookies();
  return readStalwartAuthContextFromStore(cookieStore, slot);
}

export function setStalwartAuthContextInStore(
  cookieStore: CookieStore,
  slot: number,
  context: StalwartAuthContext,
): void {
  cookieStore.set(
    stalwartAuthContextCookieName(slot),
    encryptPayload(
      { ...context, exp: Date.now() + contextTtlMs(context.authHeader) } as unknown as Record<string, unknown>,
      'session-context',
    ),
    getSessionCookieOptions(),
  );
}

export async function setStalwartAuthContext(slot: number, context: StalwartAuthContext): Promise<void> {
  const cookieStore = await cookies();
  setStalwartAuthContextInStore(cookieStore, slot, context);
}

export function clearStalwartAuthContextInStore(cookieStore: CookieStore, slot: number): void {
  cookieStore.delete(stalwartAuthContextCookieName(slot));
}

export async function clearStalwartAuthContext(slot: number): Promise<void> {
  const cookieStore = await cookies();
  clearStalwartAuthContextInStore(cookieStore, slot);
}