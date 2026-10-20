import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Fork (Wnt/webmail), owner report 2026-10-20 on Bulwark 6fd6d1eb: while
// swiping, the neighbour pane showed "Images and external content have been
// blocked" for a message that opened without it (the pane had decided before
// the trusted-senders address book loaded and never decided again). The pane
// and the reading pane now share one decision (hooks/use-external-content.ts)
// and one banner rule (showsBlockedContentBanner): for the same message they
// show the same banner and block the same remote content, in every trust
// state, also when the trust data arrives after the pane was drawn.
//
// Review swipe-trust r1 (the reviewer's probes kept as regression tests): trust
// added and revoked while mounted, a forged trusted From (failed sender checks)
// staying blocked when the trust lists arrive, the phone conversation cards on
// the same decision, the reader's buttons, and plugin/TNEF/rfc822 bodies.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { SwipePeek } = await import('../swipe-peek');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useContactStore } = await import('@/stores/contact-store');
const { __clearEmailContentCache } = await import('@/lib/email-content-cache');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
// Invented senders and a remote image on an invented host.
const UNKNOWN = 'news@unknown-sender.test';
const TRUSTED = 'letters@trusted-sender.test';
const mail = (id: string, from: string): Email => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Examplepaja', email: from }], to: [], subject: `Subject ${id}`, receivedAt: '2026-01-01T00:00:00Z',
  preview: 'p', hasAttachment: false, size: 10, textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: `<p>Body ${id}</p><img src="https://images.example.test/${id}.png">`, isTruncated: false } },
} as unknown as Email);

/** What a view shows for the message: the banner, and whether its frame may load the remote image. */
function state(container: HTMLElement) {
  const frame = container.querySelector('iframe') as HTMLIFrameElement | null;
  const doc = frame?.getAttribute('srcdoc') ?? '';
  return {
    banner: (container.textContent ?? '').includes('external_content_warning'),
    remoteAllowed: /img-src data: blob: http: https:/.test(doc),
    // A blocked image keeps its URL only in data-blocked-src (for "Load images").
    imageLive: / src="https:\/\/images\.example\.test\//.test(doc),
  };
}

function both(email: Email) {
  const peek = render(<SwipePeek neighbour={{ row: { ...email, bodyValues: undefined } as unknown as Email, email }} isDark={false} />);
  const reader = render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  return { peek, reader };
}

beforeEach(() => {
  __clearEmailContentCache();
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [], trustedSendersAddressBook: false } as never);
  useContactStore.setState({ trustedSenderEmails: [], trustedSendersLoaded: false } as never);
});


const { ThreadConversationView } = await import('../thread-conversation-view');
const { renderHooks } = await import('@/lib/plugin-hooks');
const blocked = { banner: true, remoteAllowed: false, imageLive: false };
const allowed = { banner: false, remoteAllowed: true, imageLive: true };
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

it('unrelated late book cannot unblock unknown sender or display-name impersonation', async () => {
  useSettingsStore.setState({ trustedSendersAddressBook: true });
  const email = mail('unknown-late', UNKNOWN);
  email.from = [{ name: TRUSTED, email: UNKNOWN }];
  email.bodyValues!['1'].value += `<p>${TRUSTED}</p><span data-trusted="true">trusted</span>`;
  const views = both(email);
  act(() => useContactStore.setState({ trustedSenderEmails: [TRUSTED], trustedSendersLoaded: true }));
  await settle();
  expect(state(views.peek.container)).toEqual(blocked);
  expect(state(views.reader.container)).toEqual(blocked);
});

it.each(['list', 'book'])('mounted peek and reader react to %s trust addition and revocation', async source => {
  useSettingsStore.setState({ trustedSendersAddressBook: source === 'book' });
  const views = both(mail(`revoke-${source}`, TRUSTED));
  const update = (emails: string[]) => source === 'book'
    ? useContactStore.setState({ trustedSenderEmails: emails })
    : useSettingsStore.setState({ trustedSenders: emails });
  act(() => { update([TRUSTED]); });
  await settle();
  expect(state(views.peek.container)).toEqual(allowed);
  expect(state(views.reader.container)).toEqual(allowed);
  act(() => { update([]); });
  await settle();
  expect(state(views.peek.container)).toEqual(blocked);
  expect(state(views.reader.container)).toEqual(blocked);
});

it('disabling address book and changing policy rebuild body and CSP', async () => {
  useSettingsStore.setState({ trustedSendersAddressBook: true });
  useContactStore.setState({ trustedSenderEmails: [TRUSTED] });
  const views = both(mail('toggle-book', TRUSTED));
  expect(state(views.peek.container)).toEqual(allowed);
  act(() => useSettingsStore.setState({ trustedSendersAddressBook: false }));
  expect(state(views.peek.container)).toEqual(blocked);
  expect(state(views.reader.container)).toEqual(blocked);
  act(() => useSettingsStore.setState({ externalContentPolicy: 'allow' }));
  expect(state(views.peek.container)).toEqual(allowed);
  expect(state(views.reader.container)).toEqual(allowed);
  act(() => useSettingsStore.setState({ externalContentPolicy: 'block' }));
  expect(state(views.peek.container)).toEqual(blocked);
  expect(state(views.reader.container)).toEqual(blocked);
});

