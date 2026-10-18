// Fork (Wnt/webmail): the JMAP session of each login, kept from the last
// visit, so a page start (a notification tap's message link, the Home Screen
// app opening) is signed in after the access-token request alone instead of
// that request and then GET /.well-known/jmap.
//
// The session holds the server's URLs, the account ids and capabilities: no
// credentials. It is only a starting point. The client checks it right after
// it is used (and whenever a JMAP response names another sessionState), and a
// changed account or API URL makes the page start again with the server's
// session (see JMAPClient.adoptSession / revalidateSession). An entry is
// dropped with its login (sign-out, removal) and is used only for the login
// (server and user name) it was saved for.

const PREFIX = 'jmap-session:v1:';
/** Older entries are not used: the next start fetches the session as before. */
export const SESSION_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Entry {
  at: number;
  serverUrl: string;
  username: string;
  session: Record<string, unknown>;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function norm(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

/** The session saved for `accountId`, if it was saved for this server and user and is not too old. */
export function readCachedSession(accountId: string, serverUrl: string, username: string, now: number = Date.now()): Record<string, unknown> | null {
  const store = storage();
  if (!store || !accountId) return null;
  try {
    const raw = store.getItem(PREFIX + accountId);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<Entry> | null;
    if (!entry || typeof entry !== 'object' || !entry.session || typeof entry.session !== 'object') return null;
    if (entry.serverUrl !== norm(serverUrl) || entry.username !== username) return null;
    const at = Number(entry.at);
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > SESSION_CACHE_MAX_AGE_MS) return null;
    return entry.session;
  } catch {
    return null;
  }
}

/** Saves the server's session (as the server sent it) for `accountId`. */
export function writeCachedSession(accountId: string, serverUrl: string, username: string, session: Record<string, unknown>, now: number = Date.now()): void {
  const store = storage();
  if (!store || !accountId || !session) return;
  try {
    const entry: Entry = { at: now, serverUrl: norm(serverUrl), username, session };
    store.setItem(PREFIX + accountId, JSON.stringify(entry));
  } catch {
    // Storage full or blocked: the next start fetches the session.
  }
}

/** Drops the session saved for `accountId`. */
export function forgetCachedSession(accountId: string): void {
  const store = storage();
  if (!store || !accountId) return;
  try {
    store.removeItem(PREFIX + accountId);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}

/** Drops every saved session (a full sign-out, clearing the cached data). */
export function forgetAllCachedSessions(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}
