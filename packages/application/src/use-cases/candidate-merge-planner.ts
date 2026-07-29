import { MAX_CHAPTER_CONTENT_LENGTH } from "@inkshadow/domain";

export const CANDIDATE_DIFF_ALGORITHM = "bounded-myers-unicode-scalar-v1" as const;

export interface CandidateDiffLimits {
  readonly maxTextUtf16Units: number;
  readonly maxTotalCodePoints: number;
  readonly maxEditDistance: number;
  readonly maxTraceCells: number;
  readonly maxWorkUnits: number;
  readonly maxChanges: number;
  readonly maxOutputUtf16Units: number;
}

export const CANDIDATE_DIFF_HARD_LIMITS: Readonly<CandidateDiffLimits> = Object.freeze({
  maxTextUtf16Units: MAX_CHAPTER_CONTENT_LENGTH,
  maxTotalCodePoints: 1_000_000,
  maxEditDistance: 4_096,
  maxTraceCells: 8_500_000,
  maxWorkUnits: 20_000_000,
  maxChanges: 4_096,
  maxOutputUtf16Units: MAX_CHAPTER_CONTENT_LENGTH,
});

export const CANDIDATE_DIFF_DEFAULT_LIMITS: Readonly<CandidateDiffLimits> = Object.freeze({
  maxTextUtf16Units: MAX_CHAPTER_CONTENT_LENGTH,
  maxTotalCodePoints: 250_000,
  maxEditDistance: 2_048,
  maxTraceCells: 2_500_000,
  maxWorkUnits: 5_000_000,
  maxChanges: 2_048,
  maxOutputUtf16Units: MAX_CHAPTER_CONTENT_LENGTH,
});

export type CandidateDiffLimitOverrides = Partial<CandidateDiffLimits>;

export type CandidateMergePlanningErrorCode =
  | "INVALID_LIMITS"
  | "INVALID_CONTENT"
  | "INVALID_UNICODE"
  | "TEXT_LIMIT_EXCEEDED"
  | "DIFF_COMPLEXITY_LIMIT_EXCEEDED"
  | "CHANGE_LIMIT_EXCEEDED"
  | "INVALID_SNAPSHOT"
  | "SNAPSHOT_IDENTITY_MISMATCH"
  | "INVALID_CHANGE_DECISIONS"
  | "INVALID_SELECTION"
  | "OUTPUT_LIMIT_EXCEEDED";

export interface CandidateMergePlanningError {
  readonly code: CandidateMergePlanningErrorCode;
  readonly message: string;
  readonly context: Readonly<Record<string, boolean | number | string>>;
}

interface PlanningErrorOutcome {
  readonly status: "error";
  readonly error: CandidateMergePlanningError;
}

export interface CandidateUtf16Range {
  readonly start: number;
  readonly end: number;
}

export interface CandidateTextChange {
  readonly id: string;
  readonly baselineRange: CandidateUtf16Range;
  readonly candidateRange: CandidateUtf16Range;
  readonly removedText: string;
  readonly insertedText: string;
  readonly removedCodePoints: number;
  readonly insertedCodePoints: number;
}

export interface CandidateTextDiff {
  readonly algorithm: typeof CANDIDATE_DIFF_ALGORITHM;
  readonly offsetEncoding: "utf-16";
  readonly baselineUtf16Units: number;
  readonly candidateUtf16Units: number;
  readonly baselineCodePoints: number;
  readonly candidateCodePoints: number;
  readonly editDistance: number;
  readonly changes: readonly CandidateTextChange[];
}

export type CandidateTextDiffOutcome =
  | {
      readonly status: "ready";
      readonly diff: CandidateTextDiff;
    }
  | PlanningErrorOutcome;

export interface CandidateMergeSnapshot {
  readonly revision: number;
  readonly contentDigest: string;
  readonly content: string;
}

export interface CandidateChangeDecision {
  readonly changeId: string;
  readonly decision: "accept" | "reject";
}

export type CandidateApplicationStrategy =
  | {
      readonly kind: "accept_all";
    }
  | {
      readonly kind: "apply_changes";
      readonly decisions: readonly CandidateChangeDecision[];
    }
  | {
      readonly kind: "insert_at_cursor";
      readonly cursorUtf16: number;
    }
  | {
      readonly kind: "replace_selection";
      readonly selection: CandidateUtf16Range;
    }
  | {
      readonly kind: "overwrite_document";
    };

export interface PlanCandidateApplicationInput {
  readonly baseline: CandidateMergeSnapshot;
  readonly current: CandidateMergeSnapshot;
  readonly candidateContent: string;
  readonly strategy: CandidateApplicationStrategy;
  readonly limits?: CandidateDiffLimitOverrides;
}

