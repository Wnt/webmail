// Fork (Wnt/webmail), audit bulwark-1: an explicit sign-out ends Web Push on
// this device. Only a sign-out the user asked for comes here; a session or
// token that merely expired keeps push working, and the service worker keeps
// showing the payload preview when /api/push/preview answers 401.
//
// The teardown (JMAP PushSubscription, relay record, browser subscription)
// needs the network, so it is backed by a marker the service worker reads in
// Cache Storage: pushes for a signed-out account are dropped, and after a
// sign-out of every account the worker also drops the browser subscription.
// The marker is cleared when push is enabled again, and the device-wide one
// also on a deliberate sign-in.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { disableWebPush, dropRelayRegistration, forgetWebPushRegistration, locallyOptedInAccounts } from '@/lib/web-push';
import { currentRelayUrl } from '@/lib/push-relay-current';
import {
  bumpSignOutGeneration, commitGeneration, markPushSignedOutLocked, pushAccountOfLogin, trackTeardown, withPushLock,
} from '@/lib/push-signout-state';

export { clearPushSignedOut } from '@/lib/push-signout-state';

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const SW_SCOPE = `${BASE_PATH}/`;
const NOTIFICATION_TAG_PREFIX = 'bulwark-mail:';

// The network part of the teardown may not hold the sign-out up for longer:
// the marker already silences the device, and the server side goes on in the
// background.
const TEARDOWN_TIMEOUT_MS = 8000;
// How long the sign-out waits for the worker to confirm (see settleWorker).
const WORKER_SETTLE_TIMEOUT_MS = 6000;

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration(SW_SCOPE)) ?? null;
  } catch {
    return null;
  }
}

function accountIdOf(client: IJMAPClient): string | null {
  try {
    return client.getAccountId() || null;
  } catch {
    return null;
  }
}

async function closeNotifications(accountIds: string[], everyAccount: boolean): Promise<void> {
  const registration = await swRegistration();
  if (!registration || typeof registration.getNotifications !== 'function') return;
  const tags = new Set(accountIds.map((id) => NOTIFICATION_TAG_PREFIX + id));
  try {
    for (const notification of await registration.getNotifications()) {
      const tag = notification.tag || '';
      if (tags.has(tag) || (everyAccount && tag.startsWith(NOTIFICATION_TAG_PREFIX))) notification.close();
    }
  } catch {
    // Nothing on screen to close.
  }
}

async function unsubscribeBrowser(): Promise<void> {
  const registration = await swRegistration();
  try {
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    // The service worker drops the subscription on the next push instead.
  }
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([work.then(() => undefined, () => undefined), timeout])
    .finally(() => clearTimeout(timer));
}

/**
 * Ask the service worker to settle the pushes it is handling for these
 * accounts (see handlePushSignOut in public/sw.js) and wait for its answer:
 * once it comes, no notification for them can still be on its way.
 */
async function settleWorker(accountIds: string[], everyAccount: boolean): Promise<WorkerSettlement> {
  const registration = await swRegistration();
  const worker = registration?.active;
  if (!worker || typeof MessageChannel === 'undefined') return 'no-worker';
  const channel = new MessageChannel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = new Promise<WorkerSettlement>((resolve) => {
    channel.port1.onmessage = (e: MessageEvent) => resolve((e.data as { done?: unknown })?.done === true ? 'settled' : 'pending');
    timer = setTimeout(() => resolve('pending'), WORKER_SETTLE_TIMEOUT_MS);
  });
  try {
    worker.postMessage({ type: 'push-signout', accountIds, everyAccount }, [channel.port2]);
    return await answer;
  } catch {
    return 'pending';
  } finally {
    clearTimeout(timer);
    channel.port1.close();
  }
}

/**
 * 'settled': the worker drained every push it was handling for these
 * accounts and closed their notifications. 'pending': it did not confirm in
 * time; it keeps suppressing them (markers, in-progress flag) and settles on
 * its own, but the sign-out goes on without that guarantee. 'no-worker':
 * nothing was being handled.
 */
export type WorkerSettlement = 'settled' | 'pending' | 'no-worker';

