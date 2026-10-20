"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  gutterModes,
  isRevealed,
  isZoomed,
  restingScrollLeft,
  visibleWidth,
  type GutterModes,
  type SwipeDirection,
} from "@/lib/message-swipe";
import { afterBodyPainted, markSwipeDone, noteSwipeCommit, type SwipePreload } from "@/lib/open-timing";

/**
 * Swipe between messages on the phone: finger left opens the next message,
 * finger right the previous one (mirrored in RTL).
 *
 * The swipe is native horizontal scrolling (see `lib/message-swipe.ts` for
 * why): the caller renders a horizontal scroll-snap track holding
 *   [prev pane] [the message page] [next pane]
 * where a `go` side is a pane as wide as the page showing that neighbour as
 * it will open (components/email/swipe-peek.tsx), so the real next message
 * moves in with the finger. The browser's own snapping settles the track on
 * the page or on a pane; settling on a whole pane opens that neighbour.
 *
 * Nothing slides or fades after the snap: the track stays on the pane while
 * the reading page behind it takes the new message (taken from memory when
 * it was prepared, so no fetch), and once that page's body is on screen the
 * track is put back on the page in one step. Pane and page show the same
 * thing, so the hand-over is not seen. While a commit is in flight the panes
 * keep what they show (`committing`), and a second swipe waits.
 *
 * It needs no touch listeners for the swipe itself, so touches that start on
 * the sandboxed body iframe (where WebKit runs no listener of ours) work like
 * any other, and nothing here can get in the way of scrolling, zoom,
 * selection or typing. The only touch listeners (passive) lock the track
 * during a long-press or while a second finger is down, and note the
 * release for the open-speed beacon.
 */

export interface UseMessageSwipeOptions {
  enabled: boolean;
  /** The horizontal scroll-snap track (position: relative). */
  trackRef: React.RefObject<HTMLElement | null>;
  /** The message page between the panes. */
  pageRef: React.RefObject<HTMLElement | null>;
  /** The pane inside the page that scrolls the message vertically. */
  paneRef?: React.RefObject<HTMLElement | null>;
  prevGutterRef: React.RefObject<HTMLElement | null>;
  nextGutterRef: React.RefObject<HTMLElement | null>;
  onNext?: () => void;
  onPrev?: () => void;
  /** Leaving would lose something (an unsent quick reply): never navigate. */
  blocked?: boolean;
  /** A swipe was tried while blocked (once per gesture). */
  onBlocked?: () => void;
  /** Changes when another message is shown (its id). */
  resetKey?: string | null;
  /** What each side's pane shows right now (for the open-speed beacon). */
  preload?: { prev: SwipePreload; next: SwipePreload };
  /** The page is loading the message it was asked to show (the open's fetch). */
  loading?: boolean;
}

/**
 * Give up waiting for the next message and go back to the page as it is. The
 * pane shows the message being opened meanwhile; an open that ends without a
 * new message (a failed fetch) goes back at once.
 */
