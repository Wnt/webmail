// Fork (Wnt/webmail), review swipe-trust r3 (the reviewer's probes kept as
// regression tests): two editors keep their own quote permission; removing it
// keeps the user's edits and the references that are sent.
import { expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { QuotedHtml, buildQuotedHtmlBlock, setQuotedHtmlRemoteAllowed, serializeEditorContent } from '../quoted-html';
import { useSettingsStore } from '@/stores/settings-store';
const url = 'https://images.example.test/quote.png';
it('two editors keep separate permissions; revocation preserves redaction and outgoing references', async () => {
  useSettingsStore.setState({externalContentPolicy: 'ask'});
  const make = () => new Editor({extensions: [Document, Paragraph, Text, QuotedHtml], content: buildQuotedHtmlBlock(`<p>original</p><img src="${url}">`)});
  const a = make(), b = make();
  const inner = (ed: Editor) => ed.view.dom.querySelector('.quoted-html-island')!.shadowRoot!.firstElementChild!;
  try {
    setQuotedHtmlRemoteAllowed(a, true);
    expect(inner(a).querySelector('img')!.getAttribute('src')).toBe(url);
    expect(inner(b).querySelector('img')!.getAttribute('src')).not.toBe(url);
    inner(a).querySelector('p')!.textContent = 'redacted';
    inner(a).dispatchEvent(new Event('input', {bubbles: true, composed: true}));
    inner(a).dispatchEvent(new FocusEvent('focusin', {bubbles: true, composed: true}));
    setQuotedHtmlRemoteAllowed(a, false);
    expect(inner(a).querySelector('img')!.getAttribute('src')).not.toBe(url);
    expect(inner(a).textContent).toBe('redacted');
    await new Promise(resolve => requestAnimationFrame(resolve));
    const sent = serializeEditorContent(a as never);
    expect(sent).toContain('redacted');
    expect(sent).toContain(`src="${url}"`);
    expect(sent).not.toContain('data-bulwark-remote');
  } finally { a.destroy(); b.destroy(); }
});
