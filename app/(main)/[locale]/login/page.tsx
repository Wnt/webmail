// Fork (Wnt/webmail): in passkey-entry mode (lib/auth/passkey-entry.ts) the
// login route is a small branded server-rendered page with one sign-in button,
// and the upstream login form (./login-client.tsx, unchanged) never renders.
// The proxy has already sent every visit that should sign in automatically on
// to the provider; what is left here is a sign-out, a failed sign-in, or a
// session cookie the app could not use. Adding an account and the mobile app
// hand-off keep the upstream page.
import { cookies } from "next/headers";
import { configManager } from "@/lib/admin/config-manager";
import { IS_LITE } from "@/lib/lite";
import { passkeyEntryEnabled, SIGNED_OUT_COOKIE, SSO_BEGIN_PATH } from "@/lib/auth/passkey-entry";
import { safeReturnPath } from "@/lib/auth/passkey-entry-shared";
import { PasskeyEntryPage, reasonForSsoError } from "@/components/auth/passkey-entry-page";
import LoginPageClient from "./login-client";

type SearchParams = Record<string, string | string[] | undefined>;

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** A configured asset path under the mount prefix; absolute URLs as they are. */
const asset = (url: string) => (url.startsWith("/") && !url.startsWith("//") ? `${BASE_PATH}${url}` : url);

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
  const signedOut = (await cookies()).has(SIGNED_OUT_COOKIE);
  const reason = reasonForSsoError(first(q.sso_error)) ?? (signedOut ? "signed_out" : null);
  return (
    <PasskeyEntryPage
      appName={configManager.get<string>("appName", "") || process.env.NEXT_PUBLIC_APP_NAME || "Webmail"}
      logoUrl={asset(configManager.get<string>("faviconUrl", "") || "/branding/Bulwark_Favicon.svg")}
      beginAction={`${BASE_PATH}${SSO_BEGIN_PATH}`}
      locale={locale}
      returnTo={safeReturnPath(first(q.return), BASE_PATH)}
      reason={reason}
    />
  );
}
