import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Performance regression budget (2026-10-18), with the real drag-and-drop
// provider and hooks the rows use (open-render-budget.test.tsx stubs them).
// Measured in production on a cold notification tap: every list row and every
// folder row re-rendered on each of about ten store writes before the message
// showed, although they are memoised - the drag-and-drop context handed out a
// new value on every render of the mail app, and the drag and drop hooks in
// each row subscribed to the whole email store.

const counts = { folderRows: 0, listRows: 0 };

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/layout/account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/hooks/use-is-embedded', () => ({ useIsEmbedded: () => { counts.folderRows++; return false; } }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => { counts.listRows++; return null; } }));

const { DragDropProvider } = await import('@/contexts/drag-drop-context');
const { Sidebar } = await import('@/components/layout/sidebar');
const { EmailList } = await import('@/components/email/email-list');
const { useEmailStore } = await import('@/stores/email-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useUIStore } = await import('@/stores/ui-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const MAILBOXES = ['inbox', 'sent', 'drafts', 'trash', 'f1', 'f2', 'f3', 'f4'].map((id, i) => ({
  id, name: id, role: i < 4 ? ['inbox', 'sent', 'drafts', 'trash'][i] : undefined, parentId: null,
  totalEmails: 10, unreadEmails: 3, sortOrder: i, myRights: { mayAddItems: true },
})) as unknown as Mailbox[];
const EMAILS = Array.from({ length: 8 }, (_, i): Email => ({
  id: `m${i}`, threadId: `thread-m${i}`, mailboxIds: { inbox: true }, keywords: { $seen: false }, size: 1000,
  receivedAt: `2026-09-${String(28 - i).padStart(2, '0')}T10:00:00Z`, from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }],
  subject: `Mail ${i}`, hasAttachment: false, preview: 'p',
}));

const initialEmailState = useEmailStore.getState();
const restores: Array<() => void> = [];
beforeEach(() => {
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', mailboxes: MAILBOXES });
  useUIStore.setState({ sidebarCollapsed: false } as never);
  useSettingsStore.setState({ enableUnifiedMailbox: false, hideAccountSwitcher: true, density: 'comfortable' } as never);
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

/** As MailApp renders them: inside the drag-and-drop provider, with fresh inline callbacks every render. */
function Shell({ tick }: { tick: number }) {
  return (
    <DragDropProvider>
      <Sidebar mailboxes={MAILBOXES} selectedMailbox="inbox" onMailboxSelect={() => tick} onCompose={() => tick} />
      <EmailList emails={EMAILS} onEmailSelect={() => tick} onDelete={() => tick} onToggleStar={() => tick} />
    </DragDropProvider>
  );
}

describe('open render budget with the real drag-and-drop provider', () => {
  it('a parent re-render and store writes around an open render no list or folder row', () => {
    const view = render(<Shell tick={0} />);
    expect(counts.listRows, 'first render: the visible rows').toBeGreaterThanOrEqual(5);
    expect(counts.folderRows, 'first render: the folder rows').toBeGreaterThanOrEqual(MAILBOXES.length);
    counts.listRows = 0; counts.folderRows = 0;
    view.rerender(<Shell tick={1} />);
    act(() => {
      useEmailStore.getState().setLoadingEmail(true);
      useEmailStore.getState().selectEmail(EMAILS[2]);
      useEmailStore.getState().setLoadingEmail(false);
      useEmailStore.setState({ quota: { used: 1, total: 2 } });
      useAuthStore.setState({ connectionLost: true } as never);
    });
    view.rerender(<Shell tick={2} />);
    expect(counts.listRows, 'list rows').toBe(0);
    expect(counts.folderRows, 'folder rows').toBe(0);
  });
});
