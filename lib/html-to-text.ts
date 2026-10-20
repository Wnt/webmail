import { parseHtmlSafely } from '@/lib/email-sanitization';

// Block-level tags whose boundaries become line breaks in the plain-text
// rendering. Without this, the DOM's textContent would run every block
// together on a single line (#421).
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dd',
  'dl',
  'dt',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);

// Paragraph-level blocks that, with `paragraphSpacing` enabled, are separated by
// a blank line rather than a single newline - matching how they render visually.
const PARAGRAPH_TAGS = new Set([
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
]);

export interface HtmlToPlainTextOptions {
  /**
   * Separate paragraph-level blocks (<p>, headings, lists, ...) with a blank
   * line instead of a single newline. Use for email bodies where paragraphs
   * are visually spaced; leave off for compact output like signatures.
   */
  paragraphSpacing?: boolean;
  /**
   * Mark quoted text (<blockquote>, the composer's quoted original) with "> "
   * and list items with "- " or "1. ", as plain-text mail does. Without them
   * the text part of a reply could not tell the reply from the quote.
   */
  mailMarkup?: boolean;
  /**
   * Leave elements out (the verification-code reader: hidden and quoted
   * parts): 'element' skips it with its content, 'rest' ends the text there
   * (everything after is prior correspondence). Unset: every element is read.
   */
  exclude?: (element: Element) => 'element' | 'rest' | null;
}

function normalizeLineBreaks(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(new RegExp(String.fromCharCode(160), 'g'), ' ')
    // Trims trailing spaces, but keeps the one that makes "-- " the RFC 3676
    // signature delimiter, so the text part still marks the signature.
    .split('\n')
    .map((line) => (/^--[ \t]*$/.test(line) ? '-- ' : line.replace(/[ \t]+$/, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Converts HTML into readable plain text, preserving line structure from block
 * elements and <br> tags. Links render as `text <href>` unless the text already
 * is the href. Used to derive the text/plain alternative of an HTML email.
 */
export function htmlToPlainText(html: string, options: HtmlToPlainTextOptions = {}): string {
  return htmlToPlainTextBounded(html, Infinity, options).text;
}

/**
 * `htmlToPlainText` that stops walking once it has produced `maxLength`
 * characters (the verification-code detector needs only the top of a body).
 * `truncated` says it stopped before the end. The work is linear in the
 * input: the trailing-newline count is kept as the output grows, never
 * recounted from the output.
 */
export function htmlToPlainTextBounded(
  html: string,
  maxLength: number,
  options: HtmlToPlainTextOptions = {},
): { text: string; truncated: boolean; stopped: boolean } {
  const { paragraphSpacing = false, mailMarkup = false, exclude } = options;
  const document = parseHtmlSafely(html);
  const chunks: string[] = [];
  // Newline characters trailing the accumulated output, and its length.
  let trailing = 0;
  let produced = 0;
  let truncated = false;
  // An `exclude` verdict of 'rest' ended the text: what is left is complete.
  let stopped = false;

  const push = (chunk: string) => {
    chunks.push(chunk);
    produced += chunk.length;
    let newlines = 0;
    while (newlines < chunk.length && chunk[chunk.length - 1 - newlines] === '\n') newlines++;
    trailing = newlines === chunk.length ? trailing + newlines : newlines;
  };

  const appendText = (value: string) => {
    if (!value) return;
    const normalized = value.replace(/\s+/g, ' ');
    if (!normalized.trim()) return;
    const previous = chunks[chunks.length - 1];
    if (previous && !previous.endsWith('\n') && !previous.endsWith(' ')) {
      push(' ');
    }
    push(normalized);
  };

  // Ensures at least `min` trailing newlines, without emitting leading ones.
  const ensureNewlines = (min: number) => {
    if (chunks.length === 0) return;
    for (let current = trailing; current < min; current++) {
      push('\n');
    }
  };

  // Walks the children until enough text has been produced.
  const walkChildren = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (stopped) return;
      if (produced >= maxLength) {
        truncated = true;
        return;
      }
      walk(child);
    }
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent || '');
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const tagName = element.tagName.toLowerCase();

    const verdict = exclude?.(element) ?? null;
    if (verdict === 'rest') {
      stopped = true;
      return;
    }
    if (verdict === 'element') return;

    if (tagName === 'br') {
      // Additive so consecutive <br> can form a blank line (capped by normalize).
      if (chunks.length > 0) push('\n');
      return;
    }

    // A link reads as "text <href>". With `exclude` (the code reader), it is
    // read like any other element instead, so its hidden or quoted parts are
    // left out, a quote start in it ends the text, and the budget holds.
    if (tagName === 'a' && !exclude) {
      const text = element.textContent?.replace(/\s+/g, ' ').trim() || '';
      const href = element.getAttribute('href')?.trim() || '';
      const normalizedHref = href.replace(/^mailto:/i, '');
      if (text && normalizedHref && text === normalizedHref) {
        appendText(text);
        return;
      }
      if (text && href && text !== href) {
        appendText(`${text} <${href}>`);
        return;
      }
    }

    const separator = paragraphSpacing && PARAGRAPH_TAGS.has(tagName) ? 2 : 1;
    const isBlock = BLOCK_TAGS.has(tagName);

    if (mailMarkup && (tagName === 'blockquote' || element.hasAttribute('data-quoted-html'))) {
      const quoted = htmlToPlainText(element.innerHTML, options);
      if (quoted) {
        ensureNewlines(separator);
        push(quoted.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
        ensureNewlines(separator);
      }
      return;
    }

    if (mailMarkup && tagName === 'li') {
      const list = element.parentElement;
      let marker = '- ';
      if (list?.tagName.toLowerCase() === 'ol') {
        const start = Number(list.getAttribute('start') ?? 1) || 1;
        const position = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === 'li').indexOf(element);
        marker = `${start + position}. `;
      }
      ensureNewlines(1);
      push(marker);
      walkChildren(element);
      ensureNewlines(1);
      return;
    }

    if (isBlock) {
      ensureNewlines(separator);
    }

    walkChildren(element);

    if (isBlock) {
      ensureNewlines(separator);
    }
  };

  walkChildren(document.body);
  return { text: normalizeLineBreaks(chunks.join('')), truncated, stopped };
}
