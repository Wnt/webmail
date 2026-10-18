import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

// On a phone the banner said "Press c to compose" and pointed at a sidebar
// that the phone layout does not have.

const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
}));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ startTour: vi.fn() }) }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { WelcomeBanner } = await import('../welcome-banner');
const { useSettingsStore } = await import('@/stores/settings-store');

describe('WelcomeBanner tips', () => {
  beforeEach(() => {
    useSettingsStore.setState({ onboardingCompleted: false });
  });

  it('gives keyboard tips on a desktop', () => {
    device.isMobile = false;
    render(<WelcomeBanner />);
    expect(screen.getByText('tip_compose')).toBeInTheDocument();
    expect(screen.getByText('tip_shortcuts')).toBeInTheDocument();
  });

  it('gives touch tips on a phone', () => {
    device.isMobile = true;
    render(<WelcomeBanner />);
    expect(screen.getByText('tip_compose_touch')).toBeInTheDocument();
    expect(screen.getByText('tip_sidebar_touch')).toBeInTheDocument();
    expect(screen.queryByText('tip_shortcuts')).toBeNull();
  });
});

// On a fresh phone the welcome card and the push onboarding card were up
// together: one fixed above the list, the other floating over it, and on a
// short screen the floating one landed on the welcome card. While this card
// is up it holds `data-welcome-open` on <html>, and the corner cards step
// aside until it is dismissed (useCornerCardsAside).
describe('WelcomeBanner and the corner cards', () => {
  beforeEach(() => {
    device.isMobile = true;
    localStorage.clear();
    useSettingsStore.setState({ onboardingCompleted: false });
    delete document.documentElement.dataset.welcomeOpen;
  });

  it('holds data-welcome-open while it is up and drops it on Got it', () => {
    render(<WelcomeBanner />);
    expect(document.documentElement.dataset.welcomeOpen).toBe('1');
    fireEvent.click(screen.getByText('got_it'));
    expect(document.documentElement.dataset.welcomeOpen).toBeUndefined();
  });

  it('drops it when it unmounts, and holds nothing once onboarding is done', () => {
    const { unmount } = render(<WelcomeBanner />);
    expect(document.documentElement.dataset.welcomeOpen).toBe('1');
    unmount();
    expect(document.documentElement.dataset.welcomeOpen).toBeUndefined();

    useSettingsStore.setState({ onboardingCompleted: true, showOnboardingOnNewDevices: false });
    render(<WelcomeBanner />);
    expect(document.documentElement.dataset.welcomeOpen).toBeUndefined();
  });
});

// The card listened for Escape on the whole window, so the Escape that
// closed a dialog, a menu or the open message also dismissed the card for
// good (found in the live Chrome check, 2026-10-18). It now takes Escape only
// while the focus is inside it, and the key stops there.
describe('WelcomeBanner and the Escape key', () => {
  beforeEach(() => {
    device.isMobile = false;
    localStorage.clear();
    useSettingsStore.setState({ onboardingCompleted: false });
  });

  it('stays when Escape is meant for something else (a dialog, a menu, the page)', () => {
    render(
      <>
        <WelcomeBanner />
        <div role="dialog" aria-label="Some dialog"><button type="button">in the dialog</button></div>
      </>,
    );
    const inDialog = screen.getByRole('button', { name: 'in the dialog' });
    inDialog.focus();
    fireEvent.keyDown(inDialog, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSettingsStore.getState().onboardingCompleted).toBe(false);
    expect(localStorage.getItem('onboarding_completed')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'title' })).toBeInTheDocument();
  });

  it('is dismissed by Escape while the focus is in it, and the key goes no further', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      render(<WelcomeBanner />);
      const gotIt = screen.getByRole('button', { name: 'got_it' });
      gotIt.focus();
      fireEvent.keyDown(gotIt, { key: 'Escape' });
      expect(useSettingsStore.getState().onboardingCompleted).toBe(true);
      // The same Escape does not also reach the window's keyboard shortcuts
      // (which close the open message).
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });
});
