import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// Opening a conversation sends Thread/get and the members' Email/get in one
// request (a result reference), instead of waiting for the thread first.

const session = {
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 } },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl: 'https://mail.example.com/jmap/api',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const email = (id: string, receivedAt: string) => ({ id, receivedAt, bodyValues: {}, textBody: [], htmlBody: [] });

describe('getThreadEmails', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  async function connected(): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(json(session));
    const client = new JMAPClient('https://mail.example.com', 'u', 'p');
    await client.connect();
    fetchSpy.mockReset();
    return client;
  }

  it('fetches the thread and its emails in one request', async () => {
    const client = await connected();
    const bodies: unknown[] = [];
    fetchSpy.mockImplementation((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return json({ sessionState: 's', methodResponses: [
        ['Thread/get', { list: [{ id: 'T', emailIds: ['a', 'b'] }] }, 't'],
        ['Email/get', { list: [email('a', '2026-01-01T00:00:00Z'), email('b', '2026-02-01T00:00:00Z')] }, 'e'],
      ] });
    }) as never);
    const emails = await client.getThreadEmails('T');
    expect(bodies).toHaveLength(1);
    const calls = (bodies[0] as { methodCalls: [string, Record<string, unknown>, string][] }).methodCalls;
    expect(calls.map((c) => c[0])).toEqual(['Thread/get', 'Email/get']);
    expect(calls[1][1]['#ids']).toEqual({ resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' });
    expect(emails.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('falls back to batches when the combined Email/get is refused', async () => {
    const client = await connected();
    const sent: string[][] = [];
    fetchSpy.mockImplementation((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      sent.push(body.methodCalls.map((c) => c[0]));
      if (body.methodCalls[0][0] === 'Thread/get') {
        return json({ sessionState: 's', methodResponses: [
          ['Thread/get', { list: [{ id: 'T', emailIds: ['a', 'b', 'c'] }] }, 't'],
          ['error', { type: 'requestTooLarge' }, 'e'],
        ] });
      }
      const ids = body.methodCalls[0][1].ids as string[];
      return json({ sessionState: 's', methodResponses: [['Email/get', { list: ids.map((id, i) => email(id, `2026-0${i + 1}-01T00:00:00Z`)) }, '0']] });
    }) as never);
    const emails = await client.getThreadEmails('T');
    expect(sent).toEqual([['Thread/get', 'Email/get'], ['Email/get'], ['Email/get']]);
    expect(emails.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('getEmail reuses a conversation fetch that is in flight', async () => {
    const client = await connected();
    const sent: string[][] = [];
    fetchSpy.mockImplementation((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      sent.push(body.methodCalls.map((c) => c[0]));
      if (body.methodCalls[0][0] === 'Thread/get') {
        return json({ sessionState: 's', methodResponses: [
          ['Thread/get', { list: [{ id: 'T', emailIds: ['a', 'b'] }] }, 't'],
          ['Email/get', { list: [email('a', '2026-01-01T00:00:00Z'), email('b', '2026-02-01T00:00:00Z')] }, 'e'],
        ] });
      }
      return json({ sessionState: 's', methodResponses: [['Email/get', { list: [email('b', '2026-02-01T00:00:00Z')] }, '0']] });
    }) as never);
    const [thread, newest] = await Promise.all([client.getThreadEmails('T'), client.getEmail('b', undefined, { threadId: 'T' })]);
    expect(sent).toEqual([['Thread/get', 'Email/get']]);
    expect(newest?.id).toBe('b');
    expect(newest).not.toBe(thread[0]); // a copy: the open message and the thread list don't share an object
    // Another thread, or no thread hint: fetched as before.
    await client.getEmail('b');
    await client.getEmail('b', undefined, { threadId: 'other' });
    expect(sent).toEqual([['Thread/get', 'Email/get'], ['Email/get'], ['Email/get']]);
  });
});

