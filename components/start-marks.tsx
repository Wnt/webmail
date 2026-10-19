"use client";

// Fork (Wnt/webmail): page-start marks for the open-speed beacon
// (lib/open-timing.ts `pageStartStages`): `mm:start:boot` when the app's own
// code first runs in this document (this module is evaluated as the root
// layout's client components are set up for hydration) and
// `mm:start:hydrated` when the server's markup has been hydrated (the first
// passive effects after the hydration commit). Timings only.

import { useEffect } from "react";
import { START_MARK_BOOT, START_MARK_HYDRATED } from "@/lib/open-timing";

function markOnce(name: string) {
  try {
    if (typeof window === "undefined" || typeof performance?.mark !== "function") return;
    if (performance.getEntriesByName(name, "mark").length === 0) performance.mark(name);
  } catch {
    // User Timing is a nicety.
  }
}

markOnce(START_MARK_BOOT);

export function StartMarks() {
  useEffect(() => {
    markOnce(START_MARK_HYDRATED);
  }, []);
  return null;
}
