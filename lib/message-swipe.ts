/**
 * Swipe between messages on the phone: the pure parts (no DOM writes), so the
 * rules can be unit tested and `hooks/use-message-swipe.ts` only does plumbing.
 *
 * The swipe is the browser's own horizontal scrolling, not a JavaScript touch
 * gesture. The message page (its subject and the pane that scrolls it) sits in
 * a horizontal scroll-snap "track" between two gutters; a sideways pan scrolls
 * the track and reveals a gutter, and the track settling with a whole "go"
 * gutter on screen opens that message.
 *
 * Why scrolling: the HTML body is a sandboxed iframe without allow-scripts.
 * WebKit (iOS Safari and the Home Screen app) runs no event listener on such
 * a document, not even one the host page added, so touches that start on the
 * body never reach any script of ours. A pan that starts there still chains
 * to the host's scroll containers, and the host sees those scroll. Scrolling
 * also leaves every other decision to the platform, as it is for any page:
 * the axis lock (a vertical scroll never moves the track), pinch-zoom,
 * long-press, text selection and its handles, caret moves in the reply box,
 * links, and Safari's own edge swipe. A horizontally scrollable table or code
 * block in the body scrolls first; at its end it rubber-bands rather than
 * opening the next message (swipe on the text around it for that). For
 * engines that start no text selection on a long-press, the hook also locks
 * the track while a finger rests before moving or a second finger is down.
 */

/**
 * - `go`: a message on that side; the gutter is a snap point and settling
 *   there opens it.
 * - `bounce`: nothing to open (the end of the list, or an unsent quick reply
 *   that would be lost): a short gutter without a snap point, so the message
 *   moves a little and springs back.
 * - `off`: no gutter, so the track cannot scroll sideways at all. Used while
 *   the page is pinch-zoomed: panning a zoomed page must pan the page.
 */
export type GutterMode = 'go' | 'bounce' | 'off';

export interface GutterModes {
  prev: GutterMode;
  next: GutterMode;
}

/** `next` = the button that was on the right (older in a newest-first list). */
export type SwipeDirection = 'next' | 'prev';

export function gutterModes(opts: {
  /** The phone layout (desktop has buttons and shortcuts). */
  enabled: boolean;
  /** The page is pinch-zoomed. */
  zoomed: boolean;
  /** Navigating away would lose something (an unsent quick reply). */
  blocked: boolean;
  canPrev: boolean;
  canNext: boolean;
}): GutterModes {
  if (!opts.enabled || opts.zoomed) return { prev: 'off', next: 'off' };
  if (opts.blocked) return { prev: 'bounce', next: 'bounce' };
  return { prev: opts.canPrev ? 'go' : 'bounce', next: opts.canNext ? 'go' : 'bounce' };
}

/** A visual-viewport scale this far above 1 counts as pinch-zoomed. */
export const ZOOM_EPSILON = 0.01;

export function isZoomed(scale: number | undefined | null): boolean {
  return typeof scale === 'number' && scale > 1 + ZOOM_EPSILON;
}

/** How much of a gutter is on screen inside the track, in px (0 when none). */
export function visibleWidth(track: { left: number; right: number }, gutter: { left: number; right: number }): number {
  return Math.max(0, Math.min(track.right, gutter.right) - Math.max(track.left, gutter.left));
}

/**
 * The share of a `go` gutter's commit point already scrolled into view:
 * 1 at half the gutter, which is where releasing the finger snaps to the
 * gutter (the next message) instead of back to the current one.
 */
export function swipeProgress(visible: number, gutterWidth: number): number {
  if (!(gutterWidth > 0)) return 0;
  return Math.max(0, Math.min(1, visible / (gutterWidth / 2)));
}

/** Px of slack when deciding whether a gutter is wholly on screen. */
export const REVEAL_SLACK = 2;

/** The track has settled with this gutter wholly on screen. */
export function isRevealed(visible: number, gutterWidth: number): boolean {
  return gutterWidth > 0 && visible >= gutterWidth - REVEAL_SLACK;
}

/**
 * The track scrollLeft that puts the page flush with the track (its resting
 * place), from layout offsets so a transform on the page does not skew it.
 * RTL scroll containers count scrollLeft from 0 at the right edge downwards.
 */
export function restingScrollLeft(opts: {
  pageOffsetLeft: number;
  scrollWidth: number;
  clientWidth: number;
  rtl: boolean;
}): number {
  const { pageOffsetLeft, scrollWidth, clientWidth, rtl } = opts;
  return rtl ? pageOffsetLeft - Math.max(0, scrollWidth - clientWidth) : pageOffsetLeft;
}
