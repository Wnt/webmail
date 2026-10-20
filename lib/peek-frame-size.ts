// Fork (Wnt/webmail): the height of a swipe neighbour pane's body frame
// (components/email/swipe-peek.tsx). The pane shows the first screen of the
// message only, so the frame grows to its document's height up to
// `maxHeight`. A body that sizes itself by the frame (viewport units, height
// media queries whose width changes the fit-to-width scale) can keep growing
// or cycle (review swipe-preload r3 R3-E, r4 R4-C): once a recent height
// comes back, or after PEEK_MAX_RESIZES changes, the frame keeps `maxHeight` -
// a fixed viewport, independent of the message - and stops measuring.

/** A pane's frame adjusts its height at most this often before it keeps its full height. */
export const PEEK_MAX_RESIZES = 20;

/**
 * Sizes `iframe` to its parsed document `doc` (scaled by `fit`, the
 * fit-to-width pass, which returns the scale it applied) and keeps doing so
 * while the body resizes, with the bounds above. Returns a stop function.
 */
export function sizePeekFrame(
  iframe: HTMLIFrameElement,
  doc: Document,
  { maxHeight, fit }: { maxHeight: number; fit: (doc: Document) => number },
): () => void {
  const recent: number[] = [];
  let changes = 0;
  let fixed = false;
  let observer: ResizeObserver | null = null;
  const apply = () => {
    if (fixed || iframe.contentDocument !== doc || !doc.body) return;
    const scale = fit(doc);
    const height = Math.min(maxHeight, Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) * scale));
    if (iframe.style.height === `${height}px`) return;
    if (recent.includes(height) || ++changes > PEEK_MAX_RESIZES) {
      fixed = true;
      observer?.disconnect();
      iframe.style.height = `${maxHeight}px`;
      return;
    }
    recent.push(height);
    if (recent.length > 6) recent.shift();
    iframe.style.height = `${height}px`;
  };
  apply();
  if (!fixed && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(apply);
    observer.observe(doc.body);
  }
  return () => { fixed = true; observer?.disconnect(); };
}
