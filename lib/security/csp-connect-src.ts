// Fork (Wnt/webmail): a connect-src that names the origins this deployment
// actually talks to, instead of upstream's blanket `'self' https:`.
//
// The browser fetches only from the webmail itself, the configured JMAP
// server(s) and the push relay(s). `https:` stays when the deployment lets
// users type their own JMAP endpoint or runs plugins (their api.http.fetch
// targets are per-plugin), since those destinations are not known here.
// CSP_CONNECT_SRC_EXTRA (space-separated origins) is the escape hatch for a
// JMAP session that points at another host.

export interface ConnectSrcInput {
  isDev: boolean;
  /** Users may enter any JMAP server URL. */
  allowCustomJmapEndpoint: boolean;
  /** Plugins may fetch their own declared origins from the page. */
  pluginsEnabled: boolean;
  /** URLs the page is known to call: JMAP servers, push relays. */
  urls: ReadonlyArray<string | null | undefined>;
  /** CSP_CONNECT_SRC_EXTRA. */
  extra?: string | null;
}

/** The scheme://host[:port] of an http(s) URL, or null. */
export function httpOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function buildConnectSrc(input: ConnectSrcInput): string {
  if (input.isDev) return `'self' http: https: ws: wss:`;
  const sources: string[] = [`'self'`];
  const seen = new Set<string>();
  const add = (origin: string | null) => {
    if (!origin) return;
    const key = origin.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(origin);
  };
  for (const url of input.urls) add(httpOrigin(url));
  for (const token of (input.extra ?? '').split(/\s+/)) add(httpOrigin(token));
  if (input.allowCustomJmapEndpoint || input.pluginsEnabled) sources.push('https:');
  return sources.join(' ');
}
