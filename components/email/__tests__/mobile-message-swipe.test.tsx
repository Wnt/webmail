import { render, within, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Phone: previous / next are a sideways swipe on the open message, not
// buttons. Desktop keeps its buttons and shortcuts.
//
// The swipe is the browser's own horizontal scrolling of a track around the
// message pane (lib/message-swipe.ts). WebKit runs no event listener on the
// sandboxed body iframe's document - not even one the host adds - so a swipe
// that started on the body never reached the old touch handler on an iPhone,
// and the old handler ignored touches on the quick reply box on purpose.
// jsdom has no layout or native scrolling, so these tests stand in for the
// pan: they put the track's gutters where a pan leaves them (their client
// rects) and fire the track's `scroll` / `scrollend`, as the engine does.
// The real pans run in tools/e2e (Chromium) and tools/ios/sim (WebKit).

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
const { useToastStore } = await import('@/stores/toast-store');

// Invented data only.
const WIDE_TABLE = `<table><tr>${Array.from({ length: 14 }, (_, i) => `<td style="white-space:nowrap">Quarter ${i + 1} figure</td>`).join('')}</tr></table>`;
const HTML_BODY = '<p>Hello from Examplepaja. Read <a href="https://examplepaja.test/a">the first link</a> and '
  + `<a href="https://examplepaja.test/b">the second link</a>.</p>${WIDE_TABLE}<p>Kind regards, Examplepaja</p>`;

const plainEmail = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice Example', email: 'alice@examplepaja.test' }], to: [{ email: 'bob@examplepaja.test' }],
  subject: 'Planning notes', receivedAt: '2026-01-01T00:00:00Z', preview: 'Planning notes', hasAttachment: false,
  size: 100, textBody: [{ partId: 'p1', type: 'text/plain' }], htmlBody: [],
  attachments: [], bodyValues: { p1: { value: 'The planning meeting moves to Thursday. See https://examplepaja.test/plan', isTruncated: false } },
} as unknown as Email;

const htmlEmail = {
  ...plainEmail, id: 'e2', blobId: 'b2', threadId: 't2', subject: 'Quarterly figures',
  textBody: [], htmlBody: [{ partId: 'h1', type: 'text/html' }],
  bodyValues: { h1: { value: HTML_BODY, isTruncated: false } },
} as unknown as Email;

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function renderViewer(props: Partial<React.ComponentProps<typeof EmailViewer>> = {}) {
  return render(
    <EmailViewer email={plainEmail} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
      onQuickReply={vi.fn(async () => {})} {...props} />,
  );
}

const PREV = 'tooltips.previous';
const NEXT = 'tooltips.next';
const W = 390; // the track's width in these tests

/** Buttons named previous / next that are not inside the screen-reader-only block. */
function visibleNavButtons(container: HTMLElement) {
  return [...container.querySelectorAll('button')].filter((b) => {
    const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
    return (name === PREV || name === NEXT) && !b.closest('.sr-only');
  });
}

