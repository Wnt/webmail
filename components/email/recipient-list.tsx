"use client";

import type { ContactCard } from "@/lib/jmap/types";
import { RecipientPopover } from "./recipient-popover";

/** The first `maxVisible` recipients as contact popovers ("me" for the user's own address). */
export function renderClickableRecipients(
  recipients: Array<{ name?: string; email: string }>,
  currentUserEmail: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
  onViewContact?: (contact: ContactCard | null, email: string) => void,
  maxVisible: number = 2
) {
  const visible = recipients.slice(0, maxVisible);
  return visible.map((r, index) => {
    const isMe = currentUserEmail &&
      (r.email.toLowerCase() === currentUserEmail.toLowerCase() ||
       r.email.toLowerCase().startsWith(currentUserEmail.toLowerCase().split('@')[0] + '+'));

    return (
      <span key={r.email + index} className="inline-flex items-center">
        {index > 0 && <span className="text-muted-foreground me-1">,</span>}
        <RecipientPopover
          name={r.name}
          email={r.email}
          displayLabel={isMe ? t('recipient_me') : undefined}
          onViewContact={onViewContact}
          className="text-sm"
        />
      </span>
    );
  });
}
