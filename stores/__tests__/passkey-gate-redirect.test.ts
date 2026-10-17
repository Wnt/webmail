import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAuthStore, redirectToLogin } from '../auth-store';
import { usePasskeyGateStore } from '../passkey-gate-store';

// Fork (Wnt/webmail): the app guards' redirectToLogin with the in-page passkey
// sign-in mounted. Its own file: auth-store keeps a module-level "leaving for
// the provider logout" flag that other test files set for good.

let replaceSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/en/mail');
  replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  usePasskeyGateStore.setState({ active: true, requested: false, reason: null, returnTo: null, epoch: 0 });
});

describe('redirectToLogin with the in-page passkey sign-in', () => {
  it('a signed-out page asks for the gate instead of navigating', () => {
    useAuthStore.setState({ isAuthenticated: false });
    redirectToLogin();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(usePasskeyGateStore.getState().requested).toBe(true);
  });

  it('a page that is still signed in leaves (no overlay over live state)', () => {
    useAuthStore.setState({ isAuthenticated: true });
    redirectToLogin();
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
    expect(usePasskeyGateStore.getState().requested).toBe(false);
  });

  it('without the gate mounted it navigates as upstream does', () => {
    usePasskeyGateStore.setState({ active: false });
    useAuthStore.setState({ isAuthenticated: false });
    redirectToLogin();
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
  });
});
