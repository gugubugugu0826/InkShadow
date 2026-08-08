import type { Clock } from "@inkshadow/domain";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export const MULTI_AGENT_REVIEW_MODES = [
  "brainstorm",
  "outline_review",
  "character_review",
  "world_review",
  "commercial_review",
  "plot_planning",
] as const;

export const MULTI_AGENT_REVIEW_ROLES = [
  "planner",
  "drafter",
  "critic",
  "continuity_reviewer",
  "editor",
] as const;

export const MULTI_AGENT_REVIEW_CONCLUSION_CATEGORIES = [
  "must_change",
  "suggested_change",
  "optional_enhancement",
  "disputed_opinion",
  "convertible_task",
] as const;

export type PersistedMultiAgentReviewMode = (typeof MULTI_AGENT_REVIEW_MODES)[number];
export type PersistedMultiAgentReviewRole = (typeof MULTI_AGENT_REVIEW_ROLES)[number];
export type MultiAgentReviewConclusionCategory =
  (typeof MULTI_AGENT_REVIEW_CONCLUSION_CATEGORIES)[number];
export type MultiAgentReviewTargetKind = "chapter" | "outline";
export type MultiAgentReviewSessionStatus =
  "idle" | "running" | "candidate_ready" | "needs_input" | "failed" | "paused" | "cancelled";
export type MultiAgentReviewParticipantStatus =
  "idle" | "working" | "done" | "needs_input" | "error" | "paused" | "cancelled";
export type MultiAgentReviewTurnStatus =
  "working" | "completed" | "needs_input" | "failed" | "cancelled";
export type MultiAgentReviewCandidateStatus = "ready" | "accepted" | "rejected" | "expired";

export interface MultiAgentReviewLimits {
  readonly maximumRounds: number;
  readonly maximumTurns: number;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumCostMicros: number;
  readonly maximumDurationMs: number;
  readonly currency: string;
}

export interface MultiAgentReviewParticipantSnapshot {
  readonly participantId: string;
  readonly ordinal: number;
  readonly role: PersistedMultiAgentReviewRole;
  readonly enabled: boolean;
  readonly status: MultiAgentReviewParticipantStatus;
  readonly providerId: string;
  readonly providerKind: "open_ai_compatible" | "ollama";
  readonly endpointUrl: string;
  readonly authentication: "none" | "bearer_keyring";
  readonly providerProfileRevision: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly maximumTurns: number;
  readonly contextWindowTokens: number;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly cachedInputMicrosPerMillionTokens: number | null;
  readonly pricingVersion: string;
  readonly priceUpdatedAt: string;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MultiAgentReviewSourceReference {
  readonly kind: "chapter" | "outline_node" | "material" | "project_rule" | "turn";
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceVersionId: string | null;
  readonly sourceChecksum: string;
  readonly modelLabel: string;
  readonly authoritativeLabel: string | null;
  readonly excerpt: string | null;
}

export const MULTI_AGENT_CONFIRMED_STORY_FACT_AUTHORITY_SCHEMA =
  "inkshadow.multi-agent.confirmed-story-fact.v1" as const;

export interface MultiAgentReviewConfirmedStoryFactAuthorityInput {
  readonly id: string;
  readonly projectId: string;
  readonly factType: string;
  readonly contentText: string | null;
  readonly structuredValue: unknown;
  readonly source: Readonly<{
    readonly kind: string;
    readonly reference: string;
    readonly chapterId: string | null;
    readonly versionId: string | null;
    readonly startOffset: number | null;
    readonly endOffset: number | null;
    readonly sourceLength: number | null;
    readonly excerpt: string | null;
    readonly contentChecksum: string | null;
  }>;
  readonly effectiveAt: string | null;
  readonly invalidatedAt: string | null;
  readonly confidence: number;
  readonly origin: string;
  readonly locked: boolean;
  readonly revision: number;
}

/**
 * Canonical public authority shared by local multi-agent prompts and the
 * persistence-time citation verifier. It deliberately represents only a
 * main-branch, formal, user-confirmed and non-deprecated StoryFact.
 */
export interface MultiAgentReviewConfirmedStoryFactAuthority extends MultiAgentReviewConfirmedStoryFactAuthorityInput {
  readonly schemaVersion: typeof MULTI_AGENT_CONFIRMED_STORY_FACT_AUTHORITY_SCHEMA;
  readonly authorityKind: "confirmed_story_fact";
  readonly status: "formal";
  readonly branchId: null;
  readonly userConfirmed: true;
  readonly deprecated: false;
  readonly needsReview: false;
}

export function createMultiAgentReviewConfirmedStoryFactAuthority(
  input: MultiAgentReviewConfirmedStoryFactAuthorityInput,
): MultiAgentReviewConfirmedStoryFactAuthority {
  return Object.freeze({
    schemaVersion: MULTI_AGENT_CONFIRMED_STORY_FACT_AUTHORITY_SCHEMA,
    authorityKind: "confirmed_story_fact" as const,
    id: input.id,
    projectId: input.projectId,
    factType: input.factType,
    contentText: input.contentText,
    structuredValue: input.structuredValue,
    source: Object.freeze({ ...input.source }),
    effectiveAt: input.effectiveAt,
    invalidatedAt: input.invalidatedAt,
    confidence: input.confidence,
    status: "formal" as const,
    branchId: null,
    origin: input.origin,
    userConfirmed: true as const,
    locked: input.locked,
    deprecated: false as const,
    needsReview: false as const,
    revision: input.revision,
  });
}

export function computeMultiAgentReviewConfirmedStoryFactChecksum(
  authority: MultiAgentReviewConfirmedStoryFactAuthority,
): Promise<string> {
  return sha256Hex(canonicalJson(authority));
}

export interface MultiAgentReviewConclusion {
  readonly id: string;
  readonly ordinal: number;
  readonly category: MultiAgentReviewConclusionCategory;
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly string[];
  readonly sourceReferences: readonly MultiAgentReviewSourceReference[];
  readonly taskProposal: {
    readonly title: string;
    readonly description: string;
    readonly priority: "p0" | "p1" | "p2" | "p3";
  } | null;
}

export interface MultiAgentReviewTurn {
  readonly id: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly participantId: string;
  readonly idempotencyKey: string;
  readonly resultFingerprint: string | null;
  readonly generationId: string;
  readonly runRevisionBefore: number;
  readonly status: MultiAgentReviewTurnStatus;
  readonly reservation: {
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
    readonly maximumCostMicros: number;
  };
  readonly publicMessage: string | null;
  readonly responseJson: string | null;
  readonly usageSource: "provider_reported" | "provider_unavailable" | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly costMicros: number | null;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly conclusions: readonly MultiAgentReviewConclusion[];
}

export interface MultiAgentReviewCandidate {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly targetKind: MultiAgentReviewTargetKind;
  readonly chapterCandidateId: string | null;
  readonly baseVersionId: string | null;
  readonly baseOutlineRevision: number | null;
  readonly payloadJson: string;
  readonly payloadChecksum: string;
  readonly status: MultiAgentReviewCandidateStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
  readonly acceptedOutlineSnapshotJson: string | null;
  readonly acceptedOutlineRevision: number | null;
}

export interface MultiAgentReviewSession {
  readonly id: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly restartOfSessionId: string | null;
  readonly mode: PersistedMultiAgentReviewMode;
  readonly targetKind: MultiAgentReviewTargetKind;
  readonly chapterId: string | null;
  readonly baseVersionId: string | null;
  readonly baseOutlineRevision: number | null;
  readonly baseAuthorityChecksum: string;
  readonly userRequest: string;
  readonly status: MultiAgentReviewSessionStatus;
  readonly revision: number;
  readonly attempt: number;
  readonly limits: MultiAgentReviewLimits;
  readonly cancellationRequested: boolean;
  readonly failureCode: string | null;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly participants: readonly MultiAgentReviewParticipantSnapshot[];
  readonly turns: readonly MultiAgentReviewTurn[];
  readonly candidate: MultiAgentReviewCandidate | null;
}

export interface CreateMultiAgentReviewSessionInput {
  readonly id: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly restartOfSessionId?: string | null;
  readonly mode: PersistedMultiAgentReviewMode;
  readonly target:
    | {
        readonly kind: "chapter";
        readonly chapterId: string;
        readonly baseVersionId: string;
        readonly baseAuthorityChecksum: string;
      }
    | {
        readonly kind: "outline";
        readonly baseOutlineRevision: number;
        readonly baseAuthorityChecksum: string;
      };
  readonly userRequest: string;
  readonly attempt?: number;
  readonly limits: MultiAgentReviewLimits;
  readonly participants: readonly Omit<
    MultiAgentReviewParticipantSnapshot,
    "status" | "errorCode" | "createdAt" | "updatedAt"
  >[];
  readonly startedAt: string;
  readonly deadlineAt: string;
}

export interface ClaimMultiAgentReviewTurnInput {
  readonly sessionId: string;
  readonly expectedSessionRevision: number;
  readonly turnId: string;
  readonly participantId: string;
  readonly idempotencyKey: string;
  readonly generationId: string;
  readonly reservation: {
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
    readonly maximumCostMicros: number;
  };
  readonly startedAt: string;
}

export interface CompleteMultiAgentReviewTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly expectedSessionRevision: number;
  readonly resultFingerprint: string;
  readonly serializedResponse: string;
  readonly publicMessage: string;
  readonly needsInput: boolean;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number | null;
  };
  readonly conclusions: readonly Omit<MultiAgentReviewConclusion, "ordinal">[];
  readonly completedAt: string;
}

export interface FailMultiAgentReviewTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly expectedSessionRevision: number;
  readonly outcome: "failed" | "cancelled";
  readonly errorCode: string;
  readonly resultFingerprint?: string | null;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number | null;
  } | null;
  readonly completedAt: string;
}

export interface PublishMultiAgentReviewCandidateInput {
  readonly sessionId: string;
  readonly expectedSessionRevision: number;
  readonly candidateId: string;
  readonly chapterCandidateId: string | null;
  readonly payloadJson: string;
  readonly payloadChecksum: string;
  readonly chapterContentChecksum: string | null;
  readonly auditEventId: string;
  readonly publishedAt: string;
}

export interface CreateMultiAgentReviewSessionReceipt {
  readonly session: MultiAgentReviewSession;
  readonly created: boolean;
}

export interface AcceptOutlineReviewCandidateReceipt {
  readonly candidate: MultiAgentReviewCandidate;
  readonly outlineSnapshotJson: string;
  readonly outlineRevision: number;
}

export type MultiAgentReviewStoreErrorCode =
  | "MULTI_AGENT_INVALID_INPUT"
  | "MULTI_AGENT_NOT_FOUND"
  | "MULTI_AGENT_AUTHORITY_MISMATCH"
  | "MULTI_AGENT_IDEMPOTENCY_CONFLICT"
  | "MULTI_AGENT_REVISION_CONFLICT"
  | "MULTI_AGENT_ILLEGAL_STATE"
  | "MULTI_AGENT_LIMIT_EXHAUSTED"
  | "MULTI_AGENT_USAGE_UNAVAILABLE"
  | "MULTI_AGENT_CORRUPT";

export class MultiAgentReviewStoreError extends Error {
  public constructor(
    readonly code: MultiAgentReviewStoreErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MultiAgentReviewStoreError";
  }
}

