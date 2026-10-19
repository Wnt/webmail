import { Email } from '@/lib/jmap/types';
import { hasMeaningfulHtmlBody } from '@/lib/signature-utils';

/**
 * Pick the HTML body an email should be rendered from, or null when it should be
 * rendered as plain text instead. Shared by the desktop viewer and the mobile
 * thread view so the two cannot drift apart again (#489: the thread view was
 * missing the part-type guard and rendered plain-text-only mail as HTML,
 * collapsing every line break).
 */
export function getRenderableHtmlBody(
  email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues'>
): string | null {
  return selectHtmlBody(email, Infinity)?.html ?? null;
}

/** An HTML body read up to a limit, and whether anything of it was left out. */
export interface BoundedHtmlBody {
  html: string;
  /** Cut by the limit here, or already by the server (a truncated body value). */
  cut: boolean;
}

/**
 * `getRenderableHtmlBody` for a reader that needs at most `maxChars` of the
 * HTML (the verification-code detector): the HTML is cut first, so the
 * meaningful-HTML check, and any DOM built from it, never sees more than
 * that, however large the body is. The reading pane keeps the full body.
 */
export function getRenderableHtmlBodyBounded(
  email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues'>,
  maxChars: number
): BoundedHtmlBody | null {
  return selectHtmlBody(email, maxChars);
}

function selectHtmlBody(
  email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues'>,
  maxChars: number
): BoundedHtmlBody | null {
  const htmlPart = email.htmlBody?.[0];
  if (!htmlPart?.partId || !email.bodyValues?.[htmlPart.partId]) return null;

  const bodyValue = email.bodyValues[htmlPart.partId];
  const fullContent = bodyValue.value;
  if (!fullContent) return null;

  // Per RFC 8621, a single-part email exposes the same part in both htmlBody and
  // textBody. That shared part may actually be text/plain (plain-text-only mail);
  // rendering it as HTML collapses newlines and skips linkification, so route by
  // the part's media type rather than by which list it appears in.
  if (htmlPart.type && htmlPart.type.toLowerCase() !== 'text/html') return null;

  const htmlContent = fullContent.length > maxChars ? fullContent.slice(0, maxChars) : fullContent;

  // Prefer textBody when the HTML is an auto-generated minimal wrapper (no rich
  // formatting). Server-generated HTML from text/plain emails often lacks <br>
  // tags, which would collapse newlines just the same.
  const textPartId = email.textBody?.[0]?.partId;
  const hasDistinctTextBody =
    !!textPartId && textPartId !== htmlPart.partId && !!email.bodyValues[textPartId];
  if (hasDistinctTextBody && !hasMeaningfulHtmlBody(htmlContent)) return null;

  return { html: htmlContent, cut: htmlContent.length < fullContent.length || bodyValue.isTruncated === true };
}

/**
 * The plain-text body of a draft being re-opened, taken from the parts the
 * server lists as the body and from nothing else.
 *
 * `bodyValues` is keyed by part id, and `getEmail` asks for
 * `fetchAllBodyValues`, which per RFC 8621 § 4.1.4 covers every `text/*`
 * part of the message - attachments included. Joining all of them put the
 * contents of an attached .csv or .txt into the composer as the message
 * text: a draft carrying only attachments and no body re-opened showing an
 * attachment's contents as what you had written, and saving or sending it
 * then made that the actual message.
 */
export function getDraftTextBody(
  email: Pick<Email, 'textBody' | 'bodyValues'>
): string {
  return (email.textBody ?? [])
    .map(part => (part.partId ? email.bodyValues?.[part.partId]?.value : undefined))
    .filter((value): value is string => !!value)
    .join('\n');
}
