import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Audit bulwark-1: the page side of an explicit sign-out - the handshake with
// the service worker, the fallback when suppression cannot be confirmed, and a
// teardown that outlives its wait never touching a newer opt-in.

vi.mock('@/lib/push-relay-current', () => ({ currentRelayUrl: async () => 'https://mail.example.com/relay' }));

const RELAY_DELETE = 'DELETE https://mail.example.com/relay/api/push/register/device1';

function installWorker(answer: 'done' | 'not-done' | 'never', endpoint?: string) {
  const posted: unknown[] = [];
  const unsubscribe = vi.fn(async () => true);
  const active = {
    postMessage: (msg: unknown, transfer: MessagePort[]) => {
      posted.push(msg);
      if (answer === 'never') return;
      transfer[0].postMessage({ done: answer === 'done' });
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    getRegistration: vi.fn(async () => ({
      active,
      pushManager: { getSubscription: async () => ({ unsubscribe, ...(endpoint ? { endpoint } : {}) }) },
      getNotifications: async () => [],
    })),
  }});
  return { posted, unsubscribe };
}

function stubCaches({ failWrites = false } = {}) {
  const store = new Map<string, string>();
  vi.stubGlobal('caches', {
    open: async () => ({
      put: async (key: string, res: Response) => {
        if (failWrites) throw new DOMException('quota', 'QuotaExceededError');
        store.set(key, await res.text());
      },
      delete: async (key: string) => store.delete(key),
      match: async (key: string) => (store.has(key) ? new Response(store.get(key)) : undefined),
    }),
  });
  return store;
}

function makeClient() {
  return {
    getAccountId: () => 'acc1',
    listPushSubscriptions: vi.fn(async () => [{ id: 'subscription1', deviceClientId: 'device1' }]),
    destroyPushSubscription: vi.fn(async () => {}),
  };
}

let requests: string[];
beforeEach(() => {
  localStorage.clear();
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response('{}');
  }));
  localStorage.setItem('bulwark.push.deviceClientId.v1.acc1', 'device1');
  localStorage.setItem('bulwark.push.subscriptionId.v1.acc1', 'subscription1');
  // Another account keeps push on this browser.
  localStorage.setItem('bulwark.push.subscriptionId.v1.acc2', 'subscription2');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('waits for the worker to confirm it settled the accounts', async () => {
  stubCaches();
  const { posted, unsubscribe } = installWorker('done');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const result = await teardownPushOnSignOut({ clients: [makeClient() as never], everyAccount: false });
  expect(result).toEqual({ suppressed: true, worker: 'settled', browserUnsubscribed: false });
  expect(posted).toEqual([{ type: 'push-signout', accountIds: ['acc1'], everyAccount: false, persisted: true }]);
  // The shared browser subscription stays: acc2 still uses it.
  expect(unsubscribe).not.toHaveBeenCalled();
  expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBeNull();
});

it('a worker that answers "not done" makes the sign-out drop the browser subscription', async () => {
  stubCaches();
  const { unsubscribe } = installWorker('not-done');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const result = await teardownPushOnSignOut({ clients: [makeClient() as never], everyAccount: false });
  expect(result).toEqual({ suppressed: true, worker: 'pending', browserUnsubscribed: true });
  expect(unsubscribe).toHaveBeenCalled();
});

it('a worker that never answers does not hold the sign-out, and is not counted as settled', async () => {
  stubCaches();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { unsubscribe } = installWorker('never');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const done = teardownPushOnSignOut({ clients: [makeClient() as never], everyAccount: false });
  await vi.advanceTimersByTimeAsync(8_001);
  const result = await done;
  expect(result.worker).toBe('pending');
  expect(result.browserUnsubscribed).toBe(true);
  expect(unsubscribe).toHaveBeenCalled();
});