interface SessionRow {
  id: string;
  project_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  restart_of_session_id: string | null;
  mode: string;
  target_kind: string;
  chapter_id: string | null;
  base_version_id: string | null;
  base_outline_revision: number | null;
  base_authority_checksum: string;
  user_request: string;
  status: string;
  revision: number;
  attempt: number;
  maximum_rounds: number;
  maximum_turns: number;
  maximum_input_tokens: number;
  maximum_output_tokens: number;
  maximum_cost_micros: number;
  maximum_duration_ms: number;
  currency: string;
  cancellation_requested: number;
  failure_code: string | null;
  started_at: string;
  deadline_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ParticipantRow {
  session_id: string;
  participant_id: string;
  ordinal: number;
  role: string;
  enabled: number;
  status: string;
  provider_id: string;
  provider_kind: string;
  endpoint_url: string;
  authentication: string;
  provider_profile_revision: number;
  model_id: string;
  model_revision: string;
  maximum_turns: number;
  context_window_tokens: number;
  input_micros_per_million_tokens: number;
  output_micros_per_million_tokens: number;
  cached_input_micros_per_million_tokens: number | null;
  pricing_version: string;
  price_updated_at: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  sequence: number;
  attempt: number;
  participant_id: string;
  idempotency_key: string;
  result_fingerprint: string | null;
  generation_id: string;
  run_revision_before: number;
  status: string;
  reservation_input_tokens: number;
  reservation_output_tokens: number;
  reservation_cost_micros: number;
  public_message: string | null;
  response_json: string | null;
  usage_source: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_micros: number | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ConclusionRow {
  id: string;
  session_id: string;
  turn_id: string;
  ordinal: number;
  category: string;
  title: string;
  explanation: string;
  evidence_json: string;
  task_proposal_json: string | null;
  created_at: string;
}

interface SourceReferenceRow {
  conclusion_id: string;
  ordinal: number;
  kind: string;
  source_id: string;
  source_revision: number;
  source_version_id: string | null;
  source_checksum: string;
  model_label: string;
  authoritative_label: string;
  excerpt: string | null;
}

interface CandidateRow {
  id: string;
  session_id: string;
  project_id: string;
  target_kind: string;
  chapter_candidate_id: string | null;
  base_version_id: string | null;
  base_outline_revision: number | null;
  payload_json: string;
  payload_checksum: string;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  accepted_outline_snapshot_json: string | null;
  accepted_outline_revision: number | null;
}

interface UsageTotalsRow {
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  turn_count: number;
}

interface OutlineRow {
  project_id: string;
  revision: number;
  snapshot_json: string;
}

interface ConfirmedStoryFactAuthorityRow {
  readonly id: string;
  readonly project_id: string;
  readonly fact_type: string;
  readonly content_text: string | null;
  readonly value_json: string | null;
  readonly source_kind: string;
  readonly evidence_reference: string;
  readonly source_chapter_id: string | null;
  readonly source_version_id: string | null;
  readonly source_start_offset: number | null;
  readonly source_end_offset: number | null;
  readonly source_length: number | null;
  readonly source_excerpt: string | null;
  readonly effective_at: string | null;
  readonly invalidated_at: string | null;
  readonly branch_id: string | null;
  readonly confidence: number;
  readonly status: string;
  readonly origin: string;
  readonly user_confirmed: number;
  readonly locked: number;
  readonly deprecated: number;
  readonly needs_review: number;
  readonly revision: number;
}

interface StoryFactChapterEvidenceRow {
  readonly project_id: string;
  readonly chapter_id: string;
  readonly content: string;
  readonly content_checksum: string;
}

interface ReviewCausalEvidenceRow {
  readonly id: string;
  readonly excerpt: string;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly source_length: number;
  readonly content: string;
  readonly content_checksum: string;
}

type StrictMultiAgentCandidate =
  | {
      readonly kind: "chapter_content";
      readonly content: string;
    }
  | {
      readonly kind: "outline_patch";
      readonly changes: readonly {
        readonly nodeId: string;
        readonly expectedNodeRevision: number;
        readonly title: string | null;
        readonly synopsis: string | null;
      }[];
    };

interface StrictMultiAgentPublicResponse {
  readonly schemaVersion: 1;
  readonly publicMessage: string;
  readonly conclusions: readonly Record<string, unknown>[];
  readonly candidate: StrictMultiAgentCandidate | null;
  readonly needsInput: { readonly question: string } | null;
}

const SESSION_SELECT = `SELECT
  id, project_id, idempotency_key, request_fingerprint, restart_of_session_id,
  mode, target_kind, chapter_id, base_version_id, base_outline_revision,
  base_authority_checksum, user_request, status, revision, attempt,
  maximum_rounds, maximum_turns, maximum_input_tokens, maximum_output_tokens,
  maximum_cost_micros, maximum_duration_ms, currency,
  cancellation_requested, failure_code, started_at, deadline_at, completed_at,
  created_at, updated_at
FROM multi_agent_review_sessions`;

const PARTICIPANT_SELECT = `SELECT
  session_id, participant_id, ordinal, role, enabled, status, provider_id,
  provider_kind, endpoint_url, authentication, provider_profile_revision,
  model_id, model_revision, maximum_turns, context_window_tokens,
  input_micros_per_million_tokens, output_micros_per_million_tokens,
  cached_input_micros_per_million_tokens, pricing_version, price_updated_at,
  error_code, created_at, updated_at
FROM multi_agent_review_participants`;

const TURN_SELECT = `SELECT
  id, session_id, sequence, attempt, participant_id, idempotency_key,
  result_fingerprint, generation_id, run_revision_before, status,
  reservation_input_tokens, reservation_output_tokens, reservation_cost_micros,
  public_message, response_json, usage_source, input_tokens, output_tokens,
  cached_input_tokens, cost_micros, error_code, started_at, completed_at,
  created_at, updated_at
FROM multi_agent_review_turns`;

const CANDIDATE_SELECT = `SELECT
  id, session_id, project_id, target_kind, chapter_candidate_id,
  base_version_id, base_outline_revision, payload_json, payload_checksum,
  status, revision, created_at, updated_at, decided_at,
  accepted_outline_snapshot_json, accepted_outline_revision
FROM multi_agent_review_candidates`;

export class MultiAgentReviewSqliteStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public async createSession(
    inputValue: CreateMultiAgentReviewSessionInput,
  ): Promise<CreateMultiAgentReviewSessionReceipt> {
    const input = validateCreateInput(inputValue);
    const authoritativeFingerprint = await hashCreateInput(input);
    if (input.requestFingerprint !== authoritativeFingerprint) {
      throw storeError(
        "MULTI_AGENT_AUTHORITY_MISMATCH",
        "The review request fingerprint does not cover its complete authority.",
      );
    }
    const created = await this.executor.transaction(async (transaction) => {
      const existingRows = await transaction.select<SessionRow>(
        `${SESSION_SELECT}
         WHERE project_id = ? AND idempotency_key = ?`,
        [input.projectId, input.idempotencyKey],
      );
      const existing = existingRows[0];
      if (existing !== undefined) {
        if (existing.request_fingerprint !== input.requestFingerprint || existing.id !== input.id) {
          throw storeError(
            "MULTI_AGENT_IDEMPOTENCY_CONFLICT",
            "The review idempotency key already belongs to another request.",
          );
        }
        return false;
      }

      await requireTargetAuthority(transaction, input);
      await requireRestartAuthority(transaction, input);
      const now = input.startedAt;
      await transaction.execute(
        `INSERT INTO multi_agent_review_sessions (
           id, project_id, idempotency_key, request_fingerprint,
           restart_of_session_id, mode, target_kind, chapter_id,
           base_version_id, base_outline_revision, base_authority_checksum,
           user_request, status, revision, attempt, maximum_rounds,
           maximum_turns, maximum_input_tokens, maximum_output_tokens,
           maximum_cost_micros, maximum_duration_ms, currency,
           cancellation_requested, failure_code, started_at, deadline_at,
           completed_at, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?,
           ?, ?, ?, 0, NULL, ?, ?, NULL, ?, ?
         )`,
        [
          input.id,
          input.projectId,
          input.idempotencyKey,
          input.requestFingerprint,
          input.restartOfSessionId,
          input.mode,
          input.target.kind,
          input.target.kind === "chapter" ? input.target.chapterId : null,
          input.target.kind === "chapter" ? input.target.baseVersionId : null,
          input.target.kind === "outline" ? input.target.baseOutlineRevision : null,
          input.target.baseAuthorityChecksum,
          input.userRequest,
          input.attempt,
          input.limits.maximumRounds,
          input.limits.maximumTurns,
          input.limits.maximumInputTokens,
          input.limits.maximumOutputTokens,
          input.limits.maximumCostMicros,
          input.limits.maximumDurationMs,
          input.limits.currency,
          input.startedAt,
          input.deadlineAt,
          now,
          now,
        ],
      );
      for (const participant of input.participants) {
        await transaction.execute(
          `INSERT INTO multi_agent_review_participants (
             session_id, participant_id, ordinal, role, enabled, status,
             provider_id, provider_kind, endpoint_url, authentication,
             provider_profile_revision, model_id, model_revision, maximum_turns,
             context_window_tokens, input_micros_per_million_tokens,
             output_micros_per_million_tokens,
             cached_input_micros_per_million_tokens, pricing_version,
             price_updated_at, error_code, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             NULL, ?, ?
           )`,
          [
            input.id,
            participant.participantId,
            participant.ordinal,
            participant.role,
            participant.enabled ? 1 : 0,
            participant.providerId,
            participant.providerKind,
            participant.endpointUrl,
            participant.authentication,
            participant.providerProfileRevision,
            participant.modelId,
            participant.modelRevision,
            participant.maximumTurns,
            participant.contextWindowTokens,
            participant.inputMicrosPerMillionTokens,
            participant.outputMicrosPerMillionTokens,
            participant.cachedInputMicrosPerMillionTokens,
            participant.pricingVersion,
            participant.priceUpdatedAt,
            now,
            now,
          ],
        );
      }
      return true;
    });
    const session = await this.requireSession(input.id);
    return Object.freeze({ session, created });
  }

  public async findSessionById(sessionIdValue: string): Promise<MultiAgentReviewSession | null> {
    const sessionId = requireIdentifier(sessionIdValue, "sessionId");
    return loadSession(this.executor, sessionId);
  }

  public async listProjectSessions(
    projectIdValue: string,
    limitValue = 50,
  ): Promise<readonly MultiAgentReviewSession[]> {
    const projectId = requireIdentifier(projectIdValue, "projectId");
    const limit = requireInteger(limitValue, 1, 100, "limit");
    const rows = await this.executor.select<{ id: string }>(
      `SELECT id
       FROM multi_agent_review_sessions
       WHERE project_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
      [projectId, limit],
    );
    const sessions: MultiAgentReviewSession[] = [];
    for (const row of rows) {
      const session = await loadSession(this.executor, row.id);
      if (session === null) {
        throw storeError("MULTI_AGENT_CORRUPT", "A review history row disappeared while reading.");
      }
      sessions.push(session);
    }
    return Object.freeze(sessions);
  }

  public async claimTurn(
    inputValue: ClaimMultiAgentReviewTurnInput,
  ): Promise<MultiAgentReviewSession> {
    const input = validateClaimInput(inputValue);
    await this.executor.transaction(async (transaction) => {
      const duplicateRows = await transaction.select<TurnRow>(
        `${TURN_SELECT}
         WHERE session_id = ? AND idempotency_key = ?`,
        [input.sessionId, input.idempotencyKey],
      );
      const duplicate = duplicateRows[0];
      if (duplicate !== undefined) {
        if (
          duplicate.id === input.turnId &&
          duplicate.generation_id === input.generationId &&
          duplicate.participant_id === input.participantId &&
          duplicate.reservation_input_tokens === input.reservation.maximumInputTokens &&
          duplicate.reservation_output_tokens === input.reservation.maximumOutputTokens &&
          duplicate.reservation_cost_micros === input.reservation.maximumCostMicros &&
          duplicate.started_at === input.startedAt &&
          duplicate.run_revision_before === input.expectedSessionRevision
        ) {
          return;
        }
        throw storeError(
          "MULTI_AGENT_IDEMPOTENCY_CONFLICT",
          "The turn idempotency key already belongs to another dispatch.",
        );
      }
      const session = await requireSessionRow(transaction, input.sessionId);
      requireSessionRevision(session, input.expectedSessionRevision);
      if (
        session.status !== "running" ||
        session.cancellation_requested !== 0 ||
        input.startedAt >= session.deadline_at
      ) {
        throw storeError(
          "MULTI_AGENT_ILLEGAL_STATE",
          "The review is not eligible to dispatch another turn.",
        );
      }

      const participants = await loadParticipantRows(transaction, input.sessionId);
      const usage = await loadUsageTotals(transaction, input.sessionId);
      const selected = await selectNextParticipant(
        transaction,
        participants,
        input.sessionId,
        usage.turn_count,
      );
      if (selected?.participant_id !== input.participantId) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "The requested participant is not the authoritative next reviewer.",
        );
      }
      if (
        input.reservation.maximumInputTokens + input.reservation.maximumOutputTokens >
        selected.context_window_tokens
      ) {
        throw storeError(
          "MULTI_AGENT_LIMIT_EXHAUSTED",
          "The turn reservation exceeds the selected model context window.",
        );
      }
      requireReservationWithinLimits(session, usage, input.reservation);
      const enabledCount = participants.filter(({ enabled }) => enabled === 1).length;
      const nextRound = Math.floor(usage.turn_count / enabledCount) + 1;
      if (usage.turn_count >= session.maximum_turns || nextRound > session.maximum_rounds) {
        throw storeError(
          "MULTI_AGENT_LIMIT_EXHAUSTED",
          "The review turn or round limit has been exhausted.",
        );
      }

      const nextSequence = usage.turn_count + 1;
      await transaction.execute(
        `INSERT INTO multi_agent_review_turns (
           id, session_id, sequence, attempt, participant_id, idempotency_key,
           result_fingerprint, generation_id, run_revision_before, status,
           reservation_input_tokens, reservation_output_tokens,
           reservation_cost_micros, public_message, response_json, usage_source,
           input_tokens, output_tokens, cached_input_tokens, cost_micros,
           error_code, started_at, completed_at, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'working', ?, ?, ?, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?
         )`,
        [
          input.turnId,
          input.sessionId,
          nextSequence,
          session.attempt,
          input.participantId,
          input.idempotencyKey,
          input.generationId,
          session.revision,
          input.reservation.maximumInputTokens,
          input.reservation.maximumOutputTokens,
          input.reservation.maximumCostMicros,
          input.startedAt,
          input.startedAt,
          input.startedAt,
        ],
      );
      await updateSessionRevision(transaction, session, {
        status: "running",
        updatedAt: input.startedAt,
      });
      await transaction.execute(
        `UPDATE multi_agent_review_participants
         SET status = 'working', error_code = NULL, updated_at = ?
         WHERE session_id = ? AND participant_id = ?`,
        [input.startedAt, input.sessionId, input.participantId],
      );
    });
    return this.requireSession(input.sessionId);
  }

  public async completeTurn(
    inputValue: CompleteMultiAgentReviewTurnInput,
  ): Promise<MultiAgentReviewSession> {
    const input = validateCompleteInput(inputValue);
    const authoritativeFingerprint = await hashCompletionInput(input);
    if (input.resultFingerprint !== authoritativeFingerprint) {
      throw storeError(
        "MULTI_AGENT_AUTHORITY_MISMATCH",
        "The turn result fingerprint does not cover its complete public receipt.",
      );
    }
    await this.executor.transaction(async (transaction) => {
      const session = await requireSessionRow(transaction, input.sessionId);
      const turn = await requireTurnRow(transaction, input.sessionId, input.turnId);
      if (turn.status !== "working") {
        if (
          (turn.status === "completed" || turn.status === "needs_input") &&
          turn.result_fingerprint === input.resultFingerprint
        ) {
          return;
        }
        throw storeError(
          "MULTI_AGENT_IDEMPOTENCY_CONFLICT",
          "The turn has already completed with a different result.",
        );
      }
      requireSessionRevision(session, input.expectedSessionRevision);
      if (session.status !== "running" || input.completedAt > session.deadline_at) {
        throw storeError(
          "MULTI_AGENT_LIMIT_EXHAUSTED",
          "The review duration expired before the turn could be committed.",
        );
      }
      const participant = await requireParticipantRow(
        transaction,
        input.sessionId,
        turn.participant_id,
      );
      const costMicros = calculateProviderCostMicros(participant, input.usage);
      requireTurnUsageWithinReservation(turn, input.usage, costMicros);
      const totals = await loadUsageTotals(transaction, input.sessionId);
      requireReportedUsageWithinLimits(session, totals, input.usage, costMicros);
      const publicResponse = validatePublicResponseProjection(
        input.serializedResponse,
        input.publicMessage,
        input.needsInput,
        input.conclusions,
      );
      const expectedCandidateKind =
        session.target_kind === "chapter" ? "chapter_content" : "outline_patch";
      if (
        publicResponse.candidate !== null &&
        publicResponse.candidate.kind !== expectedCandidateKind
      ) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "The public candidate does not match the authoritative review target.",
        );
      }
      if (input.completedAt < turn.started_at) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "A turn cannot complete before its authoritative start time.",
        );
      }

      const terminalStatus = input.needsInput ? "needs_input" : "completed";
      const updated = await transaction.execute(
        `UPDATE multi_agent_review_turns
         SET
           result_fingerprint = ?, status = ?, public_message = ?,
           response_json = ?, usage_source = 'provider_reported',
           input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
           cost_micros = ?, error_code = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'working'`,
        [
          input.resultFingerprint,
          terminalStatus,
          input.publicMessage,
          input.serializedResponse,
          input.usage.inputTokens,
          input.usage.outputTokens,
          input.usage.cachedInputTokens,
          costMicros,
          input.completedAt,
          input.completedAt,
          input.turnId,
          input.sessionId,
        ],
      );
      if (updated.rowsAffected !== 1) {
        throw storeError(
          "MULTI_AGENT_REVISION_CONFLICT",
          "The review turn changed before its result could be committed.",
          true,
        );
      }
      await persistConclusions(transaction, input, input.completedAt);
      await updateSessionRevision(transaction, session, {
        status: input.needsInput ? "needs_input" : "running",
        updatedAt: input.completedAt,
      });
      await transaction.execute(
        `UPDATE multi_agent_review_participants
         SET status = ?, error_code = NULL, updated_at = ?
         WHERE session_id = ? AND participant_id = ?`,
        [
          input.needsInput ? "needs_input" : "done",
          input.completedAt,
          input.sessionId,
          turn.participant_id,
        ],
      );
    });
    return this.requireSession(input.sessionId);
  }

  public async failTurn(
    inputValue: FailMultiAgentReviewTurnInput,
  ): Promise<MultiAgentReviewSession> {
    const input = validateFailInput(inputValue);
    const authoritativeFingerprint = await hashFailureInput(input);
    if (input.resultFingerprint !== null && input.resultFingerprint !== authoritativeFingerprint) {
      throw storeError(
        "MULTI_AGENT_AUTHORITY_MISMATCH",
        "The failed turn fingerprint does not match its complete receipt.",
      );
    }
    await this.executor.transaction(async (transaction) => {
      const session = await requireSessionRow(transaction, input.sessionId);
      const turn = await requireTurnRow(transaction, input.sessionId, input.turnId);
      if (turn.status !== "working") {
        if (
          turn.status === input.outcome &&
          turn.error_code === input.errorCode &&
          turn.result_fingerprint === authoritativeFingerprint &&
          turn.completed_at === input.completedAt &&
          samePersistedUsage(turn, input.usage)
        ) {
          return;
        }
        throw storeError(
          "MULTI_AGENT_IDEMPOTENCY_CONFLICT",
          "The review turn already has a different terminal result.",
        );
      }
      requireSessionRevision(session, input.expectedSessionRevision);
      if (input.completedAt < turn.started_at || input.completedAt < session.updated_at) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "A failed turn cannot complete before its authoritative start time.",
        );
      }
      const participant = await requireParticipantRow(
        transaction,
        input.sessionId,
        turn.participant_id,
      );
      const costMicros =
        input.usage === null ? null : calculateProviderCostMicros(participant, input.usage);
      await transaction.execute(
        `UPDATE multi_agent_review_turns
         SET
           result_fingerprint = ?, status = ?, usage_source = ?,
           input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
           cost_micros = ?, error_code = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'working'`,
        [
          authoritativeFingerprint,
          input.outcome,
          input.usage === null ? "provider_unavailable" : "provider_reported",
          input.usage?.inputTokens ?? null,
          input.usage?.outputTokens ?? null,
          input.usage?.cachedInputTokens ?? null,
          costMicros,
          input.errorCode,
          input.completedAt,
          input.completedAt,
          input.turnId,
          input.sessionId,
        ],
      );
      const sessionStatus = input.outcome === "cancelled" ? "cancelled" : "failed";
      await updateSessionRevision(transaction, session, {
        status: sessionStatus,
        updatedAt: input.completedAt,
        completedAt: input.completedAt,
        failureCode: input.outcome === "failed" ? input.errorCode : null,
        cancellationRequested: input.outcome === "cancelled",
      });
      await transaction.execute(
        `UPDATE multi_agent_review_participants
         SET status = ?, error_code = ?, updated_at = ?
         WHERE session_id = ? AND participant_id = ?`,
        [
          input.outcome === "cancelled" ? "cancelled" : "error",
          input.outcome === "cancelled" ? null : input.errorCode,
          input.completedAt,
          input.sessionId,
          turn.participant_id,
        ],
      );
    });
    return this.requireSession(input.sessionId);
  }

  public async cancelSession(
    sessionIdValue: string,
    expectedRevisionValue: number,
    cancelledAtValue: string = this.clock.now(),
  ): Promise<MultiAgentReviewSession> {
    const sessionId = requireIdentifier(sessionIdValue, "sessionId");
    const expectedRevision = requireInteger(
      expectedRevisionValue,
      1,
      Number.MAX_SAFE_INTEGER,
      "expectedRevision",
    );
    const cancelledAt = requireTimestamp(cancelledAtValue, "cancelledAt");
    await this.executor.transaction(async (transaction) => {
      const session = await requireSessionRow(transaction, sessionId);
      if (session.status === "cancelled") {
        return;
      }
      requireSessionRevision(session, expectedRevision);
      if (session.status !== "running") {
        throw storeError("MULTI_AGENT_ILLEGAL_STATE", "Only a running review can be cancelled.");
      }
      await transaction.execute(
        `UPDATE multi_agent_review_turns
         SET
           status = 'cancelled', usage_source = 'provider_unavailable',
           error_code = 'AGENT_CANCELLED', completed_at = ?, updated_at = ?
         WHERE session_id = ? AND status = 'working'`,
        [cancelledAt, cancelledAt, sessionId],
      );
      await transaction.execute(
        `UPDATE multi_agent_review_participants
         SET status = 'cancelled', error_code = NULL, updated_at = ?
         WHERE session_id = ? AND status = 'working'`,
        [cancelledAt, sessionId],
      );
      await updateSessionRevision(transaction, session, {
        status: "cancelled",
        updatedAt: cancelledAt,
        completedAt: cancelledAt,
        cancellationRequested: true,
      });
    });
    return this.requireSession(sessionId);
  }

  public async failSession(
    sessionIdValue: string,
    expectedRevisionValue: number,
    errorCodeValue: string,
    failedAtValue: string = this.clock.now(),
  ): Promise<MultiAgentReviewSession> {
    const sessionId = requireIdentifier(sessionIdValue, "sessionId");
    const expectedRevision = requireInteger(
      expectedRevisionValue,
      1,
      Number.MAX_SAFE_INTEGER,
      "expectedRevision",
    );
    const errorCode = requireErrorCode(errorCodeValue, "failure.errorCode");
    const failedAt = requireTimestamp(failedAtValue, "failedAt");
    await this.executor.transaction(async (transaction) => {
      const session = await requireSessionRow(transaction, sessionId);
      if (
        session.status === "failed" &&
        session.failure_code === errorCode &&
        session.revision === expectedRevision + 1 &&
        session.completed_at === failedAt &&
        session.updated_at === failedAt
      ) {
        return;
      }
      requireSessionRevision(session, expectedRevision);
      if (
        session.status !== "running" ||
        failedAt < session.updated_at ||
        failedAt < session.started_at
      ) {
        throw storeError(
          "MULTI_AGENT_ILLEGAL_STATE",
          "The review cannot be failed in its current state or timestamp order.",
        );
      }
      const workingRows = await transaction.select<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM multi_agent_review_turns
         WHERE session_id = ? AND status = 'working'`,
        [sessionId],
      );
      if (workingRows[0]?.count !== 0) {
        throw storeError(
          "MULTI_AGENT_ILLEGAL_STATE",
          "A working turn must be completed or failed before the review is failed.",
        );
      }
      await updateSessionRevision(transaction, session, {
        status: "failed",
        updatedAt: failedAt,
        completedAt: failedAt,
        failureCode: errorCode,
      });
    });
    return this.requireSession(sessionId);
  }

  public async recoverInterruptedSessions(
    recoveredAtValue: string = this.clock.now(),
    limitValue = 100,
  ): Promise<number> {
    const recoveredAt = requireTimestamp(recoveredAtValue, "recoveredAt");
    const limit = requireInteger(limitValue, 1, 100, "limit");
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<{
        id: string;
        revision: number;
        maximum_turns: number;
      }>(
        `SELECT id, revision, maximum_turns
         FROM multi_agent_review_sessions
         WHERE status = 'running'
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
        [limit * 10],
      );
      let recovered = 0;
      for (const row of rows) {
        if (recovered >= limit) {
          break;
        }
        const finalRows = await transaction.select<{
          sequence: number;
          status: string;
          response_json: string | null;
        }>(
          `SELECT sequence, status, response_json
           FROM multi_agent_review_turns
           WHERE session_id = ?
           ORDER BY sequence DESC
           LIMIT 1`,
          [row.id],
        );
        if (isPendingCandidatePublication(finalRows[0], row.maximum_turns)) {
          continue;
        }
        if (row.revision >= Number.MAX_SAFE_INTEGER) {
          throw storeError(
            "MULTI_AGENT_LIMIT_EXHAUSTED",
            "A review revision authority is exhausted and cannot be recovered.",
          );
        }
        await transaction.execute(
          `UPDATE multi_agent_review_turns
           SET
             status = 'failed', usage_source = 'provider_unavailable',
             error_code = 'APP_RESTARTED', completed_at = ?, updated_at = ?
           WHERE session_id = ? AND status = 'working'`,
          [recoveredAt, recoveredAt, row.id],
        );
        await transaction.execute(
          `UPDATE multi_agent_review_participants
           SET status = 'paused', error_code = NULL, updated_at = ?
           WHERE session_id = ? AND enabled = 1`,
          [recoveredAt, row.id],
        );
        const changed = await transaction.execute(
          `UPDATE multi_agent_review_sessions
           SET status = 'paused', revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND status = 'running'`,
          [recoveredAt, row.id, row.revision],
        );
        if (changed.rowsAffected !== 1) {
          throw storeError(
            "MULTI_AGENT_REVISION_CONFLICT",
            "A review changed while interrupted sessions were recovered.",
            true,
          );
        }
        recovered += 1;
      }
      return recovered;
    });
  }

  public async listPendingCandidatePublicationSessions(
    limitValue = 100,
  ): Promise<readonly MultiAgentReviewSession[]> {
    const limit = requireInteger(limitValue, 1, 100, "limit");
    const rows = await this.executor.select<{ id: string }>(
      `SELECT session.id
       FROM multi_agent_review_sessions AS session
       JOIN multi_agent_review_turns AS final_turn
         ON final_turn.session_id = session.id
        AND final_turn.sequence = session.maximum_turns
       WHERE session.status = 'running'
         AND final_turn.status = 'completed'
         AND final_turn.response_json IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM multi_agent_review_turns AS working
           WHERE working.session_id = session.id
             AND working.status = 'working'
         )
       ORDER BY session.updated_at ASC, session.id ASC
       LIMIT ?`,
      [limit],
    );
    const sessions: MultiAgentReviewSession[] = [];
    for (const row of rows) {
      const session = await this.requireSession(row.id);
      const finalTurn = session.turns.at(-1);
      if (
        finalTurn?.sequence !== session.limits.maximumTurns ||
        finalTurn.status !== "completed" ||
        finalTurn.responseJson === null ||
        parseStrictPublicResponse(finalTurn.responseJson).candidate === null
      ) {
        throw storeError(
          "MULTI_AGENT_CORRUPT",
          "A pending candidate publication receipt is inconsistent.",
        );
      }
      sessions.push(session);
    }
    return Object.freeze(sessions);
  }

  public async publishCandidate(
    inputValue: PublishMultiAgentReviewCandidateInput,
  ): Promise<MultiAgentReviewCandidate> {
    const input = validatePublishInput(inputValue);
    if ((await sha256Hex(input.payloadJson)) !== input.payloadChecksum) {
      throw storeError(
        "MULTI_AGENT_AUTHORITY_MISMATCH",
        "The review candidate payload checksum is invalid.",
      );
    }
    const authoritativePayload = parseJsonObject(input.payloadJson, "publication payload");
    if (authoritativePayload.kind === "chapter_content") {
      const content = requireText(
        authoritativePayload.content,
        1,
        750_000,
        "publication.chapterContent",
      );
      if (
        input.chapterContentChecksum === null ||
        (await sha256Hex(content)) !== input.chapterContentChecksum
      ) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "The isolated chapter candidate checksum is invalid.",
        );
      }
    }
    await this.executor.transaction(async (transaction) => {
      const session = await requireSessionRow(transaction, input.sessionId);
      const existingRows = await transaction.select<CandidateRow>(
        `${CANDIDATE_SELECT} WHERE session_id = ?`,
        [input.sessionId],
      );
      const existing = existingRows[0];
      if (existing !== undefined) {
        if (await candidateReplayMatches(transaction, existing, input)) {
          return;
        }
        throw storeError(
          "MULTI_AGENT_IDEMPOTENCY_CONFLICT",
          "The review has already published a different candidate.",
        );
      }
      requireSessionRevision(session, input.expectedSessionRevision);
      if (
        session.status !== "running" ||
        input.publishedAt > session.deadline_at ||
        session.cancellation_requested !== 0
      ) {
        throw storeError(
          "MULTI_AGENT_ILLEGAL_STATE",
          "The review cannot publish a candidate in its current state.",
        );
      }
      const turns = await transaction.select<TurnRow>(
        `${TURN_SELECT}
         WHERE session_id = ?
         ORDER BY sequence ASC`,
        [input.sessionId],
      );
      if (
        turns.length === 0 ||
        turns.some((turn) => turn.status !== "completed") ||
        turns.some((turn) => turn.usage_source !== "provider_reported")
      ) {
        throw storeError(
          "MULTI_AGENT_USAGE_UNAVAILABLE",
          "Only completed turns with provider usage receipts can publish a candidate.",
        );
      }
      requireCandidateMatchesPublicTurn(session, turns, input.payloadJson);
      const finalTurn = turns.at(-1);
      if (
        finalTurn?.completed_at === null ||
        finalTurn?.completed_at === undefined ||
        input.publishedAt < finalTurn.completed_at
      ) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "A candidate cannot be published before the final public turn.",
        );
      }

      if (session.target_kind === "chapter") {
        if (input.chapterCandidateId === null || input.chapterContentChecksum === null) {
          throw storeError(
            "MULTI_AGENT_INVALID_INPUT",
            "A chapter review requires an isolated chapter candidate receipt.",
          );
        }
        const payload = parseJsonObject(input.payloadJson, "candidate payload");
        const content = requireText(payload.content, 1, 750_000, "candidate.content");
        await transaction.execute(
          `INSERT INTO ai_candidates (
             id, project_id, chapter_id, source, base_version_id, content,
             content_checksum, status, revision, incomplete, created_at, updated_at,
             decided_at, task_intent, application_mode, payload_kind,
             anchor_start_utf16, anchor_end_utf16
           ) VALUES (
             ?, ?, ?, 'agent', ?, ?, ?, 'ready', 1, 0, ?, ?, NULL,
             'whole_chapter_rewrite', 'replace_document', 'full_document', NULL, NULL
           )`,
          [
            input.chapterCandidateId,
            session.project_id,
            session.chapter_id,
            session.base_version_id,
            content,
            input.chapterContentChecksum,
            input.publishedAt,
            input.publishedAt,
          ],
        );
      } else if (input.chapterCandidateId !== null || input.chapterContentChecksum !== null) {
        throw storeError(
          "MULTI_AGENT_INVALID_INPUT",
          "An outline review cannot create a chapter candidate.",
        );
      }

      await transaction.execute(
        `INSERT INTO multi_agent_review_candidates (
           id, session_id, project_id, target_kind, chapter_candidate_id,
           base_version_id, base_outline_revision, payload_json,
           payload_checksum, status, revision, created_at, updated_at, decided_at,
           accepted_outline_snapshot_json, accepted_outline_revision
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, ?, ?, NULL, NULL, NULL
         )`,
        [
          input.candidateId,
          input.sessionId,
          session.project_id,
          session.target_kind,
          input.chapterCandidateId,
          session.base_version_id,
          session.base_outline_revision,
          input.payloadJson,
          input.payloadChecksum,
          input.publishedAt,
          input.publishedAt,
        ],
      );
      await updateSessionRevision(transaction, session, {
        status: "candidate_ready",
        updatedAt: input.publishedAt,
        completedAt: input.publishedAt,
      });
      await insertAuditEvent(transaction, {
        id: input.auditEventId,
        projectId: session.project_id,
        entityType: "multi_agent_review",
        entityId: session.id,
        action: "candidate_ready",
        requestId: session.idempotency_key,
        metadata: {
          candidateId: input.candidateId,
          targetKind: session.target_kind,
          chapterCandidateId: input.chapterCandidateId,
        },
        createdAt: input.publishedAt,
      });
    });
    const session = await this.requireSession(input.sessionId);
    if (session.candidate === null) {
      throw storeError("MULTI_AGENT_CORRUPT", "The published candidate receipt is missing.");
    }
    return session.candidate;
  }

  public async acceptOutlineCandidate(
    candidateIdValue: string,
    expectedCandidateRevisionValue: number,
    auditEventIdValue: string,
    acceptedAtValue: string = this.clock.now(),
  ): Promise<AcceptOutlineReviewCandidateReceipt> {
    const candidateId = requireIdentifier(candidateIdValue, "candidateId");
    const expectedCandidateRevision = requireInteger(
      expectedCandidateRevisionValue,
      1,
      Number.MAX_SAFE_INTEGER,
      "expectedCandidateRevision",
    );
    const auditEventId = requireIdentifier(auditEventIdValue, "auditEventId");
    const acceptedAt = requireTimestamp(acceptedAtValue, "acceptedAt");
    const result = await this.executor.transaction(async (transaction) => {
      const candidateRows = await transaction.select<CandidateRow>(
        `${CANDIDATE_SELECT} WHERE id = ?`,
        [candidateId],
      );
      const candidate = candidateRows[0];
      if (candidate === undefined) {
        throw storeError("MULTI_AGENT_NOT_FOUND", "The review candidate does not exist.");
      }
      if (
        candidate.status === "accepted" &&
        candidate.target_kind === "outline" &&
        candidate.revision === expectedCandidateRevision + 1 &&
        candidate.accepted_outline_snapshot_json !== null &&
        candidate.accepted_outline_revision !== null &&
        candidate.updated_at === acceptedAt &&
        (await auditEventMatches(
          transaction,
          auditEventId,
          candidate.project_id,
          "multi_agent_review_candidate",
          candidateId,
          "outline_candidate_accepted",
        ))
      ) {
        return {
          snapshotJson: candidate.accepted_outline_snapshot_json,
          revision: candidate.accepted_outline_revision,
        };
      }
      if (candidate.status !== "ready" || candidate.target_kind !== "outline") {
        throw storeError(
          "MULTI_AGENT_ILLEGAL_STATE",
          "Only a ready outline candidate can be accepted.",
        );
      }
      if (candidate.revision !== expectedCandidateRevision) {
        throw revisionConflict(expectedCandidateRevision, candidate.revision);
      }
      if (candidate.revision >= Number.MAX_SAFE_INTEGER) {
        throw storeError(
          "MULTI_AGENT_LIMIT_EXHAUSTED",
          "The candidate revision authority is exhausted.",
        );
      }
      const outlineRows = await transaction.select<OutlineRow>(
        `SELECT project_id, revision, snapshot_json
         FROM story_outlines
         WHERE project_id = ?`,
        [candidate.project_id],
      );
      const outline = outlineRows[0];
      const session = await requireSessionRow(transaction, candidate.session_id);
      if (
        outline?.revision !== candidate.base_outline_revision ||
        (await sha256Hex(outline.snapshot_json)) !== session.base_authority_checksum ||
        acceptedAt < candidate.created_at
      ) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "The formal outline changed after this candidate was created.",
        );
      }
      const applied = applyOutlinePatch(
        outline.snapshot_json,
        candidate.payload_json,
        candidate.project_id,
        acceptedAt,
      );
      const outlineUpdated = await transaction.execute(
        `UPDATE story_outlines
         SET revision = ?, snapshot_json = ?
         WHERE project_id = ? AND revision = ?`,
        [applied.revision, applied.snapshotJson, candidate.project_id, outline.revision],
      );
      if (outlineUpdated.rowsAffected !== 1) {
        throw storeError(
          "MULTI_AGENT_REVISION_CONFLICT",
          "The formal outline changed while the candidate was accepted.",
          true,
        );
      }
      const candidateUpdated = await transaction.execute(
        `UPDATE multi_agent_review_candidates
         SET status = 'accepted', revision = revision + 1,
             updated_at = ?, decided_at = ?,
             accepted_outline_snapshot_json = ?,
             accepted_outline_revision = ?
         WHERE id = ? AND revision = ? AND status = 'ready'`,
        [
          acceptedAt,
          acceptedAt,
          applied.snapshotJson,
          applied.revision,
          candidateId,
          expectedCandidateRevision,
        ],
      );
      if (candidateUpdated.rowsAffected !== 1) {
        throw storeError(
          "MULTI_AGENT_REVISION_CONFLICT",
          "The outline candidate changed while it was accepted.",
          true,
        );
      }
      await insertAuditEvent(transaction, {
        id: auditEventId,
        projectId: candidate.project_id,
        entityType: "multi_agent_review_candidate",
        entityId: candidateId,
        action: "outline_candidate_accepted",
        requestId: candidate.session_id,
        metadata: {
          baselineRevision: outline.revision,
          resultingRevision: applied.revision,
        },
        createdAt: acceptedAt,
      });
      return applied;
    });
    const candidate = await this.requireCandidate(candidateId);
    return Object.freeze({
      candidate,
      outlineSnapshotJson: result.snapshotJson,
      outlineRevision: result.revision,
    });
  }

  public rejectCandidate(
    candidateId: string,
    expectedCandidateRevision: number,
    auditEventId: string,
    rejectedAt: string = this.clock.now(),
  ): Promise<MultiAgentReviewCandidate> {
    return this.decideCandidate(
      candidateId,
      expectedCandidateRevision,
      auditEventId,
      "rejected",
      rejectedAt,
    );
  }

  public expireCandidate(
    candidateId: string,
    expectedCandidateRevision: number,
    auditEventId: string,
    expiredAt: string = this.clock.now(),
  ): Promise<MultiAgentReviewCandidate> {
    return this.decideCandidate(
      candidateId,
      expectedCandidateRevision,
      auditEventId,
      "expired",
      expiredAt,
    );
  }

  public exportSessionHistory(session: MultiAgentReviewSession): string {
    return JSON.stringify({
      schemaVersion: 1,
      exportedAt: this.clock.now(),
      session,
    });
  }

  private async requireSession(sessionId: string): Promise<MultiAgentReviewSession> {
    const session = await loadSession(this.executor, sessionId);
    if (session === null) {
      throw storeError("MULTI_AGENT_NOT_FOUND", "The review session does not exist.");
    }
    return session;
  }

  private async requireCandidate(candidateId: string): Promise<MultiAgentReviewCandidate> {
    const rows = await this.executor.select<CandidateRow>(`${CANDIDATE_SELECT} WHERE id = ?`, [
      candidateId,
    ]);
    if (rows[0] === undefined) {
      throw storeError("MULTI_AGENT_NOT_FOUND", "The review candidate does not exist.");
    }
    return hydrateCandidate(rows[0]);
  }

  private async decideCandidate(
    candidateIdValue: string,
    expectedCandidateRevisionValue: number,
    auditEventIdValue: string,
    decision: "rejected" | "expired",
    decidedAtValue: string,
  ): Promise<MultiAgentReviewCandidate> {
    const candidateId = requireIdentifier(candidateIdValue, "candidateId");
    const expectedCandidateRevision = requireInteger(
      expectedCandidateRevisionValue,
      1,
      Number.MAX_SAFE_INTEGER,
      "expectedCandidateRevision",
    );
    const auditEventId = requireIdentifier(auditEventIdValue, "auditEventId");
    const decidedAt = requireTimestamp(decidedAtValue, "candidate.decidedAt");
    const action = decision === "rejected" ? "candidate_rejected" : "candidate_expired";
    await this.executor.transaction(async (transaction) => {
      const candidateRows = await transaction.select<CandidateRow>(
        `${CANDIDATE_SELECT} WHERE id = ?`,
        [candidateId],
      );
      const candidate = candidateRows[0];
      if (candidate === undefined) {
        throw storeError("MULTI_AGENT_NOT_FOUND", "The review candidate does not exist.");
      }
      if (
        candidate.status === decision &&
        candidate.revision === expectedCandidateRevision + 1 &&
        candidate.updated_at === decidedAt &&
        candidate.decided_at === decidedAt &&
        (await auditEventReceiptMatches(transaction, {
          id: auditEventId,
          projectId: candidate.project_id,
          entityId: candidateId,
          action,
          requestId: candidate.session_id,
          createdAt: decidedAt,
        }))
      ) {
        return;
      }
      if (candidate.status !== "ready") {
        throw storeError(
          "MULTI_AGENT_ILLEGAL_STATE",
          "Only a ready review candidate can be rejected or expired.",
        );
      }
      if (candidate.revision !== expectedCandidateRevision) {
        throw revisionConflict(expectedCandidateRevision, candidate.revision);
      }
      if (candidate.revision >= Number.MAX_SAFE_INTEGER) {
        throw storeError(
          "MULTI_AGENT_LIMIT_EXHAUSTED",
          "The candidate revision authority is exhausted.",
        );
      }
      if (decidedAt < candidate.created_at) {
        throw storeError(
          "MULTI_AGENT_AUTHORITY_MISMATCH",
          "A candidate cannot be decided before it was published.",
        );
      }
      if (candidate.target_kind === "chapter") {
        const changed = await transaction.execute(
          `UPDATE ai_candidates
           SET status = ?, revision = revision + 1, updated_at = ?, decided_at = ?
           WHERE id = ? AND status = 'ready' AND revision = ?`,
          [
            decision,
            decidedAt,
            decidedAt,
            candidate.chapter_candidate_id,
            expectedCandidateRevision,
          ],
        );
        if (changed.rowsAffected !== 1) {
          throw storeError(
            "MULTI_AGENT_REVISION_CONFLICT",
            "The isolated chapter candidate changed before its decision was committed.",
            true,
          );
        }
        const projectedRows = await transaction.select<{
          revision: number;
          status: string;
          updated_at: string;
          decided_at: string | null;
        }>(
          `SELECT revision, status, updated_at, decided_at
           FROM multi_agent_review_candidates
           WHERE id = ?`,
          [candidateId],
        );
        const projected = projectedRows[0];
        if (
          projected?.revision !== candidate.revision + 1 ||
          projected.status !== decision ||
          projected.updated_at !== decidedAt ||
          projected.decided_at !== decidedAt
        ) {
          throw storeError(
            "MULTI_AGENT_CORRUPT",
            "The chapter candidate decision projection did not update atomically.",
          );
        }
      } else {
        const changed = await transaction.execute(
          `UPDATE multi_agent_review_candidates
           SET status = ?, revision = revision + 1,
               updated_at = ?, decided_at = ?
           WHERE id = ? AND revision = ? AND status = 'ready'`,
          [decision, decidedAt, decidedAt, candidateId, expectedCandidateRevision],
        );
        if (changed.rowsAffected !== 1) {
          throw storeError(
            "MULTI_AGENT_REVISION_CONFLICT",
            "The outline candidate changed before its decision was committed.",
            true,
          );
        }
      }
      await insertAuditEvent(transaction, {
        id: auditEventId,
        projectId: candidate.project_id,
        entityType: "multi_agent_review_candidate",
        entityId: candidateId,
        action,
        requestId: candidate.session_id,
        metadata: {
          targetKind: candidate.target_kind,
          chapterCandidateId: candidate.chapter_candidate_id,
        },
        createdAt: decidedAt,
      });
    });
    return this.requireCandidate(candidateId);
  }
}

async function loadSession(
  executor: TransactionExecutor,
  sessionId: string,
): Promise<MultiAgentReviewSession | null> {
  const rows = await executor.select<SessionRow>(`${SESSION_SELECT} WHERE id = ?`, [sessionId]);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const [participantRows, turnRows, conclusionRows, sourceReferenceRows, candidateRows] =
    await Promise.all([
      executor.select<ParticipantRow>(
        `${PARTICIPANT_SELECT}
         WHERE session_id = ?
         ORDER BY ordinal ASC, participant_id ASC`,
        [sessionId],
      ),
      executor.select<TurnRow>(
        `${TURN_SELECT}
         WHERE session_id = ?
         ORDER BY sequence ASC, id ASC`,
        [sessionId],
      ),
      executor.select<ConclusionRow>(
        `SELECT
           id, session_id, turn_id, ordinal, category, title, explanation,
           evidence_json, task_proposal_json, created_at
         FROM multi_agent_review_conclusions
         WHERE session_id = ?
         ORDER BY turn_id ASC, ordinal ASC, id ASC`,
        [sessionId],
      ),
      executor.select<SourceReferenceRow>(
        `SELECT
           source.conclusion_id, source.ordinal, source.kind, source.source_id,
           source.source_revision, source.source_version_id,
           source.source_checksum, source.model_label,
           source.authoritative_label, source.excerpt
         FROM multi_agent_review_source_references AS source
         JOIN multi_agent_review_conclusions AS conclusion
           ON conclusion.id = source.conclusion_id
         WHERE conclusion.session_id = ?
         ORDER BY source.conclusion_id ASC, source.ordinal ASC`,
        [sessionId],
      ),
      executor.select<CandidateRow>(`${CANDIDATE_SELECT} WHERE session_id = ?`, [sessionId]),
    ]);
  const referencesByConclusion = new Map<string, SourceReferenceRow[]>();
  for (const source of sourceReferenceRows) {
    const references = referencesByConclusion.get(source.conclusion_id) ?? [];
    references.push(source);
    referencesByConclusion.set(source.conclusion_id, references);
  }
  const conclusionsByTurn = new Map<string, MultiAgentReviewConclusion[]>();
  for (const conclusion of conclusionRows) {
    const conclusions = conclusionsByTurn.get(conclusion.turn_id) ?? [];
    conclusions.push(
      hydrateConclusion(conclusion, referencesByConclusion.get(conclusion.id) ?? []),
    );
    conclusionsByTurn.set(conclusion.turn_id, conclusions);
  }
  return hydrateSession({
    row,
    participants: participantRows.map(hydrateParticipant),
    turns: turnRows.map((turn) => hydrateTurn(turn, conclusionsByTurn.get(turn.id) ?? [])),
    candidate: candidateRows[0] === undefined ? null : hydrateCandidate(candidateRows[0]),
  });
}

function hydrateSession(input: {
  readonly row: SessionRow;
  readonly participants: readonly MultiAgentReviewParticipantSnapshot[];
  readonly turns: readonly MultiAgentReviewTurn[];
  readonly candidate: MultiAgentReviewCandidate | null;
}): MultiAgentReviewSession {
  const row = input.row;
  const mode = requireEnum(row.mode, MULTI_AGENT_REVIEW_MODES, "session.mode");
  const targetKind = requireEnum(
    row.target_kind,
    ["chapter", "outline"] as const,
    "session.targetKind",
  );
  const status = requireEnum(
    row.status,
    ["idle", "running", "candidate_ready", "needs_input", "failed", "paused", "cancelled"] as const,
    "session.status",
  );
  const participants = Object.freeze([...input.participants]);
  const turns = Object.freeze([...input.turns]);
  if (
    participants.length < 1 ||
    participants.length > 16 ||
    participants.filter(({ enabled }) => enabled).length < 1 ||
    turns.length > row.maximum_turns ||
    turns.some((turn, index) => turn.sequence !== index + 1) ||
    (status === "candidate_ready") !== (input.candidate !== null) ||
    (input.candidate !== null &&
      (input.candidate.sessionId !== row.id ||
        input.candidate.projectId !== row.project_id ||
        input.candidate.targetKind !== targetKind))
  ) {
    throw storeError(
      "MULTI_AGENT_CORRUPT",
      "The persisted review aggregate is internally inconsistent.",
    );
  }
  return Object.freeze({
    id: requireIdentifier(row.id, "session.id"),
    projectId: requireIdentifier(row.project_id, "session.projectId"),
    idempotencyKey: requireIdentifier(row.idempotency_key, "session.idempotencyKey"),
    requestFingerprint: requireChecksum(row.request_fingerprint, "session.requestFingerprint"),
    restartOfSessionId:
      row.restart_of_session_id === null
        ? null
        : requireIdentifier(row.restart_of_session_id, "session.restartOfSessionId"),
    mode,
    targetKind,
    chapterId:
      row.chapter_id === null ? null : requireIdentifier(row.chapter_id, "session.chapterId"),
    baseVersionId:
      row.base_version_id === null
        ? null
        : requireIdentifier(row.base_version_id, "session.baseVersionId"),
    baseOutlineRevision:
      row.base_outline_revision === null
        ? null
        : requireInteger(
            row.base_outline_revision,
            1,
            Number.MAX_SAFE_INTEGER,
            "session.baseOutlineRevision",
          ),
    baseAuthorityChecksum: requireChecksum(
      row.base_authority_checksum,
      "session.baseAuthorityChecksum",
    ),
    userRequest: requireText(row.user_request, 1, 40_000, "session.userRequest"),
    status,
    revision: requireInteger(row.revision, 1, Number.MAX_SAFE_INTEGER, "session.revision"),
    attempt: requireInteger(row.attempt, 1, 1_000, "session.attempt"),
    limits: Object.freeze({
      maximumRounds: requireInteger(row.maximum_rounds, 1, 16, "session.maximumRounds"),
      maximumTurns: requireInteger(row.maximum_turns, 1, 128, "session.maximumTurns"),
      maximumInputTokens: requireInteger(
        row.maximum_input_tokens,
        1,
        10_000_000,
        "session.maximumInputTokens",
      ),
      maximumOutputTokens: requireInteger(
        row.maximum_output_tokens,
        1,
        10_000_000,
        "session.maximumOutputTokens",
      ),
      maximumCostMicros: requireInteger(
        row.maximum_cost_micros,
        0,
        10_000_000_000,
        "session.maximumCostMicros",
      ),
      maximumDurationMs: requireInteger(
        row.maximum_duration_ms,
        1_000,
        86_400_000,
        "session.maximumDurationMs",
      ),
      currency: requireCurrency(row.currency),
    }),
    cancellationRequested: requireBooleanInteger(
      row.cancellation_requested,
      "session.cancellationRequested",
    ),
    failureCode:
      row.failure_code === null ? null : requireErrorCode(row.failure_code, "session.failureCode"),
    startedAt: requireTimestamp(row.started_at, "session.startedAt"),
    deadlineAt: requireTimestamp(row.deadline_at, "session.deadlineAt"),
    completedAt:
      row.completed_at === null ? null : requireTimestamp(row.completed_at, "session.completedAt"),
    createdAt: requireTimestamp(row.created_at, "session.createdAt"),
    updatedAt: requireTimestamp(row.updated_at, "session.updatedAt"),
    participants,
    turns,
    candidate: input.candidate,
  });
}

function hydrateParticipant(row: ParticipantRow): MultiAgentReviewParticipantSnapshot {
  return Object.freeze({
    participantId: requireIdentifier(row.participant_id, "participant.id"),
    ordinal: requireInteger(row.ordinal, 0, 15, "participant.ordinal"),
    role: requireEnum(row.role, MULTI_AGENT_REVIEW_ROLES, "participant.role"),
    enabled: requireBooleanInteger(row.enabled, "participant.enabled"),
    status: requireEnum(
      row.status,
      ["idle", "working", "done", "needs_input", "error", "paused", "cancelled"] as const,
      "participant.status",
    ),
    providerId: requireIdentifier(row.provider_id, "participant.providerId"),
    providerKind: requireEnum(
      row.provider_kind,
      ["open_ai_compatible", "ollama"] as const,
      "participant.providerKind",
    ),
    endpointUrl: requireEndpointUrl(row.endpoint_url),
    authentication: requireEnum(
      row.authentication,
      ["none", "bearer_keyring"] as const,
      "participant.authentication",
    ),
    providerProfileRevision: requireInteger(
      row.provider_profile_revision,
      1,
      Number.MAX_SAFE_INTEGER,
      "participant.providerProfileRevision",
    ),
    modelId: requireText(row.model_id, 1, 512, "participant.modelId"),
    modelRevision: requireText(row.model_revision, 1, 256, "participant.modelRevision"),
    maximumTurns: requireInteger(row.maximum_turns, 1, 128, "participant.maximumTurns"),
    contextWindowTokens: requireInteger(
      row.context_window_tokens,
      1,
      10_000_000,
      "participant.contextWindowTokens",
    ),
    inputMicrosPerMillionTokens: requireInteger(
      row.input_micros_per_million_tokens,
      0,
      1_000_000_000_000,
      "participant.inputPricing",
    ),
    outputMicrosPerMillionTokens: requireInteger(
      row.output_micros_per_million_tokens,
      0,
      1_000_000_000_000,
      "participant.outputPricing",
    ),
    cachedInputMicrosPerMillionTokens:
      row.cached_input_micros_per_million_tokens === null
        ? null
        : requireInteger(
            row.cached_input_micros_per_million_tokens,
            0,
            1_000_000_000_000,
            "participant.cachedInputPricing",
          ),
    pricingVersion: requireText(row.pricing_version, 1, 256, "participant.pricingVersion"),
    priceUpdatedAt: requireTimestamp(row.price_updated_at, "participant.priceUpdatedAt"),
    errorCode:
      row.error_code === null ? null : requireErrorCode(row.error_code, "participant.errorCode"),
    createdAt: requireTimestamp(row.created_at, "participant.createdAt"),
    updatedAt: requireTimestamp(row.updated_at, "participant.updatedAt"),
  });
}

function hydrateTurn(
  row: TurnRow,
  conclusions: readonly MultiAgentReviewConclusion[],
): MultiAgentReviewTurn {
  const status = requireEnum(
    row.status,
    ["working", "completed", "needs_input", "failed", "cancelled"] as const,
    "turn.status",
  );
  const usageSource =
    row.usage_source === null
      ? null
      : requireEnum(
          row.usage_source,
          ["provider_reported", "provider_unavailable"] as const,
          "turn.usageSource",
        );
  if (
    (status === "working" &&
      (row.completed_at !== null || usageSource !== null || conclusions.length !== 0)) ||
    ((status === "completed" || status === "needs_input") &&
      (row.public_message === null ||
        row.response_json === null ||
        usageSource !== "provider_reported" ||
        row.input_tokens === null ||
        row.output_tokens === null ||
        row.cost_micros === null))
  ) {
    throw storeError("MULTI_AGENT_CORRUPT", "A review turn receipt is inconsistent.");
  }
  return Object.freeze({
    id: requireIdentifier(row.id, "turn.id"),
    sequence: requireInteger(row.sequence, 1, 128, "turn.sequence"),
    attempt: requireInteger(row.attempt, 1, 1_000, "turn.attempt"),
    participantId: requireIdentifier(row.participant_id, "turn.participantId"),
    idempotencyKey: requireIdentifier(row.idempotency_key, "turn.idempotencyKey"),
    resultFingerprint:
      row.result_fingerprint === null
        ? null
        : requireChecksum(row.result_fingerprint, "turn.resultFingerprint"),
    generationId: requireIdentifier(row.generation_id, "turn.generationId"),
    runRevisionBefore: requireInteger(
      row.run_revision_before,
      1,
      Number.MAX_SAFE_INTEGER,
      "turn.runRevisionBefore",
    ),
    status,
    reservation: Object.freeze({
      maximumInputTokens: requireInteger(
        row.reservation_input_tokens,
        1,
        10_000_000,
        "turn.reservation.inputTokens",
      ),
      maximumOutputTokens: requireInteger(
        row.reservation_output_tokens,
        1,
        10_000_000,
        "turn.reservation.outputTokens",
      ),
      maximumCostMicros: requireInteger(
        row.reservation_cost_micros,
        0,
        10_000_000_000,
        "turn.reservation.costMicros",
      ),
    }),
    publicMessage:
      row.public_message === null
        ? null
        : requireText(row.public_message, 1, 40_000, "turn.publicMessage"),
    responseJson:
      row.response_json === null
        ? null
        : requireJsonObjectText(row.response_json, 1_000_000, "turn.responseJson"),
    usageSource,
    inputTokens: requireNullableInteger(row.input_tokens, 0, 10_000_000, "turn.inputTokens"),
    outputTokens: requireNullableInteger(row.output_tokens, 0, 10_000_000, "turn.outputTokens"),
    cachedInputTokens: requireNullableInteger(
      row.cached_input_tokens,
      0,
      10_000_000,
      "turn.cachedInputTokens",
    ),
    costMicros: requireNullableInteger(
      row.cost_micros,
      0,
      Number.MAX_SAFE_INTEGER,
      "turn.costMicros",
    ),
    errorCode: row.error_code === null ? null : requireErrorCode(row.error_code, "turn.errorCode"),
    startedAt: requireTimestamp(row.started_at, "turn.startedAt"),
    completedAt:
      row.completed_at === null ? null : requireTimestamp(row.completed_at, "turn.completedAt"),
    createdAt: requireTimestamp(row.created_at, "turn.createdAt"),
    updatedAt: requireTimestamp(row.updated_at, "turn.updatedAt"),
    conclusions: Object.freeze([...conclusions]),
  });
}

function hydrateConclusion(
  row: ConclusionRow,
  references: readonly SourceReferenceRow[],
): MultiAgentReviewConclusion {
  const evidenceValue = parseJson(row.evidence_json, "conclusion.evidence");
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 16) {
    throw storeError("MULTI_AGENT_CORRUPT", "Conclusion evidence is invalid.");
  }
  const evidence = evidenceValue.map((value) =>
    requireText(value, 1, 4_000, "conclusion.evidence item"),
  );
  const taskProposal =
    row.task_proposal_json === null
      ? null
      : hydrateTaskProposal(parseJsonObject(row.task_proposal_json, "task proposal"));
  const category = requireEnum(
    row.category,
    MULTI_AGENT_REVIEW_CONCLUSION_CATEGORIES,
    "conclusion.category",
  );
  if ((category === "convertible_task") !== (taskProposal !== null)) {
    throw storeError("MULTI_AGENT_CORRUPT", "Conclusion task projection is inconsistent.");
  }
  return Object.freeze({
    id: requireIdentifier(row.id, "conclusion.id"),
    ordinal: requireInteger(row.ordinal, 0, 63, "conclusion.ordinal"),
    category,
    title: requireText(row.title, 1, 240, "conclusion.title"),
    explanation: requireText(row.explanation, 1, 12_000, "conclusion.explanation"),
    evidence: Object.freeze(evidence),
    sourceReferences: Object.freeze(
      references.map((reference) =>
        Object.freeze({
          kind: requireEnum(
            reference.kind,
            ["chapter", "outline_node", "material", "project_rule", "turn"] as const,
            "sourceReference.kind",
          ),
          sourceId: requireIdentifier(reference.source_id, "sourceReference.sourceId"),
          sourceRevision: requireInteger(
            reference.source_revision,
            1,
            Number.MAX_SAFE_INTEGER,
            "sourceReference.sourceRevision",
          ),
          sourceVersionId:
            reference.source_version_id === null
              ? null
              : requireIdentifier(reference.source_version_id, "sourceReference.sourceVersionId"),
          sourceChecksum: requireChecksum(
            reference.source_checksum,
            "sourceReference.sourceChecksum",
          ),
          modelLabel: requireText(reference.model_label, 1, 240, "sourceReference.modelLabel"),
          authoritativeLabel: requireText(
            reference.authoritative_label,
            1,
            240,
            "sourceReference.authoritativeLabel",
          ),
          excerpt:
            reference.excerpt === null
              ? null
              : requireText(reference.excerpt, 1, 2_000, "sourceReference.excerpt"),
        }),
      ),
    ),
    taskProposal,
  });
}

function hydrateCandidate(row: CandidateRow): MultiAgentReviewCandidate {
  return Object.freeze({
    id: requireIdentifier(row.id, "candidate.id"),
    sessionId: requireIdentifier(row.session_id, "candidate.sessionId"),
    projectId: requireIdentifier(row.project_id, "candidate.projectId"),
    targetKind: requireEnum(
      row.target_kind,
      ["chapter", "outline"] as const,
      "candidate.targetKind",
    ),
    chapterCandidateId:
      row.chapter_candidate_id === null
        ? null
        : requireIdentifier(row.chapter_candidate_id, "candidate.chapterCandidateId"),
    baseVersionId:
      row.base_version_id === null
        ? null
        : requireIdentifier(row.base_version_id, "candidate.baseVersionId"),
    baseOutlineRevision: requireNullableInteger(
      row.base_outline_revision,
      1,
      Number.MAX_SAFE_INTEGER,
      "candidate.baseOutlineRevision",
    ),
    payloadJson: requireJsonObjectText(row.payload_json, 1_000_000, "candidate.payloadJson"),
    payloadChecksum: requireChecksum(row.payload_checksum, "candidate.payloadChecksum"),
    status: requireEnum(
      row.status,
      ["ready", "accepted", "rejected", "expired"] as const,
      "candidate.status",
    ),
    revision: requireInteger(row.revision, 1, Number.MAX_SAFE_INTEGER, "candidate.revision"),
    createdAt: requireTimestamp(row.created_at, "candidate.createdAt"),
    updatedAt: requireTimestamp(row.updated_at, "candidate.updatedAt"),
    decidedAt:
      row.decided_at === null ? null : requireTimestamp(row.decided_at, "candidate.decidedAt"),
    acceptedOutlineSnapshotJson:
      row.accepted_outline_snapshot_json === null
        ? null
        : requireJsonObjectText(
            row.accepted_outline_snapshot_json,
            5_000_000,
            "candidate.acceptedOutlineSnapshotJson",
          ),
    acceptedOutlineRevision: requireNullableInteger(
      row.accepted_outline_revision,
      1,
      Number.MAX_SAFE_INTEGER,
      "candidate.acceptedOutlineRevision",
    ),
  });
}

function validateCreateInput(input: CreateMultiAgentReviewSessionInput): Required<
  Omit<CreateMultiAgentReviewSessionInput, "restartOfSessionId" | "attempt">
> & {
  readonly restartOfSessionId: string | null;
  readonly attempt: number;
} {
  const id = requireIdentifier(input.id, "session.id");
  const projectId = requireIdentifier(input.projectId, "session.projectId");
  const idempotencyKey = requireIdentifier(input.idempotencyKey, "session.idempotencyKey");
  const requestFingerprint = requireChecksum(
    input.requestFingerprint,
    "session.requestFingerprint",
  );
  const restartOfSessionId =
    input.restartOfSessionId === undefined || input.restartOfSessionId === null
      ? null
      : requireIdentifier(input.restartOfSessionId, "session.restartOfSessionId");
  if (restartOfSessionId === id) {
    throw invalidInput("A review cannot restart itself.");
  }
  const mode = requireEnum(input.mode, MULTI_AGENT_REVIEW_MODES, "session.mode");
  const target =
    input.target.kind === "chapter"
      ? Object.freeze({
          kind: "chapter" as const,
          chapterId: requireIdentifier(input.target.chapterId, "target.chapterId"),
          baseVersionId: requireIdentifier(input.target.baseVersionId, "target.baseVersionId"),
          baseAuthorityChecksum: requireChecksum(
            input.target.baseAuthorityChecksum,
            "target.baseAuthorityChecksum",
          ),
        })
      : (input.target as { readonly kind?: unknown }).kind === "outline"
        ? Object.freeze({
            kind: "outline" as const,
            baseOutlineRevision: requireInteger(
              input.target.baseOutlineRevision,
              1,
              Number.MAX_SAFE_INTEGER,
              "target.baseOutlineRevision",
            ),
            baseAuthorityChecksum: requireChecksum(
              input.target.baseAuthorityChecksum,
              "target.baseAuthorityChecksum",
            ),
          })
        : (() => {
            throw invalidInput("The review target kind is invalid.");
          })();
  const limits = validateLimits(input.limits);
  const userRequest = requireText(input.userRequest, 1, 40_000, "session.userRequest");
  const attempt = requireInteger(input.attempt ?? 1, 1, 1_000, "session.attempt");
  const startedAt = requireTimestamp(input.startedAt, "session.startedAt");
  const deadlineAt = requireTimestamp(input.deadlineAt, "session.deadlineAt");
  if (
    deadlineAt <= startedAt ||
    Date.parse(deadlineAt) - Date.parse(startedAt) > limits.maximumDurationMs
  ) {
    throw invalidInput("The review deadline exceeds its duration authority.");
  }
  if (input.participants.length < 1 || input.participants.length > 16) {
    throw invalidInput("A review must contain between one and sixteen participants.");
  }
  const participantIds = new Set<string>();
  const ordinals = new Set<number>();
  const participants = input.participants.map((participant) => {
    const validated = validateParticipantInput(participant);
    if (participantIds.has(validated.participantId) || ordinals.has(validated.ordinal)) {
      throw invalidInput("Review participant identifiers and ordinals must be unique.");
    }
    participantIds.add(validated.participantId);
    ordinals.add(validated.ordinal);
    return validated;
  });
  const enabled = participants.filter(({ enabled: isEnabled }) => isEnabled);
  if (
    enabled.length < 1 ||
    limits.maximumTurns > enabled.length * limits.maximumRounds ||
    limits.maximumTurns >
      enabled.reduce((total, participant) => total + participant.maximumTurns, 0)
  ) {
    throw invalidInput("The review turn limit exceeds its enabled participant or round capacity.");
  }
  return Object.freeze({
    id,
    projectId,
    idempotencyKey,
    requestFingerprint,
    restartOfSessionId,
    mode,
    target,
    userRequest,
    attempt,
    limits,
    participants: Object.freeze(participants),
    startedAt,
    deadlineAt,
  });
}

function validateParticipantInput(
  participant: Omit<
    MultiAgentReviewParticipantSnapshot,
    "status" | "errorCode" | "createdAt" | "updatedAt"
  >,
): Omit<MultiAgentReviewParticipantSnapshot, "status" | "errorCode" | "createdAt" | "updatedAt"> {
  return Object.freeze({
    participantId: requireIdentifier(participant.participantId, "participant.id"),
    ordinal: requireInteger(participant.ordinal, 0, 15, "participant.ordinal"),
    role: requireEnum(participant.role, MULTI_AGENT_REVIEW_ROLES, "participant.role"),
    enabled: requireBoolean(participant.enabled, "participant.enabled"),
    providerId: requireIdentifier(participant.providerId, "participant.providerId"),
    providerKind: requireEnum(
      participant.providerKind,
      ["open_ai_compatible", "ollama"] as const,
      "participant.providerKind",
    ),
    endpointUrl: requireEndpointUrl(participant.endpointUrl),
    authentication: requireEnum(
      participant.authentication,
      ["none", "bearer_keyring"] as const,
      "participant.authentication",
    ),
    providerProfileRevision: requireInteger(
      participant.providerProfileRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      "participant.providerProfileRevision",
    ),
    modelId: requireText(participant.modelId, 1, 512, "participant.modelId"),
    modelRevision: requireText(participant.modelRevision, 1, 256, "participant.modelRevision"),
    maximumTurns: requireInteger(participant.maximumTurns, 1, 128, "participant.maximumTurns"),
    contextWindowTokens: requireInteger(
      participant.contextWindowTokens,
      1,
      10_000_000,
      "participant.contextWindowTokens",
    ),
    inputMicrosPerMillionTokens: requireInteger(
      participant.inputMicrosPerMillionTokens,
      0,
      1_000_000_000_000,
      "participant.inputPricing",
    ),
    outputMicrosPerMillionTokens: requireInteger(
      participant.outputMicrosPerMillionTokens,
      0,
      1_000_000_000_000,
      "participant.outputPricing",
    ),
    cachedInputMicrosPerMillionTokens:
      participant.cachedInputMicrosPerMillionTokens === null
        ? null
        : requireInteger(
            participant.cachedInputMicrosPerMillionTokens,
            0,
            1_000_000_000_000,
            "participant.cachedInputPricing",
          ),
    pricingVersion: requireText(participant.pricingVersion, 1, 256, "participant.pricingVersion"),
    priceUpdatedAt: requireTimestamp(participant.priceUpdatedAt, "participant.priceUpdatedAt"),
  });
}

function validateLimits(limits: MultiAgentReviewLimits): MultiAgentReviewLimits {
  return Object.freeze({
    maximumRounds: requireInteger(limits.maximumRounds, 1, 16, "limits.maximumRounds"),
    maximumTurns: requireInteger(limits.maximumTurns, 1, 128, "limits.maximumTurns"),
    maximumInputTokens: requireInteger(
      limits.maximumInputTokens,
      1,
      10_000_000,
      "limits.maximumInputTokens",
    ),
    maximumOutputTokens: requireInteger(
      limits.maximumOutputTokens,
      1,
      10_000_000,
      "limits.maximumOutputTokens",
    ),
    maximumCostMicros: requireInteger(
      limits.maximumCostMicros,
      0,
      10_000_000_000,
      "limits.maximumCostMicros",
    ),
    maximumDurationMs: requireInteger(
      limits.maximumDurationMs,
      1_000,
      86_400_000,
      "limits.maximumDurationMs",
    ),
    currency: requireCurrency(limits.currency),
  });
}

function validateClaimInput(input: ClaimMultiAgentReviewTurnInput): ClaimMultiAgentReviewTurnInput {
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "claim.sessionId"),
    expectedSessionRevision: requireInteger(
      input.expectedSessionRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      "claim.expectedSessionRevision",
    ),
    turnId: requireIdentifier(input.turnId, "claim.turnId"),
    participantId: requireIdentifier(input.participantId, "claim.participantId"),
    idempotencyKey: requireIdentifier(input.idempotencyKey, "claim.idempotencyKey"),
    generationId: requireIdentifier(input.generationId, "claim.generationId"),
    reservation: validateReservation(input.reservation),
    startedAt: requireTimestamp(input.startedAt, "claim.startedAt"),
  });
}

function validateCompleteInput(
  input: CompleteMultiAgentReviewTurnInput,
): CompleteMultiAgentReviewTurnInput {
  const serializedResponse = requireJsonObjectText(
    input.serializedResponse,
    1_000_000,
    "completion.serializedResponse",
  );
  const conclusions = input.conclusions.map((conclusion, ordinal) =>
    validateConclusionInput(conclusion, ordinal),
  );
  if (conclusions.length > 64) {
    throw invalidInput("A review turn cannot persist more than 64 conclusions.");
  }
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "completion.sessionId"),
    turnId: requireIdentifier(input.turnId, "completion.turnId"),
    expectedSessionRevision: requireInteger(
      input.expectedSessionRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      "completion.expectedSessionRevision",
    ),
    resultFingerprint: requireChecksum(input.resultFingerprint, "completion.resultFingerprint"),
    serializedResponse,
    publicMessage: requireText(input.publicMessage, 1, 40_000, "completion.publicMessage"),
    needsInput: requireBoolean(input.needsInput, "completion.needsInput"),
    usage: validateUsage(input.usage),
    conclusions: Object.freeze(conclusions),
    completedAt: requireTimestamp(input.completedAt, "completion.completedAt"),
  });
}

function validateFailInput(input: FailMultiAgentReviewTurnInput): Required<
  Omit<FailMultiAgentReviewTurnInput, "resultFingerprint" | "usage">
> & {
  readonly resultFingerprint: string | null;
  readonly usage: FailMultiAgentReviewTurnInput["usage"] extends infer Usage
    ? Exclude<Usage, undefined>
    : never;
} {
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "failure.sessionId"),
    turnId: requireIdentifier(input.turnId, "failure.turnId"),
    expectedSessionRevision: requireInteger(
      input.expectedSessionRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      "failure.expectedSessionRevision",
    ),
    outcome: requireEnum(input.outcome, ["failed", "cancelled"] as const, "failure.outcome"),
    errorCode: requireErrorCode(input.errorCode, "failure.errorCode"),
    resultFingerprint:
      input.resultFingerprint === undefined || input.resultFingerprint === null
        ? null
        : requireChecksum(input.resultFingerprint, "failure.resultFingerprint"),
    usage: input.usage === undefined || input.usage === null ? null : validateUsage(input.usage),
    completedAt: requireTimestamp(input.completedAt, "failure.completedAt"),
  });
}

function validatePublishInput(
  input: PublishMultiAgentReviewCandidateInput,
): PublishMultiAgentReviewCandidateInput {
  const payloadJson = requireJsonObjectText(
    input.payloadJson,
    1_000_000,
    "publication.payloadJson",
  );
  const payload = parseStrictCandidatePayload(
    parseJsonObject(payloadJson, "publication payload"),
    "publication payload",
  );
  const chapterCandidateId =
    input.chapterCandidateId === null
      ? null
      : requireIdentifier(input.chapterCandidateId, "publication.chapterCandidateId");
  const chapterContentChecksum =
    input.chapterContentChecksum === null
      ? null
      : requireChecksum(input.chapterContentChecksum, "publication.chapterContentChecksum");
  if (
    (payload.kind === "chapter_content" &&
      (chapterCandidateId === null || chapterContentChecksum === null)) ||
    (payload.kind === "outline_patch" &&
      (chapterCandidateId !== null || chapterContentChecksum !== null))
  ) {
    throw invalidInput(
      "A chapter candidate payload requires both isolated chapter candidate receipts.",
    );
  }
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, "publication.sessionId"),
    expectedSessionRevision: requireInteger(
      input.expectedSessionRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      "publication.expectedSessionRevision",
    ),
    candidateId: requireIdentifier(input.candidateId, "publication.candidateId"),
    chapterCandidateId,
    payloadJson,
    payloadChecksum: requireChecksum(input.payloadChecksum, "publication.payloadChecksum"),
    chapterContentChecksum,
    auditEventId: requireIdentifier(input.auditEventId, "publication.auditEventId"),
    publishedAt: requireTimestamp(input.publishedAt, "publication.publishedAt"),
  });
}

function validateReservation(
  reservation: ClaimMultiAgentReviewTurnInput["reservation"],
): ClaimMultiAgentReviewTurnInput["reservation"] {
  return Object.freeze({
    maximumInputTokens: requireInteger(
      reservation.maximumInputTokens,
      1,
      10_000_000,
      "reservation.maximumInputTokens",
    ),
    maximumOutputTokens: requireInteger(
      reservation.maximumOutputTokens,
      1,
      10_000_000,
      "reservation.maximumOutputTokens",
    ),
    maximumCostMicros: requireInteger(
      reservation.maximumCostMicros,
      0,
      10_000_000_000,
      "reservation.maximumCostMicros",
    ),
  });
}

function validateUsage(
  usage: NonNullable<FailMultiAgentReviewTurnInput["usage"]>,
): NonNullable<FailMultiAgentReviewTurnInput["usage"]> {
  const inputTokens = requireInteger(usage.inputTokens, 0, 10_000_000, "usage.inputTokens");
  const outputTokens = requireInteger(usage.outputTokens, 0, 10_000_000, "usage.outputTokens");
  const cachedInputTokens =
    usage.cachedInputTokens === null
      ? null
      : requireInteger(usage.cachedInputTokens, 0, inputTokens, "usage.cachedInputTokens");
  return Object.freeze({ inputTokens, outputTokens, cachedInputTokens });
}

function validateConclusionInput(
  conclusion: Omit<MultiAgentReviewConclusion, "ordinal">,
  ordinal: number,
): MultiAgentReviewConclusion {
  const category = requireEnum(
    conclusion.category,
    MULTI_AGENT_REVIEW_CONCLUSION_CATEGORIES,
    "conclusion.category",
  );
  if ((category === "convertible_task") !== (conclusion.taskProposal !== null)) {
    throw invalidInput("Conclusion task proposals must match the convertible-task category.");
  }
  if (conclusion.evidence.length > 16 || conclusion.sourceReferences.length > 32) {
    throw invalidInput("Conclusion evidence or source references exceed their bounds.");
  }
  if (conclusion.sourceReferences.some(({ authoritativeLabel }) => authoritativeLabel !== null)) {
    throw invalidInput("Authoritative citation labels are derived by the local store.");
  }
  return Object.freeze({
    id: requireIdentifier(conclusion.id, "conclusion.id"),
    ordinal,
    category,
    title: requireText(conclusion.title, 1, 240, "conclusion.title"),
    explanation: requireText(conclusion.explanation, 1, 12_000, "conclusion.explanation"),
    evidence: Object.freeze(
      conclusion.evidence.map((evidence) => requireText(evidence, 1, 4_000, "conclusion.evidence")),
    ),
    sourceReferences: Object.freeze(
      conclusion.sourceReferences.map((reference) =>
        Object.freeze({
          kind: requireEnum(
            reference.kind,
            ["chapter", "outline_node", "material", "project_rule", "turn"] as const,
            "sourceReference.kind",
          ),
          sourceId: requireIdentifier(reference.sourceId, "sourceReference.sourceId"),
          sourceRevision: requireInteger(
            reference.sourceRevision,
            1,
            Number.MAX_SAFE_INTEGER,
            "sourceReference.sourceRevision",
          ),
          sourceVersionId:
            reference.sourceVersionId === null
              ? null
              : requireIdentifier(reference.sourceVersionId, "sourceReference.sourceVersionId"),
          sourceChecksum: requireChecksum(
            reference.sourceChecksum,
            "sourceReference.sourceChecksum",
          ),
          modelLabel: requireText(reference.modelLabel, 1, 240, "sourceReference.modelLabel"),
          authoritativeLabel:
            reference.authoritativeLabel === null
              ? null
              : requireText(
                  reference.authoritativeLabel,
                  1,
                  240,
                  "sourceReference.authoritativeLabel",
                ),
          excerpt:
            reference.excerpt === null
              ? null
              : requireText(reference.excerpt, 1, 2_000, "sourceReference.excerpt"),
        }),
      ),
    ),
    taskProposal:
      conclusion.taskProposal === null
        ? null
        : Object.freeze({
            title: requireText(conclusion.taskProposal.title, 1, 240, "taskProposal.title"),
            description: requireText(
              conclusion.taskProposal.description,
              1,
              8_000,
              "taskProposal.description",
            ),
            priority: requireEnum(
              conclusion.taskProposal.priority,
              ["p0", "p1", "p2", "p3"] as const,
              "taskProposal.priority",
            ),
          }),
  });
}

async function requireTargetAuthority(
  executor: TransactionExecutor,
  input: ReturnType<typeof validateCreateInput>,
): Promise<void> {
  if (input.target.kind === "chapter") {
    const rows = await executor.select<{
      current_version_id: string;
      content_checksum: string;
    }>(
      `SELECT chapter.current_version_id, version.content_checksum
       FROM chapters AS chapter
       JOIN chapter_versions AS version
         ON version.id = ?
        AND version.chapter_id = chapter.id
        AND version.project_id = chapter.project_id
       WHERE chapter.id = ?
         AND chapter.project_id = ?
         AND chapter.status = 'active'`,
      [input.target.baseVersionId, input.target.chapterId, input.projectId],
    );
    const row = rows[0];
    if (
      row?.current_version_id !== input.target.baseVersionId ||
      row.content_checksum !== input.target.baseAuthorityChecksum
    ) {
      throw storeError(
        "MULTI_AGENT_AUTHORITY_MISMATCH",
        "The chapter review baseline is stale or belongs to another project.",
      );
    }
    return;
  }
  const rows = await executor.select<OutlineRow>(
    `SELECT project_id, revision, snapshot_json
     FROM story_outlines
     WHERE project_id = ? AND revision = ?`,
    [input.projectId, input.target.baseOutlineRevision],
  );
  const row = rows[0];
  if (
    row === undefined ||
    (await sha256Hex(row.snapshot_json)) !== input.target.baseAuthorityChecksum
  ) {
    throw storeError(
      "MULTI_AGENT_AUTHORITY_MISMATCH",
      "The outline review baseline is stale or unavailable.",
    );
  }
}

async function requireRestartAuthority(
  executor: TransactionExecutor,
  input: ReturnType<typeof validateCreateInput>,
): Promise<void> {
  if (input.restartOfSessionId === null) {
    if (input.attempt !== 1) {
      throw invalidInput("An initial review must start at attempt one.");
    }
    return;
  }
  const previous = await requireSessionRow(executor, input.restartOfSessionId);
  if (
    previous.project_id !== input.projectId ||
    previous.mode !== input.mode ||
    previous.target_kind !== input.target.kind ||
    previous.chapter_id !== (input.target.kind === "chapter" ? input.target.chapterId : null) ||
    previous.base_version_id !==
      (input.target.kind === "chapter" ? input.target.baseVersionId : null) ||
    previous.base_outline_revision !==
      (input.target.kind === "outline" ? input.target.baseOutlineRevision : null) ||
    previous.base_authority_checksum !== input.target.baseAuthorityChecksum ||
    previous.user_request !== input.userRequest ||
    input.attempt !== previous.attempt + 1 ||
    !["paused", "needs_input", "failed", "cancelled"].includes(previous.status)
  ) {
    throw storeError(
      "MULTI_AGENT_AUTHORITY_MISMATCH",
      "The restart request does not match an eligible prior review authority.",
    );
  }
}

async function requireSessionRow(
  executor: TransactionExecutor,
  sessionId: string,
): Promise<SessionRow> {
  const rows = await executor.select<SessionRow>(`${SESSION_SELECT} WHERE id = ?`, [sessionId]);
  if (rows[0] === undefined) {
    throw storeError("MULTI_AGENT_NOT_FOUND", "The review session does not exist.");
  }
  return rows[0];
}

async function loadParticipantRows(
  executor: TransactionExecutor,
  sessionId: string,
): Promise<readonly ParticipantRow[]> {
  return executor.select<ParticipantRow>(
    `${PARTICIPANT_SELECT}
     WHERE session_id = ?
     ORDER BY ordinal ASC, participant_id ASC`,
    [sessionId],
  );
}

async function requireParticipantRow(
  executor: TransactionExecutor,
  sessionId: string,
  participantId: string,
): Promise<ParticipantRow> {
  const rows = await executor.select<ParticipantRow>(
    `${PARTICIPANT_SELECT}
     WHERE session_id = ? AND participant_id = ?`,
    [sessionId, participantId],
  );
  if (rows[0] === undefined) {
    throw storeError(
      "MULTI_AGENT_AUTHORITY_MISMATCH",
      "The review participant does not belong to this session.",
    );
  }
  return rows[0];
}

async function requireTurnRow(
  executor: TransactionExecutor,
  sessionId: string,
  turnId: string,
): Promise<TurnRow> {
  const rows = await executor.select<TurnRow>(
    `${TURN_SELECT}
     WHERE session_id = ? AND id = ?`,
    [sessionId, turnId],
  );
  if (rows[0] === undefined) {
    throw storeError("MULTI_AGENT_NOT_FOUND", "The review turn does not exist.");
  }
  return rows[0];
}

async function loadUsageTotals(
  executor: TransactionExecutor,
  sessionId: string,
): Promise<UsageTotalsRow> {
  const rows = await executor.select<UsageTotalsRow>(
    `SELECT
       COALESCE(SUM(
         CASE WHEN usage_source = 'provider_reported' THEN input_tokens ELSE 0 END
       ), 0) AS input_tokens,
       COALESCE(SUM(
         CASE WHEN usage_source = 'provider_reported' THEN output_tokens ELSE 0 END
       ), 0) AS output_tokens,
       COALESCE(SUM(
         CASE WHEN usage_source = 'provider_reported' THEN cost_micros ELSE 0 END
       ), 0) AS cost_micros,
       COUNT(*) AS turn_count
     FROM multi_agent_review_turns
     WHERE session_id = ?`,
    [sessionId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw storeError("MULTI_AGENT_CORRUPT", "Review usage totals are unavailable.");
  }
  return {
    input_tokens: requireInteger(row.input_tokens, 0, 10_000_000, "usageTotals.inputTokens"),
    output_tokens: requireInteger(row.output_tokens, 0, 10_000_000, "usageTotals.outputTokens"),
    cost_micros: requireInteger(row.cost_micros, 0, 10_000_000_000, "usageTotals.costMicros"),
    turn_count: requireInteger(row.turn_count, 0, 128, "usageTotals.turnCount"),
  };
}

function isPendingCandidatePublication(
  finalTurn:
    | {
        readonly sequence: number;
        readonly status: string;
        readonly response_json: string | null;
      }
    | undefined,
  maximumTurns: number,
): boolean {
  if (
    finalTurn?.sequence !== maximumTurns ||
    finalTurn.status !== "completed" ||
    finalTurn.response_json === null
  ) {
    return false;
  }
  try {
    return parseStrictPublicResponse(finalTurn.response_json).candidate !== null;
  } catch {
    return false;
  }
}

async function selectNextParticipant(
  executor: TransactionExecutor,
  participants: readonly ParticipantRow[],
  sessionId: string,
  turnCount: number,
): Promise<ParticipantRow | null> {
  const enabled = participants.filter(({ enabled }) => enabled === 1);
  if (enabled.length === 0) {
    return null;
  }
  const countRows = await executor.select<{
    participant_id: string;
    turn_count: number;
  }>(
    `SELECT participant_id, COUNT(*) AS turn_count
     FROM multi_agent_review_turns
     WHERE session_id = ?
     GROUP BY participant_id`,
    [sessionId],
  );
  const counts = new Map(
    countRows.map((row) => [
      row.participant_id,
      requireInteger(row.turn_count, 0, 128, "participant.turnCount"),
    ]),
  );
  const start = turnCount % enabled.length;
  for (let offset = 0; offset < enabled.length; offset += 1) {
    const participant = enabled[(start + offset) % enabled.length];
    if (
      participant !== undefined &&
      (counts.get(participant.participant_id) ?? 0) < participant.maximum_turns
    ) {
      return participant;
    }
  }
  return null;
}

function requireSessionRevision(session: SessionRow, expectedRevision: number): void {
  if (session.revision !== expectedRevision) {
    throw revisionConflict(expectedRevision, session.revision);
  }
}

function requireReservationWithinLimits(
  session: SessionRow,
  usage: UsageTotalsRow,
  reservation: ClaimMultiAgentReviewTurnInput["reservation"],
): void {
  if (
    usage.input_tokens + reservation.maximumInputTokens > session.maximum_input_tokens ||
    usage.output_tokens + reservation.maximumOutputTokens > session.maximum_output_tokens ||
    usage.cost_micros + reservation.maximumCostMicros > session.maximum_cost_micros
  ) {
    throw storeError(
      "MULTI_AGENT_LIMIT_EXHAUSTED",
      "The requested turn reservation exceeds a review resource limit.",
    );
  }
}

function requireTurnUsageWithinReservation(
  turn: TurnRow,
  usage: NonNullable<FailMultiAgentReviewTurnInput["usage"]>,
  costMicros: number,
): void {
  if (
    usage.inputTokens > turn.reservation_input_tokens ||
    usage.outputTokens > turn.reservation_output_tokens ||
    costMicros > turn.reservation_cost_micros
  ) {
    throw storeError(
      "MULTI_AGENT_LIMIT_EXHAUSTED",
      "Provider usage exceeded the authoritative turn reservation.",
    );
  }
}

function requireReportedUsageWithinLimits(
  session: SessionRow,
  totals: UsageTotalsRow,
  usage: NonNullable<FailMultiAgentReviewTurnInput["usage"]>,
  costMicros: number,
): void {
  if (
    totals.input_tokens + usage.inputTokens > session.maximum_input_tokens ||
    totals.output_tokens + usage.outputTokens > session.maximum_output_tokens ||
    totals.cost_micros + costMicros > session.maximum_cost_micros
  ) {
    throw storeError(
      "MULTI_AGENT_LIMIT_EXHAUSTED",
      "Provider usage exceeded an authoritative review limit.",
    );
  }
}

function calculateProviderCostMicros(
  participant: ParticipantRow,
  usage: NonNullable<FailMultiAgentReviewTurnInput["usage"]>,
): number {
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const uncachedTokens = usage.inputTokens - cachedTokens;
  const cachedRate =
    participant.cached_input_micros_per_million_tokens ??
    participant.input_micros_per_million_tokens;
  const micros =
    ceilDivide(
      BigInt(uncachedTokens) * BigInt(participant.input_micros_per_million_tokens),
      1_000_000n,
    ) +
    ceilDivide(BigInt(cachedTokens) * BigInt(cachedRate), 1_000_000n) +
    ceilDivide(
      BigInt(usage.outputTokens) * BigInt(participant.output_micros_per_million_tokens),
      1_000_000n,
    );
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw storeError("MULTI_AGENT_CORRUPT", "Provider usage produced an out-of-range review cost.");
  }
  return Number(micros);
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}

async function persistConclusions(
  executor: TransactionExecutor,
  input: CompleteMultiAgentReviewTurnInput,
  createdAt: string,
): Promise<void> {
  const session = await requireSessionRow(executor, input.sessionId);
  for (const [ordinal, conclusion] of input.conclusions.entries()) {
    const validatedReferences = await validateSourceReferences(
      executor,
      session,
      conclusion.sourceReferences,
      input.turnId,
    );
    await executor.execute(
      `INSERT INTO multi_agent_review_conclusions (
         id, session_id, turn_id, ordinal, category, title, explanation,
         evidence_json, task_proposal_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conclusion.id,
        input.sessionId,
        input.turnId,
        ordinal,
        conclusion.category,
        conclusion.title,
        conclusion.explanation,
        JSON.stringify(conclusion.evidence),
        conclusion.taskProposal === null ? null : JSON.stringify(conclusion.taskProposal),
        createdAt,
      ],
    );
    for (const [referenceOrdinal, reference] of validatedReferences.entries()) {
      await executor.execute(
        `INSERT INTO multi_agent_review_source_references (
           conclusion_id, ordinal, kind, source_id, source_revision,
           source_version_id, source_checksum, model_label,
           authoritative_label, excerpt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          conclusion.id,
          referenceOrdinal,
          reference.kind,
          reference.sourceId,
          reference.sourceRevision,
          reference.sourceVersionId,
          reference.sourceChecksum,
          reference.modelLabel,
          reference.authoritativeLabel,
          reference.excerpt,
        ],
      );
    }
  }
}

async function validateSourceReferences(
  executor: TransactionExecutor,
  session: SessionRow,
  references: readonly MultiAgentReviewSourceReference[],
  currentTurnId: string,
): Promise<
  readonly (MultiAgentReviewSourceReference & {
    readonly authoritativeLabel: string;
  })[]
> {
  const validated: (MultiAgentReviewSourceReference & {
    readonly authoritativeLabel: string;
  })[] = [];
  for (const reference of references) {
    switch (reference.kind) {
      case "chapter": {
        const rows = await executor.select<{
          title: string;
          content: string;
          sequence: number;
          content_checksum: string;
        }>(
          `SELECT
             chapter.title, version.content, version.sequence, version.content_checksum
           FROM chapter_versions AS version
           JOIN chapters AS chapter
             ON chapter.id = version.chapter_id
            AND chapter.project_id = version.project_id
           WHERE version.id = ?
             AND version.chapter_id = ?
             AND version.project_id = ?
             AND chapter.status = 'active'`,
          [reference.sourceVersionId, reference.sourceId, session.project_id],
        );
        const row = rows[0];
        const targetBaseline =
          reference.sourceId === session.chapter_id &&
          reference.sourceVersionId === session.base_version_id;
        const verifiedCausalEvidence =
          reference.excerpt === null
            ? false
            : await matchesVerifiedMainCausalEvidence(executor, session.project_id, reference);
        if (
          reference.sourceRevision !== row?.sequence ||
          reference.sourceChecksum !== row.content_checksum ||
          (await sha256Hex(row.content)) !== row.content_checksum ||
          (!targetBaseline && !verifiedCausalEvidence) ||
          !referenceExcerptMatches(reference.excerpt, row.content)
        ) {
          throw storeError(
            "MULTI_AGENT_AUTHORITY_MISMATCH",
            "A chapter source reference is missing, stale, or belongs to another project.",
          );
        }
        validated.push({
          ...reference,
          authoritativeLabel: requireText(row.title, 1, 200, "chapter citation title"),
        });
        break;
      }
      case "outline_node": {
        const rows = await executor.select<OutlineRow>(
          `SELECT project_id, revision, snapshot_json
           FROM story_outlines
           WHERE project_id = ?`,
          [session.project_id],
        );
        const outline = rows[0];
        if (
          outline === undefined ||
          (session.target_kind === "outline" && outline.revision !== session.base_outline_revision)
        ) {
          throw storeError(
            "MULTI_AGENT_AUTHORITY_MISMATCH",
            "The cited outline baseline is stale or unavailable.",
          );
        }
        const snapshot = parseJsonObject(outline.snapshot_json, "outline source snapshot");
        if (!isUnknownArray(snapshot.nodes)) {
          throw storeError("MULTI_AGENT_CORRUPT", "The cited outline snapshot is invalid.");
        }
        const node = snapshot.nodes.find(
          (value) => isRecord(value) && value.id === reference.sourceId,
        );
        if (
          !isRecord(node) ||
          reference.sourceVersionId !== null ||
          reference.sourceRevision !== node.revision ||
          reference.sourceChecksum !== (await sha256Hex(canonicalJson(node))) ||
          !referenceExcerptMatches(reference.excerpt, node)
        ) {
          throw storeError(
            "MULTI_AGENT_AUTHORITY_MISMATCH",
            "An outline source reference is missing, stale, or belongs to another project.",
          );
        }
        validated.push({
          ...reference,
          authoritativeLabel: deriveAuthorityLabel(node, `大纲节点 ${reference.sourceId}`),
        });
        break;
      }
      case "material": {
        const rows = await executor.select<{
          snapshot_json: string;
          revision: number;
          content_fingerprint: string;
        }>(
          `SELECT snapshot_json, revision, content_fingerprint
           FROM story_materials
           WHERE id = ? AND project_id = ? AND status = 'active'`,
          [reference.sourceId, session.project_id],
        );
        const material = rows[0];
        const snapshot =
          material === undefined
            ? null
            : parseJsonObject(material.snapshot_json, "material source snapshot");
        if (
          material === undefined ||
          snapshot === null ||
          reference.sourceVersionId !== null ||
          reference.sourceRevision !== material.revision ||
          reference.sourceChecksum !== material.content_fingerprint ||
          !referenceExcerptMatches(reference.excerpt, snapshot)
        ) {
          throw storeError(
            "MULTI_AGENT_AUTHORITY_MISMATCH",
            "A material source reference is missing, stale, or belongs to another project.",
          );
        }
        validated.push({
          ...reference,
          authoritativeLabel: deriveAuthorityLabel(snapshot, `素材 ${reference.sourceId}`),
        });
        break;
      }
      case "project_rule": {
        const storyFact = await loadConfirmedStoryFactReviewAuthority(
          executor,
          session.project_id,
          reference.sourceId,
        );
        if (storyFact !== null) {
          if (
            reference.sourceVersionId !== null ||
            reference.sourceRevision !== storyFact.revision ||
            reference.sourceChecksum !==
              (await computeMultiAgentReviewConfirmedStoryFactChecksum(storyFact)) ||
            !referenceExcerptMatches(reference.excerpt, storyFact)
          ) {
            throw projectRuleAuthorityMismatch();
          }
          validated.push({
            ...reference,
            authoritativeLabel: storyFactAuthorityLabel(storyFact),
          });
          break;
        }

        // Compatibility path for pre-unified enabled L4 memory records.
        const rows = await executor.select<{
          snapshot_json: string;
          revision: number;
        }>(
          `SELECT snapshot_json, revision
           FROM story_memory_records
           WHERE id = ? AND project_id = ? AND level = 'L4' AND status = 'enabled'`,
          [reference.sourceId, session.project_id],
        );
        const rule = rows[0];
        const snapshot =
          rule === undefined
            ? null
            : parseJsonObject(rule.snapshot_json, "project-rule source snapshot");
        if (
          rule === undefined ||
          snapshot === null ||
          reference.sourceVersionId !== null ||
          reference.sourceRevision !== rule.revision ||
          reference.sourceChecksum !== (await sha256Hex(canonicalJson(snapshot))) ||
          !referenceExcerptMatches(reference.excerpt, snapshot)
        ) {
          throw storeError(
            "MULTI_AGENT_AUTHORITY_MISMATCH",
            "A project-rule source reference is missing, stale, or belongs to another project.",
          );
        }
        validated.push({
          ...reference,
          authoritativeLabel: deriveAuthorityLabel(snapshot, `项目规则 ${reference.sourceId}`),
        });
        break;
      }
      case "turn": {
        const rows = await executor.select<{
          referenced_sequence: number;
          current_sequence: number;
          public_message: string;
          result_fingerprint: string;
        }>(
          `SELECT
             referenced.sequence AS referenced_sequence,
             current.sequence AS current_sequence,
             referenced.public_message,
             referenced.result_fingerprint
           FROM multi_agent_review_turns AS referenced
           JOIN multi_agent_review_turns AS current
             ON current.id = ?
            AND current.session_id = referenced.session_id
           WHERE referenced.id = ?
             AND referenced.session_id = ?
             AND referenced.status = 'completed'`,
          [currentTurnId, reference.sourceId, session.id],
        );
        const turn = rows[0];
        if (
          turn === undefined ||
          turn.referenced_sequence >= turn.current_sequence ||
          reference.sourceVersionId !== null ||
          reference.sourceRevision !== turn.referenced_sequence ||
          reference.sourceChecksum !== turn.result_fingerprint ||
          !referenceExcerptMatches(reference.excerpt, turn.public_message)
        ) {
          throw storeError(
            "MULTI_AGENT_AUTHORITY_MISMATCH",
            "A turn source reference is missing or does not precede this response.",
          );
        }
        validated.push({
          ...reference,
          authoritativeLabel: `评审发言 #${String(turn.referenced_sequence)}`,
        });
        break;
      }
    }
  }
  return Object.freeze(validated);
}

