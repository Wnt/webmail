// The mobile conversation view built its own sanitizer hook, which caught
// only <img src> and inline style url(), and a CSP that always allowed
// http:/https: images - so with remote content blocked (default policy
// 'ask') srcset, background attributes, posters and <source> still loaded.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const t = Object.assign((k: string) => k, { raw: (k: string) => k, rich: (k: string) => k });
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));

const TRACKERS = ['upper.gif', 'srcset.gif', 'bgattr.gif', 'poster.gif', 'source.gif'];
const HTML = `
<p>hello</p>
<img src="HTTPS://t.example/upper.gif">
<img srcset="https://t.example/srcset.gif 1x">
<table background="https://t.example/bgattr.gif"><tr><td>x</td></tr></table>
<video poster="https://t.example/poster.gif"></video>
<picture><source srcset="https://t.example/source.gif"><img alt="p"></picture>
`;

describe('conversation view honours the remote-content block', () => {
  it('emits no live tracker URL and a strict img-src while blocked', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    expect(useSettingsStore.getState().externalContentPolicy).toBe('ask');
    const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
    const email = {
      id: 'e1', threadId: 't1', mailboxIds: { a: true }, keywords: { $seen: true },
      from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
      subject: 's', receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hello', hasAttachment: false,
      htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], attachments: [],
      bodyValues: { '1': { value: HTML } },
    };
    const { container } = render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails: [email], latestEmail: email } as never}
        emails={[email] as never}
        onBack={() => {}}
      />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const srcdoc = iframe!.getAttribute('srcdoc') ?? '';
    // A live attribute, not the inert data-blocked-* copy the blocker keeps.
    const live = TRACKERS.filter((name) => new RegExp(`\\s(src|srcset|background|poster)="[^"]*${name.replace('.', '\\.')}`, 'i').test(srcdoc));
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(srcdoc)?.[1] ?? '';
    expect(live).toEqual([]);
    expect(csp).not.toMatch(/img-src[^;]*https?:/);
  }, 30_000);
});

describe('conversation view header', () => {
  it('names the back button for screen readers', async () => {
    const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
    const email = {
      id: 'e2', threadId: 't2', mailboxIds: { a: true }, keywords: { $seen: true },
      from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
      subject: 's', receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hi', hasAttachment: false,
      htmlBody: [], textBody: [], attachments: [], bodyValues: {},
    };
    render(
      <ThreadConversationView
        thread={{ threadId: 't2', emails: [email], latestEmail: email } as never}
        emails={[email] as never}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'email_viewer.back_to_list' })).toBeInTheDocument();
  });
});

// Audit safari-links-1: the cards run the reading pane's sanitizer and link
// policy - no relative href survives to navigate the card frame (or, with the
// old blanket _blank, a new tab) to a route of our own origin.
describe('conversation view link policy', () => {
  it('drops relative hrefs and keeps web, mailto and fragment links', async () => {
    const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');
    const html = '<style>p{color:red}</style><a href="/oauth/end_session" target="_blank">r</a>'
      + '<a href="https://outside.example/x" target="_top">w</a><a href="mailto:reader@example.test">m</a>'
      + '<a href="#s">f</a><map name="m"><area href="?view=x" coords="0,0,1,1"></map>';
    const email = {
      id: 'e3', threadId: 't3', mailboxIds: { a: true }, keywords: { $seen: true },
      from: [{ name: 'Sender', email: 'sender@t.example' }], to: [{ email: 'me@example.org' }],
      subject: 's', receivedAt: '2026-09-26T10:00:00Z', size: 1, preview: 'hi', hasAttachment: false,
      htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], attachments: [],
      bodyValues: { '1': { value: html } },
    };
    const { container } = render(
      <ThreadConversationView
        thread={{ threadId: 't3', emails: [email], latestEmail: email } as never}
        emails={[email] as never}
        onBack={() => {}}
      />,
    );
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc') ?? '';
    const body = new DOMParser().parseFromString(srcdoc, 'text/html').body;
    const [relative, web, mail, fragment] = Array.from(body.querySelectorAll('a'));
    expect(relative.hasAttribute('href')).toBe(false);
    expect(relative.hasAttribute('target')).toBe(false);
    expect(web.getAttribute('href')).toBe('https://outside.example/x');
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mail.getAttribute('href')).toBe('mailto:reader@example.test');
    expect(mail.hasAttribute('target')).toBe(false);
    expect(fragment.getAttribute('href')).toBe('#s');
    expect(body.querySelector('area')!.hasAttribute('href')).toBe(false);
    // The cards still drop the sender's <style> blocks.
    expect(body.innerHTML).not.toContain('color:red');
  }, 30_000);
});