it('a marker that cannot be stored is reported, the worker told, and the browser subscription dropped', async () => {
  stubCaches({ failWrites: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { posted, unsubscribe } = installWorker('done');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const result = await teardownPushOnSignOut({ clients: [makeClient() as never], everyAccount: false });
  expect(result).toEqual({ suppressed: false, worker: 'settled', browserUnsubscribed: true });
  expect(posted).toEqual([{ type: 'push-signout', accountIds: ['acc1'], everyAccount: false, persisted: false }]);
  expect(unsubscribe).toHaveBeenCalled();
});

it('a teardown that outlives its wait leaves an opt-in made meanwhile alone', async () => {
  stubCaches();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { unsubscribe } = installWorker('done');
  localStorage.removeItem('bulwark.push.subscriptionId.v1.acc2'); // acc1 is the only account with push
  const client = makeClient();
  let releaseDestroy!: () => void;
  client.destroyPushSubscription.mockImplementation(() => new Promise<void>((resolve) => { releaseDestroy = resolve; }));
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const done = teardownPushOnSignOut({ clients: [client as never], everyAccount: false });
  await vi.advanceTimersByTimeAsync(10_001); // past the wait and the locked step's bound
  await done;

  // The user enables push again (it commits under the lock).
  const state = await import('@/lib/push-signout-state');
  await state.withPushLock(async () => {
    localStorage.setItem('bulwark.push.subscriptionId.v1.acc1', 'push-new');
    state.bumpCommitGeneration('acc1');
  });

  const unsubscribesBefore = unsubscribe.mock.calls.length;
  releaseDestroy();
  await vi.advanceTimersByTimeAsync(1);
  expect(localStorage.getItem('bulwark.push.subscriptionId.v1.acc1')).toBe('push-new');
  expect(requests).not.toContain(RELAY_DELETE);
  expect(unsubscribe.mock.calls.length).toBe(unsubscribesBefore);
});

it('the sign-out generation is bumped synchronously, before anything is awaited', async () => {
  stubCaches();
  installWorker('done');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const { signOutGeneration } = await import('@/lib/push-signout-state');
  const before = signOutGeneration('acc1');
  const done = teardownPushOnSignOut({ clients: [makeClient() as never], everyAccount: true });
  expect(signOutGeneration('acc1')).not.toBe(before);
  await done;
});

// Fork (Wnt/webmail), Codex Astra late-push review: on Apple's push service our
// gateway sends new mail as a Declarative Web Push message the browser shows by
// itself, so the worker's sign-out markers cannot stop it. There the server side
// must confirm the teardown, or the browser subscription goes too.
const APPLE = 'https://web.push.apple.com/QGx0abc';
const FCM = 'https://fcm.googleapis.com/fcm/send/abc';

it('Apple push: a teardown the server confirmed keeps the browser subscription the other account uses', async () => {
  stubCaches();
  const { unsubscribe } = installWorker('done', APPLE);
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const result = await teardownPushOnSignOut({ clients: [makeClient() as never], everyAccount: false });
  expect(result).toEqual({ suppressed: true, worker: 'settled', browserUnsubscribed: false });
  expect(unsubscribe).not.toHaveBeenCalled();
  expect(requests).toContain(RELAY_DELETE);
});

for (const [what, fail] of [
  ['the relay record\'s DELETE failed', 'relay'],
  ['the PushSubscription destroy failed', 'destroy'],
] as const) {
  it(`Apple push: ${what}, so the browser subscription is dropped`, async () => {
    stubCaches();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unsubscribe } = installWorker('done', APPLE);
    if (fail === 'relay') {
      vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Response('{}', { status: init?.method === 'DELETE' ? 503 : 200 });
      }));
    }
    const client = makeClient();
    if (fail === 'destroy') client.destroyPushSubscription.mockRejectedValue(new Error('offline'));
    const { teardownPushOnSignOut } = await import('@/lib/push-signout');
    const result = await teardownPushOnSignOut({ clients: [client as never], everyAccount: false });
    expect(result).toEqual({ suppressed: true, worker: 'settled', browserUnsubscribed: true });
    expect(unsubscribe).toHaveBeenCalled();
  });
}

it('Apple push: a teardown still running after the wait drops the browser subscription', async () => {
  stubCaches();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { unsubscribe } = installWorker('done', APPLE);
  const client = makeClient();
  client.destroyPushSubscription.mockImplementation(() => new Promise<void>(() => {}));
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const done = teardownPushOnSignOut({ clients: [client as never], everyAccount: false });
  await vi.advanceTimersByTimeAsync(10_001);
  const result = await done;
  expect(result.browserUnsubscribed).toBe(true);
  expect(unsubscribe).toHaveBeenCalled();
});

it('other push services: an unconfirmed teardown keeps the subscription (the worker\'s marker suppresses)', async () => {
  stubCaches();
  const { unsubscribe } = installWorker('done', FCM);
  const client = makeClient();
  client.destroyPushSubscription.mockRejectedValue(new Error('offline'));
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const result = await teardownPushOnSignOut({ clients: [client as never], everyAccount: false });
  expect(result).toEqual({ suppressed: true, worker: 'settled', browserUnsubscribed: false });
  expect(unsubscribe).not.toHaveBeenCalled();
});