async function matchesVerifiedMainCausalEvidence(
  executor: TransactionExecutor,
  projectId: string,
  reference: MultiAgentReviewSourceReference,
): Promise<boolean> {
  if (reference.sourceVersionId === null || reference.excerpt === null) {
    return false;
  }
  let rows: ReviewCausalEvidenceRow[];
  try {
    rows = await executor.select<ReviewCausalEvidenceRow>(
      `SELECT
         evidence.id, evidence.excerpt, evidence.start_offset,
         evidence.end_offset, evidence.source_length,
         version.content, version.content_checksum
       FROM causal_evidence_sources AS evidence
       INNER JOIN chapter_versions AS version
         ON version.id = evidence.chapter_version_id
        AND version.chapter_id = evidence.chapter_id
        AND version.project_id = evidence.project_id
       WHERE evidence.project_id = ?
         AND evidence.chapter_id = ?
         AND evidence.chapter_version_id = ?
         AND evidence.content_hash = ?`,
      [projectId, reference.sourceId, reference.sourceVersionId, reference.sourceChecksum],
    );
  } catch (cause: unknown) {
    if (isMissingSqliteTable(cause, "causal_evidence_sources")) {
      return false;
    }
    throw cause;
  }
  for (const row of rows) {
    if (
      row.content_checksum !== reference.sourceChecksum ||
      row.content.length !== row.source_length ||
      row.start_offset < 0 ||
      row.end_offset <= row.start_offset ||
      row.end_offset > row.source_length ||
      row.content.slice(row.start_offset, row.end_offset) !== row.excerpt ||
      !row.excerpt.includes(reference.excerpt) ||
      (await sha256Hex(row.content)) !== reference.sourceChecksum
    ) {
      continue;
    }
    if (await causalEvidenceIsUsedByMainGraph(executor, projectId, row.id)) {
      return true;
    }
  }
  return false;
}