export interface CandidatePlannedTextEdit {
  readonly range: CandidateUtf16Range;
  readonly replacement: string;
  readonly sourceChangeId: string | null;
}

export interface CandidateApplicationPlan {
  readonly strategy: CandidateApplicationStrategy["kind"];
  readonly baselineRevision: number;
  readonly baselineContentDigest: string;
  readonly editOffsetEncoding: "utf-16";
  readonly editOrder: "descending";
  readonly edits: readonly CandidatePlannedTextEdit[];
  readonly resultContent: string;
  readonly acceptedChangeIds: readonly string[];
  readonly rejectedChangeIds: readonly string[];
  readonly diff: CandidateTextDiff | null;
}

export interface CandidateThreeWayConflict {
  readonly kind: "baseline_changed";
  readonly revisionChanged: boolean;
  readonly contentDigestChanged: boolean;
  readonly baseline: CandidateMergeSnapshot;
  readonly current: CandidateMergeSnapshot;
  readonly candidateContent: string;
}

export type CandidateApplicationPlanOutcome =
  | {
      readonly status: "ready";
      readonly plan: CandidateApplicationPlan;
    }
  | {
      readonly status: "conflict";
      readonly conflict: CandidateThreeWayConflict;
    }
  | PlanningErrorOutcome;

interface DiffAtom {
  readonly kind: "equal" | "insert" | "delete";
  readonly value: string;
}

interface MyersSuccess {
  readonly status: "ready";
  readonly atoms: readonly DiffAtom[];
  readonly editDistance: number;
}

interface ResolvedLimitsSuccess {
  readonly status: "ready";
  readonly limits: CandidateDiffLimits;
}

type ResolvedLimitsOutcome = ResolvedLimitsSuccess | PlanningErrorOutcome;

type MyersOutcome = MyersSuccess | PlanningErrorOutcome;

interface TokenizedText {
  readonly tokens: readonly string[];
  readonly utf16Units: number;
}

type TokenizeOutcome =
  | {
      readonly status: "ready";
      readonly value: TokenizedText;
    }
  | PlanningErrorOutcome;

/**
 * Computes a deterministic shortest edit script over Unicode scalar values.
 * Public ranges remain UTF-16 offsets so callers can apply them directly to
 * JavaScript strings without ever splitting a surrogate pair.
 */
export function diffCandidateContent(
  baselineContent: string,
  candidateContent: string,
  limitOverrides?: CandidateDiffLimitOverrides,
): CandidateTextDiffOutcome {
  const resolved = resolveLimits(limitOverrides);
  if (resolved.status === "error") {
    return resolved;
  }

  const baseline = tokenizeText(
    baselineContent,
    "baselineContent",
    resolved.limits.maxTextUtf16Units,
    resolved.limits.maxTotalCodePoints,
  );
  if (baseline.status === "error") {
    return baseline;
  }
  const candidate = tokenizeText(
    candidateContent,
    "candidateContent",
    resolved.limits.maxTextUtf16Units,
    resolved.limits.maxTotalCodePoints - baseline.value.tokens.length,
  );
  if (candidate.status === "error") {
    return candidate;
  }

  const totalCodePoints = baseline.value.tokens.length + candidate.value.tokens.length;
  if (totalCodePoints > resolved.limits.maxTotalCodePoints) {
    return planningError(
      "TEXT_LIMIT_EXCEEDED",
      "The combined text is too large for bounded candidate diffing.",
      {
        actualCodePoints: totalCodePoints,
        limitCodePoints: resolved.limits.maxTotalCodePoints,
      },
    );
  }

  const prefixLength = commonPrefixLength(baseline.value.tokens, candidate.value.tokens);
  const suffixLength = commonSuffixLength(
    baseline.value.tokens,
    candidate.value.tokens,
    prefixLength,
  );
  const baselineMiddle = baseline.value.tokens.slice(
    prefixLength,
    baseline.value.tokens.length - suffixLength,
  );
  const candidateMiddle = candidate.value.tokens.slice(
    prefixLength,
    candidate.value.tokens.length - suffixLength,
  );

  const myers = boundedMyers(baselineMiddle, candidateMiddle, resolved.limits);
  if (myers.status === "error") {
    return myers;
  }

  const baselinePrefixUtf16 = utf16LengthOfTokens(baseline.value.tokens, prefixLength);
  const candidatePrefixUtf16 = utf16LengthOfTokens(candidate.value.tokens, prefixLength);
  const changes = buildChanges(
    myers.atoms,
    baselinePrefixUtf16,
    candidatePrefixUtf16,
    resolved.limits.maxChanges,
  );
  if (changes.status === "error") {
    return changes;
  }

  return {
    status: "ready",
    diff: Object.freeze({
      algorithm: CANDIDATE_DIFF_ALGORITHM,
      offsetEncoding: "utf-16",
      baselineUtf16Units: baseline.value.utf16Units,
      candidateUtf16Units: candidate.value.utf16Units,
      baselineCodePoints: baseline.value.tokens.length,
      candidateCodePoints: candidate.value.tokens.length,
      editDistance: myers.editDistance,
      changes: Object.freeze(changes.changes),
    }),
  };
}

