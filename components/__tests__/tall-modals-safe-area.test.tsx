import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { TemplateManagerModal } from '@/components/templates/template-manager-modal';
import { FilterRuleModal } from '@/components/filters/filter-rule-modal';
import { SieveEditorModal } from '@/components/filters/sieve-editor-modal';
import { ICalImportModal } from '@/components/calendar/ical-import-modal';
import { KeyboardShortcutsModal } from '@/components/keyboard-shortcuts-modal';
import { SidebarAppsModal } from '@/components/layout/sidebar-apps-modal';
import { PlaceholderFillModal } from '@/components/templates/placeholder-fill-modal';
import type { EmailTemplate } from '@/lib/template-types';

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn(), resetTourCompletion: vi.fn() }),
}));

// These dialogs are centred on a fixed overlay and may grow to 80-90vh. On a
// phone in the installed iOS app (viewport-fit=cover, black-translucent status
// bar) that put their top edge and header padding under the status bar: on a
// 852 px screen with a 59 px inset, a full-height box starts at 43 px. Their
// bottom edge ran into the home-indicator strip too: the email source box
// ended ~13 pt inside the 34 pt bottom inset of an iPhone 17 Pro (iOS
// Simulator, home-screen app). The overlay must pad both insets, once, and
// the box must not grow past the padded overlay (90vh alone is taller than
// what is left between the insets).
const calendars = [{ id: 'cal-1', name: 'Work', isDefault: true, myRights: { mayWriteAll: true } }] as unknown as Calendar[];
const client = { getAccountId: () => 'acc' };
const template = { id: 't1', name: 'Greeting', subject: 'Hello', body: 'Hello {{recipient_name}}', isFavorite: false } as unknown as EmailTemplate;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// p-4 overlays keep their 1rem where there is no inset; the others had no
// vertical padding and pad just the inset.
const PADDED = ['pt-[max(1rem,env(safe-area-inset-top))]', 'pb-[max(1rem,env(safe-area-inset-bottom))]'];
const BARE = ['pt-[env(safe-area-inset-top)]', 'pb-[env(safe-area-inset-bottom)]'];

const cases: Array<[string, () => React.ReactElement, string[]]> = [
  ['identity manager', () => <IdentityManagerModal isOpen onClose={vi.fn()} />, PADDED],
  ['template manager', () => <TemplateManagerModal isOpen onClose={vi.fn()} />, PADDED],
  ['filter rule editor', () => <FilterRuleModal mailboxes={[]} onSave={vi.fn()} onClose={vi.fn()} />, BARE],
  ['Sieve script editor', () => (
    <SieveEditorModal content="" onSave={vi.fn()} onClose={vi.fn()} onValidate={vi.fn().mockResolvedValue({ isValid: true })} />
  ), BARE],
  ['calendar import', () => <ICalImportModal calendars={calendars} client={client as never} onClose={vi.fn()} />, BARE],
  ['keyboard shortcuts', () => <KeyboardShortcutsModal isOpen onClose={vi.fn()} />, PADDED],
  ['sidebar apps', () => <SidebarAppsModal isOpen onClose={vi.fn()} />, PADDED],
  ['template placeholders', () => (
    <PlaceholderFillModal template={template} placeholders={['recipient_name']} autoFilled={{}} onConfirm={vi.fn()} onSkip={vi.fn()} onClose={vi.fn()} />
  ), PADDED],
];

describe('tall centred dialogs and the iOS safe area', () => {
  it.each(cases)('the %s overlay keeps its tall box inside both insets, once', (_name, ui, padding) => {
    render(ui());
    const dialog = screen.getByRole('dialog');
    // The box grows to its share of the screen or the padded overlay,
    // whichever is less (100% of a flex item = the overlay's content box).
    const maxHeights = Array.from(dialog.classList).filter((cls) => cls.startsWith('max-h-'));
    expect(maxHeights).toHaveLength(1);
    expect(maxHeights[0]).toMatch(/^max-h-\[min\([89]\dvh,100%\)\]$/);
    const overlay = dialog.closest('.fixed');
    expect(overlay).not.toBeNull();
    // The overlay pads the insets (an offset would leave the status-bar and
    // home-indicator strips undimmed).
    expect(overlay).toHaveClass('inset-0', ...padding);
    // Once: neither the box nor anything in it adds an inset again.
    const inside = [dialog, ...Array.from(dialog.querySelectorAll('*'))]
      .flatMap((el) => Array.from(el.classList))
      .filter((cls) => cls.includes('safe-area-inset'));
    expect(inside).toEqual([]);
  });
});
