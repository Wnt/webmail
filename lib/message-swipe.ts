/**
 * Gesture classification for swiping between messages on the phone: a pure
 * state machine (no DOM), so the thresholds can be unit tested and the hook
 * that drives it (`hooks/use-message-swipe.ts`) only does plumbing.
 *
 * A swipe is claimed only when the finger has clearly moved sideways:
 *  - past `slop` px, at most `maxAngleDeg` off the horizontal;
 *  - not after resting as for a long-press (text selection, link menu);
 *  - started away from the screen's left/right edges (Safari's back/forward
 *    edge swipe) and the bottom edge (the home indicator's app switcher);
 *  - with a single finger (two fingers are a pinch).
 * Anything that moves vertically first is a scroll and is left alone for the
 * rest of that touch. A claimed swipe that turns vertical is cancelled.
 * Release commits past `commitDistance`, or on a quick flick.
 */

export interface MessageSwipeConfig {
  /** Travel (px) before the motion is classified at all. */
  slop: number;
  /** Largest angle (degrees) off the horizontal that still counts as a swipe. */
  maxAngleDeg: number;
  /** After the claim: cancel once the motion is this steep (degrees) and `cancelDy` px vertical. */
  cancelAngleDeg: number;
  cancelDy: number;
  /** Release past this horizontal distance (px) navigates... */
  commitDistance: number;
  /** ...or past `flickDistance` px at `flickVelocity` px/ms or faster. */
  flickDistance: number;
  flickVelocity: number;
  /** No swipe starts this close (px) to the left or right edge of the viewport. */
  edgeX: number;
  /** No swipe starts this close (px) to the bottom edge of the viewport. */
  edgeBottom: number;
  /** A touch that rests this long (ms) before moving is a long-press, not a swipe. */
  longPressMs: number;
}

export const MESSAGE_SWIPE_DEFAULTS: MessageSwipeConfig = {
  slop: 10,
  maxAngleDeg: 30,
  cancelAngleDeg: 50,
  cancelDy: 24,
  commitDistance: 96,
  flickDistance: 40,
  flickVelocity: 0.5,
  edgeX: 24,
  edgeBottom: 34,
  longPressMs: 450,
};

/** `next` = the button that was on the right (older in a newest-first list). */
export type SwipeDirection = 'next' | 'prev';

export interface SwipeViewport {
  width: number;
  height: number;
  /** Right-to-left UI: the finger's direction is mirrored. */
  rtl?: boolean;
}

export type SwipeStartRejection = 'multi-touch' | 'edge' | 'zoomed' | 'excluded';

export type SwipeMoveResult =
  /** Still undecided (inside the slop). */
  | { kind: 'pending' }
  /** Not a swipe: ignore the rest of this touch. */
  | { kind: 'ignored'; reason: 'vertical' | 'long-press' | 'multi-touch' | 'not-started' }
  /** Just became a swipe. The caller may still veto it (e.g. a scrollable child). */
  | { kind: 'claim'; dx: number; direction: SwipeDirection }
  /** Following the finger. */
  | { kind: 'track'; dx: number; direction: SwipeDirection }
  /** Was a swipe, turned vertical (or a second finger landed): snap back. */
  | { kind: 'cancel' };

export type SwipeEndResult =
  | { kind: 'none' }
  | { kind: 'cancel' }
  | { kind: 'commit'; direction: SwipeDirection };

interface Sample { x: number; t: number }

/** Finger moving left (dx < 0) opens the next message, as a page turn does. */
export function directionOf(dx: number, rtl = false): SwipeDirection {
  return (dx < 0) !== rtl ? 'next' : 'prev';
}

export class MessageSwipeTracker {
  readonly config: MessageSwipeConfig;
  private phase: 'idle' | 'pending' | 'tracking' | 'ignored' | 'cancelled' = 'idle';
  private x0 = 0;
  private y0 = 0;
  private t0 = 0;
  private dx = 0;
  private rtl = false;
  private samples: Sample[] = [];

  constructor(config: Partial<MessageSwipeConfig> = {}) {
    this.config = { ...MESSAGE_SWIPE_DEFAULTS, ...config };
  }

  get active(): boolean {
    return this.phase === 'tracking';
  }

