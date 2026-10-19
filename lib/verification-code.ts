import type { Email } from '@/lib/jmap/types';
import { getRenderableHtmlBodyBounded } from '@/lib/email-body-selection';
import { htmlToPlainTextBounded } from '@/lib/html-to-text';

/**
 * Finds the one-time code in a sign-in or confirmation mail ("Your
 * verification code is 177945", "HUK6QR ist Ihr Bestätigungscode"), so the
 * list and the reader can offer it for copying.
 *
 * A token only counts when it looks like a code and sits near a word that
 * names one (code, Bestätigungscode, Passcode, PIN, OTP, ...). Mail is full
 * of numbers — dates, prices, postcodes, order and phone numbers — and a
 * wrong chip is worse than none, so anything doubtful is left out.
 */

// A code this far after its keyword ("Der Bestätigungscode ist unten
// aufgeführt. Bitte geben Sie ihn ... ein. 37CCHC") still counts, one this far
// before it ("548980 ist Ihr Bestätigungscode") too.
const MAX_AFTER = 120;
const MAX_BEFORE = 60;

// Words that end in a code keyword but name something else: "Gutscheincode",
// "Postcode", "Barcode", and the word before a bare "code" ("promo code",
// "Claude Code", "VS Code").
const NOT_A_CODE_PREFIXES = new Set([
  'en', 'de', 'uni', 'x', 'vs', 'op', 'byte', 'bar', 'post', 'zip', 'qr', 'geo', 'short', 'pseudo',
  'hash', 'leet', 'trans', 're', 'source', 'quell', 'programm', 'program', 'status', 'error',
  'fehler', 'dress', 'color', 'colour', 'farb', 'html', 'css', 'embed', 'tracking', 'sendungs',
  'referral', 'empfehlungs', 'sort', 'swift', 'tax', 'ean', 'produkt', 'product', 'artikel',
  'promo', 'coupon', 'discount', 'voucher', 'gift', 'gutschein', 'rabatt', 'aktions', 'geschenk',
  'bonus', 'vorteils', 'area', 'country', 'länder', 'laender', 'landes', 'claude', 'studio',
]);

// Word endings that name a code, across the languages the app ships.
// "bestätigungscode", "verificatiecode", "engangskode", "vahvistuskoodi(si)",
// "verifieringskod", "ellenőrzőkód", "код", ...
const CODE_WORD_ENDINGS = [
  'code', 'codes', 'codice', 'codici', 'código', 'códigos', 'codigo', 'codigos', 'cod', 'kod',
  'kodu', 'kodem', 'kodunuz', 'kód', 'kódot', 'kódu', 'kode', 'koden', 'koodi', 'koodia', 'koodisi', 'koodiasi', 'koodinne', 'koodianne', 'kood',
  'kods', 'kodas', 'код', 'кода', 'коду', 'кодом', 'κωδικός', 'κωδικό', 'קוד', 'رمز', 'کد',
];

const CODE_WORDS_EXACT = new Set(['passcode', 'einmalkennwort', 'einmalpasswort']);

// Only ever written in capitals when they mean a code; "pin" and "tan" are
// ordinary words too.
const UPPERCASE_CODE_WORDS = /^(?:PIN|OTP|(?:m|sms|push|chip|photo|i|e)?TAN)$/;

// Scripts without spaces between words, matched as substrings.
const CJK_CODE_WORDS = /コード|認証番号|確認番号|验证码|驗證碼|校验码|动态码|인증\s?번호|인증\s?코드|코드/g;

const ONE_TIME_PASSWORD = /\b(?:one[- ]time|single[- ]use|temporary) pass(?:word|code)\b/gi;

