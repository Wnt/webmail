import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailList } from '../email-list';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email } from '@/lib/jmap/types';

// The onboarding welcome card stood fixed above the message list: on a phone
// it kept the top third of the screen while the rows scrolled under it (iOS
// Simulator, home-screen app). The list now takes it as a header that scrolls
// with the rows, like a list item, and the virtualizer counts its height.

vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ startTour: vi.fn() }) }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({ client: null, identities: [], username: null, activeAccountId: 'acct-1' })),
  };
});
vi.mock('@/stores/account-store', () => {
  const state = { getAccountById: () => undefined };
  return {
    useAccountStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const makeEmail = (id: string): Email => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2026-09-30T10:00:00Z',
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});
const mails = Array.from({ length: 30 }, (_, i) => makeEmail(`m${i}`));

const HEADER = 200;
const VIEWPORT = 300;
// Extra-compact rows are estimated at 32px: measured the same, every row is
// where the virtualizer thinks it is, measured or not.
const ROW = 32;

const scrollTo = vi.fn();
const element = HTMLElement.prototype as unknown as Record<string, unknown>;
beforeAll(() => { element.scrollTo = scrollTo; });
afterAll(() => { delete element.scrollTo; });

const initialEmailState = useEmailStore.getState();
const initialSettingsState = useSettingsStore.getState();
let stubs: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox' });
  useSettingsStore.setState({ density: 'extra-compact', mailLayout: 'split' } as never);
  scrollTo.mockClear();
  // A layout for the virtualizer, which jsdom does not have: a 300px list
  // whose header is 200px tall, over 32px rows.
  const isList = (el: Element) => (el as HTMLElement).dataset?.tour === 'email-list';
  const isHeader = (el: Element) => (el as HTMLElement).hasAttribute?.('data-list-header');
  stubs = [
    // An empty header box (the card gone) is 0px tall.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return isList(this) ? VIEWPORT : isHeader(this) && this.childElementCount > 0 ? HEADER : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300),
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return isList(this) ? HEADER + mails.length * ROW : 0;
    }),
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return isList(this) ? VIEWPORT : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.hasAttribute('data-index') ? ROW : 0;
      return { x: 0, y: 0, width: 300, height, top: 0, left: 0, right: 300, bottom: height, toJSON: () => ({}) } as DOMRect;
    }),
  ];
});
afterEach(() => {
  stubs.forEach((stub) => stub.mockRestore());
  useSettingsStore.setState(initialSettingsState, true);
});

const header = <div role="complementary" aria-label="Welcome">welcome card</div>;

/** Where the list scrolls to bring m20 into view. */
function scrollTarget(withHeader: React.ReactNode) {
  const view = render(<EmailList emails={mails} header={withHeader} />);
  scrollTo.mockClear();
  view.rerender(<EmailList emails={mails} header={withHeader} selectedEmailId="m20" />);
  const tops = scrollTo.mock.calls.map(([options]) => options?.top).filter((top): top is number => typeof top === 'number');
  view.unmount();
  expect(tops.length).toBeGreaterThan(0);
  return tops[tops.length - 1];
}

describe('email list header', () => {
  it('scrolls with the rows: it is inside the scroll container, above the first row', () => {
    const { container } = render(<EmailList emails={mails} header={header} />);
    const scroller = container.querySelector('[data-tour="email-list"]') as HTMLElement;
    const card = container.querySelector('[aria-label="Welcome"]') as HTMLElement;
    expect(scroller).toContainElement(card);
    const firstRow = scroller.querySelector('[data-index="0"]') as HTMLElement;
    expect(card.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The rows box starts below the header, so the first row sits at its top
    // and the second one a row below: the header's height is not added twice.
    expect(firstRow.style.top).toBe('0px');
    expect((scroller.querySelector('[data-index="1"]') as HTMLElement).style.top).toBe(`${ROW}px`);
  });

  it('counts the header when it brings a message into view', () => {
    const plain = scrollTarget(undefined);
    expect(plain).toBeGreaterThan(0);
    // The rows start the header's height further down the scroll container.
    // Left out of the sum, the list stopped that much short and the message
    // stayed below the fold.
    expect(scrollTarget(header) - plain).toBe(HEADER);
  });

  it('lets the rows move up when the welcome card is dismissed', async () => {
    const { WelcomeBanner } = await import('@/components/ui/welcome-banner');
    const { useSettingsStore: settings } = await import('@/stores/settings-store');
    settings.setState({ onboardingCompleted: false });
    localStorage.clear();
    // A ResizeObserver whose header callbacks the test fires, as the browser
    // does when the card collapses.
    const resized: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        if (el.hasAttribute('data-list-header')) resized.push(() => this.cb([], this as unknown as ResizeObserver));
      }
      unobserve() {}
      disconnect() {}
    });
    try {
      const plain = scrollTarget(undefined);
      const view = render(<EmailList emails={mails} header={<WelcomeBanner />} />);
      const card = screen.getByRole('complementary');
      expect(view.container.querySelector('[data-tour="email-list"]')).toContainElement(card);
      fireEvent.click(screen.getByText('got_it'));
      fireEvent.transitionEnd(card);
      expect(screen.queryByRole('complementary')).toBeNull();
      act(() => { resized.forEach((fire) => fire()); });
      scrollTo.mockClear();
      view.rerender(<EmailList emails={mails} header={<WelcomeBanner />} selectedEmailId="m20" />);
      const tops = scrollTo.mock.calls.map(([options]) => options?.top).filter((top): top is number => typeof top === 'number');
      // With the card gone the rows start at the top again.
      expect(tops[tops.length - 1]).toBe(plain);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws no header box without a header', () => {
    const { container } = render(<EmailList emails={mails} />);
    expect(container.querySelector('[data-list-header]')).toBeNull();
    expect((container.querySelector('[data-index="0"]') as HTMLElement).style.top).toBe('0px');
  });
});
