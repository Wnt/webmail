import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { Email } from '../jmap/types';

// Fork (Wnt/webmail), review swipe-preload r7 R7-A (the reviewer's probes
// kept as regression tests): the session's mail account is the server's
// primary mail account, else a listed account that advertises mail - never
// an account that only serves contacts. A session whose account lost mail
// retires the old copies on revalidation, reconnect and 401 refresh; a saved
// session without a mail account is not adopted; transport failures, the
// same identity and another valid mail account behave as before.
// Fork (Wnt/webmail), review swipe-preload r6 R6-A/R6-B (the reviewer's
// probes kept as regression tests): a session answer that lists no mail
// account - through background revalidation, a reconnect, or a 401 refresh
// (also with TOTP) - retires the old account's kept copies for good, a later
// reconnect of the same identity does not bring them back, and an account
// counts only when the session itself lists it (not an inherited name).

const session = (apiUrl = 'https://mail.example.test/jmap/api') => ({
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:mail': {} },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
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


const withoutMail = () => ({
  ...session(),
  capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:contacts': {} },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} } } },
  primaryAccounts: { 'urn:ietf:params:jmap:contacts': 'acct-1' },
});

it.each(['revalidate', 'reconnect', 'refresh'] as const)('mail permission removal through %s invalidates old mail copies', async (path) => {
  const scope = client.getSessionScope();
  client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-MAIL'), 10_000, scope);
  fetchSpy.mockReset();
  if (path === 'refresh') fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
  fetchSpy.mockResolvedValueOnce(json(withoutMail()));
  fetchSpy.mockResolvedValue(json({ methodResponses: [['error', { type: 'accountNotFound' }, '0']] }));
  if (path === 'revalidate') await client.revalidateSession();
  if (path === 'reconnect') await client.reconnect().catch(() => {});
  if (path === 'refresh') await client.getEmail('trigger-refresh');
  const beforeOpen = fetchSpy.mock.calls.length;
  const opened = await client.getEmail('old-ready');
  console.log({ path, oldBodyReturnedWithoutRead: opened?.bodyValues?.['1']?.value === 'PRIVATE-OLD-MAIL' && fetchSpy.mock.calls.length === beforeOpen });
  expect({ sameScope: client.getSessionScope() === scope, returnedOld: opened?.bodyValues?.['1']?.value === 'PRIVATE-OLD-MAIL' })
    .toEqual({ sameScope: false, returnedOld: false });
});

it('adoptSession refuses a saved session without any mail-capable account', () => {
  expect(client.adoptSession(withoutMail())).toBe(false);
});

it('fallback selects a mail-capable account rather than the first unrelated account', () => {
  client.adoptSession({ ...session(), primaryAccounts: {}, accounts: {
    contacts: { name: 'Contacts', accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} } },
    'acct-1': session().accounts['acct-1'],
  } });
  expect(client.getAccountId()).toBe('acct-1');
});

it.each(['transport failure', 'valid same identity'] as const)('control: %s preserves ready copies', async (mode) => {
  const scope = client.getSessionScope();
  client.primeEmailForOpen('old-ready', full('old-ready', 'VALID-MAIL'), 10_000, scope);
  fetchSpy.mockReset();
  if (mode === 'transport failure') fetchSpy.mockRejectedValueOnce(new Error('offline'));
  else fetchSpy.mockResolvedValueOnce(json(session()));
  await client.revalidateSession();
  expect(client.getSessionScope()).toBe(scope);
  expect((await client.getEmail('old-ready'))?.bodyValues?.['1']?.value).toBe('VALID-MAIL');
});

it('control: a different valid mail account rejects the old primer', async () => {
  const scope = client.getSessionScope();
  client.primeEmailForOpen('old-ready', full('old-ready', 'PRIVATE-OLD-MAIL'), 10_000, scope);
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValueOnce(json({
    ...session(), accounts: { 'acct-2': session().accounts['acct-1'] },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-2' },
  }));
  fetchSpy.mockResolvedValue(json({ methodResponses: [['error', { type: 'accountNotFound' }, '0']] }));
  expect(await client.revalidateSession()).toBe('replaced');
  expect(client.getSessionScope()).not.toBe(scope);
  expect((await client.getEmail('old-ready'))?.bodyValues?.['1']?.value).not.toBe('PRIVATE-OLD-MAIL');
});
