import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { htmlToPlainText, htmlToPlainTextBounded } from '@/lib/html-to-text';
import {
  CUT_MARK,
  findVerificationCode,
  markCut,
  MAX_BODY_CHARS,
  MAX_PREVIEW_CHARS,
  MAX_SUBJECT_CHARS,
  verificationCodeBodyText,
} from '@/lib/verification-code';

// Hostile mail must not cost more than its length: every shape below takes at
// most about 8x the time for 4x the input, and stays far under the bound.
// webmail-gateway's port of the detector has the same tests.

/** The fastest of five runs, in ms (the least disturbed by other load on the host). */
function timeMs(f: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    f();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** The fastest of seven runs at 5,000 and at 20,000 characters, taken in turn so both see the same load. */
function scaling(shape: (n: number) => () => unknown): { small: number; large: number } {
  const [runSmall, runLarge] = [shape(5_000), shape(20_000)];
  let small = Infinity;
  let large = Infinity;
  for (let i = 0; i < 7; i++) {
    let t0 = performance.now();
    runSmall();
    small = Math.min(small, performance.now() - t0);
    t0 = performance.now();
    runLarge();
    large = Math.min(large, performance.now() - t0);
  }
  return { small, large };
}

const part = (partId: string, type: string) => ({ partId, blobId: `blob-${partId}`, size: 1, type });
const htmlMail = (value: string) => ({
  htmlBody: [part('1', 'text/html')],
  textBody: [part('1', 'text/html')],
  bodyValues: { 1: { value, isEncodingProblem: false, isTruncated: false } },
});

describe('hostile mail stays cheap (linear, capped)', () => {
  const shapes: [string, (n: number) => () => unknown][] = [
    ['one long word under a code subject', (n) => () => findVerificationCode('Your verification code', 'x'.repeat(n))],
    ['one long word as the subject', (n) => () => findVerificationCode('x'.repeat(n / 20), '')],
    ['a long word ending in @', (n) => () => findVerificationCode('code', `${'x'.repeat(n)}@`)],
    ['dense code candidates', (n) => () => findVerificationCode('', 'code 1234 '.repeat(n / 10))],
    ['digits glued into one long word', (n) => () => findVerificationCode('Your code', 'a1234'.repeat(n / 5))],
    ['one long code word', (n) => () => findVerificationCode('', `${'code'.repeat(n / 4)} 123456`)],
    ['hyphenated groups', (n) => () => findVerificationCode('code', 'ab-'.repeat(n / 3))],
    ['dots before a long run of spaces', (n) => () => findVerificationCode('code', `${'.'.repeat(n / 2)}${' '.repeat(n / 2)}x`)],
    ['unclosed style elements in the body', (n) => () => verificationCodeBodyText(htmlMail('<style>'.repeat(n / 7)))],
    ['unclosed title elements in the body', (n) => () => verificationCodeBodyText(htmlMail('<title>x'.repeat(n / 8)))],
    ['style openings without a closing angle bracket', (n) => () => verificationCodeBodyText(htmlMail(`${'<style '.repeat(n / 7)}>x`))],
    ['line breaks followed by empty blocks', (n) => () => verificationCodeBodyText(htmlMail(`x${'<br>'.repeat(n / 15)}${'<div></div>'.repeat(n / 15)}`))],
  ];

  it.each(shapes)('%s: well under the bound, and 4x the input takes at most about 8x the time', (_, shape) => {
    const { small, large } = scaling(shape);
    expect(large).toBeLessThan(250);
    expect(large).toBeLessThan(8 * small + 10);
  });

  it('a 40,000-character word, 20,000 characters of "code 1234 " and huge inputs finish quickly', () => {
    expect(timeMs(() => findVerificationCode('Your verification code', 'x'.repeat(40_000)))).toBeLessThan(250);
    expect(timeMs(() => findVerificationCode('', 'code 1234 '.repeat(2_000)))).toBeLessThan(250);
    expect(timeMs(() => findVerificationCode('x'.repeat(1_000_000), 'y'.repeat(1_000_000), 'preview'))).toBeLessThan(250);
  });

  it('reads the subject, a preview and a body only up to their caps, never half a code', () => {
    expect([MAX_SUBJECT_CHARS, MAX_PREVIEW_CHARS, MAX_BODY_CHARS]).toEqual([1_000, 1_000, 20_000]);
    const pad = (n: number) => 'Lorem ipsum '.repeat(Math.ceil(n / 12)).slice(0, n);
    expect(findVerificationCode(`${pad(900)} Your code is 482913`, '')).toBe('482913');
    expect(findVerificationCode(`${pad(1_000)} Your code is 482913`, '')).toBeNull();
    expect(findVerificationCode('', `${pad(900)} Your code is 482913`, 'preview')).toBe('482913');
    expect(findVerificationCode('', `${pad(1_000)} Your code is 482913`, 'preview')).toBeNull();
    expect(findVerificationCode('', `${pad(19_000)} Your code is 482913`)).toBe('482913');
    expect(findVerificationCode('', `${pad(20_000)} Your code is 482913`)).toBeNull();
    // Near the cut, nothing is offered: never "4829" for 482913 cut after its fourth digit.
    const ending = (n: number) => `${pad(MAX_BODY_CHARS - n - 9)} code is `;
    expect(findVerificationCode('', `${ending(120)}482913 ${pad(200)}`)).toBe('482913');
    expect(findVerificationCode('', `${ending(40)}482913 ${pad(200)}`)).toBeNull();
    expect(findVerificationCode('', `${ending(4)}482913 and more`)).toBeNull();
  });

  it('still removes closed style, script and title elements from the body', () => {
    const text = verificationCodeBodyText(
      htmlMail('<html><head><title>T</title><STYLE type="x">.a{width:600px}</style ></head><body><script>x()</script><style><p>Code: 261765</p>'),
    );
    expect(text).not.toContain('600px');
    expect(text).not.toContain('x()');
    expect(findVerificationCode('Verification code', text)).toBe('261765');
  });

  // The shape of review bulwark-n1 R1: each empty block used to recount every
  // trailing line break (quadratic: seconds at 12,000). Most of what is left
  // here is jsdom's own parse, so the bound is generous and the test long.
  it('line breaks followed by empty blocks near the HTML cap convert in linear time', () => {
    const shape = (n: number) => `x${'<br>'.repeat(n)}${'<div></div>'.repeat(n)}`;
    expect(shape(12_000).length).toBe(180_001); // under the 200,000-character HTML cap
    const [small, large] = [htmlMail(shape(3_000)), htmlMail(shape(12_000))];
    let tSmall = Infinity;
    let tLarge = Infinity;
    for (let i = 0; i < 3; i++) {
      let t0 = performance.now();
      verificationCodeBodyText(small);
      tSmall = Math.min(tSmall, performance.now() - t0);
      t0 = performance.now();
      verificationCodeBodyText(large);
      tLarge = Math.min(tLarge, performance.now() - t0);
    }
    expect(tLarge).toBeLessThan(5_000);
    expect(tLarge).toBeLessThan(8 * tSmall + 200);
    // The same conversion as before, without the recounts.
    expect(htmlToPlainText('a<br><br><br><div></div>b<p>c</p><div><div></div></div>d')).toBe('a\n\nb\nc\nd');
  }, 60_000);

  it('a spaced or grouped code cut at a cap never comes back as its first group (subject, preview, body)', () => {
    const at = (max: number, lead: string) => `${' '.repeat(max - lead.length)}${lead}`;
    for (const lead of ['Your code is 1234 ', 'Your code is 1234-', 'Your code is 1 2 3 4 ']) {
      expect(findVerificationCode(`${at(MAX_SUBJECT_CHARS, lead)}5678`, '')).toBeNull();
      expect(findVerificationCode('', `${at(MAX_PREVIEW_CHARS, lead)}5678`, 'preview')).toBeNull();
      expect(findVerificationCode('', `${at(MAX_BODY_CHARS, lead)}5678`)).toBeNull();
    }
    expect(findVerificationCode('', 'Your code is 1234 5678', 'preview')).toBe('12345678');
    // The guard counts from where the cut was: a code far before a long cut word still counts.
    expect(findVerificationCode('', markCut(`Your code is 482913 ${'x'.repeat(5_000)}`, true))).toBe('482913');
    expect(findVerificationCode('', `Your code is 482913 ${'x'.repeat(30_000)}`)).toBe('482913');
    expect(findVerificationCode('', markCut('Your code is 1234 5678', true))).toBeNull();
    expect(findVerificationCode('', markCut('Your code is 1234 5678', false))).toBe('12345678');
  });

  it('keeps the cut through HTML extraction: a large removed <style> before the cut leaves a short text that is still cut', () => {
    const tail = '</style>Your code is 1234';
    const html = `<style>${'x'.repeat(200_000 - '<style>'.length - tail.length)}${tail}56`;
    const text = verificationCodeBodyText(htmlMail(html));
    expect(text.endsWith(CUT_MARK)).toBe(true);
    expect(findVerificationCode('', text)).toBeNull();
    // A body value the server cut is cut too; a code well before the cut is still found.
    const plain = (value: string) => ({
      htmlBody: [part('1', 'text/plain')],
      textBody: [part('1', 'text/plain')],
      bodyValues: { 1: { value, isEncodingProblem: false, isTruncated: true } },
    });
    expect(findVerificationCode('', verificationCodeBodyText(plain('Your code is 1234')))).toBeNull();
    expect(findVerificationCode('', verificationCodeBodyText(plain(`Your code is 482913. ${'Lorem ipsum '.repeat(20)}`)))).toBe('482913');
  });

  it('a multipart mail with distinct parts: no parse the detector triggers sees more than the HTML budget', () => {
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
    try {
      const mail = {
        htmlBody: [part('h', 'text/html')],
        textBody: [part('t', 'text/plain')],
        bodyValues: {
          h: { value: `<b>Your code is 482913</b>${'x'.repeat(400_000)}`, isEncodingProblem: false, isTruncated: false },
          t: { value: 'Your code is 482913', isEncodingProblem: false, isTruncated: false },
        },
      };
      const text = verificationCodeBodyText(mail);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(Math.max(...spy.mock.calls.map((c) => String(c[0]).length))).toBeLessThanOrEqual(200_000);
      expect(findVerificationCode('Sign in', text)).toBe('482913');
    } finally {
      spy.mockRestore();
    }
  });

  // jsdom's own DOMParser takes time quadratic in the nesting depth (4,000 levels: several
  // seconds in the parse alone); browsers cap the depth of the tree they build.
  it('deeply nested HTML does not throw', () => {
    const nested = verificationCodeBodyText(htmlMail(`${'<div>'.repeat(1_000)}Your code is 482913${'</div>'.repeat(1_000)}`));
    expect(findVerificationCode('', nested)).toBe('482913');
  }, 30_000);

  it('the bounded conversion stops once it has enough text, and says so', () => {
    const html = `${'<p>Lorem ipsum dolor sit amet</p>'.repeat(2_000)}<p>Your code is 482913</p>`;
    const bounded = htmlToPlainTextBounded(html, 1_000);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.length).toBeLessThan(1_100);
    expect(bounded.text).not.toContain('482913');
    const whole = htmlToPlainTextBounded(html, Infinity);
    expect(whole.truncated).toBe(false);
    expect(whole.text).toBe(htmlToPlainText(html));
  });
});
