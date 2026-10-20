import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { Email } from '../jmap/types';

// Fork (Wnt/webmail), review swipe-preload r1 R3/R4: copies of messages kept
// for an open (primedEmails: the push worker's copy, the hover prefetch, the
// phone swipe's hand-over) are bounded, belong to the session they were made
// in (its API URL and mail account), and go with it.

const session = (apiUrl = 'https://mail.example.test/jmap/api') => ({
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl, downloadUrl: 'https://mail.example.test/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.test/jmap/upload/{accountId}/', eventSourceUrl: 'https://mail.example.test/jmap/eventsource',
});
// Invented data only.
const full = (id: string, body = `Body of ${id}`): Email => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {}, size: 10, receivedAt: '2026-01-01T00:00:00Z',
  subject: id, from: [{ email: 'info@examplepaja.test' }], to: [],
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [],
  bodyValues: { '1': { value: body, isTruncated: false } },
} as unknown as Email);
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });

let gets: string[];
let fetchSpy: ReturnType<typeof vi.spyOn>;
let client: JMAPClient;
beforeEach(async () => {
  gets = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(json(session()));
  client = new JMAPClient('https://mail.example.test', 'u', 'p');
  await client.connect();
  fetchSpy.mockReset();
  fetchSpy.mockImplementation((async (_u: string, init?: RequestInit) => {
    const { methodCalls } = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    const out = methodCalls.map(([n, a, t]) => {
      if (n === 'Email/get') gets.push(...(a.ids as string[]));
      return [n, n === 'Email/get' ? { accountId: 'acct-1', state: 's', list: (a.ids as string[]).map((id) => full(id, `Server body of ${id}`)), notFound: [] } : {}, t];
    });
    return json({ sessionState: 's', methodResponses: out });
  }) as never);
});
afterEach(() => { client.disconnect(); fetchSpy.mockRestore(); });
const primed = () => (client as unknown as { primedEmails: Map<string, unknown> }).primedEmails;

describe('copies kept for an open', () => {
  it('at most 8 wait; the oldest go first', () => {
    for (let i = 0; i < 12; i++) client.primeEmail(full(`k${i}`));
    expect(primed().size).toBe(8);
    expect([...primed().keys()].map((k) => k.split('\u0000')[1])).toEqual(['k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11']);
  });

  it('are dropped when the client disconnects', () => {
    client.primeEmail(full('k1'));
    client.disconnect();
    expect(primed().size).toBe(0);
  });

  it('are not handed out in a session that replaced the one they were made in', async () => {
    client.primeEmailForOpen('m1', full('m1', 'Copy from the old session'), 10_000, client.getSessionScope());
    (client as unknown as { apiUrl: string }).apiUrl = 'https://other.example.test/jmap/api';
    const opened = await client.getEmail('m1');
    expect(opened?.bodyValues?.['1']?.value).toBe('Server body of m1');
    expect(gets).toEqual(['m1']);
  });

  it('a fetch that ends after its session was replaced is not used', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const pending = gate.then(() => full('m2', 'Copy from the old session'));
    client.primeEmailForOpen('m2', pending, 10_000, client.getSessionScope());
    const opening = client.getEmail('m2');
    (client as unknown as { apiUrl: string }).apiUrl = 'https://other.example.test/jmap/api';
    release();
    const opened = await opening;
    // An open that spans a session change returns nothing of the old session.
    expect(opened?.bodyValues?.['1']?.value).not.toBe('Copy from the old session');
  });

  it('a copy made in another session is refused at the hand-over (no render needed)', async () => {
    const before = client.getSessionScope();
    client.disconnect();
    expect(client.adoptSession(session())).toBe(true); // same server and account, a new session
    client.primeEmailForOpen('m4', full('m4', 'Copy from the old session'), 10_000, before);
    expect(primed().size).toBe(0);
    expect((await client.getEmail('m4'))?.bodyValues?.['1']?.value).toBe('Server body of m4');
  });

  it('a fetch ahead that ends in another session is dropped', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const realFetch = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((async (u: string, init?: RequestInit) => { await gate; return realFetch(u, init); }) as never);
    const ahead = client.fetchEmailAhead('m5');
    client.disconnect();
    client.adoptSession(session());
    release();
    expect(await ahead).toBeNull();
  });

  it('fetchEmailAhead keeps nothing in the client', async () => {
    const e = await client.fetchEmailAhead('m3');
    expect(e?.id).toBe('m3');
    expect(primed().size).toBe(0);
  });
});

