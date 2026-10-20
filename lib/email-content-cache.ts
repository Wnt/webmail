// Fork (Wnt/webmail): the reading pane's sanitized message bodies, and the
// sanitizing of a body before it is opened.
//
// The reading pane turns a message's HTML body into what its sandboxed
// iframe shows (getRenderableHtmlBody, cid: references, DOMPurify through
// sanitizeEmailBodyForIframe). That pass costs tens of ms on the main thread.
// It used to run while the message opened. Bodies the app has before the open
// - the push worker's kept copy of a new message, a body fetched while the
// pointer rests on its row - are sanitized here when the browser is idle,
// with the very same function and inputs; the reading pane then finds the
// result in the cache instead of sanitizing on the way to the first paint.
//
// The cache key carries every input the result depends on (the login, the
// message id, whether external content is blocked, the resolved cid: URLs);
// JMAP message bodies are immutable. A body whose shown part was truncated by
// the server is never cached ahead: the open fetches the full value first.

import type { Email } from '@/lib/jmap/types';
import { authenticationResultsValues, parseAuthenticationResults, senderTrustCheck, type SenderTrustCheck } from '@/lib/email-headers';
import { getRenderableHtmlBody } from '@/lib/email-body-selection';
import { sanitizeEmailBodyForIframe } from '@/lib/email-sanitization';
import { useSettingsStore } from '@/stores/settings-store';
import { useContactStore } from '@/stores/contact-store';

export interface EmailHtmlContent {
  html: string;
  isHtml: boolean;
  hasStyleTag: boolean;
  externalBlocked: boolean;
}

export interface CachedEmailContent {
  content: EmailHtmlContent;
  blockedExternalContent: boolean;
}

/**
 * The body text a result was made from (the shown HTML and text parts'
 * values). A hit must have been made from exactly this text: the key's ids
 * name a message only within one session and account, so another message
 * that happens to share them (another login, a replaced session) never gets
 * this body (review swipe-preload R4; audit/FOLLOWUPS.md pwa-start N4).
 */
type BodyInputs = readonly [string | undefined, string | undefined, string];

/**
 * Everything of `email` that prepareEmailHtml's result depends on besides the
 * key's options: the shown HTML and text values, and what decides between
 * them and the cid: rewrite - the parts' ids and media types (a text/plain
 * part listed as htmlBody renders as text; a distinct text part can win over
 * a bare HTML wrapper) and whether there are attachments.
 */
function bodyInputs(email: Email): BodyInputs {
  const values = email.bodyValues ?? {};
  const html = email.htmlBody?.[0];
  const text = email.textBody?.[0];
  const shape = [html?.partId ?? '', html?.type ?? '', text?.partId ?? '', text?.type ?? '', email.attachments ? 'a' : ''].join('\u0000');
  return [html?.partId ? values[html.partId]?.value : undefined, text?.partId ? values[text.partId]?.value : undefined, shape];
}

const EMAIL_CONTENT_CACHE = new Map<string, CachedEmailContent & { inputs: BodyInputs }>();
/** The last few bodies shown or sanitized ahead (a repeat open, a re-render after a keyword change). */
export const EMAIL_CONTENT_CACHE_SIZE = 12;
const INERT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The key of a message's sanitized body; null when it has no body values. */
export function emailContentCacheKey(email: Email, blockExternal: boolean, cidBlobUrls: Record<string, string>): string | null {
  if (!email.id || !email.bodyValues) return null;
  const account = email.sourceClientAccountId ?? email.sourceAccountId ?? email.accountId ?? '';
  const cids = Object.keys(cidBlobUrls).sort().map((k) => `${k}=${cidBlobUrls[k]}`).join('&');
  return `${account}\u0000${email.id}\u0000${blockExternal ? 1 : 0}\u0000${cids}`;
}

