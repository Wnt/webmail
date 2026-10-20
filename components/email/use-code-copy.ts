"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText, type CopyResult } from "@/lib/copy-text";

export type CodeCopyState = "idle" | "copying" | "copied" | "failed";

/**
 * Fork (Wnt/webmail): the copy behind the one-time-code bar and chip, owned by
 * one code. A tap starts the write at once (inside the tap, as WebKit
 * requires); a second tap while it waits does nothing; the shown state is the
 * browser's answer for this code only. When the code changes (the reader or a
 * list row reused for another message) or the component goes, the waiting
 * copy is cut loose: its late answer changes nothing and cannot unlock or
 * overwrite the new code's copy.
 */
export function useCodeCopy(code: string, opts?: { onFailed?: () => boolean; copiedMs?: number }) {
  const [shown, setShown] = useState<{ code: string; state: CodeCopyState; selected: boolean }>(
    () => ({ code, state: "idle", selected: false }),
  );
  const state: CodeCopyState = shown.code === code ? shown.state : "idle";
  const selected = shown.code === code && shown.selected;
  const op = useRef(0);
  const pending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const onFailed = useRef(opts?.onFailed);
  onFailed.current = opts?.onFailed;
  const copiedMs = opts?.copiedMs ?? 3000;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    pending.current = false;
    return () => {
      controller.abort();
      // Ends whichever copy is current now (not a node ref): its answer must not land.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      op.current++;
    };
  }, [code]);

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setShown((s) => (s.code === code && s.state === "copied" ? { ...s, state: "idle" } : s)), copiedMs);
    return () => clearTimeout(timer);
  }, [state, code, copiedMs]);

  /** Call from the click handler itself. Resolves the browser's answer, or null when this tap did nothing or was cut loose. */
  const copy = useCallback((): Promise<CopyResult | null> => {
    if (pending.current) return Promise.resolve(null);
    pending.current = true;
    const mine = ++op.current;
    setShown({ code, state: "copying", selected: false });
    // Called right here in the tap, before anything is awaited.
    return copyText(code, { signal: lifetime.current?.signal }).then((result) => {
      if (op.current !== mine) return null;
      pending.current = false;
      if (result === "copied") setShown({ code, state: "copied", selected: false });
      else if (result === "failed") setShown({ code, state: "failed", selected: onFailed.current?.() ?? false });
      else setShown({ code, state: "idle", selected: false });
      return result === "superseded" ? null : result;
    });
  }, [code]);

  return { state, selected, copy };
}
