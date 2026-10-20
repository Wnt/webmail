// Fork (Wnt/webmail): the document the reading pane's sandboxed body iframe
// shows (its srcdoc), built from a sanitized body (lib/email-content-cache.ts).
// Moved out of components/email/email-viewer.tsx unchanged, so the phone's
// swipe neighbours (components/email/swipe-peek.tsx) render exactly the
// document the reading pane will: the same styles and the same
// Content-Security-Policy (emailIframeCsp), with no script.

import { emailIframeCsp } from '@/lib/email-sanitization';
import { DARK_PENDING_CLASS, emailColorScheme, emailDarkModeCss, resolveColorSchemeMedia } from '@/lib/email-dark-mode';
import { hasFullBleedCanvas } from '@/lib/email-full-bleed';
import type { MessageSpacing } from '@/stores/settings-store';

export interface EmailFrameContent {
  html: string;
  isHtml: boolean;
  hasStyleTag: boolean;
  externalBlocked: boolean;
}

/** The body iframe's srcdoc for `content`; '' when it is not HTML (plain text renders inline). */
export function buildEmailFrameSrcDoc(
  content: EmailFrameContent,
  { isDark, nativeDarkMode, messageSpacing }: { isDark: boolean; nativeDarkMode: boolean; messageSpacing: MessageSpacing },
): string {
  if (!content.isHtml) return '';

  // Dark mode rewrites the mail's colours after load (applyEmailDarkMode in
  // handleIframeLoad); this only sets the fallback colours and keeps the
  // body hidden until that pass ran. A mail with its own dark styles gets
  // them pinned to the app theme rather than the OS.
  const darkModeCSS = isDark ? emailDarkModeCss() : '';
  const colorScheme = emailColorScheme(isDark, nativeDarkMode);

  // Bare HTML emails (no <style>) tend to be plain prose without their own
  // layout - give them the same padding as plain-text mails (.email-content-text).
  // Word/Outlook HTML emails ship a <style> block but put their gutter in
  // @page margins (print-only), so they need a fallback body padding too.
  const isWordHtml = /class=["']?(?:Mso|WordSection)|<o:p[\s>/]|urn:schemas-microsoft-com:office:office/i.test(content.html);
  // "auto" spacing: only drop our gutter when the mail paints a full-bleed
  // background canvas (a width:100% element carrying a background colour) --
  // the one case where the gutter shows as a frame around the email's own
  // background. A <style> tag alone is too weak a signal: plenty of
  // transactional mails ship one for web fonts yet have no gutter of their
  // own, and zeroing the padding glues their content to the corner.
  // Only looked at when it decides anything (lib/email-full-bleed.ts, upstream 29cb6b7f).
  const autoDropsGutter =
    messageSpacing === 'auto' && content.hasStyleTag && !isWordHtml && hasFullBleedCanvas(content.html);
  const dropGutter = messageSpacing === 'edge' || autoDropsGutter;
  const bodyPadding = dropGutter ? '0' : '1rem 1.25rem';
  const mobileBodyPaddingX = dropGutter ? '0' : '0.75rem';

  // Word emails rely on empty <p class=MsoNormal>&nbsp;</p> spacers for vertical
  // rhythm. With our default line-height: 1.6 these stack into oversized gaps;
  // tighten to match how Outlook/Gmail render the same source.
  const wordHtmlCSS = isWordHtml ? `
    body { line-height: 1.15; }
    p.MsoNormal, li.MsoNormal, div.MsoNormal { margin: 0 0 6px; }
  ` : '';

  // Defense-in-depth CSP inside srcDoc (see emailIframeCsp). When the user
  // loads/trusts the sender the srcDoc is rebuilt (see emailContent) with
  // the permissive variant so real images, web fonts and media load.
  const iframeCsp = emailIframeCsp(content.externalBlocked);

  return `<!DOCTYPE html>
<html class="${isDark ? DARK_PENDING_CLASS : ''}" style="color-scheme: ${colorScheme};"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${iframeCsp}">
<meta name="referrer" content="no-referrer">
<meta http-equiv="x-dns-prefetch-control" content="off">
<style>
  /* Force content height: some emails set html/body { height: 100% }, which -
     combined with overflow:hidden and our scrollHeight-based auto-resize -
     collapses the measured height and clips everything below the fold. The
     height reset is repeated in a trailing <style> after the body content
     (see below): the email's own <style> is injected inside our <body> and so
     lands later in source order, where - at equal specificity and !important -
     it would otherwise win the cascade. */
  /* overflow-y stays hidden so our scrollHeight-based height measurement works;
     overflow-x is auto on the body so an intrinsically wide table (e.g. a
     20-column data table) can scroll horizontally instead of being crushed to
     fit - the latter wraps header text to one character per line, which reads
     as 90deg-rotated vertical headers (issue #409). On a phone that scroll is
     the wrong answer for ordinary fixed-width mail, so fitEmailBodyWidth()
     shrinks the whole body to the screen width after load and only content too
     wide to stay legible when scaled keeps scrolling. */
  html { overflow: hidden; height: auto !important; }
  /* Some emails put height:100% on a full-bleed wrapper table/div (not html/body),
     which - with body's overflow:hidden - clips the content to a sliver, and the
     scrollHeight-based auto-resize then locks the iframe short (a Box.co.il
     verification email rendered as a logo-only 150px strip). Neutralise the
     full-height trick on any element so the body grows to its content. */
  [style*="height:100%"], [style*="height: 100%"] { height: auto !important; }
  body { margin: 0; padding: ${bodyPadding}; overflow-x: auto; overflow-y: hidden; height: auto !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; background: #ffffff; word-wrap: break-word; overflow-wrap: break-word; }
  @media (max-width: 640px) { body { padding-left: ${mobileBodyPaddingX}; padding-right: ${mobileBodyPaddingX}; } }
  /* Only force the cap on images that set no width of their own: an
     !important 100% also overrides a sender's inline max-width, and an
     image sized by max-width + max-height + width:100% then grows to
     the pane width while its max-height still clamps the height - the
     picture renders stretched. Same reasoning as the table rule below (#790).
     height stays !important so a fixed inline height cannot squash it. */
  img:not([style*="max-width"]) { max-width: 100% !important; }
  img[style*="max-width"] { max-width: 100%; }
  img { height: auto !important; }
  a { color: #1a73e8; }
  /* Only force the cap on tables that set no width of their own: an
     !important 100% would also override a newsletter's inline
     max-width:600px and stretch it across the pane. (#790) */
  table:not([style*="max-width"]) { max-width: 100% !important; }
  table[style*="max-width"] { max-width: 100%; }
  table { table-layout: auto; overflow-wrap: break-word; }
  /* break-word (not anywhere): break only over-long single words, and keep each
     word's min-content width so columns are not collapsed to a single char. */
  td, th { overflow-wrap: break-word; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  ${wordHtmlCSS}
  ${darkModeCSS}
</style></head><body dir="auto">${resolveColorSchemeMedia(content.html, isDark)}<style>html,body{height:auto!important;min-height:0!important;max-height:none!important}</style></body></html>`;
}
