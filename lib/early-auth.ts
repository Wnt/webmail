// Fork (Wnt/webmail): the access-token request of a page start, sent by the
// document's own head script instead of after the app's code has loaded and
// rendered. On a page opened at a message link (a notification tap) or the
// Home Screen app starting, that round trip then runs while the browser
// still loads and runs the app's scripts, instead of after them.
//
// The head script (earlyTokenScript, in the root layout) sends the same
// PUT /api/auth/token?slot=N the restore would send first, for the login the
// restore starts with (checkAuth: the active login, else the default one,
// else the first), and leaves the pending response on `window`. The
// restore takes it (takeEarlyAccessToken) instead of sending its own; nothing
// else reads it. A response nobody takes is harmless: the request only renews
// (or reuses) the slot's token, as the restore's own request would.

import { locales } from '@/i18n/routing';

export const EARLY_TOKEN_GLOBAL = '__mmEarlyToken';
/** A response older than this is not used (the page took long to start); the restore asks again. */
export const EARLY_TOKEN_MAX_AGE_MS = 30_000;

interface EarlyToken {
  slot: number;
  at: number;
  response: Promise<Response>;
  abort: () => void;
}

/**
 * The head script. Runs before the app's scripts: reads the persisted login
 * registry (`account-registry`), and for a mail page (`/`, `/mail/...`)
 * whose first login is an OAuth one, sends its token request. Plain ES5, no
 * dependencies; any error leaves everything to the restore.
 */
export function earlyTokenScript(basePath: string): string {
  return `
                try {
                  (function () {
                    var base = ${JSON.stringify(basePath)};
                    var locales = ${JSON.stringify([...locales])};
                    var path = location.pathname;
                    if (base) {
                      if (path !== base && path.indexOf(base + '/') !== 0) return;
                      path = path.slice(base.length);
                    }
                    var segs = path.split('/').filter(Boolean);
                    var li = -1;
                    for (var i = 0; i < segs.length; i++) { if (locales.indexOf(segs[i]) !== -1) { li = i; break; } }
                    if (!base && li > 0) return;
                    if (li === 0) segs.shift();
                    if (segs.length > 0 && segs[0] !== 'mail') return;
                    var reg = JSON.parse(localStorage.getItem('account-registry') || 'null');
                    var st = reg && reg.state;
                    var accounts = (st && st.accounts) || [];
                    if (!accounts.length) return;
                    var pick = function (id) { for (var j = 0; j < accounts.length; j++) { if (id && accounts[j].id === id) return accounts[j]; } return null; };
                    var auth = JSON.parse(localStorage.getItem('auth-storage') || 'null');
                    var active = auth && auth.state && auth.state.activeAccountId;
                    var a = pick(active) || pick(st.defaultAccountId) || accounts[0];
                    if (!a || a.authMode !== 'oauth' || a.awaitingSignIn || typeof a.cookieSlot !== 'number') return;
                    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
                    var res = fetch(base + '/api/auth/token?slot=' + a.cookieSlot, { method: 'PUT', signal: ctl ? ctl.signal : undefined });
                    res.catch(function () {});
                    window.${EARLY_TOKEN_GLOBAL} = { slot: a.cookieSlot, at: Date.now(), response: res, abort: function () { if (ctl) ctl.abort(); } };
                  })();
                } catch (e) {}`;
}

/**
 * The head script's pending token response for `slot`, taken once. Null when
 * there is none, it is for another slot, or it is too old (then it is dropped).
 */
export function takeEarlyAccessToken(slot: number, now: number = Date.now()): EarlyToken | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  const early = w[EARLY_TOKEN_GLOBAL] as EarlyToken | undefined;
  if (!early) return null;
  try {
    delete w[EARLY_TOKEN_GLOBAL];
  } catch {
    w[EARLY_TOKEN_GLOBAL] = undefined;
  }
  if (!early || typeof early !== 'object' || early.slot !== slot || !early.response || typeof early.response.then !== 'function') return null;
  const at = Number(early.at);
  if (!Number.isFinite(at) || now - at > EARLY_TOKEN_MAX_AGE_MS || at > now + 60_000) return null;
  return early;
}
