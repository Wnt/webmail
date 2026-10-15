// Fork (Wnt/webmail), audit bulwark-1: the explicit sign-out markers the
// service worker reads (public/sw.js, same cache and keys). See
// lib/push-signout.ts for when they are set.

const PUSH_STATE_CACHE = 'bulwark-push-state-v1';
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const DEVICE_MARKER = 'signed-out-all';

function stateUrl(path: string): string {
  return `${window.location.origin}${BASE_PATH}/__push-state/${path}`;
}

function accountMarkerUrl(accountId: string): string {
  return stateUrl(`signed-out/${encodeURIComponent(accountId)}`);
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
  const marker = () => new Response(JSON.stringify({ at: Date.now() }), {
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
