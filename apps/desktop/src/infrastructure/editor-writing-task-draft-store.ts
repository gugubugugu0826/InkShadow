export type EditorWritingTask =
  "continuation" | "selection_rewrite" | "polish" | "expand" | "shorten";

export interface EditorWritingTaskDraftIdentity {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly sessionId: string;
  readonly task: EditorWritingTask;
  readonly selection: Readonly<{ start: number; end: number }> | null;
}

interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type EditorWritingTaskDraftLoadResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{
      ok: false;
      value: "";
      error: "DRAFT_IDENTITY_INVALID" | "DRAFT_STORAGE_UNAVAILABLE" | "DRAFT_CORRUPT";
      rawPreserved: boolean;
    }>;

export type EditorWritingTaskDraftOutcome =
  | "generation_succeeded"
  | "failed_final"
  | "cancelled_before_dispatch"
  | "in_progress"
  | "recoverable_failure"
  | "result_needs_review";

const PREFIX = "inkshadow.editor-writing-task-draft.v1";
const SESSION_PREFIX = "inkshadow.editor-writing-session.v1";
const MAXIMUM_REQUIREMENT_CHARACTERS = 2_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function loadEditorWritingTaskDraft(
  storage: StoragePort,
  identity: EditorWritingTaskDraftIdentity,
): EditorWritingTaskDraftLoadResult {
  const key = storageKey(identity);
  if (key === null) {
    return Object.freeze({
      ok: false,
      value: "",
      error: "DRAFT_IDENTITY_INVALID",
      rawPreserved: false,
    });
  }
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return Object.freeze({
      ok: false,
      value: "",
      error: "DRAFT_STORAGE_UNAVAILABLE",
      rawPreserved: true,
    });
  }
  if (raw === null) return Object.freeze({ ok: true, value: "" });
  const parsed = parseStoredDraft(raw);
  if (!parsed.ok) {
    return Object.freeze({
      ok: false,
      value: "",
      error: "DRAFT_CORRUPT",
      rawPreserved: true,
    });
  }
  return Object.freeze({ ok: true, value: parsed.value });
}

export function saveEditorWritingTaskDraft(
  storage: StoragePort,
  identity: EditorWritingTaskDraftIdentity,
  requirement: string,
): boolean {
  const key = storageKey(identity);
  if (key === null) return false;
  try {
    const existing = storage.getItem(key);
    if (existing !== null && !parseStoredDraft(existing).ok) return false;
    if (requirement.length === 0) {
      storage.removeItem(key);
      return true;
    }
    if (!validRequirement(requirement)) return false;
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, requirement }));
    return true;
  } catch {
    return false;
  }
}

export function clearEditorWritingTaskDraft(
  storage: StoragePort,
  identity: EditorWritingTaskDraftIdentity,
): boolean {
  const key = storageKey(identity);
  if (key === null) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Settles exactly one writing-task draft. A draft is author input, so an
 * in-flight task, an unsafe local fragment, or an uncertain provider result
 * must keep it available for recovery. A definitive failure is still useful
 * author input for an explicit retry. Only success or an author-confirmed
 * pre-dispatch cancellation may remove the exact identity that started it.
 */
export function settleEditorWritingTaskDraft(
  storage: StoragePort,
  identity: EditorWritingTaskDraftIdentity,
  outcome: EditorWritingTaskDraftOutcome,
  expectedRequirement?: string,
): boolean {
  if (
    outcome === "in_progress" ||
    outcome === "failed_final" ||
    outcome === "recoverable_failure" ||
    outcome === "result_needs_review"
  ) {
    return storageKey(identity) !== null;
  }
  if (expectedRequirement !== undefined) {
    const current = loadEditorWritingTaskDraft(storage, identity);
    if (!current.ok) return false;
    if (current.value !== expectedRequirement) return true;
  }
  return clearEditorWritingTaskDraft(storage, identity);
}

export function sameEditorWritingTaskDraftIdentity(
  left: EditorWritingTaskDraftIdentity | null,
  right: EditorWritingTaskDraftIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.projectId === right.projectId &&
    left.chapterId === right.chapterId &&
    left.versionId === right.versionId &&
    left.sessionId === right.sessionId &&
    left.task === right.task &&
    ((left.selection === null && right.selection === null) ||
      (left.selection !== null &&
        right.selection !== null &&
        left.selection.start === right.selection.start &&
        left.selection.end === right.selection.end))
  );
}

export function loadOrCreateEditorWritingSessionId(
  storage: StoragePort,
  scope: Readonly<{ projectId: string; chapterId: string; versionId: string }>,
  createSessionId: () => string,
): string | null {
  const key = writingSessionStorageKey(scope);
  if (key === null) return null;
  try {
    const existing = storage.getItem(key);
    if (existing !== null) {
      const parsed: unknown = JSON.parse(existing);
      if (
        isRecord(parsed) &&
        parsed.schemaVersion === 1 &&
        typeof parsed.sessionId === "string" &&
        parsed.sessionId.length >= 1 &&
        parsed.sessionId.length <= 200
      ) {
        return parsed.sessionId;
      }
    }
    const sessionId = createSessionId();
    if (sessionId.length < 1 || sessionId.length > 200) return null;
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, sessionId }));
    return sessionId;
  } catch {
    return null;
  }
}

function storageKey(identity: EditorWritingTaskDraftIdentity): string | null {
  if (
    identity.projectId.length === 0 ||
    identity.chapterId.length === 0 ||
    identity.versionId.length === 0 ||
    identity.sessionId.length === 0
  ) {
    return null;
  }
  const selection = selectionKey(identity);
  if (selection === null) return null;
  return [
    PREFIX,
    encodeURIComponent(identity.projectId),
    encodeURIComponent(identity.chapterId),
    encodeURIComponent(identity.versionId),
    encodeURIComponent(identity.sessionId),
    identity.task,
    selection,
  ].join(":");
}

function writingSessionStorageKey(
  scope: Readonly<{ projectId: string; chapterId: string; versionId: string }>,
): string | null {
  if (
    scope.projectId.length === 0 ||
    scope.chapterId.length === 0 ||
    scope.versionId.length === 0
  ) {
    return null;
  }
  return [
    SESSION_PREFIX,
    encodeURIComponent(scope.projectId),
    encodeURIComponent(scope.chapterId),
    encodeURIComponent(scope.versionId),
  ].join(":");
}

function selectionKey(identity: EditorWritingTaskDraftIdentity): string | null {
  if (identity.task === "continuation") return identity.selection === null ? "document" : null;
  const selection = identity.selection;
  if (
    selection === null ||
    !Number.isSafeInteger(selection.start) ||
    !Number.isSafeInteger(selection.end) ||
    selection.start < 0 ||
    selection.end <= selection.start
  ) {
    return null;
  }
  return `${String(selection.start)}-${String(selection.end)}`;
}

function validRequirement(value: string): boolean {
  return value.length <= MAXIMUM_REQUIREMENT_CHARACTERS && !CONTROL_CHARACTER_PATTERN.test(value);
}

function parseStoredDraft(
  raw: string,
): Readonly<{ ok: true; value: string }> | Readonly<{ ok: false }> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.requirement !== "string" ||
      !validRequirement(parsed.requirement)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({ ok: true, value: parsed.requirement });
  } catch {
    return Object.freeze({ ok: false });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
