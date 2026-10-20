// Fork (Wnt/webmail), review swipe-trust r3 (the reviewer's probes kept as
// regression tests): a header written in two spellings still reaches the spam
// and list readers after getEmail groups the headers.
import { expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { extractListHeaders } from '@/lib/email-headers';

it('case-insensitive grouping preserves spam and list consumers', async () => {
  const client = new JMAPClient('https://mail.example.test', 'review', 'password');
  const fields = [
    ['X-Spam-Score', 'spam, score=7.0'],
    ['X-Spam-LLM', 'SPAM (example explanation)'],
    ['List-Unsubscribe', '<mailto:leave@example.test>'],
    ['List-Id', 'Example list <list.example.test>'],
  ];
  const email = { id: 'case-consumers', headers: fields.flatMap(([name,value]) => [{name: name.toLowerCase(), value}, {name, value}]) };
  const request = vi.spyOn(client as any, 'request').mockResolvedValue({methodResponses: [['Email/get', {list: [email]}, '0']]});
  try {
    const parsed = (await client.getEmail(email.id))!;
    expect(parsed.spamScore).toBe(7);
    expect(parsed.spamLLM?.verdict).toBe('SPAM');
    expect(extractListHeaders(parsed.headers!).listUnsubscribe?.mailto).toBe('mailto:leave@example.test');
    expect(extractListHeaders(parsed.headers!).listId).toBe('Example list <list.example.test>');
  } finally { request.mockRestore(); client.disconnect(); }
});
