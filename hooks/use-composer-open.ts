"use client";

import { useSyncExternalStore } from "react";

// Every mounted EmailComposer ref-counts `data-composer-open` on <html>
// (see email-composer.tsx). Corner cards (install, push onboarding) read it
// here so they never sit over the composer's Send button.
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-composer-open"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): boolean {
  return document.documentElement.dataset.composerOpen !== undefined;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useComposerOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Placement shared by the bottom-corner onboarding cards. Below `md` the
// mobile shell has a bottom navigation bar (or the viewer's action bar) and
// the floating Compose button above it, so the card sits clear of both.
export const CORNER_CARD_POSITION =
  "fixed z-50 left-4 right-4 bottom-[calc(9rem+env(safe-area-inset-bottom))] md:left-auto md:bottom-4 md:right-4";