/** `email`'s sanitized body under `key`, if it was made from this very body text. */
export function cachedEmailContent(key: string | null, email: Email): CachedEmailContent | undefined {
  const entry = key ? EMAIL_CONTENT_CACHE.get(key) : undefined;
  if (!entry) return undefined;
  const [html, text, shape] = bodyInputs(email);
  if (entry.inputs[0] !== html || entry.inputs[1] !== text || entry.inputs[2] !== shape) return undefined;
  return { content: entry.content, blockedExternalContent: entry.blockedExternalContent };
}

function remember(key: string, value: CachedEmailContent, email: Email): void {
  EMAIL_CONTENT_CACHE.delete(key);
  EMAIL_CONTENT_CACHE.set(key, { ...value, inputs: bodyInputs(email) });
  while (EMAIL_CONTENT_CACHE.size > EMAIL_CONTENT_CACHE_SIZE) {
    const oldest = EMAIL_CONTENT_CACHE.keys().next().value;
    if (oldest === undefined) break;
    EMAIL_CONTENT_CACHE.delete(oldest);
  }
}

/**
 * The reading pane's HTML body of `email`: sanitized for the iframe, with
 * cid: references resolved to `cidBlobUrls` (an inert pixel until fetched),
 * and the external-content policy applied. Null when the message has no HTML
 * body to show this way (the pane shows its text body instead). Kept in the
 * cache under emailContentCacheKey.
 */
