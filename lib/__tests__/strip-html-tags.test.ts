// Fork (Wnt/webmail): lib/strip-html-tags.ts gives the old regex pipeline's
// result and takes time linear in the body. All inputs are synthetic.

import { describe, expect, it } from 'vitest';
import { isHtmlBodyEffectivelyEmpty, stripHtmlTags } from '@/lib/strip-html-tags';
import { emailToReadView } from '@/lib/plugin-projection';
import type { Email } from '@/lib/jmap/types';

// The former pipeline, kept here as the reference on small inputs.
const oldStrip = (html: string, replacement: string) =>
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, replacement).replace(/<[^>]+>/g, replacement);

const BUDGET_MS = 1000;
function timed<T>(fn: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
}

describe('stripHtmlTags', () => {
  it('removes script and style content and replaces tags', () => {
    expect(stripHtmlTags('<p>Hi <b>there</b></p><style>p{x:1}</style><SCRIPT>a<b</script>!', ' ')).toBe(' Hi  there    !');
    expect(stripHtmlTags('<div>x</div><style>p{}</style>', '', ['style'])).toBe('x');
  });

  it('keeps a `<` that starts no tag, and an unclosed raw-text element\'s content', () => {
    // As before: a tag runs from `<` to the next `>`, whatever is between.
    expect(stripHtmlTags('1 < 2 and <> 3', ' ')).toBe('1   3');
    expect(stripHtmlTags('<> 1 < 2', ' ')).toBe('<> 1 < 2');
    expect(stripHtmlTags('a <b> c < d', ' ')).toBe('a   c < d');
    expect(stripHtmlTags('<style>p{} no end', ' ')).toBe(' p{} no end');
  });

  it('gives the old pipeline\'s result on random markup', () => {
    const tokens = ['<', '>', 'a', ' ', '/', 'style', 'script', '</style>', '</SCRIPT>', '<style>', '<Script ', '<b>', '&nbsp;', '\n', 'x>'];
    let seed = 20261020;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 5000; i++) {
      let s = '';
      for (let j = rnd(40); j > 0; j--) s += tokens[rnd(tokens.length)];
      expect(stripHtmlTags(s, ' '), JSON.stringify(s)).toBe(oldStrip(s, ' '));
    }
  });

  it('answers long unclosed tags and raw-text openers in milliseconds', () => {
    for (const html of ['<a'.repeat(32_000), '<style>'.repeat(32_000), '<script '.repeat(28_000), `x${'<'.repeat(200_000)}>`]) {
      const plain = timed(() => stripHtmlTags(html, ' '));
      expect(plain.ms, html.slice(0, 12)).toBeLessThan(BUDGET_MS);
      const empty = timed(() => isHtmlBodyEffectivelyEmpty(html));
      expect(empty.ms, html.slice(0, 12)).toBeLessThan(BUDGET_MS);
    }
  });
});

describe('isHtmlBodyEffectivelyEmpty', () => {
  it('sees Word boilerplate as empty and real text as not', () => {
    expect(isHtmlBodyEffectivelyEmpty('<html><head><style>p.MsoNormal{margin:0}</style></head><body><p class=MsoNormal>&nbsp;</p><p>&#160;</p></body></html>')).toBe(true);
    expect(isHtmlBodyEffectivelyEmpty('<div><br></div>')).toBe(true);
    expect(isHtmlBodyEffectivelyEmpty('<p>Hei</p>')).toBe(false);
    expect(isHtmlBodyEffectivelyEmpty('1 < 2')).toBe(false);
  });
});

describe('emailToReadView (plugin projection) on an HTML-only body', () => {
  const email = (html: string): Email => ({
    id: 'm1', threadId: 't1', mailboxIds: { inbox: true }, keywords: {}, subject: 'Synthetic',
    from: [{ name: 'Examplepaja', email: 'info@examplepaja.test' }], to: [], cc: [], receivedAt: '2026-01-01T00:00:00Z',
    hasAttachment: false, preview: '', size: html.length,
    // An empty text/plain alternative: the projection falls back to the HTML.
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '2', type: 'text/html' }],
    bodyValues: { '1': { value: '  ', isTruncated: false }, '2': { value: html, isTruncated: false } },
  } as unknown as Email);

  it('reads the HTML as text', () => {
    expect(emailToReadView(email('<p>Hello&nbsp;<b>there</b> &amp; you</p><style>p{}</style>')).text).toBe('Hello there & you');
  });

  it('answers a long run of unclosed tags in milliseconds', () => {
    const { ms } = timed(() => emailToReadView(email('<a'.repeat(32_000))));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