/**
 * Turn Web Push off for the accounts being signed out on purpose. Call it
 * before their clients disconnect and their tokens are revoked: destroying
 * the JMAP PushSubscription needs the still-valid credential.
 *
 * `clients`: the connected clients of those logins. `loginIds`: the login
 * entries, so an account without a connected client is silenced too (its
 * relay record goes; the JMAP record expires on the server).
 * `unmappedFallback`: one of the logins could not be mapped to a push account
 * (it never connected since this mapping exists); every local opt-in not in
 * `keep` (the accounts that stay) is turned off too, so nothing unknown can
 * keep notifying. Those accounts need a fresh opt-in.
 * `everyAccount`: nobody stays signed in on this device, so every account
 * with a push opt-in here and the browser's push subscription go too.
 */
export function teardownPushOnSignOut(params: {
  clients: IJMAPClient[];
  loginIds?: string[];
  unmappedFallback?: { keep: string[] };
  everyAccount: boolean;
}): Promise<{ worker: WorkerSettlement }> {
  if (typeof window === 'undefined') return Promise.resolve({ worker: 'no-worker' });
  const targets = new Map<string, IJMAPClient | null>();
  for (const client of params.clients) {
    const accountId = accountIdOf(client);
    if (accountId) targets.set(accountId, client);
  }
  for (const loginId of params.loginIds ?? []) {
    const accountId = pushAccountOfLogin(loginId);
    if (accountId && !targets.has(accountId)) targets.set(accountId, null);
  }
  if (params.everyAccount || params.unmappedFallback) {
    const keep = params.everyAccount ? [] : params.unmappedFallback!.keep;
    for (const accountId of locallyOptedInAccounts()) {
      if (!targets.has(accountId) && !keep.includes(accountId)) targets.set(accountId, null);
    }
  }
  const accountIds = [...targets.keys()];
  // First, synchronously: from now on no enable that started earlier, in any
  // tab, can commit for these accounts (lib/push-signout-state.ts), and one
  // starting in this tab waits until this teardown is over.
  bumpSignOutGeneration(accountIds, params.everyAccount);
  const commitsAtStart = new Map(accountIds.map((id) => [id, commitGeneration(id)]));
  const work = runTeardown(params, targets, accountIds, commitsAtStart);
  trackTeardown(accountIds, work);
  return work;
}

async function runTeardown(
  params: { everyAccount: boolean },
  targets: Map<string, IJMAPClient | null>,
  accountIds: string[],
  commitsAtStart: Map<string, number>,
): Promise<{ worker: WorkerSettlement }> {
  // Local and quick, and enough on its own to silence this device.
  await withPushLock(() => markPushSignedOutLocked(accountIds, params.everyAccount));
  // Pushes the worker is already handling settle before the sign-out goes on
  // (alongside the network work below, which it does not depend on).
  const settled = settleWorker(accountIds, params.everyAccount)
    .catch((): WorkerSettlement => 'pending')
    .then(async (worker) => {
      await closeNotifications(accountIds, params.everyAccount);
      if (worker === 'pending') console.warn('[push] The service worker has not confirmed the sign-out yet; it settles on its own');
      return worker;
    });

  // One deadline for all of the network work.
  const network = (async () => {
    if (params.everyAccount) await unsubscribeBrowser();
    // The locked/configured relay, the same one push was enabled against.
    const relayBaseUrl = await currentRelayUrl().catch(() => undefined);
    for (const [accountId, client] of targets) {
      if (client) await disableWebPush({ client, relayBaseUrl }).catch(() => undefined);
      else await dropRelayRegistration(accountId, relayBaseUrl).catch(() => undefined);
    }
    // The browser subscription is shared: it goes once no other account here uses it.
    if (!params.everyAccount && !locallyOptedInAccounts().some((id) => !targets.has(id))) {
      await unsubscribeBrowser();
    }
  })();
  const [worker] = await Promise.all([settled, withTimeout(network, TEARDOWN_TIMEOUT_MS)]);

  // Even when the server side is still running: the opt-in is over, so no
  // later session restore may re-enable push for these accounts - unless the
  // user has enabled it again since (in another tab), which stays.
  await withPushLock(async () => {
    for (const accountId of accountIds) {
      if (commitGeneration(accountId) === commitsAtStart.get(accountId)) forgetWebPushRegistration(accountId);
    }
  });
  return { worker };
}