/**
 * Produces a side-effect-free application plan. Every strategy is guarded by
 * the candidate baseline identity; a changed revision or digest becomes an
 * explicit three-way conflict instead of an overwrite.
 */
export function planCandidateApplication(
  input: PlanCandidateApplicationInput,
): CandidateApplicationPlanOutcome {
  const resolved = resolveLimits(input.limits);
  if (resolved.status === "error") {
    return resolved;
  }
  const validated = validatePlanningInput(input, resolved.limits);
  if (validated !== null) {
    return validated;
  }

  const revisionChanged = input.current.revision !== input.baseline.revision;
  const contentDigestChanged = input.current.contentDigest !== input.baseline.contentDigest;
  if (revisionChanged || contentDigestChanged) {
    return {
      status: "conflict",
      conflict: Object.freeze({
        kind: "baseline_changed",
        revisionChanged,
        contentDigestChanged,
        baseline: freezeSnapshot(input.baseline),
        current: freezeSnapshot(input.current),
        candidateContent: input.candidateContent,
      }),
    };
  }

  if (input.current.content !== input.baseline.content) {
    return planningError(
      "SNAPSHOT_IDENTITY_MISMATCH",
      "Equal revision and digest metadata cannot identify different content.",
      {
        baselineRevision: input.baseline.revision,
        contentDigest: input.baseline.contentDigest,
      },
    );
  }

  switch (input.strategy.kind) {
    case "accept_all":
    case "overwrite_document":
      return planWholeReplacement(input, resolved.limits);
    case "apply_changes":
      return planSelectedChanges(input, input.strategy, resolved.limits);
    case "insert_at_cursor":
      return planCursorInsertion(input, input.strategy, resolved.limits);
    case "replace_selection":
      return planSelectionReplacement(input, input.strategy, resolved.limits);
  }
}

function planWholeReplacement(
  input: PlanCandidateApplicationInput,
  limits: CandidateDiffLimits,
): CandidateApplicationPlanOutcome {
  const outputError = ensureOutputLength(input.candidateContent.length, limits);
  if (outputError !== null) {
    return outputError;
  }
  const edits =
    input.current.content === input.candidateContent
      ? []
      : [
          freezeTextEdit({
            range: { start: 0, end: input.current.content.length },
            replacement: input.candidateContent,
            sourceChangeId: null,
          }),
        ];
  return readyPlan(input, input.candidateContent, edits, [], [], null);
}

function planSelectedChanges(
  input: PlanCandidateApplicationInput,
  strategy: Extract<CandidateApplicationStrategy, { readonly kind: "apply_changes" }>,
  limits: CandidateDiffLimits,
): CandidateApplicationPlanOutcome {
  const diff = diffCandidateContent(input.baseline.content, input.candidateContent, limits);
  if (diff.status === "error") {
    return diff;
  }
  const decisions = validateDecisions(diff.diff.changes, strategy.decisions);
  if (decisions.status === "error") {
    return decisions;
  }

  let outputLength = input.baseline.content.length;
  for (const change of diff.diff.changes) {
    if (decisions.byChangeId.get(change.id) === "accept") {
      outputLength += change.insertedText.length - change.removedText.length;
    }
  }
  const outputError = ensureOutputLength(outputLength, limits);
  if (outputError !== null) {
    return outputError;
  }

  const resultParts: string[] = [];
  const edits: CandidatePlannedTextEdit[] = [];
  const acceptedChangeIds: string[] = [];
  const rejectedChangeIds: string[] = [];
  let cursor = 0;
  for (const change of diff.diff.changes) {
    resultParts.push(input.baseline.content.slice(cursor, change.baselineRange.start));
    if (decisions.byChangeId.get(change.id) === "accept") {
      resultParts.push(change.insertedText);
      acceptedChangeIds.push(change.id);
      if (change.removedText !== change.insertedText) {
        edits.push(
          freezeTextEdit({
            range: change.baselineRange,
            replacement: change.insertedText,
            sourceChangeId: change.id,
          }),
        );
      }
    } else {
      resultParts.push(change.removedText);
      rejectedChangeIds.push(change.id);
    }
    cursor = change.baselineRange.end;
  }
  resultParts.push(input.baseline.content.slice(cursor));
  edits.sort((left, right) => right.range.start - left.range.start);

  return readyPlan(
    input,
    resultParts.join(""),
    edits,
    acceptedChangeIds,
    rejectedChangeIds,
    diff.diff,
  );
}