async function causalEvidenceIsUsedByMainGraph(
  executor: TransactionExecutor,
  projectId: string,
  evidenceId: string,
): Promise<boolean> {
  const rows = await executor.select<{ matched: number }>(
    `SELECT 1 AS matched
     FROM (
       SELECT event.evidence_id
       FROM causal_events AS event
       WHERE event.project_id = ? AND event.branch_id = 'main'
       UNION
       SELECT prerequisite.evidence_id
       FROM causal_event_prerequisites AS prerequisite
       INNER JOIN causal_events AS event
         ON event.id = prerequisite.event_id
        AND event.project_id = prerequisite.project_id
        AND event.branch_id = prerequisite.branch_id
       WHERE event.project_id = ? AND event.branch_id = 'main'
       UNION
       SELECT change.evidence_id
       FROM causal_event_character_changes AS change
       INNER JOIN causal_events AS event
         ON event.id = change.event_id
        AND event.project_id = change.project_id
        AND event.branch_id = change.branch_id
       WHERE event.project_id = ? AND event.branch_id = 'main'
       UNION
       SELECT change.evidence_id
       FROM causal_event_relationship_changes AS change
       INNER JOIN causal_events AS event
         ON event.id = change.event_id
        AND event.project_id = change.project_id
        AND event.branch_id = change.branch_id
       WHERE event.project_id = ? AND event.branch_id = 'main'
       UNION
       SELECT change.evidence_id
       FROM causal_event_item_changes AS change
       INNER JOIN causal_events AS event
         ON event.id = change.event_id
        AND event.project_id = change.project_id
        AND event.branch_id = change.branch_id
       WHERE event.project_id = ? AND event.branch_id = 'main'
       UNION
       SELECT progress.evidence_id
       FROM causal_event_foreshadow_progress AS progress
       INNER JOIN causal_events AS event
         ON event.id = progress.event_id
        AND event.project_id = progress.project_id
        AND event.branch_id = progress.branch_id
       WHERE event.project_id = ? AND event.branch_id = 'main'
       UNION
       SELECT relation.evidence_id
       FROM causal_event_relations AS relation
       WHERE relation.project_id = ? AND relation.branch_id = 'main'
     ) AS graph_evidence
     WHERE graph_evidence.evidence_id = ?
     LIMIT 1`,
    [projectId, projectId, projectId, projectId, projectId, projectId, projectId, evidenceId],
  );
  return rows[0]?.matched === 1;
}