describe('copies kept for an open: a new session at the same address (review swipe-preload r2 R2-C)', () => {
  it('an open waiting on a copy does not take it after a sign-out and a new session', async () => {
    let release!: (e: Email) => void;
    const pending = new Promise<Email>((r) => { release = r; });
    client.primeEmailForOpen('same-id', pending, 10_000, client.getSessionScope());
    const opening = client.getEmail('same-id');
    client.disconnect();
    client.adoptSession(session());
    release(full('same-id', 'OLD LOGIN BODY'));
    expect((await opening)?.bodyValues?.['1']?.value).not.toBe('OLD LOGIN BODY');
  });

  it('fetchEmailAhead drops a result that arrives after a sign-out and a new session', async () => {
    let release!: (e: Email) => void;
    const spy = vi.spyOn(client as unknown as { fetchFullEmail: () => Promise<Email> }, 'fetchFullEmail')
      .mockImplementation(() => new Promise<Email>((r) => { release = r; }));
    const ahead = client.fetchEmailAhead('same-id');
    client.disconnect();
    client.adoptSession(session());
    release(full('same-id', 'OLD LOGIN BODY'));
    expect(await ahead).toBeNull();
    spy.mockRestore();
  });
});

describe('an open checks its session again before it returns (review swipe-preload r3 R3-B)', () => {
  it('a copy taken for an open is not returned when the session changed while the open finished', async () => {
    client.primeEmailForOpen('ready', full('ready', 'OLD READY BODY'), 10_000, client.getSessionScope());
    const opening = client.getEmail('ready');
    client.disconnect();
    client.adoptSession(session());
    expect((await opening)?.bodyValues?.['1']?.value).not.toBe('OLD READY BODY');
  });

  it('nor the completion of a cut body fetched for the old session', async () => {
    const copy = full('truncated', 'OLD PARTIAL BODY');
    (copy.bodyValues as Record<string, { isTruncated: boolean }>)['1'].isTruncated = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fetchSpy.mockImplementation((async () => {
      await gate;
      return json({ methodResponses: [['Email/get', { list: [full('truncated', 'OLD COMPLETE BODY')] }, '0']] });
    }) as never);
    client.primeEmailForOpen('truncated', copy, 10_000, client.getSessionScope());
    const opening = client.getEmail('truncated');
    client.disconnect();
    const next = session();
    client.adoptSession({ ...next, accounts: { 'acct-2': next.accounts['acct-1'] }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-2' } });
    release();
    expect((await opening)?.bodyValues?.['1']?.value).not.toBe('OLD COMPLETE BODY');
  });

  it('a reconnect of the same session keeps the generation (R3-D)', async () => {
    const before = client.getSessionScope();
    fetchSpy.mockResolvedValueOnce(json(session()));
    await client.reconnect();
    expect(client.getSessionScope()).toBe(before);
    client.disconnect();
    client.adoptSession(session());
    expect(client.getSessionScope()).not.toBe(before);
  });
});

it('a 401 session refresh to another primary account makes earlier copies stale (review swipe-preload r4 R4-B)', async () => {
  const before = client.getSessionScope();
  client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-ACCOUNT'), 10_000, before);
  const next = session();
  const replacement = { ...next, accounts: { 'acct-2': next.accounts['acct-1'] }, primaryAccounts: {'urn:ietf:params:jmap:mail': 'acct-2'} };
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValueOnce(new Response('', {status:401}));
  fetchSpy.mockResolvedValueOnce(json(replacement));
  // A genuine server can reject the old account on the retried request. The
  // stale ready primer must still become inaccessible without any server read.
  fetchSpy.mockResolvedValueOnce(json({methodResponses:[['error',{type:'accountNotFound'},'0']]}));
  fetchSpy.mockResolvedValueOnce(json({methodResponses:[['Email/get',{accountId:'acct-2',list:[],notFound:['old-ready']},'0']]}));
  expect(await client.getEmail('trigger-refresh')).toBeNull();
  expect(client.getSessionSnapshot()?.primaryAccounts).toEqual(replacement.primaryAccounts);
  const opened = await client.getEmail('old-ready');
  expect({sameScope:client.getSessionScope()===before,returnedOld:opened?.bodyValues?.['1']?.value==='PRIVATE-OLD-ACCOUNT'})
    .toEqual({sameScope:false,returnedOld:false});
});