function planCursorInsertion(
  input: PlanCandidateApplicationInput,
  strategy: Extract<CandidateApplicationStrategy, { readonly kind: "insert_at_cursor" }>,
  limits: CandidateDiffLimits,
): CandidateApplicationPlanOutcome {
  const cursor = strategy.cursorUtf16;
  if (
    !isValidUtf16Offset(input.current.content, cursor) ||
    !isUnicodeScalarBoundary(input.current.content, cursor)
  ) {
    return planningError(
      "INVALID_SELECTION",
      "The cursor must be a UTF-16 offset on a Unicode scalar boundary.",
      { cursorUtf16: cursor },
    );
  }
  const outputLength = input.current.content.length + input.candidateContent.length;
  const outputError = ensureOutputLength(outputLength, limits);
  if (outputError !== null) {
    return outputError;
  }
  if (input.candidateContent.length === 0) {
    return readyPlan(input, input.current.content, [], [], [], null);
  }

  return readyPlan(
    input,
    `${input.current.content.slice(0, cursor)}${input.candidateContent}${input.current.content.slice(cursor)}`,
    [
      freezeTextEdit({
        range: { start: cursor, end: cursor },
        replacement: input.candidateContent,
        sourceChangeId: null,
      }),
    ],
    [],
    [],
    null,
  );
}

function planSelectionReplacement(
  input: PlanCandidateApplicationInput,
  strategy: Extract<CandidateApplicationStrategy, { readonly kind: "replace_selection" }>,
  limits: CandidateDiffLimits,
): CandidateApplicationPlanOutcome {
  const { start, end } = strategy.selection;
  if (
    !isValidUtf16Offset(input.current.content, start) ||
    !isValidUtf16Offset(input.current.content, end) ||
    start > end ||
    !isUnicodeScalarBoundary(input.current.content, start) ||
    !isUnicodeScalarBoundary(input.current.content, end)
  ) {
    return planningError(
      "INVALID_SELECTION",
      "The selection must be an ordered UTF-16 range on Unicode scalar boundaries.",
      { endUtf16: end, startUtf16: start },
    );
  }
  const outputLength = input.current.content.length - (end - start) + input.candidateContent.length;
  const outputError = ensureOutputLength(outputLength, limits);
  if (outputError !== null) {
    return outputError;
  }
  if (input.current.content.slice(start, end) === input.candidateContent) {
    return readyPlan(input, input.current.content, [], [], [], null);
  }

  return readyPlan(
    input,
    `${input.current.content.slice(0, start)}${input.candidateContent}${input.current.content.slice(end)}`,
    [
      freezeTextEdit({
        range: { start, end },
        replacement: input.candidateContent,
        sourceChangeId: null,
      }),
    ],
    [],
    [],
    null,
  );
}

function readyPlan(
  input: PlanCandidateApplicationInput,
  resultContent: string,
  edits: readonly CandidatePlannedTextEdit[],
  acceptedChangeIds: readonly string[],
  rejectedChangeIds: readonly string[],
  diff: CandidateTextDiff | null,
): CandidateApplicationPlanOutcome {
  return {
    status: "ready",
    plan: Object.freeze({
      strategy: input.strategy.kind,
      baselineRevision: input.baseline.revision,
      baselineContentDigest: input.baseline.contentDigest,
      editOffsetEncoding: "utf-16",
      editOrder: "descending",
      edits: Object.freeze([...edits]),
      resultContent,
      acceptedChangeIds: Object.freeze([...acceptedChangeIds]),
      rejectedChangeIds: Object.freeze([...rejectedChangeIds]),
      diff,
    }),
  };
}

function validatePlanningInput(
  input: PlanCandidateApplicationInput,
  limits: CandidateDiffLimits,
): CandidateApplicationPlanOutcome | null {
  const baselineMetadataError = validateSnapshotMetadata(input.baseline, "baseline");
  if (baselineMetadataError !== null) {
    return baselineMetadataError;
  }
  const currentMetadataError = validateSnapshotMetadata(input.current, "current");
  if (currentMetadataError !== null) {
    return currentMetadataError;
  }

  for (const [field, content] of [
    ["baseline.content", input.baseline.content],
    ["current.content", input.current.content],
    ["candidateContent", input.candidateContent],
  ] as const) {
    const contentError = validateText(content, field, limits.maxTextUtf16Units);
    if (contentError !== null) {
      return contentError;
    }
  }
  return null;
}