const rect = (left: number, width: number) =>
  ({ left, right: left + width, width, top: 0, bottom: 800, height: 800, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

function parts(container: HTMLElement) {
  const track = container.querySelector('[data-message-swipe-track]') as HTMLElement | null;
  const page = container.querySelector('[data-message-swipe-page]') as HTMLElement | null;
  const pane = container.querySelector('[data-message-swipe]') as HTMLElement | null;
  const prev = container.querySelector('[data-swipe-gutter="prev"]') as HTMLElement | null;
  const next = container.querySelector('[data-swipe-gutter="next"]') as HTMLElement | null;
  return { track, page, pane, prev, next };
}

const gutterWidth = (g: HTMLElement) => (g.dataset.mode === 'go' ? Math.round(W * 0.4) : 48);

/**
 * Where a sideways pan leaves the track: `px` of the next (finger moved left)
 * or previous (finger moved right) gutter on screen. Then the engine's
 * scroll events; `settle` adds the scrollend of a finished gesture.
 */
function pan(container: HTMLElement, side: 'next' | 'prev' | 'none', px: number, { settle = true } = {}) {
  const { track, prev, next } = parts(container);
  if (!track) return; // nothing that scrolls sideways: the pan moves nothing
  track.getBoundingClientRect = () => rect(0, W);
  if (prev) {
    const w = gutterWidth(prev);
    prev.getBoundingClientRect = () => rect(side === 'prev' ? px - w : -w, w);
  }
  if (next) {
    const w = gutterWidth(next);
    next.getBoundingClientRect = () => rect(side === 'next' ? W - px : W, w);
  }
  act(() => {
    track.dispatchEvent(new Event('scroll'));
    if (settle) track.dispatchEvent(new Event('scrollend'));
  });
}

/** A whole swipe: the gutter fully revealed, then settled (the snap). */
const swipeTo = (container: HTMLElement, side: 'next' | 'prev') => {
  const g = parts(container)[side];
  pan(container, side, g ? gutterWidth(g) : 0);
};

function touch(el: Element, type: string, x: number, y: number, fingers = 1) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const list = type === 'touchend' || type === 'touchcancel' ? [] : Array.from({ length: fingers }, () => ({ clientX: x, clientY: y }));
  Object.defineProperty(ev, 'touches', { value: list });
  el.dispatchEvent(ev);
  return ev;
}

/** The touches of a sideways finger drag on `el` (what the old handler listened to). */
function fingerDrag(el: Element, x0: number, x1: number, y = 300, { fingers = 1 } = {}) {
  act(() => {
    touch(el, 'touchstart', x0, y, fingers);
    for (let i = 1; i <= 8; i++) touch(el, 'touchmove', x0 + ((x1 - x0) * i) / 8, y, fingers);
    touch(el, 'touchend', x1, y);
  });
}

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** A fake visual viewport, so a pinch can be simulated. */
function installVisualViewport() {
  const listeners = new Set<() => void>();
  const vv = {
    scale: 1,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return {
    pinchTo(scale: number) {
      vv.scale = scale;
      act(() => { listeners.forEach((fn) => fn()); });
    },
    remove() { Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true }); },
  };
}

