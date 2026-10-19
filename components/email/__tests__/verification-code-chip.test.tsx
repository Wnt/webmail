import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fork (Wnt/webmail): the small code chip (list rows, older code mails) copies
// through lib/copy-text.ts like the bar: one write at a time, and "copied"
// only when the browser confirmed it (Astra otp-code-bar r1 R1). Invented codes.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast: toasts }));

const { VerificationCodeChip } = await import('../verification-code-chip');

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
  toasts.success.mockClear();
  toasts.error.mockClear();
});
afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

describe('VerificationCodeChip', () => {
  it('a double click while the first write waits writes once', async () => {
    let resolve!: () => void;
    writeText.mockImplementation(() => new Promise<void>((r) => { resolve = r; }));
    render(<VerificationCodeChip code="482913" />);
    const chip = screen.getByTestId('verification-code-chip');
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('482913');
    await act(async () => { resolve(); });
    expect(toasts.success).toHaveBeenCalledTimes(1);
  });

  it('a refused write says it could not copy', async () => {
    writeText.mockImplementation(() => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    render(<VerificationCodeChip code="482913" />);
    await act(async () => { fireEvent.click(screen.getByTestId('verification-code-chip')); });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });
});