function validateSnapshotMetadata(
  snapshot: CandidateMergeSnapshot,
  field: "baseline" | "current",
): CandidateApplicationPlanOutcome | null {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    return planningError(
      "INVALID_SNAPSHOT",
      "Candidate merge snapshot revisions must be positive safe integers.",
      { field: `${field}.revision`, revision: snapshot.revision },
    );
  }
  if (
    snapshot.contentDigest.length === 0 ||
    snapshot.contentDigest.length > 512 ||
    snapshot.contentDigest.trim() !== snapshot.contentDigest
  ) {
    return planningError(
      "INVALID_SNAPSHOT",
      "Candidate merge snapshot digests must be non-empty, trimmed, and bounded.",
      { digestLength: snapshot.contentDigest.length, field: `${field}.contentDigest` },
    );
  }
  return null;
}

function validateText(
  content: string,
  field: string,
  maxTextUtf16Units: number,
): PlanningErrorOutcome | null {
  if (content.length > maxTextUtf16Units) {
    return planningError("TEXT_LIMIT_EXCEEDED", "Candidate merge text exceeds its hard limit.", {
      actualUtf16Units: content.length,
      field,
      limitUtf16Units: maxTextUtf16Units,
    });
  }
  if (content.includes("\u0000")) {
    return planningError("INVALID_CONTENT", "Candidate merge text cannot contain null bytes.", {
      field,
    });
  }
  const invalidOffset = findInvalidUtf16Offset(content);
  return invalidOffset === null
    ? null
    : planningError("INVALID_UNICODE", "Candidate merge text must contain well-formed UTF-16.", {
        field,
        offsetUtf16: invalidOffset,
      });
}

function tokenizeText(
  content: string,
  field: string,
  maxTextUtf16Units: number,
  maxCodePoints: number,
): TokenizeOutcome {
  const validationError = validateText(content, field, maxTextUtf16Units);
  if (validationError !== null) {
    return validationError;
  }
  const tokens: string[] = [];
  for (const token of content) {
    if (tokens.length >= maxCodePoints) {
      return planningError(
        "TEXT_LIMIT_EXCEEDED",
        "The combined text is too large for bounded candidate diffing.",
        { field, limitCodePoints: maxCodePoints },
      );
    }
    tokens.push(token);
  }
  return {
    status: "ready",
    value: {
      tokens,
      utf16Units: content.length,
    },
  };
}

function findInvalidUtf16Offset(content: string): number | null {
  for (let index = 0; index < content.length; index += 1) {
    const unit = content.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return index;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return index;
    }
  }
  return null;
}

