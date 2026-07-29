import {
  AUTHORITATIVE_EXTRACTION_SEVERITIES,
  validateAuthoritativeExtractionProvenance,
  validateAuthoritativeExtractionSource,
  type AuthoritativeExtractionCandidate,
  type AuthoritativeExtractionGoldenThresholds,
  type AuthoritativeExtractionMetrics,
  type AuthoritativeExtractionProvenance,
  type AuthoritativeExtractionSource,
} from "./authoritative-extraction.js";
import { StoryCoreError } from "./errors.js";
import { FORMAL_RECORD_KINDS } from "./formal-record.js";
import { err, ok, type Result } from "./result.js";
import { cloneStoryValue, createEvidence, createStoryValue, storyValuesEqual } from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
} from "./value-objects.js";

export const AUTHORITATIVE_EXTRACTION_JOB_STATES = [
  "queued",
  "running",
  "waiting_for_network",
  "blocked_evaluation",
  "materialization_pending",
  "materializing",
  "awaiting_review",
  "completed",
  "failed_retryable",
  "failed_final",
  "blocked_stale",
  "cancelled",
] as const;
export type AuthoritativeExtractionJobState = (typeof AUTHORITATIVE_EXTRACTION_JOB_STATES)[number];

export const AUTHORITATIVE_EXTRACTION_EXECUTION_MODES = ["local", "remote"] as const;
export type AuthoritativeExtractionExecutionMode =
  (typeof AUTHORITATIVE_EXTRACTION_EXECUTION_MODES)[number];

export interface AuthoritativeExtractionJobFailure {
  readonly code: SafeIdentifier;
  readonly retryable: boolean;
}

export interface AuthoritativeExtractionJob {
  readonly id: UuidV7;
  readonly source: AuthoritativeExtractionSource;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly evaluationSuiteId: SafeIdentifier;
  readonly executionMode: AuthoritativeExtractionExecutionMode;
  readonly state: AuthoritativeExtractionJobState;
  readonly revision: number;
  readonly attemptCount: number;
  readonly cancelRequested: boolean;
  readonly leaseOwner: SafeIdentifier | null;
  readonly leaseExpiresAt: IsoUtcTimestamp | null;
  readonly failure: AuthoritativeExtractionJobFailure | null;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface CreateAuthoritativeExtractionJobInput {
  readonly id: string;
  readonly source: AuthoritativeExtractionSource;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly evaluationSuiteId: string;
  readonly executionMode: AuthoritativeExtractionExecutionMode;
  readonly now: string;
}

export interface AuthoritativeExtractionCandidateRecord {
  readonly jobId: UuidV7;
  readonly reviewItemId: UuidV7;
  readonly source: AuthoritativeExtractionSource;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly candidate: AuthoritativeExtractionCandidate;
  readonly createdAt: IsoUtcTimestamp;
}

export interface AuthoritativeExtractionEvaluationRecord {
  readonly id: UuidV7;
  readonly suiteId: SafeIdentifier;
  readonly provenance: AuthoritativeExtractionProvenance;
  readonly thresholds: AuthoritativeExtractionGoldenThresholds;
  readonly metrics: AuthoritativeExtractionMetrics;
  readonly fixtureCount: number;
  readonly protocolFailureCount: number;
  readonly createdAt: IsoUtcTimestamp;
}

export const AUTHORITATIVE_EXTRACTION_DECISION_KINDS = [
  "accept",
  "modify",
  "reject",
  "defer",
  "resume",
] as const;
export type AuthoritativeExtractionDecisionKind =
  (typeof AUTHORITATIVE_EXTRACTION_DECISION_KINDS)[number];
export type AuthoritativeExtractionDecisionClaimState =
  "claimed" | "committed" | "projection_pending" | "completed";

export interface AuthoritativeExtractionDecisionClaim {
  readonly idempotencyKey: string;
  readonly jobId: UuidV7;
  readonly candidateKey: SafeIdentifier;
  readonly decisionId: UuidV7;
  readonly kind: AuthoritativeExtractionDecisionKind;
  readonly payloadChecksumSha256: string;
  readonly state: AuthoritativeExtractionDecisionClaimState;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface AuthoritativeExtractionEnqueueResult {
  readonly job: AuthoritativeExtractionJob;
  readonly created: boolean;
}

export interface ClaimAuthoritativeExtractionJobInput {
  readonly projectId: UuidV7;
  readonly workerId: SafeIdentifier;
  readonly now: IsoUtcTimestamp;
  readonly leaseExpiresAt: IsoUtcTimestamp;
}

export interface CompleteAuthoritativeExtractionAttemptInput {
  readonly job: AuthoritativeExtractionJob;
  readonly expectedRevision: number;
  readonly workerId: SafeIdentifier;
  readonly candidates: readonly AuthoritativeExtractionCandidateRecord[];
  readonly now: IsoUtcTimestamp;
}

export interface FailAuthoritativeExtractionJobInput {
  readonly jobId: UuidV7;
  readonly expectedRevision: number;
  readonly workerId: SafeIdentifier;
  readonly state:
    | "waiting_for_network"
    | "blocked_evaluation"
    | "failed_retryable"
    | "failed_final"
    | "blocked_stale"
    | "cancelled";
  readonly failure: AuthoritativeExtractionJobFailure | null;
  readonly now: IsoUtcTimestamp;
}

export interface ClaimAuthoritativeExtractionDecisionInput {
  readonly idempotencyKey: string;
  readonly jobId: UuidV7;
  readonly candidateKey: SafeIdentifier;
  readonly decisionId: UuidV7;
  readonly kind: AuthoritativeExtractionDecisionKind;
  readonly payloadChecksumSha256: string;
  readonly now: IsoUtcTimestamp;
}

/**
 * Durable queue/evaluation boundary. Implementations persist only source
 * references, strict candidates, metrics, and sanitized errors. Source chapter
 * text, prompt bodies, provider messages, and credentials are intentionally
 * absent from every command.
 */
export interface AuthoritativeExtractionRepository {
  enqueue(
    job: AuthoritativeExtractionJob,
  ): Promise<Result<AuthoritativeExtractionEnqueueResult, StoryCoreError>>;

