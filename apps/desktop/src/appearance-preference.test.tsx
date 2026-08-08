import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPEARANCE_PREFERENCE_STORAGE_KEY,
  AppearancePreferenceProvider,
  initializeAppearancePreference,
  readAppearancePreference,
  useAppearancePreference,
} from "./appearance-preference";

describe("appearance preference", () => {
  const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-surface");
  });

  afterEach(() => {
    if (originalMatchMediaDescriptor === undefined) {
      Reflect.deleteProperty(window, "matchMedia");
    } else {
      Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
    }
    document.documentElement.removeAttribute("data-surface");
  });

  it("defaults invalid or missing persisted values to following the system", () => {
    expect(readAppearancePreference(window.localStorage)).toBe("system");

    window.localStorage.setItem(APPEARANCE_PREFERENCE_STORAGE_KEY, "sepia");

    expect(initializeAppearancePreference()).toBe("system");
    expect(document.documentElement).not.toHaveAttribute("data-surface");
  });

  it("persists explicit choices and restores them before the application renders", async () => {
    installSystemPreference(false);
    const user = userEvent.setup();
    render(
      <AppearancePreferenceProvider>
        <AppearanceHarness />
      </AppearancePreferenceProvider>,
    );

    expect(screen.getByTestId("appearance-state")).toHaveTextContent("system:light");
    expect(document.documentElement).not.toHaveAttribute("data-surface");

    await user.click(screen.getByRole("button", { name: "使用深色" }));

    expect(document.documentElement).toHaveAttribute("data-surface", "dark");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("dark");
    expect(screen.getByTestId("editor-paper")).toHaveAttribute("data-surface", "dark");

    document.documentElement.removeAttribute("data-surface");
    expect(initializeAppearancePreference()).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-surface", "dark");

    await user.click(screen.getByRole("button", { name: "使用浅色" }));
    expect(document.documentElement).toHaveAttribute("data-surface", "light");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("light");

    await user.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(document.documentElement).not.toHaveAttribute("data-surface");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("system");
  });

  it("responds to system appearance changes while leaving the root in automatic mode", () => {
    const media = installSystemPreference(false);
    render(
      <AppearancePreferenceProvider>
        <AppearanceHarness />
      </AppearancePreferenceProvider>,
    );

    act(() => {
      media.change(true);
    });

    expect(screen.getByTestId("appearance-state")).toHaveTextContent("system:dark");
    expect(document.documentElement).not.toHaveAttribute("data-surface");

    act(() => {
      media.change(false);
    });

    expect(screen.getByTestId("appearance-state")).toHaveTextContent("system:light");
    expect(document.documentElement).not.toHaveAttribute("data-surface");
  });
});

function AppearanceHarness() {
  const { preference, resolvedSurface, setPreference } = useAppearancePreference();
  return (
    <>
      <output data-testid="appearance-state">
        {preference}:{resolvedSurface}
      </output>
      <div data-testid="editor-paper" data-surface={resolvedSurface} />
      <button type="button" onClick={() => setPreference("light")}>
        使用浅色
      </button>
      <button type="button" onClick={() => setPreference("dark")}>
        使用深色
      </button>
      <button type="button" onClick={() => setPreference("system")}>
        跟随系统
      </button>
    </>
  );
}

function installSystemPreference(initiallyDark: boolean): {
  readonly change: (matches: boolean) => void;
} {
  let listener: ((event: MediaQueryListEvent) => void) | null = null;
  const mediaQuery = {
    matches: initiallyDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((type: string, nextListener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") {
        listener = nextListener;
      }
    }),
    removeEventListener: vi.fn(
      (type: string, currentListener: (event: MediaQueryListEvent) => void) => {
        if (type === "change" && listener === currentListener) {
          listener = null;
        }
      },
    ),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  window.matchMedia = vi.fn(() => mediaQuery);

  return {
    change(matches) {
      listener?.({ matches } as MediaQueryListEvent);
    },
  };
}
