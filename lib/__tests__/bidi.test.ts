import { describe, expect, it } from 'vitest';
import { stripBidiControls } from '@/lib/bidi';

describe('stripBidiControls', () => {
  it('removes the characters that reorder what the reader sees', () => {
    // An RTL override makes `report‮fdp.exe` read as `reportexe.pdf`.
    expect(stripBidiControls('report‮fdp.exe')).toBe('reportfdp.exe');
    expect(stripBidiControls('⁦a⁩‎b‏‪‫‬‭')).toBe('ab');
  });

  it('leaves ordinary text, including right-to-left scripts, alone', () => {
    expect(stripBidiControls('Rechnung März.pdf')).toBe('Rechnung März.pdf');
    expect(stripBidiControls('تقرير.pdf')).toBe('تقرير.pdf');
  });
});

// Fork (Wnt/webmail): the reader's and the swipe panes' attachment names go
// through components/email/attachment-display.ts.
describe('getAttachmentDisplayName', () => {
  it('shows the name without directional formatting characters', async () => {
    const { getAttachmentDisplayName } = await import('@/components/email/attachment-display');
    expect(getAttachmentDisplayName('report‮fdp.exe', 'application/octet-stream')).toBe('reportfdp.exe');
    expect(getAttachmentDisplayName('plain.pdf', 'application/pdf')).toBe('plain.pdf');
    // A name of nothing but controls falls back like a missing one.
    expect(getAttachmentDisplayName('\u202E\u202D', 'application/pdf')).toBe(getAttachmentDisplayName(undefined, 'application/pdf'));
    expect(getAttachmentDisplayName('\u202E', 'application/pdf')).not.toBe('');
  });
});
