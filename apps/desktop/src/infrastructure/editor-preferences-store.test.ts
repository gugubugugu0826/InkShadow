import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EDITOR_PREFERENCES,
  EDITOR_PREFERENCES_CHANGED_EVENT,
  EDITOR_PREFERENCES_STORAGE_KEY,
  loadEditorPreferences,
  saveEditorPreferences,
} from "./editor-preferences-store";

describe("editor preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to one-second autosave and persists explicit changes", () => {
    expect(loadEditorPreferences(window.localStorage)).toEqual({
      autosaveEnabled: true,
      autosaveDebounceMs: 1_000,
    });

    const listener = vi.fn();
    window.addEventListener(EDITOR_PREFERENCES_CHANGED_EVENT, listener, { once: true });
    saveEditorPreferences(
      window.localStorage,
      { autosaveEnabled: false, autosaveDebounceMs: 1_500 },
      window,
    );

    expect(loadEditorPreferences(window.localStorage)).toEqual({
      autosaveEnabled: false,
      autosaveDebounceMs: 1_500,
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("removes corrupt values and keeps safe defaults", () => {
    window.localStorage.setItem(EDITOR_PREFERENCES_STORAGE_KEY, "{not-json");
    expect(loadEditorPreferences(window.localStorage)).toEqual(DEFAULT_EDITOR_PREFERENCES);
    expect(window.localStorage.getItem(EDITOR_PREFERENCES_STORAGE_KEY)).toBeNull();
  });
});
