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
    client.primeEmailForOpen('m1', full('m1', 'Copy from the old session'), 10_000);
    (client as unknown as { apiUrl: string }).apiUrl = 'https://other.example.test/jmap/api';
    const opened = await client.getEmail('m1');
    expect(opened?.bodyValues?.['1']?.value).toBe('Server body of m1');
    expect(gets).toEqual(['m1']);
  });

  it('a fetch that ends after its session was replaced is not used', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const pending = gate.then(() => full('m2', 'Copy from the old session'));
    client.primeEmailForOpen('m2', pending, 10_000);
    const opening = client.getEmail('m2');
    (client as unknown as { apiUrl: string }).apiUrl = 'https://other.example.test/jmap/api';
    release();
    const opened = await opening;
    expect(opened?.bodyValues?.['1']?.value).toBe('Server body of m2');
  });

  it('fetchEmailAhead keeps nothing in the client', async () => {
    const e = await client.fetchEmailAhead('m3');
    expect(e?.id).toBe('m3');
    expect(primed().size).toBe(0);
  });
});
