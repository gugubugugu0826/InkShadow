import { DEFAULT_USER_SETTINGS } from "@inkshadow/config";

export const EDITOR_PREFERENCES_STORAGE_KEY = "inkshadow.editor.preferences.v1";
export const EDITOR_PREFERENCES_CHANGED_EVENT = "inkshadow:editor-preferences-changed";

const MAX_SERIALIZED_LENGTH = 4_096;

export interface EditorPreferences {
  readonly autosaveEnabled: boolean;
  readonly autosaveDebounceMs: number;
}

interface StoredEditorPreferences extends EditorPreferences {
  readonly schemaVersion: 1;
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = Object.freeze({
  autosaveEnabled: true,
  autosaveDebounceMs: DEFAULT_USER_SETTINGS.autosaveDebounceMs,
});

export function loadEditorPreferences(storage: Storage): EditorPreferences {
  let serialized: string | null;
  try {
    serialized = storage.getItem(EDITOR_PREFERENCES_STORAGE_KEY);
  } catch {
    return DEFAULT_EDITOR_PREFERENCES;
  }
  if (serialized === null) return DEFAULT_EDITOR_PREFERENCES;
  if (serialized.length > MAX_SERIALIZED_LENGTH) {
    removeCorruptPreferences(storage);
    return DEFAULT_EDITOR_PREFERENCES;
  }
  try {
    const value: unknown = JSON.parse(serialized);
    return normalizePreferences(value);
  } catch {
    removeCorruptPreferences(storage);
    return DEFAULT_EDITOR_PREFERENCES;
  }
}

export function saveEditorPreferences(
  storage: Storage,
  input: EditorPreferences,
  eventTarget?: EventTarget,
): EditorPreferences {
  const normalized = normalizePreferences({ schemaVersion: 1, ...input });
  const stored: StoredEditorPreferences = Object.freeze({
    schemaVersion: 1,
    ...normalized,
  });
  storage.setItem(EDITOR_PREFERENCES_STORAGE_KEY, JSON.stringify(stored));
  eventTarget?.dispatchEvent(new Event(EDITOR_PREFERENCES_CHANGED_EVENT));
  return normalized;
}

function normalizePreferences(value: unknown): EditorPreferences {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return DEFAULT_EDITOR_PREFERENCES;
  }
  const autosaveEnabled =
    typeof value.autosaveEnabled === "boolean"
      ? value.autosaveEnabled
      : DEFAULT_EDITOR_PREFERENCES.autosaveEnabled;
  const autosaveDebounceMs =
    typeof value.autosaveDebounceMs === "number" &&
    Number.isInteger(value.autosaveDebounceMs) &&
    value.autosaveDebounceMs >= 250 &&
    value.autosaveDebounceMs <= 5_000
      ? value.autosaveDebounceMs
      : DEFAULT_EDITOR_PREFERENCES.autosaveDebounceMs;
  return Object.freeze({ autosaveEnabled, autosaveDebounceMs });
}

function removeCorruptPreferences(storage: Storage): void {
  try {
    storage.removeItem(EDITOR_PREFERENCES_STORAGE_KEY);
  } catch {
    // Preferences are optional; editor durability keeps its safe defaults.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
