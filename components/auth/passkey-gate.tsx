"use client";

// Fork (Wnt/webmail): the in-page passkey sign-in (lib/auth/passkey-entry.ts).
//
// Mounted by the locale layout around every page in passkey-entry mode. When
// a sign-in is needed - no session cookie in the first request (so the screen
// is already in the server's HTML), or later through the stores' "go to the
// login page" (stores/passkey-gate-store.ts) - it covers the page the user
// opened with the Madekivi Mail passkey screen and signs in right there:
//
//   POST <passkey_challenge_endpoint>   challenge + CSRF token (gateway /auth/fp/options)
//   navigator.credentials.get()         same origin: the gateway's RP ID and origin
//   POST <authorization_challenge_endpoint>  assertion + PKCE challenge -> code
//   POST /api/auth/sso/code             code + verifier -> Bulwark's session cookies
//
// No redirect, no second document: the page underneath starts afresh once
// signed in and simply shows what was asked for - a deep link included.
//
// The prompt opens by itself only on a visible, focused page the user opened
// themselves or from this origin, and not after an explicit sign-out or a
// failed sign-in; a refused or cancelled prompt waits for the one button,
// which calls get() straight from the tap (the challenge is already here:
// WebKit can lose a tap's activation to a network round trip). Without the
// provider's first-party endpoints the button (and the automatic start) take
// the redirect flow instead.

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { usePasskeyGateStore } from "@/stores/passkey-gate-store";
import { generateCodeChallenge, generateCodeVerifier } from "@/lib/oauth/pkce";
import { SIGNED_OUT_COOKIE } from "@/lib/auth/passkey-entry-shared";
import { locales } from "@/i18n/routing";
import type { PasskeyGateConfig } from "@/lib/auth/passkey-entry";
import { PasskeyEntryPage, beginHref, type PasskeyEntryReason } from "./passkey-entry-page";

/** The gateway keeps a challenge 120 s; one older than this leaves too little for the ceremony. */
const CHALLENGE_FRESH_MS = 60 * 1000;

interface Prepared {
  options: PublicKeyCredentialRequestOptionsJSONLike;
  csrf: string;
  verifier: string;
  codeChallenge: string;
  at: number;
}

