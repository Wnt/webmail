/**
 * @vitest-environment node
 *
 * Fork (Wnt/webmail): in passkey-entry mode the login route renders the
 * branded page with one sign-in button - never the upstream form - and keeps
 * the upstream page for adding an account and the mobile app hand-off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key in config ? config[key] : fallback)),
  },
}));
// Vite's CSS pipeline would load the app's Tailwind PostCSS config.
vi.mock('@/components/auth/passkey-entry-page.module.css', () => ({ default: new Proxy({}, { get: (_t, k) => String(k) }) }));
vi.mock('@/app/(main)/[locale]/login/login-client', () => ({ default: () => 'UPSTREAM-LOGIN-FORM' }));

import LoginPage from '@/app/(main)/[locale]/login/page';

async function render(search: Record<string, string> = {}) {
  const el = await LoginPage({ params: Promise.resolve({ locale: 'en' }), searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, {
    oauthEnabled: true, oauthOnly: true, autoSsoEnabled: true, jmapServers: [],
    appName: 'Madekivi Mail', faviconUrl: '/branding/Madekivi_Favicon.svg',
  });
});

vi.mock('@/components/auth/passkey-login-route', () => ({
  PasskeyLoginRoute: ({ target, reason }: { target: string; reason: string | null }) => `PASSKEY-ROUTE target=${target} reason=${reason}`,
}));

describe('login route in passkey-entry mode', () => {
  it('hands over to the in-page passkey sign-in, never the upstream form', async () => {
    const html = await render();
    expect(html).not.toContain('UPSTREAM-LOGIN-FORM');
    expect(html).toBe('PASSKEY-ROUTE target=/en reason=null');
  });

  it('says why it is shown and where to go after', async () => {
    expect(await render({ sso_error: 'access_denied' })).toContain('reason=cancelled');
    expect(await render({ sso_error: 'temporarily_unavailable' })).toContain('reason=unavailable');
    expect(await render({ return: '/en/mail/message/M1?slot=0' })).toContain('target=/en/mail/message/M1?slot=0');
    expect(await render({ return: '//evil.example/en' })).toContain('target=/en ');
  });

  it('leaves the upstream page for adding an account, the mobile app, and other modes', async () => {
    expect(await render({ mode: 'add-account' })).toBe('UPSTREAM-LOGIN-FORM');
    expect(await render({ mobile_redirect_uri: 'bulwarkmobile://x' })).toBe('UPSTREAM-LOGIN-FORM');
    config.autoSsoEnabled = false;
    expect(await render()).toBe('UPSTREAM-LOGIN-FORM');
  });
});
