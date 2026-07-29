export type AiCandidateSource = "generate" | "polish" | "extract" | "whatif" | "agent";

export type AiCandidateStatus = "streaming" | "ready" | "accepted" | "rejected" | "expired";

export interface AiCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId?: string;
  readonly source: AiCandidateSource;
  readonly baseVersionId?: string;
  readonly content: string;
  readonly status: AiCandidateStatus;
  readonly createdAt: string;
}

export type CandidateApplicationMode =
  "insert_at_cursor" | "replace_selection" | "create_chapter_version";

export interface CandidateSelection {
  readonly start: number;
  readonly end: number;
}

export interface CandidateApplicationContext {
  readonly actorId: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly currentVersionId: string;
  readonly canEdit: boolean;
  readonly targetLocked: boolean;
  readonly confirmedByUser: boolean;
  readonly mode: CandidateApplicationMode;
  readonly cursorOffset?: number;
  readonly selection?: CandidateSelection;
}

export interface CandidateApplicationPlan {
  readonly candidateId: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly expectedBaseVersionId: string;
  readonly mode: CandidateApplicationMode;
  readonly content: string;
  readonly recoveryPointRequired: true;
  readonly auditEvent: "ai_candidate.apply_requested";
  readonly cursorOffset?: number;
  readonly selection?: CandidateSelection;
}

export type CandidateSafetyErrorCode =
  | "CANDIDATE_NOT_READY"
  | "CANDIDATE_EMPTY"
  | "CANDIDATE_PROJECT_MISMATCH"
  | "CANDIDATE_CHAPTER_REQUIRED"
  | "CANDIDATE_CHAPTER_MISMATCH"
  | "CANDIDATE_SOURCE_NOT_APPLICABLE"
  | "CANDIDATE_BASE_VERSION_REQUIRED"
  | "BASE_VERSION_CHANGED"
  | "CANDIDATE_EDIT_FORBIDDEN"
  | "CANDIDATE_TARGET_LOCKED"
  | "CANDIDATE_CONFIRMATION_REQUIRED"
  | "CANDIDATE_SELECTION_REQUIRED"
  | "CANDIDATE_SELECTION_INVALID"
  | "CANDIDATE_CURSOR_INVALID"
  | "POLISH_MUST_REPLACE_SELECTION";

export class CandidateSafetyError extends Error {
  constructor(
    readonly code: CandidateSafetyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CandidateSafetyError";
  }
}

function fail(code: CandidateSafetyErrorCode, message: string): never {
  throw new CandidateSafetyError(code, message);
}

export function buildCandidateApplicationPlan(
  candidate: AiCandidate,
  context: CandidateApplicationContext,
): CandidateApplicationPlan {
  if (candidate.status !== "ready") {
    fail("CANDIDATE_NOT_READY", "Only ready candidates can be applied.");
  }
  if (candidate.content.trim().length === 0) {
    fail("CANDIDATE_EMPTY", "Empty candidates cannot be applied.");
  }
  if (candidate.projectId !== context.projectId) {
    fail("CANDIDATE_PROJECT_MISMATCH", "The candidate belongs to another project.");
  }
  if (candidate.chapterId === undefined) {
    fail("CANDIDATE_CHAPTER_REQUIRED", "Chapter application requires a chapter-scoped candidate.");
  }
  if (candidate.chapterId !== context.chapterId) {
    fail("CANDIDATE_CHAPTER_MISMATCH", "The candidate belongs to another chapter.");
  }
  if (candidate.source === "extract" || candidate.source === "whatif") {
    fail(
      "CANDIDATE_SOURCE_NOT_APPLICABLE",
      "Extracted state and What-if candidates require their dedicated draft workflows.",
    );
  }
  if (candidate.baseVersionId === undefined) {
    fail(
      "CANDIDATE_BASE_VERSION_REQUIRED",
      "Candidate application requires a stable base version.",
    );
  }
  if (candidate.baseVersionId !== context.currentVersionId) {
    fail("BASE_VERSION_CHANGED", "The chapter changed after this candidate was created.");
  }
  if (!context.canEdit) {
    fail("CANDIDATE_EDIT_FORBIDDEN", "The current actor cannot edit this chapter.");
  }
  if (context.targetLocked) {
    fail("CANDIDATE_TARGET_LOCKED", "AI candidates cannot modify a locked target.");
  }
  if (!context.confirmedByUser) {
    fail("CANDIDATE_CONFIRMATION_REQUIRED", "AI candidates require explicit user confirmation.");
  }
  if (candidate.source === "polish" && context.mode !== "replace_selection") {
    fail(
      "POLISH_MUST_REPLACE_SELECTION",
      "Polish candidates may only replace an explicit selection.",
    );
  }

  if (context.mode === "replace_selection") {
    if (context.selection === undefined) {
      fail("CANDIDATE_SELECTION_REQUIRED", "Replacing text requires a selection.");
    }
    if (
      !Number.isSafeInteger(context.selection.start) ||
      !Number.isSafeInteger(context.selection.end) ||
      context.selection.start < 0 ||
      context.selection.end <= context.selection.start
    ) {
      fail("CANDIDATE_SELECTION_INVALID", "Candidate selection bounds are invalid.");
    }
  }

  if (
    context.mode === "insert_at_cursor" &&
    (context.cursorOffset === undefined ||
      !Number.isSafeInteger(context.cursorOffset) ||
      context.cursorOffset < 0)
  ) {
    fail("CANDIDATE_CURSOR_INVALID", "Inserting a candidate requires a valid cursor offset.");
  }

  const planBase = {
    candidateId: candidate.id,
    actorId: context.actorId,
    projectId: context.projectId,
    chapterId: context.chapterId,
    expectedBaseVersionId: candidate.baseVersionId,
    mode: context.mode,
    content: candidate.content,
    recoveryPointRequired: true,
    auditEvent: "ai_candidate.apply_requested",
  } as const;

  if (context.mode === "replace_selection") {
    const selection = context.selection;
    if (selection === undefined) {
      fail("CANDIDATE_SELECTION_REQUIRED", "Replacing text requires a selection.");
    }
    return {
      ...planBase,
      selection,
    };
  }
  if (context.mode === "insert_at_cursor") {
    const cursorOffset = context.cursorOffset;
    if (cursorOffset === undefined) {
      fail("CANDIDATE_CURSOR_INVALID", "Inserting a candidate requires a valid cursor offset.");
    }
    return {
      ...planBase,
      cursorOffset,
    };
  }
  return planBase;
}
