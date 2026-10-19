import { describe, it, expect } from 'vitest';
import {
  gutterModes,
  isRevealed,
  isZoomed,
  restingScrollLeft,
  swipeProgress,
  visibleWidth,
  REVEAL_SLACK,
} from '@/lib/message-swipe';

const base = { enabled: true, zoomed: false, blocked: false, canPrev: true, canNext: true };

describe('message swipe gutters', () => {
  it('a neighbour on a side gives a "go" gutter there', () => {
    expect(gutterModes(base)).toEqual({ prev: 'go', next: 'go' });
  });

  it('at an end of the list that side only bounces', () => {
    expect(gutterModes({ ...base, canNext: false })).toEqual({ prev: 'go', next: 'bounce' });
    expect(gutterModes({ ...base, canPrev: false })).toEqual({ prev: 'bounce', next: 'go' });
    expect(gutterModes({ ...base, canPrev: false, canNext: false })).toEqual({ prev: 'bounce', next: 'bounce' });
  });

  it('an unsent quick reply blocks both sides: bounce only, never navigate', () => {
    expect(gutterModes({ ...base, blocked: true })).toEqual({ prev: 'bounce', next: 'bounce' });
  });

  it('a pinch-zoomed page has no gutters at all, so a pan pans the page', () => {
    expect(gutterModes({ ...base, zoomed: true })).toEqual({ prev: 'off', next: 'off' });
    expect(gutterModes({ ...base, zoomed: true, blocked: true })).toEqual({ prev: 'off', next: 'off' });
  });

  it('off outside the phone layout', () => {
    expect(gutterModes({ ...base, enabled: false })).toEqual({ prev: 'off', next: 'off' });
  });
});

describe('message swipe geometry', () => {
  it('zoomed only past the epsilon', () => {
    expect(isZoomed(1)).toBe(false);
    expect(isZoomed(1.005)).toBe(false);
    expect(isZoomed(1.2)).toBe(true);
    expect(isZoomed(undefined)).toBe(false);
  });

  it('measures how much of a gutter is inside the track', () => {
    const track = { left: 0, right: 390 };
    expect(visibleWidth(track, { left: 390, right: 546 })).toBe(0); // at rest, off to the right
    expect(visibleWidth(track, { left: 340, right: 496 })).toBe(50);
    expect(visibleWidth(track, { left: 234, right: 390 })).toBe(156); // whole
    expect(visibleWidth(track, { left: -156, right: 0 })).toBe(0);
    expect(visibleWidth(track, { left: -100, right: 56 })).toBe(56);
  });

  it('progress reaches 1 at half the gutter (where a release snaps to it)', () => {
    expect(swipeProgress(0, 156)).toBe(0);
    expect(swipeProgress(39, 156)).toBeCloseTo(0.5);
    expect(swipeProgress(78, 156)).toBe(1);
    expect(swipeProgress(156, 156)).toBe(1);
    expect(swipeProgress(10, 0)).toBe(0);
  });

  it('a gutter counts as revealed only when wholly on screen', () => {
    expect(isRevealed(156, 156)).toBe(true);
    expect(isRevealed(156 - REVEAL_SLACK, 156)).toBe(true);
    expect(isRevealed(150, 156)).toBe(false);
    expect(isRevealed(0, 0)).toBe(false);
  });

  it('rests the page flush with the track in LTR and RTL', () => {
    // LTR: [prev 156][page 390][next 156]; the page starts 156 px in.
    expect(restingScrollLeft({ pageOffsetLeft: 156, scrollWidth: 702, clientWidth: 390, rtl: false })).toBe(156);
    // No prev gutter: the page is first.
    expect(restingScrollLeft({ pageOffsetLeft: 0, scrollWidth: 546, clientWidth: 390, rtl: false })).toBe(0);
    // RTL: [next 156][page 390][prev 156] left to right; scrollLeft runs 0 .. -(702 - 390).
    expect(restingScrollLeft({ pageOffsetLeft: 156, scrollWidth: 702, clientWidth: 390, rtl: true })).toBe(-156);
  });
});
