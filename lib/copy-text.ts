// Fork (Wnt/webmail): copy a short text (a one-time code) to the clipboard,
// and say honestly whether it worked.
//
// Browsers write the clipboard from a page only while it handles the user's
// own tap or click (WebKit: Clipboard::writeText -> shouldProceedWithClipboardWrite,
// ClipboardAccessPolicy::RequiresUserGesture by default; execCommand('copy') ->
// EditorCommand.cpp allowCopyCutFromDOM -> UserGestureIndicator::processingUserGesture).
// On iOS 26.3 an `await` before the write already loses the tap (iOS Simulator,
// 2026-10-19: a 1.5 s timer or a fetch first -> NotAllowedError), and a page
// started from a notification tap has no tap at all, so nothing here runs on
// its own: call copyText synchronously from the click handler, before any await.

export type CopyResult = 'copied' | 'failed';

/**
 * Writes `text` to the clipboard. Resolves 'copied' only when the browser
 * confirmed the write (the Clipboard API's promise resolved, or the
 * execCommand('copy') fallback reported success), 'failed' otherwise. Never
 * throws, never reads the clipboard.
 */
export async function copyText(text: string): Promise<CopyResult> {
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
      return 'copied';
    } catch {
      // Refused (no tap, permission denied, page not focused): try the old way.
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

/** Selects the text of `el`, so the user can copy it by hand. */
export function selectElementText(el: HTMLElement | null): boolean {
  if (!el || typeof window === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection) return false;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}
