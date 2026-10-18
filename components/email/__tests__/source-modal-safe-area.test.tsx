import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { PaneIdContext } from '@/hooks/use-pane-context';

// The email source dialog is centred on a fixed overlay and grows to 90vh.
// On a phone in the installed iOS app (viewport-fit=cover, black-translucent
// status bar) its box started at 43 px on an 852 px screen with a 59 px inset,
// so its top edge and header padding sat under the status bar. Its bottom edge
// ran ~13 pt into the 34 pt home-indicator strip (iPhone 17 Pro, iOS
// Simulator, home-screen app: box bottom at y=853 of 874). The overlay must
// keep it inside both insets, once, and only where it is fixed to the
// viewport (a Pro pane's overlay is inside the padded app).
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');

const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [{ name: 'Me', email: 'me@example.test' }],
  subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [], attachments: [], bodyValues: {},
} as unknown as Email;
const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

function openSource(wrap: (ui: React.ReactElement) => React.ReactElement = (ui) => ui) {
  render(wrap(
    <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
      onMoveToMailbox={vi.fn()} onSetTag={vi.fn()} />,
  ));
  const more = screen.getByRole('button', { name: 'more_actions' });
  fireEvent.mouseDown(more);
  fireEvent.click(more);
  act(() => { vi.advanceTimersByTime(32); });
  const item = within(screen.getByRole('menu', { name: 'more_actions' })).getByRole('menuitem', { name: /view_source/ });
  fireEvent.mouseDown(item);
  fireEvent.click(item);
  return screen.getByRole('dialog', { name: 'email_source' }).parentElement!;
}

describe('email source dialog and the iOS status bar', () => {
  it('keeps the 90vh box inside the top and bottom insets, once', () => {
    const overlay = openSource();
    expect(overlay).toHaveClass('fixed', 'inset-0', 'p-4', 'pt-[max(1rem,env(safe-area-inset-top))]', 'pb-[max(1rem,env(safe-area-inset-bottom))]');
    // 90vh is taller than what is left between the insets (786 pt against
    // 778 pt there), so the box also stops at the padded overlay.
    expect(screen.getByRole('dialog', { name: 'email_source' })).toHaveClass('max-h-[min(90vh,100%)]');
    const inside = Array.from(overlay.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.classList))
      .filter((cls) => cls.includes('safe-area-inset'));
    expect(inside).toEqual([]);
  });

  it('inside a Pro pane the overlay covers the pane and adds no inset', () => {
    const overlay = openSource((ui) => <PaneIdContext.Provider value="split">{ui}</PaneIdContext.Provider>);
    expect(overlay).toHaveClass('absolute', 'inset-0', 'p-4');
    expect(Array.from(overlay.classList).filter((cls) => cls.includes('safe-area-inset'))).toEqual([]);
  });
});

// iOS Simulator (WebKit) and Chrome both painted the phone action bar (Reply /
// Reply All / Forward) over the bottom of the source dialog: both were z-50
// in the same stacking context and the bar comes later in the document. The
// dialog's close button had no accessible name either.
function zOf(el: Element): number {
  const z = Array.from(el.classList)
    .map((cls) => /^z-(?:\[(\d+)\]|(\d+))$/.exec(cls))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1] ?? m[2]));
  expect(z).toHaveLength(1);
  return z[0];
}

describe('email source dialog over the phone action bar', () => {
  it('is a named dialog above the action bar', () => {
    const overlay = openSource();
    const dialog = screen.getByRole('dialog', { name: 'email_source' });
    expect(overlay).toContainElement(dialog);
    const bar = document.querySelector('[data-mobile-message-bar]')!.closest('nav')!;
    expect(bar).toBeInTheDocument();
    // Same stacking context (the viewer root), so the higher z-index wins.
    expect(zOf(overlay)).toBeGreaterThan(zOf(bar));
  });

  it('inside a Pro pane it is above the pane-scoped action bar too', () => {
    const overlay = openSource((ui) => <PaneIdContext.Provider value="split">{ui}</PaneIdContext.Provider>);
    const bar = document.querySelector('[data-mobile-message-bar]')!.closest('nav')!;
    expect(bar).toHaveClass('absolute');
    expect(zOf(overlay)).toBeGreaterThan(zOf(bar));
  });

  it('has a named close button that closes it', () => {
    openSource();
    const dialog = screen.getByRole('dialog', { name: 'email_source' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'close' }));
    expect(screen.queryByRole('dialog', { name: 'email_source' })).toBeNull();
  });
});

// The phone's More panel spans the viewport height. Its list (a long Move to
// folder list) ended under the home indicator; it must scroll clear of it.
describe('the phone More panel and the home indicator', () => {
  function moreList(wrap: (ui: React.ReactElement) => React.ReactElement = (ui) => ui) {
    render(wrap(
      <EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        onMoveToMailbox={vi.fn()} onSetTag={vi.fn()} />,
    ));
    // The panel is rendered (slid off-screen) while closed.
    const panel = document.querySelector('[role="menu"].w-72') as HTMLElement;
    expect(panel).not.toBeNull();
    const list = panel.querySelector(':scope > .overflow-y-auto') as HTMLElement;
    expect(list).not.toBeNull();
    return list;
  }

  it('pads the bottom inset below its last action', () => {
    expect(moreList()).toHaveClass('overflow-y-auto', 'pb-[calc(0.5rem+env(safe-area-inset-bottom))]');
  });

  it('adds no inset inside a Pro pane', () => {
    const list = moreList((ui) => <PaneIdContext.Provider value="split">{ui}</PaneIdContext.Provider>);
    expect(list).toHaveClass('overflow-y-auto', 'py-2');
    expect(Array.from(list.classList).filter((cls) => cls.includes('safe-area-inset'))).toEqual([]);
  });
});
