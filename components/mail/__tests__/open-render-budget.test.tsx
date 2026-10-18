import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Performance regression budget (2026-10-18): what opening a message, marking
// it read and the store writes around an open may re-render. Measured in
// production, an open re-rendered the whole shell about ten times - every
// folder row of the sidebar and every list row, each time. These are work
// counts (renders of one per-row piece), not timings, so they hold on a
// loaded host.
//
//  - the sidebar renders nothing for an open, a loading flag or a parent
//    re-render with fresh inline callbacks; a count change on one folder
//    re-renders that folder's row only;
//  - the message list renders nothing for store writes that change none of
//    its rows; opening a message re-renders the rows it selects and leaves;
//    marking one read re-renders that row only.

const counts = { folderRows: 0, listRows: 0 };

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({ useDragDropContext: () => ({ isDragging: false }) }));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({ useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }) }));
vi.mock('@/components/layout/account-switcher', () => ({ AccountSwitcher: () => null }));
// Every folder row asks this once per render (MailboxTreeItem), and so does
// the sidebar itself once.
vi.mock('@/hooks/use-is-embedded', () => ({ useIsEmbedded: () => { counts.folderRows++; return false; } }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
// One avatar per list row and render.
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => { counts.listRows++; return null; } }));

const { Sidebar } = await import('@/components/layout/sidebar');
const { EmailList } = await import('@/components/email/email-list');
const { useEmailStore } = await import('@/stores/email-store');
const { useUIStore } = await import('@/stores/ui-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const mailbox = (id: string, i: number, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name: id, role: i < 4 ? (['inbox', 'sent', 'drafts', 'trash'][i] as Mailbox['role']) : undefined,
  parentId: null, totalEmails: 10, unreadEmails: 3, sortOrder: i, myRights: { mayAddItems: true }, ...extra,
} as unknown as Mailbox);
const MAILBOXES = ['inbox', 'sent', 'drafts', 'trash', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((id, i) => mailbox(id, i));

const makeEmail = (id: string, seen = false): Email => ({
  id, threadId: `thread-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: seen }, size: 1000,
  receivedAt: `2026-09-${String(30 - Number(id.slice(1))).padStart(2, '0')}T10:00:00Z`,
  from: [{ name: 'Alice Example', email: 'alice@example.test' }], subject: `Mail ${id}`, hasAttachment: false, preview: 'p',
});
const EMAILS = Array.from({ length: 10 }, (_, i) => makeEmail(`m${i}`));

const initialEmailState = useEmailStore.getState();
const restores: Array<() => void> = [];
beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', mailboxes: MAILBOXES });
  useUIStore.setState({ sidebarCollapsed: false } as never);
  useSettingsStore.setState({ enableUnifiedMailbox: false, hideAccountSwitcher: true, density: 'comfortable' } as never);
  // A layout for the list's virtualizer (jsdom has none): a 1000px list of 60px rows.
  const isList = (el: Element) => (el as HTMLElement).dataset?.tour === 'email-list';
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return isList(this) ? 1000 : 0; }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400),
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return isList(this) ? 1000 : 0; }),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.hasAttribute('data-index') ? 60 : isList(this) ? 1000 : 0;
      return { x: 0, y: 0, width: 400, height, top: 0, left: 0, right: 400, bottom: height, toJSON: () => ({}) } as DOMRect;
    }),
  ];
  restores.push(() => spies.forEach((s) => s.mockRestore()));
  (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo = () => {};
});
afterEach(() => { while (restores.length) restores.pop()!(); });

/** The sidebar as MailApp renders it: fresh inline callbacks on every render. */
function SidebarHost({ mailboxes, tick }: { mailboxes: Mailbox[]; tick: number }) {
  return (
    <Sidebar
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      onMailboxSelect={() => tick}
      onCompose={() => tick}
      onSidebarClose={() => tick}
      onUnreadFilterClick={() => tick}
    />
  );
}

describe('open render budget: sidebar', () => {
  it('an open, its loading flags and a parent re-render render no folder row', () => {
    const view = render(<SidebarHost mailboxes={MAILBOXES} tick={0} />);
    expect(counts.folderRows, 'first render: every row').toBeGreaterThanOrEqual(MAILBOXES.length);
    counts.folderRows = 0;
    act(() => {
      useEmailStore.getState().setLoadingEmail(true);
      useEmailStore.getState().selectEmail(EMAILS[3]);
      useEmailStore.getState().setLoadingEmail(false);
    });
    view.rerender(<SidebarHost mailboxes={MAILBOXES} tick={1} />);
    expect(counts.folderRows).toBe(0);
  });

  it('a count change on one folder re-renders that row (and the sidebar) only', () => {
    const view = render(<SidebarHost mailboxes={MAILBOXES} tick={0} />);
    counts.folderRows = 0;
    const next = MAILBOXES.map((m) => (m.id === 'inbox' ? { ...m, unreadEmails: m.unreadEmails - 1 } : m));
    view.rerender(<SidebarHost mailboxes={next} tick={1} />);
    expect(counts.folderRows).toBeLessThanOrEqual(2);
  });
});

/** The list as MailApp renders it: fresh inline callbacks on every render. */
function ListHost({ emails, selectedEmailId, tick }: { emails: Email[]; selectedEmailId?: string; tick: number }) {
  return (
    <EmailList
      emails={emails}
      selectedEmailId={selectedEmailId}
      onEmailSelect={() => tick}
      onToggleStar={() => tick}
      onDelete={() => tick}
      onArchive={() => tick}
      onMarkAsRead={() => tick}
    />
  );
}

describe('open render budget: message list', () => {
  it('store writes around an open and a parent re-render render no list row', () => {
    const view = render(<ListHost emails={EMAILS} tick={0} />);
    expect(counts.listRows, 'first render: the visible rows').toBeGreaterThanOrEqual(5);
    counts.listRows = 0;
    act(() => {
      useEmailStore.getState().setLoadingEmail(true);
      useEmailStore.setState({ quota: { used: 1, total: 2 } });
      useEmailStore.getState().setLoadingEmail(false);
    });
    view.rerender(<ListHost emails={EMAILS} tick={1} />);
    expect(counts.listRows).toBe(0);
  });

  it('opening a message re-renders the rows it selects and leaves, not the others', () => {
    const view = render(<ListHost emails={EMAILS} selectedEmailId="m1" tick={0} />);
    counts.listRows = 0;
    view.rerender(<ListHost emails={EMAILS} selectedEmailId="m4" tick={1} />);
    expect(counts.listRows).toBeLessThanOrEqual(2);
  });

  it('marking one message read re-renders that row only', () => {
    const view = render(<ListHost emails={EMAILS} selectedEmailId="m2" tick={0} />);
    counts.listRows = 0;
    const next = EMAILS.map((e) => (e.id === 'm2' ? { ...e, keywords: { ...e.keywords, $seen: true } } : e));
    view.rerender(<ListHost emails={next} selectedEmailId="m2" tick={1} />);
    expect(counts.listRows).toBe(1);
  });
});
