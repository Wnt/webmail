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
  const work = { pending: [], displayed: false };
  event.waitUntil(handlePushInOrder(event, work).then(() => Promise.all(work.pending)));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
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
  // through and announce it normally.
  if (payload && payload.renotify === false && emailIds.length > 0
    && notified.includes(emailIds[emailIds.length - 1])) {
    const content = payload.email && typeof payload.email.summary === "string" && payload.email.summary.trim()
      ? buildPayloadEmailContent(payload.email)
      : null;
    // The summary is for the newest of its ids (the gateway summarises the
    // headline message); it only replaces a notification that shows that one.
    if (content) await replaceWithSummary("bulwark-mail:" + (accountId || "default"), content, accountId, emailIds[emailIds.length - 1], work);
    return;
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
  const data = headlineEmailId
    ? {
      kind: "email",
      emailId: headlineEmailId,
      threadId: email && typeof email.threadId === "string" ? email.threadId : undefined,
      slot,
      accountId,
      headlineEmailId,
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

  const quiet = await withinQuietWindow(accountId);
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
  }, work);

  const announced = freshIds.length > 0 ? freshIds : (email ? [email.id] : []);
  if (announced.length > 0) {
    await writeNotifiedIds(accountId, notified.concat(announced));
  }

  // Fork patch (Wnt/webmail): the message this notification opens, kept so a
  // tap shows it without fetching it again (lib/push-prefetch.ts). After the
  // notification is up, so keeping it never delays the alert; not when the
  // account was signed out meanwhile.
  if (preview && preview.full && typeof preview.full === "object" && preview.full.id === headlineEmailId
    && work.displayed && await pushSignedOut(accountId) !== true) {
    await rememberPrefetchedEmail(accountId, preview.full);
  }
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