it.each(['load_external_content', 'trust_sender'])('reader %s works', async button => {
  const email = mail(`button-${button}`, UNKNOWN);
  const views = both(email);
  fireEvent.click(views.reader.getByRole('button', { name: button }));
  await settle();
  expect(state(views.reader.container)).toEqual(allowed);
  expect(state(views.peek.container)).toEqual(button === 'trust_sender' ? allowed : blocked);
});

it('plugin body owns banner, changes with trust, and clears banner for text replacement', async () => {
  const plugin = vi.spyOn(renderHooks.onRenderEmailBody, 'transform').mockResolvedValue({
    html: '<p>PLUGIN-REVIEW</p><img src="https://images.example.test/plugin.png">', text: '', attachments: [], handledBy: 'review',
  });
  try {
    const email = mail('plugin-review', UNKNOWN);
    email.bodyValues!['1'].value = '<p>ordinary body has no images</p>';
    const view = render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await waitFor(() => expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('PLUGIN-REVIEW'));
    expect(state(view.container)).toEqual(blocked);
    act(() => useSettingsStore.setState({ trustedSenders: [UNKNOWN] }));
    expect(state(view.container)).toEqual(allowed);
    act(() => useSettingsStore.setState({ trustedSenders: [] }));
    expect(state(view.container)).toEqual(blocked);
    plugin.mockResolvedValue({ html: '', text: 'PLUGIN-TEXT-REVIEW', attachments: [], handledBy: 'review' });
    act(() => window.dispatchEvent(new Event('plugin:rerender-email')));
    await waitFor(() => expect(view.container.textContent).toContain('PLUGIN-TEXT-REVIEW'));
    expect(state(view.container).banner).toBe(false);
  } finally { plugin.mockRestore(); }
});

it.each(['list', 'book'])('failed-auth forged trusted From must remain blocked after %s arrives', async source => {
  useSettingsStore.setState({ trustedSendersAddressBook: source === 'book' });
  const email = mail(`forged-${source}`, TRUSTED);
  email.authenticationResults = { dmarc: { result: 'fail', domain: 'trusted-sender.test' }, spf: { result: 'fail' }, dkim: { result: 'fail' } };
  const views = both(email);
  expect(state(views.peek.container)).toEqual(blocked);
  act(() => {
    if (source === 'book') useContactStore.setState({ trustedSenderEmails: [TRUSTED], trustedSendersLoaded: true });
    else useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  });
  await settle();
  expect.soft(state(views.peek.container)).toEqual(blocked);
  expect.soft(state(views.reader.container)).toEqual(blocked);
});

it.each(['list', 'book'])('conversation must revoke %s trust while mounted', async source => {
  useSettingsStore.setState({ trustedSendersAddressBook: source === 'book', trustedSenders: source === 'list' ? [TRUSTED] : [] });
  useContactStore.setState({ trustedSenderEmails: source === 'book' ? [TRUSTED] : [] });
  const email = mail(`thread-${source}`, TRUSTED);
  const view = render(<ThreadConversationView thread={{ threadId: email.threadId, emails: [email], latestEmail: email } as never} emails={[email]} onBack={() => {}} />);
  expect(state(view.container).remoteAllowed).toBe(true);
  act(() => {
    if (source === 'book') useContactStore.setState({ trustedSenderEmails: [] });
    else useSettingsStore.setState({ trustedSenders: [] });
  });
  await settle();
  expect(state(view.container).remoteAllowed).toBe(false);
});

it('conversation reacts to late trust book', async () => {
  useSettingsStore.setState({ trustedSendersAddressBook: true });
  const email = mail('thread-late', TRUSTED);
  const view = render(<ThreadConversationView thread={{ threadId: email.threadId, emails: [email], latestEmail: email } as never} emails={[email]} onBack={() => {}} />);
  expect(state(view.container).remoteAllowed).toBe(false);
  act(() => useContactStore.setState({ trustedSenderEmails: [TRUSTED], trustedSendersLoaded: true }));
  await settle();
  expect(state(view.container).remoteAllowed).toBe(true);
});


