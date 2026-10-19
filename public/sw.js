/* eslint-disable no-undef */

// Bulwark service worker.
//
// This SW does two jobs:
//   1. Satisfy the PWA installability requirement (network-only fetch handler,
//      no caching - so we never serve stale chunks after a deployment).
//   2. Receive Web Push wake-up pings from the relay and turn them into
//      enriched system notifications. Mirrors the React Native FCM headless
//      task: relay sends only a state-change ping, the client fetches the
//      newest unread email itself so the relay never sees mail content.

// When the app is mounted at a subpath (Next.js basePath, e.g. /webmail), the
// SW is served at /webmail/sw.js and registered with scope /webmail/. Derive
// the prefix from the SW's own URL so push fetches and notification clicks
// land on the right path - service workers can't read process.env.
function getBasePath() {
  const path = new URL(self.location.href).pathname;
  // self.location is .../sw.js; strip the trailing filename to get the dir,
  // then strip the trailing slash so it concatenates cleanly with `/foo`.
  const dir = path.replace(/[^/]*$/, "");
  return dir.replace(/\/+$/, "");
}

const BASE_PATH = getBasePath();
const MAILTO_CLIENTS = new Map();

// Fork patch (Wnt/webmail): this worker's revision. The page compares it with
// the one it was built with (lib/sw-revision.ts, kept equal by a unit test)
// and asks the browser for the newer worker when they differ: an iPhone can
// keep running an old worker. Bump both whenever this file changes.
const SW_REVISION = "2026-10-19.push5";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  // Fork patch (Wnt/webmail): whether this push showed a notification, and
  // work that may outlive the handler (a delayed close, see showReplacing),
  // which keeps the event alive without holding up the account's next push.
  // `trace`: what happened, for the tap diagnostics (tracePush).
  const work = { pending: [], displayed: false, trace: {}, receivedAt: Date.now() };
  event.waitUntil(handlePushInOrder(event, work).then(() => Promise.all(work.pending)));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

// Fork patch (Wnt/webmail): the user dismissed one of our notifications, so
// its disappearance from the list is not a tap (see rememberShown).
self.addEventListener("notificationclose", (event) => {
  event.waitUntil(handleNotificationClose(event));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  // Fork patch (Wnt/webmail): the page asks which worker revision runs.
  if (data.type === "sw-revision") {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ revision: SW_REVISION });
    return;
  }

  if (data.type === "mailto-client-ready") {
    if (event.source && event.source.id) {
      MAILTO_CLIENTS.set(event.source.id, {
        path: typeof data.path === "string" ? data.path : "",
        standalone: data.standalone === true,
        clientId: typeof data.clientId === "string" ? data.clientId : "",
        focusNotificationTitle: typeof data.focusNotificationTitle === "string" ? data.focusNotificationTitle : "",
        focusNotificationBody: typeof data.focusNotificationBody === "string" ? data.focusNotificationBody : "",
      });
    }
    return;
  }

  if (data.type === "mailto-client-gone") {
    if (event.source && event.source.id) {
      const current = MAILTO_CLIENTS.get(event.source.id);
      if (!current
        || (typeof data.clientId === "string" && current.clientId === data.clientId)
        || (typeof data.clientId !== "string" && typeof data.path === "string" && current.path === data.path)) {
        MAILTO_CLIENTS.delete(event.source.id);
      }
    }
    return;
  }

  if (data.type === "push-signout") {
    event.waitUntil(handlePushSignOut(event));
    return;
  }

  if (data.type === "open-mailto-in-client") {
    event.waitUntil(handleOpenMailtoInClient(event));
    return;
  }

  if (data.type === "focus-existing-mailto-client") {
    event.waitUntil(focusExistingWindowClient(event.source && event.source.id, true));
    return;
  }

  if (data.type !== "focus-existing-client") return;

  event.waitUntil(focusExistingWindowClient(event.source && event.source.id));
});

// Fork patch (Wnt/webmail), audit bulwark-5: a quiet summary replacement
// reads the account's notification and then replaces it. Two push handlers
// for one account running at once could interleave those steps with a newer
// message's notification, so pushes are handled one at a time per account.
const PUSH_QUEUES = new Map();

function readPushPayload(event) {
  try {
    return event.data ? event.data.json() : null;
  } catch (_) {
    return null;
  }
}

/** The account a push is for, as handlePush reads it ("" when it names none). */
function pushPayloadAccountId(payload) {
  if (payload && typeof payload.accountId === "string" && payload.accountId) return payload.accountId;
  const changed = payload && payload.changed && typeof payload.changed === "object" ? payload.changed : null;
  return (changed && Object.keys(changed)[0]) || "";
}

function handlePushInOrder(event, work) {
  const payload = readPushPayload(event);
  const key = pushPayloadAccountId(payload) || "default";
  const previous = PUSH_QUEUES.get(key) || Promise.resolve();
  const run = previous.then(async () => {
    try {
      await handlePush(event, work);
    } finally {
      // Fork patch (Wnt/webmail): see acknowledgeUnshownPush.
      if (!work.displayed) await acknowledgeUnshownPush(payload, work);
      // Fork patch (Wnt/webmail): the first link of a tap's chain, without
      // any id (traceTap). Outlives the handler like a delayed close.
      work.pending.push(tracePush(payload, work));
    }
  });
  const settled = run.catch(() => undefined);
  PUSH_QUEUES.set(key, settled);
  settled.then(() => {
    if (PUSH_QUEUES.get(key) === settled) PUSH_QUEUES.delete(key);
  });
  return run;
}

