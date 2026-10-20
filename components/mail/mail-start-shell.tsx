// Fork (Wnt/webmail): what a page start paints before the app runs.
//
// The server renders this in place of the mail client while the client
// loads, restores its session and opens the first view: the app's own layout
// (bars, rows, the reading view) with grey placeholders, in the active theme
// (the root layout's head script sets the theme class before <body>).
//
// WebKit shows nothing of a new page until it counts as "visually non-empty":
// more than 200 characters of text, more than 32x32 px of image or <svg>, or
// the whole HTML parsed with no stylesheet or font still loading
// (LocalFrameView::qualifiesAsVisuallyNonEmpty). The old spinner with
// "Loading..." met none of these, so an iPhone kept the screen white until the
// end of the HTML, which arrives together with the start's 1.8 MB of script.
// The avatar placeholders here are <svg> elements of 40x40 px, and the
// render-blocking `rel=expect` link (Safari 18.2+, Chrome 124+) ends the hold
// as soon as the end of this shell is parsed.
//
// Static markup only: no text in a web font, no state, no handlers. It is
// inert and hidden from assistive technology, which hears one status line.

import type { ReactNode } from "react";

const BAR = "rounded bg-foreground/[0.08]";

function Avatar({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0 text-foreground/[0.08]"
      style={{ width: size, height: size }} aria-hidden="true" focusable="false">
      <circle cx="20" cy="20" r="20" fill="currentColor" />
    </svg>
  );
}

function Line({ w, h = 10, className = "" }: { w: string; h?: number; className?: string }) {
  return <div className={`${BAR} ${className}`} style={{ width: w, height: h }} />;
}

function Icon() {
  return <div className={BAR} style={{ width: 22, height: 22 }} />;
}

function PhoneMessage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-foreground/30" aria-hidden="true" focusable="false">
          <path d="m15 18-6-6 6-6" />
        </svg>
        <div className="flex gap-5">{[0, 1, 2, 3, 4, 5].map((i) => <Icon key={i} />)}</div>
      </div>
      <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <Line w="58%" h={16} />
      </div>
      <div className="flex shrink-0 gap-3 border-b border-border px-4 py-4">
        <Avatar />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <Line w="45%" />
          <Line w="62%" />
          <Line w="25%" />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-4 pt-5">
        {["94%", "88%", "91%", "70%", "0", "86%", "93%", "52%"].map((w, i) =>
          w === "0" ? <div key={i} className="h-2" /> : <Line key={i} w={w} />)}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-around border-t border-border pb-[env(safe-area-inset-bottom)]">
        {[0, 1, 2].map((i) => <Icon key={i} />)}
      </div>
    </div>
  );
}

function PhoneList() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 px-3">
        <Icon />
        <div className="h-10 flex-1 rounded-full bg-foreground/[0.06]" />
        <Avatar size={36} />
      </div>
      <div className="flex-1 overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex gap-3 border-b border-border px-4 py-4">
            <Avatar />
            <div className="flex flex-1 flex-col gap-2 pt-1">
              <Line w="38%" />
              <Line w="70%" />
              <Line w="88%" />
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-around border-t border-border pb-[env(safe-area-inset-bottom)]">
        {[0, 1, 2].map((i) => <Icon key={i} />)}
      </div>
    </div>
  );
}

function Wide() {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col gap-4 border-e border-border bg-sidebar p-4">
        <Line w="70%" h={16} />
        {rows(7).map((i) => <Line key={i} w={`${60 - (i % 3) * 10}%`} />)}
      </div>
      <div className="flex w-[22rem] shrink-0 flex-col border-e border-border">
        <div className="flex h-14 items-center border-b border-border px-4"><Line w="60%" h={14} /></div>
        {rows(8).map((i) => (
          <div key={i} className="flex gap-3 border-b border-border px-4 py-3">
            <Avatar size={36} />
            <div className="flex flex-1 flex-col gap-2 pt-1"><Line w="40%" /><Line w="75%" /><Line w="90%" /></div>
          </div>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-6">
        <Line w="50%" h={18} />
        <div className="flex gap-3 py-2"><Avatar /><div className="flex flex-1 flex-col gap-2 pt-1"><Line w="30%" /><Line w="45%" /></div></div>
        {rows(6).map((i) => <Line key={i} w={`${92 - (i % 3) * 9}%`} />)}
      </div>
    </div>
  );
}

/**
 * The start shell. `view`: the reading view (a page opened at a message or
 * conversation link) or the mail list. Phones get that view; wider screens a
 * three-pane outline.
 */
export function MailStartShell({ view, label }: { view: "message" | "list"; label: string }): ReactNode {
  return (
    <div className="fixed inset-0 bg-background pt-[env(safe-area-inset-top)]" data-mm-start-shell="">
      {/* Ends WebKit's/Chrome's hold on the first frame once the shell below is parsed (React hoists it to <head>). */}
      <link rel="expect" href="#mm-start-shell-end" {...{ blocking: "render" }} />
      <p role="status" className="sr-only">{label}</p>
      {/* Static on purpose: a pulse animation (Tailwind animate-pulse) slowed the
          start's hydration by ~0.4 s in the iOS Simulator's WebKit. */}
      <div className="h-full" inert aria-hidden="true">
        <div className="h-full md:hidden">{view === "message" ? <PhoneMessage /> : <PhoneList />}</div>
        <div className="hidden h-full md:block"><Wide /></div>
      </div>
      <div id="mm-start-shell-end" />
    </div>
  );
}
