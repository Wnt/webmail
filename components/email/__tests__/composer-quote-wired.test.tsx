import { act, render } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// Fork (Wnt/webmail), review swipe-trust r3 (the reviewer's probes kept as
// regression tests), with the composer wired to a real quote editor through
// onEditorReady: a reply's or forward's quote follows the reading pane's
// decision - failed checks, late trust and its removal, the policy (also for
// a reopened draft with no original), an order-unknown header record, and a
// conversation message (getThreadEmails) whose raw header fails.

// ─── Heavy component mocks (mirrors composer-reopened-draft-signature.test.tsx) ─

vi.mock('@/components/email/rich-text-editor', async () => {
  const { Editor } = await import('@tiptap/core');
  const { default: Document } = await import('@tiptap/extension-document');
  const { default: Paragraph } = await import('@tiptap/extension-paragraph');
  const { default: Text } = await import('@tiptap/extension-text');
  const { QuotedHtml } = await import('../quoted-html');
  return { RichTextEditor: ({ content, onEditorReady }: any) => {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      const editor = new Editor({ extensions: [Document, Paragraph, Text, QuotedHtml], content });
      ref.current!.appendChild(editor.view.dom);
      onEditorReady?.(editor);
      return () => editor.destroy();
    }, []);
    return <div ref={ref} data-testid="real-quote-editor" />;
  }};
});

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null,
    connectionLost: false,
    getClientForAccount: () => undefined,
    getAllConnectedClients: () => new Map(),
    syncIdentities: () => {},
    refreshIdentities: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = {
    identities: [
      { id: 'id-me', email: 'me@example.com', name: 'Me', htmlSignature: '<b>Alice</b>', textSignature: 'Alice' },
    ] as Array<Record<string, unknown>>,
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    draftSaveEnabled: false,
    sendRawEmail: async () => ({ sent: true }),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});

// ─── Misc dependency mocks ────────────────────────────────────────────────────

vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {} },
}));

vi.mock('@/lib/plugin-hooks', () => ({
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true },
    onComposeSend: { takeOver: async () => 'default' },
    onTransformOutgoingEmail: { transform: async (email: unknown) => email },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));


import { shouldBlockExternalFor } from '@/lib/email-content-cache';


import { useSettingsStore } from '@/stores/settings-store';
import { useContactStore } from '@/stores/contact-store';
import { buildQuotedHtmlBlock } from '../quoted-html';
import { parseAuthenticationResults } from '@/lib/email-headers';
const URL = 'https://images.example.test/track.png';
const html = `<p>Original</p><img src="${URL}">`;
const from = [{ email: 'letters@trusted-sender.test' }];
const original = { from, subject: 'Message', receivedAt: '2026-01-01T00:00:00Z', htmlBody: html,
  authenticationResults: parseAuthenticationResults('receiver.test; dkim=pass header.d=trusted-sender.test') };
