"use client";

import { useMemo } from "react";
import type { Email } from "@/lib/jmap/types";
import { shouldBlockExternalFor } from "@/lib/email-content-cache";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore } from "@/stores/contact-store";

/**
 * Fork (Wnt/webmail): whether a message's external content (remote images,
 * fonts, media) is blocked, decided one way for the reading pane and for the
 * phone swipe's neighbour panes (components/email/swipe-peek.tsx), so the two
 * can never disagree about the same message.
 *
 * The decision follows lib/email-content-cache.ts shouldBlockExternalFor: the
 * external-content policy, this message's own "Load images" permission, and
 * whether the sender is trusted (the trusted-sender list, or the trusted-
 * senders address book when that is on). It subscribes to those lists, so a
 * message prepared before the address book has loaded is decided again when
 * it arrives (a neighbour prepared early used to keep "unknown sender,
 * blocked" while the reading pane, deciding later, loaded its pictures).
 */
export function useBlockExternal(email: Pick<Email, "from"> | null | undefined, allowExternalContent: boolean): boolean {
  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const trustedSenders = useSettingsStore((s) => s.trustedSenders);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const trustedSenderEmails = useContactStore((s) => s.trustedSenderEmails);
  const sender = email?.from?.[0]?.email?.toLowerCase() ?? "";
  return useMemo(() => {
    if (!email) return false;
    return shouldBlockExternalFor(email, {
      externalContentPolicy,
      allowExternalContent,
      isSenderTrusted: useSettingsStore.getState().isSenderTrusted,
      trustedSendersAddressBook,
      isTrustedAddressBookSender: useContactStore.getState().isTrustedAddressBookSender,
    });
    // The trust lists are inputs: a change re-decides (they are read through the stores' own predicates).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!email, sender, externalContentPolicy, allowExternalContent, trustedSenders, trustedSendersAddressBook, trustedSenderEmails]);
}
