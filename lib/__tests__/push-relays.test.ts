// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RELAY_BASE_URL,
  builtInRelayUrl,
  resolveActiveRelayUrl,
  resolveDefaultRelayUrl,
  resolvePushRelayOptions,
} from '@/lib/push-relays';

// Fork (Wnt/webmail): the test environment sets no NEXT_PUBLIC_PUSH_RELAY_URL,
// so there is no built-in relay. Upstream's hosted relay must never appear.
describe('built-in relay', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is empty without a build-time relay - no hosted fallback', () => {
    expect(DEFAULT_RELAY_BASE_URL).toBe('');
    expect(resolvePushRelayOptions({})).toEqual([]);
    expect(resolveDefaultRelayUrl({})).toBe('');
    expect(resolveActiveRelayUrl({}, 'https://notifications.relay.bulwarkmail.org')).toBe('');
  });

  it('comes from NEXT_PUBLIC_PUSH_RELAY_URL when the build sets it', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUSH_RELAY_URL', 'https://mail.madekivi.fi/relay/');
    vi.resetModules();
    const mod = await import('@/lib/push-relays');
    expect(mod.DEFAULT_RELAY_BASE_URL).toBe('https://mail.madekivi.fi/relay');
    expect(mod.resolvePushRelayOptions({})).toEqual([
      { label: 'mail.madekivi.fi', url: 'https://mail.madekivi.fi/relay' },
    ]);
    expect(mod.resolveDefaultRelayUrl({})).toBe('https://mail.madekivi.fi/relay');
    // The public policy subset (no relay, not locked) still lands on our relay.
    expect(
      mod.resolveActiveRelayUrl({ pushRelays: [], pushRelayUrl: '', pushRelayUrlLocked: false }, ''),
    ).toBe('https://mail.madekivi.fi/relay');
  });

  it('ignores an invalid build-time value', () => {
    expect(builtInRelayUrl(undefined)).toBe('');
    expect(builtInRelayUrl('')).toBe('');
    expect(builtInRelayUrl('mail.madekivi.fi/relay')).toBe('');
    expect(builtInRelayUrl(' https://mail.madekivi.fi/relay// ')).toBe('https://mail.madekivi.fi/relay');
  });
});

describe('resolvePushRelayOptions', () => {
  it('appends admin relays and labels unlabelled ones by host', () => {
    const options = resolvePushRelayOptions({
      pushRelays: [
        { label: 'Company', url: 'https://push.company.example/' },
        { label: '  ', url: 'https://push.other.example' },
      ],
    });

    expect(options).toEqual([
      { label: 'Company', url: 'https://push.company.example' },
      { label: 'push.other.example', url: 'https://push.other.example' },
    ]);
  });

  it('drops invalid and duplicate relays', () => {
    const options = resolvePushRelayOptions({
      pushRelays: [
        { label: 'Empty', url: '' },
        { label: 'Not a URL', url: 'push.company.example' },
        { label: 'Company', url: 'https://push.company.example' },
        { label: 'Dupe', url: 'https://push.company.example/' },
      ],
    });

    expect(options).toHaveLength(1);
  });

  it('keeps a legacy single-URL policy selectable', () => {
    const options = resolvePushRelayOptions({ pushRelayUrl: 'https://legacy.example' });
    expect(options.map((o) => o.url)).toEqual(['https://legacy.example']);
  });
});

describe('resolveActiveRelayUrl', () => {
  const policy = {
    pushRelays: [
      { label: 'Company', url: 'https://push.company.example' },
      { label: 'Other', url: 'https://push.other.example' },
    ],
    pushRelayUrl: 'https://push.company.example',
  };

  it('uses the admin default when the user has not chosen', () => {
    expect(resolveActiveRelayUrl(policy, '')).toBe('https://push.company.example');
  });

  it('honors a user choice that the policy still offers', () => {
    expect(resolveActiveRelayUrl(policy, 'https://push.other.example')).toBe('https://push.other.example');
  });

  it('ignores a user choice the policy does not offer', () => {
    expect(resolveActiveRelayUrl(policy, 'https://attacker.example')).toBe(
      'https://push.company.example',
    );
  });

  it('pins users to the default when the admin locked the choice', () => {
    expect(
      resolveActiveRelayUrl({ ...policy, pushRelayUrlLocked: true }, 'https://push.other.example'),
    ).toBe('https://push.company.example');
  });
});
