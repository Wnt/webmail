// Fork (Wnt/webmail), audit bulwark-1: the explicit sign-out markers the
// service worker reads (public/sw.js, same cache and keys). See
// lib/push-signout.ts for when they are set.
//
// Protocol: a sign-out writes its markers, and a push enable commits (records
// its opt-in, lifts markers), only inside withPushLock - a Web Lock shared by
// every tab. Each marker carries a fresh id; an enable notes the ids present
// when it starts and refuses to commit if any other id has appeared since,
// i.e. if the account was signed out (in any tab) while it ran.

const PUSH_STATE_CACHE = 'bulwark-push-state-v1';
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const DEVICE_MARKER = 'signed-out-all';

function stateUrl(path: string): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/${path}`;
}

function accountMarkerUrl(accountId: string): string {
  return stateUrl(`signed-out/${encodeURIComponent(accountId)}`);
}

const LOCK_NAME = 'bulwark-push-signout';

/** Run `fn` holding the cross-tab push sign-out lock (directly where Web Locks are unavailable). */
export async function withPushLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: LockManager }).locks
    : undefined;
  if (!locks?.request) return fn();
  return locks.request(LOCK_NAME, fn) as Promise<T>;
}

function newMarkerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pushStateCache(): Promise<Cache | null> {
  if (typeof window === 'undefined' || typeof caches === 'undefined') return null;
  try {
    return await caches.open(PUSH_STATE_CACHE);
  } catch {
    return null;
  }
}

/** Mark the accounts (and with `everyAccount`, the whole device) as signed out for the service worker. */
export async function markPushSignedOut(accountIds: string[], everyAccount: boolean): Promise<void> {
  const cache = await pushStateCache();
  if (!cache) return;
  const marker = () => new Response(JSON.stringify({ at: Date.now(), id: newMarkerId() }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const urls = accountIds.map(accountMarkerUrl);
  if (everyAccount) urls.push(stateUrl(DEVICE_MARKER));
  await Promise.all(urls.map((url) => cache.put(url, marker()).catch(() => undefined)));
}

/**
 * Lift the sign-out markers: the device-wide one, and with `accountId` that
 * account's. Push for an account needs a fresh opt-in after an explicit
 * sign-out, so only enabling it clears the account's marker.
 */
export async function clearPushSignedOut(accountId: string | null): Promise<void> {
  const cache = await pushStateCache();
  if (!cache) return;
  const urls = [stateUrl(DEVICE_MARKER)];
  if (accountId) urls.push(accountMarkerUrl(accountId));
  await Promise.all(urls.map((url) => cache.delete(url).catch(() => false)));
}

// An enable that was already running when the user signed the account out
// must not finish afterwards: it would recreate the subscription the
// sign-out just removed and lift the marker. Each explicit sign-out bumps
// the account's epoch; enableWebPush compares the epoch it started with.
const signOutEpochs = new Map<string, number>();

export function noteExplicitSignOut(accountId: string): void {
  signOutEpochs.set(accountId, (signOutEpochs.get(accountId) ?? 0) + 1);
}

export function signOutEpoch(accountId: string): number {
  return signOutEpochs.get(accountId) ?? 0;
}

/** True while the account (or the whole device) carries an explicit sign-out marker. */
export async function isPushSignedOut(accountId: string): Promise<boolean> {
  const cache = await pushStateCache();
  if (!cache) return false;
  try {
    return !!(await cache.match(stateUrl(DEVICE_MARKER)) || await cache.match(accountMarkerUrl(accountId)));
  } catch {
    return false;
  }
}

// Which JMAP account (the id pushes carry) a login entry was last connected
// as. Lets an explicit sign-out silence an account whose client is not
// connected right now (a failed or pending restore).
const LOGIN_ACCOUNT_PREFIX = 'bulwark.push.loginAccount.v1.';

export function rememberPushAccount(loginId: string, jmapAccountId: string): void {
  if (!loginId || !jmapAccountId) return;
  try {
    localStorage.setItem(LOGIN_ACCOUNT_PREFIX + loginId, jmapAccountId);
  } catch {
    // No storage: only connected clients can be signed out of push.
  }
}

export function pushAccountOfLogin(loginId: string): string | null {
  try {
    return localStorage.getItem(LOGIN_ACCOUNT_PREFIX + loginId);
  } catch {
    return null;
  }
}

export function forgetPushAccountOfLogin(loginId: string): void {
  try {
    localStorage.removeItem(LOGIN_ACCOUNT_PREFIX + loginId);
  } catch {
    // Nothing recorded.
  }
}

/**
 * The ids of the sign-out markers that apply to the account now (its own and
 * the device-wide one). Compare with {@link signedOutSince}.
 */
export async function signOutMarkerIds(accountId: string): Promise<string[]> {
  const cache = await pushStateCache();
  if (!cache) return [];
  const ids: string[] = [];
  for (const url of [stateUrl(DEVICE_MARKER), accountMarkerUrl(accountId)]) {
    try {
      const res = await cache.match(url);
      if (!res) continue;
      const body = await res.json().catch(() => null) as { id?: unknown; at?: unknown } | null;
      ids.push(typeof body?.id === 'string' ? body.id : `${url}@${String(body?.at ?? '')}`);
    } catch {
      // Unreadable: treat as absent.
    }
  }
  return ids;
}

/** True when a sign-out marker for the account appeared that was not among `before`. */
export async function signedOutSince(accountId: string, before: string[]): Promise<boolean> {
  return (await signOutMarkerIds(accountId)).some((id) => !before.includes(id));
}
