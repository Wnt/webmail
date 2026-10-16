import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Audit bulwark-1: the page side of the explicit sign-out handshake with the
// service worker. A worker that does not confirm is reported, not assumed.

vi.mock('@/lib/push-relay-current', () => ({ currentRelayUrl: async () => 'https://mail.example.com/relay' }));

function installWorker(answer: 'done' | 'not-done' | 'never') {
  const posted: unknown[] = [];
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
      pushManager: { getSubscription: async () => null },
      getNotifications: async () => [],
    })),
  }});
  return posted;
}

const client = {
  getAccountId: () => 'acc1',
  listPushSubscriptions: async () => [],
  destroyPushSubscription: async () => {},
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('waits for the worker to confirm it settled the accounts', async () => {
  const posted = installWorker('done');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const result = await teardownPushOnSignOut({ clients: [client as never], everyAccount: false });
  expect(result.worker).toBe('settled');
  expect(posted).toEqual([{ type: 'push-signout', accountIds: ['acc1'], everyAccount: false }]);
});

it('a worker that answers "not done" leaves the sign-out marked pending', async () => {
  installWorker('not-done');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  expect((await teardownPushOnSignOut({ clients: [client as never], everyAccount: false })).worker).toBe('pending');
});

it('a worker that never answers does not hold the sign-out, and is not counted as settled', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  installWorker('never');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const done = teardownPushOnSignOut({ clients: [client as never], everyAccount: false });
  await vi.advanceTimersByTimeAsync(8_001);
  expect((await done).worker).toBe('pending');
});

it('the sign-out generation is bumped synchronously, before anything is awaited', async () => {
  installWorker('done');
  const { teardownPushOnSignOut } = await import('@/lib/push-signout');
  const { signOutGeneration } = await import('@/lib/push-signout-state');
  const before = signOutGeneration('acc1');
  const done = teardownPushOnSignOut({ clients: [client as never], everyAccount: true });
  expect(signOutGeneration('acc1')).not.toBe(before);
  await done;
});