describe('previous / next on the phone', () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    device.isMobile = true;
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
    useToastStore.setState({ toasts: [] } as never);
    setReducedMotion(true);
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.useRealTimers();
  });

  it('the bottom bar has no previous or next buttons', () => {
    const { container } = renderViewer({ onNavigateNext: vi.fn(), onNavigatePrev: vi.fn(), onReply: vi.fn() });
    const bar = container.querySelector('[data-mobile-message-bar]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: PREV })).toBeNull();
    expect(within(bar).queryByRole('button', { name: NEXT })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'tooltips.reply' })).toBeInTheDocument();
    expect(visibleNavButtons(container)).toHaveLength(0);
  });

  it('Mountain View on the phone shows no previous / next arrows either', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
    const { container } = renderViewer({ onNavigateNext: vi.fn(), onNavigatePrev: vi.fn(), onBack: vi.fn() });
    expect(visibleNavButtons(container)).toHaveLength(0);
  });

  it('screen readers still get previous / next buttons', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: onPrev });
    const sr = container.querySelector('[data-message-nav-sr]') as HTMLElement;
    expect(sr).toHaveClass('sr-only');
    fireEvent.click(within(sr).getByRole('button', { name: NEXT }));
    fireEvent.click(within(sr).getByRole('button', { name: PREV }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('at the last message the screen-reader next button is disabled', () => {
    const { container } = renderViewer({ onNavigatePrev: vi.fn() });
    const sr = container.querySelector('[data-message-nav-sr]') as HTMLElement;
    expect(within(sr).getByRole('button', { name: NEXT })).toBeDisabled();
  });

  it('the whole message - header, body, quick reply, the space below - is inside the sideways track', () => {
    const { container } = renderViewer({ email: htmlEmail, onNavigateNext: vi.fn(), onNavigatePrev: vi.fn() });
    const { track, page, pane, prev, next } = parts(container);
    expect(track).toBeTruthy();
    expect(track!.className).toMatch(/overflow-x-auto/);
    expect(track!.className).toMatch(/snap-mandatory/);
    // The page holds the subject and the pane; the toolbar above stays put.
    expect(page!.querySelector('h1')?.textContent).toBe('Quarterly figures');
    expect(page!.contains(pane)).toBe(true);
    expect(page!.querySelector('[data-mobile-message-bar]')).toBeNull();
    // The pane only scrolls vertically, so a sideways pan passes through to the track.
    expect(pane!.className).toMatch(/overflow-x-hidden/);
    const frame = container.querySelector('iframe[title="Email content"]') as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(pane!.contains(frame)).toBe(true);
    // The body keeps its sandbox: no scripts, so no listener could ever run in it on WebKit.
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    expect([...track!.children]).toEqual([prev, page, next]);
    expect(prev!.dataset.mode).toBe('go');
    expect(next!.dataset.mode).toBe('go');
  });

  it('desktop has no track: the wrappers have no box and the pane stays a plain scroller', () => {
    device.isMobile = false;
    const { container } = renderViewer({ onNavigateNext: vi.fn(), onNavigatePrev: vi.fn() });
    expect(container.querySelector('[data-message-swipe-track]')).toBeNull();
    expect(container.querySelector('[data-message-swipe-page]')).toBeNull();
    const contents = [...container.querySelectorAll('div.contents')];
    expect(contents.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[data-swipe-gutter]')).toBeNull();
  });

  it('a swipe that starts on the HTML body (sandboxed iframe) opens the next message', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { container } = renderViewer({ email: htmlEmail, onNavigateNext: onNext, onNavigatePrev: onPrev });
    // On WebKit nothing inside the frame reaches us; the pan scrolls the track.
    swipeTo(container, 'next');
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('a swipe to the right on the body opens the previous message', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { container } = renderViewer({ email: htmlEmail, onNavigateNext: onNext, onNavigatePrev: onPrev });
    swipeTo(container, 'prev');
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('a swipe on the plain-text body opens the next message', () => {
    const onNext = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: vi.fn() });
    const body = container.querySelector('.email-content-text') as HTMLElement;
    fingerDrag(body, 300, 60);
    swipeTo(container, 'next');
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('a swipe on the empty quick reply box opens the next message', () => {
    const onNext = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: vi.fn() });
    const box = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    fingerDrag(box, 300, 60);
    swipeTo(container, 'next');
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('with unsent text in the quick reply box no swipe navigates, the text stays and it says why', async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    // (Plain text: jsdom never parses the HTML body's frame, and the quick reply waits for it.)
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: onPrev });
    const box = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Thanks, Thursday works for me.' } });
    const { pane } = parts(container);
    // On the reply box, then anywhere else on the message (the old handler
    // navigated from the header or a plain body, and the viewer clears the
    // quick reply when the message changes: the draft was gone).
    fingerDrag(box, 300, 60);
    pan(container, 'next', 30, { settle: false });
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    fingerDrag(pane!, 300, 60);
    swipeTo(container, 'next');
    fingerDrag(pane!, 60, 300);
    swipeTo(container, 'prev');
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
    expect(box.value).toBe('Thanks, Thursday works for me.');
    // The gutters only bounce, and a toast says why.
    expect(parts(container).prev!.dataset.mode).toBe('bounce');
    expect(parts(container).next!.dataset.mode).toBe('bounce');
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('unsaved_changes');
    // Cleared: swiping works again.
    fireEvent.change(box, { target: { value: '' } });
    swipeTo(container, 'next');
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('a text drag in the reply box (long-press, then sideways) does not navigate or touch the text', () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const onNext = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: vi.fn() });
    const box = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Draft about the planning meeting' } });
    box.focus();
    box.setSelectionRange(3, 3);
    const { track } = parts(container);
    // The finger rests (a long-press), then drags sideways: the track is
    // locked for that touch, so only the text selection can follow it.
    act(() => { touch(box, 'touchstart', 80, 300); });
    act(() => { vi.advanceTimersByTime(600); });
    expect(track!.style.overflowX).toBe('hidden');
    act(() => { for (let i = 1; i <= 8; i++) touch(box, 'touchmove', 80 + i * 25, 300); });
    expect(track!.style.overflowX).toBe('hidden');
    act(() => { touch(box, 'touchend', 280, 300); });
    expect(track!.style.overflowX).toBe('');
    expect(onNext).not.toHaveBeenCalled();
    expect(box.value).toBe('Draft about the planning meeting');
    expect(box.selectionStart).toBe(3);
    // A finger that moves at once is a swipe: no lock.
    act(() => { touch(box, 'touchstart', 300, 300); touch(box, 'touchmove', 260, 300); });
    act(() => { vi.advanceTimersByTime(600); });
    expect(track!.style.overflowX).toBe('');
    act(() => { touch(box, 'touchend', 60, 300); });
  });

  it('a vertical scroll does not navigate', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { container } = renderViewer({ email: htmlEmail, onNavigateNext: onNext, onNavigatePrev: onPrev });
    const { pane } = parts(container);
    act(() => {
      pane!.dispatchEvent(new Event('scroll'));
      pane!.dispatchEvent(new Event('scrollend'));
    });
    pan(container, 'none', 0); // the track itself at rest
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('a short pan that springs back does not navigate', () => {
    const onNext = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: vi.fn() });
    pan(container, 'next', 50); // released a third of the way in: settles back at rest
    expect(onNext).not.toHaveBeenCalled();
  });

  it('a link tap in the body opens the link, not another message', () => {
    const onNext = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: vi.fn() });
    const link = container.querySelector('.email-content-text a') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { link.dispatchEvent(ev); });
    // Nothing of the swipe swallows the click (the old handler did after a swipe).
    expect(onNext).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('a two-finger pinch does not navigate, and a zoomed page pans instead of swiping', () => {
    const vv = installVisualViewport();
    try {
      const onNext = vi.fn();
      const { container } = renderViewer({ email: htmlEmail, onNavigateNext: onNext, onNavigatePrev: vi.fn() });
      const { pane, track } = parts(container);
      // A second finger locks the track until the fingers are up.
      act(() => { touch(pane!, 'touchstart', 300, 300, 2); });
      expect(track!.style.overflowX).toBe('hidden');
      act(() => { touch(pane!, 'touchmove', 200, 300, 2); touch(pane!, 'touchend', 200, 300); });
      expect(track!.style.overflowX).toBe('');
      vv.pinchTo(2.3);
      expect(container.querySelector('[data-swipe-gutter]')).toBeNull();
      pan(container, 'none', 0);
      expect(onNext).not.toHaveBeenCalled();
      // Zoomed back out: the gutters return.
      vv.pinchTo(1);
      expect(parts(container).next!.dataset.mode).toBe('go');
    } finally {
      vv.remove();
    }
  });

  it('at the last message the next side only bounces', () => {
    const onPrev = vi.fn();
    const { container } = renderViewer({ onNavigatePrev: onPrev });
    const { next } = parts(container);
    expect(next!.dataset.mode).toBe('bounce');
    swipeTo(container, 'next');
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('slides out before opening the next message, and the next one slides in (motion allowed)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    setReducedMotion(false);
    const onNext = vi.fn();
    const { container, rerender } = renderViewer({ onNavigateNext: onNext });
    const { page, track } = parts(container);
    swipeTo(container, 'next');
    expect(onNext).not.toHaveBeenCalled();
    expect(page!.dataset.swipe).toBe('out');
    expect(page!.style.transform).toMatch(/^translate3d\(-\d+px,0,0\)$/);
    expect(track!.style.overflowX).toBe('hidden'); // no second swipe meanwhile
    act(() => { vi.advanceTimersByTime(200); });
    expect(onNext).toHaveBeenCalledTimes(1);
    rerender(
      <EmailViewer email={htmlEmail} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        onQuickReply={vi.fn(async () => {})} onNavigateNext={onNext} />,
    );
    expect(page!.dataset.swipe).toBe('enter');
    expect(track!.style.overflowX).toBe('');
    act(() => { vi.advanceTimersByTime(400); });
    expect(page!.style.transform).toBe('');
  });
});