const WORD = /[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu;

// "with code 250 (2.1.5)" in a delivery report: a code word followed by a
// number too short to be a one-time code names a status or error code.
const LABELS_SHORT_NUMBER = /^\s*[:=]?\s*\d{1,3}(?![\p{L}\p{N}]|[.,]\d|[ -]\d)/u;

function isCodeWordPart(part: string, previous: string | undefined): boolean {
  if (UPPERCASE_CODE_WORDS.test(part)) return true;
  const lower = part.toLowerCase();
  if (CODE_WORDS_EXACT.has(lower)) return true;
  for (const ending of CODE_WORD_ENDINGS) {
    if (!lower.endsWith(ending)) continue;
    const prefix = lower.slice(0, lower.length - ending.length);
    // A bare "code" takes its meaning from the word before it.
    const qualifier = prefix || previous?.toLowerCase();
    return !qualifier || !NOT_A_CODE_PREFIXES.has(qualifier);
  }
  return false;
}

interface Span { start: number; end: number }

/** The code words of `text`, as three lists (words, CJK words, "one-time
 *  password" phrases). Within a list the spans are disjoint and in order, so
 *  a candidate looks up only the ones near it (`nearbyKeywords`). */
function findCodeWords(text: string): Span[][] {
  const words: Span[] = [];
  let previousWord: string | undefined;
  for (const match of text.matchAll(WORD)) {
    const start = match.index!;
    const end = start + match[0].length;
    const parts = match[0].split('-');
    const hit = parts.some((part, i) => isCodeWordPart(part, i > 0 ? parts[i - 1] : previousWord));
    const next = text.slice(end, end + 12);
    // "Code of Conduct", "code of practice"
    if (hit && !/^\s+of\s/i.test(next) && !LABELS_SHORT_NUMBER.test(next)) words.push({ start, end });
    previousWord = parts[parts.length - 1];
  }
  const lists = [words];
  for (const re of [CJK_CODE_WORDS, ONE_TIME_PASSWORD]) {
    lists.push([...text.matchAll(re)].map((match) => ({ start: match.index!, end: match.index! + match[0].length })));
  }
  return lists;
}

/** The keywords of one list that can matter for a candidate at start..end:
 *  those ending at most MAX_AFTER before it or starting at most MAX_BEFORE
 *  after it (or overlapping it). Found by binary search, so the scoring is
 *  linear in the text, not candidates times keywords. */
function* nearbyKeywords(list: Span[], start: number, end: number): Generator<Span> {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.end < start - MAX_AFTER) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < list.length && list[i]!.start <= end + MAX_BEFORE; i++) yield list[i]!;
}

// Tried in this order at each position, so "557 260" and "6ZA-BRE" are taken
// whole before their pieces are.
const CANDIDATE = new RegExp(
  [
    // 6ZA-BRE, NJF63-SW7S7, and 2025-12-12 (dropped later)
    String.raw`(?<![\p{L}\p{N}])[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8}){1,3}(?![\p{L}\p{N}])`,
    // 557 260, 123-456
    String.raw`(?<!\d)\d{3,4}[ -]\d{3,4}(?!\d)`,
    // 3 0 4 6 2 7
    String.raw`(?<![\p{L}\p{N}])\d(?: \d){3,9}(?![\p{L}\p{N}])`,
    // 37CCHC, 5aem5f5z, 177945
    String.raw`(?<![\p{L}\p{N}])[A-Za-z0-9]{4,10}(?![\p{L}\p{N}])`,
  ].join('|'),
  'gu',
);

// Digits run into the words around them, which the pass above takes as one
// token: "ein:86771674Teile", "Claude.ai177945Copy", "732888Gib".
const GLUED_DIGITS = /(?<=\p{L})\d{4,10}(?!\d)|(?<!\d)\d{4,10}(?=\p{L})/gu;

const ALNUM = /[\p{L}\p{N}]/u;
// Glued digits are part of a word; a run longer than this either way is an
// id or a hash, not a word (and the walk stays bounded).
const MAX_GLUED_WALK = 64;

/** Whether the digits at start..end have only letters around them, as in
 *  "ai177945Copy", and are not one group of an id like "4887a30a5a2si2098"
 *  or "PAXPR03MB8065". */
function gluedToWords(text: string, start: number, end: number): boolean {
  let from = start;
  let to = end;
  while (from > 0 && ALNUM.test(text.charAt(from - 1))) {
    if (start - from >= MAX_GLUED_WALK) return false;
    from--;
  }
  while (to < text.length && ALNUM.test(text.charAt(to))) {
    if (to - end >= MAX_GLUED_WALK) return false;
    to++;
  }
  return /^\p{L}*\d+\p{L}*$/u.test(text.slice(from, to));
}