async function loadConfirmedStoryFactReviewAuthority(
  executor: TransactionExecutor,
  projectId: string,
  sourceId: string,
): Promise<MultiAgentReviewConfirmedStoryFactAuthority | null> {
  let rows: ConfirmedStoryFactAuthorityRow[];
  try {
    rows = await executor.select<ConfirmedStoryFactAuthorityRow>(
      `SELECT
         id, project_id, fact_type, content_text, value_json, source_kind,
         evidence_reference, source_chapter_id, source_version_id,
         source_start_offset, source_end_offset, source_length, source_excerpt,
         effective_at, invalidated_at, branch_id, confidence, status, origin,
         user_confirmed, locked, deprecated, needs_review, revision
       FROM story_facts
       WHERE id = ? AND project_id = ?
       LIMIT 2`,
      [sourceId, projectId],
    );
  } catch (cause: unknown) {
    if (isMissingSqliteTable(cause, "story_facts")) {
      return null;
    }
    throw cause;
  }
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (
    rows.length !== 1 ||
    row.status !== "formal" ||
    row.user_confirmed !== 1 ||
    row.deprecated !== 0 ||
    row.needs_review !== 0 ||
    row.branch_id !== null ||
    ![0, 1].includes(row.locked) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isFinite(row.confidence) ||
    row.confidence < 0 ||
    row.confidence > 1 ||
    (row.content_text === null && row.value_json === null)
  ) {
    throw projectRuleAuthorityMismatch();
  }
  const structuredValue =
    row.value_json === null ? null : parseJson(row.value_json, "story-fact structured value");
  const contentChecksum = await verifyStoryFactChapterEvidence(executor, row);
  return createMultiAgentReviewConfirmedStoryFactAuthority({
    id: row.id,
    projectId: row.project_id,
    factType: row.fact_type,
    contentText: row.content_text,
    structuredValue,
    source: {
      kind: row.source_kind,
      reference: row.evidence_reference,
      chapterId: row.source_chapter_id,
      versionId: row.source_version_id,
      startOffset: row.source_start_offset,
      endOffset: row.source_end_offset,
      sourceLength: row.source_length,
      excerpt: row.source_excerpt,
      contentChecksum,
    },
    effectiveAt: row.effective_at,
    invalidatedAt: row.invalidated_at,
    confidence: row.confidence,
    origin: row.origin,
    locked: row.locked === 1,
    revision: row.revision,
  });
}

