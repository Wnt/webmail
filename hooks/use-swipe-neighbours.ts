"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Email } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { afterBodyPainted } from "@/lib/open-timing";
import { resolveEmailBlobContext } from "@/stores/email-store";
import type { SwipePreload } from "@/lib/open-timing";
import {
  NEIGHBOUR_CACHE_SIZE,
  NEIGHBOUR_PRIME_MAX_AGE_MS,
  NEIGHBOUR_REMEMBER_MAX_CHARS,
  bodyChars,
  neighbourFetchable,
  peekKind,
  saveDataRequested,
  whenIdle,
} from "@/lib/swipe-neighbours";

/**
 * Fork (Wnt/webmail): the previous and the next message of the open one on
 * the phone, fetched ahead so the swipe between messages shows them while the
 * finger moves and opens them with no fetch (rules: lib/swipe-neighbours.ts).
 *
 * `prevRow` / `nextRow` are the list rows the swipe opens. Once the open
 * message's body is on screen, at idle, each neighbour not yet in memory is
 * fetched (the next one first, or the side of the last swipe), one after the
 * other. Fetching is an Email/get only: a neighbour is never marked read
 * here; the reading pane marks the message it shows, by its own rule.
 *
 * `prime(row)`, called right before the swipe opens `row`, hands the copy in
 * memory (or its fetch still under way) to the client with the row's current
 * flags, so the open's getEmail takes it instead of asking the server.
 *
 * The copies live here only (JMAPClient.fetchEmailAhead keeps nothing), at
 * most NEIGHBOUR_CACHE_SIZE, for one client; each carries the session it was
 * fetched in (JMAPClient.getSessionScope: a generation, the user, the API URL
 * and the mail account) and counts only while the client is still in it -
 * checked when it is looked up, when its fetch ends and, by the client, when
 * it is handed over. The caller turns the swipe off for messages that are not
 * the signed-in account's own (another login, a shared folder).
 */

export interface SwipeNeighbour {
  /** The list row the swipe opens. */
  row: Email;
  /** Its full message once fetched (or kept from earlier), else null. */
  email: Email | null;
}

export interface SwipeNeighbours {
  prev: SwipeNeighbour | null;
  next: SwipeNeighbour | null;
}

export interface UseSwipeNeighboursOptions {
  client: IJMAPClient | null | undefined;
  /** The phone's single-message reading view. */
  enabled: boolean;
  /** The open message (full). */
  current: Email | null | undefined;
  prevRow?: Email | null;
  nextRow?: Email | null;
}

const keyOf = (scope: string, id: string) => `${scope}\u0000${id}`;

/**
 * `row` is a message of the signed-in account itself, as the open resolves its
 * owner (stores/email-store.ts resolveEmailBlobContext): not another login's,
 * not a shared folder's, not a source-stamped row; and not a draft. Only such
 * messages are fetched ahead, kept or handed over (JMAP ids are only unique
 * within one account).
 */
export function swipeOwnsRow(row: Email | null | undefined, client: IJMAPClient | null | undefined): boolean {
  if (!row || !client || !neighbourFetchable(row)) return false;
  const owner = resolveEmailBlobContext(row, client);
  return owner.client === client && !owner.accountId;
}

/** A full message kept for the swipe, with the session it was fetched in. */
interface Kept { email: Email; scope: string }
interface PendingFetch { promise: Promise<Email | null>; scope: string }

