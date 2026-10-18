"use client";

import { useSyncExternalStore } from "react";

// Every mounted EmailComposer ref-counts `data-composer-open` on <html>
// (see email-composer.tsx), and the mail list's welcome card ref-counts
// `data-welcome-open` while it is on screen (welcome-banner.tsx). Corner
// cards (install, push onboarding) read them here so they never sit over
// the composer's Send button, and so a fresh device shows one onboarding
// card at a time instead of the welcome card and a corner card together.
const FLAGS = ["data-composer-open", "data-welcome-open"];

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: FLAGS,
  });
  return () => observer.disconnect();
}

function composerOpenSnapshot(): boolean {
  return document.documentElement.dataset.composerOpen !== undefined;
}

function cornerCardsAsideSnapshot(): boolean {
  const { dataset } = document.documentElement;
  return dataset.composerOpen !== undefined || dataset.welcomeOpen !== undefined;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useComposerOpen(): boolean {
  return useSyncExternalStore(subscribe, composerOpenSnapshot, getServerSnapshot);
}

/** True while a corner card should step aside: a composer is open or the welcome card is up. */
export function useCornerCardsAside(): boolean {
  return useSyncExternalStore(subscribe, cornerCardsAsideSnapshot, getServerSnapshot);
}

/**
 * Ref-counts `data-welcome-open` on <html> until the returned function is
 * called (same scheme as the composer's `data-composer-open`).
 */
export function holdWelcomeOpen(): () => void {
  const root = document.documentElement;
  root.dataset.welcomeOpen = String(Number(root.dataset.welcomeOpen ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = Number(root.dataset.welcomeOpen ?? 1) - 1;
    if (left > 0) root.dataset.welcomeOpen = String(left);
    else delete root.dataset.welcomeOpen;
  };
}

// Placement shared by the bottom-corner onboarding cards. Below `md` the
// mobile shell has a bottom navigation bar (or the viewer's action bar) and
// the floating Compose button above it, so the card sits clear of both.
//
// Layer: the cards are mounted last at the root of the app, so at the
// dialogs' z-50 they painted over every open dialog, and on a phone over
// everything inside the full-screen viewer/composer pane, whose fixed
// position makes it a stacking context that caps its children at its own
// z-30 (the email source dialog, the More panel).
// - Phone: z-20, under that pane and everything above it (bars, drawers,
//   menus, dialogs); the cards float over the list only.
// - `md` and up (no fixed pane): z-40, still above the list's floating
//   Compose button (z-40, earlier in the document) where the two share the
//   bottom-right corner, and under drawers, menus and dialogs (z-50 and up).
export const CORNER_CARD_POSITION =
  "fixed z-20 md:z-40 left-4 right-4 bottom-[calc(9rem+env(safe-area-inset-bottom))] md:left-auto md:bottom-4 md:right-4";
