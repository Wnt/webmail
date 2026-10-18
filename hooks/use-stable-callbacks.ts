import { useRef } from 'react';

/**
 * Fork (Wnt/webmail): the same props with every function prop swapped for a
 * stand-in that keeps its identity across renders and calls the function the
 * props carry now. Lets a memoised child skip the renders its parent makes for
 * unrelated reasons (an inline `onX={() => ...}` is a new function each time),
 * while every call still reaches the parent's current handler.
 *
 * Only for event-style callbacks: a function the child calls during render
 * (a render prop) must stay out of it, or a memoised child would keep stale
 * output. A prop that changes between a function and undefined changes the
 * stand-in too, so `onX ? ... : ...` checks in the child still work.
 */
export function useStableCallbacks<P extends object>(props: P): P {
  const latest = useRef(props);
  latest.current = props;
  const standIns = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const out = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'function') {
      out[key] = value;
      continue;
    }
    let fn = standIns.current.get(key);
    if (!fn) {
      fn = (...args: unknown[]) => {
        const current = (latest.current as Record<string, unknown>)[key];
        return typeof current === 'function' ? (current as (...a: unknown[]) => unknown)(...args) : undefined;
      };
      standIns.current.set(key, fn);
    }
    out[key] = fn;
  }
  return out as P;
}
