"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Image } from "@/components/icons";
import { emailIframeCsp, sanitizeEmailBodyForIframe } from "@/lib/email-sanitization";
import { useSettingsStore } from "@/stores/settings-store";

// Fork (Wnt/webmail), audit bulwark-2: an HTML attachment is sender content
// like a mail body, so its preview follows the same remote-content policy:
// sanitized like a body, rendered in a srcdoc with the mail body's resource
// CSP and no referrer, and remote images/styles/fonts stay blocked under
// "block", or under "ask" until the user loads them for this preview. The
// empty sandbox (no scripts, no same-origin, no forms) stays as before.

/**
 * The attachment's text the way a browser would have decoded it: a BOM, then
 * the declared charset (MIME parameter or a <meta> in the first 1024 bytes),
 * else UTF-8. Non-UTF-8 attachments would otherwise turn into mojibake now
 * that the preview is built from text instead of the original bytes.
 */
export async function decodeHtmlAttachment(blob: Blob, contentType?: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let label = "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    const declared = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1]
      ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
    if (declared) label = declared;
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function HtmlAttachmentPreview({ html, title }: { html: string; title: string }) {
  const t = useTranslations("email_viewer");
  const policy = useSettingsStore((state) => state.externalContentPolicy);
  const [allowed, setAllowed] = useState(false);
  const blockRemote = policy === "block" || (policy === "ask" && !allowed);

  const { doc, blockedSomething } = useMemo(() => {
    const result = sanitizeEmailBodyForIframe(html, blockRemote);
    return {
      doc: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${emailIframeCsp(blockRemote)}"><meta name="referrer" content="no-referrer"></head><body>${result.html}</body></html>`,
      blockedSomething: result.blockedExternalContent,
    };
  }, [html, blockRemote]);

  return (
    <div className="w-full max-w-5xl h-full flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      {blockRemote && blockedSomething && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm">
          <Image className="w-4 h-4 text-muted-foreground" />
          <span className="flex-1 min-w-0">{t("external_content_warning")}</span>
          {policy === "ask" && (
            <button
              type="button"
              onClick={() => setAllowed(true)}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors"
            >
              {t("load_external_content")}
            </button>
          )}
        </div>
      )}
      <iframe
        srcDoc={doc}
        sandbox=""
        referrerPolicy="no-referrer"
        className="w-full flex-1 min-h-0 rounded-lg bg-white"
        title={title}
      />
    </div>
  );
}
