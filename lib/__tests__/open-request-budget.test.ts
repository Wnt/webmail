import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { threadKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Performance regression budget: how many JMAP requests opening a
// conversation costs, counted at the fetch boundary with a small fake JMAP
// server. These are work counts, not timings, so they hold on a loaded CI host.
//
// - Expanding a conversation is ONE request: Thread/get + Email/get by result
//   reference (c20900f2; before it, two sequential round trips).
// - A desktop click on a collapsed conversation (expand + open the newest
//   message, as ThreadListItem and MailApp.handleEmailSelect do) fetches the
//   newest message once, not twice (2086b64d).

const session = {
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl: 'https://mail.example.com/jmap/api',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
};
const THREAD = { id: 'T', emailIds: ['m1', 'm2', 'm3'] };
const received = (id: string) => `2026-0${THREAD.emailIds.indexOf(id) + 1}-01T00:00:00Z`;
const fullEmail = (id: string) => ({
  id, threadId: 'T', mailboxIds: { inbox: true }, keywords: { $seen: true }, size: 10, receivedAt: received(id),
  subject: 's', preview: 'p', from: [{ email: 'a@example.com' }], to: [],
  textBody: [{ partId: '1', type: 'text/plain', size: 4 }], htmlBody: [],
  bodyValues: { '1': { value: 'Body', isEncodingProblem: false, isTruncated: false } },
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

type Call = [string, Record<string, unknown>, string];
/** Every JMAP API POST, as the method calls it carried. */
let posts: Call[][];

// Answers Thread/get and Email/get (plain ids or #ids from a Thread/get in the
// same request), as a JMAP server would.
function fakeJmap(_url: string, init?: RequestInit): Promise<Response> {
  const { methodCalls } = JSON.parse(String(init?.body)) as { methodCalls: Call[] };
  posts.push(methodCalls);
  const out: Call[] = [];
  const byTag = new Map<string, Record<string, unknown>>();
  for (const [name, args, tag] of methodCalls) {
    let res: Record<string, unknown>;
    if (name === 'Thread/get') {
      res = { accountId: 'acct-1', state: 's', list: (args.ids as string[]).filter((i) => i === 'T').map(() => THREAD), notFound: [] };
    } else if (name === 'Email/get') {
      const ref = args['#ids'] as { resultOf: string } | undefined;
      const ids = ref ? ((byTag.get(ref.resultOf)?.list as { emailIds: string[] }[]) ?? []).flatMap((t) => t.emailIds) : (args.ids as string[]);
      res = { accountId: 'acct-1', state: 's', list: ids.map(fullEmail), notFound: [] };
    } else {
      res = { accountId: 'acct-1', state: 's', list: [] };
    }
    byTag.set(tag, res);
    out.push([name, res, tag]);
  }
  return Promise.resolve(json({ sessionState: 's', methodResponses: out }));
}

/** Email/get calls that fetch `id`, by id or through a Thread/get reference. */
function emailGetsFor(id: string): number {
  return posts.flat().filter(([name, args]) =>
    name === 'Email/get' && (args['#ids'] ? THREAD.emailIds.includes(id) : (args.ids as string[]).includes(id))).length;
}

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', myRights: {} } as unknown as Mailbox;
const listRow = { ...fullEmail('m3'), bodyValues: undefined } as unknown as Email;

let fetchSpy: ReturnType<typeof vi.spyOn>;
let client: JMAPClient;

beforeEach(async () => {
  posts = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(json(session));
  client = new JMAPClient('https://mail.example.com', 'u', 'p');
  await client.connect();
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(fakeJmap as never);
  useAuthStore.setState({ activeAccountId: 'login-1', client: client as never, getClientForAccount: () => undefined } as never);
  useEmailStore.setState({
    isUnifiedView: false, unifiedRole: null, selectedMailbox: 'inbox', viewingAccountId: null,
    mailboxes: [inbox], accountMailboxes: {}, emails: [listRow],
    expandedThreadIds: new Set(), threadEmailsCache: new Map(), threadEmailCounts: new Map(),
    isLoadingThread: null, processingReadStatus: new Set(),
  } as never);
});
afterEach(() => {
  client.disconnect();
  fetchSpy.mockRestore();
});

describe('conversation open request budget', () => {
  it('expanding a conversation costs one JMAP request: Thread/get + Email/get by back-reference', async () => {
    const emails = await useEmailStore.getState().fetchThreadEmails(client, threadKeyFor(listRow));
    expect(emails.map((e) => e.id)).toEqual(['m3', 'm2', 'm1']);
    expect(posts).toHaveLength(1);
    expect(posts[0].map((c) => c[0])).toEqual(['Thread/get', 'Email/get']);
    expect(posts[0][1][1]).not.toHaveProperty('ids');
    expect(posts[0][1][1]['#ids']).toEqual({ resultOf: posts[0][0][2], name: 'Thread/get', path: '/list/*/emailIds' });
  });

  it('a desktop click on a collapsed conversation fetches the newest message once', async () => {
    // ThreadListItem's click: onToggleExpand (EmailList -> store.fetchThreadEmails)
    // and onEmailSelect(latest) (MailApp.handleEmailSelect -> getEmail with the
    // row's threadId) at the same moment.
    const [thread, opened] = await Promise.all([
      useEmailStore.getState().fetchThreadEmails(client, threadKeyFor(listRow)),
      client.getEmail(listRow.id, undefined, { threadId: listRow.threadId }),
    ]);
    expect(thread).toHaveLength(3);
    expect(opened?.id).toBe('m3');
    expect(opened?.bodyValues?.['1']?.value).toBe('Body');
    expect(emailGetsFor('m3')).toBe(1);
    expect(posts).toHaveLength(1);
  });
});

// Fork (Wnt/webmail): a tapped notification's message, kept by the push
// worker (lib/push-prefetch.ts), opens without a JMAP request - once.
describe('notification tap request budget', () => {
  it('a primed message opens with no Email/get; the next open of it fetches again', async () => {
    client.primeEmail(fullEmail('m2') as unknown as Email);
    const first = await client.getEmail('m2');
    expect(first?.bodyValues?.['1']?.value).toBe('Body');
    expect(posts).toHaveLength(0);
    await client.getEmail('m2');
    expect(emailGetsFor('m2')).toBe(1);
  });

  it('a primed message of another account is not used', async () => {
    client.primeEmail(fullEmail('m1') as unknown as Email, 'acct-other');
    await client.getEmail('m1');
    expect(emailGetsFor('m1')).toBe(1);
  });
});
