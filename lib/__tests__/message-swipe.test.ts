import { describe, it, expect } from 'vitest';
import {
  MessageSwipeTracker,
  MESSAGE_SWIPE_DEFAULTS as D,
  directionOf,
  swipeOffset,
} from '@/lib/message-swipe';

const VP = { width: 390, height: 844 };

/** Drive a tracker through a straight drag in `steps` moves of `dt` ms each. */
function drag(
  tr: MessageSwipeTracker,
  from: [number, number],
  to: [number, number],
  { steps = 10, dt = 16, t0 = 0 } = {},
) {
  const results = [];
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    results.push(tr.move(from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, t0 + i * dt));
  }
  return { results, end: tr.end(t0 + steps * dt) };
}

function swipe(from: [number, number], to: [number, number], opts?: { steps?: number; dt?: number; t0?: number }) {
  const tr = new MessageSwipeTracker();
  expect(tr.start(from[0], from[1], opts?.t0 ?? 0, VP)).toBeNull();
  return drag(tr, from, to, opts);
}

describe('message swipe classification', () => {
  it('a long horizontal drag to the left commits "next"', () => {
    const { results, end } = swipe([300, 400], [300 - D.commitDistance - 10, 400], { steps: 10, dt: 30 });
    expect(results.some((r) => r.kind === 'claim')).toBe(true);
    expect(end).toEqual({ kind: 'commit', direction: 'next' });
  });

  it('a long horizontal drag to the right commits "prev"', () => {
    const { end } = swipe([80, 400], [80 + D.commitDistance + 10, 400], { steps: 10, dt: 30 });
    expect(end).toEqual({ kind: 'commit', direction: 'prev' });
  });

  it('a slow, short drag snaps back', () => {
    const { end } = swipe([300, 400], [300 - 60, 400], { steps: 20, dt: 40 });
    expect(end).toEqual({ kind: 'cancel' });
  });

  it('a quick flick past the flick distance commits even when short', () => {
    // 60 px in 60 ms = 1 px/ms
    const { end } = swipe([300, 400], [240, 400], { steps: 4, dt: 15 });
    expect(end).toEqual({ kind: 'commit', direction: 'next' });
  });

  it('a flick shorter than the flick distance does not commit', () => {
    const { end } = swipe([300, 400], [300 - (D.flickDistance - 5), 400], { steps: 3, dt: 10 });
    expect(end.kind).not.toBe('commit');
  });

  it('a drag that ends moving back the other way does not count as a flick', () => {
    const tr = new MessageSwipeTracker();
    tr.start(300, 400, 0, VP);
    for (let i = 1; i <= 6; i++) tr.move(300 - i * 12, 400, i * 16); // to 228 (dx -72)
    for (let i = 1; i <= 3; i++) tr.move(228 + i * 6, 400, 96 + i * 10); // back to 246 (dx -54), fast
    expect(tr.end(130)).toEqual({ kind: 'cancel' });
  });

  it('a vertical scroll is never claimed', () => {
    const { results, end } = swipe([200, 600], [200, 200]);
    expect(results.find((r) => r.kind !== 'pending')).toEqual({ kind: 'ignored', reason: 'vertical' });
    expect(results.some((r) => r.kind === 'claim' || r.kind === 'track')).toBe(false);
    expect(end).toEqual({ kind: 'none' });
  });

  it('a diagonal steeper than the angle threshold is a scroll', () => {
    const angle = (D.maxAngleDeg + 5) * (Math.PI / 180);
    const len = 200;
    const { results, end } = swipe([300, 400], [300 - len * Math.cos(angle), 400 - len * Math.sin(angle)]);
    expect(results.find((r) => r.kind !== 'pending')).toMatchObject({ kind: 'ignored', reason: 'vertical' });
    expect(end.kind).toBe('none');
  });

  it('a diagonal flatter than the angle threshold is a swipe', () => {
    const angle = (D.maxAngleDeg - 8) * (Math.PI / 180);
    const len = 200;
    const { end } = swipe([300, 400], [300 - len * Math.cos(angle), 400 - len * Math.sin(angle)], { dt: 30 });
    expect(end).toEqual({ kind: 'commit', direction: 'next' });
  });

  it('movement inside the slop stays undecided (a tap)', () => {
    const tr = new MessageSwipeTracker();
    tr.start(200, 400, 0, VP);
    expect(tr.move(204, 403, 50)).toEqual({ kind: 'pending' });
    expect(tr.end(80)).toEqual({ kind: 'none' });
  });

  it('a claimed swipe that turns vertical is cancelled', () => {
    const tr = new MessageSwipeTracker();
    tr.start(300, 400, 0, VP);
    expect(tr.move(280, 402, 16).kind).toBe('claim');
    expect(tr.move(250, 405, 32).kind).toBe('track');
    // Now the finger heads down the page.
    expect(tr.move(255, 470, 48)).toEqual({ kind: 'cancel' });
    // Further moves are ignored, and release does not navigate.
    expect(tr.move(150, 470, 64).kind).toBe('ignored');
    expect(tr.end(80)).toEqual({ kind: 'cancel' });
  });

  it('small vertical drift during a swipe is tolerated', () => {
    const tr = new MessageSwipeTracker();
    tr.start(300, 400, 0, VP);
    tr.move(280, 402, 16);
    expect(tr.move(150, 418, 120).kind).toBe('track');
    expect(tr.end(140)).toEqual({ kind: 'commit', direction: 'next' });
  });

  it('a second finger (pinch) cancels a swipe and is never one', () => {
    const tr = new MessageSwipeTracker();
    expect(tr.start(200, 400, 0, VP, { touches: 2 })).toBe('multi-touch');
    expect(tr.move(50, 400, 30).kind).toBe('ignored');
    expect(tr.end(40)).toEqual({ kind: 'none' });

    tr.start(300, 400, 0, VP);
    expect(tr.move(270, 400, 16).kind).toBe('claim');
    expect(tr.move(240, 400, 32, 2)).toEqual({ kind: 'cancel' });
    expect(tr.end(40)).toEqual({ kind: 'cancel' });
  });

  it('a long-press before moving is not a swipe (text selection, link menu)', () => {
    const tr = new MessageSwipeTracker();
    tr.start(200, 400, 0, VP);
    expect(tr.move(201, 400, 200)).toEqual({ kind: 'pending' });
    expect(tr.move(150, 400, D.longPressMs + 10)).toEqual({ kind: 'ignored', reason: 'long-press' });
    expect(tr.end(D.longPressMs + 50)).toEqual({ kind: 'none' });
  });

  describe('edge exclusion', () => {
    it('ignores touches starting at the left edge (Safari back swipe)', () => {
      const tr = new MessageSwipeTracker();
      expect(tr.start(D.edgeX - 1, 400, 0, VP)).toBe('edge');
      expect(drag(tr, [D.edgeX - 1, 400], [300, 400]).end).toEqual({ kind: 'none' });
    });

    it('ignores touches starting at the right edge (Safari forward swipe)', () => {
      const tr = new MessageSwipeTracker();
      expect(tr.start(VP.width - D.edgeX + 1, 400, 0, VP)).toBe('edge');
      expect(drag(tr, [VP.width - 5, 400], [50, 400]).end).toEqual({ kind: 'none' });
    });

    it('ignores touches starting on the home-indicator strip', () => {
      const tr = new MessageSwipeTracker();
      expect(tr.start(200, VP.height - D.edgeBottom + 1, 0, VP)).toBe('edge');
    });

    it('accepts touches just inside the edges', () => {
      const tr = new MessageSwipeTracker();
      expect(tr.start(D.edgeX + 1, 400, 0, VP)).toBeNull();
      expect(tr.start(VP.width - D.edgeX - 1, 400, 0, VP)).toBeNull();
    });
  });

  it('ignores touches while the page is pinch-zoomed or on excluded targets', () => {
    const tr = new MessageSwipeTracker();
    expect(tr.start(200, 400, 0, VP, { zoomed: true })).toBe('zoomed');
    expect(tr.start(200, 400, 0, VP, { excluded: true })).toBe('excluded');
  });

  it('a veto (scrollable child) drops the claimed swipe', () => {
    const tr = new MessageSwipeTracker();
    tr.start(300, 400, 0, VP);
    expect(tr.move(270, 400, 16).kind).toBe('claim');
    tr.veto();
    expect(tr.move(100, 400, 32).kind).toBe('ignored');
    expect(tr.end(48)).toEqual({ kind: 'none' });
  });

  it('mirrors directions in RTL', () => {
    expect(directionOf(-50)).toBe('next');
    expect(directionOf(50)).toBe('prev');
    expect(directionOf(-50, true)).toBe('prev');
    const tr = new MessageSwipeTracker();
    tr.start(300, 400, 0, { ...VP, rtl: true });
    expect(drag(tr, [300, 400], [150, 400], { dt: 30 }).end).toEqual({ kind: 'commit', direction: 'prev' });
  });

  it('follows the finger 1:1 when there is a message, and only nudges at the ends', () => {
    expect(swipeOffset(-120, true, 390)).toBe(-120);
    expect(swipeOffset(-500, true, 390)).toBe(-390);
    expect(Math.abs(swipeOffset(-120, false, 390))).toBeLessThanOrEqual(48);
    expect(swipeOffset(-120, false, 390)).toBeLessThan(0);
    expect(swipeOffset(400, false, 390)).toBe(48);
  });
});
