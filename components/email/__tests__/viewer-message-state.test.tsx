import { render, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Fork (Wnt/webmail), review swipe-preload r1 (R1, R2, R4; the reviewer's
// probes kept as regression tests):
// - per-message state of the reading pane - "Load images", the extracted
//   bodies of plugins, TNEF and message/rfc822 - never carries over to the
//   next message, not even for the renders before the reset effect: the next
//   message is never sanitized or framed under the other's permission;
// - a lite swipe neighbour reads nothing of its body beyond its first lines
//   (no DOM parse of an over-limit body for its attachment chips);
// - the sanitized-body cache hands out a body only for the very text it was
//   made from: another login's message with the same id gets its own body;
// - (r2) all of it is keyed by the message's owner and id: two accounts'
//   messages with the same JMAP id share nothing.

const sanitize = vi.hoisted(() => ({ calls: 0, inputs: [] as { html: string; block: boolean }[] }));
vi.mock('@/lib/email-sanitization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email-sanitization')>();
  return {
    ...actual,
    sanitizeEmailBodyForIframe: (...args: Parameters<typeof actual.sanitizeEmailBodyForIframe>) => {
      sanitize.calls++; sanitize.inputs.push({ html: args[0], block: args[1] });
      return actual.sanitizeEmailBodyForIframe(...args);
    },
  };
});
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

const { EmailViewer } = await import('@/components/email/email-viewer');
const { __clearEmailContentCache } = await import('@/lib/email-content-cache');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const htmlEmail = (id: string, seen: boolean): Email => ({
  id, blobId: `b-${id}`, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: seen },
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ name: 'Bob', email: 'bob@example.test' }],
  subject: 'Synthetic', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hi', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<table width="100%"><tr><td><p>Hello <b>there</b></p></td></tr></table>', isTruncated: false } },
} as unknown as Email);

const viewer = (email: Email, tick: number) => (
  <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
    onReply={() => tick} onDelete={() => tick} onToggleStar={() => tick} onMarkAsRead={() => tick} />
);


