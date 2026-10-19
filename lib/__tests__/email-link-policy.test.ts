import { describe, expect, it } from 'vitest';
import {
  applyEmailLinkPolicy,
  classifyEmailLinkHref,
  isInPlaceLinkHref,
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

  it('writes a fragment against the srcdoc document and accepts only that about: form', () => {
    expect(classifyEmailLinkHref('#section')).toEqual({ kind: 'fragment', href: 'about:srcdoc#section' });
    expect(classifyEmailLinkHref(' \n#')).toEqual({ kind: 'fragment', href: 'about:srcdoc#' });
    expect(classifyEmailLinkHref('about:srcdoc#section')).toEqual({ kind: 'fragment', href: 'about:srcdoc#section' });
    expect(classifyEmailLinkHref('ABOUT:srcdoc#section')).toEqual({ kind: 'fragment', href: 'about:srcdoc#section' });
    for (const href of ['about:srcdoc', 'about:SRCDOC#section', 'about:srcdoc?x#section', 'about:blank#section', 'about:srcdocx#s']) {
      expect(classifyEmailLinkHref(href)).toBeNull();
    }
    // The browser reads the written form as the frame's own URL plus a fragment.
    expect(new URL('about:srcdoc#section', BASE).href).toBe('about:srcdoc#section');
    expect(new URL('#section', BASE).href).toBe(`${BASE}#section`);
    expect(openableLinkHref('about:srcdoc#section')).toBeNull();
  });

  it('leaves fragments and mailto: to the browser in the click handler, nothing else', () => {
    for (const href of ['about:srcdoc#section', '#section', 'mailto:reader@example.test', 'MAILTO:reader@example.test']) {
      expect(isInPlaceLinkHref(href)).toBe(true);
    }
    for (const href of ['https://outside.example/', 'tel:1', 'blob:https://mail.example.test/1', '/x', 'about:blank', '', null]) {
      expect(isInPlaceLinkHref(href)).toBe(false);
    }
  });

  it('keeps fragments, external protocols and blob: part links, scheme lower-cased', () => {
    expect(classifyEmailLinkHref('#section')?.kind).toBe('fragment');
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

describe('fragment links in every body renderer', () => {
  // The reading pane and the HTML/.eml previews keep <style>; the conversation
  // cards do not. Both external-content settings. A and AREA.
  const renderers = [
    ['reading pane / previews', {}],
    ['conversation cards', { keepStyleTags: false }],
  ] as const;
  for (const [name, options] of renderers) {
    for (const blockExternal of [true, false]) {
      it(`${name}, external content ${blockExternal ? 'blocked' : 'allowed'}`, () => {
        const doc = parseHtmlSafely(sanitizeEmailBodyForIframe(
          '<a href="#part-2" target="_top">a</a><map name="m"><area href=" #part-2" target="_blank" coords="0,0,1,1"></map>'
          + '<img usemap="#m" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'
          + '<a href="about:srcdoc#part-2">sender-written</a><p id="part-2">two</p>',
          blockExternal, options,
        ).html);
        for (const el of [doc.querySelector('a')!, doc.querySelector('area')!]) {
          expect(el.getAttribute('href')).toBe('about:srcdoc#part-2');
          expect(el.hasAttribute('target')).toBe(false);
          expect(el.hasAttribute('rel')).toBe(false);
        }
        // An image map's own name reference is not a link and stays as written.
        expect(doc.querySelector('img')!.getAttribute('usemap')).toBe('#m');
        // DOMPurify's URI allowlist drops a sender's own about: href before the policy runs.
        expect(doc.querySelectorAll('a')[1].hasAttribute('href')).toBe(false);
      });
    }
  }
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
