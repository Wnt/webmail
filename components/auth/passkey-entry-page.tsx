// Fork (Wnt/webmail): the passkey screen of the passkey entry
// (lib/auth/passkey-entry.ts). Presentational, for the server and the client:
// the in-page sign-in (components/auth/passkey-gate.tsx) passes `onSignIn`
// and a status line; without it the one button is a plain link into the
// redirect flow (/api/auth/sso/begin), which needs no script at all.
//
// The wording is Finnish and English side by side, as on the gateway's pages:
// the owner's locale (fi) is not one of the app's.

import styles from './passkey-entry-page.module.css';

export type PasskeyEntryReason = 'signed_out' | 'error' | 'cancelled' | 'unavailable' | null;

export interface PasskeyEntryPageProps {
  appName: string;
  /** Mark that follows the colour scheme itself (an SVG with its own media query). */
  logoUrl: string;
  /** `<basePath>/api/auth/sso/begin`, where the button links to */
  beginAction: string;
  locale: string;
  returnTo: string | null;
  reason: PasskeyEntryReason;
  /** In-page sign-in: the button runs this instead of linking to the redirect flow. */
  onSignIn?: () => void;
  busy?: boolean;
  /** A live status line under the button (waiting, cancelled, ...). */
  status?: { text: string; error: boolean } | null;
}

const NOTICES: Record<Exclude<PasskeyEntryReason, null>, { text: string; error: boolean }> = {
  signed_out: { text: 'Kirjauduit ulos. / You have signed out.', error: false },
  cancelled: { text: 'Kirjautuminen keskeytyi. / Sign-in was cancelled.', error: true },
  unavailable: {
    text: 'Kirjautuminen ei juuri nyt onnistu. Yritä hetken päästä uudelleen. / Sign-in is not available right now. Try again in a moment.',
    error: true,
  },
  error: { text: 'Kirjautuminen ei onnistunut. Yritä uudelleen. / Sign-in did not complete. Try again.', error: true },
};

/** Which notice an `sso_error` code gets. */
export function reasonForSsoError(code: string | undefined): PasskeyEntryReason {
  if (!code) return null;
  if (code === 'access_denied') return 'cancelled';
  if (code === 'temporarily_unavailable' || code === 'server_error') return 'unavailable';
  return 'error';
}

/** `<begin>?locale=..[&return=..]` */
export function beginHref(beginAction: string, locale: string, returnTo: string | null): string {
  const q = new URLSearchParams({ locale });
  if (returnTo) q.set('return', returnTo);
  return `${beginAction}?${q.toString()}`;
}

export const PASSKEY_BUTTON_LABEL = 'Kirjaudu passkeyllä / Sign in with passkey';

export function PasskeyEntryPage({ appName, logoUrl, beginAction, locale, returnTo, reason, onSignIn, busy, status }: PasskeyEntryPageProps) {
  const notice = reason ? NOTICES[reason] : null;
  return (
    <main className={styles.page} data-passkey-entry="">
      <div className={styles.card}>
        <header className={styles.brand}>
          <img src={logoUrl} alt="" width={32} height={32} />
          <span>{appName}</span>
        </header>
        <h1 className={styles.title}>Kirjaudu sisään / Sign in</h1>
        {notice ? (
          <p className={styles.notice} data-kind={notice.error ? 'error' : 'info'} role={notice.error ? 'alert' : 'status'}>
            {notice.text}
          </p>
        ) : (
          <p className={styles.text}>Jatka passkeyllä. / Continue with your passkey.</p>
        )}
        {onSignIn ? (
          <button type="button" className={styles.button} onClick={onSignIn} disabled={busy} autoFocus>
            {PASSKEY_BUTTON_LABEL}
          </button>
        ) : (
          /* A plain link, not a form: the page's CSP limits form targets to
             this origin, and a browser applies that to the redirect on to an
             identity provider elsewhere. */
          <a href={beginHref(beginAction, locale, returnTo)} className={styles.button} autoFocus>
            {PASSKEY_BUTTON_LABEL}
          </a>
        )}
        <p className={styles.status} data-kind={status?.error ? 'error' : 'info'} role="status" aria-live="polite" id="passkey-status">
          {status?.text ?? ''}
        </p>
      </div>
    </main>
  );
}
