import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { Email } from '../jmap/types';

// Fork (Wnt/webmail), review swipe-preload r6 R6-A/R6-B (the reviewer's
// probes kept as regression tests): a session answer that lists no mail
// account - through background revalidation, a reconnect, or a 401 refresh
// (also with TOTP) - retires the old account's kept copies for good, a later
// reconnect of the same identity does not bring them back, and an account
// counts only when the session itself lists it (not an inherited name).

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


describe('a session with no mail account retires the old copies', () => {
  it.each(['u', ''])('empty authoritative revalidation retires cached mail (username %j)', async (username) => {
    const scope = client.getSessionScope();
    client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-ACCOUNT'), 10_000, scope);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(json({...session(), username, accounts: {}, primaryAccounts: {}}));
    fetchSpy.mockResolvedValue(json({ methodResponses: [['error', {type:'accountNotFound'}, '0']] }));
    const check = await client.revalidateSession();
    const opened = await client.getEmail('old-ready');
    expect({check, sameScope: client.getSessionScope() === scope, returnedOld: opened?.bodyValues?.['1']?.value === 'PRIVATE-OLD-ACCOUNT'})
      .toMatchObject({sameScope: false, returnedOld: false});
  });
  it('revalidation cannot retain a dangling primary account', async () => {
    const scope = client.getSessionScope();
    client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-ACCOUNT'), 10_000, scope);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(json({...session(), accounts: {}}));
    fetchSpy.mockResolvedValue(json({ methodResponses: [['error', {type:'accountNotFound'}, '0']] }));
    const check = await client.revalidateSession();
    const opened = await client.getEmail('old-ready');
    expect({check, sameScope: client.getSessionScope() === scope, returnedOld: opened?.bodyValues?.['1']?.value === 'PRIVATE-OLD-ACCOUNT'})
      .toMatchObject({sameScope: false, returnedOld: false});
  });
  it('a successful reconnect cannot resurrect copies retired by an empty session', async () => {
    const scope = client.getSessionScope();
    client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-ACCOUNT'), 10_000, scope);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(json({...session(), accounts: {}, primaryAccounts: {}}));
    await expect(client.reconnect()).rejects.toThrow('No mail account');
    fetchSpy.mockResolvedValueOnce(json(session()));
    await client.reconnect();
    fetchSpy.mockResolvedValue(json({ methodResponses: [['error', {type:'accountNotFound'}, '0']] }));
    const opened = await client.getEmail('old-ready');
    expect({sameScope: client.getSessionScope() === scope, returnedOld: opened?.bodyValues?.['1']?.value === 'PRIVATE-OLD-ACCOUNT'})
      .toEqual({sameScope: false, returnedOld: false});
  });
  it('401 refresh rejects an empty account list even when the old primary is named', async () => {
    const scope = client.getSessionScope();
    client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-ACCOUNT'), 10_000, scope);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(new Response('', {status:401}));
    fetchSpy.mockResolvedValueOnce(json({...session(), accounts: {}}));
    await client.getEmail('trigger-refresh');
    expect(client.getAccountId()).toBe('');
    expect(client.getSessionScope()).not.toBe(scope);
    expect(primed().size).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  it('TOTP refresh rejects empty accounts and preserves the original 401', async () => {
    const scope = client.getSessionScope();
    client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-ACCOUNT'), 10_000, scope);
    const prompt = vi.fn().mockResolvedValue('123456');
    client.enableTotpReauth('p', prompt);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(new Response('', {status:401}));
    fetchSpy.mockResolvedValueOnce(new Response('', {status:402}));
    fetchSpy.mockResolvedValueOnce(json({...session(), accounts:{},primaryAccounts:{}}));
    const fetcher = client as unknown as {authenticatedFetch: (url:string) => Promise<Response>};
    const response = await fetcher.authenticatedFetch('https://mail.example.test/jmap/api');
    expect(response.status).toBe(401);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(client.getAccountId()).toBe('');
    expect(client.getSessionScope()).not.toBe(scope);
    expect(primed().size).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  it('failed ordinary refresh preserves the original 401 and sends no API retry', async () => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(new Response('', {status:401}));
    fetchSpy.mockResolvedValueOnce(json({...session(), accounts:{},primaryAccounts:{}}));
    const fetcher = client as unknown as {authenticatedFetch: (url:string) => Promise<Response>};
    const response = await fetcher.authenticatedFetch('https://mail.example.test/jmap/api');
    expect(response.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

it('401 refresh requires an own account entry, not an inherited property', async () => {
  const named = {...session(), accounts: {constructor: session().accounts['acct-1']}, primaryAccounts: {'urn:ietf:params:jmap:mail': 'constructor'}};
  expect(client.adoptSession(named)).toBe(true);
  const scope = client.getSessionScope();
  client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-ACCOUNT'), 10_000, scope);
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValueOnce(new Response('', {status:401}));
  fetchSpy.mockResolvedValueOnce(json({...named, accounts:{}}));
  fetchSpy.mockResolvedValue(json({methodResponses:[['error',{type:'accountNotFound'},'0']]}));
  expect(await client.getEmail('trigger-refresh')).toBeNull();
  const opened = await client.getEmail('old-ready');
  expect({account:client.getAccountId(),sameScope:client.getSessionScope()===scope,returnedOld:opened?.bodyValues?.['1']?.value==='PRIVATE-OLD-ACCOUNT'})
    .toEqual({account:'',sameScope:false,returnedOld:false});
});
