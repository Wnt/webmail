import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Fork (Wnt/webmail): where the one-time-code bar sits in the reading view.
// A notification tap on an iPhone starts the Home Screen app at the message
// link, and the code must be on screen at once, with no scrolling: the bar is
// the first thing on the message page, above the subject and outside the pane
// that scrolls the message, on the phone (where it swipes with its message)
// and on wider screens. jsdom has no layout, so these tests pin the structure;
// tools/e2e (60-otp-code-bar, Chromium) and tools/ios/sim (WebKit) measure
// the real viewport. Invented senders and codes only.

const device = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { useSettingsStore } = await import('@/stores/settings-store');
const { takePrefetchedEmail } = await import('@/lib/push-prefetch');

// The first render of the whole reading view is slow on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const otpEmail = {
  id: 'm-otp', blobId: 'b-otp', threadId: 't-otp', mailboxIds: { inbox: true }, keywords: {},
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ email: 'alice@example.test' }],
  subject: 'Sign in to Examplepaja', receivedAt: minutesAgo(2), preview: 'Use this code to sign in', hasAttachment: false,
  size: 900, textBody: [], htmlBody: [{ partId: 'h1', type: 'text/html' }], attachments: [],
  bodyValues: {
    h1: {
      value: '<p>Hello,</p><p>Your Examplepaja verification code is:</p>'
        + '<table><tr><td style="font-size:28px">604217</td></tr></table><p>It expires in 10 minutes.</p>',
      isTruncated: false,
    },
  },
} as unknown as Email;

const plainEmail = {
  ...otpEmail, id: 'm-plain', subject: 'Planning notes', textBody: [{ partId: 'p1', type: 'text/plain' }], htmlBody: [],
  bodyValues: { p1: { value: 'The planning meeting moves to Thursday at 10.', isTruncated: false } },
} as unknown as Email;

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function renderViewer(email: Email) {
  return render(
    <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
      onQuickReply={vi.fn(async () => {})} />,
  );
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  device.isMobile = true;
  useSettingsStore.setState({ showVerificationCodes: true, toolbarPosition: 'top' });
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

/** The bar is first on the message page and not inside the pane that scrolls. */
function expectFirstInView(container: HTMLElement) {
  const barEl = screen.getByTestId('verification-code-bar');
  const subject = container.querySelector('h1')!;
  const pane = container.querySelector('[data-message-swipe]') ?? container.querySelector('.overflow-auto');
  expect(barEl.compareDocumentPosition(subject) & Node.DOCUMENT_POSITION_FOLLOWING, 'the bar comes before the subject').toBeTruthy();
  expect(pane, 'the scrolling message pane').not.toBeNull();
  expect(pane!.contains(barEl), 'the bar does not scroll away with the message').toBe(false);
  return barEl;
}

describe('the code bar in the reading view', () => {
  it('phone: the first thing on the message page, outside the scrolling pane, swiping with its message', () => {
    const { container } = renderViewer(otpEmail);
    const barEl = expectFirstInView(container);
    const page = container.querySelector('[data-message-swipe-page]')!;
    expect(page.firstElementChild).toBe(barEl);
    expect(screen.getByTestId('verification-code-value')).toHaveTextContent('604217');
    expect(screen.getByRole('button', { name: 'copy_button' })).toBeInTheDocument();
    // The bar replaces the small chip by the subject.
    expect(screen.queryByTestId('verification-code-chip')).toBeNull();
  });

  it('desktop: above the subject and outside the scrolling content too', () => {
    device.isMobile = false;
    const { container } = renderViewer(otpEmail);
    expectFirstInView(container);
  });

  it('with the toolbar below the subject the bar still comes first', () => {
    useSettingsStore.setState({ toolbarPosition: 'below-subject' });
    const { container } = renderViewer(otpEmail);
    expectFirstInView(container);
  });

  it('an old code mail (past the list\'s 24 h) keeps only the small chip', () => {
    renderViewer({ ...otpEmail, receivedAt: minutesAgo(3 * 24 * 60) } as Email);
    expect(screen.queryByTestId('verification-code-bar')).toBeNull();
    expect(screen.getByTestId('verification-code-chip')).toBeInTheDocument();
  });

  it('a mail without a code has no bar; the setting off hides it', () => {
    const { unmount } = renderViewer(plainEmail);
    expect(screen.queryByTestId('verification-code-bar')).toBeNull();
    unmount();
    useSettingsStore.setState({ showVerificationCodes: false });
    renderViewer(otpEmail);
    expect(screen.queryByTestId('verification-code-bar')).toBeNull();
  });

  it('another message gets a fresh bar (no "copied" carried over)', async () => {
    const { rerender } = renderViewer(otpEmail);
    screen.getByTestId('verification-code-copy').click();
    await vi.waitFor(() => expect(screen.getByTestId('verification-code-bar')).toHaveAttribute('data-copy-state', 'copied'));
    const next = { ...otpEmail, id: 'm-otp-2', bodyValues: { h1: { value: '<p>Your verification code is 771204.</p>', isTruncated: false } } } as unknown as Email;
    rerender(<EmailViewer email={next} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn(async () => {})} />);
    expect(screen.getByTestId('verification-code-bar')).toHaveAttribute('data-copy-state', 'idle');
    expect(screen.getByTestId('verification-code-value')).toHaveTextContent('771204');
  });
});

