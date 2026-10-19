// Fork (Wnt/webmail): on the phone a conversation opens in the conversation
// view; the open (newest) card of a fresh sign-in mail starts with the same
// one-time-code bar as the reading view, older code mails keep the chip.
// Invented senders and codes only.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const t = Object.assign((k: string) => k, { raw: (k: string) => k, rich: (k: string) => k });
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));

const message = (id: string, code: string, receivedAt: string) => ({
  id, threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ email: 'me@example.org' }],
  subject: 'Sign in to Examplepaja', receivedAt, size: 1, preview: 'Your code', hasAttachment: false,
  htmlBody: [], textBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: `Your verification code is ${code}.`, isTruncated: false } },
});

async function renderConversation(newest: ReturnType<typeof message>, older: ReturnType<typeof message>) {
  const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
  return render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails: [newest, older], latestEmail: newest } as never}
      emails={[newest, older] as never}
      onBack={() => {}}
    />,
  );
}

describe('conversation view code bar', () => {
  it('the open card of a fresh code mail starts with the bar', async () => {
    const now = Date.now();
    await renderConversation(
      message('e2', '771204', new Date(now - 60_000).toISOString()),
      message('e1', '604217', new Date(now - 3 * 86_400_000).toISOString()),
    );
    const bars = screen.getAllByTestId('verification-code-bar');
    expect(bars).toHaveLength(1);
    expect(screen.getByTestId('verification-code-value')).toHaveTextContent('771204');
    expect(screen.queryByTestId('verification-code-chip')).toBeNull();
  }, 30_000);

  it('an old code mail keeps the chip', async () => {
    const now = Date.now();
    await renderConversation(
      message('e2', '771204', new Date(now - 2 * 86_400_000).toISOString()),
      message('e1', '604217', new Date(now - 3 * 86_400_000).toISOString()),
    );
    expect(screen.queryByTestId('verification-code-bar')).toBeNull();
    expect(screen.getByTestId('verification-code-chip')).toBeInTheDocument();
  }, 30_000);
});
