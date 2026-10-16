// Fork (Wnt/webmail), audit bulwark-1: the explicit sign-out state shared by
// the page, every tab and the service worker. See lib/push-signout.ts for
// when a sign-out happens.
//
// Protocol:
// - Sign-out generation (localStorage, synchronous, shared by every tab):
//   a per-account counter and a device-wide one. An explicit sign-out bumps
//   them synchronously before anything else. They only ever grow.
// - Markers (Cache Storage, read by public/sw.js): written by a sign-out,
//   lifted only by a user-initiated enable (account and device marker) or a
//   deliberate sign-in (device marker).
// - Every marker mutation and every push enable commit runs inside
//   withPushLock, a Web Lock shared by every tab. An enable notes the
//   generation when the user (or a background re-sync) starts it and, after
//   all its network work, commits under the lock only if the generation is
//   unchanged. Otherwise the account was signed out meanwhile, in any tab,
//   and the enable undoes what it created instead.
// - Commit generation (localStorage): bumped by each successful commit, so a
//   superseded enable's rollback never removes a newer enable's record.

const PUSH_STATE_CACHE = 'bulwark-push-state-v1';
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const DEVICE_MARKER = 'signed-out-all';
const SIGNOUT_GEN_PREFIX = 'bulwark.push.signOutGen.v1.';
const DEVICE_SIGNOUT_GEN = `${SIGNOUT_GEN_PREFIX}*`;
const COMMIT_GEN_PREFIX = 'bulwark.push.commitGen.v1.';
const LOCK_NAME = 'bulwark-push-signout';

function stateUrl(path: string): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/${path}`;
}

function accountMarkerUrl(accountId: string): string {
  return stateUrl(`signed-out/${encodeURIComponent(accountId)}`);
}

/** Run `fn` holding the cross-tab push lock (directly where Web Locks are unavailable). Not reentrant. */
export async function withPushLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: LockManager }).locks
    : undefined;
  if (!locks?.request) return fn();
  return locks.request(LOCK_NAME, fn) as Promise<T>;
}

function readCounter(key: string): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function bumpCounter(key: string): void {
  try {
    localStorage.setItem(key, String(readCounter(key) + 1));
  } catch {
    // No storage: no cross-tab protection, the markers still apply.
  }
}

/** Synchronously record that these accounts (and with `everyAccount`, the device) are being signed out. */
export function bumpSignOutGeneration(accountIds: string[], everyAccount: boolean): void {
  for (const accountId of accountIds) bumpCounter(SIGNOUT_GEN_PREFIX + accountId);
  if (everyAccount) bumpCounter(DEVICE_SIGNOUT_GEN);
}

/** The account's sign-out generation now; changes whenever it (or the device) is signed out. */
export function signOutGeneration(accountId: string): string {
  return `${readCounter(DEVICE_SIGNOUT_GEN)}:${readCounter(SIGNOUT_GEN_PREFIX + accountId)}`;
}

/** Bumped (under the lock) by every committed enable of the account. */
export function commitGeneration(accountId: string): number {
  return readCounter(COMMIT_GEN_PREFIX + accountId);
}

export function bumpCommitGeneration(accountId: string): void {
  bumpCounter(COMMIT_GEN_PREFIX + accountId);
}

// Sign-outs this tab is still tearing down, per account: an enable started
// meanwhile waits for them, so the two never work on one account at once.
const teardownsInProgress = new Map<string, Promise<unknown>>();

export function trackTeardown(accountIds: string[], work: Promise<unknown>): void {
  const settled = work.catch(() => undefined);
  for (const accountId of accountIds) {
    teardownsInProgress.set(accountId, settled);
    void settled.then(() => {
      if (teardownsInProgress.get(accountId) === settled) teardownsInProgress.delete(accountId);
    });
  }
}

export async function teardownSettled(accountId: string): Promise<void> {
  await teardownsInProgress.get(accountId);
}

async function pushStateCache(): Promise<Cache | null> {
  if (typeof window === 'undefined' || typeof caches === 'undefined') return null;
  try {
    return await caches.open(PUSH_STATE_CACHE);
  } catch {
    return null;
  }
}

/**
 * Mark the accounts (and with `everyAccount`, the whole device) as signed out
 * for the service worker. Call inside withPushLock.
 */
export async function markPushSignedOutLocked(accountIds: string[], everyAccount: boolean): Promise<void> {
  const cache = await pushStateCache();
  if (!cache) return;
  const marker = () => new Response(JSON.stringify({ at: Date.now() }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const urls = accountIds.map(accountMarkerUrl);
  if (everyAccount) urls.push(stateUrl(DEVICE_MARKER));
  await Promise.all(urls.map((url) => cache.put(url, marker()).catch(() => undefined)));
}

/** Lift the device-wide marker and, with `accountId`, that account's. Call inside withPushLock. */
export async function clearPushSignedOutLocked(accountId: string | null): Promise<void> {
  const cache = await pushStateCache();
  if (!cache) return;
  const urls = [stateUrl(DEVICE_MARKER)];
  if (accountId) urls.push(accountMarkerUrl(accountId));
  await Promise.all(urls.map((url) => cache.delete(url).catch(() => false)));
}

/**
 * {@link clearPushSignedOutLocked} under the lock. A deliberate sign-in lifts
 * the device-wide marker this way; an account's marker is lifted only by a
 * user-initiated enable (see enableWebPush).
 */
export function clearPushSignedOut(accountId: string | null): Promise<void> {
  return withPushLock(() => clearPushSignedOutLocked(accountId));
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