describe('old code mails in the reader (the small chip)', () => {
  it('moving to another old code mail while a copy waits: its chip copies its own code (Astra r2 N1a)', async () => {
    let rejectA!: (e: unknown) => void;
    writeText.mockImplementation((text: string) => (text === '604217'
      ? new Promise<void>((_, rej) => { rejectA = rej; })
      : Promise.resolve()));
    const old = (id: string, code: string) => ({ ...otpEmail, id, receivedAt: minutesAgo(3 * 24 * 60),
      bodyValues: { h1: { value: `<p>Your verification code is ${code}.</p>`, isTruncated: false } } }) as unknown as Email;
    const { rerender } = renderViewer(old('m-old-a', '604217'));
    screen.getByTestId('verification-code-chip').click();
    rerender(<EmailViewer email={old('m-old-b', '771204')} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onQuickReply={vi.fn(async () => {})} />);
    screen.getByTestId('verification-code-chip').click();
    expect(writeText).toHaveBeenLastCalledWith('771204');
    rejectA(new DOMException('not allowed', 'NotAllowedError'));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
  });
});

describe('opened from a notification: a cold start at the message link with the kept message', () => {
  // The push worker keeps the notified message whole (public/sw.js, fetched
  // with the preview); the app started at /mail/message/<id> takes it (no
  // Email/get) and the phone starts in the reading pane. The code comes from
  // that kept copy as soon as the message renders, with no request of its own.
  const store = new Map<string, string>();
  const keptUrl = (acc: string, id: string) => `${window.location.origin}/__push-state/prefetched/${acc}/${id}`;

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (k: string) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)!) } : undefined),
        delete: async (k: string) => store.delete(k),
      }),
    });
    window.history.replaceState(null, '', `/en/mail/message/${otpEmail.id}`);
  });

  it('the code bar is on the first screen, from the kept message, with nothing copied and no code in the URL or history', async () => {
    store.set(keptUrl('acc1', otpEmail.id), JSON.stringify({ at: NOW - 30_000, email: otpEmail }));
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
    vi.stubGlobal('fetch', fetchSpy);

    const kept = await takePrefetchedEmail('acc1', otpEmail.id, NOW);
    expect(kept?.id).toBe(otpEmail.id);
    const { container } = renderViewer(kept!);

    const barEl = expectFirstInView(container);
    expect(container.querySelector('[data-message-swipe-page]')!.firstElementChild).toBe(barEl);
    expect(screen.getByTestId('verification-code-value')).toHaveTextContent('604217');
    // Found from the kept copy alone: no mail request (the viewer's own office
    // status probe aside).
    const mailRequests = fetchSpy.mock.calls.map((c) => String((c as unknown[])[0])).filter((u) => !u.includes('/api/wopi/status'));
    expect(mailRequests).toEqual([]);
    // No copy without a tap (WebKit refuses one anyway; it would only fail).
    expect(writeText).not.toHaveBeenCalled();
    // The deep link carries the message id only.
    expect(window.location.href).not.toContain('604217');
    expect(JSON.stringify(window.history.state ?? null)).not.toContain('604217');

    // One tap copies exactly the code.
    screen.getByTestId('verification-code-copy').click();
    expect(writeText).toHaveBeenCalledWith('604217');
    await vi.waitFor(() => expect(barEl).toHaveAttribute('data-copy-state', 'copied'));
  });
});
