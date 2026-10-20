import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';

// Performance regression budget (2026-10-19): opening a message from the list
// used to start its Email/get at the click and sanitize its body on the way
// to the first paint. The mouse resting on the row (or a finger held still on
// it) now fetches the message and sanitizes its body before the click: the
// open sends no Email/get and runs no sanitize pass. A message the push
// worker kept opens from its kept copy, with the row's current flags.

const sanitize = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/email-sanitization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email-sanitization')>();
  return {
    ...actual,
    sanitizeEmailBodyForIframe: (...args: Parameters<typeof actual.sanitizeEmailBodyForIframe>) => {
      sanitize.calls++;
      return actual.sanitizeEmailBodyForIframe(...args);
    },
  };
});

const { JMAPClient } = await import('@/lib/jmap/client');
const { prefetchForOpen, attachOpenPrefetch, watchKeptEmails, __resetOpenPrefetch, HOVER_DWELL_MS, PRESS_DWELL_MS } = await import('@/lib/open-prefetch');
const { cachedEmailContent, emailContentCacheKey, __clearEmailContentCache } = await import('@/lib/email-content-cache');

const SERVER = 'https://mail.example.test';
const session = {
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:mail': {} },
  accounts: { a1: { name: 'alice@example.test', isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
  username: 'alice@example.test', apiUrl: `${SERVER}/jmap`, downloadUrl: `${SERVER}/d/{blobId}`, state: 's1',
};
const full = (id: string, keywords: Record<string, boolean> = {}): Email => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords, size: 100, receivedAt: '2026-01-01T00:00:00Z',
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], subject: 'Invented',
  htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { 1: { value: '<p>Hello <b>there</b></p>', isTruncated: false } },
} as unknown as Email);
const row = (id: string, keywords: Record<string, boolean> = {}) => ({ id, keywords, mailboxIds: { inbox: true } } as unknown as Email);

let gets: string[] = [];
const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
  return new Response(JSON.stringify({ sessionState: 's1', methodResponses: body.methodCalls.map(([name, args, id]) => {
    if (name === 'Email/get') { gets.push(...(args.ids as string[])); return [name, { list: (args.ids as string[]).map((x) => full(x)), notFound: [] }, id]; }
    return [name, {}, id];
  }) }), { status: 200 });
});

function client() {
  const c = JMAPClient.withBearer(SERVER, 'tok', 'alice@example.test');
  c.adoptSession(session);
  return c;
}
const idle = () => new Promise((r) => setTimeout(r, 20));

// A minimal Cache Storage for the push worker's kept copies.
function stubCaches(entries: Record<string, unknown>) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  const cache = {
    match: async (url: string) => (store.has(url) ? new Response(store.get(url)) : undefined),
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (url: string) => store.delete(url),
    put: async () => {},
  };
  vi.stubGlobal('caches', { open: async () => cache });
}

beforeEach(() => {
  gets = [];
  sanitize.calls = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  __resetOpenPrefetch();
  __clearEmailContentCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('a message is fetched and sanitized before its open', () => {
  it('the open after a rest on the row sends no Email/get and sanitizes nothing', async () => {
    const c = client();
    prefetchForOpen(c, row('m1'));
    await idle();
    expect(gets).toEqual(['m1']);
    expect(cachedEmailContent(emailContentCacheKey(full('m1'), false, {}), full('m1')) ?? cachedEmailContent(emailContentCacheKey(full('m1'), true, {}), full('m1'))).toBeDefined();
    const before = sanitize.calls;
    const email = await c.getEmail('m1');
    expect(email?.id).toBe('m1');
    expect(gets, 'the open sends no Email/get of its own').toEqual(['m1']);
    expect(sanitize.calls - before).toBe(0);
    c.disconnect();
  });

  it('a click while the fetch is out waits for it instead of asking again', async () => {
    const c = client();
    prefetchForOpen(c, row('m2'));
    const email = await c.getEmail('m2');
    expect(email?.id).toBe('m2');
    expect(gets).toEqual(['m2']);
    c.disconnect();
  });

  it("a kept message opens from the worker's copy, with the row's current flags", async () => {
    stubCaches({
      [`${window.location.origin}/__push-state/prefetched/a1/m3`]: { at: Date.now(), accountId: 'a1', email: full('m3', {}) },
    });
    watchKeptEmails();
    await idle();
    const c = client();
    prefetchForOpen(c, row('m3', { $seen: true }));
    await idle();
    const email = await c.getEmail('m3');
    expect(gets, 'no Email/get at all').toEqual([]);
    expect(email?.keywords).toEqual({ $seen: true });
    c.disconnect();
  });

  it('drafts and rows of other logins are left alone', async () => {
    const c = client();
    prefetchForOpen(c, row('d1', { $draft: true }));
    prefetchForOpen(c, { ...row('x1'), sourceClientAccountId: 'other' } as Email);
    await idle();
    expect(gets).toEqual([]);
    c.disconnect();
  });
});

describe('list rows', () => {
  function list() {
    const container = document.createElement('div');
    container.innerHTML = '<div data-testid="email-list-item" data-email-id="r1"><span>row</span></div>';
    document.body.appendChild(container);
    const go = vi.fn();
    const fakeClient = { prefetchEmail: go, getAccountId: () => 'a1' } as never;
    const detach = attachOpenPrefetch(container, (id) => row(id), () => fakeClient);
    const span = container.querySelector('span')!;
    const fire = (type: string, pointerType: string, x = 0, y = 0) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerType', { value: pointerType });
      span.dispatchEvent(e);
    };
    return { go, fire, detach, container };
  }

  it('the mouse resting on a row fetches its message', async () => {
    vi.useFakeTimers();
    const { go, fire, detach } = list();
    fire('pointerover', 'mouse');
    vi.advanceTimersByTime(HOVER_DWELL_MS - 1);
    expect(go).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(go).toHaveBeenCalledWith('r1', null, expect.anything());
    detach();
    vi.useRealTimers();
  });

  it('a finger held still fetches it; a scroll does not', async () => {
    vi.useFakeTimers();
    const { go, fire, detach } = list();
    fire('pointerdown', 'touch', 10, 10);
    fire('pointermove', 'touch', 10, 40);
    vi.advanceTimersByTime(PRESS_DWELL_MS + 10);
    expect(go).not.toHaveBeenCalled();
    fire('pointerdown', 'touch', 10, 10);
    vi.advanceTimersByTime(PRESS_DWELL_MS + 1);
    expect(go).toHaveBeenCalledTimes(1);
    detach();
    vi.useRealTimers();
  });
});