async function handlePush(event, work) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (_) {
    payload = null;
  }

  const accountLabel = (payload && typeof payload.accountLabel === "string")
    ? payload.accountLabel
    : "";

  // Two payload shapes reach us from the relay:
  //   - "jmap-email-push": the server evaluated our per-account delivery
  //     filter (draft-ietf-jmap-emailpush) and this is a list of the new
  //     message ids that passed it - spam filed into Junk never gets here.
  //   - "jmap-state-change" (older servers): a bare EmailDelivery ping wrapped
  //     as { changed: { [accountId]: {...} } }, fired for every ingested
  //     message including junk. The relay forwards a single account per push,
  //     so the first key is the one this notification is for.
  const changed = payload && payload.changed && typeof payload.changed === "object"
    ? payload.changed
    : null;
  const accountId = (payload && typeof payload.accountId === "string" && payload.accountId)
    || (changed ? Object.keys(changed)[0] || "" : "");
  const emailIds = payload && Array.isArray(payload.emailIds)
    ? payload.emailIds.filter((id) => typeof id === "string" && id)
    : [];

  // Fork patch (Wnt/webmail), audit bulwark-1: the user signed this account
  // (or every account) out on purpose. Teardown normally stops these pushes
  // at the source; this covers a teardown that could not reach the network.
  // An expired session sets no marker and keeps notifying.
  const generationAtStart = signOutGeneration(accountId);
  if (await pushSignedOut(accountId) === true) return;

  // Never notify twice for the same message. A push can be redelivered (relay
  // retry, browser replay after coming back online) and, on the older
  // state-change path, a junk delivery wakes us while an unread message we
  // already announced is still sitting in the Inbox - without this we would
  // re-buzz for that old message.
  const notified = await readNotifiedIds(accountId);

  // Fork patch (Wnt/webmail): our gateway follows a new-mail push with a quiet
  // replacement that carries an AI summary (`email.summary`, `renotify: false`).
  // When we already announced that message, swap the text of its notification
  // in place without alerting again. If the first push never arrived, fall
  // through and announce it, quietly.
  //
  // On an iPhone the new-mail push is a Declarative Web Push message that iOS
  // shows by itself (no worker, no data: see the gateway's payload.ts), so
  // this worker first meets the message here. It takes that notification over
  // as if it had shown it: its own copy with the tap data (and the ledger
  // entry) replaces it, the message is marked announced and kept for the tap.
  const quietPush = !!(payload && payload.renotify === false);
  const groupTagEarly = "bulwark-mail:" + (accountId || "default");
  // Fork patch (Wnt/webmail): what is up for the account when this push is
  // decided on. A notification the browser shows by itself after this moment
  // (a declarative push for newer mail) is never replaced by this push.
  const upAtStart = await accountNotifications(groupTagEarly, accountId);
  const mine = pushSentAt(payload);
  if (quietPush && emailIds.length > 0) {
    const headline = emailIds[emailIds.length - 1];
    const announced = notified.includes(headline);
    // The newest of them by when their push went out (none known when the
    // browser could not list them: then announced below without replacing).
    const top = newestNotification(upAtStart || []);
    if (top && top.data.headlineEmailId === headline) {
      const content = payload.email && typeof payload.email.summary === "string" && payload.email.summary.trim()
        ? buildPayloadEmailContent(payload.email)
        : (top.byBrowser ? { title: top.n.title || "New mail", body: top.n.body || "" } : null);
      // The summary is for the newest of its ids (the gateway summarises the
      // headline message); it only replaces a notification that shows that one.
      if (content) {
        work.trace.shown = "summary";
        await showMailNotification(accountId, content.title, {
          body: content.body,
          tag: groupTagEarly,
          icon: `${BASE_PATH}/api/pwa-icon/192`,
          badge: `${BASE_PATH}/api/pwa-icon/192`,
          data: top.data,
          renotify: false,
          silent: true,
        }, work, replaceKeys(upAtStart, headline, Math.max(mine, top.sentAt)));
      }
      if (top.byBrowser && !announced) {
        work.trace.over = work.displayed;
        await writeNotifiedIds(accountId, notified.concat(emailIds));
      }
      // Kept for the tap unless it already is (the first push's lookup may
      // have failed, or this worker never saw that push).
      if (work.displayed) deferKeep(accountId, headline, payload, work);
      return;
    }
    // Announced before and now dismissed, or another message's notification
    // is up that is newer or cannot be ordered against this one: that one
    // stays (acknowledgeUnshownPush re-shows it on WebKit).
    if (announced) return;
    if (top && !(top.sentAt > 0 && mine > 0 && top.sentAt < mine)) return;
    // Nothing up for it, or only older mail: announced below, quietly.
  }

  const freshIds = emailIds.filter((id) => !notified.includes(id));
  if (emailIds.length > 0 && freshIds.length === 0) {
    return;
  }

  // Best effort: ask the webmail to look up the email so we can build a useful
  // notification. With ids from the server we ask for exactly the newest of
  // them; otherwise the API falls back to the newest unread Inbox message. If
  // the request fails (offline, session expired, server down) we fall back to
  // a generic "New mail" so the user still sees something.
  let preview = null;
  let previewOk = false;
  work.trace.preview = "fail";
  try {
    const query = new URLSearchParams();
    if (accountId) query.set("accountId", accountId);
    if (freshIds.length > 0) {
      query.set("emailId", freshIds[freshIds.length - 1]);
      // Fork patch (Wnt/webmail): the whole message too, kept for the tap.
      query.set("full", "1");
    }
    const qs = query.toString();
    const previewUrl = `${BASE_PATH}/api/push/preview${qs ? `?${qs}` : ""}`;
    // Fork patch (Wnt/webmail): pushes for an account run one at a time, so
    // a stalled lookup (headers or body) must not hold the next ones back
    // for long; an explicit sign-out cuts it short too (handlePushSignOut).
    const controller = typeof AbortController === "function" && typeof setTimeout === "function"
      ? new AbortController()
      : null;
    const timer = controller ? setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS) : null;
    const lookups = previewLookups(accountId);
    if (controller) lookups.add(controller);
    try {
      const res = await fetch(previewUrl, {
        credentials: "include",
        cache: "no-store",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (res.ok) {
        preview = await res.json();
        previewOk = true;
        work.trace.preview = "ok";
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) lookups.delete(controller);
    }
  } catch (_) {
    preview = null;
  }

  const email = preview && preview.email ? preview.email : null;
  const unreadTotal = preview && typeof preview.unreadTotal === "number"
    ? preview.unreadTotal
    : 0;
  // The login (cookie slot) that owns this account, so the click opens the
  // message there and not in whichever account happens to be active.
  const slot = preview && Number.isInteger(preview.slot) ? preview.slot : undefined;

  // Push subscription is scoped to EmailDelivery, but stragglers from the
  // older broader-types subscription, marking-as-read races and verification
  // pings can still wake us with no actual unread mail. When the preview API
  // succeeded and reports zero unread, stay silent. When the preview API
  // failed (network/auth/server down) we cannot tell, so fall through to the
  // generic "New mail" toast rather than miss a real delivery.
  if (previewOk && !email && unreadTotal === 0) {
    return;
  }

  // State-change path only (no ids from the server): the newest unread Inbox
  // message is one we already announced, so whatever woke us was not new
  // Inbox mail - typically a delivery into Junk or a Sieve-filed folder.
  if (emailIds.length === 0 && previewOk && email && notified.includes(email.id)) {
    return;
  }

  // Group per account under one shared tag so a burst of new mail collapses
  // into a single, self-updating notification instead of one toast per message
  // (Android renders one notification per unique tag, which is why 50 arrivals
  // used to stack 50 toasts). The newest message is the headline and a
  // Gmail-style "+N more" line carries the rest, counted from the account's
  // unread total.
  const groupTag = "bulwark-mail:" + (accountId || "default");
  let title;
  let body;
  // Fork patch (Wnt/webmail), audit bulwark-5: the message this notification
  // headlines, so a later summary can tell whether it belongs here.
  const headlineEmailId = (email && typeof email.id === "string" && email.id)
    || (freshIds.length > 0 ? freshIds[freshIds.length - 1] : "");
  // Fork patch (Wnt/webmail): a tap opens the message the notification
  // names whenever its id is known: from the preview, or else the newest id
  // the push itself carried (the preview API failed, e.g. 401 after the
  // session expired). That includes a "+N more" group: it headlines its
  // newest message, and the inbox is one step back from there. Only a push
  // with no id at all (an older server's bare state change) opens the list.
  const sentAt = pushSentAt(payload);
  const data = headlineEmailId
    ? {
      kind: "email",
      emailId: headlineEmailId,
      threadId: email && typeof email.threadId === "string" ? email.threadId : undefined,
      slot,
      accountId,
      headlineEmailId,
      // Fork patch (Wnt/webmail): when the gateway sent this message's first
      // push, which orders notifications (see the quiet path above).
      ...(sentAt > 0 ? { sentAt } : {}),
    }
    : { kind: "mail-list", accountId, slot, headlineEmailId };

  if (email) {
    const sender = email.from && email.from[0];
    const senderName = (sender && sender.name) || (sender && sender.email) || "New mail";
    title = senderName + (accountLabel ? ` (${accountLabel})` : "");
    body = email.subject || email.preview || "(no subject)";
    const more = unreadTotal > 1 ? unreadTotal - 1 : 0;
    if (more > 0) {
      // Several unread: this is a group. Keep the newest as the headline and
      // add the "+N more" count; a tap still opens the headline message.
      body += "\n" + (more === 1 ? "+1 more message" : `+${more} more messages`);
    }
  } else {
    const fallback = !previewOk ? buildPayloadEmailContent(payload && payload.email) : null;
    if (fallback) {
      // Fork patch (Wnt/webmail): the preview API failed (e.g. 401 after the
      // session expired) but the push itself carried the email summary.
      title = fallback.title;
      body = fallback.body;
    } else {
      title = accountLabel ? `New mail (${accountLabel})` : "New mail";
      body = unreadTotal > 1 ? `${unreadTotal} unread messages` : "You have new mail";
    }
  }

  // A quiet replacement whose first push this worker never saw (and no
  // notification for it is on screen: dismissed, or the push was lost) is
  // announced without a sound: it already alerted once, or should have.
  // Fork patch (Wnt/webmail): a newer message's notification is already up
  // (this push was delivered late): it stays the headline. Decided before
  // showing, since a same-tag notification replaces it on most browsers. The
  // message counts as announced; on WebKit the account's newest notification
  // is shown again (acknowledgeUnshownPush).
  if (newerOtherMail(upAtStart, headlineEmailId, mine)) {
    const late = freshIds.length > 0 ? freshIds : (email ? [email.id] : []);
    if (late.length > 0) await writeNotifiedIds(accountId, notified.concat(late));
    return;
  }

  const quiet = quietPush || await withinQuietWindow(accountId);
  work.trace.shown = "new";
  // Fork patch (Wnt/webmail): when the browser could not list what is up,
  // this replaces nothing it could tell apart (replaceKeys of null). WebKit
  // never replaces by tag; a browser that does keeps the account's single
  // notification, as upstream.
  const replacing = replaceKeys(upAtStart, headlineEmailId, mine);
  await showMailNotification(accountId, title, {
    body,
    // Shared per-account tag: each new push replaces the account's single
    // notification rather than adding another.
    tag: groupTag,
    // Branded app icon via the PWA-icon endpoint (admin-configured, else the
    // built-in default). The static /icon-192x192.png ignored admin branding.
    icon: `${BASE_PATH}/api/pwa-icon/192`,
    badge: `${BASE_PATH}/api/pwa-icon/192`,
    data,
    // Inside the quiet window the notification still appears or updates,
    // without a sound.
    renotify: !quiet,
    silent: quiet,
  }, work, replacing);

  const announced = freshIds.length > 0 ? freshIds : (email ? [email.id] : []);
  if (announced.length > 0) {
    await writeNotifiedIds(accountId, notified.concat(announced));
  }

  // Fork patch (Wnt/webmail): the message this notification opens, kept so a
  // tap shows it without fetching it again (lib/push-prefetch.ts). After the
  // notification is up, so keeping it never delays the alert; not when the
  // account was signed out meanwhile.
  if (preview && preview.full && typeof preview.full === "object" && preview.full.id === headlineEmailId
    && work.displayed) {
    if (await keepIfStillSignedIn(accountId, preview.full, generationAtStart)) work.trace.kept = "preview";
  } else if (headlineEmailId && work.displayed) {
    // Fork patch (Wnt/webmail): the lookup failed (an expired session: its
    // access token lives an hour) or named no whole message. The push's own
    // preview ticket reads that one message (keepWithTicket).
    deferKeep(accountId, headlineEmailId, payload, work);
  }
}

