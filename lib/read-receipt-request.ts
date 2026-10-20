// Fork (Wnt/webmail): the reading pane's Disposition-Notification-To lookup,
// moved out of components/email/email-viewer.tsx so it can be tested on its
// own. The parse is upstream bulwarkmail/webmail 29cb6b7f's.

/**
 * The address a message asks a read receipt (MDN, RFC 8098) to be sent to,
 * from its Disposition-Notification-To header (looked up case-insensitively),
 * or null when there is none.
 */
export function readReceiptRequestAddress(
  headers: Record<string, string | string[]> | undefined | null,
): string | null {
  if (!headers) return null;
  let raw: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'disposition-notification-to') {
      const v = headers[key];
      raw = Array.isArray(v) ? v[0] : v;
      break;
    }
  }
  if (!raw) return null;
  // A header is a line: cap it, and give up an unclosed `<` at the next
  // `<` rather than rescanning to the end once per `<` (sender-controlled).
  const line = raw.slice(0, 1000);
  const m = line.match(/<([^<>]+)>/);
  const addr = (m ? m[1] : line).trim();
  return addr || null;
}
