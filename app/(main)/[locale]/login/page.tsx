// Fork (Wnt/webmail): in passkey-entry mode (lib/auth/passkey-entry.ts) the
// login route hands over to the in-page passkey sign-in (the gate in the locale
// layout), and the upstream login form (./login-client.tsx, unchanged) never
// renders. Adding an account and the mobile app hand-off keep the upstream page.
import { configManager } from "@/lib/admin/config-manager";
import { IS_LITE } from "@/lib/lite";
import { passkeyEntryEnabled } from "@/lib/auth/passkey-entry";
import { safeReturnPath } from "@/lib/auth/passkey-entry-shared";
import { reasonForSsoError } from "@/components/auth/passkey-entry-page";
import { PasskeyLoginRoute } from "@/components/auth/passkey-login-route";
import LoginPageClient from "./login-client";

type SearchParams = Record<string, string | string[] | undefined>;

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);


export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  // The static Lite export has no server: always the upstream page.
  if (IS_LITE) return <LoginPageClient />;
  await configManager.ensureLoaded();
  const q = await searchParams;
  if (!passkeyEntryEnabled() || first(q.mode) || first(q.mobile_redirect_uri)) return <LoginPageClient />;

  const { locale } = await params;
  // The passkey gate in the locale layout signs in; this route asks for it and moves on.
  return (
    <PasskeyLoginRoute
      target={safeReturnPath(first(q.return), BASE_PATH) ?? `${BASE_PATH}/${locale}`}
      reason={reasonForSsoError(first(q.sso_error))}
    />
  );
}
