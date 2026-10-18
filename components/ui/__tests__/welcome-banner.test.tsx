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