async function verifyStoryFactChapterEvidence(
  executor: TransactionExecutor,
  row: ConfirmedStoryFactAuthorityRow,
): Promise<string | null> {
  const sourceFields = [
    row.source_chapter_id,
    row.source_version_id,
    row.source_start_offset,
    row.source_end_offset,
    row.source_length,
    row.source_excerpt,
  ];
  if (row.source_kind !== "chapter_span") {
    if (sourceFields.some((value) => value !== null)) {
      throw storeError(
        "MULTI_AGENT_CORRUPT",
        "A non-chapter StoryFact contains chapter evidence fields.",
      );
    }
    return null;
  }
  const sourceVersionId = row.source_version_id;
  const startOffset = row.source_start_offset;
  const endOffset = row.source_end_offset;
  const sourceLength = row.source_length;
  if (
    typeof row.source_chapter_id !== "string" ||
    typeof sourceVersionId !== "string" ||
    typeof startOffset !== "number" ||
    !Number.isSafeInteger(startOffset) ||
    typeof endOffset !== "number" ||
    !Number.isSafeInteger(endOffset) ||
    typeof sourceLength !== "number" ||
    !Number.isSafeInteger(sourceLength) ||
    typeof row.source_excerpt !== "string"
  ) {
    throw projectRuleAuthorityMismatch();
  }
  const versionRows = await executor.select<StoryFactChapterEvidenceRow>(
    `SELECT
       version.project_id, version.chapter_id, version.content,
       version.content_checksum
     FROM chapter_versions AS version
     INNER JOIN chapters AS chapter
       ON chapter.id = version.chapter_id
      AND chapter.project_id = version.project_id
     WHERE version.id = ?
     LIMIT 2`,
    [sourceVersionId],
  );
  const version = versionRows[0];
  if (
    versionRows.length !== 1 ||
    version?.project_id !== row.project_id ||
    version.chapter_id !== row.source_chapter_id ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > sourceLength ||
    version.content.length !== sourceLength ||
    version.content.slice(startOffset, endOffset) !== row.source_excerpt ||
    (await sha256Hex(version.content)) !== version.content_checksum
  ) {
    throw projectRuleAuthorityMismatch();
  }
  return version.content_checksum;
}

