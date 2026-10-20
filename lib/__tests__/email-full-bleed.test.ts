import { describe, expect, it } from 'vitest';
import { hasFullBleedCanvas } from '@/lib/email-full-bleed';

// The first describe block is upstream bulwarkmail/webmail 29cb6b7f's test.
describe('hasFullBleedCanvas', () => {
  it('recognises a 100% wide element with a background, in either attribute order', () => {
    expect(hasFullBleedCanvas('<table width="100%" bgcolor="#f4f4f4"><tr><td>x</td></tr></table>')).toBe(true);
    expect(hasFullBleedCanvas('<div style="background-color:#eee;width:100%">x</div>')).toBe(true);
    expect(hasFullBleedCanvas('<body style="width: 100%; background: #fff">')).toBe(true);
  });

  it('does not take width and background from two different elements', () => {
    expect(hasFullBleedCanvas('<table width="100%"><tr><td bgcolor="#fff">x</td></tr></table>')).toBe(false);
    expect(hasFullBleedCanvas('<div style="width:100%"></div><div style="background:#fff"></div>')).toBe(false);
    expect(hasFullBleedCanvas('<p style="width:100%;background:#fff">not a canvas element</p>')).toBe(false);
  });

  it('answers a megabyte style attribute in milliseconds', () => {
    const html = `<div style="${'width:100%;'.repeat(100_000)}">x</div>`;
    const started = performance.now();
    expect(hasFullBleedCanvas(html)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    const html2 = `<table style="${'background:red;'.repeat(70_000)}">x</table>`;
    const started2 = performance.now();
    expect(hasFullBleedCanvas(html2)).toBe(false);
    expect(performance.now() - started2).toBeLessThan(100);
  });
});

// Fork (Wnt/webmail): more long-token shapes, all synthetic.
describe('hasFullBleedCanvas on long tokens', () => {
  const timed = (html: string) => {
    const started = performance.now();
    const result = hasFullBleedCanvas(html);
    return { result, ms: performance.now() - started };
  };

  it('keeps the quote and whitespace forms of width="100%"', () => {
    expect(hasFullBleedCanvas('<table width = " 100%" bgcolor="#fff">')).toBe(true);
    expect(hasFullBleedCanvas("<div width='  100%' style='background:red'>")).toBe(true);
    expect(hasFullBleedCanvas('<div width=100% bgcolor=1>')).toBe(true);
    expect(hasFullBleedCanvas('<div width=" x100%" bgcolor=1>')).toBe(false);
    expect(hasFullBleedCanvas('<div width=""100%" bgcolor=1>')).toBe(false);
  });

  it('answers a megabyte of padded attributes in milliseconds', () => {
    const tag = (pad: string) => `<div title="width=${pad}" data-x="background${pad}">x</div>`;
    const spaces = ' '.repeat(8_000);
    const { result, ms } = timed(tag(spaces).repeat(64));
    expect(result).toBe(false);
    expect(ms).toBeLessThan(1000);
    const mixed = ' \t\n'.repeat(2_600);
    const second = timed(tag(mixed).repeat(64));
    expect(second.result).toBe(false);
    expect(second.ms).toBeLessThan(1000);
  });

  it('answers half a megabyte of start tags and unclosed tags in milliseconds', () => {
    for (const html of ['<div '.repeat(100_000), '<table width=100% '.repeat(30_000), `<body ${'width '.repeat(200_000)}`]) {
      const { result, ms } = timed(html);
      expect(result).toBe(false);
      expect(ms).toBeLessThan(1000);
    }
  });
});
