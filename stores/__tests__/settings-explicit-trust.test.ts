import { beforeEach, describe, expect, it } from 'vitest';
import { migrateSettings, useSettingsStore } from '../settings-store';

// Fork (Wnt/webmail), owner decision 2026-10-20: trust for remote content
// comes only from the user's own "Always trust this sender" or a sender added
// in Settings. Trust held before that rule - possibly added automatically for
// every reply's recipients, or a trusted-senders book option switched on
// automatically - is kept unused as "unconfirmed" and grants nothing, whether
// it comes from this browser's storage (migration v8) or from an older
// settings copy (server sync or an export file, importSettings).

const OLD = 'old-entry@example.test';
const NEW = 'clicked@example.test';

beforeEach(() => {
  useSettingsStore.setState({
    trustedSenders: [], trustedSendersAddressBook: null,
    unconfirmedTrustedSenders: [], unconfirmedTrustedSendersAddressBook: false,
  } as never);
});

describe('settings migration v8', () => {
  it('moves the old list and an automatically enabled book option to unconfirmed', () => {
    const migrated = migrateSettings({ trustedSenders: [OLD], trustedSendersAddressBook: true }, 7) as unknown as Record<string, unknown>;
    expect(migrated.trustedSenders).toEqual([]);
    expect(migrated.unconfirmedTrustedSenders).toEqual([OLD]);
    expect(migrated.trustedSendersAddressBook).toBeNull();
    expect(migrated.unconfirmedTrustedSendersAddressBook).toBe(true);
    expect(migrated.trustModel).toBe('explicit');
    useSettingsStore.setState(migrated as never);
    expect(useSettingsStore.getState().isSenderTrusted(OLD)).toBe(false);
  });

  it('leaves a record already under the rule alone', () => {
    const migrated = migrateSettings({ trustedSenders: [NEW], trustedSendersAddressBook: true, trustModel: 'explicit' }, 8) as unknown as Record<string, unknown>;
    expect(migrated.trustedSenders).toEqual([NEW]);
    expect(migrated.trustedSendersAddressBook).toBe(true);
  });
});

describe('importSettings', () => {
  it('an older settings copy grants no trust and keeps its list as unconfirmed', () => {
    expect(useSettingsStore.getState().importSettings(JSON.stringify({ trustedSenders: [OLD], trustedSendersAddressBook: true }))).toBe(true);
    const s = useSettingsStore.getState();
    expect(s.trustedSenders).toEqual([]);
    expect(s.isSenderTrusted(OLD)).toBe(false);
    expect(s.trustedSendersAddressBook).toBeNull();
    expect(s.unconfirmedTrustedSenders).toEqual([OLD]);
    expect(s.unconfirmedTrustedSendersAddressBook).toBe(true);
  });

  it('a copy made under the rule round-trips the user\'s own trust', () => {
    useSettingsStore.getState().addTrustedSender(NEW);
    const exported = useSettingsStore.getState().exportSettings();
    expect(JSON.parse(exported).trustModel).toBe('explicit');
    useSettingsStore.setState({ trustedSenders: [] } as never);
    expect(useSettingsStore.getState().importSettings(exported)).toBe(true);
    expect(useSettingsStore.getState().isSenderTrusted(NEW)).toBe(true);
  });
});
