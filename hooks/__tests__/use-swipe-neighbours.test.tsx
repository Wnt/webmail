import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import type { Email } from '@/lib/jmap/types';
import { useSwipeNeighbours } from '../use-swipe-neighbours';
import { __resetOpenTiming, bodyReady } from '@/lib/open-timing';
import { NEIGHBOUR_CACHE_SIZE } from '@/lib/swipe-neighbours';

// Fork (Wnt/webmail): the phone swipe's neighbours, fetched ahead (rules in
// lib/swipe-neighbours.ts), counted at the fetch boundary with a small fake
// JMAP server - work counts, not timings:
// - nothing before the open message's body is on screen;
// - then one Email/get per neighbour, and never an Email/set: preparing a
//   neighbour does not mark it read (only the open does, by its own rule);
// - a swipe opens the prepared neighbour with no request at all, and a swipe
//   back finds the message it left in memory;
// - nothing while the page is hidden, nothing for drafts or rows of another
//   account; at most NEIGHBOUR_CACHE_SIZE messages kept.

const session = {
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl: 'https://mail.example.test/jmap/api',
  downloadUrl: 'https://mail.example.test/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.test/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.test/jmap/eventsource',
};
// Invented data only.
const full = (id: string, keywords: Record<string, boolean> = {}): Email => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords, size: 10, receivedAt: '2026-01-01T00:00:00Z',
  subject: `Subject ${id}`, preview: 'p', from: [{ email: 'info@examplepaja.test' }], to: [],
  textBody: [{ partId: '1', type: 'text/plain', size: 4 }], htmlBody: [],
  bodyValues: { '1': { value: `Body of ${id}`, isEncodingProblem: false, isTruncated: false } },
} as unknown as Email);
const row = (id: string, extra: Partial<Email> = {}) => ({ ...full(id), bodyValues: undefined, ...extra }) as unknown as Email;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

type Call = [string, Record<string, unknown>, string];
let posts: Call[][];
function fakeJmap(_url: string, init?: RequestInit): Promise<Response> {
  const { methodCalls } = JSON.parse(String(init?.body)) as { methodCalls: Call[] };
  posts.push(methodCalls);
  const out = methodCalls.map(([name, args, tag]) => [name, name === 'Email/get'
    ? { accountId: 'acct-1', state: 's', list: (args.ids as string[]).map((id) => full(id)), notFound: [] }
    : { accountId: 'acct-1', state: 's', list: [] }, tag]);
  return Promise.resolve(json({ sessionState: 's', methodResponses: out }));
}
const calls = () => posts.flat();
const emailGets = (id: string) => calls().filter(([n, a]) => n === 'Email/get' && (a.ids as string[] | undefined)?.includes(id)).length;
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let fetchSpy: ReturnType<typeof vi.spyOn>;
let client: JMAPClient;
beforeEach(async () => {
  __resetOpenTiming();
  posts = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(json(session));
  client = new JMAPClient('https://mail.example.test', 'u', 'p');
  await client.connect();
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(fakeJmap as never);
});
afterEach(() => {
  client.disconnect();
  fetchSpy.mockRestore();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

function mount(current: Email, prevRow: Email | null, nextRow: Email | null) {
  return renderHook((p: { current: Email; prevRow: Email | null; nextRow: Email | null }) =>
    useSwipeNeighbours({ client, enabled: true, current: p.current, prevRow: p.prevRow, nextRow: p.nextRow }),
  { initialProps: { current, prevRow, nextRow } });
}

describe('swipe neighbours: fetched ahead, never marked read', () => {
  it('fetches nothing before the open message is on screen, then each neighbour once, with Email/get only', async () => {
    const view = mount(full('m2'), row('m1'), row('m3'));
    await settle();
    expect(posts).toHaveLength(0);
    act(() => bodyReady('m2'));
    await settle(400);
    expect(emailGets('m1')).toBe(1);
    expect(emailGets('m3')).toBe(1);
    expect(calls().map(([n]) => n).filter((n) => n !== 'Email/get')).toEqual([]);
    expect(view.result.current.neighbours?.next?.email?.bodyValues?.['1']?.value).toBe('Body of m3');
    expect(view.result.current.neighbours?.prev?.email?.id).toBe('m1');
  });

  it('a swipe opens the prepared neighbour with no request', async () => {
    const view = mount(full('m2'), row('m1'), row('m3'));
    act(() => bodyReady('m2'));
    await settle(400);
    const before = posts.length;
    expect(view.result.current.prime(row('m3'))).toBe('full');
    const opened = await client.getEmail('m3');
    expect(opened?.bodyValues?.['1']?.value).toBe('Body of m3');
    expect(posts.length).toBe(before);
  });

  it('a swipe back finds the message it left in memory: no fetch for it', async () => {
    const view = mount(full('m2'), row('m1'), row('m3'));
    act(() => bodyReady('m2'));
    await settle(400);
    view.result.current.prime(row('m3'));
    const m3 = await client.getEmail('m3');
    view.rerender({ current: m3!, prevRow: row('m2'), nextRow: row('m4') });
    act(() => bodyReady('m3'));
    await settle(400);
    expect(emailGets('m2')).toBe(0);
    expect(emailGets('m4')).toBe(1);
    const before = posts.length;
    view.result.current.prime(row('m2'));
    await client.getEmail('m2');
    expect(posts.length).toBe(before);
  });

  it('the open takes the row\'s current flags, not the ones the copy was fetched with', async () => {
    const view = mount(full('m2'), null, row('m3'));
    act(() => bodyReady('m2'));
    await settle(400);
    view.result.current.prime(row('m3', { keywords: { $seen: true, $flagged: true } }));
    const opened = await client.getEmail('m3');
    expect(opened?.keywords).toEqual({ $seen: true, $flagged: true });
  });

  it('a hidden page prepares nothing until it is shown again', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    mount(full('m2'), row('m1'), row('m3'));
    act(() => bodyReady('m2'));
    await settle(400);
    expect(posts).toHaveLength(0);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle(400);
    expect(emailGets('m3')).toBe(1);
  });

  it('drafts (they open in the composer) and rows of another account are not fetched', async () => {
    mount(full('m2'), row('m1', { sourceAccountId: 'acct-2' } as Partial<Email>), row('m3', { keywords: { $draft: true } }));
    act(() => bodyReady('m2'));
    await settle(400);
    expect(posts).toHaveLength(0);
  });

  it(`keeps at most ${NEIGHBOUR_CACHE_SIZE} messages`, async () => {
    let current = full('m1');
    const view = mount(current, null, row('m2'));
    for (let i = 1; i <= 7; i++) {
      act(() => bodyReady(`m${i}`));
      await settle(300);
      view.result.current.prime(row(`m${i + 1}`));
      current = (await client.getEmail(`m${i + 1}`))!;
      view.rerender({ current, prevRow: row(`m${i}`), nextRow: row(`m${i + 2}`) });
    }
    // m1 is long gone from memory: a swipe all the way back fetches it again.
    expect(view.result.current.prime(row('m1'))).toBe('none');
    expect(view.result.current.prime(row('m7'))).toBe('full');
  });
});
