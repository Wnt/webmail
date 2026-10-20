import { render, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Fork (Wnt/webmail), review swipe-trust r2 (the reviewer's probes kept as
// regression tests): the trusted-sender list and book apply only to a From the
// receiving server's checks authenticate (lib/email-headers.ts
// senderTrustCheck), read in order and without regard to the header's case
// (authenticationResultsValues) - in the reading pane, the swipe pane, the
// conversation cards, prewarming and getEmail alike. A pass for an unrelated
// domain or a lone HELO pass does not count. The conversation card offers
// "Load images" under "ask" only, as the reading pane does.

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
const blocked = { banner: true, remoteAllowed: false, imageLive: false };
const allowed = { banner: false, remoteAllowed: true, imageLive: true };


const { shouldBlockExternalFor, prewarmEmailContent, cachedEmailContent, emailContentCacheKey } = await import('@/lib/email-content-cache');
const { parseAuthenticationResults } = await import('@/lib/email-headers');
const failHeader = 'receiver.test; dmarc=fail header.from=trusted-sender.test; spf=fail smtp.mailfrom=trusted-sender.test; dkim=fail';
const options = { externalContentPolicy: 'ask', allowExternalContent: false, isSenderTrusted: () => true, trustedSendersAddressBook: false, isTrustedAddressBookSender: () => false };
const conversation = (email: Email) => <ThreadConversationView thread={{ threadId: email.threadId, emails: [email], latestEmail: email } as never} emails={[email]} onBack={() => {}} />;

it.each(['array', 'record'])('raw canonical %s failure blocks all three readers', kind => {
  useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  const email = mail(`canonical-${kind}`, TRUSTED);
  email.headers = (kind === 'array' ? [{ name: 'Authentication-Results', value: failHeader }] : {'Authentication-Results': failHeader}) as never;
  const views = both(email); const card = render(conversation(email));
  expect(state(views.reader.container)).toEqual(blocked);
  expect(state(views.peek.container)).toEqual(blocked);
  expect(state(card.container).remoteAllowed).toBe(false);
});

it.each(['array', 'record'])('lowercase receiver failure must block all readers (%s)', kind => {
  useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  const email = mail(`lowercase-${kind}`, TRUSTED);
  email.headers = (kind === 'array' ? [{ name: 'authentication-results', value: failHeader }] : {'authentication-results': failHeader}) as never;
  const views = both(email); const card = render(conversation(email));
  expect(state(views.reader.container)).toEqual(blocked);
  expect(state(views.peek.container)).toEqual(blocked);
  expect(state(card.container).remoteAllowed).toBe(false);
});

it('mixed casing cannot select the sender-supplied pass below receiver failure', () => {
  const email = mail('mixed', TRUSTED);
  email.headers = [
    { name: 'authentication-results', value: failHeader },
    { name: 'Authentication-Results', value: 'attacker.test; dmarc=pass header.from=trusted-sender.test' },
  ] as never;
  expect(shouldBlockExternalFor(email, options)).toBe(true);
});

it('single HELO pass does not authenticate From', () => {
  const email = mail('helo', TRUSTED);
  email.headers = {'Authentication-Results': 'receiver.test; spf=pass smtp.helo=attacker.test; dmarc=none'};
  expect(shouldBlockExternalFor(email, options)).toBe(true);
});

it.each(['spf', 'dkim'])('unaligned %s pass with no DMARC pass does not authenticate trusted From', method => {
  const email = mail(`unaligned-${method}`, TRUSTED);
  email.headers = {'Authentication-Results': method === 'spf'
    ? 'receiver.test; spf=pass smtp.mailfrom=attacker.test; dmarc=none'
    : 'receiver.test; dkim=pass header.d=attacker.test; dmarc=none'};
  expect(shouldBlockExternalFor(email, options)).toBe(true);
});

it('same message authentication updates rebuild every frame in both directions', () => {
  useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  const email = mail('auth-update', TRUSTED);
  const views = both(email); const card = render(conversation(email));
  for (const bad of [true, false]) {
    const updated = { ...email, authenticationResults: parseAuthenticationResults(bad ? failHeader : 'receiver.test; dmarc=pass header.from=trusted-sender.test') };
    views.reader.rerender(<EmailViewer email={updated} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    views.peek.rerender(<SwipePeek neighbour={{ row: updated, email: updated }} isDark={false} />);
    card.rerender(conversation(updated));
    expect(state(views.reader.container)).toEqual(bad ? blocked : allowed);
    expect(state(views.peek.container)).toEqual(bad ? blocked : allowed);
    expect(state(card.container).remoteAllowed).toBe(!bad);
  }
});

it('prewarm consults raw auth before selecting the cache permission', async () => {
  useSettingsStore.setState({ trustedSenders: [TRUSTED] });
  const email = mail('prewarm-failed', TRUSTED);
  email.headers = {'Authentication-Results': failHeader};
  prewarmEmailContent(email);
  await waitFor(() => expect(cachedEmailContent(emailContentCacheKey(email, true, {}), email)?.content.externalBlocked).toBe(true));
  expect(cachedEmailContent(emailContentCacheKey(email, false, {}), email)).toBeUndefined();
});

it('conversation Load images under ask loads the message; under block it is not offered (as in the reading pane)', () => {
  const view = render(conversation(mail('card-button-ask', UNKNOWN)));
  fireEvent.click(view.getByRole('button', {name: 'email_viewer.load_external_content'}));
  expect(state(view.container).remoteAllowed).toBe(true);
  expect(state(view.container).imageLive).toBe(true);
  view.unmount();
  useSettingsStore.setState({ externalContentPolicy: 'block' });
  const blockedView = render(conversation(mail('card-button-block', UNKNOWN)));
  expect(blockedView.queryByRole('button', {name: 'email_viewer.load_external_content'})).toBeNull();
  expect(state(blockedView.container).remoteAllowed).toBe(false);
  const reader = render(<EmailViewer email={mail('reader-button-block', UNKNOWN)} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  expect(reader.queryByRole('button', {name: 'load_external_content'})).toBeNull();
});

it('explicit allow under ask and global allow still override failed checks', () => {
  const email = mail('explicit', TRUSTED);
  email.authenticationResults = parseAuthenticationResults(failHeader);
  expect(shouldBlockExternalFor(email, {...options, allowExternalContent: true})).toBe(false);
  expect(shouldBlockExternalFor(email, {...options, externalContentPolicy: 'allow'})).toBe(false);
});

it('getEmail keeps the lowercase receiver failure authoritative over a lower canonical pass', async () => {
  const { JMAPClient } = await import('@/lib/jmap/client');
  const client = new JMAPClient('https://mail.example.test', 'review', 'password');
  const email = mail('get-email-case', TRUSTED);
  email.headers = [
    { name: 'authentication-results', value: failHeader },
    { name: 'Authentication-Results', value: 'attacker.test; dmarc=pass header.from=trusted-sender.test' },
  ] as never;
  const request = vi.spyOn(client as unknown as { request: () => Promise<unknown> }, 'request').mockResolvedValue({methodResponses: [['Email/get', {list: [email]}, '0']]} as never);
  try {
    const result = await client.getEmail(email.id);
    expect(result).not.toBeNull();
    expect(result!.authenticationResults?.dmarc?.result).toBe('fail');
    expect(shouldBlockExternalFor(result!, options)).toBe(true);
  } finally { request.mockRestore(); client.disconnect(); }
});

it('a trusted sender authenticated by an aligned DKIM signature or SPF MAIL FROM (a subdomain counts) keeps its pictures', () => {
  for (const header of [
    'receiver.test; dkim=pass header.d=trusted-sender.test; dmarc=none',
    'receiver.test; dkim=pass header.d=mail.trusted-sender.test; dmarc=none',
    'receiver.test; spf=pass smtp.mailfrom=bounce@trusted-sender.test; dmarc=none',
    'receiver.test; spf=pass smtp.mailfrom=trusted-sender.test; dkim=pass header.d=esp.test; dmarc=pass header.from=trusted-sender.test',
  ]) {
    const email = mail('aligned', TRUSTED);
    email.headers = {'Authentication-Results': header} as never;
    expect(shouldBlockExternalFor(email, options), header).toBe(false);
  }
});

it('no results at all (mail the server did not check): trust applies as before; the trust button shows only where trust would apply', () => {
  const email = mail('unchecked', TRUSTED);
  expect(shouldBlockExternalFor(email, options)).toBe(false);
  const forged = mail('forged-button', UNKNOWN);
  forged.authenticationResults = parseAuthenticationResults('receiver.test; spf=pass smtp.mailfrom=attacker.test; dmarc=none');
  const reader = render(<EmailViewer email={forged} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  expect(reader.queryByRole('button', {name: 'trust_sender'})).toBeNull();
  expect(reader.getByRole('button', {name: 'load_external_content'})).toBeTruthy();
});

// Owner decision 2026-10-20: passing the receiving server's checks is never
// consent. An unknown sender whose DMARC, DKIM and SPF all pass for its own
// domain stays blocked everywhere a message is drawn - the reading pane, the
// swipe's neighbour pane, a conversation card, and the body prepared ahead.
it('an unknown sender that passes every check stays blocked in the reader, the swipe pane, the card and the body prepared ahead', async () => {
  const pass = 'receiver.test; dmarc=pass header.from=unknown-sender.test; dkim=pass header.d=unknown-sender.test; spf=pass smtp.mailfrom=unknown-sender.test';
  const parsed = mail('authenticated-unknown', UNKNOWN);
  parsed.authenticationResults = parseAuthenticationResults(pass);
  const raw = mail('authenticated-unknown-raw', UNKNOWN);
  raw.headers = [{ name: 'Authentication-Results', value: pass }] as never;
  for (const email of [parsed, raw]) {
    const views = both(email); const card = render(conversation(email));
    expect(state(views.reader.container)).toEqual(blocked);
    expect(state(views.peek.container)).toEqual(blocked);
    expect(state(card.container).remoteAllowed).toBe(false);
    expect(state(card.container).imageLive).toBe(false);
    views.reader.unmount(); views.peek.unmount(); card.unmount();
    prewarmEmailContent(email);
    await waitFor(() => expect(cachedEmailContent(emailContentCacheKey(email, true, {}), email)?.content.externalBlocked).toBe(true));
    expect(cachedEmailContent(emailContentCacheKey(email, false, {}), email)).toBeUndefined();
    expect(shouldBlockExternalFor(email, { ...options, isSenderTrusted: () => false })).toBe(true);
  }
});
