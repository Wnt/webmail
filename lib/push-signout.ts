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
import { disableWebPush, forgetWebPushRegistration } from '@/lib/web-push';
import { currentRelayUrl } from '@/lib/push-relay-current';
import { markPushSignedOut, noteExplicitSignOut } from '@/lib/push-signout-state';

export { clearPushSignedOut } from '@/lib/push-signout-state';

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const SW_SCOPE = `${BASE_PATH}/`;
const NOTIFICATION_TAG_PREFIX = 'bulwark-mail:';

// The network part of the teardown may not hold the sign-out up for longer:
// the marker already silences the device, and the server side goes on in the
// background.
const TEARDOWN_TIMEOUT_MS = 8000;

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
 * Turn Web Push off for the accounts being signed out on purpose. Call it
 * before their clients disconnect and their tokens are revoked: destroying
 * the JMAP PushSubscription needs the still-valid credential.
 *
 * `everyAccount`: nobody stays signed in on this device, so the browser's
 * push subscription goes too, even for accounts without a client here.
 */
export async function teardownPushOnSignOut(params: {
  clients: IJMAPClient[];
  everyAccount: boolean;
}): Promise<void> {
  if (typeof window === 'undefined') return;
  const targets = params.clients
    .map((client) => ({ client, accountId: accountIdOf(client) }))
    .filter((t): t is { client: IJMAPClient; accountId: string } => t.accountId !== null);
  const accountIds = targets.map((t) => t.accountId);

  // Local and quick, and enough on its own to silence this device.
  for (const accountId of accountIds) noteExplicitSignOut(accountId);
  await markPushSignedOut(accountIds, params.everyAccount);
  await closeNotifications(accountIds, params.everyAccount);
  if (params.everyAccount) await withTimeout(unsubscribeBrowser(), TEARDOWN_TIMEOUT_MS);

  const network = (async () => {
    // The locked/configured relay, the same one push was enabled against.
    const relayBaseUrl = await currentRelayUrl().catch(() => undefined);
    for (const { client } of targets) {
      await disableWebPush({ client, relayBaseUrl }).catch(() => undefined);
    }
  })();
  await withTimeout(network, TEARDOWN_TIMEOUT_MS);

  // Even when the server side is still running: the opt-in is over, so no
  // later session restore may re-enable push for these accounts.
  for (const accountId of accountIds) forgetWebPushRegistration(accountId);
}
