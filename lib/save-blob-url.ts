// Fork (Wnt/webmail): save a blob: URL under an attachment's name, as the
// reader does for a body link to a cid: part (components/email/email-viewer.tsx
// openCidPartLink). The name is a sender's: it is saved without directional
// formatting characters (upstream 29b33eb4), so `report‮fdp.exe` cannot
// pose as a PDF in the browser's download list.

import { stripBidiControls } from '@/lib/bidi';

export function saveBlobUrl(href: string, name: string | null | undefined, fallback = 'download'): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = stripBidiControls(name || '') || fallback;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
