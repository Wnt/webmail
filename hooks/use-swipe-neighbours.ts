"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Email } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { afterBodyPainted } from "@/lib/open-timing";
import type { SwipePreload } from "@/lib/open-timing";
import { fetchAhead } from "@/lib/open-prefetch";
import {
  NEIGHBOUR_CACHE_SIZE,
  NEIGHBOUR_FETCH_MAX_AGE_MS,
  NEIGHBOUR_PRIME_MAX_AGE_MS,
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
 * memory to the client with the row's current flags, so the open's getEmail
 * takes it instead of asking the server.
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
  // Full messages in memory, least recently used first; for one client only.
  const cache = useRef<{ client: IJMAPClient | null | undefined; map: Map<string, Email> }>({ client, map: new Map() });
  if (cache.current.client !== client) cache.current = { client, map: new Map() };
  const [version, setVersion] = useState(0);
  const lastDir = useRef<"prev" | "next">("next");

  const accountId = client?.getAccountId?.() ?? "";
  const remember = useCallback((email: Email) => {
    const map = cache.current.map;
    const k = keyOf(accountId, email.id);
    map.delete(k);
    map.set(k, email);
    while (map.size > NEIGHBOUR_CACHE_SIZE) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }, [accountId]);
  const lookup = useCallback((row: Email | null | undefined): Email | null => {
    if (!row || !neighbourFetchable(row)) return null;
    const copy = cache.current.map.get(keyOf(accountId, row.id));
    return copy && copy.id === row.id ? copy : null;
  }, [accountId]);

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
      if (saveDataRequested()) return;
      const row = queue[i];
      if (lookup(row)) { step(i + 1); return; }
      const pending = fetchAhead(client, row, NEIGHBOUR_FETCH_MAX_AGE_MS);
      if (!pending) return;
      void pending.then((email) => {
        if (cancelled) return;
        if (email && email.id === row.id && email.bodyValues) {
          remember(email);
          setVersion((v) => v + 1);
        }
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
  }, [enabled, client, currentId, prevId, nextId, lookup, remember]);

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
    const copy = lookup(row);
    if (!copy || !client?.prefetchEmail) return "none";
    // The copy in memory, with the row's current flags and folders (a flag
    // changed since the fetch, e.g. marked read elsewhere, is the row's).
    client.prefetchEmail(row.id, { ...copy, keywords: row.keywords ?? copy.keywords, mailboxIds: row.mailboxIds ?? copy.mailboxIds },
      { maxAgeMs: NEIGHBOUR_PRIME_MAX_AGE_MS, replace: true });
    return peekKind(copy);
  }, [client, lookup]);

  const noteDirection = useCallback((dir: "prev" | "next") => { lastDir.current = dir; }, []);

  return { neighbours, prime, noteDirection };
}
