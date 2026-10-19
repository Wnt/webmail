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
// No single step holds the cross-tab push lock longer than this.
const LOCKED_STEP_TIMEOUT_MS = 10000;

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

/**
 * Whether this browser's push subscription is Apple's (Safari, iOS Home
 * Screen apps). There our gateway sends new mail as a Declarative Web Push
 * message that the browser shows by itself, without the service worker, so
 * the sign-out markers the worker reads cannot stop it.
 */
async function browserUsesApplePush(): Promise<boolean> {
  const registration = await swRegistration();
  try {
    const subscription = await registration?.pushManager?.getSubscription();
    const host = subscription?.endpoint ? new URL(subscription.endpoint).hostname : '';
    return host === 'push.apple.com' || host.endsWith('.push.apple.com');
  } catch {
    return false;
  }
}

async function unsubscribeBrowser(stillOk: () => boolean = () => true): Promise<boolean> {
  const registration = await swRegistration();
  try {
    const subscription = await registration?.pushManager?.getSubscription();
    if (!stillOk()) return false;
    if (subscription) await subscription.unsubscribe();
    return true;
  } catch {
    // The service worker drops the subscription on the next push instead.
    return false;
  }
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([work.then(() => undefined, () => undefined), timeout])
    .finally(() => clearTimeout(timer));
}

/** Run `work` holding the push lock, but never hold the lock longer than `ms`. */
function underLock(work: () => Promise<unknown>, ms = LOCKED_STEP_TIMEOUT_MS): Promise<void> {
  return withPushLock(() => withTimeout(work(), ms));
}

/**
 * 'settled': the worker drained every push it was handling for these
 * accounts and closed their notifications. 'pending': it did not confirm (in
 * time, or at all); it keeps suppressing them and settles on its own.
 * 'no-worker': nothing was being handled.
 */
export type WorkerSettlement = 'settled' | 'pending' | 'no-worker';

export interface PushSignOutResult {
  /** The sign-out markers the service worker reads were written. */
  suppressed: boolean;
  worker: WorkerSettlement;
  /**
   * Suppression could not be confirmed (markers not written, or the worker
   * not settled in time), so the browser's push subscription was dropped as
   * a safe fallback - for every account on this device until the app is
   * opened again (a re-sync re-subscribes accounts that kept push).
   */
  browserUnsubscribed: boolean;
}

/**
 * Ask the service worker to settle the pushes it is handling for these
 * accounts (see handlePushSignOut in public/sw.js). `bounded` resolves with
 * its answer, or 'pending' after WORKER_SETTLE_TIMEOUT_MS; `final` with the
 * answer whenever it comes (the reply port stays open for it).
 */