export function useSwipeNeighbours({ client, enabled, current, prevRow, nextRow }: UseSwipeNeighboursOptions): {
  neighbours: SwipeNeighbours | null;
  prime: (row: Email) => SwipePreload;
  /** The side the user last swiped to: its neighbour is fetched first. */
  noteDirection: (dir: "prev" | "next") => void;
} {
  // Full messages in memory, least recently used first, and the fetches under
  // way; for one client. Each carries the session it was fetched in, and only
  // counts while the client is still in that session (checked live: a session
  // can change without a render).
  const cache = useRef<{ client: IJMAPClient | null | undefined; map: Map<string, Kept>; pending: Map<string, PendingFetch> }>(
    { client, map: new Map(), pending: new Map() });
  if (cache.current.client !== client) cache.current = { client, map: new Map(), pending: new Map() };
  const [version, setVersion] = useState(0);
  const lastDir = useRef<"prev" | "next">("next");
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const liveScope = useCallback(() => client?.getSessionScope?.() ?? "", [client]);

  const remember = useCallback((email: Email, scope: string) => {
    // A message too big to keep is not kept (it is fetched again when needed).
    if (!scope || bodyChars(email) > NEIGHBOUR_REMEMBER_MAX_CHARS) return;
    const map = cache.current.map;
    const k = keyOf(scope, email.id);
    map.delete(k);
    map.set(k, { email, scope });
    while (map.size > NEIGHBOUR_CACHE_SIZE) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }, []);
  /** The copy of `row`'s message kept in the client's current session, if any. */
  const lookup = useCallback((row: Email | null | undefined): Kept | null => {
    const scope = liveScope();
    if (!row || !scope || !swipeOwnsRow(row, client)) return null;
    const kept = cache.current.map.get(keyOf(scope, row.id));
    return kept && kept.scope === scope && kept.email.id === row.id ? kept : null;
  }, [liveScope, client]);

  // The open message stays in memory: after a swipe it is a neighbour. Only
  // while the swipe is on: the caller turns it off for messages that are not
  // the signed-in account's own (another login, a shared folder).
  const currentId = current?.id;
  useEffect(() => {
    if (!enabled || !current?.bodyValues || !swipeOwnsRow(current, client)) return;
    remember(current, liveScope());
    // Only another message, not each flag change of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, currentId, remember, liveScope, client]);

  const prevId = prevRow?.id;
  const nextId = nextRow?.id;
  const rows = useRef({ prevRow, nextRow });
  rows.current = { prevRow, nextRow };
  useEffect(() => {
    if (!enabled || !client || !currentId) return;
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    let onVisible: (() => void) | null = null;
    const order = lastDir.current === "prev" ? (["prevRow", "nextRow"] as const) : (["nextRow", "prevRow"] as const);
    const queue = order.map((k) => rows.current[k]).filter((r): r is Email => swipeOwnsRow(r, client));
    const step = (i: number) => {
      if (cancelled || i >= queue.length || !enabledRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // A hidden page prepares nothing; it carries on when shown again.
        onVisible = () => {
          if (document.visibilityState === "hidden") return;
          document.removeEventListener("visibilitychange", onVisible!);
          onVisible = null;
          cancelIdle = whenIdle(() => step(i));
        };
        document.addEventListener("visibilitychange", onVisible);
        return;
      }
      if (saveDataRequested() || !client.fetchEmailAhead) return;
      const row = queue[i];
      const scope = liveScope();
      if (!scope || !swipeOwnsRow(row, client)) return;
      const k = keyOf(scope, row.id);
      const box = cache.current;
      if (lookup(row) || box.pending.has(k)) { step(i + 1); return; }
      // Fetched, not taken from the push worker's kept copies: those carry no
      // session identity yet (audit/FOLLOWUPS.md, pwa-start N4).
      const promise = client.fetchEmailAhead(row.id);
      box.pending.set(k, { promise, scope });
      void promise.then((email) => {
        box.pending.delete(k);
        // Another client, or another session meanwhile: not kept.
        if (cache.current !== box || liveScope() !== scope) return;
        if (email && email.id === row.id && email.bodyValues) {
          remember(email, scope);
          setVersion((v) => v + 1);
        }
        if (cancelled) return;
        // One neighbour at a time, each at idle.
        cancelIdle = whenIdle(() => step(i + 1));
      });
    };
    const cancelWait = afterBodyPainted(currentId, () => {
      if (!cancelled) cancelIdle = whenIdle(() => step(0));
    }, 1500);
    return () => {
      cancelled = true;
      cancelWait();
      cancelIdle?.();
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, client, currentId, prevId, nextId, lookup, remember, liveScope]);

  const scopeNow = liveScope();
  const neighbours = useMemo<SwipeNeighbours | null>(() => {
    if (!enabled || !scopeNow) return null;
    return {
      prev: prevRow ? { row: prevRow, email: lookup(prevRow)?.email ?? null } : null,
      next: nextRow ? { row: nextRow, email: lookup(nextRow)?.email ?? null } : null,
    };
    // version: a neighbour arrived; scopeNow: another session shows none of the last one's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, prevRow, nextRow, lookup, version, scopeNow]);

  const prime = useCallback((row: Email): SwipePreload => {
    if (!enabledRef.current || !client?.primeEmailForOpen) return "none";
    // The row's current flags and folders win (a flag changed since the
    // fetch, e.g. marked read elsewhere, is the row's).
    const withRow = (copy: Email): Email => ({ ...copy, keywords: row.keywords ?? copy.keywords, mailboxIds: row.mailboxIds ?? copy.mailboxIds });
    const kept = lookup(row);
    if (kept) {
      // The client refuses it unless it is still in the session the copy came from.
      client.primeEmailForOpen(row.id, withRow(kept.email), NEIGHBOUR_PRIME_MAX_AGE_MS, kept.scope);
      return peekKind(kept.email);
    }
    const scope = liveScope();
    const pending = scope ? cache.current.pending.get(keyOf(scope, row.id)) : undefined;
    if (pending && pending.scope === scope) {
      client.primeEmailForOpen(row.id, pending.promise.then((e) => (e ? withRow(e) : null)), NEIGHBOUR_PRIME_MAX_AGE_MS, pending.scope);
    }
    return "none";
  }, [client, lookup, liveScope]);

  const noteDirection = useCallback((dir: "prev" | "next") => { lastDir.current = dir; }, []);

  return { neighbours, prime, noteDirection };
}
