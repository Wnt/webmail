// A collapsed message card in the conversation view shows the message's
// preview under a two-line clamp. A long link in it could not wrap, so it ran
// past the card and was cut off at the edge with no ellipsis. jsdom has no
// layout, so this pins the classes that keep it inside the card.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const t = Object.assign((k: string) => k, { raw: (k: string) => k, rich: (k: string) => k });
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));

const LONG = 'This newsletter is in HTML only. Read it at https://news.examplepaja.test/v/'
  + 'aGVsbG8td29ybGQtZXhhbXBsZXBhamEtdG9rZW4'.repeat(4);

const message = (id: string, preview: string, receivedAt: string) => ({
  id, threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ email: 'me@example.org' }],
  subject: 'Autumn news', receivedAt, size: 1, preview, hasAttachment: false,
  htmlBody: [], textBody: [], attachments: [], bodyValues: {},
});

describe('conversation view collapsed card preview', () => {
  it('clamps a long link to two lines and lets it break inside the card', async () => {
    const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
    const older = message('e1', LONG, '2026-09-25T10:00:00Z');
    const newest = message('e2', 'Thanks, see you on Monday.', '2026-09-26T10:00:00Z');
    // Newest first, as the view gets them: the newest opens, the older one stays a card.
    const { container } = render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails: [newest, older], latestEmail: newest } as never}
        emails={[newest, older] as never}
        onBack={() => {}}
      />,
    );
    const p = [...container.querySelectorAll('p')].find((el) => el.textContent?.includes('examplepaja.test'));
    expect(p).toBeDefined();
    expect(p).toHaveClass('line-clamp-2', 'wrap-anywhere');
  }, 30_000);
});
