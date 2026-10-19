import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, selectElementText } from '@/lib/copy-text';

// Fork (Wnt/webmail): the copy behind the one-time-code bar and chip. The
// result must be the browser's answer - "copied" only when the write
// succeeded - and the write must start inside the tap: WebKit checks the tap
// when writeText is called (an await before it already loses the tap on
// iOS 26.3). Invented codes only.

const CODE = '604217';
let execCommand: ReturnType<typeof vi.fn>;

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText: vi.fn(writeText) } : undefined,
  });
  return (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> } | undefined)?.writeText;
}

beforeEach(() => {
  execCommand = vi.fn(() => false);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('copyText', () => {
  it('starts the write synchronously, inside the caller\'s tap', () => {
    const writeText = stubClipboard(() => Promise.resolve());
    void copyText(CODE);
    // Nothing awaited yet, and the write has already been asked for.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(CODE);
  });

  it('reports copied only once the Clipboard API promise resolves', async () => {
    let resolve!: () => void;
    stubClipboard(() => new Promise<void>((r) => { resolve = r; }));
    let result: string | undefined;
    const done = copyText(CODE).then((r) => { result = r; });
    await Promise.resolve();
    await Promise.resolve();
    expect(result, 'nothing reported while the browser has not answered').toBeUndefined();
    resolve();
    await done;
    expect(result).toBe('copied');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('refused write (NotAllowedError): falls back to execCommand on a selection holding exactly the code', async () => {
    stubClipboard(() => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    let selected = '';
    execCommand.mockImplementation((cmd: string) => {
      selected = String(window.getSelection());
      return cmd === 'copy';
    });
    expect(await copyText(CODE)).toBe('copied');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe(CODE);
    // The helper span is gone and nothing stays selected after a copy.
    expect(document.body.childElementCount).toBe(0);
    expect(String(window.getSelection())).toBe('');
  });

  it('both refused: failed, never copied', async () => {
    stubClipboard(() => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    expect(await copyText(CODE)).toBe('failed');
    expect(document.body.childElementCount).toBe(0);
  });

  it('execCommand throwing counts as a failure', async () => {
    stubClipboard(() => Promise.reject(new Error('refused')));
    execCommand.mockImplementation(() => { throw new Error('SecurityError'); });
    expect(await copyText(CODE)).toBe('failed');
  });

  it('writeText throwing synchronously falls back too', async () => {
    stubClipboard(() => { throw new TypeError('Illegal invocation'); });
    execCommand.mockReturnValue(true);
    expect(await copyText(CODE)).toBe('copied');
  });

  it('no Clipboard API (an insecure page, an old browser): execCommand alone decides', async () => {
    stubClipboard(undefined);
    execCommand.mockReturnValue(true);
    expect(await copyText(CODE)).toBe('copied');
    execCommand.mockReturnValue(false);
    expect(await copyText(CODE)).toBe('failed');
  });

  it('never reads the clipboard', async () => {
    const readText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()), readText, read: readText },
    });
    await copyText(CODE);
    expect(readText).not.toHaveBeenCalled();
  });
});

describe('selectElementText', () => {
  it('selects the text of the element, for copying by hand', () => {
    const span = document.createElement('span');
    span.textContent = 'K7P2QX';
    document.body.appendChild(span);
    expect(selectElementText(span)).toBe(true);
    expect(String(window.getSelection())).toBe('K7P2QX');
    expect(selectElementText(null)).toBe(false);
  });
});
