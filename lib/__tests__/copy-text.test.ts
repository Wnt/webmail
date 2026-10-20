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

  it('a refused write (NotAllowedError): failed, and nothing is written afterwards', async () => {
    stubClipboard(() => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    execCommand.mockReturnValue(true);
    expect(await copyText(CODE)).toBe('failed');
    // By the time a refusal comes back the tap is over (WebKit refuses the
    // legacy copy then too), and a later write could overwrite another copy
    // the user made since (Astra r2 N1b).
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('the legacy copy (no Clipboard API): a selection holding exactly the code, cleaned up, the user\'s selection put back', async () => {
    stubClipboard(undefined);
    let selected = '';
    execCommand.mockImplementation((cmd: string) => {
      selected = String(window.getSelection());
      return cmd === 'copy';
    });
    const p = document.createElement('p');
    p.textContent = 'an earlier selection';
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.addRange(range);
    expect(await copyText(CODE)).toBe('copied');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe(CODE);
    expect(document.body.childElementCount).toBe(1); // only the paragraph; the helper span is gone
    expect(String(window.getSelection())).toBe('an earlier selection');
  });

  it('the legacy copy throwing counts as a failure', async () => {
    stubClipboard(undefined);
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

describe('an older copy still waiting for the browser', () => {
  // Astra otp-code-bar r1 N1 / r2 N1b: message A's copy was pending, the user
  // copied something else (B's code, the message link), then A's write was
  // refused and a late fallback wrote A's code over it. Nothing is written
  // after the tap any more, and a newer copy (or the caller's abort) makes the
  // old one report 'superseded'.
  it('a newer copy started meanwhile: the old one writes nothing more and reports superseded', async () => {
    let rejectA!: (e: unknown) => void;
    const writes: string[] = [];
    stubClipboard((text) => {
      writes.push(text);
      return text === '123456' ? new Promise<void>((_, rej) => { rejectA = rej; }) : Promise.resolve();
    });
    execCommand.mockReturnValue(true);
    const a = copyText('123456');
    const b = copyText('654321');
    expect(await b).toBe('copied');
    rejectA(new DOMException('not allowed', 'NotAllowedError'));
    expect(await a).toBe('superseded');
    expect(execCommand).not.toHaveBeenCalled();
    expect(writes).toEqual(['123456', '654321']);
  });

  it('another writer in the app (the message link) copied meanwhile: the late refusal writes nothing over it', async () => {
    let rejectA!: (e: unknown) => void;
    const clipboard: string[] = [];
    stubClipboard((text) => (text === CODE
      ? new Promise<void>((_, rej) => { rejectA = rej; })
      : (clipboard.push(text), Promise.resolve())));
    execCommand.mockImplementation(() => { clipboard.push('fallback'); return true; });
    const a = copyText(CODE);
    // hooks/use-copy-link.ts writes directly, not through copyText.
    await navigator.clipboard.writeText('https://mail.example.test/en/mail/message/b');
    rejectA(new DOMException('not allowed', 'NotAllowedError'));
    expect(await a).toBe('failed');
    expect(execCommand).not.toHaveBeenCalled();
    expect(clipboard).toEqual(['https://mail.example.test/en/mail/message/b']);
  });

  it('an old write that succeeds late reports superseded, not copied', async () => {
    let resolveA!: () => void;
    stubClipboard((text) => (text === '123456' ? new Promise<void>((r) => { resolveA = r; }) : Promise.resolve()));
    const a = copyText('123456');
    expect(await copyText('654321')).toBe('copied');
    resolveA();
    expect(await a).toBe('superseded');
  });

  it('aborted by its caller (the bar went away): no fallback', async () => {
    let rejectA!: (e: unknown) => void;
    stubClipboard(() => new Promise<void>((_, rej) => { rejectA = rej; }));
    execCommand.mockReturnValue(true);
    const controller = new AbortController();
    const a = copyText('123456', { signal: controller.signal });
    controller.abort();
    rejectA(new Error('refused'));
    expect(await a).toBe('superseded');
    expect(execCommand).not.toHaveBeenCalled();
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
