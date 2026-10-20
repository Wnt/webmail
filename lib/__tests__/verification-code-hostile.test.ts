import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { htmlToPlainText, htmlToPlainTextBounded } from '@/lib/html-to-text';
import {
  detectorWork,
  findVerificationCode,
  listVerificationCode,
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

/**
 * Nine rounds at 5,000 and at 20,000 characters, taken in turn so both see
 * the same load: the fastest large run, and whether any round was linear
 * (4x the input in at most 8x the time, plus 10 ms of timer and scheduling
 * noise). A quadratic shape fails every round; a busy host only some.
 */
function scaling(shape: (n: number) => () => unknown): { large: number; linear: boolean } {
  const [runSmall, runLarge] = [shape(5_000), shape(20_000)];
  let large = Infinity;
  let linear = false;
  for (let i = 0; i < 9; i++) {
    let t0 = performance.now();
    runSmall();
    const s = performance.now() - t0;
    t0 = performance.now();
    runLarge();
    const l = performance.now() - t0;
    large = Math.min(large, l);
    if (l < 8 * s + 10) linear = true;
  }
  return { large, linear };
}

const part = (partId: string, type: string) => ({ partId, blobId: `blob-${partId}`, size: 1, type });
const plainMail = (value: string) => ({
  htmlBody: [part('1', 'text/plain')],
  textBody: [part('1', 'text/plain')],
  bodyValues: { 1: { value, isEncodingProblem: false, isTruncated: false } },
});
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
    ['many closed hidden elements', (n) => () => verificationCodeBodyText(htmlMail('<div hidden>x</div>'.repeat(n / 19)))],
    ['a long inline style', (n) => () => verificationCodeBodyText(htmlMail(`<p style="${'a:b;'.repeat(n / 4)}">code 123456</p>`))],
    ['quoted lines', (n) => () => findVerificationCode('Your code', verificationCodeBodyText(plainMail('> code 1234\n'.repeat(n / 12))))],
    ['a long attribution-like line', (n) => () => findVerificationCode('Your code', verificationCodeBodyText(plainMail(`On ${'x'.repeat(n)} wrote:\ncode 123456`)))],
    ['long separator-like lines', (n) => () => verificationCodeBodyText(plainMail(`${'-'.repeat(n / 2)}\n${'_'.repeat(n / 2)}\ncode 123456`))],
  ];

  it.each(shapes)('%s: well under the bound, and 4x the input takes at most about 8x the time', (_, shape) => {
    const { large, linear } = scaling(shape);
    expect(large).toBeLessThan(250);
    expect(linear).toBe(true);
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
    expect(findVerificationCode('', `${pad(800)} Your code is 482913 ${pad(100)}`, 'preview')).toBe('482913');
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
    // Uncut, the whole code; a preview may always be cut at its end, so it gives one only with room after it.
    expect(findVerificationCode('', 'Your code is 1234 5678')).toBe('12345678');
    expect(findVerificationCode('', 'Your code is 1234 5678', 'preview')).toBeNull();
    expect(findVerificationCode('', 'Your code is 1234 5678. It expires in 10 minutes, so use it soon.', 'preview')).toBe('12345678');
    // The guard counts from where the cut was: a code far before a long cut word still counts.
    expect(findVerificationCode('', markCut(`Your code is 482913 ${'x'.repeat(5_000)}`, true))).toBe('482913');
    expect(findVerificationCode('', `Your code is 482913 ${'x'.repeat(30_000)}`)).toBe('482913');
    expect(findVerificationCode('', markCut('Your code is 1234 5678', true))).toBeNull();
    expect(findVerificationCode('', markCut('Your code is 1234 5678', false))).toBe('12345678');
  });

  it('HTML whose source was cut is not read: a large <style> before the cut, or tree repair moving the cut code (review bulwark-n1 R4)', () => {
    const tail = '</style>Your code is 1234';
    const html = `<style>${'x'.repeat(200_000 - '<style>'.length - tail.length)}${tail}56`;
    expect(verificationCodeBodyText(htmlMail(html))).toBe('');
    expect(findVerificationCode('', verificationCodeBodyText(htmlMail(html)))).toBeNull();
    // Foster parenting: a <div> inside a <table> moves before the table, so
    // the code cut at the end of the source lands near the start of the text.
    const fosterTail = `<table><tr><td>${'Ordinary words. '.repeat(20)}</td></tr><div>Your code is 1234`;
    const foster = `<style>${'x'.repeat(200_000 - 7 - 8 - fosterTail.length)}</style>${fosterTail}56</table>`;
    expect(foster.indexOf('56</table>')).toBe(200_000);
    expect(findVerificationCode('', verificationCodeBodyText(htmlMail(foster)))).toBeNull();
    // A separate, uncut plain-text part is read instead.
    const multipart = {
      htmlBody: [part('h', 'text/html')],
      textBody: [part('t', 'text/plain')],
      bodyValues: {
        h: { value: foster, isEncodingProblem: false, isTruncated: false },
        t: { value: 'Your code is 123456', isEncodingProblem: false, isTruncated: false },
      },
    };
    expect(findVerificationCode('', verificationCodeBodyText(multipart))).toBe('123456');
    // The server's truncated HTML value is cut too.
    const truncated = { ...htmlMail('<p>Your code is 123456</p>'), bodyValues: { 1: { value: '<p>Your code is 123456</p>', isEncodingProblem: false, isTruncated: true } } };
    expect(verificationCodeBodyText(truncated)).toBe('');
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

  it('a preview the server may have cut (JMAP: up to 256 characters, no mark) offers no code near its end; the reader still finds it', () => {
    const pad = (n: number) => 'Please sign in. '.repeat(Math.ceil(n / 16)).slice(0, n);
    const at256 = (lead: string, rest: string) => {
      const full = `${pad(256 - lead.length)}${lead}${rest}`;
      return { preview: full.slice(0, 256), full };
    };
    const inside = at256(' Your code is 1234', '56. Use it to sign in.');
    expect(inside.preview).toHaveLength(256);
    expect(findVerificationCode('Your verification code', inside.preview, 'preview')).toBeNull();
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(listVerificationCode({ subject: 'Your verification code', preview: inside.preview, receivedAt: '2026-10-19T11:59:00Z' }, now)).toBeNull();
    const reader = {
      htmlBody: [part('1', 'text/plain')],
      textBody: [part('1', 'text/plain')],
      bodyValues: { 1: { value: inside.full, isEncodingProblem: false, isTruncated: false } },
    };
    expect(findVerificationCode('Your verification code', verificationCodeBodyText(reader))).toBe('123456');
    // Cut after a group and the space trimmed, or inside a grouped or hyphenated code.
    expect(findVerificationCode('', at256(' Your code is 1234 ', '5678').preview.trimEnd(), 'preview')).toBeNull();
    expect(findVerificationCode('', at256(' Your code is 123 4', '56').preview, 'preview')).toBeNull();
    expect(findVerificationCode('', at256(' Your code is 1234-', '5678').preview, 'preview')).toBeNull();
    // An explicit "..." or "…" is a cut in any source, grouped codes included.
    for (const source of ['preview', 'body'] as const) {
      expect(findVerificationCode('', 'Your code is 1234 ...', source)).toBeNull();
      expect(findVerificationCode('', 'Your code is 1234 5678…', source)).toBeNull();
    }
    // Any preview may end where its server stopped reading (legacy-proxy reads 8,192 bytes, and whitespace
    // can collapse them to "Your code is 1234"; review bulwark-n1 r3): a preview gives a code only with 40
    // visible characters after it, however short it is.
    const collapsed = `${' '.repeat(8192 - 'Your code is 1234'.length)}Your code is 123456`.slice(0, 8192).trim();
    expect(collapsed).toBe('Your code is 1234');
    expect(listVerificationCode({ subject: '', preview: collapsed, receivedAt: '2026-10-19T11:59:00Z' }, now)).toBeNull();
    expect(findVerificationCode('', 'Your code is 482913. It expires in 10 minutes.', 'preview')).toBeNull();
    expect(findVerificationCode('', 'Your code is 482913. It expires in 10 minutes, so use it soon.', 'preview')).toBe('482913');
    expect(findVerificationCode('', `Your code is 482913. ${pad(230)}`, 'preview')).toBe('482913');
    expect(findVerificationCode('', `${pad(170)} Your code is 482913`, 'preview')).toBeNull();
  });

  it('the converter reads every element unless told otherwise; the reader leaves hidden and quoted ones out', () => {
    const html = '<p>Visible</p><div style="display:none">Hidden</div><blockquote>Quoted</blockquote><div class="gmail_quote">Earlier</div>';
    expect(htmlToPlainText(html)).toBe('Visible\nHidden\nQuoted\nEarlier');
    const read = htmlToPlainTextBounded(html, Infinity, {
      exclude: (el) => (el.classList.contains('gmail_quote') ? 'rest' : el.tagName === 'BLOCKQUOTE' || el.getAttribute('style') ? 'element' : null),
    });
    expect(read).toEqual({ text: 'Visible', truncated: false, stopped: true });
    expect(verificationCodeBodyText(htmlMail(html)).trim()).toBe('Visible');
  });

  it('dense candidates and code words: the keyword lookups grow linearly (counted, not timed; review bulwark-n1 R6)', () => {
    const steps = (n: number) => {
      detectorWork.keywordSteps = 0;
      findVerificationCode('', 'code 1234 '.repeat(n));
      return detectorWork.keywordSteps;
    };
    const [s100, s400, s2000] = [steps(100), steps(400), steps(2_000)];
    expect(s2000 / 2_000).toBeLessThan(60);
    expect(s2000 / s400).toBeLessThan(5 * 1.05);
    expect(s400 / s100).toBeLessThan(4 * 1.1);
  });

  it("a preview's ellipsis or an unmarked server cut never leaves a fragment (review bulwark-n1 R5)", () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    const row = (preview: string) => listVerificationCode({ subject: '', preview, receivedAt: '2026-10-19T11:59:00Z' }, now);
    expect(row('Your code is 1234 56...')).toBeNull();
    expect(row('Your code is 1234 ...')).toBeNull();
    expect(row('Your code is 1 2 3 4 5...')).toBeNull();
    expect(row('Your code is 1234 5678')).toBeNull();
    expect(row('Your code is 1234 5678. It expires in 10 minutes, so use it soon.')).toBe('12345678');
    // legacy-proxy's preview: the first 256 characters, no ellipsis, no flag.
    const body = `${'x'.repeat(238)} Your code is 12345678`;
    expect(row(body.slice(0, 256))).toBeNull();
    const reader = {
      htmlBody: [part('1', 'text/plain')],
      textBody: [part('1', 'text/plain')],
      bodyValues: { 1: { value: body, isEncodingProblem: false, isTruncated: false } },
    };
    expect(findVerificationCode('', verificationCodeBodyText(reader))).toBe('12345678');
  });

  it('a link reads its visible text only when the code reader asks; ordinary conversion is unchanged (review bulwark-n1 r3 R7)', () => {
    const link = '<a href="https://examplepaja.test/login"><span hidden>Your code is 123456</span>Continue</a>';
    expect(htmlToPlainText(link)).toBe('Your code is 123456Continue <https://examplepaja.test/login>');
    const read = htmlToPlainTextBounded(link, Infinity, { exclude: (el) => (el.hasAttribute('hidden') ? 'element' : null) });
    expect(read.text).toBe('Continue');
    expect(findVerificationCode('', verificationCodeBodyText(htmlMail(link)))).toBeNull();
    expect(findVerificationCode('', verificationCodeBodyText(htmlMail(`${link}<p>Your verification code is 654321.</p>`)))).toBe('654321');
  });

  it('a quote after the text cap does not make the cut text whole (the reader keeps the two cut causes apart)', () => {
    const html = `<p>${'Lorem ipsum '.repeat(1_700).slice(0, MAX_BODY_CHARS - 'Your code is 1234'.length)}Your code is 123456</p><div>On Monday, Alice Example wrote:</div><div>Earlier</div>`;
    expect(findVerificationCode('', verificationCodeBodyText(htmlMail(html)))).toBeNull();
    expect(findVerificationCode('', verificationCodeBodyText(htmlMail('<p>Your code is 123456</p><div>On Monday, Alice Example wrote:</div>')))).toBe('123456');
  });
});
