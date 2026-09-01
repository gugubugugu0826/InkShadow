export interface ContinuationConfirmationScope {
  readonly projectId: string;
  readonly chapterId: string;
  readonly bodyVersionId: string;
  readonly modelId: string;
  readonly providerDisplayName: string;
  readonly taskType: "prose_generation" | "continuation";
  readonly storyDataScope: string;
  readonly privacyDestination: "local" | "remote";
  readonly disclosureFingerprint: string;
}

interface SessionStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredContinuationConfirmation extends ContinuationConfirmationScope {
  readonly schemaVersion: 1;
}

export const CONTINUATION_CONFIRMATION_SESSION_KEY =
  "inkshadow.continuation-confirmation.session.v1";

export function rememberContinuationConfirmation(
  storage: SessionStoragePort,
  scope: ContinuationConfirmationScope,
): void {
  try {
    storage.setItem(
      CONTINUATION_CONFIRMATION_SESSION_KEY,
      JSON.stringify({ schemaVersion: 1, ...scope } satisfies StoredContinuationConfirmation),
    );
  } catch {
    forgetContinuationConfirmation(storage);
  }
}

export function continuationConfirmationRemembered(
  storage: SessionStoragePort,
  scope: ContinuationConfirmationScope,
): boolean {
  try {
    const raw = storage.getItem(CONTINUATION_CONFIRMATION_SESSION_KEY);
    if (raw === null) return false;
    const stored = parseStoredConfirmation(JSON.parse(raw) as unknown);
    if (stored !== null && sameScope(stored, scope)) return true;
  } catch {
    // Invalid or unavailable session state must never authorize a send.
  }
  forgetContinuationConfirmation(storage);
  return false;
}

export function forgetContinuationConfirmation(storage: SessionStoragePort): void {
  try {
    storage.removeItem(CONTINUATION_CONFIRMATION_SESSION_KEY);
  } catch {
    // The safe fallback is an absent grant; callers will still require confirmation.
  }
}

function sameScope(
  stored: StoredContinuationConfirmation,
  current: Omit<ContinuationConfirmationScope, "taskType"> & Readonly<{ taskType: string }>,
): boolean {
  return (
    stored.projectId === current.projectId &&
    stored.chapterId === current.chapterId &&
    stored.bodyVersionId === current.bodyVersionId &&
    stored.modelId === current.modelId &&
    stored.providerDisplayName === current.providerDisplayName &&
    stored.taskType === current.taskType &&
    stored.storyDataScope === current.storyDataScope &&
    stored.privacyDestination === current.privacyDestination &&
    stored.disclosureFingerprint === current.disclosureFingerprint
  );
}

function parseStoredConfirmation(value: unknown): StoredContinuationConfirmation | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.taskType !== "prose_generation" && value.taskType !== "continuation")
  ) {
    return null;
  }
  if (value.privacyDestination !== "local" && value.privacyDestination !== "remote") {
    return null;
  }
  if (
    !isBoundedText(value.projectId, 80) ||
    !isBoundedText(value.chapterId, 80) ||
    !isBoundedText(value.bodyVersionId, 80) ||
    !isBoundedText(value.modelId, 300) ||
    !isBoundedText(value.providerDisplayName, 200) ||
    !isBoundedText(value.storyDataScope, 500) ||
    !isBoundedText(value.disclosureFingerprint, 500)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: value.projectId,
    chapterId: value.chapterId,
    bodyVersionId: value.bodyVersionId,
    modelId: value.modelId,
    providerDisplayName: value.providerDisplayName,
    taskType: value.taskType,
    storyDataScope: value.storyDataScope,
    privacyDestination: value.privacyDestination,
    disclosureFingerprint: value.disclosureFingerprint,
  });
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
