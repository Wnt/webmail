"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  gutterModes,
  isRevealed,
  isZoomed,
  restingScrollLeft,
  swipeProgress,
  visibleWidth,
  type GutterModes,
  type SwipeDirection,
} from "@/lib/message-swipe";

/**
 * Swipe between messages on the phone: finger left opens the next message,
 * finger right the previous one (mirrored in RTL).
 *
 * The swipe is native horizontal scrolling (see `lib/message-swipe.ts` for
 * why): the caller renders a horizontal scroll-snap track holding
 *   [prev gutter] [the message page] [next gutter]
 * with the gutters this hook's `modes` ask for. The hook keeps the page at
 * rest between them, drives the edge hint chips from the scroll position,
 * and when the track settles with a whole `go` gutter on screen it slides
 * the message out, opens that neighbour, and brings the new one in.
 *
 * It needs no touch listeners for the swipe itself, so touches that start on
 * the sandboxed body iframe (where WebKit runs no listener of ours) work like
 * any other, and nothing here can get in the way of scrolling, zoom,
 * selection or typing. The only touch listeners (passive) lock the track
 * during a long-press or while a second finger is down.
 */

export interface UseMessageSwipeOptions {
  enabled: boolean;
  /** The horizontal scroll-snap track (position: relative). */
  trackRef: React.RefObject<HTMLElement | null>;
  /** The message page between the gutters; it slides on a commit. */
  pageRef: React.RefObject<HTMLElement | null>;
  /** The pane inside the page that scrolls the message vertically. */
  paneRef?: React.RefObject<HTMLElement | null>;
  prevGutterRef: React.RefObject<HTMLElement | null>;
  nextGutterRef: React.RefObject<HTMLElement | null>;
  /** Fixed hint chips at the left and right edge (opacity is driven here). */
  hintLeftRef?: React.RefObject<HTMLElement | null>;
  hintRightRef?: React.RefObject<HTMLElement | null>;
  onNext?: () => void;
  onPrev?: () => void;
  /** Leaving would lose something (an unsent quick reply): never navigate. */
  blocked?: boolean;
  /** A swipe was tried while blocked (once per gesture). */
  onBlocked?: () => void;
  /** Changes when another message is shown (its id): the new one slides in. */
  resetKey?: string | null;
}

const OUT_MS = 170;
const IN_MS = 220;
/** Give up waiting for the next message to arrive and show what is there. */
const ENTER_FALLBACK_MS = 1500;
/** A blocked swipe this far into a gutter says why it does not navigate. */
const BLOCKED_NOTICE_PX = 16;
/** Without `scrollend` (older engines): settled after this long without a scroll event. */
const SETTLE_MS = 180;
/**
 * After the hook itself moves the track (back to rest, a new message in), a
 * settle within this long is that move's, never a swipe to commit.
 */
const RESNAP_GUARD_MS = 300;
/** A finger resting this long before it moves is a long-press (selection, menus), never a swipe. */
const LONG_PRESS_MS = 450;
/** Movement (px) that counts as "moved" before the long-press time. */
const LONG_PRESS_SLOP = 10;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** `scrollend`: fires in iOS 26 WebKit (checked in the simulator), Chrome 114+, Firefox 109+; older engines settle on a timer. */
function hasScrollEnd(): boolean {
  return typeof window !== "undefined" && "onscrollend" in (window as object);
}

