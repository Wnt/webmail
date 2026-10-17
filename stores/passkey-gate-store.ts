// Fork (Wnt/webmail): the in-page passkey sign-in (components/auth/passkey-gate.tsx).
//
// While the gate is mounted (passkey-entry mode with the provider's
// first-party endpoints), a need to sign in - no session at start, a session
// that expired, an explicit sign-out - shows it over the current page instead
// of navigating to the login page, so the page the user asked for (a deep link
// from a notification, say) is simply there once signed in.

import { create } from 'zustand';
import type { PasskeyEntryReason } from '@/components/auth/passkey-entry-page';

interface PasskeyGateState {
  /** The gate is mounted and takes over sign-in. */
  active: boolean;
  /** Someone asked for a sign-in (the auth store, the login route). */
  requested: boolean;
  /** Why it is shown, when someone said (the login route's sso_error); signed-out is read from the cookie. */
  reason: PasskeyEntryReason;
  /** Where the redirect-flow fallback returns to, when someone said (the login route's target). */
  returnTo: string | null;
  /** Bumped by every completed sign-in: the page under the gate starts afresh. */
  epoch: number;
  setActive: (active: boolean) => void;
  request: (reason?: PasskeyEntryReason, returnTo?: string | null) => void;
  signedIn: () => void;
}

export const usePasskeyGateStore = create<PasskeyGateState>((set) => ({
  active: false,
  requested: false,
  reason: null,
  returnTo: null,
  epoch: 0,
  setActive: (active) => set({ active }),
  request: (reason = null, returnTo = null) => set({ requested: true, reason, returnTo }),
  signedIn: () => set((s) => ({ requested: false, reason: null, returnTo: null, epoch: s.epoch + 1 })),
}));

/** Show the gate if it is mounted; false when the caller has to navigate to the login page itself. */
export function requestPasskeyGate(): boolean {
  const s = usePasskeyGateStore.getState();
  if (!s.active) return false;
  s.request();
  return true;
}
