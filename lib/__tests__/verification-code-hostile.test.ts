import { describe, it, expect } from 'vitest';
import {
  findVerificationCode,
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
    const ending = (n: number) => `${pad(MAX_BODY_CHARS - n - 9)} code is `;
    expect(findVerificationCode('', `${ending(7)}482913 and more`)).toBe('482913');
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
});