function nextFrame(fn: () => void): number {
  if (typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(fn);
  return window.setTimeout(fn, 16);
}

function isRtl(el: Element): boolean {
  try {
    return getComputedStyle(el).direction === "rtl";
  } catch {
    return false;
  }
}

export function useMessageSwipe({
  enabled,
  trackRef,
  pageRef,
  paneRef,
  prevGutterRef,
  nextGutterRef,
  hintLeftRef,
  hintRightRef,
  onNext,
  onPrev,
  blocked = false,
  onBlocked,
  resetKey,
}: UseMessageSwipeOptions): { modes: GutterModes } {
  // A pinch-zoomed page pans with the finger; the track must not take that pan.
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const update = () => setZoomed(isZoomed(vv.scale));
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, [enabled]);

  const modes = gutterModes({ enabled, zoomed, blocked, canPrev: !!onPrev, canNext: !!onNext });

  const live = useRef({ onNext, onPrev, onBlocked, blocked, modes });
  live.current = { onNext, onPrev, onBlocked, blocked, modes };

  /** idle; out = sliding away before navigating; waiting = for the next message. */
  const phase = useRef<"idle" | "out" | "waiting">("idle");
  const pendingEnter = useRef<{ timer: number; reduced: boolean } | null>(null);
  const scrolling = useRef(false);
  const noticed = useRef(false);
  const frame = useRef(0);
  const settleTimer = useRef(0);
  const snapFrame = useRef(0);
  const guardUntil = useRef(0);
  const timers = useRef<number[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== id);
      fn();
    }, ms);
    timers.current.push(id);
    return id;
  }, []);

  const setHints = useCallback((side: "left" | "right" | null, progress: number) => {
    const l = hintLeftRef?.current;
    const r = hintRightRef?.current;
    if (l) {
      l.style.opacity = side === "left" ? String(progress) : "0";
      l.dataset.ready = side === "left" && progress >= 1 ? "true" : "false";
    }
    if (r) {
      r.style.opacity = side === "right" ? String(progress) : "0";
      r.dataset.ready = side === "right" && progress >= 1 ? "true" : "false";
    }
  }, [hintLeftRef, hintRightRef]);

  const clearSurface = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    el.style.transition = "";
    el.style.transform = "";
    el.style.opacity = "";
    el.style.willChange = "";
    delete el.dataset.swipe;
  }, []);

  /**
   * Put the page back at rest, flush with the track, without animating.
   *
   * With mandatory snapping the engine remembers the element it last snapped
   * to - after a commit, the gutter - and re-snaps to it when the layout
   * changes (the next message's gutters, its body loading). Re-snapping to a
   * whole gutter would settle there and open yet another message (seen once
   * in the iOS Simulator: one swipe, two messages on). So snapping is off
   * while the hook moves the track and comes back two frames later, at rest,
   * which makes the page the remembered target; and a settle right after
   * such a move never commits (RESNAP_GUARD_MS).
   */
  const center = useCallback(() => {
    const track = trackRef.current;
    const page = pageRef.current;
    if (!track || !page) return;
    const rest = () => restingScrollLeft({
      pageOffsetLeft: page.offsetLeft,
      scrollWidth: track.scrollWidth,
      clientWidth: track.clientWidth,
      rtl: isRtl(track),
    });
    const left = rest();
    if (Math.abs(track.scrollLeft - left) <= 0.5 && !track.style.scrollSnapType) return;
    guardUntil.current = performance.now() + RESNAP_GUARD_MS;
    track.style.scrollSnapType = "none";
    track.scrollLeft = left;
    window.cancelAnimationFrame?.(snapFrame.current);
    snapFrame.current = nextFrame(() => {
      snapFrame.current = nextFrame(() => {
        snapFrame.current = 0;
        // Mid-commit the next enter() comes back here; it restores then.
        if (phase.current !== "idle") return;
        track.scrollLeft = rest();
        track.style.scrollSnapType = "";
        guardUntil.current = performance.now() + RESNAP_GUARD_MS;
      });
    });
  }, [trackRef, pageRef]);

  /** The gutters' geometry inside the track right now. */
  const gutters = useCallback(() => {
    const track = trackRef.current;
    if (!track) return [];
    const t = track.getBoundingClientRect();
    const rtl = isRtl(track);
    const out: { dir: SwipeDirection; side: "left" | "right"; width: number; visible: number }[] = [];
    for (const [dir, ref] of [["prev", prevGutterRef], ["next", nextGutterRef]] as const) {
      const el = ref.current;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // prev is the start side: the left in LTR, the right in RTL.
      out.push({ dir, side: (dir === "prev") !== rtl ? "left" : "right", width: r.width, visible: visibleWidth(t, r) });
    }
    return out;
  }, [trackRef, prevGutterRef, nextGutterRef]);

  const enter = useCallback(() => {
    const p = pendingEnter.current;
    pendingEnter.current = null;
    if (p) window.clearTimeout(p.timer);
    phase.current = "idle";
    const track = trackRef.current;
    const root = pageRef.current;
    if (track) track.style.overflowX = "";
    center();
    setHints(null, 0);
    if (!root) return;
    const pane = paneRef?.current;
    if (pane) pane.scrollTop = 0;
    if (!p || p.reduced || !root.style.transform) {
      clearSurface(root);
      return;
    }
    root.dataset.swipe = "enter";
    root.style.transition = `transform ${IN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${IN_MS}ms ease-out`;
    root.style.transform = "translate3d(0,0,0)";
    root.style.opacity = "1";
    later(() => { if (root.dataset.swipe === "enter") clearSurface(root); }, IN_MS + 20);
  }, [trackRef, pageRef, paneRef, center, setHints, clearSurface, later]);

  /** `sign`: the way the message moved (+1 right, -1 left). */
  const commit = useCallback((direction: SwipeDirection, sign: number) => {
    const nav = direction === "next" ? live.current.onNext : live.current.onPrev;
    setHints(null, 0);
    if (!nav) { center(); return; }
    const track = trackRef.current;
    const root = pageRef.current;
    // No second swipe until the next message is in, and no re-snap to the
    // gutter meanwhile (see center()).
    if (track) {
      track.style.overflowX = "hidden";
      track.style.scrollSnapType = "none";
    }
    const reduced = prefersReducedMotion();
    const width = root?.clientWidth || window.innerWidth;
    const go = () => {
      phase.current = "waiting";
      if (root && !reduced) {
        // The next message comes in from the side the finger pulled it from.
        root.style.transition = "none";
        root.style.transform = `translate3d(${-sign * Math.round(width * 0.3)}px,0,0)`;
        root.dataset.swipe = "waiting";
      }
      const timer = later(() => enter(), ENTER_FALLBACK_MS);
      pendingEnter.current = { timer, reduced };
      nav();
    };
    if (reduced || !root) { go(); return; }
    phase.current = "out";
    root.dataset.swipe = "out";
    root.style.willChange = "transform, opacity";
    root.style.transition = `transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`;
    root.style.transform = `translate3d(${sign * width}px,0,0)`;
    root.style.opacity = "0";
    later(go, OUT_MS);
  }, [trackRef, pageRef, center, setHints, enter, later]);

  const onScrollEnd = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    scrolling.current = false;
    noticed.current = false;
    if (phase.current !== "idle") return;
    // The hook's own move settling (or the engine re-snapping after it): not a swipe.
    if (performance.now() < guardUntil.current) {
      setHints(null, 0);
      return;
    }
    const gs = gutters();
    for (const g of gs) {
      if (live.current.modes[g.dir] === "go" && isRevealed(g.visible, g.width)) {
        commit(g.dir, g.side === "left" ? 1 : -1);
        return;
      }
    }
    setHints(null, 0);
    // Settled part-way into a gutter (an engine without scroll snapping): back to rest.
    if (gs.some((g) => g.visible > 1)) {
      const track = trackRef.current;
      const page = pageRef.current;
      if (track && page) {
        const left = restingScrollLeft({
          pageOffsetLeft: page.offsetLeft, scrollWidth: track.scrollWidth, clientWidth: track.clientWidth, rtl: isRtl(track),
        });
        try { track.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" }); } catch { track.scrollLeft = left; }
      }
    }
  }, [gutters, commit, setHints, trackRef, pageRef]);

  const onScroll = useCallback(() => {
    scrolling.current = true;
    if (!hasScrollEnd()) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(onScrollEnd, SETTLE_MS);
    }
    if (phase.current !== "idle" || frame.current) return;
    const raf = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (fn: FrameRequestCallback) => { fn(performance.now()); return 0; };
    frame.current = raf(() => {
      frame.current = 0;
      if (phase.current !== "idle") return;
      let side: "left" | "right" | null = null;
      let progress = 0;
      for (const g of gutters()) {
        if (g.visible <= 0.5) continue;
        const mode = live.current.modes[g.dir];
        if (mode === "go") {
          side = g.side;
          progress = swipeProgress(g.visible, g.width);
        } else if (live.current.blocked && g.visible >= BLOCKED_NOTICE_PX && !noticed.current) {
          noticed.current = true;
          live.current.onBlocked?.();
        }
      }
      setHints(side, progress);
    });
  }, [gutters, setHints, onScrollEnd]);

  // Listen to the track's own scrolling (passive; nothing is ever prevented).
  useEffect(() => {
    const track = trackRef.current;
    if (!enabled || !track) return;
    const opts: AddEventListenerOptions = { passive: true };
    track.addEventListener("scroll", onScroll, opts);
    track.addEventListener("scrollend", onScrollEnd, opts);
    return () => {
      track.removeEventListener("scroll", onScroll);
      track.removeEventListener("scrollend", onScrollEnd);
      if (frame.current) window.cancelAnimationFrame(frame.current);
      frame.current = 0;
      window.clearTimeout(settleTimer.current);
    };
    // resetKey: the track can be a new element after another message renders.
  }, [enabled, trackRef, resetKey, onScroll, onScrollEnd]);

  // Long-presses and second fingers never swipe. Where the platform starts a
  // text selection on a long-press (iOS) the track would not move anyway; on
  // blank areas, and in engines without touch selection, the drag after a
  // long-press would pan the track - so a touch on the page (outside the body
  // frame, whose touches never reach us on WebKit and select natively there)
  // that rests before moving, or a second finger, locks the track's sideways
  // scrolling until every finger is up. Passive: nothing is prevented.
  useEffect(() => {
    const track = trackRef.current;
    if (!enabled || !track) return;
    let timer = 0;
    let locked = false;
    let moved = false;
    let x0 = 0;
    let y0 = 0;
    const lock = () => {
      if (locked || phase.current !== "idle" || scrolling.current) return;
      locked = true;
      track.style.overflowX = "hidden";
    };
    const unlock = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (!locked) return;
      locked = false;
      if (phase.current === "idle") track.style.overflowX = "";
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        window.clearTimeout(timer);
        timer = 0;
        lock();
        return;
      }
      unlock();
      moved = false;
      x0 = e.touches[0]?.clientX ?? 0;
      y0 = e.touches[0]?.clientY ?? 0;
      timer = window.setTimeout(() => {
        timer = 0;
        if (!moved) lock();
      }, LONG_PRESS_MS);
    };
    const move = (e: TouchEvent) => {
      if (moved || !timer) return;
      const t = e.touches[0];
      if (t && Math.hypot(t.clientX - x0, t.clientY - y0) >= LONG_PRESS_SLOP) {
        moved = true;
        window.clearTimeout(timer);
        timer = 0;
      }
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length === 0) unlock();
    };
    const opts: AddEventListenerOptions = { passive: true };
    track.addEventListener("touchstart", start, opts);
    track.addEventListener("touchmove", move, opts);
    track.addEventListener("touchend", end, opts);
    track.addEventListener("touchcancel", end, opts);
    return () => {
      track.removeEventListener("touchstart", start);
      track.removeEventListener("touchmove", move);
      track.removeEventListener("touchend", end);
      track.removeEventListener("touchcancel", end);
      unlock();
    };
  }, [enabled, trackRef, resetKey]);

  // At rest whenever the gutters change (a neighbour appears, a reply is typed,
  // zoom) or another message is shown - unless a commit is mid-flight.
  useLayoutEffect(() => {
    if (!enabled || phase.current !== "idle" || scrolling.current) return;
    center();
  }, [enabled, modes.prev, modes.next, resetKey, center]);

  // Keep at rest across rotation and pane resizes.
  useEffect(() => {
    const track = trackRef.current;
    if (!enabled || !track || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (phase.current === "idle" && !scrolling.current) center();
    });
    ro.observe(track);
    return () => ro.disconnect();
  }, [enabled, trackRef, resetKey, center]);

  // Another message is on screen: bring it in.
  useEffect(() => {
    if (pendingEnter.current) enter();
  }, [resetKey, enter]);

  // Leaving the phone layout (rotation, resize) or unmounting mid-swipe: no stray styles.
  useEffect(() => {
    if (enabled) return;
    phase.current = "idle";
    if (pendingEnter.current) window.clearTimeout(pendingEnter.current.timer);
    pendingEnter.current = null;
    setHints(null, 0);
    clearSurface(pageRef.current);
    const track = trackRef.current;
    if (track) {
      track.style.overflowX = "";
      track.style.scrollSnapType = "";
    }
  }, [enabled, pageRef, trackRef, setHints, clearSurface]);

  useEffect(() => () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    window.cancelAnimationFrame?.(snapFrame.current);
  }, []);

  return { modes };
}
