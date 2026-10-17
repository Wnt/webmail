// Fork (Wnt/webmail): the login page in passkey-entry mode
// (lib/auth/passkey-entry.ts). A server component with no script: one button
// that starts the sign-in (/api/auth/sso/begin), which goes straight on to
// the provider's passkey prompt. Shown only where signing in automatically
// would be wrong - after an explicit sign-out, after a failed or cancelled
// sign-in - so the upstream login form never renders in this mode.
//
// The wording is Finnish and English side by side, as on the gateway's pages:
// the owner's locale (fi) is not one of the app's.

import styles from './passkey-entry-page.module.css';

export type PasskeyEntryReason = 'signed_out' | 'error' | 'cancelled' | 'unavailable' | null;

export interface PasskeyEntryPageProps {
  appName: string;
  /** Mark that follows the colour scheme itself (an SVG with its own media query). */
  logoUrl: string;
  /** `<basePath>/api/auth/sso/begin` */
  beginAction: string;
  locale: string;
  returnTo: string | null;
  reason: PasskeyEntryReason;
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

export const PASSKEY_BUTTON_LABEL = 'Kirjaudu passkeyllä / Sign in with passkey';

export function PasskeyEntryPage({ appName, logoUrl, beginAction, locale, returnTo, reason }: PasskeyEntryPageProps) {
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
        {/* A plain GET navigation: no script needed, and the passkey prompt on the next page follows this tap. */}
        <form method="get" action={beginAction}>
          <input type="hidden" name="locale" value={locale} />
          {returnTo ? <input type="hidden" name="return" value={returnTo} /> : null}
          <button type="submit" className={styles.button} autoFocus>
            {PASSKEY_BUTTON_LABEL}
          </button>
        </form>
      </div>
    </main>
  );
}