export function prepareEmailHtml(email: Email, blockExternal: boolean, cidBlobUrls: Record<string, string>): CachedEmailContent | null {
  if (!email.bodyValues) return null;
  let htmlContent = getRenderableHtmlBody(email);
  if (!htmlContent) return null;
  // Replace cid: references with authenticated blob URLs (fetched by the
  // pane); a raw JMAP download URL would raise the browser's auth dialog.
  if (email.attachments) {
    htmlContent = htmlContent.replace(/\bcid:([^"'\s)]+)/gi, (_match, cidRef: string) => cidBlobUrls[cidRef] || INERT_PIXEL);
  }
  // Sanitize (no dark mode colour transforms - emails render true to life in
  // the iframe) and enforce the external-content policy.
  const { html, blockedExternalContent } = sanitizeEmailBodyForIframe(htmlContent, blockExternal);
  const value: CachedEmailContent = {
    content: {
      html,
      isHtml: true,
      hasStyleTag: /<style[\s>]/i.test(htmlContent),
      // Drives the strict iframe CSP: in blocking mode the iframe forbids
      // external img/media/font fetches entirely, so a vector the DOM walk
      // missed (e.g. <style>-tag url()) still can't phone home.
      externalBlocked: blockExternal,
    },
    blockedExternalContent,
  };
  const key = emailContentCacheKey(email, blockExternal, cidBlobUrls);
  if (key) remember(key, value, email);
  return value;
}

/**
 * Whether the reading pane blocks external content for `email` when it first
 * shows it: the sender is not trusted (the trusted-sender list, or the
 * trusted-senders address book when that is on) and the policy is 'block', or
 * 'ask' before the user allowed it.
 */
type SenderFacts = Pick<Email, 'from'> & Partial<Pick<Email, 'authenticationResults' | 'headers'>> & {
  /**
   * The check already made for the message (senderTrustFor), carried where
   * the message itself is not (a reply's or forward's context): it keeps a
   * rejected or order-unknown result from turning into "no checks".
   */
  senderTrust?: SenderTrustCheck;
};

/**
 * Fork (Wnt/webmail): whether the receiving server's checks let the trusted-
 * sender list or book apply to the message's From address
 * (lib/email-headers.ts senderTrustCheck): from the results getEmail parsed,
 * else from the raw header of a message fetched ahead. A header record whose
 * order is unknown (the field under two spellings) is `unauthenticated`.
 */
export function senderTrustFor(email: SenderFacts): SenderTrustCheck {
  const from = email.from?.[0]?.email;
  if (email.senderTrust) return email.senderTrust;
  if (email.authenticationResults) return senderTrustCheck(email.authenticationResults, from);
  const raw = authenticationResultsValues(email.headers);
  if (raw === null) return 'unauthenticated';
  return raw.length ? senderTrustCheck(parseAuthenticationResults(raw), from) : 'none';
}

/** Whether trusting the sender would let its messages load remote content: the trust buttons show only then. */
export function senderTrustable(email: SenderFacts): boolean {
  return senderTrustFor(email) !== 'unauthenticated';
}

export function shouldBlockExternalFor(
  email: SenderFacts,
  opts: {
    externalContentPolicy: string;
    allowExternalContent: boolean;
    isSenderTrusted: (email: string) => boolean;
    trustedSendersAddressBook: boolean | null;
    isTrustedAddressBookSender: (email: string) => boolean;
  },
): boolean {
  const senderEmail = email.from?.[0]?.email?.toLowerCase();
  // Fork (Wnt/webmail): the lists apply only to a From address the receiving
  // server's checks authenticate (or mail it did not check at all), so a
  // forged trusted address cannot load remote content (reviews swipe-trust r1
  // R1, r2 R2-1/R2-2). The "allow" setting and the message's own "Load images"
  // still apply.
  const senderIsTrusted = senderEmail && senderTrustFor(email) !== 'unauthenticated'
    ? opts.isSenderTrusted(senderEmail) || (!!opts.trustedSendersAddressBook && opts.isTrustedAddressBookSender(senderEmail))
    : false;
  return !senderIsTrusted && (
    opts.externalContentPolicy === 'block'
    || (opts.externalContentPolicy === 'ask' && !opts.allowExternalContent)
  );
}

/**
 * Whether the reading view shows its "Images and external content have been
 * blocked" banner: something was actually blocked in the prepared body, the
 * user has not allowed this message's external content, and the policy is not
 * "allow". One rule for the reading pane and the swipe's neighbour panes.
 */
export function showsBlockedContentBanner(opts: {
  blockedExternalContent: boolean;
  allowExternalContent: boolean;
  externalContentPolicy: string;
}): boolean {
  return opts.blockedExternalContent && !opts.allowExternalContent && opts.externalContentPolicy !== 'allow';
}

function hasTruncatedShownBody(email: Email): boolean {
  const values = email.bodyValues;
  if (!values) return false;
  const html = email.htmlBody?.[0]?.partId;
  const text = email.textBody?.[0]?.partId;
  return Boolean((html && values[html]?.isTruncated) || (text && values[text]?.isTruncated));
}

/**
 * Sanitizes `email`'s body for the reading pane when the browser is next
 * idle, as the pane will when it opens the message: before any cid: image is
 * fetched, with external content allowed only by the policy or a trusted
 * sender. The open then takes it from the cache. `email` must carry the list
 * row's source stamps (accountId, sourceAccountId, sourceClientAccountId) the
 * pane's copy will carry, or the key differs and the pane sanitizes as before.
 */
export function prewarmEmailContent(email: Email | null | undefined): void {
  if (!email?.id || !email.bodyValues || hasTruncatedShownBody(email)) return;
  const run = () => {
    try {
      const settings = useSettingsStore.getState();
      const contacts = useContactStore.getState();
      const blockExternal = shouldBlockExternalFor(email, {
        externalContentPolicy: settings.externalContentPolicy,
        allowExternalContent: false,
        isSenderTrusted: settings.isSenderTrusted,
        trustedSendersAddressBook: settings.trustedSendersAddressBook,
        isTrustedAddressBookSender: contacts.isTrustedAddressBookSender,
      });
      const key = emailContentCacheKey(email, blockExternal, {});
      if (!key || cachedEmailContent(key, email)) return;
      prepareEmailHtml(email, blockExternal, {});
    } catch {
      // Best effort: the open sanitizes it as before.
    }
  };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 1000 });
  } else {
    setTimeout(run, 0);
  }
}

/** Tests only. */
export function __clearEmailContentCache(): void {
  EMAIL_CONTENT_CACHE.clear();
}
