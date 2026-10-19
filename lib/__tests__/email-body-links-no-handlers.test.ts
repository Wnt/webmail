import { describe, expect, it } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { prepareEmailHtml } from '@/lib/email-content-cache';
import {
  emailIframeCsp,
  isOpenableLinkHref,
  parseHtmlSafely,
  sanitizeEmailBodyForIframe,
} from '@/lib/email-sanitization';
import { inertBlobType } from '@/lib/file-preview';

// Safari does not dispatch even parent-installed listeners in a sandboxed
// document without allow-scripts. Inspect the real serialized body, without
// dispatching synthetic clicks: jsdom does not implement sandbox navigation.
const body = (html: string) => parseHtmlSafely(sanitizeEmailBodyForIframe(html, true).html);

describe('email-body link policy without iframe event handlers', () => {
  describe.each(['a', 'area'])('%s', (tag) => {
    const markup = (attrs: string) => tag === 'a'
      ? `<a ${attrs}>Read document</a>`
      : `<map name="document"><area shape="rect" coords="0,0,10,10" ${attrs}></map>`;

    // These are deliberately ordinary failing regression tests, not it.fails:
    // the sanitizer must enforce the existing click-handler policy itself.
    it.each(['/oauth/end_session', '../document', '?view=document'])(
      'neutralizes handler-rejected relative href %s before rendering', (href) => {
        expect(isOpenableLinkHref(href)).toBe(false);
        const link = body(markup(`href="${href}" target="_top"`)).querySelector(tag)!;
        expect(link.hasAttribute('target')).toBe(false);
        expect(link.hasAttribute('href')).toBe(false);
      },
    );

    it.each(['https://outside.example/document', '//outside.example/document', 'h&#9;ttps://outside.example/document'])(
      'statically isolates web link %s even with sender target and opener', (href) => {
        const link = body(markup(`href="${href}" target="_parent" rel="opener" ping="https://tracker.example/ping" referrerpolicy="unsafe-url"`)).querySelector(tag)!;
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.hasAttribute('ping')).toBe(false);
        expect(link.hasAttribute('referrerpolicy')).toBe(false);
      },
    );

    it.each(['javascript:alert(1)', 'data:text/html,document', 'data:image/svg+xml,document', 'intent:document', 'file:///document'])(
      'removes disallowed scheme %s without a listener', (href) => {
        expect(body(markup(`href="${href}"`)).querySelector(tag)!.hasAttribute('href')).toBe(false);
      },
    );

    it.each(['mailto:reader@example.test', 'tel:+15550100', '#section'])(
      'removes sender top target and opener from %s', (href) => {
        const link = body(markup(`href="${href}" target="_top" rel="opener"`)).querySelector(tag)!;
        // Fix review r1: a fragment is written against the srcdoc document's own
        // URL; a bare `#section` would resolve against the app page around it.
        expect(link.getAttribute('href')).toBe(href.startsWith('#') ? `about:srcdoc${href}` : href);
        expect(link.hasAttribute('target')).toBe(false);
        expect(link.hasAttribute('rel')).toBe(false);
      },
    );
  });

  it('neutralizes relative links through the actual body preparation/cache path', () => {
    const email = {
      id: 'safari-relative-link-regression', attachments: [],
      htmlBody: [{ partId: 'html', type: 'text/html' }],
      bodyValues: { html: { value: '<p><a href="/oauth/end_session">Read document</a></p>', isTruncated: false } },
    } as unknown as Email;
    const prepared = prepareEmailHtml(email, true, {})!;
    expect(prepared.content.isHtml).toBe(true);
    expect(prepared.content.externalBlocked).toBe(true);
    expect(parseHtmlSafely(prepared.content.html).querySelector('a')!.hasAttribute('href')).toBe(false);
  });

  it('removes forms, refresh, base, scripts and nested frame markup before rendering', () => {
    const doc = body('<form action="https://outside.example/submit"><input name="field"><button>Submit</button></form>'
      + '<meta http-equiv="refresh" content="0;url=https://outside.example/refresh">'
      + '<base target="_top" href="https://outside.example/"><script>alert(1)</script>'
      + '<iframe src="https://outside.example/frame"></iframe>');
    expect(doc.querySelector('form, input, button, meta, base, script, iframe')).toBeNull();
    for (const externalBlocked of [true, false]) {
      expect(emailIframeCsp(externalBlocked)).toContain("default-src 'none'");
      expect(emailIframeCsp(externalBlocked)).toContain("form-action 'none'");
      expect(emailIframeCsp(externalBlocked)).toContain("frame-src 'none'");
      expect(emailIframeCsp(externalBlocked)).toContain("base-uri 'none'");
    }
  });

  it.each(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml'])(
    'keeps the independent CID MIME defense for %s', (type) => {
      expect(inertBlobType(type)).toBe('application/octet-stream');
    },
  );
});
