"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  MessageSwipeTracker,
  MESSAGE_SWIPE_DEFAULTS,
  swipeOffset,
  type SwipeDirection,
} from "@/lib/message-swipe";

/**
 * Swipe between messages on the phone: finger left opens the next message,
 * finger right the previous one (mirrored in RTL).
 *
 * Why native listeners, and two kinds of them:
 *  - The message body is a sandboxed, script-free iframe. Touches that start
 *    on it are dispatched to the iframe's document and never reach ours. The
 *    sandbox keeps `allow-same-origin` (the viewer already reads the parsed
 *    document to size it and to route link clicks), so the host binds its own
 *    passive listeners on that document via `attachFrame` - no script runs
 *    inside the frame and the sandbox and CSP stay as they are.
 *  - The iframe is sized to its content and the viewer's own pane scrolls, so
 *    one pane-level listener set plus the frame's covers the whole message.
 *  - Every listener is passive and nothing calls preventDefault: vertical
 *    scrolling, pinch-zoom and taps stay entirely native. Classification
 *    (angle, slop, long-press, edges, flick) lives in `lib/message-swipe.ts`.
 *  - The content follows the finger by writing `transform` on the pane
 *    directly, without a React render per touchmove.
 */

export interface UseMessageSwipeOptions {
  enabled: boolean;
  /** The pane that scrolls the message; touches on it are watched. */
  rootRef: React.RefObject<HTMLElement | null>;
  /** Fixed hint chips at the left and right edge (opacity is driven here). */
  hintLeftRef?: React.RefObject<HTMLElement | null>;
  hintRightRef?: React.RefObject<HTMLElement | null>;
  onNext?: () => void;
  onPrev?: () => void;
  /** Changes when another message is shown (its id): the new one slides in. */
  resetKey?: string | null;
}

/** Text fields, editors and anything opting out keep their own touch behaviour. */
const EXCLUDED = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-swipe], [role="slider"], video, audio';