const COMMIT_FALLBACK_MS = 6000;
/** The longest the track waits on the pane for the page's body to be on screen. */
const BODY_WAIT_MS = 1200;
/** A neighbour pane this close to wholly in view (px) is in place: the swipe opens it. */
const COMMIT_SLACK_PX = 4;
/** A blocked swipe this far into a gutter says why it does not navigate. */
const BLOCKED_NOTICE_PX = 16;
/** Without `scrollend` (older engines): settled after this long without a scroll event. */
const SETTLE_MS = 180;
/**
 * After the hook itself moves the track (back to rest, the hand-over), a
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
  onNext,
  onPrev,
  blocked = false,
  onBlocked,
  resetKey,
  preload,
  loading = false,
}: UseMessageSwipeOptions): { modes: GutterModes; committing: boolean } {
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

  const liveModes = gutterModes({ enabled, zoomed, blocked, canPrev: !!onPrev, canNext: !!onNext });
  // While a commit is in flight the track keeps its shape: the pane it rests
  // on must stay where it is until the page has taken the new message.
  const [committing, setCommitting] = useState(false);
  const frozenModes = useRef(liveModes);
  if (!committing) frozenModes.current = liveModes;
  const modes = committing ? frozenModes.current : liveModes;

  const live = useRef({ onNext, onPrev, onBlocked, blocked, modes, preload });
  live.current = { onNext, onPrev, onBlocked, blocked, modes, preload };

  /** idle; committing = settled on a pane, the page is taking the neighbour. */
  const phase = useRef<"idle" | "committing">("idle");
  const pending = useRef<{ fromKey: string | null | undefined; timer: number; cancelWait?: () => void; sawLoading?: boolean } | null>(null);
  const handOver = useRef<string | null>(null);
  const scrolling = useRef(false);
  const noticed = useRef(false);
  const frame = useRef(0);
  const settleTimer = useRef(0);
  const snapFrame = useRef(0);
  const guardUntil = useRef(0);
  const timers = useRef<number[]>([]);
  // The swipe's timing (lib/open-timing.ts): when this gesture's scrolling
  // began, when a finger last left the track (WebKit reports no touch that
  // started on the body frame), and when the track settled.
  const gestureAt = useRef(0);
  const releaseAt = useRef(-1);
  const resetKeyRef = useRef(resetKey);
  resetKeyRef.current = resetKey;

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== id);
      fn();
    }, ms);
    timers.current.push(id);
    return id;
  }, []);

  /**
   * Put the page back at rest, flush with the track, without animating.
   *
   * With mandatory snapping the engine remembers the element it last snapped
   * to - after a commit, the pane - and re-snaps to it when the layout
   * changes (new panes, the body loading). Re-snapping to a whole pane would
   * settle there and open yet another message (seen once in the iOS
   * Simulator: one swipe, two messages on). So snapping is off while the hook
   * moves the track and comes back two frames later, at rest, which makes the
   * page the remembered target; and a settle right after such a move never
   * commits (RESNAP_GUARD_MS).
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
        // Mid-commit the hand-over comes back here; it restores then.
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

  /**
   * The hand-over: the page has the new message (or gave up waiting); put the
   * track back on the page and let the panes take the new neighbours - in one
   * commit, before the next frame (the layout effect below centres).
   */
  const finish = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    window.clearTimeout(p.timer);
    p.cancelWait?.();
    phase.current = "idle";
    scrolling.current = false;
    const track = trackRef.current;
    if (track) track.style.overflowX = "";
    handOver.current = resetKeyRef.current ?? null;
    setCommitting(false);
  }, [trackRef]);

  const commit = useCallback((direction: SwipeDirection) => {
    const nav = direction === "next" ? live.current.onNext : live.current.onPrev;
    const snapAt = performance.now();
    const release = releaseAt.current >= gestureAt.current && releaseAt.current <= snapAt ? releaseAt.current : undefined;
    if (!nav) { center(); return; }
    const track = trackRef.current;
    // No second swipe until the page has the new message, and no re-snap to
    // the pane meanwhile (see center()).
    if (track) {
      track.style.overflowX = "hidden";
      track.style.scrollSnapType = "none";
    }
    phase.current = "committing";
    setCommitting(true);
    pending.current = { fromKey: resetKeyRef.current, timer: later(finish, COMMIT_FALLBACK_MS) };
    noteSwipeCommit({ release, snap: snapAt, pre: live.current.preload?.[direction] ?? "none" });
    nav();
  }, [trackRef, center, later, finish]);

  // The page shows another message: wait (on the pane) until its body is on
  // screen, then hand over.
  useEffect(() => {
    const p = pending.current;
    if (!p || !resetKey || resetKey === p.fromKey) return;
    const pane = paneRef?.current;
    if (pane) pane.scrollTop = 0;
    p.cancelWait?.();
    p.cancelWait = afterBodyPainted(resetKey, finish, BODY_WAIT_MS);
  }, [resetKey, paneRef, finish]);

  // The open ended without another message (it failed): back to the page now.
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    if (loading) { p.sawLoading = true; return; }
    if (p.sawLoading && resetKeyRef.current === p.fromKey) finish();
  }, [loading, finish]);

  const onScrollEnd = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    scrolling.current = false;
    noticed.current = false;
    if (phase.current !== "idle") return;
    const gs = gutters();
    // The hook's own move settling (or the engine re-snapping after it): not
    // a swipe. Never left resting on a pane, though.
    if (performance.now() < guardUntil.current) {
      if (gs.some((g) => g.visible > 1)) center();
      return;
    }
    for (const g of gs) {
      if (live.current.modes[g.dir] === "go" && isRevealed(g.visible, g.width)) {
        commit(g.dir);
        return;
      }
    }
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
  }, [gutters, commit, center, trackRef, pageRef]);

  const onScroll = useCallback(() => {
    if (!scrolling.current) gestureAt.current = performance.now();
    scrolling.current = true;
    if (!hasScrollEnd()) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(onScrollEnd, SETTLE_MS);
    }
    // The pane is in place (within COMMIT_SLACK_PX): open it now. WebKit's
    // snap creeps over the last pixels and reports `scrollend` ~0.1-0.2 s
    // after the motion is over; the pane is the page's next state either way.
    // (A pane is wholly in view only at the track's end, so only a finished
    // swipe gets here, even with the finger still down.)
    if (phase.current === "idle" && performance.now() >= guardUntil.current) {
      for (const g of gutters()) {
        if (live.current.modes[g.dir] === "go" && isRevealed(g.visible, g.width, COMMIT_SLACK_PX)) {
          commit(g.dir);
          return;
        }
      }
    }
    if (phase.current !== "idle" || frame.current || !live.current.blocked || noticed.current) return;
    const raf = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (fn: FrameRequestCallback) => { fn(performance.now()); return 0; };
    frame.current = raf(() => {
      frame.current = 0;
      if (phase.current !== "idle" || noticed.current) return;
      for (const g of gutters()) {
        if (live.current.modes[g.dir] !== "go" && g.visible >= BLOCKED_NOTICE_PX) {
          noticed.current = true;
          live.current.onBlocked?.();
          return;
        }
      }
    });
  }, [gutters, onScrollEnd, commit]);

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
      if (e.touches.length !== 0) return;
      unlock();
      const nowMs = performance.now();
      // Event.timeStamp is on the performance.now() clock in current engines.
      releaseAt.current = e.timeStamp > 0 && e.timeStamp <= nowMs ? e.timeStamp : nowMs;
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
  // zoom), another message is shown, or a hand-over finished - unless a
  // commit is mid-flight. Before paint, so the hand-over is one frame.
  useLayoutEffect(() => {
    if (!enabled || phase.current !== "idle" || (scrolling.current && !handOver.current)) return;
    center();
    const shownId = handOver.current;
    if (shownId) {
      handOver.current = null;
      markSwipeDone(shownId);
    }
  }, [enabled, modes.prev, modes.next, resetKey, committing, center]);

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

  // Leaving the phone layout (rotation, resize) or unmounting mid-swipe: no stray styles.
  useEffect(() => {
    if (enabled) return;
    const p = pending.current;
    pending.current = null;
    if (p) { window.clearTimeout(p.timer); p.cancelWait?.(); }
    phase.current = "idle";
    setCommitting(false);
    const track = trackRef.current;
    if (track) {
      track.style.overflowX = "";
      track.style.scrollSnapType = "";
    }
  }, [enabled, trackRef]);

  useEffect(() => () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    window.cancelAnimationFrame?.(snapFrame.current);
    pending.current?.cancelWait?.();
  }, []);

  return { modes, committing };
}