const YEAR = /^(?:19|20)\d\d$/;
// 10min, 600px, 100GB
const NUMBER_WITH_UNIT = /^\d+[a-z]{1,3}$/i;
// THANKS10, HERBST25, FALL2026
const PROMO_CODE = /^[A-Z]{4,}\d{1,4}$/;
const PROMO_WORDS = /%|(?<!\p{L})(?:off|rabatt|spar\p{L}*|save|discount|coupon|gutschein\p{L}*|voucher|sale|angebot\p{L}*)(?!\p{L})/iu;
// A number labelled as something else: "Kundennummer: 5512345", "Meeting-ID:
// 845 1234 5678", "at line 1042", "card ending in 4821". Nouns that also
// label codes ("Code für dein Konto: 123456") count only without a colon.
const LABELLED_AS_OTHER = new RegExp(
  String.raw`(?:(?:\p{L}*(?:nummer|number)|(?<!\p{L})(?:nr|no|id|line|zeile|version|tel|telefon|phone|fax|mobil|plz))\.?:?` +
  String.raw`|(?<!\p{L})(?:order|bestellung|account|konto|invoice|rechnung|ticket|case|page|seite|room|zimmer|commit|issue|pr|build|run|job|step|port)` +
  String.raw`|ending in|endet auf|endend auf|ends with)[ #]*$`,
  'iu',
);
const LOWERCASE_HEX = /^[0-9a-f-]+$/;
// "The code is: 123456", "Ihr Code lautet 123456"
const LINKED_BY = /(?::|=|(?<!\p{L})(?:is|lautet|ist|est|es|è|é|är|er|jest|je))\s*$/iu;

const LETTER = /\p{L}/u;

/** Text around a candidate, not starting or ending inside a word, so that
 *  "off" cut from "offiziellen" does not read as a word of its own. */
