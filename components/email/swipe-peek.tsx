"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import type { Email } from "@/lib/jmap/types";
import { ChevronLeft, Image, ShieldAlert, Star } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { cn, formatDate, formatDateTime, formatFileSize } from "@/lib/utils";
import { emailDisplayDate } from "@/lib/email-date";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import { applyEmailLinkPolicy, plainTextToSafeHtml, sanitizePlainTextRenderedHtml } from "@/lib/email-sanitization";
import { cachedEmailContent, emailContentCacheKey, prepareEmailHtml, shouldBlockExternalFor } from "@/lib/email-content-cache";
import { collapsePlainTextQuotes, setupQuoteCollapse } from "@/lib/quote-collapse";
import { applyEmailDarkMode, emailColorScheme, emailHasNativeDarkMode } from "@/lib/email-dark-mode";
import { buildEmailFrameSrcDoc, type EmailFrameContent } from "@/lib/email-frame-doc";
import { fitEmailBodyWidth } from "@/lib/email-fit-width";
import { getRenderableHtmlBody } from "@/lib/email-body-selection";
import { collectReferencedCids, isEmbeddedInBody } from "@/lib/attachment-visibility";
import { findCalendarAttachment, isCalendarMimeType } from "@/lib/calendar-invitation";
import { extractListHeaders, getSenderVerification, parseAuthenticationResults } from "@/lib/email-headers";
import { findVerificationCode, isFreshForVerificationCode, verificationCodeBodyText } from "@/lib/verification-code";
import { getEmailTagIds } from "@/lib/thread-utils";
import { NEIGHBOUR_LITE_PREVIEW_CHARS, addPeekCost, peekKind } from "@/lib/swipe-neighbours";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { useMeasuredTagDisplay } from "@/hooks/use-tag-display";
import type { SwipeNeighbour } from "@/hooks/use-swipe-neighbours";
import { TagBadge } from "./tag-badge";
import { EmailIdentityBadge } from "./email-identity-badge";
import { UnsubscribeBanner } from "./unsubscribe-banner";
import { VerificationCodeBar } from "./verification-code-bar";
import { VerificationCodeChip } from "./verification-code-chip";
import { renderClickableRecipients } from "./recipient-list";
import { RecipientPopover } from "./recipient-popover";
import { getAttachmentDisplayName, getFileIcon } from "./attachment-display";

/**
 * Fork (Wnt/webmail): the previous or the next message as it will open, in
 * the pane beside the open message on the phone, so a sideways swipe shows
 * the real neighbour moving in with the finger (hooks/use-message-swipe.ts;
 * what is prepared and when: lib/swipe-neighbours.ts).
 *
 * It draws the first screen of the reading view - the one-time-code bar, the
 * subject, the sender block, the banners and attachments that sit above the
 * body, and the body - with the reading pane's own parts and markup, so the
 * hand-over to the reading pane after the swipe changes nothing on screen.
 * The HTML body is the very document the reading pane shows: the same
 * sanitized body (from the same cache), the same srcdoc and Content-Security-
 * Policy, the same sandbox without scripts. The pane is inert (the caller
 * marks it so): nothing in it can be focused, clicked or read out, and it
 * never marks the message read.
 *
 * `lite` (a neighbour not fetched yet, too big or a body the reading pane
 * first unwraps or decrypts): the same header and the first lines as text.
 */

const NO_CIDS: Record<string, string> = Object.freeze({}) as Record<string, string>;

interface SwipePeekProps {
  neighbour: SwipeNeighbour;
  /** The reading pane's colour mode for message bodies. */
  isDark: boolean;
  currentUserEmail?: string;
}

function headerRecord(headers: Email["headers"]): Record<string, string | string[]> | null {
  if (!headers) return null;
  if (!Array.isArray(headers)) return headers as Record<string, string | string[]>;
  const out: Record<string, string | string[]> = {};
  for (const h of headers as unknown as { name?: string; value?: string }[]) {
    if (!h?.name || !h?.value) continue;
    const prev = out[h.name];
    out[h.name] = prev ? (Array.isArray(prev) ? [...prev, h.value] : [prev, h.value]) : h.value;
  }
  return out;
}