function image(view: ReturnType<typeof render>) {
  return view.container.querySelector('.quoted-html-island')!.shadowRoot!.querySelector('img')!;
}
beforeEach(() => {
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [], trustedSendersAddressBook: false,
    plainTextMode: false, signaturePosition: 'below_quote' });
  useContactStore.setState({ trustedSenderEmails: [] });
});
it.each(['reply','forward'] as const)('wired composer blocks failed auth in %s', mode => {
  useSettingsStore.setState({ trustedSenders: [from[0].email] });
  const view = render(<EmailComposer mode={mode} replyTo={{...original, authenticationResults: { dmarc: { result: 'fail' } }}} />);
  expect(image(view).getAttribute('src')).not.toBe(URL);
});
it.each(['list', 'book'])('wired composer handles late %s and revocation', source => {
  useSettingsStore.setState({ trustedSendersAddressBook: source === 'book' });
  const view = render(<EmailComposer mode="reply" replyTo={original} />);
  expect(image(view).getAttribute('src')).not.toBe(URL);
  const set = (emails: string[]) => source === 'list' ? useSettingsStore.setState({trustedSenders: emails}) : useContactStore.setState({trustedSenderEmails: emails});
  act(() => set([from[0].email]));
  expect(image(view).getAttribute('src')).toBe(URL);
  act(() => set([]));
  expect(image(view).getAttribute('src')).not.toBe(URL);
});
it('wired composer revokes global allow on an original message', () => {
  useSettingsStore.setState({ externalContentPolicy: 'allow' });
  const view = render(<EmailComposer mode="reply" replyTo={original} />);
  expect(image(view).getAttribute('src')).toBe(URL);
  act(() => useSettingsStore.setState({ externalContentPolicy: 'ask' }));
  expect(image(view).getAttribute('src')).not.toBe(URL);
});
it('reopened draft revokes global allow while mounted', () => {
  useSettingsStore.setState({ externalContentPolicy: 'allow' });
  const view = render(<EmailComposer mode="compose" initialData={{ to: '', cc: '', bcc: '', subject: 'draft', body: buildQuotedHtmlBlock(html), showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', mode: 'compose', draftId: 'draft' }} />);
  expect(image(view).getAttribute('src')).toBe(URL);
  act(() => useSettingsStore.setState({ externalContentPolicy: 'block' }));
  expect(image(view).getAttribute('src')).not.toBe(URL);
});
it('reopened draft follows enabling global allow while mounted', () => {
  const view = render(<EmailComposer mode="compose" initialData={{ to: '', cc: '', bcc: '', subject: 'draft', body: buildQuotedHtmlBlock(html), showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', mode: 'compose', draftId: 'draft' }} />);
  expect(image(view).getAttribute('src')).not.toBe(URL);
  act(() => useSettingsStore.setState({ externalContentPolicy: 'allow' }));
  expect(image(view).getAttribute('src')).toBe(URL);
});
it('ambiguous header ordering remains blocked after getEmail and projection into reply context', async () => {
  useSettingsStore.setState({ trustedSenders: [from[0].email] });
  const { JMAPClient } = await import('@/lib/jmap/client');
  const client = new JMAPClient('https://mail.example.test', 'review', 'password');
  const email: any = { id: 'ambiguous', from, headers: {
    'authentication-results': 'receiver.test; dmarc=fail header.from=trusted-sender.test',
    'Authentication-Results': 'other.test; dmarc=pass header.from=trusted-sender.test',
  }};
  const request = vi.spyOn(client as any, 'request').mockResolvedValue({methodResponses: [['Email/get', {list: [email]}, '0']]});
  try {
    const parsed = (await client.getEmail(email.id))!;
    expect(shouldBlockExternalFor(parsed, { externalContentPolicy: 'ask', allowExternalContent: false, isSenderTrusted: () => true, trustedSendersAddressBook: false, isTrustedAddressBookSender: () => false })).toBe(true);
    const view = render(<EmailComposer mode="reply" replyTo={{ ...original, from: parsed.from, authenticationResults: parsed.authenticationResults }} />);
    expect(image(view).getAttribute('src')).not.toBe(URL);
  } finally { request.mockRestore(); client.disconnect(); }
});

it.each(['reply','replyAll','forward'] as const)('thread-fetched failed-auth message stays blocked in %s composer', async mode => {
  useSettingsStore.setState({ trustedSenders: [from[0].email] });
  const { JMAPClient } = await import('@/lib/jmap/client');
  const client = new JMAPClient('https://mail.example.test', 'review', 'password');
  const email: any = { id: 'thread-raw', threadId: 't', from, receivedAt: original.receivedAt,
    htmlBody: [{partId: '1', type: 'text/html'}], textBody: [], bodyValues: {'1': {value: html, isTruncated: false}},
    headers: [{name: 'Authentication-Results', value: 'receiver.test; dmarc=fail header.from=trusted-sender.test; spf=fail smtp.mailfrom=trusted-sender.test'}] };
  const request = vi.spyOn(client as any, 'request').mockResolvedValue({methodResponses: [
    ['Thread/get', {list: [{id: 't', emailIds: [email.id]}]}, 't'],
    ['Email/get', {list: [email]}, 'e'],
  ]});
  try {
    const [parsed] = await client.getThreadEmails('t');
    expect(shouldBlockExternalFor(parsed, { externalContentPolicy: 'ask', allowExternalContent: false, isSenderTrusted: () => true, trustedSendersAddressBook: false, isTrustedAddressBookSender: () => false })).toBe(true);
    // Exactly the auth projection used by MailApp when a conversation action selects this Email.
    const view = render(<EmailComposer mode={mode} replyTo={{ ...original, from: parsed.from, authenticationResults: parsed.authenticationResults }} />);
    expect(image(view).getAttribute('src')).not.toBe(URL);
  } finally { request.mockRestore(); client.disconnect(); }
});

it('a reply whose context carries the check: unchecked mail ("none") from a trusted sender shows its quote pictures; a rejected one does not', () => {
  useSettingsStore.setState({ trustedSenders: [from[0].email] });
  const { authenticationResults: _drop, ...noResults } = original;
  const unchecked = render(<EmailComposer mode="reply" replyTo={{ ...noResults, senderTrust: 'none' }} />);
  expect(image(unchecked).getAttribute('src')).toBe(URL);
  unchecked.unmount();
  const rejected = render(<EmailComposer mode="reply" replyTo={{ ...noResults, senderTrust: 'unauthenticated' }} />);
  expect(image(rejected).getAttribute('src')).not.toBe(URL);
  rejected.unmount();
  const unknown = render(<EmailComposer mode="reply" replyTo={noResults} />);
  expect(image(unknown).getAttribute('src')).not.toBe(URL);
});

it('the quote of an unknown sender that passes every check stays blocked (authentication is never consent)', () => {
  const unknown = { ...original, from: [{ email: 'news@unknown-sender.test' }],
    authenticationResults: parseAuthenticationResults('receiver.test; dmarc=pass header.from=unknown-sender.test; dkim=pass header.d=unknown-sender.test; spf=pass smtp.mailfrom=unknown-sender.test') };
  for (const mode of ['reply', 'replyAll', 'forward'] as const) {
    const view = render(<EmailComposer mode={mode} replyTo={{ ...unknown, senderTrust: 'authenticated' }} />);
    expect(image(view).getAttribute('src')).not.toBe(URL);
    view.unmount();
  }
});
