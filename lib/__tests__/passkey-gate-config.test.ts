/**
 * @vitest-environment node
 *
 * Fork (Wnt/webmail): what the server tells the in-page passkey sign-in
 * (lib/auth/passkey-entry.ts passkeyGateConfig): the provider's first-party
 * endpoints only on this very origin, whether there is a session at all, an
 * explicit sign-out, and whether the page may ask without a tap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key in config ? config[key] : fallback)),
  },
}));
let reqHeaders = new Headers();
let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => reqHeaders,
  cookies: async () => ({ getAll: () => [...jar].map(([name, value]) => ({ name, value })), has: (n: string) => jar.has(n) }),
}));
let metadata: Record<string, string> | null = null;
vi.mock('@/lib/oauth/discovery', () => ({ discoverOAuth: vi.fn(async () => metadata) }));
vi.mock('@/lib/oauth/token-exchange', () => ({
  getRequiredConfig: () => ({ clientId: 'bulwark', discoveryUrl: 'https://mail.example.org' }),
  getDiscoveryValidator: () => undefined,
}));

import { passkeyGateConfig } from '@/lib/auth/passkey-entry';

const GW = 'https://mail.example.org';

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, { oauthEnabled: true, oauthOnly: true, autoSsoEnabled: true, jmapServers: [], oauthScopes: 'mail', appName: 'Madekivi Mail', faviconUrl: '/branding/Madekivi_Favicon.svg' });
  reqHeaders = new Headers({ host: '0.0.0.0:3000', 'x-forwarded-host': 'mail.example.org', 'x-forwarded-proto': 'https', 'sec-fetch-site': 'none' });
  jar = new Map();
  metadata = {
    issuer: GW, authorization_endpoint: `${GW}/oauth/authorize`, token_endpoint: `${GW}/oauth/token`,
    authorization_challenge_endpoint: `${GW}/auth/fp/authorize`, passkey_challenge_endpoint: `${GW}/auth/fp/options`,
  };
});

describe('passkeyGateConfig', () => {
  it('gives the page the first-party endpoints as same-origin paths', async () => {
    const c = (await passkeyGateConfig('en'))!;
    expect(c.firstParty).toEqual({
      optionsPath: '/auth/fp/options', authorizePath: '/auth/fp/authorize', clientId: 'bulwark', scope: 'mail',
      redirectUri: 'https://mail.example.org/en/auth/callback',
    });
    expect(c).toMatchObject({ appName: 'Madekivi Mail', logoUrl: '/branding/Madekivi_Favicon.svg', locale: 'en', beginAction: '/api/auth/sso/begin', noSession: true, signedOut: false, autostart: true });
  });

  it('never points the page at another origin: then the redirect flow', async () => {
    metadata = { ...metadata!, passkey_challenge_endpoint: 'https://evil.example/auth/fp/options' };
    expect((await passkeyGateConfig('en'))!.firstParty).toBeNull();
    metadata = { ...metadata!, passkey_challenge_endpoint: `${GW}//elsewhere.invalid/options` };
    expect((await passkeyGateConfig('en'))!.firstParty, 'a //host path is another origin in the browser').toBeNull();
    metadata = { ...metadata!, passkey_challenge_endpoint: `${GW}/auth/fp/options` };
    reqHeaders.set('x-forwarded-host', 'other.example.org');
    expect((await passkeyGateConfig('en'))!.firstParty).toBeNull();
    metadata = { issuer: GW, authorization_endpoint: `${GW}/oauth/authorize`, token_endpoint: `${GW}/oauth/token` };
    reqHeaders.set('x-forwarded-host', 'mail.example.org');
    expect((await passkeyGateConfig('en'))!.firstParty).toBeNull();
    metadata = null;
    expect((await passkeyGateConfig('en'))!.firstParty).toBeNull();
  });

  it('knows a session cookie and an explicit sign-out', async () => {
    jar.set('jmap_rt_1', 'x');
    expect((await passkeyGateConfig('en'))!.noSession).toBe(false);
    jar = new Map([['bulwark_signed_out', '1']]);
    const c = (await passkeyGateConfig('en'))!;
    expect(c.noSession).toBe(true);
    expect(c.signedOut).toBe(true);
  });

  it('may ask without a tap only for a page the user opened themselves or from this origin', async () => {
    for (const [site, auto] of [['none', true], ['same-origin', true], ['same-site', false], ['cross-site', false]] as const) {
      reqHeaders.set('sec-fetch-site', site);
      expect((await passkeyGateConfig('en'))!.autostart, site).toBe(auto);
    }
    reqHeaders.delete('sec-fetch-site');
    expect((await passkeyGateConfig('en'))!.autostart).toBe(false);
  });

  it('is off outside passkey-entry mode', async () => {
    config.autoSsoEnabled = false;
    expect(await passkeyGateConfig('en')).toBeNull();
  });
});
