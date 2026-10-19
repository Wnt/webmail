import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findTappedNotification,
  forgetShownNotificationsFor,
  tapFallbackApplies,
  SHOWN_MAX_AGE_MS,
} from '@/lib/notification-open';

// Fork patch (Wnt/webmail): the page side of the worker's ledger of shown
// notifications (public/sw.js rememberShown; sw-tap-ledger.test.ts is the
// writer). On the owner's iPhone (2026-10-19) a tap brought the backgrounded
// Home Screen app back on the Inbox: WebKit dropped the notification's URL
// and fired no notificationclick. The tapped notification is the one gone
// from registration.getNotifications().
const store = new Map<string, string>();
const prefix = () => `${window.location.origin}/__push-state/shown/`;
const NOW = 1_800_000_000_000;

function cacheMock() {
  return {
    open: async () => ({
      match: async (k: string | Request) => {
        const url = typeof k === 'string' ? k : k.url;
        return store.has(url) ? { json: async () => JSON.parse(store.get(url)!) } : undefined;
      },
      put: async (k: string | Request, res: Response) => { store.set(typeof k === 'string' ? k : k.url, await res.text()); },
      keys: async () => [...store.keys()].map((url) => ({ url }) as Request),
      delete: async (k: string | Request) => store.delete(typeof k === 'string' ? k : k.url),
    }),
  };
}

function shown(shownId: string, emailId: string, extra: Record<string, unknown> = {}) {
  store.set(`${prefix()}${shownId}`, JSON.stringify({ shownId, emailId, accountId: 'acc1', slot: 0, at: NOW - 60_000, listed: true, ...extra }));
}

/** A registration whose notification list holds the given shownIds. */
function listing(...shownIds: string[]) {
  return {
    getNotifications: vi.fn(async () => shownIds.map((id) => ({ data: { kind: 'email', shownId: id } }) as unknown as Notification)),
  };
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal('caches', cacheMock());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('findTappedNotification', () => {
  it('the one notification gone from the list is the tap (the app came back without its URL)', async () => {
    shown('s1', 'e1');
    const r = await findTappedNotification(listing(), NOW);
    expect(r).toEqual({ tapped: { emailId: 'e1', slot: 0 }, kept: 1, listed: 0, vanished: 1 });
    // Looked at once: the next check finds nothing.
    expect(await findTappedNotification(listing(), NOW)).toEqual({ tapped: null, kept: 0, listed: 0, vanished: 0 });
  });

  it('an older notification tapped while a newer one is still on screen opens the older one', async () => {
    shown('s1', 'e-old', { at: NOW - 3_600_000 });
    shown('s2', 'e-new');
    const r = await findTappedNotification(listing('s2'), NOW);
    expect(r.tapped).toEqual({ emailId: 'e-old', slot: 0 });
    expect(r.listed).toBe(1);
    expect([...store.keys()]).toEqual([`${prefix()}s2`]);
  });

  it('nothing gone (the app opened from its icon): no tap', async () => {
    shown('s1', 'e1');
    const r = await findTappedNotification(listing('s1'), NOW);
    expect(r).toEqual({ tapped: null, kept: 1, listed: 1, vanished: 0 });
    expect(store.size).toBe(1);
  });

  it('several gone at once (Clear All) opens nothing', async () => {
    shown('s1', 'e1');
    shown('s2', 'e2');
    const r = await findTappedNotification(listing(), NOW);
    expect(r).toMatchObject({ tapped: null, vanished: 2 });
    expect(store.size).toBe(0);
  });

  it('one the worker closed itself is no tap', async () => {
    shown('s1', 'e1', { closed: true });
    expect((await findTappedNotification(listing(), NOW)).tapped).toBeNull();
    expect(store.size).toBe(0);
  });

  it('a close the browser refused (still listed) is undone, so a later tap on it counts', async () => {
    shown('s1', 'e1', { closed: true });
    await findTappedNotification(listing('s1'), NOW);
    expect(JSON.parse(store.get(`${prefix()}s1`)!).closed).toBe(false);
    expect((await findTappedNotification(listing(), NOW)).tapped).toEqual({ emailId: 'e1', slot: 0 });
  });

  it('one the browser never listed (its absence means nothing) is no tap', async () => {
    shown('s1', 'e1', { listed: false });
    expect((await findTappedNotification(listing(), NOW)).tapped).toBeNull();
  });

  it('one older than a day is no tap', async () => {
    shown('s1', 'e1', { at: NOW - SHOWN_MAX_AGE_MS - 1 });
    expect((await findTappedNotification(listing(), NOW)).tapped).toBeNull();
  });

  it('a failing listing changes nothing', async () => {
    shown('s1', 'e1');
    const r = await findTappedNotification({ getNotifications: async () => { throw new Error('no'); } }, NOW);
    expect(r).toEqual({ tapped: null, kept: 1, listed: 0, vanished: 0 });
    expect(store.size).toBe(1);
  });

  it('does not list anything when the ledger is empty', async () => {
    const reg = listing();
    expect(await findTappedNotification(reg, NOW)).toEqual({ tapped: null, kept: 0, listed: 0, vanished: 0 });
    expect(reg.getNotifications).not.toHaveBeenCalled();
  });

  it('without a registration or Cache Storage: nothing', async () => {
    shown('s1', 'e1');
    expect((await findTappedNotification(null, NOW)).tapped).toBeNull();
    vi.stubGlobal('caches', undefined);
    expect((await findTappedNotification(listing(), NOW)).tapped).toBeNull();
  });
});

describe('forgetShownNotificationsFor', () => {
  it('a message opened in the app is no tap waiting any more', async () => {
    shown('s1', 'e1');
    shown('s2', 'e2');
    await forgetShownNotificationsFor('e1');
    expect([...store.keys()]).toEqual([`${prefix()}s2`]);
  });
});

describe('tapFallbackApplies', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1';
  const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  function setNavigator(ua: string, standalone: boolean) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
  }
  afterEach(() => {
    delete (navigator as unknown as { standalone?: boolean }).standalone;
  });

  it('only for the iPhone/iPad Home Screen app', () => {
    setNavigator(IPHONE, true);
    expect(tapFallbackApplies()).toBe(true);
    setNavigator(IPHONE, false);
    expect(tapFallbackApplies()).toBe(false);
    setNavigator(CHROME, true);
    expect(tapFallbackApplies()).toBe(false);
  });
});
