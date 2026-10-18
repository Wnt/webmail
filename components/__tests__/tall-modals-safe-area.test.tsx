import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar } from '@/lib/jmap/types';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { TemplateManagerModal } from '@/components/templates/template-manager-modal';
import { FilterRuleModal } from '@/components/filters/filter-rule-modal';
import { SieveEditorModal } from '@/components/filters/sieve-editor-modal';
import { ICalImportModal } from '@/components/calendar/ical-import-modal';

// These dialogs are centred on a fixed overlay and may grow to 90vh. On a
// phone in the installed iOS app (viewport-fit=cover, black-translucent status
// bar) that put their top edge and header padding under the status bar: on a
// 852 px screen with a 59 px inset, a full-height box starts at 43 px. The
// overlay must keep the box below the top inset, and do it once.
const calendars = [{ id: 'cal-1', name: 'Work', isDefault: true, myRights: { mayWriteAll: true } }] as unknown as Calendar[];
const client = { getAccountId: () => 'acc' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const cases: Array<[string, () => React.ReactElement, string]> = [
  ['identity manager', () => <IdentityManagerModal isOpen onClose={vi.fn()} />, 'pt-[max(1rem,env(safe-area-inset-top))]'],
  ['template manager', () => <TemplateManagerModal isOpen onClose={vi.fn()} />, 'pt-[max(1rem,env(safe-area-inset-top))]'],
  ['filter rule editor', () => <FilterRuleModal mailboxes={[]} onSave={vi.fn()} onClose={vi.fn()} />, 'pt-[env(safe-area-inset-top)]'],
  ['Sieve script editor', () => (
    <SieveEditorModal content="" onSave={vi.fn()} onClose={vi.fn()} onValidate={vi.fn().mockResolvedValue({ isValid: true })} />
  ), 'pt-[env(safe-area-inset-top)]'],
  ['calendar import', () => <ICalImportModal calendars={calendars} client={client as never} onClose={vi.fn()} />, 'pt-[env(safe-area-inset-top)]'],
];

describe('tall centred dialogs and the iOS status bar', () => {
  it.each(cases)('the %s overlay keeps its 90vh box below the top inset, once', (_name, ui, padding) => {
    render(ui());
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-h-[90vh]');
    const overlay = dialog.closest('.fixed');
    expect(overlay).not.toBeNull();
    // The overlay pads the inset (an offset would leave the status-bar strip
    // undimmed), with the overlay's usual 1rem where there is no inset.
    expect(overlay).toHaveClass('inset-0', padding);
    // Once: neither the box nor anything in it adds the inset again.
    const inside = [dialog, ...Array.from(dialog.querySelectorAll('*'))]
      .flatMap((el) => Array.from(el.classList))
      .filter((cls) => cls.includes('safe-area-inset'));
    expect(inside).toEqual([]);
  });
});