interface PublicKeyCredentialRequestOptionsJSONLike {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: { id: string; type: string; transports?: string[] }[];
  userVerification?: UserVerificationRequirement;
}

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64url = (buf: ArrayBuffer | null): string | undefined => {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function requestOptions(o: PublicKeyCredentialRequestOptionsJSONLike): PublicKeyCredentialRequestOptions {
  return {
    challenge: b64urlToBytes(o.challenge),
    timeout: o.timeout,
    rpId: o.rpId,
    userVerification: o.userVerification,
    allowCredentials: (o.allowCredentials ?? []).map((c) => ({
      id: b64urlToBytes(c.id),
      type: "public-key" as const,
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };
}

/** The assertion in the JSON form the provider verifies (WebAuthn L3 toJSON(), done by hand for older browsers). */
function assertionJSON(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      authenticatorData: bytesToB64url(r.authenticatorData),
      signature: bytesToB64url(r.signature),
      userHandle: bytesToB64url(r.userHandle),
    },
  };
}

class GateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Only ever this page's own origin: a path the server checked, resolved here and checked again. */
function sameOriginUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new GateError("cross_origin");
  return url.href;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const res = await fetch(sameOriginUrl(path), {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> | null = null;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  if (!res.ok) throw new GateError(typeof data?.error === "string" ? data.error : `http_${res.status}`);
  return data ?? {};
}

const WAITING = { text: "Odotetaan passkeytä… / Waiting for your passkey…", error: false };
const TAP = { text: "Napauta painiketta kirjautuaksesi. / Tap the button to sign in.", error: false };
const CANCELLED = { text: "Passkey-kysely peruttiin tai aikakatkaistiin. / The passkey prompt was cancelled or timed out.", error: true };

function explain(err: unknown): { text: string; error: boolean } {
  const code = err instanceof GateError ? err.code : "";
  if (code === "rate_limited") return { text: "Liian monta yritystä. Odota hetki. / Too many attempts. Wait a minute and try again.", error: true };
  if (code === "account_not_allowed") return { text: "Tällä tilillä ei voi kirjautua. / This account is not allowed to sign in.", error: true };
  if (code === "verification_failed") return { text: "Passkeytä ei voitu vahvistaa. Yritä uudelleen. / The passkey could not be verified. Try again.", error: true };
  return { text: "Kirjautuminen ei onnistunut. Yritä uudelleen. / Sign-in did not complete. Try again.", error: true };
}

function signedOutCookie(): boolean {
  try {
    return new RegExp(`(?:^|; )${SIGNED_OUT_COOKIE}=`).test(document.cookie);
  } catch {
    return false;
  }
}

export function PasskeyGate({ config, children }: { config: PasskeyGateConfig | null; children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { requested, epoch, reason: requestedReason, returnTo: requestedReturn } = usePasskeyGateStore();
  const [signedInHere, setSignedInHere] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  // The redirect flow's callback page completes its own sign-in.
  const onCallback = /\/auth\/callback\/?$/.test(pathname);
  // The login route asks for the gate itself (passkey-login-route.tsx); its
  // upstream flows (adding an account, the mobile hand-off) never do.
  const onLogin = /\/login\/?$/.test(pathname);
  const visible = !!config && !onCallback && !isAuthenticated
    && (requested || (!onLogin && config.noSession && !signedInHere));
  const firstParty = config?.firstParty ?? null;

  useEffect(() => {
    if (!config) return;
    usePasskeyGateStore.getState().setActive(true);
    return () => usePasskeyGateStore.getState().setActive(false);
  }, [config]);

  const prepared = useRef<Prepared | null>(null);
  const preparing = useRef<Promise<Prepared> | null>(null);
  const running = useRef(false);
  const autoDone = useRef(false);
  // Every showing of the gate is one generation: hiding or unmounting it
  // aborts what is in flight (fetches, the passkey prompt), and nothing that
  // resolves later for an old generation sends another request or signs in.
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const current = () => ({ gen: generation.current, signal: abort.current?.signal });
  const stale = (gen: number) => gen !== generation.current;

  useEffect(() => {
    if (!visible) return;
    generation.current += 1;
    abort.current = new AbortController();
    return () => {
      generation.current += 1;
      abort.current?.abort();
      abort.current = null;
      prepared.current = null;
      preparing.current = null;
      running.current = false;
    };
  }, [visible]);

  const prepare = useCallback((): Promise<Prepared> => {
    if (!firstParty) return Promise.reject(new GateError("no_first_party"));
    if (!preparing.current) {
      const { gen, signal } = current();
      preparing.current = (async () => {
        const verifier = generateCodeVerifier();
        const [data, codeChallenge] = await Promise.all([
          postJson(firstParty.optionsPath, {}, {}, signal),
          generateCodeChallenge(verifier),
        ]);
        if (stale(gen)) throw new GateError("stale");
        const p: Prepared = {
          options: data.options as PublicKeyCredentialRequestOptionsJSONLike,
          csrf: String(data.csrf ?? ""),
          verifier,
          codeChallenge,
          at: Date.now(),
        };
        prepared.current = p;
        return p;
      })().finally(() => {
        preparing.current = null;
      });
    }
    return preparing.current;
  }, [firstParty]);

  const fresh = () => (prepared.current && Date.now() - prepared.current.at < CHALLENGE_FRESH_MS ? prepared.current : null);

  const signIn = useCallback(async (p: Prepared, auto: boolean) => {
    if (running.current || !firstParty) return;
    const { gen, signal } = current();
    running.current = true;
    setBusy(true);
    setStatus(WAITING);
    try {
      let cred: PublicKeyCredential | null;
      try {
        cred = (await navigator.credentials.get({ publicKey: requestOptions(p.options), signal })) as PublicKeyCredential | null;
      } catch (err) {
        if (stale(gen)) return;
        const name = err instanceof DOMException ? err.name : "";
        if (name === "AbortError") return;
        // Cancelled, timed out, or (on load) not allowed without a tap: the same answer either way.
        setStatus(name === "NotAllowedError" ? (auto ? TAP : CANCELLED) : explain(err));
        return;
      }
      if (stale(gen)) return;
      if (!cred) {
        setStatus(auto ? TAP : CANCELLED);
        return;
      }
      prepared.current = null; // the provider spends the challenge, whatever the outcome
      const out = await postJson(
        firstParty.authorizePath,
        {
          client_id: firstParty.clientId,
          redirect_uri: firstParty.redirectUri,
          scope: firstParty.scope,
          code_challenge: p.codeChallenge,
          code_challenge_method: "S256",
          assertion: assertionJSON(cred),
        },
        { "X-Gateway-CSRF": p.csrf },
        signal,
      );
      if (stale(gen)) return;
      const code = typeof out.code === "string" ? out.code : "";
      if (!code) throw new GateError("no_code");
      const ok = await useAuthStore.getState().loginWithServerSso(code, null, {
        codeVerifier: p.verifier,
        redirectUri: firstParty.redirectUri,
      });
      if (!ok) throw new GateError("token_exchange_failed");
      setStatus(null);
      setSignedInHere(true);
      usePasskeyGateStore.getState().signedIn();
    } catch (err) {
      if (!stale(gen)) setStatus(explain(err));
    } finally {
      if (!stale(gen)) {
        running.current = false;
        setBusy(false);
        // Have the next challenge ready for the tap.
        if (!useAuthStore.getState().isAuthenticated && !fresh()) prepare().catch(() => { /* the tap fetches one */ });
      }
    }
  }, [firstParty, prepare]);

  const reason: PasskeyEntryReason = requestedReason ?? (visible && (config?.signedOut || signedOutCookie()) ? "signed_out" : null);
  // Where the redirect-flow fallback returns: what the login route was asked
  // for, else this page (its address may lack the locale: the proxy serves
  // those in place, and the return path is checked with the locale in it).
  const fallbackReturn = requestedReturn ?? (visible && config ? currentPath(config.locale) : null);
  const mayAutostart = !!config?.autostart && !reason;

  // Shown: fetch the challenge, and make the one automatic attempt where allowed.
  useEffect(() => {
    if (!visible || !config) return;
    autoDone.current = false;
    if (!firstParty) {
      // Redirect flow (no first-party endpoints): it starts by itself as before.
      if (mayAutostart) window.location.assign(beginHref(config.beginAction, config.locale, fallbackReturn));
      return;
    }
    prepare().catch((err) => { if (!(err instanceof GateError && err.code === "stale")) setStatus(explain(err)); });
    if (!mayAutostart) return;
    const active = () => document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus());
    // One automatic attempt, consumed as soon as it starts: whatever goes
    // wrong after that (a failed fetch, a refused prompt), only a tap retries.
    const attempt = () => {
      if (autoDone.current || running.current || !active()) return; // a later focus or visibility change tries
      autoDone.current = true;
      const p = fresh();
      (p ? Promise.resolve(p) : prepare())
        .then((ready) => {
          if (running.current) return;
          if (!active()) { setStatus(TAP); return; } // hidden meanwhile: the tap, not a later surprise
          return signIn(ready, true);
        })
        .catch((err) => { if (!(err instanceof GateError && err.code === "stale")) setStatus(explain(err)); });
    };
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    attempt();
    return () => {
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
    };
  }, [visible, config, firstParty, mayAutostart, prepare, signIn, fallbackReturn]);

  const onTap = useCallback(() => {
    autoDone.current = true; // the tap takes over from any automatic attempt
    const p = fresh();
    if (p) {
      void signIn(p, false); // no await before get(): the tap's activation is still live
      return;
    }
    setStatus(WAITING);
    prepare().then((ready) => signIn(ready, false), (err) => setStatus(explain(err)));
  }, [prepare, signIn]);

  return (
    <>
      <div style={{ display: "contents" }} inert={visible || undefined} aria-hidden={visible || undefined}>
        <Fragment key={epoch}>{children}</Fragment>
      </div>
      {visible && config ? (
        <PasskeyEntryPage
          appName={config.appName}
          logoUrl={config.logoUrl}
          beginAction={config.beginAction}
          locale={config.locale}
          returnTo={fallbackReturn}
          reason={reason}
          onSignIn={firstParty ? onTap : undefined}
          busy={busy}
          status={status}
        />
      ) : null}
    </>
  );
}

/** Where the user is, with the locale in the path (for the redirect flow's return); null on the server. */
function currentPath(locale: string): string | null {
  if (typeof window === "undefined") return null;
  const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
  const { pathname, search } = window.location;
  const rest = base && pathname.startsWith(base) ? pathname.slice(base.length) || "/" : pathname;
  const first = rest.split("/")[1] ?? "";
  const localized = first === locale || (locales as readonly string[]).includes(first) ? rest : `/${locale}${rest === "/" ? "" : rest}`;
  return `${base}${localized}${search}`;
}
