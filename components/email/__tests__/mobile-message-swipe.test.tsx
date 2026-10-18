import { render, within, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Phone: previous / next are a sideways swipe on the open message, not
// buttons. Desktop keeps its buttons and shortcuts.

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

const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ email: 'bob@example.com' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false,
  size: 100, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
} as unknown as Email;

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function renderViewer(props: Partial<React.ComponentProps<typeof EmailViewer>> = {}) {
  return render(
    <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" {...props} />,
  );
}

const PREV = 'tooltips.previous';
const NEXT = 'tooltips.next';

/** Buttons named previous / next that are not inside the screen-reader-only block. */
function visibleNavButtons(container: HTMLElement) {
  return [...container.querySelectorAll('button')].filter((b) => {
    const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
    return (name === PREV || name === NEXT) && !b.closest('.sr-only');
  });
}

function touchEvent(type: string, x: number, y: number, fingers = 1) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const list = type === 'touchend' || type === 'touchcancel' ? [] : Array.from({ length: fingers }, () => ({ clientX: x, clientY: y }));
  Object.defineProperty(ev, 'touches', { value: list });
  return ev;
}

/** A one-finger drag on `el` from (x0, y) to (x1, y + dy) in 8 moves. */
function swipe(el: Element, x0: number, x1: number, y = 300, dy = 0) {
  act(() => {
    el.dispatchEvent(touchEvent('touchstart', x0, y));
    for (let i = 1; i <= 8; i++) el.dispatchEvent(touchEvent('touchmove', x0 + ((x1 - x0) * i) / 8, y + (dy * i) / 8));
    el.dispatchEvent(touchEvent('touchend', x1, y + dy));
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

describe('previous / next on the phone', () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    device.isMobile = true;
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
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

  it('a swipe left opens the next message, a swipe right the previous one', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: onPrev });
    const pane = container.querySelector('[data-message-swipe]')!;
    swipe(pane, 600, 400);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
    swipe(pane, 400, 600);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('a vertical scroll or a short drag does not navigate', () => {
    const onNext = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext, onNavigatePrev: vi.fn() });
    const pane = container.querySelector('[data-message-swipe]')!;
    swipe(pane, 500, 400, 500, -300); // mostly up the page
    swipe(pane, 500, 470);            // 30 px: under even the flick distance
    expect(onNext).not.toHaveBeenCalled();
  });

  it('at the last message a swipe left does nothing (bounce only)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    setReducedMotion(false);
    const onPrev = vi.fn();
    const { container } = renderViewer({ onNavigatePrev: onPrev });
    const pane = container.querySelector('[data-message-swipe]') as HTMLElement;
    act(() => {
      pane.dispatchEvent(touchEvent('touchstart', 600, 300));
      pane.dispatchEvent(touchEvent('touchmove', 560, 300));
      pane.dispatchEvent(touchEvent('touchmove', 400, 300));
    });
    // Resists: a token nudge, not 1:1.
    const shift = Number(/translate3d\((-?[\d.]+)px/.exec(pane.style.transform)?.[1]);
    expect(shift).toBeLessThan(0);
    expect(shift).toBeGreaterThanOrEqual(-48);
    act(() => { pane.dispatchEvent(touchEvent('touchend', 400, 300)); });
    expect(onPrev).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(400); });
    expect(pane.style.transform).toBe('');
  });

  it('follows the finger and slides out before opening the next message (motion allowed)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    setReducedMotion(false);
    const onNext = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext });
    const pane = container.querySelector('[data-message-swipe]') as HTMLElement;
    act(() => {
      pane.dispatchEvent(touchEvent('touchstart', 600, 300));
      pane.dispatchEvent(touchEvent('touchmove', 580, 300));
      pane.dispatchEvent(touchEvent('touchmove', 450, 300));
    });
    expect(pane.style.transform).toBe('translate3d(-150px,0,0)');
    act(() => { pane.dispatchEvent(touchEvent('touchend', 450, 300)); });
    expect(onNext).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('a two-finger pinch does not navigate', () => {
    const onNext = vi.fn();
    const { container } = renderViewer({ onNavigateNext: onNext });
    const pane = container.querySelector('[data-message-swipe]')!;
    act(() => {
      pane.dispatchEvent(touchEvent('touchstart', 600, 300, 2));
      pane.dispatchEvent(touchEvent('touchmove', 300, 300, 2));
      pane.dispatchEvent(touchEvent('touchend', 300, 300));
    });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('touches starting at the screen edge are left to the browser', () => {
    const onPrev = vi.fn();
    const { container } = renderViewer({ onNavigatePrev: onPrev });
    const pane = container.querySelector('[data-message-swipe]')!;
    swipe(pane, 5, 400);
    expect(onPrev).not.toHaveBeenCalled();
  });
});

describe('previous / next on the desktop', () => {
  beforeEach(() => {
    device.isMobile = false;
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
  });

  it('has no swipe pane or screen-reader duplicates', () => {
    const { container } = renderViewer({ onNavigateNext: vi.fn(), onNavigatePrev: vi.fn() });
    expect(container.querySelector('[data-message-swipe]')).toBeNull();
    expect(container.querySelector('[data-message-nav-sr]')).toBeNull();
  });

  it('Mountain View keeps its visible pager', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
    const { container } = renderViewer({ onNavigateNext: vi.fn(), onNavigatePrev: vi.fn(), mvPosition: { index: 2, total: 5 } });
    const pager = container.querySelector('[data-mv-pager]') as HTMLElement;
    expect(pager).toBeTruthy();
    expect(within(pager).getByRole('button', { name: PREV })).toBeInTheDocument();
    expect(within(pager).getByRole('button', { name: NEXT })).toBeInTheDocument();
  });
});
