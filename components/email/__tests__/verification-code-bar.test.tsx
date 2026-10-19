import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerificationCodeBar } from '../verification-code-bar';

// Fork (Wnt/webmail): the one-time-code bar at the top of the reading view.
// One tap on "Copy code" copies; the bar never copies on its own (no browser
// lets a page write the clipboard without a tap, and iOS WebKit refuses even
// right after a notification tap), and it says "copied" only after the
// browser confirmed the write. Invented codes only. (The translation mock
// returns keys: 'copy_button', 'copied', ...)

const CODE = '482913';
let writeText: ReturnType<typeof vi.fn>;
let execCommand: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  execCommand = vi.fn(() => false);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  window.getSelection()?.removeAllRanges();
});

const bar = () => screen.getByTestId('verification-code-bar');
const button = () => screen.getByTestId('verification-code-copy');
const status = () => screen.getByTestId('verification-code-status');

describe('VerificationCodeBar', () => {
  it('shows the code and one named Copy button in a labelled region, and copies nothing on its own', () => {
    render(<VerificationCodeBar code={CODE} />);
    expect(screen.getByTestId('verification-code-value')).toHaveTextContent(CODE);
    expect(screen.getByRole('region', { name: 'label' })).toBe(bar());
    expect(screen.getByRole('button', { name: 'copy_button' })).toBe(button());
    expect(status()).toHaveAttribute('role', 'status');
    expect(status()).toHaveAttribute('aria-live', 'polite');
    expect(status()).toHaveTextContent('');
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('one tap: the write starts inside the click, "copied" only after the browser confirmed it', async () => {
    let resolve!: () => void;
    writeText.mockImplementation(() => new Promise<void>((r) => { resolve = r; }));
    render(<VerificationCodeBar code={CODE} />);
    fireEvent.click(button());
    // Asked for during the click itself, with exactly the shown code.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(bar()).toHaveAttribute('data-copy-state', 'copying');
    expect(button()).not.toHaveTextContent('copied_button');
    expect(status()).toHaveTextContent('');
    await act(async () => { resolve(); });
    expect(bar()).toHaveAttribute('data-copy-state', 'copied');
    expect(button()).toHaveTextContent('copied_button');
    expect(status()).toHaveTextContent('copied');
  });

  it('a refused write: says so, selects the code for copying by hand, never "copied"', async () => {
    writeText.mockImplementation(() => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    render(<VerificationCodeBar code={CODE} />);
    await act(async () => { fireEvent.click(button()); });
    expect(execCommand).toHaveBeenCalledWith('copy'); // the fallback was tried, and refused too
    expect(bar()).toHaveAttribute('data-copy-state', 'failed');
    expect(status()).toHaveTextContent('copy_failed_select');
    expect(button()).toHaveTextContent('copy_button');
    expect(bar()).not.toHaveTextContent('copied_button');
    expect(String(window.getSelection())).toBe(CODE);
  });

  it('the execCommand fallback that worked counts as copied', async () => {
    writeText.mockImplementation(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    execCommand.mockReturnValue(true);
    render(<VerificationCodeBar code={CODE} />);
    await act(async () => { fireEvent.click(button()); });
    expect(bar()).toHaveAttribute('data-copy-state', 'copied');
  });

  it('a second tap while the first write is pending does not write twice', async () => {
    let resolve!: () => void;
    writeText.mockImplementation(() => new Promise<void>((r) => { resolve = r; }));
    render(<VerificationCodeBar code={CODE} />);
    fireEvent.click(button());
    fireEvent.click(button());
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
    fireEvent.click(button());
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('"Copied" goes back to "Copy code" after a few seconds; a failure can be retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<VerificationCodeBar code={CODE} />);
    await act(async () => { fireEvent.click(button()); });
    expect(bar()).toHaveAttribute('data-copy-state', 'copied');
    act(() => { vi.advanceTimersByTime(3100); });
    expect(bar()).toHaveAttribute('data-copy-state', 'idle');
    expect(status()).toHaveTextContent('');

    writeText.mockImplementationOnce(() => Promise.reject(new Error('refused')));
    await act(async () => { fireEvent.click(button()); });
    expect(bar()).toHaveAttribute('data-copy-state', 'failed');
    await act(async () => { fireEvent.click(button()); });
    expect(bar()).toHaveAttribute('data-copy-state', 'copied');
  });

  it('where the browser will not select the code, the failure says only that it could not copy', async () => {
    writeText.mockImplementation(() => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    const getSelection = vi.spyOn(window, 'getSelection');
    render(<VerificationCodeBar code={CODE} />);
    getSelection.mockReturnValue(null);
    await act(async () => { fireEvent.click(button()); });
    getSelection.mockRestore();
    expect(bar()).toHaveAttribute('data-copy-state', 'failed');
    expect(status()).toHaveTextContent('copy_failed');
    expect(status()).not.toHaveTextContent('copy_failed_select');
  });

  it('the next message\'s bar: a copy the old bar left waiting never writes over the new one (Astra r1 N1)', async () => {
    let rejectA!: (e: unknown) => void;
    const writes: string[] = [];
    writeText.mockImplementation((text: string) => {
      writes.push(text);
      return text === '123456' ? new Promise<void>((_, rej) => { rejectA = rej; }) : Promise.resolve();
    });
    execCommand.mockReturnValue(true);
    const { rerender } = render(<VerificationCodeBar key="a" code="123456" />);
    fireEvent.click(button());
    // The viewer keys the bar by message: another message is another bar.
    rerender(<VerificationCodeBar key="b" code="654321" />);
    await act(async () => { fireEvent.click(button()); });
    expect(bar()).toHaveAttribute('data-copy-state', 'copied');
    await act(async () => { rejectA(new DOMException('not allowed', 'NotAllowedError')); });
    expect(execCommand).not.toHaveBeenCalled();
    expect(writes).toEqual(['123456', '654321']);
    expect(bar()).toHaveAttribute('data-copy-state', 'copied');
  });

  it('gone while its copy waits: the late refusal writes nothing and changes nothing', async () => {
    let rejectA!: (e: unknown) => void;
    writeText.mockImplementation(() => new Promise<void>((_, rej) => { rejectA = rej; }));
    execCommand.mockReturnValue(true);
    const { unmount } = render(<VerificationCodeBar code={CODE} />);
    fireEvent.click(button());
    unmount();
    await act(async () => { rejectA(new Error('refused')); });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('shows the code exactly as it is copied (no regrouping), left to right and untranslated', () => {
    render(<VerificationCodeBar code="6ZA-BRE" />);
    const value = screen.getByTestId('verification-code-value');
    expect(value.textContent).toBe('6ZA-BRE');
    expect(value).toHaveAttribute('dir', 'ltr');
    expect(value).toHaveAttribute('translate', 'no');
  });
});