it.each(['tnef', 'rfc822'])('%s extracted body derives banner and applies Load images', async format => {
  const { JMAPClient } = await import('@/lib/jmap/client');
  const tnef = await import('@/lib/tnef');
  const client = new JMAPClient('https://mail.example.test', 'review', 'password');
  const html = '<p>EXTRACTED-REVIEW</p><img src="https://images.example.test/extracted.png">';
  const mime = 'From: nested@untrusted.test\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + html;
  const bytes = new TextEncoder().encode(mime);
  const fetch = vi.spyOn(client, 'fetchBlobArrayBuffer').mockResolvedValue(bytes.buffer);
  const { default: PostalMime } = await import('postal-mime');
  const mimeParse = vi.spyOn(PostalMime.prototype, 'parse').mockResolvedValue({ html, attachments: [] } as never);
  const parse = vi.spyOn(tnef, 'parseTnef').mockReturnValue({ htmlBody: html, body: '', attachments: [] } as never);
  try {
    const email = mail(`extracted-${format}`, UNKNOWN);
    email.htmlBody = []; email.bodyValues = {};
    email.attachments = [{ partId: '2', blobId: 'extract', name: format === 'tnef' ? 'winmail.dat' : 'forward.eml', type: format === 'tnef' ? 'application/ms-tnef' : 'message/rfc822', size: bytes.length }] as Email['attachments'];
    const view = render(<EmailViewer email={email} blobSource={{ client }} mailboxes={mailboxes} />);
    await waitFor(() => expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-REVIEW'), { timeout: 10000 });
    expect(state(view.container)).toEqual(blocked);
    fireEvent.click(view.getByRole('button', { name: 'load_external_content' }));
    expect(state(view.container)).toEqual(allowed);
    view.unmount();
  } finally { fetch.mockRestore(); parse.mockRestore(); mimeParse.mockRestore(); client.disconnect(); }
});

// Review swipe-trust r1 R1, the other requested cases: trust already loaded, the raw header of a message fetched
// ahead (no parsed results yet), a change of the same message's results, a trusted sender whose checks pass, and
// the conversation cards.
const FORGED = { dmarc: { result: 'fail', domain: 'trusted-sender.test' }, spf: { result: 'fail' }, dkim: { result: 'fail' } };

it.each(['list', 'book'])('a forged trusted From stays blocked when the %s was loaded before', async source => {
  useSettingsStore.setState({ trustedSendersAddressBook: source === 'book', trustedSenders: source === 'list' ? [TRUSTED] : [] });
  useContactStore.setState({ trustedSenderEmails: source === 'book' ? [TRUSTED] : [], trustedSendersLoaded: true });
  const email = mail(`forged-pre-${source}`, TRUSTED);
  email.authenticationResults = FORGED as never;
  const views = both(email);
  await settle();
  expect(state(views.peek.container)).toEqual(blocked);
  expect(state(views.reader.container)).toEqual(blocked);
});

it('a message fetched ahead with only the raw header: its failed checks count in the pane as in the reader', async () => {
  useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  const raw = ' mx.example.test; spf=fail smtp.mailfrom=trusted-sender.test; dkim=fail header.d=trusted-sender.test; dmarc=fail header.from=trusted-sender.test';
  const ahead = mail('forged-raw', TRUSTED);
  (ahead as unknown as { headers: unknown }).headers = [{ name: 'Authentication-Results', value: raw }];
  const opened = { ...ahead, headers: { 'Authentication-Results': raw } } as unknown as Email;
  const peek = render(<SwipePeek neighbour={{ row: { ...ahead, bodyValues: undefined } as unknown as Email, email: ahead }} isDark={false} />);
  const reader = render(<EmailViewer email={opened} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  await settle();
  expect(state(peek.container)).toEqual(blocked);
  expect(state(reader.container)).toEqual(blocked);
});

it('the same message decided again when its results change; a trusted sender whose checks pass keeps its pictures', async () => {
  useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  const email = mail('auth-change', TRUSTED);
  email.authenticationResults = { dkim: { result: 'pass', domain: 'trusted-sender.test' } } as never;
  const peek = render(<SwipePeek neighbour={{ row: { ...email, bodyValues: undefined } as unknown as Email, email }} isDark={false} />);
  await settle();
  expect(state(peek.container)).toEqual(allowed);
  const forged = { ...email, authenticationResults: FORGED } as unknown as Email;
  peek.rerender(<SwipePeek neighbour={{ row: { ...forged, bodyValues: undefined } as unknown as Email, email: forged }} isDark={false} />);
  await settle();
  expect(state(peek.container)).toEqual(blocked);
});

it.each(['list', 'book'])('conversation: a forged trusted From stays blocked when the %s arrives', async source => {
  useSettingsStore.setState({ trustedSendersAddressBook: source === 'book' });
  const email = mail(`thread-forged-${source}`, TRUSTED);
  email.authenticationResults = FORGED as never;
  const view = render(<ThreadConversationView thread={{ threadId: email.threadId, emails: [email], latestEmail: email } as never} emails={[email]} onBack={() => {}} />);
  expect(state(view.container).remoteAllowed).toBe(false);
  act(() => {
    if (source === 'book') useContactStore.setState({ trustedSenderEmails: [TRUSTED], trustedSendersLoaded: true });
    else useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  });
  await settle();
  expect(state(view.container).remoteAllowed).toBe(false);
  expect(state(view.container).imageLive).toBe(false);
});
