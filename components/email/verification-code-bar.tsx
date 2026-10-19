"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Copy, Key } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { copyText, selectElementText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copying" | "copied" | "failed";

interface VerificationCodeBarProps {
  code: string;
  className?: string;
}

/**
 * Fork (Wnt/webmail): the one-time code of a fresh sign-in mail as a bar at
 * the top of the reading view - the code in large type and one big "Copy code"
 * button - so a tap on the mail's notification lands right on it.
 *
 * Nothing is copied on its own: no browser lets a page write the clipboard
 * without the user's tap (iOS WebKit refuses even right after a notification
 * tap), so the one tap on the button does it, and the result shown is the
 * browser's answer: "Copied" only once the write succeeded; otherwise the code
 * is selected for copying by hand. Everything in the bar is the app's own
 * text plus the code the detector found (letters, digits, hyphens), never the
 * mail's words, so a mail cannot put instructions here.
 */
export function VerificationCodeBar({ code, className }: VerificationCodeBarProps) {
  const t = useTranslations("email_viewer.verification_code");
  const [state, setState] = useState<CopyState>("idle");
  const codeRef = useRef<HTMLSpanElement>(null);
  const busy = useRef(false);
  const statusId = useId();
  const labelId = useId();

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [state]);

  const onCopy = () => {
    if (busy.current) return;
    busy.current = true;
    setState("copying");
    // Called right here in the tap, before anything is awaited.
    void copyText(code).then((result) => {
      busy.current = false;
      if (result === "copied") {
        setState("copied");
        return;
      }
      selectElementText(codeRef.current);
      setState("failed");
    });
  };

  const status = state === "copied" ? t("copied") : state === "failed" ? t("copy_failed_select") : "";
  const ButtonIcon = state === "copied" ? Check : Copy;

  return (
    <section
      aria-labelledby={labelId}
      data-testid="verification-code-bar"
      data-copy-state={state}
      className={cn(
        "border-b border-amber-500/30 bg-amber-500/10 px-4 lg:px-6 py-2.5",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <Key aria-hidden="true" className="hidden min-[360px]:block w-5 h-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div id={labelId} className="text-xs font-medium text-muted-foreground">
            {t("label")}
          </div>
          <span
            ref={codeRef}
            data-testid="verification-code-value"
            translate="no"
            dir="ltr"
            className={cn(
              "block font-mono font-semibold text-foreground leading-tight break-all select-all",
              code.length > 12 ? "text-lg" : "text-2xl tracking-[0.12em]",
            )}
          >
            {code}
          </span>
        </div>
        <Button
          type="button"
          size="lg"
          onClick={onCopy}
          aria-describedby={statusId}
          data-testid="verification-code-copy"
          className="flex-shrink-0 gap-2 px-4 min-w-[7.5rem]"
        >
          <ButtonIcon aria-hidden="true" className="w-5 h-5" />
          {state === "copied" ? t("copied_button") : t("copy_button")}
        </Button>
      </div>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="verification-code-status"
        className={cn(
          status ? "mt-1.5 flex items-start gap-1.5 text-sm" : "sr-only",
          state === "failed" ? "text-foreground" : "text-success",
        )}
      >
        {state === "failed" && <AlertCircle aria-hidden="true" className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />}
        {status}
      </p>
    </section>
  );
}
