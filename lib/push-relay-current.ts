// Fork (Wnt/webmail): the relay to register with, resolved from the FULL admin
// policy. Before the server can see a session it serves only the public policy
// subset, which carries no relay list and no lock; resolving from that picked
// the built-in relay even when the admin had locked another one. Fetch the full
// policy first, then resolve.

import { resolveActiveRelayUrl } from '@/lib/push-relays';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';

export async function currentRelayUrl(): Promise<string> {
  await usePolicyStore.getState().refreshIfPartial();
  return resolveActiveRelayUrl(
    usePolicyStore.getState().policy,
    useSettingsStore.getState().pushRelayUrl,
  );
}