const OUT_MS = 170;
const IN_MS = 220;
const BOUNCE_MS = 300;
/** Give up waiting for the next message to arrive and show what is there. */
const ENTER_FALLBACK_MS = 1500;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function hasSelection(doc: Document | null | undefined): boolean {
  try {
    const sel = doc?.getSelection();
    return !!sel && !sel.isCollapsed && sel.toString().length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether something between the touched node and `root` can still scroll
 * sideways in the direction the finger pushes it. Crosses from the body's
 * frame into the host document through `frame`.
 */
export function canScrollSideways(
  start: Element | null,
  fingerDx: number,
  root: Element | null,
  frame: HTMLIFrameElement | null,
): boolean {
  let el: Element | null = start;
  let inFrame = !!frame;
  while (el) {
    const doc = el.ownerDocument;
    const isFrameRoot = inFrame && (el === doc.documentElement || el === doc.body);
    if (!isFrameRoot) {
      const view = doc.defaultView;
      const ox = view ? view.getComputedStyle(el).overflowX : "visible";
      if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        const left = Math.abs(el.scrollLeft);
        const max = el.scrollWidth - el.clientWidth;
        // Finger left reveals content further along; finger right goes back.
        if (fingerDx < 0 ? left < max - 1 : left > 1) return true;
      }
    }
    if (el === root) return false;
    if (inFrame && el === doc.documentElement) {
      el = frame;
      inFrame = false;
      continue;
    }
    el = el.parentElement;
  }
  return false;
}

/** A touch in host-viewport coordinates (a frame's touches are frame-relative). */
function point(t: Touch, frame: HTMLIFrameElement | null) {
  if (!frame) return { x: t.clientX, y: t.clientY };
  // Live rect: it includes the pane's own translate and scroll.
  const r = frame.getBoundingClientRect();
  return { x: t.clientX + r.left, y: t.clientY + r.top };
}

export function useMessageSwipe({
  enabled,
  rootRef,
  hintLeftRef,
  hintRightRef,
  onNext,
  onPrev,
  resetKey,
}: UseMessageSwipeOptions) {
  const live = useRef({ enabled, onNext, onPrev });
  live.current = { enabled, onNext, onPrev };

  const tracker = useRef<MessageSwipeTracker | null>(null);
  if (!tracker.current) tracker.current = new MessageSwipeTracker();

  const gesture = useRef<{
    target: Element | null;
    frame: HTMLIFrameElement | null;
    reduced: boolean;
    claimed: boolean;
    lastDx: number;
  } | null>(null);
  const suppressClickUntil = useRef(0);
  const pendingEnter = useRef<{ timer: number } | null>(null);
  const timers = useRef<number[]>([]);
  const attached = useRef<WeakSet<Document>>(new WeakSet());

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

  const follow = useCallback((dx: number, direction: SwipeDirection) => {
    const g = gesture.current;
    const root = rootRef.current;
    if (!g || !root) return;
    g.lastDx = dx;
    const go = direction === "next" ? !!live.current.onNext : !!live.current.onPrev;
    const progress = go ? Math.min(1, Math.abs(dx) / MESSAGE_SWIPE_DEFAULTS.commitDistance) : 0;
    setHints(dx < 0 ? "right" : "left", progress);
    root.dataset.swipe = go ? "tracking" : "edge";
    if (g.reduced) return;
    root.style.transition = "none";
    root.style.willChange = "transform";
    root.style.transform = `translate3d(${swipeOffset(dx, go, root.clientWidth || window.innerWidth)}px,0,0)`;
  }, [rootRef, setHints]);

  const snapBack = useCallback(() => {
    const root = rootRef.current;
    setHints(null, 0);
    if (!root) return;
    if (prefersReducedMotion() || !root.style.transform) {
      clearSurface(root);
      return;
    }
    root.dataset.swipe = "bounce";
    root.style.transition = `transform ${BOUNCE_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
    root.style.transform = "translate3d(0,0,0)";
    later(() => { if (root.dataset.swipe === "bounce") clearSurface(root); }, BOUNCE_MS + 20);
  }, [rootRef, setHints, clearSurface, later]);

  const enter = useCallback(() => {
    const p = pendingEnter.current;
    pendingEnter.current = null;
    if (p) window.clearTimeout(p.timer);
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = 0;
    root.dataset.swipe = "enter";
    root.style.transition = `transform ${IN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${IN_MS}ms ease-out`;
    root.style.transform = "translate3d(0,0,0)";
    root.style.opacity = "1";
    later(() => { if (root.dataset.swipe === "enter") clearSurface(root); }, IN_MS + 20);
  }, [rootRef, clearSurface, later]);

  const commit = useCallback((direction: SwipeDirection, lastDx: number, reduced: boolean) => {
    const nav = direction === "next" ? live.current.onNext : live.current.onPrev;
    const root = rootRef.current;
    setHints(null, 0);
    if (!nav) { snapBack(); return; }
    if (reduced || !root) {
      if (root) clearSurface(root);
      nav();
      return;
    }
    const sign = lastDx < 0 ? -1 : 1;
    const width = root.clientWidth || window.innerWidth;
    root.dataset.swipe = "out";
    root.style.transition = `transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`;
    root.style.transform = `translate3d(${sign * width}px,0,0)`;
    root.style.opacity = "0";
    later(() => {
      // The next message comes in from the side the finger pulled it from.
      root.style.transition = "none";
      root.style.transform = `translate3d(${-sign * Math.round(width * 0.3)}px,0,0)`;
      root.dataset.swipe = "waiting";
      const timer = later(() => enter(), ENTER_FALLBACK_MS);
      pendingEnter.current = { timer };
      nav();
    }, OUT_MS);
  }, [rootRef, setHints, snapBack, clearSurface, enter, later]);

  // ---- touch plumbing -------------------------------------------------------

  const onStart = useCallback((e: TouchEvent, frame: HTMLIFrameElement | null) => {
    gesture.current = null;
    if (!live.current.enabled || pendingEnter.current) return;
    const t = e.touches[0];
    if (!t) return;
    const node = e.target as Node | null;
    const target = node?.nodeType === 1 ? (node as Element) : node?.parentElement ?? null;
    const { x, y } = point(t, frame);
    const vv = window.visualViewport;
    const excluded = !!target?.closest(EXCLUDED)
      || hasSelection(document)
      || (!!frame && hasSelection(frame.contentDocument));
    const rejected = tracker.current!.start(x, y, performance.now(), {
      width: window.innerWidth,
      height: window.innerHeight,
      rtl: document.documentElement.dir === "rtl",
    }, {
      touches: e.touches.length,
      zoomed: !!vv && vv.scale > 1.01,
      excluded,
    });
    if (rejected) return;
    gesture.current = { target, frame, reduced: prefersReducedMotion(), claimed: false, lastDx: 0 };
  }, []);

  const onMove = useCallback((e: TouchEvent, frame: HTMLIFrameElement | null) => {
    const g = gesture.current;
    if (!g || g.frame !== frame) return;
    const t = e.touches[0];
    if (!t) return;
    const { x, y } = point(t, frame);
    const r = tracker.current!.move(x, y, performance.now(), e.touches.length);
    switch (r.kind) {
      case "claim":
        if (canScrollSideways(g.target, r.dx, rootRef.current, frame)) {
          tracker.current!.veto();
          gesture.current = null;
          return;
        }
        g.claimed = true;
        follow(r.dx, r.direction);
        return;
      case "track":
        follow(r.dx, r.direction);
        return;
      case "cancel":
        snapBack();
        suppressClickUntil.current = performance.now() + 400;
        gesture.current = null;
        return;
      case "ignored":
        gesture.current = null;
        return;
      default:
        return;
    }
  }, [follow, snapBack, rootRef]);

  const onEnd = useCallback((frame: HTMLIFrameElement | null, cancelled = false) => {
    const g = gesture.current;
    if (!g || g.frame !== frame) return;
    gesture.current = null;
    const r = tracker.current!.end(performance.now());
    if (g.claimed) suppressClickUntil.current = performance.now() + 400;
    if (cancelled || r.kind === "cancel") { snapBack(); return; }
    if (r.kind === "commit") {
      if (r.direction === "next" ? live.current.onNext : live.current.onPrev) commit(r.direction, g.lastDx, g.reduced);
      else snapBack();
    } else if (g.claimed) {
      snapBack();
    }
  }, [commit, snapBack]);

  /** A claimed swipe must not also click the link or button it started on. */
  const onClickCapture = useCallback((e: Event) => {
    if (performance.now() < suppressClickUntil.current) {
      suppressClickUntil.current = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    const start = (e: TouchEvent) => onStart(e, null);
    const move = (e: TouchEvent) => onMove(e, null);
    const end = () => onEnd(null);
    const cancel = () => onEnd(null, true);
    const opts: AddEventListenerOptions = { passive: true };
    root.addEventListener("touchstart", start, opts);
    root.addEventListener("touchmove", move, opts);
    root.addEventListener("touchend", end, opts);
    root.addEventListener("touchcancel", cancel, opts);
    root.addEventListener("click", onClickCapture, true);
    return () => {
      root.removeEventListener("touchstart", start);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", cancel);
      root.removeEventListener("click", onClickCapture, true);
    };
    // resetKey: the pane can be a new element after another message renders.
  }, [enabled, rootRef, resetKey, onStart, onMove, onEnd, onClickCapture]);

  /**
   * Watch touches on the message body's parsed document. Call once per
   * document (repeat calls are ignored); the listeners go away with it.
   */
  const attachFrame = useCallback((doc: Document, frame: HTMLIFrameElement) => {
    if (attached.current.has(doc)) return;
    attached.current.add(doc);
    const opts: AddEventListenerOptions = { passive: true };
    doc.addEventListener("touchstart", (e) => onStart(e, frame), opts);
    doc.addEventListener("touchmove", (e) => onMove(e, frame), opts);
    doc.addEventListener("touchend", () => onEnd(frame), opts);
    doc.addEventListener("touchcancel", () => onEnd(frame, true), opts);
    // Window capture runs before the viewer's own document-level link handler.
    doc.defaultView?.addEventListener("click", onClickCapture, true);
  }, [onStart, onMove, onEnd, onClickCapture]);

  // Another message is on screen: bring it in.
  useEffect(() => {
    if (pendingEnter.current) enter();
  }, [resetKey, enter]);

  // Leaving mobile (rotation, resize) or unmounting mid-gesture: no stray transform.
  useEffect(() => {
    if (enabled) return;
    gesture.current = null;
    setHints(null, 0);
    clearSurface(rootRef.current);
  }, [enabled, rootRef, setHints, clearSurface]);

  useEffect(() => () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  return { attachFrame };
}
