import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// On a phone the folder drawer is fixed to the full screen height. In the
// installed iOS app its last row (the last tag) ended under the home indicator
// (iOS Simulator, iPhone 17 Pro: the row at y=830-874, the strip from 840).
// The folder list must pad the bottom inset so the last row scrolls clear of
// it; the inset is 0 in a browser tab and on a desktop.

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ isDragging: false }),
}));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({
  useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }),
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));

const { Sidebar } = await import('../sidebar');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

describe('folder list and the iOS home indicator', () => {
  it('pads the bottom safe-area inset at the end of the scrolling list, once', () => {
    const { container } = render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);
    const list = container.querySelector('[data-tour="sidebar"]') as HTMLElement;
    expect(list).toHaveClass('overflow-y-auto', 'pb-[env(safe-area-inset-bottom)]');
    const inside = Array.from(list.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.classList))
      .filter((cls) => cls.includes('safe-area-inset'));
    expect(inside).toEqual([]);
  });
});
