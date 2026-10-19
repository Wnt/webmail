"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Key } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { Email } from "@/lib/jmap/types";
import { listVerificationCode } from "@/lib/verification-code";
import { copyText } from "@/lib/copy-text";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { CHIP_BOX_CLASS, CHIP_ICON_CLASS } from "./attachment-chips";

/** The code a list row offers: found in the subject and preview of a fresh mail. */
export function useListVerificationCode(email: Email): string | null {
  const enabled = useSettingsStore((state) => state.showVerificationCodes);
  const { subject, preview, receivedAt } = email;
  return useMemo(
    () => (enabled ? listVerificationCode({ subject, preview, receivedAt }) : null),
    [enabled, subject, preview, receivedAt],
  );
}

interface VerificationCodeChipProps {
  code: string;
  className?: string;
}

/** The one-time code of a sign-in mail (lib/verification-code.ts); a click copies it. */
export function VerificationCodeChip({ code, className }: VerificationCodeChipProps) {
  const t = useTranslations("email_viewer.verification_code");
  const [copied, setCopied] = useState(false);
  // One write at a time: a second click while the first waits writes nothing.
  const busy = useRef(false);
  // Aborted when the chip goes: a copy still waiting then changes nothing.
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // copyText starts the write in the click itself (browsers allow it only
  // there) and says "copied" only when the browser confirmed it.
  const copy = async () => {
    if (busy.current) return;
    busy.current = true;
    const signal = lifetime.current?.signal;
    const result = await copyText(code, { signal });
    busy.current = false;
    if (signal?.aborted || result === "superseded") return;
    if (result === "copied") {
      setCopied(true);
      toast.success(t("copied"));
    } else {
      toast.error(t("copy_failed"));
    }
  };

  const Icon = copied ? Check : Key;
  return (
    <button
      type="button"
      // In a list row the row itself opens the message; the chip must not do both.
      onClick={(e) => { e.stopPropagation(); void copy(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={t("copy", { code })}
      aria-label={t("copy", { code })}
      data-testid="verification-code-chip"
      className={cn(CHIP_BOX_CLASS, "flex-shrink-0 bg-background/60 font-medium text-foreground hover:bg-muted", className)}
    >
      <Icon className={cn(CHIP_ICON_CLASS, copied ? "text-success" : "text-amber-600 dark:text-amber-400")} />
      <span className="font-mono tracking-wide">{code}</span>
    </button>
  );
}