const { useSettingsStore } = await import('@/stores/settings-store');
const { renderHooks } = await import('@/lib/plugin-hooks');
beforeEach(() => {
  sanitize.inputs = []; __clearEmailContentCache();
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: ['trusted@example.test'] });
});
describe('per-message state and the sanitized-body cache', () => {
it('ordinary Load images permission does not carry to another message', () => {
  const a = htmlEmail('ordinary-a', true);
  a.bodyValues!['1'].value = '<img src="https://tracker.example.test/ordinary-a">';
  const view = render(viewer(a, 0));
  fireEvent.click(view.getByText('load_external_content'));
  const b = htmlEmail('ordinary-b', true);
  b.bodyValues!['1'].value = '<img src="https://tracker.example.test/ordinary-b">';
  sanitize.inputs = [];
  view.rerender(viewer(b, 1));
  expect(sanitize.inputs.filter(x => x.html.includes('/ordinary-b')).every(x => x.block)).toBe(true);
});
it('outgoing plugin body is never rendered under incoming trusted sender permission', async () => {
  const oldBody = '<p>EXTRACTED-OLD-BODY</p><img src="https://tracker.example.test/old">';
  const plugin = vi.spyOn(renderHooks.onRenderEmailBody, 'transform').mockImplementation(async (_v, ctx) =>
    (ctx as { id?: string }).id === 'plugin-a' ? { html: oldBody, handledBy: 'test', text: '', attachments: [] } : { html: '', text: '', attachments: [] });
  try {
    const view = render(viewer(htmlEmail('plugin-a', true), 0));
    await act(async () => { await Promise.resolve(); });
    expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-OLD-BODY');
    sanitize.inputs = [];
    const committed = vi.spyOn(Element.prototype, 'setAttribute');
    const b = htmlEmail('trusted-b', true);
    b.from = [{ email: 'trusted@example.test' }];
    view.rerender(viewer(b, 1));
    const staleDocs = committed.mock.calls.filter(([name, value]) => name.toLowerCase() === 'srcdoc' && value.includes('EXTRACTED-OLD-BODY') && value.includes("img-src data: blob: http: https:"));
    committed.mockRestore();
    expect(staleDocs.map(() => 'old body committed with permissive CSP')).toEqual([]);
  } finally { plugin.mockRestore(); }
});

it('lite neighbours do not parse their over-limit HTML for attachment chips', async () => {
  const { SwipePeek } = await import('@/components/email/swipe-peek');
  useSettingsStore.setState({ hideInlineImageAttachments: true, showVerificationCodes: false });
  const e = htmlEmail('large-neighbour', true);
  e.bodyValues!['1'].value = '<p>OVERSIZED-NEIGHBOUR' + 'x'.repeat(210_000) + '</p>';
  e.textBody = [{ partId: '2', type: 'text/plain' }] as Email['textBody'];
  e.bodyValues!['2'] = { value: 'short text', isTruncated: false } as never;
  e.attachments = [{ partId: '3', blobId: 'att', type: 'image/png', size: 10, cid: 'image' }] as Email['attachments'];
  const parser = vi.spyOn(DOMParser.prototype, 'parseFromString');
  try {
    const view = render(<SwipePeek neighbour={{ row: e, email: e }} isDark={false} />);
    expect(view.container.querySelector('[data-swipe-peek="lite"]')).not.toBeNull();
    const oversized = parser.mock.calls.filter(([html]) => String(html).includes('OVERSIZED-NEIGHBOUR') && String(html).length > 200_000);
    expect(oversized.map(([html]) => String(html).length)).toEqual([]);
  } finally { parser.mockRestore(); }
});

it('a neighbour from a different login cannot reuse the first login body', async () => {
  const { SwipePeek } = await import('@/components/email/swipe-peek');
  const a = htmlEmail('overlapping-id', true);
  a.bodyValues!['1'].value = '<p>PRIVATE-LOGIN-A-BODY</p>';
  const first = render(<SwipePeek neighbour={{ row: { ...a, accountId: 'login-a' }, email: a }} isDark={false} />);
  expect(first.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('PRIVATE-LOGIN-A-BODY');
  first.unmount();
  const b = htmlEmail('overlapping-id', true);
  b.bodyValues!['1'].value = '<p>LOGIN-B-BODY</p>';
  const second = render(<SwipePeek neighbour={{ row: { ...b, accountId: 'login-b' }, email: b }} isDark={false} />);
  expect(second.container.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('PRIVATE-LOGIN-A-BODY');
});
});

describe('per-message state follows the account, not just the id (review swipe-preload r2 R2-A)', () => {
  it('Load images permission cannot follow an equal id to another account', () => {
    const a = htmlEmail('same-id', true);
    a.sourceClientAccountId = 'login-a'; a.sourceAccountId = 'account-a';
    a.bodyValues!['1'].value = '<img src="https://tracker.example.test/account-a">';
    const view = render(viewer(a, 0));
    fireEvent.click(view.getByText('load_external_content'));
    const b = htmlEmail('same-id', true);
    b.sourceClientAccountId = 'login-b'; b.sourceAccountId = 'account-b';
    b.bodyValues!['1'].value = '<img src="https://tracker.example.test/account-b">';
    sanitize.inputs = [];
    view.rerender(viewer(b, 1));
    expect(sanitize.inputs.filter(x => x.html.includes('/account-b'))).not.toHaveLength(0);
    expect(sanitize.inputs.filter(x => x.html.includes('/account-b')).every(x => x.block)).toBe(true);
  });
  it('an extracted body cannot follow an equal id to a trusted sender in another account', async () => {
    const oldBody = '<p>EXTRACTED-ACCOUNT-A</p><img src="https://tracker.example.test/old-account">';
    const plugin = vi.spyOn(renderHooks.onRenderEmailBody, 'transform').mockResolvedValue({ html: oldBody, handledBy: 'test', text: '', attachments: [] });
    const a = htmlEmail('same-extracted-id', true);
    a.sourceClientAccountId = 'login-a'; a.sourceAccountId = 'account-a';
    const view = render(viewer(a, 0));
    await act(async () => { await Promise.resolve(); });
    expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-ACCOUNT-A');
    plugin.mockImplementation(() => new Promise(() => {}));
    const committed = vi.spyOn(Element.prototype, 'setAttribute');
    const b = htmlEmail('same-extracted-id', true);
    b.sourceClientAccountId = 'login-b'; b.sourceAccountId = 'account-b';
    b.from = [{email: 'trusted@example.test'}];
    view.rerender(viewer(b, 1));
    const staleDocs = committed.mock.calls.filter(([name, value]) => name.toLowerCase() === 'srcdoc' && value.includes('EXTRACTED-ACCOUNT-A') && value.includes('img-src data: blob: http: https:'));
    committed.mockRestore(); plugin.mockRestore();
    expect(staleDocs.map(() => 'old account body committed with permissive CSP')).toEqual([]);
  });
});

describe('the owner of a message without a blobSource, and the Pro host (review swipe-preload r3 R3-A, R3-C, R3-D)', () => {
  it('does not carry Load images to an equal id after the active client changes', async () => {
    const { useAuthStore } = await import('@/stores/auth-store');
    const { JMAPClient } = await import('@/lib/jmap/client');
    const oldAuth = useAuthStore.getState();
    const aClient = new JMAPClient('https://mail.example.test', 'alice', 'p');
    const bClient = new JMAPClient('https://mail.example.test', 'bob', 'p');
    try {
      useAuthStore.setState({client:aClient,activeAccountId:'login-a'});
      const a = htmlEmail('unstamped-same-id', true);
      a.bodyValues!['1'].value = '<img src="https://tracker.example.test/unstamped-a">';
      const view = render(viewer(a, 0));
      fireEvent.click(view.getByText('load_external_content'));
      const b = htmlEmail('unstamped-same-id', true);
      b.bodyValues!['1'].value = '<img src="https://tracker.example.test/unstamped-b">';
      sanitize.inputs = [];
      act(() => useAuthStore.setState({client:bClient,activeAccountId:'login-b'}));
      view.rerender(viewer(b, 1));
      const inputs = sanitize.inputs.filter(x=>x.html.includes('/unstamped-b'));
      expect(inputs).not.toHaveLength(0);
      expect(inputs.every(x=>x.block)).toBe(true);
      view.unmount();
    } finally {
      aClient.disconnect(); bClient.disconnect();
      useAuthStore.setState(oldAuth);
    }
  });
});

it('ProEmailView shared-account change preserves neither Load images nor the previous body', async () => {
  const { ProEmailView } = await import('@/components/pro/pro-email-tab-body');
  const { useAuthStore } = await import('@/stores/auth-store');
  const { JMAPClient } = await import('@/lib/jmap/client');
  const oldAuth = useAuthStore.getState();
  const c = new JMAPClient('https://mail.example.test', 'owner', 'p');
  const a = htmlEmail('shared-same-id', true);
  a.mailboxIds = {'shared-a:inbox':true};
  a.bodyValues!['1'].value = '<img src="https://tracker.example.test/pro-shared-a">';
  const b = htmlEmail('shared-same-id', true);
  b.mailboxIds = {'shared-b:inbox':true};
  b.bodyValues!['1'].value = '<img src="https://tracker.example.test/pro-shared-b">';
  const get = vi.spyOn(c, 'getEmail').mockImplementation(async (_id, account) => account === 'shared-a' ? a : b);
  try {
    useAuthStore.setState({client:c,activeAccountId:'owner-login'});
    const close = () => {};
    const view = render(<ProEmailView emailId="shared-same-id" client={c} accountId="shared-a" onClose={close}/>);
    await waitFor(()=>expect(view.getByText('load_external_content')).toBeDefined());
    fireEvent.click(view.getByText('load_external_content'));
    sanitize.inputs = [];
    view.rerender(<ProEmailView emailId="shared-same-id" client={c} accountId="shared-b" onClose={close}/>);
    await waitFor(()=>expect(sanitize.inputs.some(x=>x.html.includes('/pro-shared-b'))).toBe(true));
    expect(get).toHaveBeenLastCalledWith('shared-same-id','shared-b');
    expect(sanitize.inputs.filter(x=>x.html.includes('/pro-shared-b')).every(x=>x.block)).toBe(true);
    view.unmount();
  } finally { get.mockRestore(); c.disconnect(); useAuthStore.setState(oldAuth); }
});

it('a reconnect of the same session keeps an extracted body (the same email object)', async () => {
  const { JMAPClient } = await import('@/lib/jmap/client');
  const c = new JMAPClient('https://mail.example.test','owner','p');
  const session = {capabilities:{}, accounts:{a:{name:'owner',isPersonal:true,accountCapabilities:{}}}, primaryAccounts:{'urn:ietf:params:jmap:mail':'a'}, apiUrl:'https://mail.example.test/jmap/api',downloadUrl:'https://mail.example.test/download/{blobId}', uploadUrl:'https://mail.example.test/upload',eventSourceUrl:'https://mail.example.test/events'};
  c.adoptSession(session);
  const plugin = vi.spyOn(renderHooks.onRenderEmailBody,'transform').mockResolvedValue({html:'<p>EXTRACTED-SESSION-BODY</p>',text:'',attachments:[],handledBy:'test'});
  const e = htmlEmail('stable-email-object',true);
  const renderViewer = (tick = 0) => <EmailViewer className={`tick-${tick}`} email={e} blobSource={{client:c,clientAccountId:'owner-login'}} mailboxes={mailboxes}/>;
  try {
    const view = render(renderViewer());
    await waitFor(()=>expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-SESSION-BODY'));
    expect(plugin).toHaveBeenCalledTimes(1);
    c.adoptSession(session);
    view.rerender(renderViewer(1));
    await act(async()=>{await Promise.resolve();});
    expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-SESSION-BODY');
    view.unmount();
  } finally {plugin.mockRestore(); c.disconnect();}
});

it('reconnecting the same account does not discard an unsent quick reply', async () => {
  const { JMAPClient } = await import('@/lib/jmap/client');
  const c = new JMAPClient('https://mail.example.test','owner','p');
  const session = {capabilities:{}, accounts:{a:{name:'owner',isPersonal:true,accountCapabilities:{}}}, primaryAccounts:{'urn:ietf:params:jmap:mail':'a'}, apiUrl:'https://mail.example.test/jmap/api',downloadUrl:'https://mail.example.test/download/{blobId}', uploadUrl:'https://mail.example.test/upload',eventSourceUrl:'https://mail.example.test/events'};
  c.adoptSession(session);
  useSettingsStore.setState({interfaceLayout:'default'});
  const e = htmlEmail('unchanged-reply',true);
  e.htmlBody=[];e.textBody=[{partId:'1',type:'text/plain'}] as Email['textBody'];e.bodyValues!['1'].value='Hello';
  const ui=(tick=0)=><EmailViewer className={`tick-${tick}`} email={e} blobSource={{client:c,clientAccountId:'owner-login'}} mailboxes={mailboxes}/>;
  const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify(session),{status:200,headers:{'Content-Type':'application/json'}}));
  try {
    const view=render(ui());
    const textarea=view.getByPlaceholderText('quick_reply_placeholder');
    fireEvent.change(textarea,{target:{value:'UNSENT REPLY'}});
    expect(textarea).toHaveValue('UNSENT REPLY');
    await c.reconnect();
    view.rerender(ui(1));
    expect(view.getByPlaceholderText('quick_reply_placeholder')).toHaveValue('UNSENT REPLY');
    view.unmount();
  } finally {fetchMock.mockRestore();c.disconnect();}
});

it('a new session (sign-out and in) restarts body extraction for the same email object', async () => {
  const { JMAPClient } = await import('@/lib/jmap/client');
  const c = new JMAPClient('https://mail.example.test','owner','p');
  const session = {capabilities:{}, accounts:{a:{name:'owner',isPersonal:true,accountCapabilities:{}}}, primaryAccounts:{'urn:ietf:params:jmap:mail':'a'}, apiUrl:'https://mail.example.test/jmap/api',downloadUrl:'https://mail.example.test/download/{blobId}', uploadUrl:'https://mail.example.test/upload',eventSourceUrl:'https://mail.example.test/events'};
  c.adoptSession(session);
  const plugin = vi.spyOn(renderHooks.onRenderEmailBody,'transform').mockResolvedValue({html:'<p>EXTRACTED-SESSION-BODY</p>',text:'',attachments:[],handledBy:'test'});
  const e = htmlEmail('stable-email-object-2',true);
  const ui = (tick = 0) => <EmailViewer className={`tick-${tick}`} email={e} blobSource={{client:c,clientAccountId:'owner-login'}} mailboxes={mailboxes}/>;
  try {
    const view = render(ui());
    await waitFor(()=>expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-SESSION-BODY'));
    c.disconnect();
    c.adoptSession(session);
    view.rerender(ui(1));
    await waitFor(()=>expect(view.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('EXTRACTED-SESSION-BODY'));
    expect(plugin).toHaveBeenCalledTimes(2);
    view.unmount();
  } finally {plugin.mockRestore(); c.disconnect();}
});
