"use client";

// Fork (Wnt/webmail): /<locale>/login in passkey-entry mode. The passkey gate
// (passkey-gate.tsx, mounted by the locale layout) is the sign-in; this route
// only asks for it - with the reason it was sent here for (a failed sign-in in
// the redirect flow) - and, once signed in, moves on to the page the visit
// was for without loading a document.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { usePasskeyGateStore } from "@/stores/passkey-gate-store";
import { toRouterPath } from "@/lib/browser-navigation";
import type { PasskeyEntryReason } from "./passkey-entry-page";

export function PasskeyLoginRoute({ target, reason }: { target: string; reason: PasskeyEntryReason }) {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (isAuthenticated) {
      router.replace(toRouterPath(target) as never);
      return;
    }
    let cancelled = false;
    // A session the browser still holds opens the app; otherwise the gate.
    useAuthStore.getState().checkAuth().finally(() => {
      if (cancelled) return;
      if (useAuthStore.getState().isAuthenticated) router.replace(toRouterPath(target) as never);
      else usePasskeyGateStore.getState().request(reason);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated, target, reason, router]);

  return null;
}
