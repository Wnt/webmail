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
const jar = new Set<string>();
vi.mock('next/headers', () => ({ cookies: async () => ({ has: (n: string) => jar.has(n) }) }));
// Vite's CSS pipeline would load the app's Tailwind PostCSS config.
vi.mock('@/components/auth/passkey-entry-page.module.css', () => ({ default: new Proxy({}, { get: (_t, k) => String(k) }) }));
vi.mock('@/app/(main)/[locale]/login/login-client', () => ({ default: () => 'UPSTREAM-LOGIN-FORM' }));

import LoginPage from '@/app/(main)/[locale]/login/page';

async function render(search: Record<string, string> = {}) {
  const el = await LoginPage({ params: Promise.resolve({ locale: 'en' }), searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  jar.clear();
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, {
    oauthEnabled: true, oauthOnly: true, autoSsoEnabled: true, jmapServers: [],
    appName: 'Madekivi Mail', faviconUrl: '/branding/Madekivi_Favicon.svg',
  });
});

describe('login route in passkey-entry mode', () => {
  it('is the branded page with one passkey button that starts the sign-in', async () => {
    const html = await render();
    expect(html).not.toContain('UPSTREAM-LOGIN-FORM');
    expect(html).toContain('Madekivi Mail');
    expect(html).toContain('/branding/Madekivi_Favicon.svg');
    // A link, not a form: form-action 'self' would block the redirect on to a provider elsewhere.
    expect(html).toContain('<a href="/api/auth/sso/begin?locale=en"');
    expect(html).toContain('Kirjaudu passkeyllä / Sign in with passkey');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/type="password"|name="username"/);
    expect(html).not.toContain('<script');
  });

  it('says why it is shown', async () => {
    expect(await render({ sso_error: 'access_denied' })).toContain('Sign-in was cancelled.');
    expect(await render({ sso_error: 'temporarily_unavailable' })).toContain('not available right now');
    expect(await render({ sso_error: 'invalid_state' })).toContain('Sign-in did not complete.');
    jar.add('bulwark_signed_out');
    expect(await render()).toContain('You have signed out.');
  });

  it('keeps a safe return path for the button and drops any other', async () => {
    expect(await render({ return: '/en/mail/message/M1?slot=0' }))
      .toContain('href="/api/auth/sso/begin?locale=en&amp;return=%2Fen%2Fmail%2Fmessage%2FM1%3Fslot%3D0"');
    const html = await render({ return: '//evil.example/en' });
    expect(html).not.toContain('return=');
  });

  it('leaves the upstream page for adding an account, the mobile app, and other modes', async () => {
    expect(await render({ mode: 'add-account' })).toBe('UPSTREAM-LOGIN-FORM');
    expect(await render({ mobile_redirect_uri: 'bulwarkmobile://x' })).toBe('UPSTREAM-LOGIN-FORM');
    config.autoSsoEnabled = false;
    expect(await render()).toBe('UPSTREAM-LOGIN-FORM');
  });
});
