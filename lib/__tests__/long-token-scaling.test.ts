// Fork (Wnt/webmail): sender-controlled header and body text that the reading
// pane and the swipe panes parse on every open must take time linear in its
// length (upstream bulwarkmail/webmail 29cb6b7f). All inputs are synthetic.
// Each case is sized so that a quadratic parse would take seconds here.

import { describe, expect, it } from 'vitest';
import { readReceiptRequestAddress } from '@/lib/read-receipt-request';
import { parseUnsubscribeUrls } from '@/lib/validation';
import { buildEmailFrameSrcDoc } from '@/lib/email-frame-doc';

const BUDGET_MS = 1000;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
}

describe('read-receipt header parse on long tokens', () => {
  it('answers 64k characters of unclosed `<` in milliseconds', () => {
    const { result, ms } = timed(() => readReceiptRequestAddress({ 'Disposition-Notification-To': '<a'.repeat(32_000) }));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).not.toBeNull();
  });

  it('answers a megabyte header in milliseconds and still finds an early address', () => {
    const tail = '<a'.repeat(500_000);
    const { result, ms } = timed(() => readReceiptRequestAddress({ 'Disposition-Notification-To': `<r@example.test>${tail}` }));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toBe('r@example.test');
  });
});

describe('List-Unsubscribe parse on long tokens', () => {
  it('answers 64k characters of unclosed `<` in milliseconds', () => {
    const { result, ms } = timed(() => parseUnsubscribeUrls('<a'.repeat(32_000)));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual({});
  });

  it('still finds the URLs after a run of stray `<`', () => {
    const header = `${'<'.repeat(20_000)}https://example.test/u>, <mailto:u@example.test>`;
    const { result, ms } = timed(() => parseUnsubscribeUrls(header));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual({ http: 'https://example.test/u', mailto: 'mailto:u@example.test', preferred: 'http' });
  });
});

describe('reading-pane document (full-bleed check) on long tokens', () => {
  const build = (html: string, messageSpacing: 'auto' | 'always' | 'edge' = 'auto') =>
    buildEmailFrameSrcDoc(
      { html, isHtml: true, hasStyleTag: true, externalBlocked: true },
      { isDark: false, nativeDarkMode: false, messageSpacing },
    );

  it('answers a long width:100% style attribute in milliseconds', () => {
    const html = `<style>p{}</style><div style="${'width:100%;'.repeat(8_000)}">x</div>`;
    const { ms } = timed(() => build(html));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('answers padded attributes in milliseconds', () => {
    const html = `<style>p{}</style>${`<div title="width=${' '.repeat(8_000)}">x</div>`.repeat(16)}`;
    const { ms } = timed(() => build(html));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('keeps the gutter decision', () => {
    const canvas = '<style>p{}</style><table width="100%" bgcolor="#f4f4f4"><tr><td>x</td></tr></table>';
    const plain = '<style>p{}</style><table width="100%"><tr><td bgcolor="#fff">x</td></tr></table>';
    expect(build(canvas)).not.toContain('1rem 1.25rem');
    expect(build(plain)).toContain('1rem 1.25rem');
    expect(build(plain, 'edge')).not.toContain('1rem 1.25rem');
    expect(build(canvas, 'always')).toContain('1rem 1.25rem');
  });
});
