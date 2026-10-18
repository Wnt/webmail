import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WopiEditor } from '@/components/files/wopi-editor';

// The office editor is a full-screen overlay fixed to the viewport, so the app
// root's safe-area padding never reaches it: in the installed iOS app its
// title and close button sat under the status bar (and, in landscape, in the
// rounded corners), and the editor's own toolbars cannot help, since env() is
// 0 inside its iframe. The overlay must pad every inset itself, once.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('office editor overlay and the iOS safe area', () => {
  it('pads all four insets on the overlay, and nothing inside adds them again', () => {
    render(<WopiEditor target={{ kind: 'file', id: 'f1', name: 'report.docx' }} onClose={() => {}} />);
    const overlay = screen.getByRole('button', { name: 'office_close' }).closest('.fixed');
    expect(overlay).not.toBeNull();
    // Padded, not offset: the overlay does not scroll, and it still covers
    // the whole screen, status-bar strip included.
    expect(overlay).toHaveClass(
      'inset-0',
      'pt-[env(safe-area-inset-top)]',
      'pb-[env(safe-area-inset-bottom)]',
      'pl-[env(safe-area-inset-left)]',
      'pr-[env(safe-area-inset-right)]',
    );
    const inside = Array.from(overlay!.querySelectorAll('*'))
      .flatMap((el) => Array.from(el.classList))
      .filter((cls) => cls.includes('safe-area-inset'));
    expect(inside).toEqual([]);
  });
});
