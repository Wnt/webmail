import { describe, expect, it } from 'vitest';
import {
  applyEmailLinkPolicy,
  classifyEmailLinkHref,
  openableLinkHref,
  parseHtmlSafely,
  sanitizeEmailBodyForIframe,
} from '@/lib/email-sanitization';

// The message-body link policy is enforced in the sanitized markup (audit
// safari-links-1): WebKit runs no click listener in the sandboxed body frame.
// These cases pin the URL-syntax corners of that policy.

const BASE = 'https://mail.example.test/en/mail/inbox';
const link = (html: string, blockExternal = true) =>
  parseHtmlSafely(sanitizeEmailBodyForIframe(html, blockExternal).html).querySelector('a, area')!;

describe('classifyEmailLinkHref', () => {
  it.each([
    '/oauth/end_session', '../document', './document', 'document.pdf', '?view=document', '',
    '   ', 'https:/oauth/end_session', 'https:oauth/end_session', 'HTTP:/x', 'http:\\x',
    'java\u0001script:alert(1)', 'h\u0001ttps://outside.example/', 'javascript:alert(1)',
    'data:image/png;base64,AAAA', 'data:text/html,x', 'cid:part@example.test', 'intent:x',
    'file:///etc/passwd', 'about:blank', 'vbscript:x', 'https://', '//', 'https://[bad/',
  ])('rejects %j', (href) => {
    expect(classifyEmailLinkHref(href)).toBeNull();
    expect(openableLinkHref(href)).toBeNull();
  });

  it.each([
    ['https://outside.example/a b', 'https://outside.example/a%20b'],
    ['HTTPS://OUTSIDE.EXAMPLE', 'https://outside.example/'],
    [' \n https://outside.example/x \t', 'https://outside.example/x'],
    ['h\ttt\nps://outside.example/x', 'https://outside.example/x'],
    ['https:\\\\outside.example\\x', 'https://outside.example/x'],
    ['https:/\\outside.example/x', 'https://outside.example/x'],
    ['//outside.example/x', 'https://outside.example/x'],
    ['/\\outside.example/x', 'https://outside.example/x'],
    ['\\\\outside.example/x', 'https://outside.example/x'],
    ['http://outside.example/x', 'http://outside.example/x'],
  ])('serializes the web link %j as %s', (href, expected) => {
    expect(classifyEmailLinkHref(href)).toEqual({ kind: 'web', href: expected });
    expect(openableLinkHref(href)).toBe(expected);
  });

  it('resolves every kept web link to itself, whatever the base', () => {
    const corpus = ['https://a.example/x', '//a.example/x', '/\\a.example', 'https:\\\\a.example', 'https:///a.example', 'http://a.example:8080/p?q#f'];
    for (const href of corpus) {
      const kept = classifyEmailLinkHref(href)!;
      expect(kept.kind).toBe('web');
      // What the browser navigates to is what was checked: no base can change it.
      expect(new URL(kept.href, BASE).href).toBe(kept.href);
      expect(new URL(kept.href, 'http://other.example/').href).toBe(kept.href);
      expect(new URL(kept.href, BASE).origin).not.toBe(new URL(BASE).origin);
    }
  });

  it('keeps fragments, external protocols and blob: part links, scheme lower-cased', () => {
    expect(classifyEmailLinkHref('#section')).toEqual({ kind: 'fragment', href: '#section' });
    expect(classifyEmailLinkHref('  MAILTO:reader@example.test')).toEqual({ kind: 'external', href: 'mailto:reader@example.test', scheme: 'mailto' });
    expect(classifyEmailLinkHref('Tel:+15550100')).toEqual({ kind: 'external', href: 'tel:+15550100', scheme: 'tel' });
    for (const scheme of ['sms', 'callto', 'xmpp', 'ftp', 'ftps']) {
      expect(classifyEmailLinkHref(`${scheme}:x`)?.kind).toBe('external');
    }
    expect(classifyEmailLinkHref('blob:https://mail.example.test/0f3d')).toEqual({ kind: 'blob', href: 'blob:https://mail.example.test/0f3d' });
    // mailto: is left to the browser and blob: to the part preview/download gate.
    expect(openableLinkHref('mailto:reader@example.test')).toBeNull();
    expect(openableLinkHref('blob:https://mail.example.test/0f3d')).toBeNull();
  });
});

describe('applyEmailLinkPolicy in the body sanitizer', () => {
  it('writes back the serialized web link with a new-tab target', () => {
    const a = link('<a href="https:\\\\outside.example\\x" target="_self" rel="opener">x</a>');
    expect(a.getAttribute('href')).toBe('https://outside.example/x');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('removes a same-scheme relative https: link and its target', () => {
    for (const href of ['https:/oauth/end_session', 'https:oauth/end_session']) {
      const a = link(`<a href="${href}" target="_blank">x</a>`);
      expect(a.hasAttribute('href')).toBe(false);
      expect(a.hasAttribute('target')).toBe(false);
    }
  });

  it('removes relative hrefs whether or not external content is blocked', () => {
    for (const blockExternal of [true, false]) {
      expect(link('<a href="/oauth/end_session">x</a>', blockExternal).hasAttribute('href')).toBe(false);
    }
  });

  it('removes data: and unresolved cid: navigation but keeps image sources', () => {
    const doc = parseHtmlSafely(sanitizeEmailBodyForIframe(
      '<a href="data:image/png;base64,AAAA"><img src="data:image/png;base64,AAAA"></a>'
      + '<a href="cid:part@example.test">c</a><img src="blob:https://mail.example.test/0f3d">',
      true,
    ).html);
    const [dataLink, cidLink] = Array.from(doc.querySelectorAll('a'));
    expect(dataLink.hasAttribute('href')).toBe(false);
    expect(cidLink.hasAttribute('href')).toBe(false);
    const [dataImg, blobImg] = Array.from(doc.querySelectorAll('img'));
    expect(dataImg.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(blobImg.getAttribute('src')).toBe('blob:https://mail.example.test/0f3d');
  });

  it('opens a blob: part link in a new tab and canonicalizes mailto:', () => {
    const blob = link('<a href="blob:https://mail.example.test/0f3d" target="_top">part</a>');
    expect(blob.getAttribute('href')).toBe('blob:https://mail.example.test/0f3d');
    expect(blob.getAttribute('target')).toBe('_blank');
    expect(blob.getAttribute('rel')).toBe('noopener noreferrer');
    const mail = link('<a href=" MAILTO:reader@example.test" target="_blank">m</a>');
    expect(mail.getAttribute('href')).toBe('mailto:reader@example.test');
    expect(mail.hasAttribute('target')).toBe(false);
  });

  it('changes nothing when applied again (the viewer re-walks the live frame)', () => {
    const html = '<a href="//outside.example/x">a</a><a href="#s">b</a><a href="tel:1">c</a>'
      + '<a href="/x">d</a><a href="blob:https://mail.example.test/1">e</a><map><area href="https://outside.example"></map>';
    const doc = parseHtmlSafely(sanitizeEmailBodyForIframe(html, true).html);
    const before = doc.body.innerHTML;
    doc.querySelectorAll('a, area').forEach(applyEmailLinkPolicy);
    expect(doc.body.innerHTML).toBe(before);
  });
});