function storyFactAuthorityLabel(authority: MultiAgentReviewConfirmedStoryFactAuthority): string {
  const content = authority.contentText?.trim();
  return content === undefined || content.length === 0
    ? `StoryFact ${authority.factType}`
    : content.slice(0, 240);
}

function projectRuleAuthorityMismatch(): MultiAgentReviewStoreError {
  return storeError(
    "MULTI_AGENT_AUTHORITY_MISMATCH",
    "A project-rule source reference is missing, stale, unconfirmed, or belongs to another project.",
  );
}

function isMissingSqliteTable(cause: unknown, tableName: string): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new RegExp(`no such table:\\s*(?:main\\.)?${tableName}`, "iu").test(message);
}

function deriveAuthorityLabel(
  snapshot: Readonly<Record<string, unknown>>,
  fallback: string,
): string {
  for (const key of ["title", "name", "label", "recordKey"]) {
    const value = snapshot[key];
    if (typeof value === "string" && value.length >= 1 && value.length <= 240) {
      return requireText(value, 1, 240, "citation authority label");
    }
  }
  return requireText(fallback, 1, 240, "citation authority label");
}

function referenceExcerptMatches(excerpt: string | null, value: unknown): boolean {
  return excerpt === null || collectText(value).some((text) => text.includes(excerpt));
}

function collectText(value: unknown): readonly string[] {
  const texts: string[] = [];
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > 20_000) {
      break;
    }
    if (typeof current === "string") {
      texts.push(current);
    } else if (isUnknownArray(current)) {
      stack.push(...current);
    } else if (isRecord(current)) {
      stack.push(...Object.values(current));
    }
  }
  return texts;
}

async function updateSessionRevision(
  executor: TransactionExecutor,
  session: SessionRow,
  input: {
    readonly status: MultiAgentReviewSessionStatus;
    readonly updatedAt: string;
    readonly completedAt?: string | null;
    readonly failureCode?: string | null;
    readonly cancellationRequested?: boolean;
  },
): Promise<void> {
  const nextRevision = session.revision + 1;
  if (!Number.isSafeInteger(nextRevision)) {
    throw storeError("MULTI_AGENT_LIMIT_EXHAUSTED", "The review revision authority is exhausted.");
  }
  const completedAt = input.completedAt === undefined ? session.completed_at : input.completedAt;
  const failureCode =
    input.failureCode === undefined
      ? input.status === "failed"
        ? session.failure_code
        : null
      : input.failureCode;
  const cancellationRequested =
    input.cancellationRequested === undefined
      ? session.cancellation_requested
      : input.cancellationRequested
        ? 1
        : 0;
  const result = await executor.execute(
    `UPDATE multi_agent_review_sessions
     SET
       status = ?, revision = ?, cancellation_requested = ?,
       failure_code = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND revision = ?`,
    [
      input.status,
      nextRevision,
      cancellationRequested,
      failureCode,
      completedAt,
      input.updatedAt,
      session.id,
      session.revision,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw storeError(
      "MULTI_AGENT_REVISION_CONFLICT",
      "The review changed before its state transition could be committed.",
      true,
    );
  }
}

function validatePublicResponseProjection(
  serializedResponse: string,
  publicMessage: string,
  needsInput: boolean,
  conclusions: readonly Omit<MultiAgentReviewConclusion, "ordinal">[],
): StrictMultiAgentPublicResponse {
  const response = parseStrictPublicResponse(serializedResponse);
  if (
    JSON.stringify(response) !== serializedResponse ||
    response.publicMessage !== publicMessage ||
    (response.needsInput !== null) !== needsInput ||
    (response.needsInput !== null && response.candidate !== null)
  ) {
    throw storeError(
      "MULTI_AGENT_AUTHORITY_MISMATCH",
      "The public response projection does not match its normalized receipt.",
    );
  }
  const normalizedConclusions = conclusions.map((conclusion) => ({
    category: conclusion.category,
    title: conclusion.title,
    explanation: conclusion.explanation,
    evidence: conclusion.evidence,
    sourceReferences: conclusion.sourceReferences.map((reference) => ({
      kind: reference.kind,
      sourceId: reference.sourceId,
      sourceRevision: reference.sourceRevision,
      sourceVersionId: reference.sourceVersionId,
      sourceChecksum: reference.sourceChecksum,
      modelLabel: reference.modelLabel,
      excerpt: reference.excerpt,
    })),
    taskProposal: conclusion.taskProposal,
  }));
  if (canonicalJson(response.conclusions) !== canonicalJson(normalizedConclusions)) {
    throw storeError(
      "MULTI_AGENT_AUTHORITY_MISMATCH",
      "The persisted conclusions differ from the public response.",
    );
  }
  return response;
}

function requireCandidateMatchesPublicTurn(
  session: SessionRow,
  turns: readonly TurnRow[],
  payloadJson: string,
): void {
  const payload = parseStrictCandidatePayload(
    parseJsonObject(payloadJson, "candidate payload"),
    "candidate payload",
  );
  const expectedKind = session.target_kind === "chapter" ? "chapter_content" : "outline_patch";
  if (payload.kind !== expectedKind) {
    throw storeError(
      "MULTI_AGENT_AUTHORITY_MISMATCH",
      "The candidate payload does not match the review target.",
    );
  }
  const finalTurn = turns.at(-1);
  if (finalTurn?.response_json !== null && finalTurn?.response_json !== undefined) {
    const response = parseStrictPublicResponse(finalTurn.response_json);
    if (
      response.candidate !== null &&
      canonicalJson(response.candidate) === canonicalJson(payload)
    ) {
      return;
    }
  }
  throw storeError(
    "MULTI_AGENT_AUTHORITY_MISMATCH",
    "The final completed public turn did not produce the requested candidate.",
  );
}

function parseStrictPublicResponse(serializedResponse: string): StrictMultiAgentPublicResponse {
  const response = parseJsonObject(serializedResponse, "public response");
  assertBoundedSafeJsonGraph(response, "public response");
  requireExactKeys(
    response,
    ["schemaVersion", "publicMessage", "conclusions", "candidate", "needsInput"],
    "public response",
  );
  if (response.schemaVersion !== 1) {
    throw invalidInput("The public response schema version is unsupported.");
  }
  const conclusions = requireBoundedArray(
    response.conclusions,
    0,
    64,
    "public response conclusions",
  ).map(parseStrictPublicConclusion);
  const candidate =
    response.candidate === null
      ? null
      : parseStrictCandidatePayload(response.candidate, "public response candidate");
  const needsInput =
    response.needsInput === null
      ? null
      : (() => {
          if (!isRecord(response.needsInput)) {
            throw invalidInput("The public response input request is invalid.");
          }
          requireExactKeys(response.needsInput, ["question"], "public response input request");
          return Object.freeze({
            question: requireText(
              response.needsInput.question,
              1,
              4_000,
              "public response needsInput.question",
            ),
          });
        })();
  if (needsInput !== null && candidate !== null) {
    throw invalidInput("A needs-input response cannot include candidate content.");
  }
  return Object.freeze({
    schemaVersion: 1,
    publicMessage: requireText(response.publicMessage, 1, 40_000, "public response publicMessage"),
    conclusions: Object.freeze(conclusions),
    candidate,
    needsInput,
  });
}

function parseStrictPublicConclusion(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidInput("A public response conclusion is invalid.");
  }
  requireExactKeys(
    value,
    ["category", "title", "explanation", "evidence", "sourceReferences", "taskProposal"],
    "public response conclusion",
  );
  const category = requireEnum(
    value.category,
    MULTI_AGENT_REVIEW_CONCLUSION_CATEGORIES,
    "public response conclusion.category",
  );
  const evidence = requireBoundedArray(
    value.evidence,
    0,
    16,
    "public response conclusion.evidence",
  ).map((item) => requireText(item, 1, 4_000, "public response conclusion.evidence item"));
  const sourceReferences = requireBoundedArray(
    value.sourceReferences,
    0,
    32,
    "public response conclusion.sourceReferences",
  ).map(parseStrictPublicSourceReference);
  const taskProposal =
    value.taskProposal === null ? null : parseStrictPublicTaskProposal(value.taskProposal);
  if ((category === "convertible_task") !== (taskProposal !== null)) {
    throw invalidInput("Public response task proposals must match the convertible-task category.");
  }
  return Object.freeze({
    category,
    title: requireText(value.title, 1, 240, "public response conclusion.title"),
    explanation: requireText(
      value.explanation,
      1,
      12_000,
      "public response conclusion.explanation",
    ),
    evidence: Object.freeze(evidence),
    sourceReferences: Object.freeze(sourceReferences),
    taskProposal,
  });
}

function parseStrictPublicSourceReference(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidInput("A public response source reference is invalid.");
  }
  requireExactKeys(
    value,
    [
      "kind",
      "sourceId",
      "sourceRevision",
      "sourceVersionId",
      "sourceChecksum",
      "modelLabel",
      "excerpt",
    ],
    "public response source reference",
  );
  const kind = requireEnum(
    value.kind,
    ["chapter", "outline_node", "material", "project_rule", "turn"] as const,
    "public response source reference.kind",
  );
  const sourceVersionId =
    value.sourceVersionId === null
      ? null
      : requireIdentifier(
          value.sourceVersionId,
          "public response source reference.sourceVersionId",
        );
  if ((kind === "chapter") !== (sourceVersionId !== null)) {
    throw invalidInput("The public response source authority receipt is invalid.");
  }
  return Object.freeze({
    kind,
    sourceId: requireIdentifier(value.sourceId, "public response source reference.sourceId"),
    sourceRevision: requireInteger(
      value.sourceRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      "public response source reference.sourceRevision",
    ),
    sourceVersionId,
    sourceChecksum: requireChecksum(
      value.sourceChecksum,
      "public response source reference.sourceChecksum",
    ),
    modelLabel: requireText(
      value.modelLabel,
      1,
      240,
      "public response source reference.modelLabel",
    ),
    excerpt:
      value.excerpt === null
        ? null
        : requireText(value.excerpt, 1, 2_000, "public response source reference.excerpt"),
  });
}

