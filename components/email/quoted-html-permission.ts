/**
 * Fork (Wnt/webmail): whether an editor's quotes may show their remote images
 * - the reading pane's decision for the message being replied to or
 * forwarded (hooks/use-external-content.ts), set by the composer and set
 * again when that decision changes (trust arriving or removed, the policy);
 * every quote of the editor re-renders (components/email/quoted-html.ts).
 * Per editor, never read from the content: nothing in a message or a draft
 * can grant it (review swipe-trust r2 R2-3).
 */
export interface QuotedHtmlStorage {
  remoteAllowed: boolean;
  listeners: Set<() => void>;
}

export function quotedHtmlStorageOf(editor: { storage: unknown } | null | undefined): QuotedHtmlStorage | undefined {
  return (editor?.storage as Record<string, unknown> | undefined)?.quotedHtml as QuotedHtmlStorage | undefined;
}

export function setQuotedHtmlRemoteAllowed(editor: { storage: unknown } | null | undefined, allowed: boolean): void {
  const storage = quotedHtmlStorageOf(editor);
  if (!storage || storage.remoteAllowed === allowed) return;
  storage.remoteAllowed = allowed;
  storage.listeners.forEach((listener) => listener());
}
