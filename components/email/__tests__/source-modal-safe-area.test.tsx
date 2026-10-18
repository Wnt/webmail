import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { PaneIdContext } from '@/hooks/use-pane-context';

// The email source dialog is centred on a fixed overlay and grows to 90vh.
// On a phone in the installed iOS app (viewport-fit=cover, black-translucent
// status bar) its box started at 43 px on an 852 px screen with a 59 px inset,
// so its top edge and header padding sat under the status bar. The overlay
// must keep it below the inset, once, and only where it is fixed to the
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
  return screen.getByRole('heading', { name: 'email_source' }).closest('.max-h-\\[90vh\\]')!.parentElement!;
}

describe('email source dialog and the iOS status bar', () => {
  it('keeps the 90vh box below the top inset, once', () => {
    const overlay = openSource();
    expect(overlay).toHaveClass('fixed', 'inset-0', 'p-4', 'pt-[max(1rem,env(safe-area-inset-top))]');
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
