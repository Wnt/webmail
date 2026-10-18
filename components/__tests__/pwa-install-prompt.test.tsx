import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PWA_INSTALL_PROMPT_VISIBILITY_EVENT,
  PWAInstallPrompt,
} from "../pwa-install-prompt";

vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({
    appName: "Bulwark",
    faviconUrl: "",
    appLogoLightUrl: "",
    appLogoDarkUrl: "",
  }),
}));

describe("PWAInstallPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("closes after the browser install prompt is dismissed", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt");
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });

    render(<PWAInstallPrompt />);
    act(() => window.dispatchEvent(event));
    expect(screen.getByText("title")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("install"));
      await Promise.resolve();
    });

    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.queryByText("title")).not.toBeInTheDocument();
  });

  it("announces that it is hidden after Not now", () => {
    const visibility: boolean[] = [];
    const listener = (event: Event) => {
      visibility.push(
        (event as CustomEvent<{ visible?: boolean }>).detail?.visible === true,
      );
    };
    window.addEventListener(PWA_INSTALL_PROMPT_VISIBILITY_EVENT, listener);

    try {
      const event = new Event("beforeinstallprompt");
      Object.assign(event, {
        prompt: vi.fn(),
        userChoice: Promise.resolve({ outcome: "dismissed" }),
      });

      render(<PWAInstallPrompt />);
      act(() => window.dispatchEvent(event));
      fireEvent.click(screen.getByText("not_now"));

      expect(visibility).toContain(true);
      expect(visibility.at(-1)).toBe(false);
    } finally {
      window.removeEventListener(PWA_INSTALL_PROMPT_VISIBILITY_EVENT, listener);
    }
  });

  function offerInstall() {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    act(() => window.dispatchEvent(event));
  }

  it("steps aside while a composer is open and returns when it closes", async () => {
    render(<PWAInstallPrompt />);
    offerInstall();
    expect(screen.getByTestId("pwa-install-prompt")).toBeInTheDocument();

    // EmailComposer ref-counts this attribute while it is mounted.
    await act(async () => {
      document.documentElement.dataset.composerOpen = "1";
      await Promise.resolve();
    });
    expect(screen.queryByTestId("pwa-install-prompt")).not.toBeInTheDocument();

    await act(async () => {
      delete document.documentElement.dataset.composerOpen;
      await Promise.resolve();
    });
    expect(screen.getByTestId("pwa-install-prompt")).toBeInTheDocument();
  });

  it("stays hidden when it is offered while composing", () => {
    document.documentElement.dataset.composerOpen = "1";
    try {
      render(<PWAInstallPrompt />);
      offerInstall();
      expect(screen.queryByTestId("pwa-install-prompt")).not.toBeInTheDocument();
    } finally {
      delete document.documentElement.dataset.composerOpen;
    }
  });

  it("clears the mobile bottom bar and Compose button, and keeps the desktop corner", () => {
    render(<PWAInstallPrompt />);
    offerInstall();
    const card = screen.getByTestId("pwa-install-prompt");
    expect(card.className).toContain(
      "bottom-[calc(9rem+env(safe-area-inset-bottom))]",
    );
    expect(card.className).toContain("md:bottom-4");
    expect(card.className).toContain("md:right-4");
    // Still dismissible.
    fireEvent.click(screen.getByLabelText("dismiss_aria"));
    expect(screen.queryByTestId("pwa-install-prompt")).not.toBeInTheDocument();
  });
});