function contextWindow(text: string, from: number, to: number): string {
  let start = Math.max(0, from);
  let end = Math.min(text.length, to);
  while (start > 0 && start < end && LETTER.test(text.charAt(start - 1)) && LETTER.test(text.charAt(start))) start++;
  while (end < text.length && end > start && LETTER.test(text.charAt(end)) && LETTER.test(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

interface Candidate extends Span { code: string; score: number }

function scoreCandidate(text: string, raw: string, start: number, keywords: Span[][]): Candidate | null {
  const end = start + raw.length;
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const digits = raw.replace(/\D/g, '');
  const before = contextWindow(text, start - 40, start);
  const after = text.slice(end, end + 8);

  if (!digits) return null;
  if (letters && letters !== letters.toUpperCase() && letters !== letters.toLowerCase()) return null;

  let code = raw;
  if (!letters) {
    // Grouped digits are typed without the gaps: "557 260" is 557260.
    code = digits;
    if (raw.includes('-') && !/^\d{3,4}-\d{3,4}$/.test(raw)) return null; // dates, phone numbers
    if (digits.length < 4 || digits.length > 10) return null;
    // Part of a date, time, decimal or longer number: 12.12.2025, 10:49:27, 1.299,00
    if (/\d[.,:/-]$/.test(before) || /^[.,:/-]\d/.test(after)) return null;
    // Issue and ticket numbers, phone numbers, the next group of an IBAN
    if (/[#+]$/.test(before) || /(?:\d|\))[ /-]?$/.test(before) || /^[ /-]?\d/.test(after)) return null;
    // Amounts
    if (/[€$£]\s?$/.test(before) || /^\s?(?:[€$£%]|eur\b|usd\b|chf\b)/i.test(after)) return null;
  } else if (NUMBER_WITH_UNIT.test(raw) || PROMO_CODE.test(raw)) {
    return null;
  }
  if (LABELLED_AS_OTHER.test(before)) return null;
  if (PROMO_WORDS.test(contextWindow(text, start - 60, end + 40))) return null;

  let best = Infinity;
  let bestAfter = Infinity;
  for (const list of keywords) {
    for (const kw of nearbyKeywords(list, start, end)) {
      if (kw.start < end && kw.end > start) return null; // the candidate is part of a keyword ("2FA-Code")
      if (kw.end <= start && start - kw.end <= MAX_AFTER) {
        bestAfter = Math.min(bestAfter, start - kw.end);
        best = Math.min(best, start - kw.end);
      }
      if (kw.start >= end && kw.start - end <= MAX_BEFORE) best = Math.min(best, (kw.start - end) * 1.5);
    }
  }
  if (best === Infinity) return null;

  // Lowercase letters also make up words, hashes and ids, so they have to
  // follow their keyword closely ("confirmation code is 5aem5f5z"), and a
  // lowercase hex string (a commit, a colour, a token) only counts when the
  // keyword labels it directly ("den Code e382e507-1593-47f8").
  if (letters && letters === letters.toLowerCase()) {
    if (bestAfter > 40) return null;
    if (LOWERCASE_HEX.test(raw) && bestAfter > 2) return null;
  }

  const linked = LINKED_BY.test(before);
  const ownLine = /(?:^|\n)\s*$/.test(before) && /^\s*(?:\n|$)/.test(after);
  // "KI Palooza 2026": a year is only the code when it is presented as one.
  if (!letters && YEAR.test(digits) && !linked && !ownLine) return null;

  let score = best;
  if (linked) score -= 15;
  if (ownLine) score -= 15;
  return { start, end, code, score };
}

const WORD_CHAR_OR_HYPHEN = /^[\p{L}\p{N}-]$/u;
const SPACE = /\s/;

/** Without a trailing "..." or "…" and the word right before it (by hand:
 *  an unanchored regex would rescan a long word from every position). */
function withoutCutWord(text: string): string {
  let end = text.length;
  while (end > 0 && SPACE.test(text.charAt(end - 1))) end--;
  let start: number;
  if (text.endsWith('...', end)) start = end - 3;
  else if (text.endsWith('…', end)) start = end - 1;
  else return text;
  while (start > 0) {
    const low = text.charCodeAt(start - 1);
    const pair = low >= 0xdc00 && low <= 0xdfff && start >= 2 && text.charCodeAt(start - 2) >= 0xd800 && text.charCodeAt(start - 2) <= 0xdbff;
    const size = pair ? 2 : 1;
    if (!WORD_CHAR_OR_HYPHEN.test(text.slice(start - size, start))) break;
    start -= size;
  }
  return text.slice(0, start);
}

// A preview is cut off with "...", and the word it cut may be half a code.
function normalize(text: string): string {
  return withoutCutWord(flatten(text)).trim();
}

function flatten(text: string): string {
  return text
    // Invisible spacers senders put between characters
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]|\u034f/g, '')
    // Links and addresses carry ids and tokens, never the code to type
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    // (each whitespace-delimited token once: what /\S*@\S+/ removed, without its rescans)
    .replace(/\S+/g, (token) => (/@\S/.test(token) ? ' ' : token))
    // Keep line breaks (a code often stands on a line of its own) but not
    // the runs of blank lines and indentation between table cells.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n[\s]*/g, '\n');
}

// A text that was cut (at a cap here, or by whoever produced it) may have
// been cut through a code, or through the text after it that decides whether
// it is one. So no candidate ending within CUT_GUARD characters of the cut is
// offered: 80 is above the longest candidate span (35, four hyphenated groups
// of 8, "AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD"; spaced digits span at most 19,
// "1 2 3 4 5 6 7 8 9 0") plus the most text a candidate is judged by after
// it (64 for the glued-digit walk; 40 for promotion words, 8 for a next
// group of digits). A code never comes back as a fragment of itself.
const CUT_GUARD = 80;

/**
 * The text a cut input is read as, and the last end a candidate may have:
 * CUT_GUARD before the cut point (measured where the cut was, not where the
 * dropped half word began, so a code far from a long cut word still counts).
 * The text then ends with " …", so nothing reads the cut as the end of a
 * line.
 */
function readCut(rawText: string): { text: string; lastEnd: number } {
  const flat = flatten(rawText);
  const kept = withoutCutWord(flat);
  const lead = kept.length - kept.trimStart().length;
  const text = kept.trim();
  return { text: text ? `${text} …` : '', lastEnd: flat.length - lead - CUT_GUARD };
}

function bestCandidate(rawText: string, cut = false): Candidate | null {
  const { text, lastEnd } = cut ? readCut(rawText) : { text: normalize(rawText), lastEnd: Infinity };
  if (!text) return null;
  const keywords = findCodeWords(text);
  if (!keywords.some((list) => list.length)) return null;

  let best: Candidate | null = null;
  for (const re of [CANDIDATE, GLUED_DIGITS]) {
    for (const match of text.matchAll(re)) {
      if (match.index! + match[0].length > lastEnd) continue;
      if (re === GLUED_DIGITS && !gluedToWords(text, match.index!, match.index! + match[0].length)) continue;
      const candidate = scoreCandidate(text, match[0], match.index!, keywords);
      if (candidate && (!best || candidate.score < best.score)) best = candidate;
    }
  }
  return best;
}

// A code sits near the top: longer input is cut, which also bounds the work
// on hostile mail. A cut text loses the word the cut went through (as a
// preview cut off with "..." does) and the CUT_GUARD tail.
export const MAX_SUBJECT_CHARS = 1_000;
export const MAX_PREVIEW_CHARS = 1_000;
export const MAX_BODY_CHARS = 20_000;

/**
 * The end of a text that was cut before it reached the detector (a body
 * reader's cap, a server's truncated body value): `findVerificationCode`
 * treats such a text as cut. U+FFFF is a noncharacter, never part of mail.
 */
export const CUT_MARK = '\u2026\uffff';

/** `text` marked as cut when `cut`. */
export function markCut(text: string, cut: boolean): string {
  return cut ? text + CUT_MARK : text;
}

// A preview may have been cut by the server that made it, with no mark at
// all: JMAP's preview is "up to 256 characters", and legacy-proxy cuts there
// and trims (so a cut one is at most a few characters shorter). A preview this
// long is read as possibly cut; a shorter one is complete.
const PREVIEW_MAY_BE_CUT = 200;

/** Whether `text` ends with "..." or "…" (and whitespace): cut, by its own say. */
function endsWithEllipsis(text: string): boolean {
  let end = text.length;
  while (end > 0 && SPACE.test(text.charAt(end - 1))) end--;
  return text.endsWith('...', end) || text.endsWith('…', end);
}

function capped(text: string | null | undefined, max: number, mayBeCut = false): { text: string; cut: boolean } {
  let t = text ?? '';
  let cut = mayBeCut;
  if (t.endsWith(CUT_MARK)) {
    t = t.slice(0, -CUT_MARK.length);
    cut = true;
  }
  if (t.length > max) {
    t = t.slice(0, max);
    cut = true;
  }
  if (endsWithEllipsis(t)) return { text: t, cut: true };
  return { text: cut ? `${t}…` : t, cut };
}

function cappedCandidate(text: string | null | undefined, max: number, mayBeCut = false): Candidate | null {
  const c = capped(text, max, mayBeCut);
  return bestCandidate(c.text, c.cut);
}

/**
 * The one-time code in a mail, or null. `text` is the preview for a list
 * row (`source` 'preview') and the body for the reader. A code in the
 * subject wins, since senders that put it there ("Your code is 177945")
 * also tend to repeat it next to unrelated numbers in the body. Wherever a
 * text was, or may have been, cut (a cap, a CUT_MARK, a closing "..." or
 * "…", a preview of PREVIEW_MAY_BE_CUT characters or more), no code is
 * offered near the cut: the body then has to show it whole.
 */
export function findVerificationCode(
  subject: string | null | undefined,
  text: string | null | undefined,
  source: 'preview' | 'body' = 'body',
): string | null {
  return (
    cappedCandidate(subject, MAX_SUBJECT_CHARS)?.code ??
    cappedCandidate(
      text,
      source === 'preview' ? MAX_PREVIEW_CHARS : MAX_BODY_CHARS,
      source === 'preview' && (text ?? '').length >= PREVIEW_MAY_BE_CUT,
    )?.code ??
    null
  );
}

/** Only fresh codes are worth a chip in the list; they expire within minutes to a day. */
export const VERIFICATION_CODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isFreshForVerificationCode(receivedAt: string | undefined, now = Date.now()): boolean {
  if (!receivedAt) return false;
  const age = now - new Date(receivedAt).getTime();
  // A little slack for a server clock ahead of this one.
  return age >= -5 * 60 * 1000 && age <= VERIFICATION_CODE_MAX_AGE_MS;
}

/**
 * The code for a list row, from the subject and preview the list already
 * has; older mail is skipped without looking.
 */
export function listVerificationCode(
  email: Pick<Email, 'subject' | 'preview' | 'receivedAt'>,
  now = Date.now(),
): string | null {
  if (!isFreshForVerificationCode(email.receivedAt, now)) return null;
  return findVerificationCode(email.subject, email.preview, 'preview');
}

// A code sits near the top; a newsletter of megabytes need not be read whole.
const MAX_BODY_HTML = 200_000;

const RAW_ELEMENT_START = /<(style|script|title)\b/gi;

/**
 * `html` without its <style>, <script> and <title> elements (each up to its
 * closing tag), in one pass: every opening tag is read up to the first `>`
 * after it, and each search for a closing tag either moves the scan past it
 * or is remembered as having found none, so unclosed elements by the
 * thousand cost no more than the markup's length.
 */
function withoutRawElements(html: string): string {
  let out = '';
  let from = 0;
  let gtFrom = -1;
  let gt = -1;
  const unclosed = new Set<string>();
  RAW_ELEMENT_START.lastIndex = 0;
  for (let m = RAW_ELEMENT_START.exec(html); m; m = RAW_ELEMENT_START.exec(html)) {
    const at = m.index + m[0].length;
    // The first '>' after the name: found once for every opening before it.
    if (gtFrom < 0 || gt < at) {
      gt = html.indexOf('>', at);
      gtFrom = at;
    }
    if (gt < 0) break;
    const name = (m[1] ?? '').toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`<\\/${name}\\s*>`, 'gi');
    close.lastIndex = gt + 1;
    const c = close.exec(html);
    if (!c) {
      unclosed.add(name);
      continue;
    }
    out += `${html.slice(from, m.index)} `;
    from = c.index + c[0].length;
    RAW_ELEMENT_START.lastIndex = from;
  }
  return out + html.slice(from);
}

/**
 * The text of a loaded mail as the reader shows it, for finding its code:
 * at most MAX_BODY_HTML characters of its HTML are selected, parsed and
 * converted (stopping once MAX_BODY_CHARS of text are out), or the top of
 * its text part. A text cut on the way (here, or by the server) ends with
 * CUT_MARK, so `findVerificationCode` knows it was cut even when the text
 * left is short (a large <style> before the cut). Never throws: a body that
 * cannot be read has no code.
 */
export function verificationCodeBodyText(email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues'>): string {
  try {
    const selected = getRenderableHtmlBodyBounded(email, MAX_BODY_HTML);
    if (selected) {
      // htmlToPlainText walks the body, and a <style> in it is text there.
      const markup = withoutRawElements(selected.html);
      const { text, truncated } = htmlToPlainTextBounded(markup, MAX_BODY_CHARS);
      return markCut(text.slice(0, MAX_BODY_CHARS), selected.cut || truncated || text.length > MAX_BODY_CHARS);
    }
    const textPart = email.textBody?.[0]?.partId;
    const bodyValue = textPart ? email.bodyValues?.[textPart] : undefined;
    const text = bodyValue?.value || '';
    return markCut(text.slice(0, MAX_BODY_CHARS), text.length > MAX_BODY_CHARS || bodyValue?.isTruncated === true);
  } catch {
    return '';
  }
}
