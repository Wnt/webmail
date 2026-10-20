"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Email } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { afterBodyPainted } from "@/lib/open-timing";
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
 * most NEIGHBOUR_CACHE_SIZE, for one client and one session
 * (JMAPClient.getSessionScope: its API URL and mail account): another session
 * starts empty, and a fetch that ends in another session is dropped.
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

const keyOf = (accountId: string, id: string) => `${accountId}\u0000${id}`;

export function useSwipeNeighbours({ client, enabled, current, prevRow, nextRow }: UseSwipeNeighboursOptions): {
  neighbours: SwipeNeighbours | null;
  prime: (row: Email) => SwipePreload;
  /** The side the user last swiped to: its neighbour is fetched first. */
  noteDirection: (dir: "prev" | "next") => void;
} {
  // Full messages in memory, least recently used first, and the fetches under
  // way; for one client and one session only.
  const scope = client?.getSessionScope?.() ?? "";
  const cache = useRef<{ client: IJMAPClient | null | undefined; scope: string; map: Map<string, Email>; pending: Map<string, Promise<Email | null>> }>(
    { client, scope, map: new Map(), pending: new Map() });
  if (cache.current.client !== client || cache.current.scope !== scope) {
    cache.current = { client, scope, map: new Map(), pending: new Map() };
  }
  const [version, setVersion] = useState(0);
  const lastDir = useRef<"prev" | "next">("next");

  const remember = useCallback((email: Email) => {
    // A message too big to keep is not kept (it is fetched again when needed).
    if (bodyChars(email) > NEIGHBOUR_REMEMBER_MAX_CHARS) return;
    const map = cache.current.map;
    const k = keyOf(scope, email.id);
    map.delete(k);
    map.set(k, email);
    while (map.size > NEIGHBOUR_CACHE_SIZE) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }, [scope]);
  const lookup = useCallback((row: Email | null | undefined): Email | null => {
    if (!row || !scope || !neighbourFetchable(row)) return null;
    const copy = cache.current.map.get(keyOf(scope, row.id));
    return copy && copy.id === row.id ? copy : null;
  }, [scope]);

  // The open message stays in memory: after a swipe it is a neighbour.
  const currentId = current?.id;
  useEffect(() => {
    if (!enabled || !current?.bodyValues || !neighbourFetchable(current)) return;
    remember(current);
    // Only another message, not each flag change of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, currentId, remember]);

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
    const queue = order.map((k) => rows.current[k]).filter((r): r is Email => !!r && neighbourFetchable(r));
    const step = (i: number) => {
      if (cancelled || i >= queue.length) return;
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
      const k = keyOf(scope, row.id);
      const box = cache.current;
      if (lookup(row) || box.pending.has(k)) { step(i + 1); return; }
      // Fetched, not taken from the push worker's kept copies: those carry no
      // session identity yet (audit/FOLLOWUPS.md, pwa-start N4).
      const pending = client.fetchEmailAhead(row.id);
      box.pending.set(k, pending);
      void pending.then((email) => {
        box.pending.delete(k);
        if (cache.current !== box) return; // another client or session meanwhile
        if (email && email.id === row.id && email.bodyValues) {
          remember(email);
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
  }, [enabled, client, scope, currentId, prevId, nextId, lookup, remember]);

  const neighbours = useMemo<SwipeNeighbours | null>(() => {
    if (!enabled) return null;
    return {
      prev: prevRow ? { row: prevRow, email: lookup(prevRow) } : null,
      next: nextRow ? { row: nextRow, email: lookup(nextRow) } : null,
    };
    // version: a neighbour arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, prevRow, nextRow, lookup, version]);

  const prime = useCallback((row: Email): SwipePreload => {
    if (!client?.primeEmailForOpen || !scope) return "none";
    // The row's current flags and folders win (a flag changed since the
    // fetch, e.g. marked read elsewhere, is the row's).
    const withRow = (copy: Email): Email => ({ ...copy, keywords: row.keywords ?? copy.keywords, mailboxIds: row.mailboxIds ?? copy.mailboxIds });
    const copy = lookup(row);
    if (copy) {
      client.primeEmailForOpen(row.id, withRow(copy), NEIGHBOUR_PRIME_MAX_AGE_MS);
      return peekKind(copy);
    }
    const pending = cache.current.pending.get(keyOf(scope, row.id));
    if (pending) client.primeEmailForOpen(row.id, pending.then((e) => (e ? withRow(e) : null)), NEIGHBOUR_PRIME_MAX_AGE_MS);
    return "none";
  }, [client, scope, lookup]);

  const noteDirection = useCallback((dir: "prev" | "next") => { lastDir.current = dir; }, []);

  return { neighbours, prime, noteDirection };
}