  listJobsByProject(
    projectId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionJob[], StoryCoreError>>;

  findJobById(jobId: UuidV7): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>>;

  recoverExpiredLeases(
    now: IsoUtcTimestamp,
  ): Promise<Result<readonly AuthoritativeExtractionJob[], StoryCoreError>>;

  resumeNetworkJobs(
    projectId: UuidV7,
    now: IsoUtcTimestamp,
  ): Promise<Result<number, StoryCoreError>>;

  resumeEvaluationBlockedJobs(
    projectId: UuidV7,
    provenance: AuthoritativeExtractionProvenance,
    now: IsoUtcTimestamp,
  ): Promise<Result<number, StoryCoreError>>;

  claimNext(
    input: ClaimAuthoritativeExtractionJobInput,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>>;

  claimMaterialization(
    input: ClaimAuthoritativeExtractionJobInput,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>>;

  completeAttempt(
    input: CompleteAuthoritativeExtractionAttemptInput,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>>;

  finishMaterialization(
    jobId: UuidV7,
    expectedRevision: number,
    workerId: SafeIdentifier,
    now: IsoUtcTimestamp,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>>;

  failJob(
    input: FailAuthoritativeExtractionJobInput,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>>;

  requestCancellation(
    jobId: UuidV7,
    now: IsoUtcTimestamp,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>>;

  isCancellationRequested(jobId: UuidV7): Promise<Result<boolean, StoryCoreError>>;

  listCandidatesByProject(
    projectId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionCandidateRecord[], StoryCoreError>>;

  listCandidatesByJob(
    jobId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionCandidateRecord[], StoryCoreError>>;

  findCandidate(
    jobId: UuidV7,
    candidateKey: SafeIdentifier,
  ): Promise<Result<AuthoritativeExtractionCandidateRecord | null, StoryCoreError>>;

  recordEvaluation(
    evaluation: AuthoritativeExtractionEvaluationRecord,
  ): Promise<Result<void, StoryCoreError>>;

  findLatestPassingEvaluation(
    suiteId: SafeIdentifier,
    provenance: AuthoritativeExtractionProvenance,
  ): Promise<Result<AuthoritativeExtractionEvaluationRecord | null, StoryCoreError>>;

  claimDecision(
    input: ClaimAuthoritativeExtractionDecisionInput,
  ): Promise<Result<AuthoritativeExtractionDecisionClaim, StoryCoreError>>;

  updateDecisionClaim(
    idempotencyKey: string,
    expectedState: AuthoritativeExtractionDecisionClaimState,
    nextState: AuthoritativeExtractionDecisionClaimState,
    now: IsoUtcTimestamp,
  ): Promise<Result<AuthoritativeExtractionDecisionClaim, StoryCoreError>>;

  findDecisionClaim(
    idempotencyKey: string,
  ): Promise<Result<AuthoritativeExtractionDecisionClaim | null, StoryCoreError>>;
}

export function createAuthoritativeExtractionJob(
  input: CreateAuthoritativeExtractionJobInput,
): Result<AuthoritativeExtractionJob, StoryCoreError> {
  const id = parseUuidV7(input.id);
  const source = validateAuthoritativeExtractionSource(input.source);
  const provenance = validateAuthoritativeExtractionProvenance(input.provenance);
  const suiteId = parseSafeIdentifier(input.evaluationSuiteId);
  const now = parseIsoUtcTimestamp(input.now);
  if (
    !id.ok ||
    !source.ok ||
    !provenance.ok ||
    !suiteId.ok ||
    !now.ok ||
    !AUTHORITATIVE_EXTRACTION_EXECUTION_MODES.includes(input.executionMode)
  ) {
    return taskValidationError("Authoritative extraction job metadata is invalid.");
  }
  return ok(
    Object.freeze({
      id: id.value,
      source: source.value,
      provenance: provenance.value,
      evaluationSuiteId: suiteId.value,
      executionMode: input.executionMode,
      state: "queued",
      revision: 1,
      attemptCount: 0,
      cancelRequested: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      failure: null,
      createdAt: now.value,
      updatedAt: now.value,
    }),
  );
}

export function validateAuthoritativeExtractionJob(
  job: AuthoritativeExtractionJob,
): Result<AuthoritativeExtractionJob, StoryCoreError> {
  const id = parseUuidV7(job.id);
  const source = validateAuthoritativeExtractionSource(job.source);
  const provenance = validateAuthoritativeExtractionProvenance(job.provenance);
  const suiteId = parseSafeIdentifier(job.evaluationSuiteId);
  const createdAt = parseIsoUtcTimestamp(job.createdAt);
  const updatedAt = parseIsoUtcTimestamp(job.updatedAt);
  const leaseOwner = job.leaseOwner === null ? ok(null) : parseSafeIdentifier(job.leaseOwner);
  const leaseExpiresAt =
    job.leaseExpiresAt === null ? ok(null) : parseIsoUtcTimestamp(job.leaseExpiresAt);
  const failure = job.failure === null ? ok(null) : validateJobFailure(job.failure);
  const leaseRequired = job.state === "running" || job.state === "materializing";
  if (
    !id.ok ||
    !source.ok ||
    !provenance.ok ||
    !suiteId.ok ||
    !createdAt.ok ||
    !updatedAt.ok ||
    !leaseOwner.ok ||
    !leaseExpiresAt.ok ||
    !failure.ok ||
    !AUTHORITATIVE_EXTRACTION_JOB_STATES.includes(job.state) ||
    !AUTHORITATIVE_EXTRACTION_EXECUTION_MODES.includes(job.executionMode) ||
    !Number.isSafeInteger(job.revision) ||
    job.revision < 1 ||
    !Number.isSafeInteger(job.attemptCount) ||
    job.attemptCount < 0 ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0 ||
    leaseRequired !== (leaseOwner.value !== null && leaseExpiresAt.value !== null) ||
    (!leaseRequired && (leaseOwner.value !== null || leaseExpiresAt.value !== null)) ||
    (job.cancelRequested && job.state !== "running") ||
    (job.state === "cancelled" && failure.value !== null) ||
    (job.state === "queued" && failure.value !== null)
  ) {
    return taskValidationError("Stored authoritative extraction job is invalid.");
  }
  return ok(
    Object.freeze({
      ...job,
      id: id.value,
      source: source.value,
      provenance: provenance.value,
      evaluationSuiteId: suiteId.value,
      leaseOwner: leaseOwner.value,
      leaseExpiresAt: leaseExpiresAt.value,
      failure: failure.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    }),
  );
}

export function validateAuthoritativeExtractionCandidateRecord(
  record: AuthoritativeExtractionCandidateRecord,
): Result<AuthoritativeExtractionCandidateRecord, StoryCoreError> {
  const jobId = parseUuidV7(record.jobId);
  const reviewItemId = parseUuidV7(record.reviewItemId);
  const source = validateAuthoritativeExtractionSource(record.source);
  const provenance = validateAuthoritativeExtractionProvenance(record.provenance);
  const createdAt = parseIsoUtcTimestamp(record.createdAt);
  const key = parseSafeIdentifier(record.candidate.key);
  const category = parseSafeIdentifier(record.candidate.category);
  const targetId = parseUuidV7(record.candidate.target.recordId);
  const original = createStoryValue(record.candidate.originalValue);
  const suggestion = createStoryValue(record.candidate.suggestedValue);
  const evidence = createEvidence({
    excerpt: record.candidate.evidence.excerpt,
    ...record.candidate.evidence.range,
  });
  if (
    !jobId.ok ||
    !reviewItemId.ok ||
    !source.ok ||
    !provenance.ok ||
    !createdAt.ok ||
    !key.ok ||
    !category.ok ||
    !targetId.ok ||
    !original.ok ||
    !suggestion.ok ||
    !evidence.ok ||
    !FORMAL_RECORD_KINDS.includes(record.candidate.target.kind) ||
    !Number.isSafeInteger(record.candidate.target.expectedRevision) ||
    record.candidate.target.expectedRevision < 1 ||
    !AUTHORITATIVE_EXTRACTION_SEVERITIES.includes(record.candidate.severity) ||
    !isRatio(record.candidate.confidence)
  ) {
    return taskValidationError("Stored authoritative extraction candidate is invalid.");
  }
  if (
    storyValuesEqual(original.value, suggestion.value) ||
    evidence.value.range.start < source.value.scope.start ||
    evidence.value.range.end > source.value.scope.end
  ) {
    return taskValidationError("Stored authoritative extraction candidate is invalid.");
  }
  return ok(
    Object.freeze({
      jobId: jobId.value,
      reviewItemId: reviewItemId.value,
      source: source.value,
      provenance: provenance.value,
      candidate: Object.freeze({
        ...record.candidate,
        key: key.value,
        category: category.value,
        target: Object.freeze({
          ...record.candidate.target,
          recordId: targetId.value,
        }),
        originalValue: cloneStoryValue(original.value),
        suggestedValue: cloneStoryValue(suggestion.value),
        evidence: Object.freeze({
          excerpt: evidence.value.excerpt,
          range: Object.freeze({ ...evidence.value.range }),
        }),
      }),
      createdAt: createdAt.value,
    }),
  );
}

export function validateAuthoritativeExtractionEvaluationRecord(
  evaluation: AuthoritativeExtractionEvaluationRecord,
): Result<AuthoritativeExtractionEvaluationRecord, StoryCoreError> {
  const id = parseUuidV7(evaluation.id);
  const suiteId = parseSafeIdentifier(evaluation.suiteId);
  const provenance = validateAuthoritativeExtractionProvenance(evaluation.provenance);
  const createdAt = parseIsoUtcTimestamp(evaluation.createdAt);
  const { thresholds, metrics } = evaluation;
  const expectedPrecision =
    metrics.predictedCount === 0 ? 1 : metrics.truePositiveCount / metrics.predictedCount;
  const expectedRecall =
    metrics.expectedCount === 0 ? 1 : metrics.truePositiveCount / metrics.expectedCount;
  if (
    !id.ok ||
    !suiteId.ok ||
    !provenance.ok ||
    !createdAt.ok ||
    !isRatio(thresholds.minimumPrecision) ||
    !isRatio(thresholds.minimumRecall) ||
    !isNonNegativeInteger(evaluation.fixtureCount) ||
    evaluation.fixtureCount < 1 ||
    !isNonNegativeInteger(evaluation.protocolFailureCount) ||
    evaluation.protocolFailureCount > evaluation.fixtureCount ||
    !isNonNegativeInteger(metrics.truePositiveCount) ||
    !isNonNegativeInteger(metrics.falsePositiveCount) ||
    !isNonNegativeInteger(metrics.falseNegativeCount) ||
    metrics.predictedCount !== metrics.truePositiveCount + metrics.falsePositiveCount ||
    metrics.expectedCount !== metrics.truePositiveCount + metrics.falseNegativeCount ||
    Math.abs(metrics.precision - expectedPrecision) > Number.EPSILON ||
    Math.abs(metrics.recall - expectedRecall) > Number.EPSILON ||
    metrics.passed !==
      (evaluation.protocolFailureCount === 0 &&
        metrics.precision >= thresholds.minimumPrecision &&
        metrics.recall >= thresholds.minimumRecall)
  ) {
    return taskValidationError("Authoritative extraction evaluation record is invalid.");
  }
  return ok(
    Object.freeze({
      ...evaluation,
      id: id.value,
      suiteId: suiteId.value,
      provenance: provenance.value,
      thresholds: Object.freeze({ ...thresholds }),
      metrics: Object.freeze({ ...metrics }),
      createdAt: createdAt.value,
    }),
  );
}

export function validateAuthoritativeExtractionDecisionClaim(
  claim: AuthoritativeExtractionDecisionClaim,
): Result<AuthoritativeExtractionDecisionClaim, StoryCoreError> {
  const jobId = parseUuidV7(claim.jobId);
  const candidateKey = parseSafeIdentifier(claim.candidateKey);
  const decisionId = parseUuidV7(claim.decisionId);
  const createdAt = parseIsoUtcTimestamp(claim.createdAt);
  const updatedAt = parseIsoUtcTimestamp(claim.updatedAt);
  if (
    !isIdempotencyKey(claim.idempotencyKey) ||
    !jobId.ok ||
    !candidateKey.ok ||
    !decisionId.ok ||
    !AUTHORITATIVE_EXTRACTION_DECISION_KINDS.includes(claim.kind) ||
    !/^[0-9a-f]{64}$/u.test(claim.payloadChecksumSha256) ||
    !["claimed", "committed", "projection_pending", "completed"].includes(claim.state) ||
    !createdAt.ok ||
    !updatedAt.ok ||
    compareTimestamps(updatedAt.value, createdAt.value) < 0
  ) {
    return taskValidationError("Authoritative extraction decision claim is invalid.");
  }
  return ok(
    Object.freeze({
      ...claim,
      jobId: jobId.value,
      candidateKey: candidateKey.value,
      decisionId: decisionId.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    }),
  );
}

export function isAuthoritativeExtractionTerminalState(
  state: AuthoritativeExtractionJobState,
): boolean {
  return ["completed", "failed_final", "blocked_stale", "cancelled"].includes(state);
}

export function isAuthoritativeExtractionIdempotencyKey(value: string): boolean {
  return isIdempotencyKey(value);
}

function validateJobFailure(
  failure: AuthoritativeExtractionJobFailure,
): Result<AuthoritativeExtractionJobFailure, StoryCoreError> {
  const code = parseSafeIdentifier(failure.code);
  return code.ok && typeof failure.retryable === "boolean"
    ? ok(Object.freeze({ code: code.value, retryable: failure.retryable }))
    : taskValidationError("Extraction failure metadata is invalid.");
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIdempotencyKey(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]+$/u.test(value)
  );
}

function taskValidationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}
