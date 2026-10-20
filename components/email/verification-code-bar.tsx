"use client";

import { useId, useRef } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Copy, Key } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { selectElementText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";
import { useCodeCopy } from "./use-code-copy";

interface VerificationCodeBarProps {
  code: string;
  className?: string;
  /**
   * Fork: drawn for looks only (the phone swipe's neighbour pane, which is
   * inert): no test id or copy state, so it is never taken for the open
   * message's bar.
   */
  decorative?: boolean;
}

/**
 * Fork (Wnt/webmail): the one-time code of a fresh sign-in mail as a bar at
 * the top of the reading view - the code in large type and one big "Copy code"
 * button - so a tap on the mail's notification lands right on it.
 *
 * Nothing is copied on its own: iOS WebKit lets a page write the clipboard
 * only inside the user's tap (it refuses even right after a notification
 * tap), and copying behind the user's back would overwrite their clipboard
 * elsewhere too. So the one tap on the button does it, and the result shown
 * is the browser's answer: "Copied" only once the write succeeded; otherwise
 * the code is selected for copying by hand (or, where the browser would not
 * select it, a plain "could not copy"). Everything in the bar is the app's own
 * text plus the code the detector found (letters, digits, hyphens), never the
 * mail's words, so a mail cannot put instructions here.
 */
export function VerificationCodeBar({ code, className, decorative = false }: VerificationCodeBarProps) {
  const t = useTranslations("email_viewer.verification_code");
  const codeRef = useRef<HTMLSpanElement>(null);
  // A refusal selects the code for copying by hand (false: the browser would not).
  const { state, selected, copy } = useCodeCopy(code, { onFailed: () => selectElementText(codeRef.current) });
  const statusId = useId();
  const labelId = useId();

  const onCopy = () => {
    void copy();
  };

  const status = state === "copied"
    ? t("copied")
    : state === "failed" ? (selected ? t("copy_failed_select") : t("copy_failed")) : "";
  const ButtonIcon = state === "copied" ? Check : Copy;

  return (
    <section
      aria-labelledby={labelId}
      data-testid={decorative ? undefined : "verification-code-bar"}
      data-copy-state={decorative ? undefined : state}
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
            data-testid={decorative ? undefined : "verification-code-value"}
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
          data-testid={decorative ? undefined : "verification-code-copy"}
          className="flex-shrink-0 gap-2 px-4 min-w-[7.5rem]"
        >
          <ButtonIcon aria-hidden="true" className="w-5 h-5" />
          {state === "copied" ? t("copied_button") : t("copy_button")}
        </Button>
      </div>
      <p
        id={statusId}
        role={decorative ? undefined : "status"}
        aria-live={decorative ? undefined : "polite"}
        aria-atomic="true"
        data-testid={decorative ? undefined : "verification-code-status"}
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