// Fork patch (Wnt/webmail): replace the account's notification (same tag) with
// the summary, silently, keeping its click data. A notification the user has
// dismissed or opened in the meantime is not brought back, and one that now
// headlines another message (a newer mail arrived, or the summary is a late
// or replayed push) keeps its text: the summary is dropped (audit bulwark-5).
async function replaceWithSummary(tag, content, accountId, headlineEmailId, work) {
  let existing = [];
  try {
    existing = await self.registration.getNotifications({ tag });
  } catch (_) {
    existing = [];
  }
  const current = existing && existing.length > 0 ? existing[existing.length - 1] : null;
  const data = current && current.data;
  if (!data || !headlineEmailId || data.headlineEmailId !== headlineEmailId
    || (data.accountId || "") !== (accountId || "")) return;
  await showMailNotification(accountId, content.title, {
    body: content.body,
    tag,
    icon: `${BASE_PATH}/api/pwa-icon/192`,
    badge: `${BASE_PATH}/api/pwa-icon/192`,
    data,
    renotify: false,
    silent: true,
  }, work);
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
  const closeShown = async () => {
    try {
      for (const n of await self.registration.getNotifications()) {
        const tag = n.tag || "";
        if (tag.startsWith("bulwark-mail:") && affected(tag.slice("bulwark-mail:".length))) n.close();
      }
    } catch (_) {
      // Nothing to close.
    }
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
  const pending = [...PUSH_QUEUES].filter(([key]) => affected(key)).map(([, queue]) => queue);
  const drain = Promise.all(pending).then(() => true, () => true);
  // Answer "done" only once the drain has really finished: a display the
  // browser accepted but has not completed is not settled. Should it take
  // longer than the deadline, answer "not done" and keep suppressing and
  // closing until it has.
  const drained = typeof setTimeout === "function"
    ? await Promise.race([drain, new Promise((resolve) => setTimeout(() => resolve(false), SIGNOUT_DRAIN_MS))])
    : await drain;
  await closeShown();
  // Fork patch (Wnt/webmail): no kept message outlives a sign-out.
  await forgetPrefetchedEmails(everyAccount ? null : accountIds);
  if (port) port.postMessage({ done: drained === true });
  if (!drained) {
    // Still part of this message's lifetime (waitUntil above).
    await drain;
    await closeShown();
  }
  if (persisted) release();
}

// Every mail notification goes through here. The marker is read again right
// before showing, and once more after: a sign-out that landed while this
// handler was busy (its preview lookup, the show itself) closed what was on
// screen before this one appeared, so this one closes itself.
async function showMailNotification(accountId, title, options, work) {
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
  await showReplacing(title, options, work);
  if (await pushSignedOut(accountId) === true) {
    try {
      const shown = await self.registration.getNotifications({ tag: options.tag });
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
async function showReplacing(title, options, work) {
  const shownId = newShownId();
  options = { ...options, data: { ...(options.data || {}), shownId, shownAt: Date.now() } };
  const navigate = notificationNavigateUrl(options.data);
  if (navigate) options.navigate = navigate;
  await self.registration.showNotification(title, options);
  if (work) work.displayed = true;
  await closeOthersWithTag(options.tag, shownId, work);
}

async function closeOthersWithTag(tag, shownId, work) {
  if (!tag) return;
  let shown;
  try {
    shown = await self.registration.getNotifications({ tag });
  } catch (_) {
    return;
  }
  // Only when the new notification can be told apart (its data came back):
  // otherwise this could close the very one just shown.
  if (!shown.some((n) => n.data && n.data.shownId === shownId)) return;
  for (const n of shown) {
    if (n.data && n.data.shownId === shownId) continue;
    const close = () => {
      try {
        n.close();
      } catch (_) {
        // Already gone.
      }
    };
    const at = n.data ? Number(n.data.shownAt) : NaN;
    const wait = Number.isFinite(at) ? at + MIN_CLOSE_AGE_MS - Date.now() : NaN;
    if (!(wait > 0)) close();
    // A young one (or one of unknown age, which may be refused now) is
    // closed again once it is old enough.
    if (typeof setTimeout === "function" && work && (wait > 0 || Number.isNaN(wait))) {
      work.pending.push(delay(Math.min(wait > 0 ? wait : MIN_CLOSE_AGE_MS, MIN_CLOSE_AGE_MS)).then(close));
    }
  }
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
    let current = null;
    try {
      const existing = await self.registration.getNotifications({ tag });
      current = existing && existing.length > 0 ? existing[existing.length - 1] : null;
    } catch (_) {
      current = null;
    }
    if (current) {
      await showMailNotification(accountId, current.title, { ...quiet, tag, body: current.body || "", data: current.data }, work);
      if (work.displayed) return;
    }
    const emailIds = payload && Array.isArray(payload.emailIds)
      ? payload.emailIds.filter((id) => typeof id === "string" && id)
      : [];
    const content = buildPayloadEmailContent(payload && payload.email);
    const emailId = emailIds.length > 0 ? emailIds[emailIds.length - 1] : "";
    const data = emailId
      ? { kind: "email", emailId, accountId, headlineEmailId: emailId }
      : { kind: "mail-list", accountId };
    await showMailNotification(
      accountId,
      content ? content.title : "New mail",
      { ...quiet, tag, body: content ? content.body : "", data },
      work,
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
  const tag = event.notification.tag || "";
  // Fork patch (Wnt/webmail): when the tap happened, for the app's open timing.
  const clickedAt = Date.now();

  if (data.kind === "protocol-mailto-focus") {
    return handleMailtoFocusNotificationClick();
  }

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
        // Fork patch (Wnt/webmail): the app said it opens the message in
        // place - a navigate() now would throw that away and start the
        // whole app again (seconds, measured).
        if (client === front && await opening) return focused;
        if (focused && "navigate" in focused && targetUrl) {
          try {
            await focused.navigate(targetUrl);
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
    return self.clients.openWindow(targetUrl || `${BASE_PATH}/`);
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

async function rememberPrefetchedEmail(accountId, email) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(prefetchedKey(accountId, email.id), new Response(JSON.stringify({ at: Date.now(), accountId, email }), {
      headers: { "Content-Type": "application/json" },
    }));
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
