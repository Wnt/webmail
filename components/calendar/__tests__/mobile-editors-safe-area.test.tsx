import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { PaneIdContext } from '@/hooks/use-pane-context';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';

// On a phone the event and task editors are full-screen layers fixed to the
// viewport, so they escape the app root's safe-area padding: in the installed
// iOS app (viewport-fit=cover, black-translucent status bar) their header sat
// under the status bar and their Save row in the home-indicator area. Each
// editor must take the insets itself, exactly once.
vi.mock('@/hooks/use-media-query', () => ({
  useIsMobile: () => true,
  useIsDesktop: () => false,
  useIsTablet: () => false,
  useMediaQuery: () => false,
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
}));
vi.mock('@/components/calendar/calendar-toolbar', () => ({ CalendarToolbar: () => null }));
vi.mock('@/components/calendar/calendar-month-view', () => ({ CalendarMonthView: () => <div>month grid</div> }));
vi.mock('@/components/calendar/calendar-week-view', () => ({ CalendarWeekView: () => null }));
vi.mock('@/components/calendar/calendar-day-view', () => ({ CalendarDayView: () => null }));
vi.mock('@/components/calendar/calendar-agenda-view', () => ({ CalendarAgendaView: () => null }));
vi.mock('@/components/calendar/task-list-view', () => ({ TaskListView: () => null }));
vi.mock('@/components/calendar/task-toolbar', () => ({
  TaskToolbar: ({ onCreateTask }: { onCreateTask: () => void }) => (
    <button type="button" onClick={onCreateTask}>new task</button>
  ),
}));
vi.mock('@/components/calendar/mini-calendar', () => ({ MiniCalendar: () => null }));
vi.mock('@/components/calendar/calendar-sidebar-panel', () => ({ CalendarSidebarPanel: () => null }));
vi.mock('@/components/calendar/calendar-sidebar-header', () => ({ CalendarSidebarHeader: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/hooks/use-pro-multi-account-calendars', () => ({
  useProMultiAccountCalendars: () => ({ enabled: false, accountClients: [] }),
}));
vi.mock('@/hooks/use-account-principal-emails', () => ({ useAccountPrincipalEmails: () => [] }));

const { CalendarApp } = await import('../calendar-app');
const { EventModal } = await import('../event-modal');

const TOP_INSET = 'env(safe-area-inset-top)';
const BOTTOM_HALF_INSET = 'calc(env(safe-area-inset-bottom)/2)';
const calendars = [
  { id: 'cal-1', name: 'Work', color: '#3b82f6', isDefault: true, isVisible: true, isSubscribed: true,
    myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayDelete: true } },
] as unknown as Calendar[];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const client = { getAccountId: () => 'acc', getUsername: () => 'me@example.test', supportsCalendars: () => true };
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login' });
  useSettingsStore.setState({ enableCalendarTasks: true, showTasksOnCalendar: false, showBirthdayCalendar: false } as never);
  useCalendarStore.setState({
    calendars, events: [], selectedCalendarIds: ['cal-1'], supportsCalendar: true, isLoading: false,
    isLoadingEvents: false, error: null, viewMode: 'month', selectedDate: new Date('2026-10-12T09:00:00'),
    icalSubscriptions: [],
    fetchCalendars: vi.fn().mockResolvedValue(undefined), fetchEvents: vi.fn().mockResolvedValue(undefined),
    refreshAllSubscriptions: vi.fn().mockResolvedValue(undefined),
  } as never);
  useTaskStore.setState({ tasks: [], fetchTasks: vi.fn().mockResolvedValue(undefined) } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Every Tailwind class inside `el` (not on it) that mentions a safe-area inset. */
function insetClassesInside(el: Element): string[] {
  return Array.from(el.querySelectorAll('*'))
    .flatMap((node) => Array.from(node.classList))
    .filter((cls) => cls.includes('safe-area-inset'));
}

function expectPadsInsetsOnce(dialog: HTMLElement) {
  // Fixed to the viewport, the editor is out of reach of the app root's
  // padding. It pads rather than offsets itself: its body scrolls, not the
  // layer, so the padding cannot scroll away, and the layer still covers the
  // status-bar strip.
  expect(dialog).toHaveClass('fixed', 'inset-0', `pt-[${TOP_INSET}]`, `pb-[${BOTTOM_HALF_INSET}]`);
  // Once: nothing inside the editor adds an inset again.
  expect(insetClassesInside(dialog)).toEqual([]);
}

describe('phone calendar editors and the iOS safe area', () => {
  it('the new-event editor pads the top inset and half the bottom inset, once', () => {
    render(<CalendarApp />);
    fireEvent.click(screen.getByRole('button', { name: 'events.create' }));
    const dialog = screen.getByRole('dialog', { name: 'events.create' });
    expectPadsInsetsOnce(dialog);
    // Header and Save row are inside the padded layer.
    expect(dialog).toContainElement(screen.getByText('form.save'));
  });

  it('the task editor pads the top inset and half the bottom inset, once', () => {
    useCalendarStore.setState({ viewMode: 'tasks' } as never);
    render(<CalendarApp />);
    fireEvent.click(screen.getByRole('button', { name: 'new task' }));
    const dialog = screen.getByRole('dialog', { name: 'tasks.create' });
    expectPadsInsetsOnce(dialog);
    expect(dialog).toContainElement(screen.getByText('tasks.save'));
  });

  it('an existing event opened on a phone gets the same layer', () => {
    const event = {
      id: 'ev-1', uid: 'ev-1', '@type': 'Event', title: 'Planning', calendarIds: { 'cal-1': true },
      start: '2026-10-12T10:00:00', duration: 'PT1H', timeZone: null, showWithoutTime: false,
    } as unknown as CalendarEvent;
    render(<EventModal event={event} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} isMobile />);
    expectPadsInsetsOnce(screen.getByRole('dialog', { name: 'Planning' }));
  });

  it('inside a Pro pane the editor covers the pane and adds no inset', () => {
    render(
      <PaneIdContext.Provider value="split">
        <EventModal calendars={calendars} defaultDate={new Date('2026-10-12T10:00:00')} onSave={vi.fn()} onClose={vi.fn()} isMobile />
      </PaneIdContext.Provider>,
    );
    const dialog = screen.getByRole('dialog', { name: 'events.create' });
    expect(dialog).toHaveClass('absolute', 'inset-0');
    expect(Array.from(dialog.classList).filter((cls) => cls.includes('safe-area-inset'))).toEqual([]);
  });
});
