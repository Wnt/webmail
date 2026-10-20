import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { FilePreviewModal } from '../file-preview-modal';
import { EmlPreview } from '../eml-preview';
import { JMAPClient } from '@/lib/jmap/client';

// Fork (Wnt/webmail), with upstream 29b33eb4 (review upstream-backport-bulwark
// r2 R2-1): a sender's attachment name shows and downloads without directional
// formatting characters in the preview dialog, an attached message's own
// attachments and the client's download link too. Synthetic names only.

const SPOOF = 'report‮fdp.exe';

afterEach(() => vi.restoreAllMocks());

describe('attachment names without directional formatting characters', () => {
  it('the preview dialog', () => {
    render(<FilePreviewModal name={SPOOF} onClose={() => {}} onDownload={() => {}} getFileContent={() => new Promise(() => {})} />);
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('reportfdp.exe');
    expect(screen.getByRole('heading').textContent).toBe('reportfdp.exe');
  });

  it("an attached message's attachments, shown and downloaded", () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    render(<EmlPreview message={{ subject: 's', text: 'x', attachments: [{ filename: SPOOF, mimeType: 'application/pdf', content: new Uint8Array([1]) }] } as never} />);
    const button = screen.getByText('reportfdp.exe');
    button.click();
    expect(clicked).toEqual(['reportfdp.exe']);
  });

  it("the client's download link", async () => {
    const c = new JMAPClient('https://mail.example.test', 'owner', 'p');
    vi.spyOn(c, 'fetchBlob').mockResolvedValue(new Blob(['x']));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    await c.downloadBlob('b1', SPOOF, 'application/pdf');
    expect(clicked).toEqual(['reportfdp.exe']);
  });
});
