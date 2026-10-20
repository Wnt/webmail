// Fork (Wnt/webmail): tag stripping for the quick text heuristics that run on
// a message's raw, unsanitized HTML body when it is opened - the plugin
// projection's plain text (lib/plugin-projection.ts, built for every open) and
// the reader's "is this HTML body empty" check before a winmail.dat or
// message/rfc822 part is unwrapped (components/email/email-viewer.tsx).
//
// Each step is one left-to-right pass, so the time is linear in the body's
// length whatever the markup. For well-formed HTML the result is the one the
// former `.replace(/<(script|style)[\s\S]*?<\/\1>/gi, …).replace(/<[^>]+>/g, …)`
// pipeline gave.

/**
 * `html` with the content of each raw-text element in `rawTextElements` - from
 * `<name` to the first following `</name>`, case-insensitive - and then every
 * tag (`<`, at least one character, the next `>`) replaced by `replacement`.
 * A `<` with no `>` after it stays as text, and so does the content of an
 * element whose closing tag never comes (only its start tag goes).
 */
export function stripHtmlTags(
  html: string,
  replacement: string,
  rawTextElements: readonly string[] = ['script', 'style'],
): string {
  return replaceTags(removeRawTextElements(html, replacement, rawTextElements), replacement);
}

function removeRawTextElements(html: string, replacement: string, names: readonly string[]): string {
  if (!names.length) return html;
  // Once a closing tag is not found after some position, it is not found after
  // any later one either: each name's closing tag is searched for to the end
  // at most once.
  const closers = new Map(names.map((name) => [name, new RegExp(`</${name}>`, 'gi')]));
  const parts: string[] = [];
  let kept = 0;
  let from = 0;
  for (;;) {
    const lt = html.indexOf('<', from);
    if (lt < 0) break;
    from = lt + 1;
    let name: string | undefined;
    for (const candidate of closers.keys()) {
      if (html.slice(lt + 1, lt + 1 + candidate.length).toLowerCase() === candidate) { name = candidate; break; }
    }
    if (!name) continue;
    const closer = closers.get(name)!;
    closer.lastIndex = lt + 1 + name.length;
    const close = closer.exec(html);
    if (!close) { closers.delete(name); continue; }
    parts.push(html.slice(kept, lt), replacement);
    kept = from = close.index + close[0].length;
  }
  parts.push(html.slice(kept));
  return parts.join('');
}

function replaceTags(html: string, replacement: string): string {
  const parts: string[] = [];
  let kept = 0;
  let from = 0;
  for (;;) {
    const lt = html.indexOf('<', from);
    if (lt < 0) break;
    const gt = html.indexOf('>', lt + 1);
    // No `>` after this `<`: no tag starts here or anywhere later.
    if (gt < 0) break;
    // `<>` is not a tag: the `<` stays and the scan goes on after it.
    if (gt === lt + 1) { from = lt + 1; continue; }
    parts.push(html.slice(kept, lt), replacement);
    kept = from = gt + 1;
  }
  parts.push(html.slice(kept));
  return parts.join('');
}

/**
 * Whether an HTML body is effectively empty (just boilerplate/whitespace):
 * Outlook often generates HTML bodies with Word CSS + &nbsp; but no real text.
 */
export function isHtmlBodyEffectivelyEmpty(html: string): boolean {
  return stripHtmlTags(html, '', ['style'])
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, '')
    .length === 0;
}