  /**
   * A touch begins. Returns why it can never become a swipe, or null when it
   * is a candidate.
   */
  start(
    x: number,
    y: number,
    t: number,
    viewport: SwipeViewport,
    opts: { touches?: number; zoomed?: boolean; excluded?: boolean } = {},
  ): SwipeStartRejection | null {
    this.reset();
    const c = this.config;
    let rejection: SwipeStartRejection | null = null;
    if ((opts.touches ?? 1) !== 1) rejection = 'multi-touch';
    else if (opts.zoomed) rejection = 'zoomed';
    else if (opts.excluded) rejection = 'excluded';
    else if (x < c.edgeX || x > viewport.width - c.edgeX || y > viewport.height - c.edgeBottom) rejection = 'edge';
    if (rejection) {
      this.phase = 'ignored';
      return rejection;
    }
    this.phase = 'pending';
    this.x0 = x;
    this.y0 = y;
    this.t0 = t;
    this.rtl = !!viewport.rtl;
    this.samples = [{ x, t }];
    return null;
  }

  move(x: number, y: number, t: number, touches = 1): SwipeMoveResult {
    const c = this.config;
    if (this.phase === 'idle' || this.phase === 'ignored' || this.phase === 'cancelled') {
      return { kind: 'ignored', reason: 'not-started' };
    }
    if (touches !== 1) {
      return this.phase === 'tracking' ? this.cancel() : this.ignore('multi-touch');
    }
    const dx = x - this.x0;
    const dy = y - this.y0;
    this.samples.push({ x, t });
    if (this.samples.length > 8) this.samples.shift();

    if (this.phase === 'pending') {
      if (Math.hypot(dx, dy) < c.slop) return { kind: 'pending' };
      if (t - this.t0 >= c.longPressMs) return this.ignore('long-press');
      const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
      if (angle > c.maxAngleDeg) return this.ignore('vertical');
      this.phase = 'tracking';
      this.dx = dx;
      return { kind: 'claim', dx, direction: directionOf(dx, this.rtl) };
    }

    // tracking
    const steep = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
    if (Math.abs(dy) >= c.cancelDy && steep > c.cancelAngleDeg) return this.cancel();
    this.dx = dx;
    return { kind: 'track', dx, direction: directionOf(dx, this.rtl) };
  }

  /** The caller vetoed a claim (a scrollable child, nowhere to go...). */
  veto(): void {
    if (this.phase === 'tracking' || this.phase === 'pending') this.phase = 'ignored';
  }

  end(t: number): SwipeEndResult {
    const c = this.config;
    const phase = this.phase;
    const dx = this.dx;
    const rtl = this.rtl;
    const v = this.velocity(t);
    this.reset();
    if (phase === 'cancelled') return { kind: 'cancel' };
    if (phase !== 'tracking') return { kind: 'none' };
    const far = Math.abs(dx) >= c.commitDistance;
    const flick = Math.abs(dx) >= c.flickDistance && Math.abs(v) >= c.flickVelocity && Math.sign(v) === Math.sign(dx);
    if (far || flick) return { kind: 'commit', direction: directionOf(dx, rtl) };
    return { kind: 'cancel' };
  }

  /** Horizontal velocity (px/ms) over the last ~100 ms of samples. */
  private velocity(now: number): number {
    const recent = this.samples.filter((s) => now - s.t <= 100);
    const pts = recent.length >= 2 ? recent : this.samples.slice(-2);
    if (pts.length < 2) return 0;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return (b.x - a.x) / dt;
  }

  private ignore(reason: 'vertical' | 'long-press' | 'multi-touch'): SwipeMoveResult {
    this.phase = 'ignored';
    return { kind: 'ignored', reason };
  }

  private cancel(): SwipeMoveResult {
    this.phase = 'cancelled';
    return { kind: 'cancel' };
  }

  private reset(): void {
    this.phase = 'idle';
    this.dx = 0;
    this.samples = [];
  }
}

/**
 * Rubber-band offset for the content under the finger: 1:1 when there is a
 * message to go to, a stiff token nudge (the "bounce") when there is none.
 */
export function swipeOffset(dx: number, canGo: boolean, width: number): number {
  if (!canGo) {
    const sign = Math.sign(dx);
    return sign * Math.min(48, Math.abs(dx) * 0.2);
  }
  const max = Math.max(1, width);
  return Math.max(-max, Math.min(max, dx));
}
