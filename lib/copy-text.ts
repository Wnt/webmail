// Fork (Wnt/webmail): copy a short text (a one-time code) to the clipboard,
// and say honestly whether it worked.
//
// The app writes the clipboard only from the user's own tap or click, and
// WebKit allows nothing else: Clipboard::writeText -> shouldProceedWithClipboardWrite
// (ClipboardAccessPolicy::RequiresUserGesture by default) and execCommand('copy')
// -> EditorCommand.cpp allowCopyCutFromDOM -> UserGestureIndicator::processingUserGesture.
// On iOS 26.3 an `await` before the write already loses the tap (iOS Simulator,
// 2026-10-19: a 1.5 s timer or a fetch first -> NotAllowedError), and a page
// started from a notification tap has no tap at all. So: call copyText
// synchronously from the click handler, before any await.

/** 'superseded': a newer copy started, or the caller cancelled, before this one finished; nothing more was written. */
export type CopyResult = 'copied' | 'failed' | 'superseded';

// The newest copy; an older one still waiting for the browser never runs its
// fallback (which would write its text over the newer one's).
let generation = 0;

/**
 * Writes `text` to the clipboard. Resolves 'copied' only when the browser
 * confirmed the write (the Clipboard API's promise resolved, or the
 * execCommand('copy') fallback reported success), 'failed' when it refused,
 * 'superseded' when a newer copyText call started (anywhere in the page) or
 * `signal` was aborted before the browser answered. Never throws, never reads
 * the clipboard.
 */
export async function copyText(text: string, opts?: { signal?: AbortSignal }): Promise<CopyResult> {
  const mine = ++generation;
  const current = () => mine === generation && !opts?.signal?.aborted;
  // Started synchronously: writeText checks the tap when it is called.
  let write: Promise<void> | null = null;
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard && typeof clipboard.writeText === 'function') write = clipboard.writeText(text);
  } catch {
    write = null;
  }
  if (write) {
    try {
      await write;
      return current() ? 'copied' : 'superseded';
    } catch {
      // Refused (no tap, permission denied, page not focused): try the old way,
      // unless this copy is no longer the one the user asked for last.
      if (!current()) return 'superseded';
    }
  }
  return execCommandCopy(text) ? 'copied' : 'failed';
}

/** The legacy copy of a selection; true only when the browser says it copied. */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function' || !document.body) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  // A span, not a text field: focusing a field would bring up the keyboard
  // and zoom on a phone.
  const holder = document.createElement('span');
  holder.textContent = text;
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;white-space:pre;'
    + 'user-select:text;-webkit-user-select:text;';
  document.body.appendChild(holder);
  try {
    const range = document.createRange();
    range.selectNodeContents(holder);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    selection.removeAllRanges();
    holder.remove();
  }
}

/** Selects the text of `el`, so the user can copy it by hand; false when the browser would not. */
export function selectElementText(el: HTMLElement | null): boolean {
  if (!el || typeof window === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection) return false;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString() === (el.textContent ?? '');
  } catch {
    return false;
  }
}
