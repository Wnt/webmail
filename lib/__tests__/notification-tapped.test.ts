import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetTapHandover,
  findTappedNotification,
  forgetShownNotificationsFor,
  settleTap,
  tapFallbackApplies,
  SHOWN_MAX_AGE_MS,
  TAP_FOUND_GRACE_MS,
  TAP_FOUND_MAX_AGE_MS,
} from '@/lib/notification-open';

// Fork patch (Wnt/webmail): the page side of the worker's ledger of shown
// notifications (public/sw.js rememberShown; sw-tap-ledger.test.ts is the
// writer). On the owner's iPhone (2026-10-19) a tap brought the backgrounded
// Home Screen app back on the Inbox: WebKit dropped the notification's URL
// and fired no notificationclick. The tapped notification is the one gone
// from registration.getNotifications().
const store = new Map<string, string>();
const prefix = () => `${window.location.origin}/__push-state/shown/`;
const foundKey = () => `${window.location.origin}/__push-state/tap-found`;
const ledgerKeys = () => [...store.keys()].filter((k) => k.startsWith(prefix()));
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
  __resetTapHandover();
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
    expect(r).toEqual({ tapped: { emailId: 'e1', slot: 0, at: NOW }, kept: 1, listed: 0, vanished: 1 });
    // Looked at once, and this page has taken it: its next check finds nothing.
    expect(await findTappedNotification(listing(), NOW)).toEqual({ tapped: null, kept: 0, listed: 0, vanished: 0 });
  });

  it('an older notification tapped while a newer one is still on screen opens the older one', async () => {
    shown('s1', 'e-old', { at: NOW - 3_600_000 });
    shown('s2', 'e-new');
    const r = await findTappedNotification(listing('s2'), NOW);
    expect(r.tapped).toMatchObject({ emailId: 'e-old', slot: 0 });
    expect(r.listed).toBe(1);
    expect(ledgerKeys()).toEqual([`${prefix()}s2`]);
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
    expect(store.has(foundKey())).toBe(false);
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
    expect((await findTappedNotification(listing(), NOW)).tapped).toMatchObject({ emailId: 'e1', slot: 0 });
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

describe('the hand-over to the page that replaces the finder', () => {
  // iOS Simulator (WebKit, iOS 26.3), 2026-10-19: WebKit shows the old page
  // first; it sees the notification gone and reads the ledger, then a new
  // page replaces it before it opens the message.
  it('a page replaced right after it found the tap: the next page takes it over', async () => {
    shown('s1', 'e1');
    const first = await findTappedNotification(listing(), NOW);
    expect(first.tapped).toMatchObject({ emailId: 'e1' });
    expect(ledgerKeys()).toEqual([]);
    __resetTapHandover(); // a new page
    const next = await findTappedNotification(listing(), NOW + 300);
    expect(next.tapped).toEqual({ emailId: 'e1', slot: 0, at: NOW, handover: true });
    // ... and only once in that page.
    expect((await findTappedNotification(listing(), NOW + 400)).tapped).toBeNull();
  });

  it('opened and kept: a page replacing the opener within the grace still opens it, later ones do not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      shown('s1', 'e1');
      const { tapped } = await findTappedNotification(listing(), NOW);
      await settleTap(tapped!, true, NOW + 500);
      __resetTapHandover();
      expect((await findTappedNotification(listing(), NOW + 2000)).tapped).toMatchObject({ emailId: 'e1', handover: true });
      __resetTapHandover();
      expect((await findTappedNotification(listing(), NOW + 500 + TAP_FOUND_GRACE_MS + 1)).tapped).toBeNull();
      expect(store.has(foundKey())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tap that could not be opened is dropped', async () => {
    shown('s1', 'e1');
    const { tapped } = await findTappedNotification(listing(), NOW);
    await settleTap(tapped!, false, NOW + 500);
    __resetTapHandover();
    expect((await findTappedNotification(listing(), NOW + 1000)).tapped).toBeNull();
  });

  it('nobody takes over a tap older than two minutes', async () => {
    shown('s1', 'e1');
    await findTappedNotification(listing(), NOW);
    __resetTapHandover();
    expect((await findTappedNotification(listing(), NOW + TAP_FOUND_MAX_AGE_MS + 1)).tapped).toBeNull();
  });

  it('the hand-over is written before the ledger entries go', async () => {
    shown('s1', 'e1');
    const order: string[] = [];
    const real = cacheMock();
    vi.stubGlobal('caches', {
      open: async () => {
        const c = await real.open();
        return {
          ...c,
          put: async (k: string | Request, res: Response) => { order.push(`put ${typeof k === 'string' ? k : k.url}`); await c.put(k, res); },
          delete: async (k: string | Request) => { order.push(`delete ${typeof k === 'string' ? k : k.url}`); return c.delete(k); },
        };
      },
    });
    await findTappedNotification(listing(), NOW);
    expect(order).toEqual([`put ${foundKey()}`, `delete ${prefix()}s1`]);
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