function parseStrictPublicTaskProposal(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidInput("A public response task proposal is invalid.");
  }
  requireExactKeys(value, ["title", "description", "priority"], "public response task proposal");
  return Object.freeze({
    title: requireText(value.title, 1, 240, "public response task proposal.title"),
    description: requireText(
      value.description,
      1,
      8_000,
      "public response task proposal.description",
    ),
    priority: requireEnum(
      value.priority,
      ["p0", "p1", "p2", "p3"] as const,
      "public response task proposal.priority",
    ),
  });
}

function parseStrictCandidatePayload(value: unknown, field: string): StrictMultiAgentCandidate {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidInput(`${field} is invalid.`);
  }
  if (value.kind === "chapter_content") {
    requireExactKeys(value, ["kind", "content"], field);
    return Object.freeze({
      kind: "chapter_content",
      content: requireText(value.content, 1, 750_000, `${field}.content`),
    });
  }
  if (value.kind !== "outline_patch") {
    throw invalidInput(`${field} kind is invalid.`);
  }
  requireExactKeys(value, ["kind", "changes"], field);
  const changedNodes = new Set<string>();
  const changes = requireBoundedArray(value.changes, 1, 2_000, `${field}.changes`).map(
    (changeValue) => {
      if (!isRecord(changeValue)) {
        throw invalidInput(`${field} contains an invalid outline change.`);
      }
      requireExactKeys(
        changeValue,
        ["nodeId", "expectedNodeRevision", "title", "synopsis"],
        `${field} outline change`,
      );
      const nodeId = requireIdentifier(changeValue.nodeId, `${field}.change.nodeId`);
      if (changedNodes.has(nodeId)) {
        throw invalidInput(`${field} cannot update the same outline node twice.`);
      }
      changedNodes.add(nodeId);
      const title =
        changeValue.title === null
          ? null
          : requireText(changeValue.title, 1, 200, `${field}.change.title`);
      const synopsis =
        changeValue.synopsis === null
          ? null
          : requireText(changeValue.synopsis, 0, 50_000, `${field}.change.synopsis`);
      if (title === null && synopsis === null) {
        throw invalidInput(`${field} outline changes must modify a title or synopsis.`);
      }
      return Object.freeze({
        nodeId,
        expectedNodeRevision: requireInteger(
          changeValue.expectedNodeRevision,
          1,
          Number.MAX_SAFE_INTEGER - 1,
          `${field}.change.expectedNodeRevision`,
        ),
        title,
        synopsis,
      });
    },
  );
  return Object.freeze({
    kind: "outline_patch",
    changes: Object.freeze(changes),
  });
}

function requireBoundedArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
    throw invalidInput(`${field} has an invalid item count.`);
  }
  return value;
}

function assertBoundedSafeJsonGraph(root: unknown, field: string): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: root, depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    nodeCount += 1;
    if (nodeCount > 20_000 || current.depth > 12) {
      throw invalidInput(`${field} exceeds its JSON complexity boundary.`);
    }
    if (typeof current.value === "string") {
      requireText(current.value, 0, 1_000_000, field);
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      typeof current.value === "number"
    ) {
      if (typeof current.value === "number" && !Number.isFinite(current.value)) {
        throw invalidInput(`${field} contains a non-finite number.`);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) {
      throw invalidInput(`${field} contains a non-JSON value.`);
    }
    for (const [key, item] of Object.entries(current.value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw invalidInput(`${field} contains a prohibited object key.`);
      }
      requireText(key, 1, 1_000_000, field);
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
}

async function insertAuditEvent(
  executor: TransactionExecutor,
  event: {
    readonly id: string;
    readonly projectId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly action: string;
    readonly requestId: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  },
): Promise<void> {
  await executor.execute(
    `INSERT INTO local_audit_events (
       id, project_id, entity_type, entity_id, action, request_id,
       metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.projectId,
      event.entityType,
      event.entityId,
      event.action,
      event.requestId,
      canonicalJson(event.metadata),
      event.createdAt,
    ],
  );
}

function applyOutlinePatch(
  baselineJson: string,
  payloadJson: string,
  projectId: string,
  acceptedAt: string,
): { readonly snapshotJson: string; readonly revision: number } {
  const snapshot = parseJsonObject(baselineJson, "outline snapshot");
  const payload = parseJsonObject(payloadJson, "outline candidate");
  requireExactKeys(payload, ["kind", "changes"], "outline candidate");
  if (
    snapshot.projectId !== projectId ||
    !Number.isSafeInteger(snapshot.revision) ||
    (snapshot.revision as number) < 1 ||
    !Array.isArray(snapshot.nodes) ||
    snapshot.nodes.length < 1 ||
    snapshot.nodes.length > 100_000 ||
    payload.kind !== "outline_patch" ||
    !Array.isArray(payload.changes) ||
    payload.changes.length < 1 ||
    payload.changes.length > 2_000
  ) {
    throw storeError("MULTI_AGENT_CORRUPT", "The outline baseline or candidate patch is invalid.");
  }
  const nodes = snapshot.nodes.map((node) => {
    if (!isRecord(node)) {
      throw storeError("MULTI_AGENT_CORRUPT", "An outline node snapshot is invalid.");
    }
    return { ...node };
  });
  const nodeMap = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = requireIdentifier(node.id, "outlineNode.id");
    if (nodeMap.has(id)) {
      throw storeError("MULTI_AGENT_CORRUPT", "Outline node identifiers are duplicated.");
    }
    nodeMap.set(id, node);
  }
  const changedNodes = new Set<string>();
  for (const changeValue of payload.changes) {
    if (!isRecord(changeValue)) {
      throw storeError("MULTI_AGENT_CORRUPT", "An outline patch change is invalid.");
    }
    requireExactKeys(
      changeValue,
      ["nodeId", "expectedNodeRevision", "title", "synopsis"],
      "outline patch change",
    );
    const nodeId = requireIdentifier(changeValue.nodeId, "outlinePatch.nodeId");
    if (changedNodes.has(nodeId)) {
      throw storeError(
        "MULTI_AGENT_CORRUPT",
        "An outline patch cannot update a node more than once.",
      );
    }
    changedNodes.add(nodeId);
    const node = nodeMap.get(nodeId);
    const expectedNodeRevision = requireInteger(
      changeValue.expectedNodeRevision,
      1,
      Number.MAX_SAFE_INTEGER - 1,
      "outlinePatch.expectedNodeRevision",
    );
    if (
      node?.revision !== expectedNodeRevision ||
      node.locked !== false ||
      typeof node.updatedAt !== "string" ||
      node.updatedAt > acceptedAt
    ) {
      throw storeError("MULTI_AGENT_AUTHORITY_MISMATCH", "An outline node changed or is locked.");
    }
    const title =
      changeValue.title === null
        ? null
        : requireText(changeValue.title, 1, 200, "outlinePatch.title");
    const synopsis =
      changeValue.synopsis === null
        ? null
        : requireText(changeValue.synopsis, 0, 50_000, "outlinePatch.synopsis");
    if (title === null && synopsis === null) {
      throw invalidInput("An outline patch change does not modify a field.");
    }
    let changed = false;
    if (title !== null && title !== node.title) {
      node.title = title;
      changed = true;
    }
    if (synopsis !== null && synopsis !== node.synopsis) {
      node.synopsis = synopsis;
      changed = true;
    }
    if (!changed) {
      throw storeError(
        "MULTI_AGENT_ILLEGAL_STATE",
        "The outline candidate does not change its baseline.",
      );
    }
    node.revision = expectedNodeRevision + 1;
    node.updatedAt = acceptedAt;
  }
  const revision = (snapshot.revision as number) + 1;
  if (!Number.isSafeInteger(revision)) {
    throw storeError("MULTI_AGENT_LIMIT_EXHAUSTED", "The outline revision authority is exhausted.");
  }
  const result = {
    ...snapshot,
    projectId,
    revision,
    nodes,
  };
  return Object.freeze({
    snapshotJson: JSON.stringify(result),
    revision,
  });
}

function hydrateTaskProposal(
  value: Record<string, unknown>,
): NonNullable<MultiAgentReviewConclusion["taskProposal"]> {
  return Object.freeze({
    title: requireText(value.title, 1, 240, "taskProposal.title"),
    description: requireText(value.description, 1, 8_000, "taskProposal.description"),
    priority: requireEnum(
      value.priority,
      ["p0", "p1", "p2", "p3"] as const,
      "taskProposal.priority",
    ),
  });
}

export async function computeMultiAgentReviewRequestFingerprint(
  input: Omit<CreateMultiAgentReviewSessionInput, "requestFingerprint">,
): Promise<string> {
  const validated = validateCreateInput({
    ...input,
    requestFingerprint: "0".repeat(64),
  });
  return hashCreateInput(validated);
}

export async function computeMultiAgentReviewCompletionFingerprint(
  input: Omit<CompleteMultiAgentReviewTurnInput, "resultFingerprint">,
): Promise<string> {
  const validated = validateCompleteInput({
    ...input,
    resultFingerprint: "0".repeat(64),
  });
  return hashCompletionInput(validated);
}

async function hashCreateInput(input: ReturnType<typeof validateCreateInput>): Promise<string> {
  return sha256Hex(
    canonicalJson({
      schemaVersion: 1,
      id: input.id,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      restartOfSessionId: input.restartOfSessionId,
      mode: input.mode,
      target: input.target,
      userRequest: input.userRequest,
      attempt: input.attempt,
      limits: input.limits,
      participants: [...input.participants].sort(
        (left, right) =>
          left.ordinal - right.ordinal || left.participantId.localeCompare(right.participantId),
      ),
      startedAt: input.startedAt,
      deadlineAt: input.deadlineAt,
    }),
  );
}

async function hashCompletionInput(input: CompleteMultiAgentReviewTurnInput): Promise<string> {
  return sha256Hex(
    canonicalJson({
      schemaVersion: 1,
      sessionId: input.sessionId,
      turnId: input.turnId,
      expectedSessionRevision: input.expectedSessionRevision,
      serializedResponse: input.serializedResponse,
      publicMessage: input.publicMessage,
      needsInput: input.needsInput,
      usage: input.usage,
      conclusions: input.conclusions,
      completedAt: input.completedAt,
    }),
  );
}

async function hashFailureInput(input: ReturnType<typeof validateFailInput>): Promise<string> {
  return sha256Hex(
    canonicalJson({
      schemaVersion: 1,
      sessionId: input.sessionId,
      turnId: input.turnId,
      expectedSessionRevision: input.expectedSessionRevision,
      outcome: input.outcome,
      errorCode: input.errorCode,
      usage: input.usage,
      completedAt: input.completedAt,
    }),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function samePersistedUsage(
  turn: TurnRow,
  usage: ReturnType<typeof validateFailInput>["usage"],
): boolean {
  return usage === null
    ? turn.usage_source === "provider_unavailable" &&
        turn.input_tokens === null &&
        turn.output_tokens === null &&
        turn.cached_input_tokens === null &&
        turn.cost_micros === null
    : turn.usage_source === "provider_reported" &&
        turn.input_tokens === usage.inputTokens &&
        turn.output_tokens === usage.outputTokens &&
        turn.cached_input_tokens === usage.cachedInputTokens;
}

async function candidateReplayMatches(
  executor: TransactionExecutor,
  existing: CandidateRow,
  input: PublishMultiAgentReviewCandidateInput,
): Promise<boolean> {
  if (
    existing.id !== input.candidateId ||
    existing.payload_checksum !== input.payloadChecksum ||
    existing.payload_json !== input.payloadJson ||
    existing.chapter_candidate_id !== input.chapterCandidateId ||
    existing.created_at !== input.publishedAt
  ) {
    return false;
  }
  if (
    !(await auditEventMatches(
      executor,
      input.auditEventId,
      existing.project_id,
      "multi_agent_review",
      existing.session_id,
      "candidate_ready",
    ))
  ) {
    return false;
  }
  if (existing.target_kind === "chapter") {
    const rows = await executor.select<{
      content_checksum: string | null;
      created_at: string;
    }>(
      `SELECT content_checksum, created_at
       FROM ai_candidates
       WHERE id = ?`,
      [existing.chapter_candidate_id],
    );
    return (
      rows[0]?.content_checksum === input.chapterContentChecksum &&
      rows[0].created_at === input.publishedAt
    );
  }
  return input.chapterContentChecksum === null;
}

async function auditEventMatches(
  executor: TransactionExecutor,
  id: string,
  projectId: string,
  entityType: string,
  entityId: string,
  action: string,
): Promise<boolean> {
  const rows = await executor.select<{ matched: number }>(
    `SELECT COUNT(*) AS matched
     FROM local_audit_events
     WHERE id = ? AND project_id = ? AND entity_type = ?
       AND entity_id = ? AND action = ?`,
    [id, projectId, entityType, entityId, action],
  );
  return rows[0]?.matched === 1;
}

async function auditEventReceiptMatches(
  executor: TransactionExecutor,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly entityId: string;
    readonly action: string;
    readonly requestId: string;
    readonly createdAt: string;
  },
): Promise<boolean> {
  const rows = await executor.select<{ matched: number }>(
    `SELECT COUNT(*) AS matched
     FROM local_audit_events
     WHERE id = ? AND project_id = ?
       AND entity_type = 'multi_agent_review_candidate'
       AND entity_id = ? AND action = ? AND request_id = ? AND created_at = ?`,
    [input.id, input.projectId, input.entityId, input.action, input.requestId, input.createdAt],
  );
  return rows[0]?.matched === 1;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 20) {
    throw invalidInput("A JSON value exceeds the supported nesting depth.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidInput("A JSON value contains a non-finite number.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) {
    throw invalidInput("A JSON value contains an unsupported type.");
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw invalidInput("A JSON value contains a prohibited object key.");
    }
    result[key] = canonicalizeJsonValue(value[key], depth + 1);
  }
  return result;
}

function parseJson(value: string, field: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    canonicalizeJsonValue(parsed);
    return parsed;
  } catch (cause: unknown) {
    if (cause instanceof MultiAgentReviewStoreError) {
      throw cause;
    }
    throw storeError("MULTI_AGENT_CORRUPT", `${field} contains invalid JSON.`);
  }
}

function parseJsonObject(value: string, field: string): Record<string, unknown> {
  const parsed = parseJson(value, field);
  if (!isRecord(parsed)) {
    throw storeError("MULTI_AGENT_CORRUPT", `${field} is not a JSON object.`);
  }
  return parsed;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidInput(`${field} contains missing or unexpected fields.`);
  }
}

function requireJsonObjectText(value: unknown, maximumLength: number, field: string): string {
  const text = requireText(value, 1, maximumLength, field);
  parseJsonObject(text, field);
  return text;
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u.test(value)
  ) {
    throw invalidInput(`${field} must be a bounded portable identifier.`);
  }
  return value;
}

function requireChecksum(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidInput(`${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireErrorCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(value)) {
    throw invalidInput(`${field} must be a bounded stable error code.`);
  }
  return value;
}

function requireCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) {
    throw invalidInput("Review currency must be a three-letter ISO code.");
  }
  return value;
}

function requireEndpointUrl(value: unknown): string {
  const text = requireText(value, 1, 2_048, "participant.endpointUrl");
  if (
    text.trim() !== text ||
    text.includes("%") ||
    text.includes("\\") ||
    text.includes("/../") ||
    text.includes("/./") ||
    text.endsWith("/..") ||
    text.endsWith("/.")
  ) {
    throw invalidInput("A model endpoint URL does not satisfy the network safety policy.");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalidInput("A model endpoint URL is invalid.");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.port === "0"
  ) {
    throw invalidInput("A model endpoint URL contains disallowed credentials or fragments.");
  }
  const queryEntries = [...url.searchParams.entries()];
  if (
    queryEntries.length > 1 ||
    queryEntries.some(
      ([key, apiVersion]) => key.toLowerCase() !== "api-version" || !isSafeApiVersion(apiVersion),
    )
  ) {
    throw invalidInput("A model endpoint URL contains an unsafe query parameter.");
  }
  return url.toString().replace(/\/$/u, "");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) &&
    octets[0] === "127"
  );
}

function isSafeApiVersion(value: string): boolean {
  if (value.length < 1 || value.length > 32) {
    return false;
  }
  const dateMatch = /^(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(?:-preview)?$/u.exec(
    value,
  );
  if (dateMatch !== null) {
    const date = dateMatch[1];
    return (
      date !== undefined && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
    );
  }
  return /^v?\d{1,4}(?:[.-]\d{1,4}){0,3}$/u.test(value);
}

function requireText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value) ||
    /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(value)
  ) {
    throw invalidInput(`${field} contains invalid or unsafe text.`);
  }
  const normalized = value.normalize("NFC");
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw invalidInput(`${field} has an invalid normalized length.`);
  }
  return normalized;
}

function requireTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw invalidInput(`${field} must be a canonical UTC timestamp.`);
  }
  return value;
}

function requireInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidInput(`${field} is outside its integer boundary.`);
  }
  return value;
}

function requireNullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number | null {
  return value === null ? null : requireInteger(value, minimum, maximum, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidInput(`${field} must be a boolean.`);
  }
  return value;
}

function requireBooleanInteger(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw storeError("MULTI_AGENT_CORRUPT", `${field} is not a SQLite boolean.`);
  }
  return value === 1;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw invalidInput(`${field} is invalid.`);
  }
  return value;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionConflict(expected: number, actual: number): MultiAgentReviewStoreError {
  return storeError(
    "MULTI_AGENT_REVISION_CONFLICT",
    `The review revision changed (expected ${String(expected)}, actual ${String(actual)}).`,
    true,
  );
}

function invalidInput(message: string): MultiAgentReviewStoreError {
  return storeError("MULTI_AGENT_INVALID_INPUT", message);
}

function storeError(
  code: MultiAgentReviewStoreErrorCode,
  message: string,
  retryable = false,
): MultiAgentReviewStoreError {
  return new MultiAgentReviewStoreError(code, message, retryable);
}
