import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Blob as NodeBlob } from 'node:buffer';
import { FilePreviewModal } from '@/components/files/file-preview-modal';
import { useSettingsStore } from '@/stores/settings-store';

// Audit bulwark-2: an HTML attachment preview follows the mail body's
// remote-content policy. Inspects only the document handed to the iframe; no
// resource is fetched and no script is executed.

afterEach(() => {
  useSettingsStore.setState({ externalContentPolicy: 'ask' });
  vi.restoreAllMocks();
});

const TRACKING_HTML = '<!doctype html><html><head><style>body{background-image:url(https://tracker.invalid/css)}</style></head><body><h1>Invoice</h1><img src="https://tracker.invalid/open"></body></html>';

function renderPreview(html: string | Uint8Array<ArrayBuffer>, contentType = 'text/html') {
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    const url = `blob:https://webmail.example/${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const view = render(<FilePreviewModal name="invoice.html" onClose={() => {}} onDownload={() => {}}
    getFileContent={async () => ({ blob: new NodeBlob([html], { type: contentType }) as unknown as Blob, contentType })} />);
  const previewDoc = async () => {
    const iframe = view.container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('');
    const documentHtml = iframe.getAttribute('srcdoc') || await blobs.get(iframe.getAttribute('src')!)!.text();
    return new DOMParser().parseFromString(documentHtml, 'text/html');
  };
  return { ...view, previewDoc };
}

const cspOf = (doc: Document) => doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';

it.each(['block', 'ask'] as const)('HTML attachment preview enforces %s remote-content policy', async (policy) => {
  useSettingsStore.setState({ externalContentPolicy: policy });
  const { container, previewDoc } = renderPreview(TRACKING_HTML);
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
  const doc = await previewDoc();
  const csp = cspOf(doc);
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain('img-src data: blob:;');
  expect(doc.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
  // Neutralised like a mail body: nothing in the document loads a remote URL.
  expect(doc.querySelector('img')?.getAttribute('src')).not.toContain('tracker.invalid');
  expect(doc.querySelector('style')?.textContent).not.toContain('tracker.invalid');
  expect(doc.body.textContent).toContain('Invoice');
});

it('"ask" loads remote content for this preview once the user allows it', async () => {
  useSettingsStore.setState({ externalContentPolicy: 'ask' });
  const { container, previewDoc } = renderPreview(TRACKING_HTML);
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
  fireEvent.click(await screen.findByRole('button', { name: 'load_external_content' }));
  await waitFor(async () => expect(cspOf(await previewDoc())).toContain('img-src data: blob: http: https:'));
  expect((await previewDoc()).querySelector('img')?.getAttribute('src')).toBe('https://tracker.invalid/open');
});

it('"block" offers no way to load remote content', async () => {
  useSettingsStore.setState({ externalContentPolicy: 'block' });
  const { container } = renderPreview(TRACKING_HTML);
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
  expect(screen.queryByRole('button', { name: 'load_external_content' })).toBeNull();
});

it('"allow" renders remote content like a mail body would', async () => {
  useSettingsStore.setState({ externalContentPolicy: 'allow' });
  const { container, previewDoc } = renderPreview(TRACKING_HTML);
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
  const doc = await previewDoc();
  expect(cspOf(doc)).toContain("default-src 'none'");
  expect(cspOf(doc)).toContain('img-src data: blob: http: https:');
  expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://tracker.invalid/open');
});

it('decodes a non-UTF-8 attachment by its declared charset', async () => {
  useSettingsStore.setState({ externalContentPolicy: 'block' });
  // "Hyvää päivää" in ISO-8859-1, declared in a <meta>.
  const latin1 = Uint8Array.from(
    '<html><head><meta charset="iso-8859-1"></head><body><p>Hyv\xe4\xe4 p\xe4iv\xe4\xe4</p></body></html>',
    (c) => c.charCodeAt(0),
  );
  const { container, previewDoc } = renderPreview(latin1);
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
  expect((await previewDoc()).body.textContent).toContain('Hyvää päivää');
});

// Audit safari-links-1: the attachment preview shares the body sanitizer's
// link policy - relative hrefs are gone from the document itself.
it.each(['block', 'allow'] as const)('HTML attachment preview drops relative link targets (policy %s)', async (policy) => {
  useSettingsStore.setState({ externalContentPolicy: policy });
  const { container, previewDoc } = renderPreview('<p><a href="/oauth/end_session">Pay</a><a href="https://outside.example/pay">Web</a><a href="#terms">Terms</a></p><p id="terms">t</p>');
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
  const [relative, web, fragment] = Array.from((await previewDoc()).querySelectorAll('a'));
  expect(relative.hasAttribute('href')).toBe(false);
  expect(web.getAttribute('href')).toBe('https://outside.example/pay');
  expect(fragment.getAttribute('href')).toBe('about:srcdoc#terms');
});