// Fork patch (Wnt/webmail): when the gateway sent the first push of this
// message (the quiet replacement names it as `firstSentAt`), ms; 0 unknown.
function pushSentAt(payload) {
  const v = payload ? Number(payload.firstSentAt || payload.sentAt) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Fork patch (Wnt/webmail): only for an account known to be signed in here:
// an unreadable sign-out state keeps nothing (audit bulwark-1, fail closed).
async function mayKeepFor(accountId) {
  if (SIGNOUTS_IN_PROGRESS.has("*") || SIGNOUTS_IN_PROGRESS.has(accountId || "default")) return false;
  return (await pushSignedOut(accountId)) === false;
}

// The ticket read outlives the handler (like a delayed close), so it never
// holds up the account's next push; the tap record waits for it, and an
// explicit sign-out drains it (KEEPS) before its final purge.
function deferKeep(accountId, emailId, payload, work) {
  const key = accountId || "default";
  const keep = keepWithTicket(accountId, emailId, payload, work).catch(() => undefined);
  let set = KEEPS.get(key);
  if (!set) {
    set = new Set();
    KEEPS.set(key, set);
  }
  set.add(keep);
  keep.then(() => {
    set.delete(keep);
    if (set.size === 0 && KEEPS.get(key) === set) KEEPS.delete(key);
  });
  work.keepDone = keep;
  work.pending.push(keep);
}

// Detached message keeps per account, and a counter each explicit sign-out of
// the account moves on: a keep that started before a sign-out never stays
// kept after it (its write is undone if the counter moved meanwhile).
const KEEPS = new Map();
const SIGNOUT_GENERATIONS = new Map();

function signOutGeneration(accountId) {
  return `${SIGNOUT_GENERATIONS.get("*") || 0}/${SIGNOUT_GENERATIONS.get(accountId || "default") || 0}`;
}

/** Keeps `email` for `accountId` unless a sign-out came after `generation`; returns whether it is kept. */
async function keepIfStillSignedIn(accountId, email, generation) {
  if (signOutGeneration(accountId) !== generation || !(await mayKeepFor(accountId))) return false;
  const ok = () => signOutGeneration(accountId) === generation;
  await rememberPrefetchedEmail(accountId, email, ok);
  if (!ok() || !(await mayKeepFor(accountId))) {
    await forgetPrefetchedEmail(accountId, email.id);
    return false;
  }
  return true;
}

// Fork patch (Wnt/webmail): our push gateway may include an optional
// `email: { from, subject, preview, summary? }` in the payload. Used when the
// preview API cannot be reached, so the toast is still informative, and for
// the quiet AI-summary replacement. The summary, when present, takes the
// preview's place. Returns { title, body } or null when there is nothing usable.
const PAYLOAD_PREVIEW_MAX = 200;

function buildPayloadEmailContent(email) {
  if (!email || typeof email !== "object") return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const from = str(email.from);
  const subject = str(email.subject);
  const preview = (str(email.summary) || str(email.preview)).slice(0, PAYLOAD_PREVIEW_MAX);
  if (!from && !subject && !preview) return null;
  return {
    title: from || "New mail",
    body: [subject, preview].filter(Boolean).join("\n") || "(no subject)",
  };
}

// Fork patch (Wnt/webmail): the account's notifications as one push sees
// them: each with the message it opens (notificationDataOf), when that
// message's push went out (0 unknown), whether the browser showed it by
// itself (a declarative push: no data of this worker) and a key that finds
// it again in a later listing.
async function accountNotifications(tag, accountId) {
  let shown = null;
  for (let attempt = 0; attempt < 2 && shown === null; attempt++) {
    try {
      shown = await self.registration.getNotifications({ tag });
    } catch (_) {
      shown = null;
      if (attempt === 0 && typeof setTimeout === "function") await delay(200);
    }
  }
  // The browser could not list them: callers must not replace anything blind.
  if (shown === null) return null;
  return (shown || []).map((n, index) => {
    const data = notificationDataOf(n, accountId) || (n.data && typeof n.data === "object" ? n.data : {});
    const sentAt = Number(data.sentAt);
    return {
      n,
      index,
      data,
      sentAt: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : 0,
      byBrowser: !(n.data && typeof n.data === "object" && n.data.shownId),
      key: notificationKey(n),
    };
  });
}

/** The newest by send time (unknown counts as oldest); between equals, the one listed last. */
function newestNotification(entries) {
  let best = null;
  for (const e of entries) {
    if (!e.data || e.data.kind !== "email" || !e.data.headlineEmailId) continue;
    if (!best || e.sentAt > best.sentAt || (e.sentAt === best.sentAt && e.index > best.index)) best = e;
  }
  return best;
}

/**
 * Which of `entries` a notification for `emailId` (its push sent at `sentAt`)
 * replaces: one for the same message, and one whose message's push is known
 * to have gone out no later. One that cannot be ordered (either time
 * unknown) stays, whoever showed it, on WebKit, which never replaces by tag.
 * A browser that replaces by tag does so itself when one is shown, so there
 * the account keeps its one notification, as upstream: a push whose message
 * is known to be older than one up is held back (newerOtherMail); without
 * times (a notification or push from before send times) the newest handled
 * one shows. Accepted: holding every unordered push back would hide new mail.
 */
function replaceKeys(entries, emailId, sentAt) {
  const keys = new Set();
  for (const e of entries || []) {
    const same = !!emailId && e.data && e.data.headlineEmailId === emailId;
    const older = e.sentAt > 0 && sentAt > 0 && e.sentAt <= sentAt;
    if (same || older) keys.add(e.key);
  }
  return keys;
}

/** Another message's notification among `entries` whose push went out after `sentAt`, if any. */
function newerOtherMail(entries, emailId, sentAt) {
  if (!(sentAt > 0) || !entries) return null;
  return entries.find((e) => e.data && e.data.kind === "email" && e.data.headlineEmailId
    && e.data.headlineEmailId !== emailId && e.sentAt > sentAt) || null;
}

// Fork patch (Wnt/webmail): the message a notification opens, from its data,
// or, for one the browser showed by itself from a Declarative Web Push
// message (iOS keeps no data for those), from its `navigate` URL, which the
// gateway builds the way buildClickUrl does. Only our own origin's message
// links count. Returns click data like the worker's own, or null.
function notificationDataOf(n, accountId) {
  if (!n) return null;
  if (n.data && typeof n.data === "object" && typeof n.data.kind === "string") return n.data;
  const emailId = emailIdFromNavigate(n.navigate);
  if (!emailId) return null;
  // The gateway puts the push's send time in the link's fragment (#sent=<ms>).
  const sent = /#(?:.*&)?sent=(\d{1,16})(?:&|$)/.exec(typeof n.navigate === "string" ? n.navigate : "");
  const sentAt = sent ? Number(sent[1]) : 0;
  return { kind: "email", emailId, accountId: accountId || "", headlineEmailId: emailId, ...(sentAt > 0 ? { sentAt } : {}) };
}

function emailIdFromNavigate(navigate) {
  if (typeof navigate !== "string" || !navigate) return "";
  try {
    const url = new URL(navigate, self.location.origin);
    if (url.origin !== self.location.origin) return "";
    const prefix = `${BASE_PATH}/mail/message/`;
    if (!url.pathname.startsWith(prefix)) return "";
    const rest = url.pathname.slice(prefix.length);
    if (!rest || rest.includes("/")) return "";
    return decodeURIComponent(rest);
  } catch (_) {
    return "";
  }
}

// Fork patch (Wnt/webmail): what the worker keeps of a pushed message for the
// tap: exactly what the reading pane's Email/get asks for (lib/jmap/
// full-email.ts; a unit test keeps the two equal).
const KEPT_EMAIL_PROPERTIES = [
  "id", "threadId", "mailboxIds", "keywords", "size",
  "receivedAt", "sentAt", "from", "to", "cc", "bcc", "replyTo",
  "subject", "preview", "textBody", "htmlBody", "bodyValues",
  "hasAttachment", "attachments", "messageId", "inReplyTo",
  "references", "headers", "bodyStructure", "blobId",
];
const KEPT_EMAIL_BODY_OPTIONS = {
  fetchTextBodyValues: true,
  fetchHTMLBodyValues: true,
  fetchAllBodyValues: true,
  maxBodyValueBytes: 256000,
};

/**
 * Keeps `emailId` for the tap with the push's preview ticket (our gateway
 * mints one per device: it reads that one message, for a few minutes, while
 * this device's push subscription stands). Used when the session-backed
 * preview lookup could not (its access token lives an hour) and when the
 * browser showed the notification by itself. The gateway's push relay sits
 * at /relay on this origin. Never delays a notification: called after one is
 * shown. Records how it went in the tap diagnostics (`kept`).
 */
async function keepWithTicket(accountId, emailId, payload, work) {
  const ticket = payload && typeof payload.previewTicket === "string" ? payload.previewTicket : "";
  if (!ticket || !emailId || typeof fetch !== "function") return;
  const generation = signOutGeneration(accountId);
  if (!(await mayKeepFor(accountId))) return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    if (await cache.match(prefetchedKey(accountId, emailId))) return;
  } catch (_) {
    // Look it up below.
  }
  const controller = typeof AbortController === "function" && typeof setTimeout === "function"
    ? new AbortController()
    : null;
  const timer = controller ? setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS) : null;
  const lookups = previewLookups(accountId);
  if (controller) lookups.add(controller);
  let email = null;
  try {
    const res = await fetch(`${self.location.origin}/relay/api/push/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, properties: KEPT_EMAIL_PROPERTIES, ...KEPT_EMAIL_BODY_OPTIONS }),
      credentials: "omit",
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (res.ok) {
      const body = await res.json();
      email = body && body.email && typeof body.email === "object" && body.email.id === emailId ? body.email : null;
    }
  } catch (_) {
    email = null;
  } finally {
    if (timer) clearTimeout(timer);
    if (controller) lookups.delete(controller);
  }
  const kept = !!email && await keepIfStillSignedIn(accountId, email, generation);
  if (work && work.trace) work.trace.kept = kept ? "ticket" : "none";
}

// Fork patch (Wnt/webmail), audit bulwark-1: markers the page writes on an
// explicit sign-out (lib/push-signout-state.ts, same cache and keys). After a
// sign-out of every account the browser subscription is dropped here too, in
// case the page could not do it.
function signedOutKey(path) {
  return `${self.location.origin}${BASE_PATH}/__push-state/${path}`;
}

const PREVIEW_TIMEOUT_MS = 10_000;
const SIGNOUT_DRAIN_MS = 30_000;

// Accounts ("*": all) whose explicit sign-out the worker is settling right
// now, with how many such sign-outs are under way.
const SIGNOUTS_IN_PROGRESS = new Map();

// Preview lookups in flight, per account, so a sign-out can cut them short.
const PREVIEW_LOOKUPS = new Map();

function previewLookups(accountId) {
  const key = accountId || "default";
  let set = PREVIEW_LOOKUPS.get(key);
  if (!set) {
    set = new Set();
    PREVIEW_LOOKUPS.set(key, set);
  }
  return set;
}

// Fork patch (Wnt/webmail), audit bulwark-1: the page's explicit sign-out
// asks the worker (after writing the markers) to settle every push already
// being handled for those accounts: lookups are aborted, so each handler
// reaches its marker check now; the account queues are drained, so a display
// already handed to the browser has finished; then everything still on
// screen for them is closed. The answer says whether that drain finished;
// the page waits for it (bounded) before it goes on with the sign-out.
async function handlePushSignOut(event) {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const everyAccount = data.everyAccount === true;
  const accountIds = Array.isArray(data.accountIds)
    ? data.accountIds.filter((id) => typeof id === "string" && id)
    : [];
  const affected = (key) => everyAccount || accountIds.includes(key);
  const keys = everyAccount ? ["*"] : accountIds;
  // The page could not store the markers: nothing persisted protects these
  // accounts, so this worker keeps suppressing them for as long as it runs
  // (the page also drops the browser's push subscription).
  const persisted = data.persisted !== false;
  for (const key of keys) SIGNOUTS_IN_PROGRESS.set(key, (SIGNOUTS_IN_PROGRESS.get(key) || 0) + 1);
  // Fork patch (Wnt/webmail): any message keep that started before this
  // sign-out is undone (keepIfStillSignedIn).
  for (const key of keys) SIGNOUT_GENERATIONS.set(key, (SIGNOUT_GENERATIONS.get(key) || 0) + 1);
  // Fork patch (Wnt/webmail): the affected accounts' mail notifications, or
  // null when the browser could not list them (then nothing counts as
  // settled). WebKit refuses to close one younger than 30 s, so what is
  // still up is closed again later (below).
  const listAffected = async () => {
    try {
      return (await self.registration.getNotifications()).filter((n) => {
        const tag = n.tag || "";
        return tag.startsWith("bulwark-mail:") && affected(tag.slice("bulwark-mail:".length));
      });
    } catch (_) {
      return null;
    }
  };
  const closeAll = (list) => {
    for (const n of list) {
      try {
        n.close();
      } catch (_) {
        // Already gone; the others still go.
      }
    }
  };
  const closeShown = async () => {
    const list = await listAffected();
    if (list) closeAll(list);
  };
  const release = () => {
    // From here on the persisted markers (written before this message) are
    // what every later push reads.
    for (const key of keys) {
      const left = (SIGNOUTS_IN_PROGRESS.get(key) || 1) - 1;
      if (left > 0) SIGNOUTS_IN_PROGRESS.set(key, left);
      else SIGNOUTS_IN_PROGRESS.delete(key);
    }
  };
  for (const [key, lookups] of PREVIEW_LOOKUPS) {
    if (affected(key)) for (const controller of lookups) controller.abort();
  }
  const pending = [...PUSH_QUEUES].filter(([key]) => affected(key)).map(([, queue]) => queue)
    .concat([...KEEPS].filter(([key]) => affected(key)).flatMap(([, set]) => [...set]));
  const drain = Promise.all(pending).then(() => true, () => true);
  // Answer "done" only once the drain has really finished: a display the
  // browser accepted but has not completed is not settled. Should it take
  // longer than the deadline, answer "not done" and keep suppressing and
  // closing until it has.
  const drained = typeof setTimeout === "function"
    ? await Promise.race([drain, new Promise((resolve) => setTimeout(() => resolve(false), SIGNOUT_DRAIN_MS))])
    : await drain;
  await closeShown();
  // Fork patch (Wnt/webmail): no kept message outlives a sign-out, and no
  // closed notification of those accounts may later look tapped.
  await forgetPrefetchedEmails(everyAccount ? null : accountIds);
  await forgetShown((entry) => everyAccount || accountIds.includes(entry.accountId || "default"));
  // Settled only when a listing shows nothing of those accounts still up:
  // WebKit refuses to close a notification younger than 30 s (and a listing
  // can fail), and then the page is told so (it drops the browser
  // subscription) while this worker closes them later.
  const after = await listAffected();
  const clear = after !== null && after.length === 0;
  if (port) port.postMessage({ done: drained === true && clear });
  if (!drained) {
    // Still part of this message's lifetime (waitUntil above).
    await drain;
    await closeShown();
  }
  if (persisted) release();
  // Fork patch (Wnt/webmail): close what is still up, once it is old enough
  // (a notification iOS showed by itself from a declarative push never passed
  // this worker's sign-out check), on every browser (the browser subscription
  // may already be gone, so it is not asked). Still this message's lifetime;
  // a few bounded tries; only for accounts still signed out (a deliberate
  // sign-in and re-enable meanwhile keeps its new notifications).
  if (!clear && typeof setTimeout === "function") {
    const stillSignedOut = async (n) => {
      if (!persisted) return true;
      // The tag's own suffix: an account id, even a literal "default".
      return (await pushSignedOut((n.tag || "").slice("bulwark-mail:".length))) !== false;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(MIN_CLOSE_AGE_MS);
      const list = await listAffected();
      if (list === null) continue;
      const signedOut = [];
      for (const n of list) if (await stillSignedOut(n)) signedOut.push(n);
      if (signedOut.length === 0) break;
      closeAll(signedOut);
      const left = await listAffected();
      if (left && left.length === 0) break;
    }
  }
}

// Every mail notification goes through here. The marker is read again right
// before showing, and once more after: a sign-out that landed while this
// handler was busy (its preview lookup, the show itself) closed what was on
// screen before this one appeared, so this one closes itself.
async function showMailNotification(accountId, title, options, work, replacing) {
  const signedOut = await pushSignedOut(accountId);
  if (signedOut === true) return false;
  if (signedOut === null) {
    // The sign-out state cannot be read: no sender, subject or preview.
    title = "New mail";
    options = { ...options, body: "", data: { kind: "mail-list", accountId } };
  }
  // Checked with no await before the show: a sign-out message that arrived
  // while the marker was being read stops this display outright.
  if (SIGNOUTS_IN_PROGRESS.has("*") || SIGNOUTS_IN_PROGRESS.has(accountId || "default")) return false;
  await showReplacing(title, options, work, replacing);
  if (await pushSignedOut(accountId) === true) {
    try {
      const shown = await self.registration.getNotifications({ tag: options.tag });
      await forgetShown((entry) => (entry.accountId || "default") === (accountId || "default"));
      for (const n of shown) n.close();
      // WebKit refuses to close it this young; try again once it may.
      if (work && typeof setTimeout === "function" && await usesApplePush()) {
        work.pending.push(delay(MIN_CLOSE_AGE_MS).then(() => {
          for (const n of shown) {
            try {
              n.close();
            } catch (_) {
              // Already gone.
            }
          }
        }));
      }
    } catch (_) {
      // Nothing left to close.
    }
    return false;
  }
  return true;
}

// Fork patch (Wnt/webmail): how WebKit (Safari, and web apps on the iOS Home
// Screen) handles web push differs from Chromium and Firefox in three ways
// that matter here (WebKit source, 2026):
//  - `tag` never replaces: every notification gets its own random identifier
//    (bugs.webkit.org 258922), so a same-tag notification is a second one.
//  - close() works, but not on a notification younger than 30 s
//    (s_persistentNotificationMinimumLifetime, WebKit 313831@main).
//  - every push event must show a notification within 30 s; after three that
//    do not, the origin's push subscriptions are removed, and the count never
//    resets while the subscription lives (maxSilentPushCount, PushService.mm).
//    Showing one and closing it at once does not work (the 30 s rule).
// So: after showing a notification, close the older ones with its tag (late
// enough), and on Apple's push service make sure each push shows something.

/** WebKit refuses close() on a persistent notification younger than 30 s. */
const MIN_CLOSE_AGE_MS = 31_000;

function newShownId() {
  try {
    if (self.crypto && typeof self.crypto.randomUUID === "function") return self.crypto.randomUUID();
  } catch (_) {
    // Fall back below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Show a notification that replaces whatever has its tag, on every browser:
 * it carries a one-off id, and right after it is shown every other
 * notification with the tag is closed. Where the browser replaced it already
 * (Chromium, Firefox) only the new one is found and nothing is closed. A
 * close that WebKit would refuse (the older one is under 30 s old) waits in
 * `work`, which the push event keeps alive without holding up the next push.
 */
async function showReplacing(title, options, work, replacing) {
  const shownId = newShownId();
  options = { ...options, data: { ...(options.data || {}), shownId, shownAt: Date.now() } };
  const navigate = notificationNavigateUrl(options.data);
  if (navigate) options.navigate = navigate;
  // Fork patch (Wnt/webmail): what this one replaces: the set its caller
  // chose when it decided on the push (replaceKeys), else what was up just
  // before it. One the browser shows meanwhile by itself (a declarative push
  // for newer mail) is never replaced.
  let keys = replacing instanceof Set ? replacing : null;
  if (!keys) {
    keys = new Set();
    try {
      for (const n of options.tag ? await self.registration.getNotifications({ tag: options.tag }) : []) keys.add(notificationKey(n));
    } catch (_) {
      // Nothing to replace.
    }
  }
  await self.registration.showNotification(title, options);
  if (work) {
    work.displayed = true;
    if (!work.shownAt) work.shownAt = Date.now();
  }
  const listed = await closeOthersWithTag(options.tag, shownId, work, keys);
  if (work && work.trace) {
    work.trace.nav = !!navigate;
    work.trace.listed = listed;
  }
  // Fork patch (Wnt/webmail): see rememberShown. Not listed at once on
  // WebKit (the ledger only matters there): look again a little later (it
  // outlives the handler like a delayed close).
  await rememberShown(options.data, listed);
  if (!listed && work && typeof setTimeout === "function" && await usesApplePush()) {
    work.listedCheck = confirmListed(options.tag, shownId, work);
    work.pending.push(work.listedCheck);
  }
}

/** The browser lists the notification `shownId` a moment after showing it: its ledger entry can be trusted. */
async function confirmListed(tag, shownId, work) {
  for (const wait of LISTED_RETRY_MS) {
    await delay(wait);
    let shown = [];
    try {
      shown = await self.registration.getNotifications({ tag });
    } catch (_) {
      shown = [];
    }
    if (shown.some((n) => n.data && n.data.shownId === shownId)) {
      await markShownListed(shownId);
      if (work && work.trace) work.trace.listed = true;
      return;
    }
  }
}

const LISTED_RETRY_MS = [500, 1500, 3000];

/**
 * Closes the notifications with `tag` that the one just shown replaces
 * (`keys`, see showReplacing). Returns whether the browser listed the one
 * just shown, with its data.
 */
async function closeOthersWithTag(tag, shownId, work, keys) {
  if (!tag) return false;
  let shown;
  try {
    shown = await self.registration.getNotifications({ tag });
  } catch (_) {
    return false;
  }
  // Only when the new notification can be told apart (its data came back):
  // otherwise this could close the very one just shown.
  if (!shown.some((n) => n.data && n.data.shownId === shownId)) return false;
  // Those still up that it replaces (one the browser replaced by tag
  // meanwhile is gone already; one that came after is left alone).
  for (const n of shown) {
    if (n.data && n.data.shownId === shownId) continue;
    if (!(keys instanceof Set) || !keys.has(notificationKey(n))) continue;
    const close = async () => {
      // Fork patch (Wnt/webmail): closed by us, so its absence is no tap.
      await markShownClosed(n.data && n.data.shownId);
      try {
        n.close();
      } catch (_) {
        // Already gone.
      }
    };
    const at = n.data ? Number(n.data.shownAt) : NaN;
    const wait = Number.isFinite(at) ? at + MIN_CLOSE_AGE_MS - Date.now() : NaN;
    if (!(wait > 0)) await close();
    // A young one (or one of unknown age, which may be refused now) is
    // closed again once it is old enough.
    if (typeof setTimeout === "function" && work && (wait > 0 || Number.isNaN(wait))) {
      work.pending.push(delay(Math.min(wait > 0 ? wait : MIN_CLOSE_AGE_MS, MIN_CLOSE_AGE_MS)).then(close));
    }
  }
  return true;
}

/** Tells one listed notification from another across getNotifications() calls. */
function notificationKey(n) {
  if (n && n.data && typeof n.data === "object" && n.data.shownId) return `s:${n.data.shownId}`;
  return `n:${(n && n.tag) || ""}\u0000${(n && n.navigate) || ""}\u0000${(n && n.title) || ""}\u0000${(n && n.body) || ""}`;
}

let applePushPromise = null;

/** True when this registration's push subscription is Apple's (WebKit). */
function usesApplePush() {
  if (!applePushPromise) {
    const lookup = (async () => {
      try {
        const subscription = await self.registration.pushManager.getSubscription();
        const host = subscription && subscription.endpoint ? new URL(subscription.endpoint).hostname : "";
        return host === "push.apple.com" || host.endsWith(".push.apple.com");
      } catch (_) {
        return false;
      }
    })();
    applePushPromise = lookup;
    // Look again next time unless it was Apple's: the subscription can change.
    lookup.then((apple) => { if (!apple && applePushPromise === lookup) applePushPromise = null; });
  }
  return applePushPromise;
}

/**
 * A push this worker chose not to announce (a redelivery, mail read in the
 * meantime, a summary whose notification was dismissed or now shows a newer
 * message, an account signed out on purpose). Elsewhere it stays silent; on
 * Apple's push service it must still show one, so it shows, without sound:
 * the account's notification again if one is on screen (still one in the
 * end), else the mail this push is about (its summary when it has one), else
 * a plain "New mail". Nothing private for an account signed out on purpose.
 */
async function acknowledgeUnshownPush(payload, work) {
  if (!(await usesApplePush())) return;
  if (work.trace) work.trace.shown = "ack";
  const accountId = pushPayloadAccountId(payload);
  const tag = "bulwark-mail:" + (accountId || "default");
  const quiet = {
    icon: `${BASE_PATH}/api/pwa-icon/192`,
    badge: `${BASE_PATH}/api/pwa-icon/192`,
    renotify: false,
    silent: true,
  };
  try {
    const signedOut = await pushSignedOut(accountId);
    // Signed out of every account: the subscription has just been dropped
    // (pushSignedOut), so there is nothing left to keep.
    if (signedOut === true && !(await self.registration.pushManager.getSubscription())) return;
    if (signedOut !== false
      || SIGNOUTS_IN_PROGRESS.has("*") || SIGNOUTS_IN_PROGRESS.has(accountId || "default")) {
      await showReplacing("New mail", { ...quiet, tag: PUSH_ACK_TAG, body: "", data: { kind: "push-ack" } }, work);
      return;
    }
    // The account's newest notification (by when its push went out) again,
    // replacing only what is no newer than it.
    const up = await accountNotifications(tag, accountId);
    const top = newestNotification(up || []);
    if (top) {
      await showMailNotification(
        accountId, top.n.title, { ...quiet, tag, body: top.n.body || "", data: top.data }, work,
        replaceKeys(up, top.data.headlineEmailId, top.sentAt),
      );
      if (work.displayed) return;
    }
    const emailIds = payload && Array.isArray(payload.emailIds)
      ? payload.emailIds.filter((id) => typeof id === "string" && id)
      : [];
    const content = buildPayloadEmailContent(payload && payload.email);
    const emailId = emailIds.length > 0 ? emailIds[emailIds.length - 1] : "";
    const sentAt = pushSentAt(payload);
    const data = emailId
      ? { kind: "email", emailId, accountId, headlineEmailId: emailId, ...(sentAt > 0 ? { sentAt } : {}) }
      : { kind: "mail-list", accountId };
    await showMailNotification(
      accountId,
      content ? content.title : "New mail",
      { ...quiet, tag, body: content ? content.body : "", data },
      work,
      // What was up when this was decided on (nothing recognisable: then
      // nothing is replaced, not even one the browser shows meanwhile).
      replaceKeys(up, emailId, pushSentAt(payload)),
    );
    if (!work.displayed) {
      await showReplacing("New mail", { ...quiet, tag: PUSH_ACK_TAG, body: "", data: { kind: "push-ack" } }, work);
    }
  } catch (_) {
    // The browser refused the notification; nothing more can be done.
  }
}

const PUSH_ACK_TAG = "bulwark-push-ack";

async function pushSignedOut(accountId) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    if (await cache.match(signedOutKey("signed-out-all"))) {
      try {
        const subscription = await self.registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
      } catch (_) {
        // Dropped on the next push instead.
      }
      return true;
    }
    return !!(accountId && await cache.match(signedOutKey(`signed-out/${encodeURIComponent(accountId)}`)));
  } catch (_) {
    // Unreadable: neither signed out nor known not to be (null). The caller
    // shows nothing private then.
    return null;
  }
}

// One message often lands in several of the user's accounts at once - a list,
// a forward, the same newsletter on two logins - and each account has its own
// notification. Only the first alert of a burst makes a sound; other accounts'
// alerts within the window show up silently. A second alert for the same
// account still rings, as before. The window runs from the last audible alert
// and is not extended by the silent ones, so a steady trickle still rings
// every so often.
const QUIET_WINDOW_MS = 30_000;

function lastAlertKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/last-alert`;
}

/** True when another account alerted audibly less than QUIET_WINDOW_MS ago; otherwise records this one. */
async function withinQuietWindow(accountId) {
  const now = Date.now();
  const account = accountId || "default";
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(lastAlertKey());
    const lastAlert = res ? await res.json() : null;
    const last = lastAlert ? Number(lastAlert.at) : 0;
    if (last && lastAlert.accountId !== account && now - last >= 0 && now - last < QUIET_WINDOW_MS) return true;
    await cache.put(
      lastAlertKey(),
      new Response(JSON.stringify({ at: now, accountId: account }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (_) {
    // Without the store every notification alerts, as before.
  }
  return false;
}

// Per-account list of message ids we have already shown a notification for.
// Service workers have no localStorage; the Cache API is the cheapest durable
// store that survives the worker being killed between pushes. Failures are
// swallowed - dedupe is a nicety, delivering the notification is not.
const PUSH_STATE_CACHE = "bulwark-push-state-v1";
const NOTIFIED_IDS_LIMIT = 200;

function notifiedIdsKey(accountId) {
  return `${self.location.origin}${BASE_PATH}/__push-state/notified/${encodeURIComponent(accountId || "default")}`;
}

async function readNotifiedIds(accountId) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(notifiedIdsKey(accountId));
    if (!res) return [];
    const data = await res.json();
    return Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === "string") : [];
  } catch (_) {
    return [];
  }
}

async function writeNotifiedIds(accountId, ids) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const unique = Array.from(new Set(ids)).slice(-NOTIFIED_IDS_LIMIT);
    await cache.put(
      notifiedIdsKey(accountId),
      new Response(JSON.stringify({ ids: unique }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (_) {
    // Best effort only.
  }
}

async function handleNotificationClick(event) {
  const data = event.notification.data || {};
  if (data.kind === "protocol-mailto-focus") {
    return handleMailtoFocusNotificationClick();
  }
  // Fork patch (Wnt/webmail): what the tap did, for the tap diagnostics.
  const outcome = { act: "none", win: 0 };
  // This tap is handled here: the page must not take its absence from the
  // list for a lost tap (rememberShown).
  const forgetting = forgetShown((entry) => typeof data.shownId === "string" && entry.shownId === data.shownId);
  try {
    return await notificationClickAction(event, outcome);
  } catch (error) {
    outcome.act = "error";
    throw error;
  } finally {
    await forgetting;
    // Not sent from here: the app this tap starts reads the kept message
    // from the same cache against a short deadline. The app (or the next
    // push) sends it.
    await traceTap("click", {
      target: data.kind === "email" && typeof data.emailId === "string" && data.emailId !== "",
      win: Math.min(outcome.win, 99),
      act: outcome.act,
      age: ageSeconds(data.shownAt),
    });
  }
}

async function notificationClickAction(event, outcome) {
  const data = event.notification.data || {};
  const tag = event.notification.tag || "";
  // Fork patch (Wnt/webmail): when the tap happened, for the app's open timing.
  const clickedAt = Date.now();

  const targetUrl = buildClickUrl(data);

  // Fork patch (Wnt/webmail): leave the message this tap is for where the
  // app reads it when it shows (lib/notification-open.ts), in case neither
  // navigate() nor openWindow() below gets the app there: WebKit may open
  // the Home Screen app at its start page, and navigate() fails on a client
  // this worker does not control.
  await rememberNotificationOpen(data, targetUrl);

  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  outcome.win = allClients.length;

  // Fork patch (Wnt/webmail): the window the tap brings to the front - the
  // one the user looked at last, so a tap never lands in a forgotten tab.
  const ordered = allClients.slice().sort((a, b) => clientFrontRank(a) - clientFrontRank(b));
  const front = ordered.find((client) => "focus" in client);

  // Notify any in-app clients so plugins listening on toastHooks.onNotificationClick fire.
  // Fork patch (Wnt/webmail): the window coming to the front is also asked
  // to open the message itself (`open: true`, with a reply port). A running,
  // signed-in mail app answers at once and opens it in place - no page load,
  // no second app start - so the worker does not navigate it.
  const opensMessage = data.kind === "email" && typeof data.emailId === "string" && data.emailId !== "";
  let opening = Promise.resolve(false);
  for (const client of allClients) {
    if (client === front && opensMessage) {
      opening = askClientToOpen(client, { kind: "notificationclick", tag, data, open: true, at: clickedAt });
      continue;
    }
    try {
      client.postMessage({ kind: "notificationclick", tag, data });
    } catch (_) {
      // Closed or detached client - ignore.
    }
  }

  for (const client of front ? [front, ...ordered.filter((c) => c !== front)] : []) {
    // Reuse an existing tab whenever possible - users on desktop browsers
    // get annoyed when each notification opens a fresh window.
    if ("focus" in client) {
      try {
        // FOCUS FIRST, NAVIGATE SECOND, and the order is the entire fix.
        //
        // A notification click grants the service worker a TRANSIENT USER ACTIVATION, and
        // both focus() and openWindow() refuse to run without one. navigate() SPENDS that
        // activation, and it also replaces the client's document, which invalidates the
        // WindowClient handle we are about to use. Navigating first therefore breaks the
        // click two ways over. Instrumented on Android in a real deployment:
        //
        //   client 1: navigate ok -> focus() threw NotFoundError      (handle stale after nav)
        //   client 2: navigate ok -> focus() threw InvalidAccessError (activation spent)
        //   openWindow()          -> threw InvalidAccessError         (same)
        //
        // Every rejection was swallowed by the catch below, so the toast closed and nothing
        // came to the front. Focusing first uses the activation while it is still live;
        // navigate() does not need one of its own once the client is focused.
        const focused = await client.focus();
        outcome.act = "focus";
        // Fork patch (Wnt/webmail): the app said it opens the message in
        // place - a navigate() now would throw that away and start the
        // whole app again (seconds, measured).
        if (client === front && await opening) {
          outcome.act = "inplace";
          return focused;
        }
        if (focused && "navigate" in focused && targetUrl) {
          try {
            await focused.navigate(targetUrl);
            outcome.act = "navigate";
          } catch (_) {
            // Focused but not navigated still beats nothing opening at all.
          }
        }
        return focused;
      } catch (_) {
        // navigate() can reject for cross-origin or detached clients - fall
        // through and open a new window below.
      }
    }
  }

  if (self.clients.openWindow) {
    const opened = await self.clients.openWindow(targetUrl || `${BASE_PATH}/`);
    outcome.act = "open";
    return opened;
  }
}

// Fork patch (Wnt/webmail): how long a tap waits for a running mail app to
// say it opens the message itself before the worker navigates instead. The
// app answers from its message handler, so this only runs out for a window
// that is not the mail app, not signed in yet, or frozen.
const OPEN_IN_PLACE_WAIT_MS = 1000;

/** Front-most first: focused, then visible, then the rest (stable). */
function clientFrontRank(client) {
  if (client && client.focused) return 0;
  if (client && client.visibilityState === "visible") return 1;
  return 2;
}

/**
 * Posts `message` to `client` with a reply port. Resolves true when the app
 * answers `{ opening: true }` within OPEN_IN_PLACE_WAIT_MS, else false
 * (older app versions never answer: they get the navigation, as before).
 */
function askClientToOpen(client, message) {
  if (typeof MessageChannel !== "function" || typeof setTimeout !== "function") {
    try {
      client.postMessage(message);
    } catch (_) {
      // Closed or detached client - ignore.
    }
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let timer = null;
    const finish = (value) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      channel.port1.onmessage = null;
      try {
        channel.port1.close();
      } catch (_) {
        // Already closed.
      }
      resolve(value);
    };
    timer = setTimeout(() => finish(false), OPEN_IN_PLACE_WAIT_MS);
    channel.port1.onmessage = (event) => finish(!!(event.data && event.data.opening === true));
    try {
      client.postMessage(message, [channel.port2]);
    } catch (_) {
      finish(false);
    }
  });
}

async function focusExistingWindowClient(sourceClientId, requireMailtoReady) {
  const entry = await findReusableWindowClientEntry(sourceClientId, requireMailtoReady);
  const client = entry && entry.client;
  if (client && "focus" in client) {
    return client.focus();
  }
}

async function handleMailtoFocusNotificationClick() {
  const entry = await findReusableWindowClientEntry(null, true);
  const client = entry && entry.client;
  if (client && "focus" in client) {
    try {
      return await client.focus();
    } catch (_) {
      // Fall through to opening a new app window if activation is still blocked.
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(`${BASE_PATH}/`);
  }
}

async function handleOpenMailtoInClient(event) {
  const data = event.data || {};
  const responsePort = event.ports && event.ports[0];
  const entry = await findReusableWindowClientEntry(event.source && event.source.id, true);
  const client = entry && entry.client;
  const state = entry && entry.state;

  if (!client || !state || !state.clientId) {
    responsePort && responsePort.postMessage({ delivered: false });
    return;
  }

  try {
    client.postMessage({ type: "mailto-request", id: data.id, clientId: state.clientId, value: data.value });
  } catch (_) {
    responsePort && responsePort.postMessage({ delivered: false });
    return;
  }

  if ("focus" in client) {
    try {
      await client.focus();
    } catch (_) {
      // Delivery succeeded; focusing can still be blocked by browser policy.
      await showMailtoFocusNotification(state);
    }
  }

  responsePort && responsePort.postMessage({ delivered: true });
}

async function showMailtoFocusNotification(state) {
  try {
    await self.registration.showNotification(state.focusNotificationTitle || "Bulwark", {
      body: state.focusNotificationBody || "The request was opened in Bulwark. Click to bring it to the front.",
      tag: "bulwark-mailto-focus",
      icon: `${BASE_PATH}/api/pwa-icon/192`,
      badge: `${BASE_PATH}/api/pwa-icon/192`,
      data: { kind: "protocol-mailto-focus" },
      renotify: true,
    });
  } catch (_) {
    // Notification permission may be missing; the mailto request was still delivered.
  }
}

async function findReusableWindowClientEntry(sourceClientId, requireMailtoReady) {
  const scopedPath = BASE_PATH ? `${BASE_PATH}/` : "/";
  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const candidates = [];

  for (const client of allClients) {
    if (client.id === sourceClientId) continue;
    const state = MAILTO_CLIENTS.get(client.id);
    if (requireMailtoReady && !state) continue;

    try {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin) continue;
      if (!url.pathname.startsWith(scopedPath)) continue;
      if (url.pathname.includes("/protocol/")) continue;

      candidates.push({ client, state, score: getReusableClientScore(state) });
    } catch (_) {
      // Detached clients can disappear while iterating.
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

/**
 * Whether a client's path is the mail section. Since #733 the mail client
 * keeps a permalink in the address bar, so an open inbox reads as
 * `/mail/folder/inbox` (optionally behind a mount prefix and a locale
 * segment) rather than a bare "/".
 *
 * Deliberately duplicated from lib/deep-links.ts: this file is served raw, not
 * bundled, so it cannot import from the app. The locale segment is matched by
 * shape (two lowercase letters) because the worker has no locale list - and no
 * app route is a bare two-letter segment.
 */
function isMailSectionPath(path) {
  if (!path) return true;
  let rest = path;
  if (BASE_PATH && (rest === BASE_PATH || rest.startsWith(`${BASE_PATH}/`))) {
    rest = rest.slice(BASE_PATH.length);
  }
  const segments = rest.split("/").filter(Boolean);
  if (segments.length > 0 && /^[a-z]{2}$/.test(segments[0])) segments.shift();
  return segments.length === 0 || segments[0] === "mail";
}

function getReusableClientScore(state) {
  if (!state) return 4;

  const isMailSection = isMailSectionPath(state.path);
  if (state.standalone && isMailSection) return 0;
  if (isMailSection) return 1;
  if (state.standalone) return 2;
  return 3;
}

// Fork patch (Wnt/webmail): where a tap on a mail notification goes, as the
// notification's `navigate` URL (WHATWG Notifications). WebKit (Safari 18.4+,
// iOS Home Screen web apps) then opens that URL in the app itself on a tap and
// skips notificationclick, whose WebKit implementation is unreliable for
// Home Screen apps (bugs.webkit.org 268797, 279456, 259212). Browsers without
// it ignore the member and run notificationclick as before.
function notificationNavigateUrl(data) {
  if (!data || (data.kind !== "email" && data.kind !== "mail-list")) return "";
  try {
    return new URL(buildClickUrl(data), self.location.origin).href;
  } catch (_) {
    return "";
  }
}

// Fork patch (Wnt/webmail): the message a tap asked for, kept for a few
// minutes in the push-state cache. The app takes it (once) when it shows:
// on start, after a sign-in, on focus, or on this worker's message.
function notificationOpenKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/notification-open`;
}

async function rememberNotificationOpen(data, url) {
  if (!data || data.kind !== "email" || typeof data.emailId !== "string" || !data.emailId) return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(
      notificationOpenKey(),
      new Response(JSON.stringify({
        emailId: data.emailId,
        slot: Number.isInteger(data.slot) ? data.slot : undefined,
        url,
        at: Date.now(),
      }), { headers: { "Content-Type": "application/json" } }),
    );
  } catch (_) {
    // Best effort: navigate() and openWindow() still carry the link.
  }
}

// Fork patch (Wnt/webmail): every mail notification this worker put on
// screen, by its one-off id, so the app can tell which one was tapped when
// the tap reached neither the worker nor the page. On an iPhone, a tap on a
// notification with a `navigate` URL never fires notificationclick, and when
// the Home Screen app was in the background (the phone asleep) WebKit brings
// its window back without loading that URL (bugs.webkit.org 268797, comments
// 37-38; the owner's iPhone, 2026-10-19). What the tap still does is remove
// that notification from the list: the app compares this ledger with
// registration.getNotifications() when it shows (lib/notification-open.ts).
// An entry leaves when this worker closes the notification itself (marked
// `closed`), when a tap reaches notificationclick, when the user dismisses it
// (notificationclose), at a sign-out, or once the app has looked at it.
// `listed`: the browser listed it right after it was shown, so its absence
// can be trusted to mean something.
const SHOWN_KEEP = 20;

function shownPrefix() {
  return `${self.location.origin}${BASE_PATH}/__push-state/shown/`;
}

async function rememberShown(data, listed) {
  if (!data || data.kind !== "email" || typeof data.emailId !== "string" || !data.emailId
    || typeof data.shownId !== "string" || !data.shownId) return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(`${shownPrefix()}${encodeURIComponent(data.shownId)}`, new Response(JSON.stringify({
      shownId: data.shownId,
      emailId: data.emailId,
      accountId: typeof data.accountId === "string" ? data.accountId : "",
      slot: Number.isInteger(data.slot) ? data.slot : undefined,
      at: Number(data.shownAt) || Date.now(),
      listed: listed === true,
    }), { headers: { "Content-Type": "application/json" } }));
    // Oldest out: keys() lists in insertion order.
    const kept = (await cache.keys()).filter((r) => r.url.startsWith(shownPrefix()));
    for (const r of kept.slice(0, Math.max(0, kept.length - SHOWN_KEEP))) await cache.delete(r);
  } catch (_) {
    // Best effort: without it a lost tap opens the Inbox, as before.
  }
}

async function markShownClosed(shownId) {
  if (typeof shownId !== "string" || !shownId) return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const key = `${shownPrefix()}${encodeURIComponent(shownId)}`;
    const res = await cache.match(key);
    if (!res) return;
    const entry = await res.json();
    await cache.put(key, new Response(JSON.stringify({ ...entry, closed: true }), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (_) {
    // Best effort.
  }
}

async function markShownListed(shownId) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const key = `${shownPrefix()}${encodeURIComponent(shownId)}`;
    const res = await cache.match(key);
    if (!res) return;
    const entry = await res.json();
    await cache.put(key, new Response(JSON.stringify({ ...entry, listed: true }), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (_) {
    // Best effort.
  }
}

/** Drops the ledger entries `match` accepts. */
async function forgetShown(match) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    for (const r of await cache.keys()) {
      if (!r.url.startsWith(shownPrefix())) continue;
      const res = await cache.match(r);
      let entry = null;
      try {
        entry = res ? await res.json() : null;
      } catch (_) {
        entry = null;
      }
      if (!entry || match(entry)) await cache.delete(r);
    }
  } catch (_) {
    // Nothing kept.
  }
}

async function handleNotificationClose(event) {
  const data = (event.notification && event.notification.data) || {};
  if (data.kind !== "email") return;
  await forgetShown((entry) => typeof data.shownId === "string" && entry.shownId === data.shownId);
  await traceTap("close", { age: ageSeconds(data.shownAt) });
  await flushTapTrace();
}

function ageSeconds(shownAt) {
  const at = Number(shownAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.max(0, Math.min(10_000_000, Math.round((Date.now() - at) / 1000)));
}

// Fork patch (Wnt/webmail): the tap diagnostics. Each link of a tap's chain
// (push received, notificationclick, the app's start, how it found the
// message, whether it opened) is one small record: a stage name and yes/no
// facts, never an id, address, subject or content. Records wait in the
// push-state cache and go to /api/perf/tap (read with the ops repo's
// tools/perf-beacon --taps). This worker sends them after a push or a
// dismissal when it can; the app sends what is left once it is signed in
// (lib/tap-trace.ts, same keys).
const TRACE_KEEP = 60;
const TRACE_POST_TIMEOUT_MS = 5000;

function tracePrefix() {
  return `${self.location.origin}${BASE_PATH}/__push-state/tap-trace/`;
}

function engineName() {
  const ua = (self.navigator && self.navigator.userAgent) || "";
  if (/Firefox\//.test(ua)) return "gecko";
  if (/Chrome\/|Chromium\/|Edg\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) return "blink";
  if (/AppleWebKit\//.test(ua)) return "webkit";
  return "other";
}

async function traceTap(ev, facts) {
  try {
    const id = newShownId().replace(/[^0-9a-z]/gi, "").slice(0, 16).toLowerCase();
    const at = Date.now();
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(`${tracePrefix()}${at}-${id}`, new Response(JSON.stringify({
      id, src: "sw", ev, at, sw: SW_REVISION, eng: engineName(), f: facts,
    }), { headers: { "Content-Type": "application/json" } }));
    const kept = (await cache.keys()).filter((r) => r.url.startsWith(tracePrefix()));
    for (const r of kept.slice(0, Math.max(0, kept.length - TRACE_KEEP))) await cache.delete(r);
  } catch (_) {
    // Diagnostics only.
  }
}

async function tracePush(payload, work) {
  // A notification the browser listed only a moment later counts as listed.
  if (work && work.listedCheck) await work.listedCheck;
  if (work && work.keepDone) await work.keepDone;
  const t = (work && work.trace) || {};
  const emailIds = payload && Array.isArray(payload.emailIds) ? payload.emailIds.filter((id) => typeof id === "string" && id) : [];
  let win = 0;
  let vis = false;
  try {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    win = all.length;
    vis = all.some((c) => c.focused || c.visibilityState === "visible");
  } catch (_) {
    // Unknown: reported as none.
  }
  // How late this push was handled: from the gateway's send (`sentAt`, the
  // server's clock) to this event, and from the event to the notification.
  const sentAt = payload && Number(payload.sentAt);
  const receivedAt = work && Number(work.receivedAt);
  const lag = Number.isFinite(sentAt) && sentAt > 0 && Number.isFinite(receivedAt)
    ? Math.max(0, Math.min(10_000_000, Math.round((receivedAt - sentAt) / 1000)))
    : undefined;
  const show = work && work.shownAt && Number.isFinite(receivedAt)
    ? Math.max(0, Math.min(600_000, Math.round(work.shownAt - receivedAt)))
    : undefined;
  await traceTap("push", {
    target: emailIds.length > 0,
    preview: t.preview || "skip",
    shown: work && work.displayed ? (t.shown || "new") : "none",
    nav: t.nav === true,
    listed: t.listed === true,
    win: Math.min(win, 99),
    vis,
    ...(lag !== undefined ? { lag } : {}),
    ...(show !== undefined ? { show } : {}),
    ...(t.over !== undefined ? { over: t.over === true } : {}),
    ...(t.kept ? { kept: t.kept } : {}),
  });
  await flushTapTrace();
}

/** Sends the waiting records; drops them once the server took them (or refused them for good). */
async function flushTapTrace() {
  if (typeof fetch !== "function") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const keys = (await cache.keys()).filter((r) => r.url.startsWith(tracePrefix())).slice(0, 30);
    if (keys.length === 0) return;
    const events = [];
    for (const r of keys) {
      const res = await cache.match(r);
      try {
        if (res) events.push(await res.json());
      } catch (_) {
        // Unreadable: dropped below.
      }
    }
    const controller = typeof AbortController === "function" && typeof setTimeout === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TRACE_POST_TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch(`${BASE_PATH}/api/perf/tap`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, events }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    // 401 (no session cookie right now) and server errors: the app sends them later.
    if (res && (res.ok || res.status === 400 || res.status === 413)) {
      for (const r of keys) await cache.delete(r);
    }
  } catch (_) {
    // Offline: the app sends them later.
  }
}

// Fork patch (Wnt/webmail): the whole message a notification opens, fetched
// with its preview (/api/push/preview?full=1) and kept in the push-state
// cache, so a tap shows it at once: the app takes it once (lib/push-prefetch.ts).
// The newest few only, for a day at most, and none after a sign-out.
const PREFETCH_KEEP = 5;
const PREFETCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function prefetchedPrefix() {
  return `${self.location.origin}${BASE_PATH}/__push-state/prefetched/`;
}

function prefetchedKey(accountId, emailId) {
  return `${prefetchedPrefix()}${encodeURIComponent(accountId || "default")}/${encodeURIComponent(emailId)}`;
}

async function rememberPrefetchedEmail(accountId, email, stillOk) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(prefetchedKey(accountId, email.id), new Response(JSON.stringify({ at: Date.now(), accountId, email }), {
      headers: { "Content-Type": "application/json" },
    }));
    // Not announced to the app when a sign-out came meanwhile (the caller undoes the write).
    if (typeof stillOk === "function" && !stillOk()) return;
    // Fork patch (Wnt/webmail): an open app sanitizes the body ahead of the
    // open and uses the kept copy for a list click too (lib/email-content-cache.ts).
    try {
      for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
        client.postMessage({ kind: "push-kept", accountId: accountId || "", emailId: email.id });
      }
    } catch (_) {
      // No window to tell.
    }
    // Oldest out: keys() lists in insertion order.
    const kept = (await cache.keys()).filter((r) => r.url.startsWith(prefetchedPrefix()));
    for (const r of kept.slice(0, Math.max(0, kept.length - PREFETCH_KEEP))) await cache.delete(r);
    const now = Date.now();
    for (const r of kept.slice(-PREFETCH_KEEP)) {
      const res = await cache.match(r);
      const at = res ? Number((await res.json()).at) : 0;
      if (!(now - at < PREFETCH_MAX_AGE_MS)) await cache.delete(r);
    }
  } catch (_) {
    // Best effort: the tap fetches the message as before.
  }
}

/** Drops one kept message. */
async function forgetPrefetchedEmail(accountId, emailId) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.delete(prefetchedKey(accountId, emailId));
  } catch (_) {
    // Nothing kept.
  }
}

/** Drops the kept messages of `accountIds` (null: of every account). */
async function forgetPrefetchedEmails(accountIds) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const prefixes = accountIds === null
      ? [prefetchedPrefix()]
      : accountIds.map((id) => `${prefetchedPrefix()}${encodeURIComponent(id || "default")}/`);
    for (const r of await cache.keys()) {
      if (prefixes.some((p) => r.url.startsWith(p))) await cache.delete(r);
    }
  } catch (_) {
    // Nothing kept.
  }
}

function buildClickUrl(data) {
  if (!data) return `${BASE_PATH}/`;
  // `?slot=` names the login the message belongs to (see the preview API).
  const slotQuery = Number.isInteger(data.slot) ? `?slot=${data.slot}` : "";
  if (data.kind === "email" && data.emailId) {
    // Permalink (#733). Under NEXT_PUBLIC_LOCALE_PREFIX=always the proxy
    // redirects this to the localised path; the worker has no locale to add.
    return `${BASE_PATH}/mail/message/${encodeURIComponent(data.emailId)}${slotQuery}`;
  }
  // A group of new mail in a known login: that login's Inbox.
  if (data.kind === "mail-list" && slotQuery) {
    return `${BASE_PATH}/mail/folder/inbox${slotQuery}`;
  }
  // Generic "New mail" toast (preview API failed or returned no email): land
  // the user on the latest unread message in their Inbox rather than just the
  // app shell, so the click still feels purposeful.
  return `${BASE_PATH}/?openLatestUnread=1`;
}
