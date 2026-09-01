import type { ContinuationDestinationId, ContinuationOutputProfileId } from "@inkshadow/ai-core";

export interface EditorContinuationPreference {
  readonly schemaVersion: 1;
  readonly profile: ContinuationOutputProfileId;
  readonly customTargetVisibleCharacters: number | null;
  readonly destination: ContinuationDestinationId;
  readonly customDestinationInstruction: string | null;
}

interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "inkshadow.editor-continuation-preference.v1";
export const DEFAULT_EDITOR_CONTINUATION_PREFERENCE: EditorContinuationPreference = Object.freeze({
  schemaVersion: 1,
  profile: "standard",
  customTargetVisibleCharacters: null,
  destination: "complete_scene",
  customDestinationInstruction: null,
});

export function loadEditorContinuationPreference(
  storage: StoragePort,
  projectId: string,
): EditorContinuationPreference {
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (raw === null) return DEFAULT_EDITOR_CONTINUATION_PREFERENCE;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schemaVersion !== 1 || !isProfile(value.profile)) {
      return DEFAULT_EDITOR_CONTINUATION_PREFERENCE;
    }
    const custom = value.customTargetVisibleCharacters;
    if (
      custom !== null &&
      (!Number.isSafeInteger(custom) || (custom as number) < 200 || (custom as number) > 12_000)
    ) {
      return DEFAULT_EDITOR_CONTINUATION_PREFERENCE;
    }
    const destination = isDestination(value.destination)
      ? value.destination
      : DEFAULT_EDITOR_CONTINUATION_PREFERENCE.destination;
    const customDestinationInstruction = normalizeCustomInstruction(
      value.customDestinationInstruction,
    );
    return Object.freeze({
      schemaVersion: 1,
      profile: value.profile === "custom" ? "standard" : value.profile,
      customTargetVisibleCharacters: custom as number | null,
      destination,
      customDestinationInstruction,
    });
  } catch {
    return DEFAULT_EDITOR_CONTINUATION_PREFERENCE;
  }
}

export function saveEditorContinuationPreference(
  storage: StoragePort,
  projectId: string,
  preference: EditorContinuationPreference,
): void {
  storage.setItem(storageKey(projectId), JSON.stringify(preference));
}

export function clearEditorContinuationPreference(storage: StoragePort, projectId: string): void {
  storage.removeItem(storageKey(projectId));
}

function storageKey(projectId: string): string {
  return `${PREFIX}:${projectId}`;
}

function isProfile(value: unknown): value is ContinuationOutputProfileId {
  return value === "short" || value === "standard" || value === "long" || value === "custom";
}

function isDestination(value: unknown): value is ContinuationDestinationId {
  return value === "complete_scene" || value === "next_segment" || value === "custom_instruction";
}

function normalizeCustomInstruction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized.length >= 1 && normalized.length <= 2_000 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