export const SwipePeek = memo(function SwipePeek({ neighbour, isDark, currentUserEmail }: SwipePeekProps) {
  const t = useTranslations("email_viewer");
  const email = neighbour.email;
  // The header comes from the full message when it is in, else from the row.
  const shown: Email = email ?? neighbour.row;
  const kind = email ? peekKind(email) : "lite";

  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const isSenderTrusted = useSettingsStore((s) => s.isSenderTrusted);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const isTrustedAddressBookSender = useContactStore((s) => s.isTrustedAddressBookSender);
  const messageSpacing = useSettingsStore((s) => s.messageSpacing);
  const plainTextFont = useSettingsStore((s) => s.plainTextFont);
  const toolbarPosition = useSettingsStore((s) => s.toolbarPosition);
  const interfaceLayout = useSettingsStore((s) => s.interfaceLayout);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const showVerificationCodes = useSettingsStore((s) => s.showVerificationCodes);
  const hideInlineImageAttachments = useSettingsStore((s) => s.hideInlineImageAttachments);
  const calendarInvitationParsingEnabled = useSettingsStore((s) => s.calendarInvitationParsingEnabled);
  const identities = useAuthStore((s) => s.identities);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const { sortTagIds } = useKeywordFormat();
  const tagsRef = useRef<HTMLDivElement>(null);
  const { variant: tagVariant } = useMeasuredTagDisplay(tagsRef);
  const mvMobileViewer = interfaceLayout === "mountain-view";

  // The body, as the reading pane prepares it when it opens the message.
  const blockExternal = useMemo(() => !!email && shouldBlockExternalFor(email, {
    externalContentPolicy,
    allowExternalContent: false,
    isSenderTrusted,
    trustedSendersAddressBook,
    isTrustedAddressBookSender,
  }), [email, externalContentPolicy, isSenderTrusted, trustedSendersAddressBook, isTrustedAddressBookSender]);
  // The main-thread cost of preparing it, for the open-speed beacon.
  const timed = <T,>(fn: () => T): T => {
    const t0 = performance.now();
    try { return fn(); } finally { if (email) addPeekCost(email.id, performance.now() - t0); }
  };
  const prepared = useMemo(() => {
    if (!email || kind !== "full") return null;
    return timed(() => cachedEmailContent(emailContentCacheKey(email, blockExternal, NO_CIDS)) ?? prepareEmailHtml(email, blockExternal, NO_CIDS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, kind, blockExternal]);
  const content = useMemo<EmailFrameContent | null>(() => {
    if (!email || kind !== "full") return null;
    if (prepared) return prepared.content;
    const textPart = email.textBody?.[0]?.partId;
    const text = textPart ? email.bodyValues?.[textPart]?.value : undefined;
    if (text === undefined) return null;
    return {
      html: collapsePlainTextQuotes(plainTextToSafeHtml(text), { show: t("show_quoted_text"), hide: t("hide_quoted_text") }),
      isHtml: false, hasStyleTag: false, externalBlocked: false,
    };
  }, [email, kind, prepared, t]);
  const nativeDark = useMemo(() => !!content?.isHtml && emailHasNativeDarkMode(content.html), [content]);
  const srcDoc = useMemo(
    () => (content?.isHtml ? timed(() => buildEmailFrameSrcDoc(content, { isDark, nativeDarkMode: nativeDark, messageSpacing })) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, isDark, nativeDark, messageSpacing],
  );
  const plainHtml = useMemo(() => (content && !content.isHtml ? sanitizePlainTextRenderedHtml(content.html) : ""), [content]);

  const code = useMemo(
    () => (showVerificationCodes && email ? timed(() => findVerificationCode(email.subject, verificationCodeBodyText(email))) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showVerificationCodes, email],
  );
  const codeBar = code && isFreshForVerificationCode(email?.receivedAt) ? code : null;

  const headers = useMemo(() => headerRecord(email?.headers), [email?.headers]);
  const sender = shown.from?.[0];
  const listUnsubscribe = useMemo(() => {
    const list = headers ? extractListHeaders(headers).listUnsubscribe : undefined;
    return list?.preferred ? list : null;
  }, [headers]);
  const senderVerification = useMemo(() => {
    const auth = email?.authenticationResults
      ?? (headers?.["Authentication-Results"] ? parseAuthenticationResults(headers["Authentication-Results"]) : undefined);
    return getSenderVerification(auth, sender?.email);
  }, [email?.authenticationResults, headers, sender?.email]);

  const attachments = useMemo(() => {
    if (!email?.attachments?.length) return [];
    const hasInvite = calendarInvitationParsingEnabled && !!findCalendarAttachment(email);
    const bodyCids = collectReferencedCids(hideInlineImageAttachments ? getRenderableHtmlBody(email) : null);
    return email.attachments
      .filter((a) => !hasInvite || !isCalendarMimeType(a.type))
      .filter((a) => !(hideInlineImageAttachments && isEmbeddedInBody(a, bodyCids)))
      .filter((a) => a.type !== "message/disposition-notification" && a.type !== "message/delivery-status");
  }, [email, calendarInvitationParsingEnabled, hideInlineImageAttachments]);

  const tagIds = sortTagIds(getEmailTagIds(shown.keywords));
  const isImportant = shown.keywords?.["$important"];
  const isStarred = shown.keywords?.$flagged;

  // The body frame, wired up as the reading pane does once its document is
  // parsed (quote toggle, dark colours, fit to the phone's width, height,
  // broken images, the link rule). No listener of ours runs inside it.
  const frameRef = useRef<HTMLIFrameElement>(null);
  const peekId = email?.id;
  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe || !srcDoc) return;
    let done: Document | null = null;
    let raf = 0;
    let resize: ResizeObserver | null = null;
    const setup = (): boolean => {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body || doc.URL !== "about:srcdoc" || doc.readyState === "loading") return false;
        if (done === doc) return true;
        done = doc;
        const t0 = performance.now();
        setupQuoteCollapse(doc, { show: t("show_quoted_text"), hide: t("hide_quoted_text") });
        if (isDark) applyEmailDarkMode(doc, { remoteContentAllowed: !content?.externalBlocked });
        const applyHeight = () => {
          if (iframe.contentDocument !== doc) return;
          const scale = fitEmailBodyWidth(doc, { enabled: true });
          iframe.style.height = Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight) * scale) + "px";
        };
        applyHeight();
        if (typeof ResizeObserver !== "undefined") {
          resize = new ResizeObserver(applyHeight);
          resize.observe(doc.body);
        }
        doc.querySelectorAll("img").forEach((el) => {
          const img = el as HTMLImageElement;
          const hide = () => { if (img.complete && img.naturalWidth === 0 && img.getAttribute("src")) img.style.display = "none"; };
          if (img.complete) hide();
          else img.addEventListener("error", () => { img.style.display = "none"; }, { once: true });
        });
        doc.querySelectorAll("a, area").forEach(applyEmailLinkPolicy);
        if (peekId) addPeekCost(peekId, performance.now() - t0);
        return true;
      } catch {
        return true;
      }
    };
    const onFrame = () => { raf = setup() ? 0 : window.requestAnimationFrame(onFrame); };
    if (typeof window.requestAnimationFrame === "function") raf = window.requestAnimationFrame(onFrame);
    const poll = window.setInterval(() => { if (setup()) window.clearInterval(poll); }, 100);
    const stop = window.setTimeout(() => window.clearInterval(poll), 15_000);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.clearInterval(poll);
      window.clearTimeout(stop);
      resize?.disconnect();
    };
  }, [srcDoc, isDark, content?.externalBlocked, t, peekId]);

  const lite = useMemo(() => {
    if (content) return "";
    const textPart = email?.textBody?.[0]?.partId;
    const text = (textPart && email?.bodyValues?.[textPart]?.value) || shown.preview || "";
    return text.slice(0, NEIGHBOUR_LITE_PREVIEW_CHARS);
  }, [content, email, shown.preview]);

  return (
    <div
      data-swipe-peek={email ? kind : "none"}
      className="h-full w-full flex flex-col overflow-hidden bg-background"
    >
      {codeBar && <VerificationCodeBar code={codeBar} className="flex-shrink-0" decorative />}
      <div className={cn("bg-background border-b border-border")}>
        <div className="px-4 lg:px-6" style={{ paddingBlock: "var(--density-header-py)" }}>
          <div className="flex items-start justify-between gap-2 lg:gap-4">
            {toolbarPosition === "below-subject" && (
              <span className="h-11 w-11 flex-shrink-0 -ms-2 inline-flex items-center justify-center">
                <ChevronLeft className="w-5 h-5" />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-start gap-2">
                {/* The reading view's subject styling; not a heading (the pane is never read out). */}
                <div data-swipe-peek-subject="" className="text-foreground break-words min-w-0 text-lg lg:text-xl font-bold tracking-tight">
                  {shown.subject || t("no_subject")}
                </div>
                {toolbarPosition === "top" && (
                  <span className="flex-shrink-0 p-1 rounded">
                    <Star className={cn("w-4 h-4 lg:w-5 lg:h-5", isStarred ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/40")} />
                  </span>
                )}
                {isImportant && (
                  <span className="px-1.5 lg:px-2 py-0.5 bg-warning/15 text-warning rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 self-center">
                    {t("important")}
                  </span>
                )}
              </div>
              {code && !codeBar && (
                <div className="mt-1.5 flex">
                  <VerificationCodeChip code={code} className="py-1 text-sm" />
                </div>
              )}
              {tagIds.length > 0 && (
                <div ref={tagsRef} className="mt-1.5 flex flex-wrap items-center gap-1">
                  {tagIds.map((id) => <TagBadge key={id} tagId={id} variant={tagVariant} />)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {toolbarPosition === "below-subject" && (
        <div className="bg-background border-b border-border">
          <div className="px-2 sm:px-4 lg:px-6 py-1 sm:py-1.5"><div className="h-10" /></div>
        </div>
      )}
      <div className={cn(
        "flex-1 min-h-0 overflow-hidden",
        mvMobileViewer ? "bg-background" : "bg-muted/30",
      )}>
        <div className="min-h-full flex flex-col">
          <div className="lg:hidden bg-background border-b border-border px-4" style={{ paddingBlock: "var(--density-header-py)" }}>
            <div className="flex items-start" style={{ gap: "var(--density-item-gap)" }}>
              <span className="flex-shrink-0">
                <Avatar name={sender?.name} email={sender?.email} size="lg" className="shadow-sm w-10 h-10" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {sender?.email ? (
                    <RecipientPopover name={sender.name} email={sender.email} className="text-sm font-semibold text-start" />
                  ) : (
                    <span className="text-sm font-semibold text-foreground">{t("unknown_sender")}</span>
                  )}
                  {email && <EmailIdentityBadge email={email} identities={identities} />}
                  {listUnsubscribe && (
                    <UnsubscribeBanner
                      listUnsubscribe={listUnsubscribe}
                      senderEmail={sender?.email || ""}
                      onSendMailtoUnsubscribe={async () => {}}
                      onDismiss={() => {}}
                    />
                  )}
                </div>
                {!mvMobileViewer && sender?.email && sender?.name && (
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">{sender.email}</div>
                )}
                <div className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
                  {shown.to && shown.to.length > 0 && (
                    <>
                      <span>→ {t("recipient_to_prefix")}</span>
                      {renderClickableRecipients(shown.to, currentUserEmail, t)}
                    </>
                  )}
                  {shown.cc && shown.cc.length > 0 && (
                    <>
                      <span className="text-muted-foreground/50">|</span>
                      <span>CC:</span>
                      {renderClickableRecipients(shown.cc, currentUserEmail, t)}
                      {shown.cc.length > 2 && <span>+{shown.cc.length - 2}</span>}
                    </>
                  )}
                  <span className="text-xs text-muted-foreground flex items-center gap-0.5 ms-1">{t("show_details")}</span>
                </div>
              </div>
              <div className="sm:hidden flex-shrink-0 text-end ms-2">
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {mvMobileViewer
                    ? formatDate(emailDisplayDate(shown))
                    : formatDateTime(emailDisplayDate(shown), timeFormat, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}
                </span>
                {shown.size > 0 && !mvMobileViewer && (
                  <div className="text-xs text-muted-foreground/60">{formatFileSize(shown.size)}</div>
                )}
              </div>
            </div>
          </div>

          {(senderVerification || (prepared?.blockedExternalContent && externalContentPolicy !== "allow")) && (
            <div className="border-b border-border bg-muted/30 isolate">
              <div className="px-6 py-1.5">
                <div className="flex flex-col gap-3 isolate">
                  {senderVerification && (
                    <div className="flex items-start gap-3 py-1">
                      <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm",
                        senderVerification.status === "failed" ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning",
                      )}>
                        <ShieldAlert className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {senderVerification.status === "failed" ? t("sender_check.failed_label") : t("sender_check.unverified_label")}
                        </div>
                        <div className="text-sm font-medium text-foreground break-words">
                          {senderVerification.status === "failed"
                            ? senderVerification.sentFrom
                              ? t("sender_check.failed_sent_from", { domain: senderVerification.domain, host: senderVerification.sentFrom })
                              : t("sender_check.failed", { domain: senderVerification.domain })
                            : senderVerification.sentFrom
                              ? t("sender_check.unverified_sent_from", { domain: senderVerification.domain, host: senderVerification.sentFrom })
                              : t("sender_check.unverified", { domain: senderVerification.domain })}
                        </div>
                        <div className="text-sm text-muted-foreground break-words">{t("sender_check.caution")}</div>
                      </div>
                    </div>
                  )}
                  {prepared?.blockedExternalContent && externalContentPolicy !== "allow" && (
                    <div className="flex items-start gap-3 py-1">
                      <div className="w-10 h-10 rounded-full bg-info/15 text-info flex items-center justify-center flex-shrink-0 shadow-sm">
                        <Image className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0 space-y-2">
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">External Content</div>
                          <div className="text-sm font-medium text-foreground break-words">{t("external_content_warning")}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {externalContentPolicy === "ask" && (
                            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground px-3 py-1.5 rounded-md border border-border min-h-[36px]">
                              <Image className="w-3.5 h-3.5" />
                              {t("load_external_content")}
                            </span>
                          )}
                          {sender?.email && !senderVerification && (
                            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground px-3 py-1.5 rounded-md border border-border min-h-[36px]">
                              {t("trust_sender")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="lg:hidden bg-background border-b border-border px-4 py-2">
              <div className="relative flex items-center gap-1.5 flex-wrap">
                {attachments.slice(0, 2).map((a, i) => {
                  const FileIcon = getFileIcon(a.name || undefined, a.type);
                  return (
                    <div key={a.blobId || i} className="bg-muted/60 rounded-md border border-border/50 relative overflow-hidden inline-flex items-center gap-1.5 px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <span className="text-sm text-foreground truncate max-w-[200px]">{getAttachmentDisplayName(a.name, a.type)}</span>
                        <span className="text-xs text-muted-foreground flex-shrink-0">{formatFileSize(a.size)}</span>
                      </div>
                    </div>
                  );
                })}
                {attachments.length > 2 && (
                  <span className="text-xs text-muted-foreground px-1.5">+{attachments.length - 2}</span>
                )}
              </div>
            </div>
          )}

          <div className="grow shrink-0 flex flex-col">
            <div
              className={cn(
                "email-content-wrapper overflow-x-auto",
                !isDark && resolvedTheme === "dark" ? "bg-white email-content-light" : "bg-background",
              )}
              style={isDark ? { backgroundColor: "#121212" } : undefined}
            >
              {content?.isHtml ? (
                <iframe
                  ref={frameRef}
                  srcDoc={srcDoc}
                  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                  title="Neighbouring message"
                  tabIndex={-1}
                  className="w-full border-0 block"
                  scrolling="no"
                  style={{ minHeight: "100px", colorScheme: emailColorScheme(isDark, nativeDark) }}
                />
              ) : content ? (
                <div
                  className="email-content-text text-foreground"
                  dir="auto"
                  dangerouslySetInnerHTML={{ __html: plainHtml }}
                  style={{
                    ...(plainTextFont === "mono" && { fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }),
                    fontSize: "14px",
                    lineHeight: "1.6",
                    wordBreak: "break-word",
                    whiteSpace: "pre-wrap",
                  }}
                />
              ) : (
                <div className="email-content-text text-muted-foreground" dir="auto" data-swipe-peek-lite=""
                  style={{ fontSize: "14px", lineHeight: "1.6", wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                  {lite}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