function settleWorker(
  accountIds: string[],
  everyAccount: boolean,
  persisted: boolean,
): { bounded: Promise<WorkerSettlement>; final: Promise<WorkerSettlement> } {
  const final = (async (): Promise<WorkerSettlement> => {
    const registration = await swRegistration();
    const worker = registration?.active;
    if (!worker || typeof MessageChannel === 'undefined') return 'no-worker';
    const channel = new MessageChannel();
    try {
      return await new Promise<WorkerSettlement>((resolve) => {
        channel.port1.onmessage = (e: MessageEvent) =>
          resolve((e.data as { done?: unknown })?.done === true ? 'settled' : 'pending');
        worker.postMessage({ type: 'push-signout', accountIds, everyAccount, persisted }, [channel.port2]);
      });
    } catch {
      return 'pending';
    } finally {
      channel.port1.close();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([
    final,
    new Promise<WorkerSettlement>((resolve) => { timer = setTimeout(() => resolve('pending'), WORKER_SETTLE_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  return { bounded, final };
}

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
 *
 * Resolves within about TEARDOWN_TIMEOUT_MS; the server-side cleanup may go
 * on after that, but it never touches an opt-in the user made again meanwhile
 * (commit generation, checked under the push lock before every step), and
 * an enable started in this tab waits for it.
 */
export function teardownPushOnSignOut(params: {
  clients: IJMAPClient[];
  loginIds?: string[];
  unmappedFallback?: { keep: string[] };
  everyAccount: boolean;
}): Promise<PushSignOutResult> {
  if (typeof window === 'undefined') {
    return Promise.resolve({ suppressed: true, worker: 'no-worker', browserUnsubscribed: false });
  }
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
  // tab, can commit for these accounts (lib/push-signout-state.ts).
  bumpSignOutGeneration(accountIds, params.everyAccount);
  const commitsAtStart = new Map(accountIds.map((id) => [id, commitGeneration(id)]));
  // Still ours: nobody has enabled push for the account again since.
  const owned = (id: string) => commitGeneration(id) === commitsAtStart.get(id);
  const allOwned = () => accountIds.every(owned);

  // An enable started in this tab from now on waits for all of it, network
  // steps that outlive the bounded wait included.
  let finishTracking!: () => void;
  trackTeardown(accountIds, new Promise<void>((resolve) => { finishTracking = resolve; }));
  const result = (async (): Promise<PushSignOutResult> => {
    // Local and quick, and enough on its own to silence this device.
    let suppressed = false;
    await underLock(async () => {
      suppressed = await markPushSignedOutLocked(accountIds, params.everyAccount);
    });
    // Pushes the worker is already handling settle (alongside the network work).
    const worker = settleWorker(accountIds, params.everyAccount, suppressed);
    // Fork (Wnt/webmail): whether the server side confirmed the teardown of
    // every account (see the Apple fallback below).
    let remoteConfirmed = true;
    let networkDone = false;
    const network = (async () => {
      if (params.everyAccount) await underLock(() => unsubscribeBrowser(allOwned));
      // The locked/configured relay, the same one push was enabled against.
      const relayBaseUrl = await currentRelayUrl().catch(() => undefined);
      for (const [accountId, client] of targets) {
        await underLock(async () => {
          if (!owned(accountId)) return;
          let ok = true;
          if (client) ok = await disableWebPush({ client, relayBaseUrl, stillOwned: () => owned(accountId) }).catch(() => false);
          else if (owned(accountId)) ok = await dropRelayRegistration(accountId, relayBaseUrl).catch(() => false);
          if (!ok) remoteConfirmed = false;
        }).catch(() => { remoteConfirmed = false; });
      }
      // The browser subscription is shared: it goes once no other account here uses it.
      if (!params.everyAccount) {
        await underLock(async () => {
          await unsubscribeBrowser(() => allOwned() && !locallyOptedInAccounts().some((id) => !targets.has(id)));
        });
      }
      networkDone = true;
    })();
    void Promise.allSettled([network, worker.final]).then(() => finishTracking());

    const [settlement] = await Promise.all([
      worker.bounded.then(async (w) => {
        await closeNotifications(accountIds, params.everyAccount);
        return w;
      }),
      withTimeout(network, TEARDOWN_TIMEOUT_MS),
    ]);

    // Suppression that cannot be confirmed falls back to dropping the
    // browser's push subscription: then nothing can arrive at all.
    // Fork (Wnt/webmail): on Apple's push service the markers suppress
    // nothing the browser shows by itself (a declarative push), so there the
    // server side must have confirmed the teardown within the wait, or the
    // browser subscription goes too (for every account on this device until
    // the app is opened again, when a re-sync re-subscribes the others).
    const declarativeUnconfirmed = !(networkDone && remoteConfirmed) && await browserUsesApplePush();
    let browserUnsubscribed = false;
    if (!suppressed || settlement === 'pending' || declarativeUnconfirmed) {
      await underLock(async () => {
        browserUnsubscribed = await unsubscribeBrowser(allOwned);
      });
      const why = !suppressed
        ? 'could not store its marker'
        : settlement === 'pending'
          ? 'is still being settled by the service worker'
          : 'was not confirmed by the server (Apple push: the browser shows declarative pushes itself)';
      console.warn(`[push] Sign-out ${why}; this browser's push subscription was dropped`);
    }

    // Even when the server side is still running: the opt-in is over, so no
    // later session restore may re-enable push for these accounts - unless the
    // user has enabled it again since (in any tab), which stays.
    await underLock(async () => {
      for (const accountId of accountIds) if (owned(accountId)) forgetWebPushRegistration(accountId);
    });
    return { suppressed, worker: settlement, browserUnsubscribed };
  })();
  result.catch(() => finishTracking());
  return result;
}