function commonPrefixLength(baseline: readonly string[], candidate: readonly string[]): number {
  const maximum = Math.min(baseline.length, candidate.length);
  let index = 0;
  while (index < maximum && baseline[index] === candidate[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(
  baseline: readonly string[],
  candidate: readonly string[],
  prefixLength: number,
): number {
  const maximum = Math.min(baseline.length, candidate.length) - prefixLength;
  let length = 0;
  while (
    length < maximum &&
    baseline[baseline.length - length - 1] === candidate[candidate.length - length - 1]
  ) {
    length += 1;
  }
  return length;
}

function boundedMyers(
  baseline: readonly string[],
  candidate: readonly string[],
  limits: CandidateDiffLimits,
): MyersOutcome {
  if (baseline.length === 0) {
    return atomsForSingleSidedInput("insert", candidate, limits);
  }
  if (candidate.length === 0) {
    return atomsForSingleSidedInput("delete", baseline, limits);
  }
  if (Math.abs(baseline.length - candidate.length) > limits.maxEditDistance) {
    return diffComplexityError("edit_distance", limits.maxEditDistance);
  }

  const offset = limits.maxEditDistance + 1;
  const frontier = new Int32Array(limits.maxEditDistance * 2 + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let traceCells = 0;
  let workUnits = 0;

  for (let distance = 0; distance <= limits.maxEditDistance; distance += 1) {
    traceCells += distance + 1;
    if (traceCells > limits.maxTraceCells) {
      return diffComplexityError("trace_cells", limits.maxTraceCells);
    }
    const snapshot = new Int32Array(distance + 1);

    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      workUnits += 1;
      if (workUnits > limits.maxWorkUnits) {
        return diffComplexityError("work_units", limits.maxWorkUnits);
      }

      const moveDown =
        diagonal === -distance ||
        (diagonal !== distance &&
          (frontier[offset + diagonal - 1] ?? -1) < (frontier[offset + diagonal + 1] ?? -1));
      let baselineIndex = moveDown
        ? (frontier[offset + diagonal + 1] ?? -1)
        : (frontier[offset + diagonal - 1] ?? -1) + 1;
      let candidateIndex = baselineIndex - diagonal;

      while (baselineIndex < baseline.length && candidateIndex < candidate.length) {
        workUnits += 1;
        if (workUnits > limits.maxWorkUnits) {
          return diffComplexityError("work_units", limits.maxWorkUnits);
        }
        if (baseline[baselineIndex] !== candidate[candidateIndex]) {
          break;
        }
        baselineIndex += 1;
        candidateIndex += 1;
      }

      frontier[offset + diagonal] = baselineIndex;
      snapshot[(diagonal + distance) / 2] = baselineIndex;
      if (baselineIndex >= baseline.length && candidateIndex >= candidate.length) {
        trace.push(snapshot);
        return {
          status: "ready",
          atoms: Object.freeze(backtrackMyers(trace, baseline, candidate, distance)),
          editDistance: distance,
        };
      }
    }
    trace.push(snapshot);
  }

  return diffComplexityError("edit_distance", limits.maxEditDistance);
}

function atomsForSingleSidedInput(
  kind: "insert" | "delete",
  tokens: readonly string[],
  limits: CandidateDiffLimits,
): MyersOutcome {
  if (tokens.length > limits.maxEditDistance) {
    return diffComplexityError("edit_distance", limits.maxEditDistance);
  }
  if (tokens.length > limits.maxWorkUnits) {
    return diffComplexityError("work_units", limits.maxWorkUnits);
  }
  return {
    status: "ready",
    atoms: Object.freeze(tokens.map((value) => Object.freeze({ kind, value }))),
    editDistance: tokens.length,
  };
}

function backtrackMyers(
  trace: readonly Int32Array[],
  baseline: readonly string[],
  candidate: readonly string[],
  finalDistance: number,
): DiffAtom[] {
  const reversed: DiffAtom[] = [];
  let baselineIndex = baseline.length;
  let candidateIndex = candidate.length;

  for (let distance = finalDistance; distance > 0; distance -= 1) {
    const previous = trace[distance - 1];
    if (previous === undefined) {
      throw new Error("Candidate diff trace is incomplete.");
    }
    const diagonal = baselineIndex - candidateIndex;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance &&
        traceValue(previous, distance - 1, diagonal - 1) <
          traceValue(previous, distance - 1, diagonal + 1))
        ? diagonal + 1
        : diagonal - 1;
    const previousBaselineIndex = traceValue(previous, distance - 1, previousDiagonal);
    const previousCandidateIndex = previousBaselineIndex - previousDiagonal;

    while (baselineIndex > previousBaselineIndex && candidateIndex > previousCandidateIndex) {
      baselineIndex -= 1;
      candidateIndex -= 1;
      const value = baseline[baselineIndex];
      if (value === undefined) {
        throw new Error("Candidate diff backtracking exceeded the baseline.");
      }
      reversed.push(Object.freeze({ kind: "equal", value }));
    }

    if (baselineIndex === previousBaselineIndex) {
      candidateIndex -= 1;
      const value = candidate[candidateIndex];
      if (value === undefined) {
        throw new Error("Candidate diff backtracking exceeded the candidate.");
      }
      reversed.push(Object.freeze({ kind: "insert", value }));
    } else {
      baselineIndex -= 1;
      const value = baseline[baselineIndex];
      if (value === undefined) {
        throw new Error("Candidate diff backtracking exceeded the baseline.");
      }
      reversed.push(Object.freeze({ kind: "delete", value }));
    }
  }

  while (baselineIndex > 0 && candidateIndex > 0) {
    baselineIndex -= 1;
    candidateIndex -= 1;
    const value = baseline[baselineIndex];
    if (value === undefined) {
      throw new Error("Candidate diff backtracking exceeded the baseline.");
    }
    reversed.push(Object.freeze({ kind: "equal", value }));
  }
  while (baselineIndex > 0) {
    baselineIndex -= 1;
    const value = baseline[baselineIndex];
    if (value === undefined) {
      throw new Error("Candidate diff backtracking exceeded the baseline.");
    }
    reversed.push(Object.freeze({ kind: "delete", value }));
  }
  while (candidateIndex > 0) {
    candidateIndex -= 1;
    const value = candidate[candidateIndex];
    if (value === undefined) {
      throw new Error("Candidate diff backtracking exceeded the candidate.");
    }
    reversed.push(Object.freeze({ kind: "insert", value }));
  }

  reversed.reverse();
  return reversed;
}

function traceValue(trace: Int32Array, distance: number, diagonal: number): number {
  if (diagonal < -distance || diagonal > distance || (diagonal + distance) % 2 !== 0) {
    return -1;
  }
  return trace[(diagonal + distance) / 2] ?? -1;
}

function buildChanges(
  atoms: readonly DiffAtom[],
  baselineStartUtf16: number,
  candidateStartUtf16: number,
  maxChanges: number,
):
  | {
      readonly status: "ready";
      readonly changes: CandidateTextChange[];
    }
  | {
      readonly status: "error";
      readonly error: CandidateMergePlanningError;
    } {
  const changes: CandidateTextChange[] = [];
  let baselineOffset = baselineStartUtf16;
  let candidateOffset = candidateStartUtf16;
  let pending:
    | {
        baselineStart: number;
        candidateStart: number;
        removed: string[];
        inserted: string[];
      }
    | undefined;

  const flush = (): CandidateMergePlanningError | null => {
    if (pending === undefined) {
      return null;
    }
    if (changes.length >= maxChanges) {
      return makePlanningError(
        "CHANGE_LIMIT_EXCEEDED",
        "Candidate diff produced too many independently actionable changes.",
        { limitChanges: maxChanges },
      );
    }
    const removedText = pending.removed.join("");
    const insertedText = pending.inserted.join("");
    changes.push(
      Object.freeze({
        id: `change-${String(changes.length + 1).padStart(6, "0")}`,
        baselineRange: freezeRange({
          start: pending.baselineStart,
          end: baselineOffset,
        }),
        candidateRange: freezeRange({
          start: pending.candidateStart,
          end: candidateOffset,
        }),
        removedText,
        insertedText,
        removedCodePoints: pending.removed.length,
        insertedCodePoints: pending.inserted.length,
      }),
    );
    pending = undefined;
    return null;
  };

  for (const atom of atoms) {
    if (atom.kind === "equal") {
      const error = flush();
      if (error !== null) {
        return { status: "error", error };
      }
      baselineOffset += atom.value.length;
      candidateOffset += atom.value.length;
      continue;
    }
    pending ??= {
      baselineStart: baselineOffset,
      candidateStart: candidateOffset,
      removed: [],
      inserted: [],
    };
    if (atom.kind === "delete") {
      pending.removed.push(atom.value);
      baselineOffset += atom.value.length;
    } else {
      pending.inserted.push(atom.value);
      candidateOffset += atom.value.length;
    }
  }

  const error = flush();
  return error === null ? { status: "ready", changes } : { status: "error", error };
}

function validateDecisions(
  changes: readonly CandidateTextChange[],
  decisions: readonly CandidateChangeDecision[],
):
  | {
      readonly status: "ready";
      readonly byChangeId: ReadonlyMap<string, "accept" | "reject">;
    }
  | {
      readonly status: "error";
      readonly error: CandidateMergePlanningError;
    } {
  const knownIds = new Set(changes.map((change) => change.id));
  const byChangeId = new Map<string, "accept" | "reject">();
  for (const decision of decisions) {
    if (
      !isCandidateChangeDecision(decision.decision) ||
      !knownIds.has(decision.changeId) ||
      byChangeId.has(decision.changeId)
    ) {
      return planningError(
        "INVALID_CHANGE_DECISIONS",
        "Change decisions must be valid and reference each known change at most once.",
        { changeId: decision.changeId },
      );
    }
    byChangeId.set(decision.changeId, decision.decision);
  }
  if (byChangeId.size !== changes.length) {
    const missing = changes.find((change) => !byChangeId.has(change.id));
    return planningError(
      "INVALID_CHANGE_DECISIONS",
      "Partial candidate application requires an explicit decision for every change.",
      { missingChangeId: missing?.id ?? "unknown" },
    );
  }
  return { status: "ready", byChangeId };
}

function isCandidateChangeDecision(value: unknown): value is "accept" | "reject" {
  return value === "accept" || value === "reject";
}

function resolveLimits(overrides: CandidateDiffLimitOverrides | undefined): ResolvedLimitsOutcome {
  const limits: CandidateDiffLimits = {
    maxTextUtf16Units:
      overrides?.maxTextUtf16Units ?? CANDIDATE_DIFF_DEFAULT_LIMITS.maxTextUtf16Units,
    maxTotalCodePoints:
      overrides?.maxTotalCodePoints ?? CANDIDATE_DIFF_DEFAULT_LIMITS.maxTotalCodePoints,
    maxEditDistance: overrides?.maxEditDistance ?? CANDIDATE_DIFF_DEFAULT_LIMITS.maxEditDistance,
    maxTraceCells: overrides?.maxTraceCells ?? CANDIDATE_DIFF_DEFAULT_LIMITS.maxTraceCells,
    maxWorkUnits: overrides?.maxWorkUnits ?? CANDIDATE_DIFF_DEFAULT_LIMITS.maxWorkUnits,
    maxChanges: overrides?.maxChanges ?? CANDIDATE_DIFF_DEFAULT_LIMITS.maxChanges,
    maxOutputUtf16Units:
      overrides?.maxOutputUtf16Units ?? CANDIDATE_DIFF_DEFAULT_LIMITS.maxOutputUtf16Units,
  };
  for (const [name, value, hardMaximum, minimum] of [
    [
      "maxTextUtf16Units",
      limits.maxTextUtf16Units,
      CANDIDATE_DIFF_HARD_LIMITS.maxTextUtf16Units,
      1,
    ],
    [
      "maxTotalCodePoints",
      limits.maxTotalCodePoints,
      CANDIDATE_DIFF_HARD_LIMITS.maxTotalCodePoints,
      1,
    ],
    ["maxEditDistance", limits.maxEditDistance, CANDIDATE_DIFF_HARD_LIMITS.maxEditDistance, 0],
    ["maxTraceCells", limits.maxTraceCells, CANDIDATE_DIFF_HARD_LIMITS.maxTraceCells, 1],
    ["maxWorkUnits", limits.maxWorkUnits, CANDIDATE_DIFF_HARD_LIMITS.maxWorkUnits, 1],
    ["maxChanges", limits.maxChanges, CANDIDATE_DIFF_HARD_LIMITS.maxChanges, 1],
    [
      "maxOutputUtf16Units",
      limits.maxOutputUtf16Units,
      CANDIDATE_DIFF_HARD_LIMITS.maxOutputUtf16Units,
      1,
    ],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > hardMaximum) {
      return planningError(
        "INVALID_LIMITS",
        "Candidate diff limits must be safe integers within their hard ceilings.",
        { hardMaximum, limit: name, minimum, value },
      );
    }
  }
  return { status: "ready", limits: Object.freeze(limits) };
}

function ensureOutputLength(
  outputLength: number,
  limits: CandidateDiffLimits,
): CandidateApplicationPlanOutcome | null {
  return outputLength <= limits.maxOutputUtf16Units
    ? null
    : planningError(
        "OUTPUT_LIMIT_EXCEEDED",
        "The planned candidate application would exceed the output limit.",
        {
          actualUtf16Units: outputLength,
          limitUtf16Units: limits.maxOutputUtf16Units,
        },
      );
}

function isValidUtf16Offset(content: string, offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= content.length;
}

function isUnicodeScalarBoundary(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) {
    return true;
  }
  const previous = content.charCodeAt(offset - 1);
  const next = content.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function utf16LengthOfTokens(tokens: readonly string[], count: number): number {
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length += tokens[index]?.length ?? 0;
  }
  return length;
}

function freezeSnapshot(snapshot: CandidateMergeSnapshot): CandidateMergeSnapshot {
  return Object.freeze({ ...snapshot });
}

function freezeRange(range: CandidateUtf16Range): CandidateUtf16Range {
  return Object.freeze({ ...range });
}

function freezeTextEdit(edit: CandidatePlannedTextEdit): CandidatePlannedTextEdit {
  return Object.freeze({ ...edit, range: freezeRange(edit.range) });
}

function diffComplexityError(
  resource: "edit_distance" | "trace_cells" | "work_units",
  limit: number,
): MyersOutcome {
  return planningError(
    "DIFF_COMPLEXITY_LIMIT_EXCEEDED",
    "Candidate diff complexity exceeded a bounded resource limit.",
    { limit, resource },
  );
}

function planningError(
  code: CandidateMergePlanningErrorCode,
  message: string,
  context: Record<string, boolean | number | string>,
): PlanningErrorOutcome {
  return {
    status: "error",
    error: makePlanningError(code, message, context),
  };
}

function makePlanningError(
  code: CandidateMergePlanningErrorCode,
  message: string,
  context: Record<string, boolean | number | string>,
): CandidateMergePlanningError {
  return Object.freeze({
    code,
    message,
    context: Object.freeze({ ...context }),
  });
}
