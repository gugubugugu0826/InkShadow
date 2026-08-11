import {
  NOVEL_SKILL_EVALUATION_METRICS,
  NOVEL_SKILL_EVALUATION_ARMS,
  listNovelSkillEvaluationFixtures,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

import type { NovelSkillPaidBlindReviewSourceItem } from "./novel-skill-paid-blind-review-service";

import {
  NovelSkillEvaluationStoreError,
  type NovelSkillEvaluationStoreErrorCode,
} from "./novel-skill-evaluation-sqlite-store";

const PAID_EVALUATION_CALL_COUNT = 192 as const;
type PaidEvaluationRubricVersion = "novel-skill-human-rubric@1";
const NOVEL_SKILL_PAID_EVALUATION_SCORE_COUNT =
  PAID_EVALUATION_CALL_COUNT * NOVEL_SKILL_EVALUATION_METRICS.length;
const MAXIMUM_BLIND_REVIEW_TEXT_CHARACTERS = 2_000_000;
const BLIND_REVIEW_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export type NovelSkillPaidEvaluationRunStatus = "planned" | "running" | "completed" | "invalidated";

export type NovelSkillPaidEvaluationEvaluationStatus =
  "NOT_EVALUATED" | "EVIDENCE_INCOMPLETE" | "FAILED" | "ELIGIBLE_FOR_REVIEW";

export type NovelSkillPaidEvaluationReservationState =
  "reserved" | "bound" | "dispatched" | "settled" | "ambiguous" | "not_dispatched";

export interface NovelSkillPaidEvaluationReservationCounts {
  readonly reserved: number;
  readonly bound: number;
  readonly dispatched: number;
  readonly settled: number;
  readonly ambiguous: number;
  readonly notDispatched: number;
}

/** Content-free aggregate suitable for an expert control surface. */
export interface NovelSkillPaidEvaluationControlSnapshot {
  readonly runId: string;
  readonly suiteId: string;
  readonly status: NovelSkillPaidEvaluationRunStatus;
  readonly evaluationStatus: NovelSkillPaidEvaluationEvaluationStatus;
  readonly revision: number;
  readonly protocolConfigured: boolean;
  readonly exactTargetCount: number;
  readonly authorizationId: string | null;
  readonly authorizedCallCount: number | null;
  readonly totalCells: number;
  readonly observedCells: number;
  readonly observationCount: number;
  readonly reservationCounts: NovelSkillPaidEvaluationReservationCounts;
  readonly authoritySnapshotCount: number;
  readonly missingAuthoritySnapshotCount: number;
  readonly successfulSettlements: number;
  readonly blindItemCount: number;
  readonly blindReceiptCount: number;
  readonly sealedScoreCount: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export type NovelSkillPaidEvaluationRecoveryKind =
  | "preflight_or_authorization"
  | "authorized_not_started"
  | "safe_local_resume"
  | "manual_dispatch_decision"
  | "blind_review";

export interface NovelSkillPaidEvaluationRecoverableRun {
  readonly runId: string;
  readonly status: "planned" | "running";
  readonly revision: number;
  readonly authorizationId: string | null;
  readonly authorizedCallCount: number | null;
  readonly completedProviderCalls: number;
  readonly observationCount: number;
  readonly blindReceiptCount: number;
  readonly reservationCounts: NovelSkillPaidEvaluationReservationCounts;
  readonly recoveryKind: NovelSkillPaidEvaluationRecoveryKind;
  readonly requiresManualDispatchDecision: boolean;
  readonly startedAt: string | null;
  readonly createdAt: string;
}

/** Exact commercial target metadata; never includes credentials, endpoints or content. */
export interface NovelSkillPaidEvaluationControlTarget {
  readonly runId: string;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: string;
  readonly connectionProtocol: "openai_compatible" | "anthropic" | "gemini" | "ollama";
  readonly connectionRevision: number;
  readonly catalogRevision: number;
  readonly providerModelId: string;
  readonly modelIdentityHash: string;
  readonly modelArtifactHash: string;
  readonly targetHash: string;
  readonly currency: string;
  readonly inputMicrosPerMillionTokens: string;
  readonly outputMicrosPerMillionTokens: string;
  readonly cachedInputMicrosPerMillionTokens: string | null;
  readonly pricingVersion: string;
  readonly pricingSnapshotHash: string;
}

export interface NovelSkillPaidEvaluationControlReservation {
  readonly reservationId: string;
  readonly runId: string;
  readonly cellId: string;
  readonly attemptId: string;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly dispatchGeneration: number;
  readonly state: NovelSkillPaidEvaluationReservationState;
  readonly plannedContextTraceId: string;
  readonly plannedModelInvocationId: string;
  readonly plannedCandidateId: string;
  readonly currency: string;
  readonly reservedMaximumCostMicros: string;
  readonly exactPredispatchEstimatedMaximumCostMicros: string | null;
  readonly authoritySnapshotHash: string | null;
  readonly providerReceiptShapeHash: string | null;
  readonly finalDispatchAuthorityHash: string | null;
  readonly actualCostMicros: string | null;
  readonly settlementOutcome:
    "succeeded" | "failed" | "cancelled" | "timed_out" | "policy_blocked" | null;
  /** A local observation digest. It is not represented as a provider signature. */
  readonly settlementReceiptHash: string | null;
  readonly visibleOutputHash: string | null;
  readonly outputCandidateId: string | null;
  readonly reservedAt: string;
  readonly boundAt: string | null;
  readonly dispatchedAt: string | null;
  readonly terminalAt: string | null;
  readonly revision: number;
}

/** A successfully settled cell whose local observation ledger still needs repair. */
export interface NovelSkillPaidEvaluationSettledUnobserved {
  readonly reservationId: string;
  readonly runId: string;
  readonly cellId: string;
  readonly attemptId: string;
  readonly contextTraceId: string;
  readonly modelInvocationId: string;
  readonly outputCandidateId: string;
  readonly terminalAt: string;
  readonly revision: number;
}

/**
 * Content-free authority needed after a run can no longer be requoted. It
 * lets restart recovery reuse the exact persisted protocol and authorization.
 */
export interface NovelSkillPaidEvaluationExecutionAuthority {
  readonly runId: string;
  readonly status: NovelSkillPaidEvaluationRunStatus;
  readonly protocolHash: string;
  readonly authorizationId: string | null;
  readonly quoteHash: string | null;
}

export interface CreateNovelSkillPaidEvaluationBlindReviewBatchInput {
  readonly batchId: string;
  readonly runId: string;
  readonly reviewerId: string;
  readonly createdAt: string;
}

/**
 * Injected only at the local persistence boundary. Production uses Web Crypto;
 * tests may provide a deterministic 32-byte source. The seed is never stored.
 */
export type NovelSkillPaidEvaluationBlindRandomSource = (byteLength: number) => Uint8Array;

export interface ReadNovelSkillPaidEvaluationBlindReviewInput {
  readonly batchId: string;
  readonly reviewerId: string;
}

export type NovelSkillPaidEvaluationBlindReviewScores = Readonly<
  Record<NovelSkillEvaluationMetric, number | null>
>;

/** The reviewer boundary extends the shared safe source contract only with local scores. */
export type NovelSkillPaidEvaluationBlindReviewItem = Readonly<
  NovelSkillPaidBlindReviewSourceItem & {
    readonly scores: NovelSkillPaidEvaluationBlindReviewScores;
  }
>;

/** No observation mapping, model slot or arm is returned to the reviewer-facing caller. */
export interface NovelSkillPaidEvaluationBlindReviewBatchRecord {
  readonly batchId: string;
  readonly runId: string;
  readonly reviewerId: string;
  readonly itemCount: typeof PAID_EVALUATION_CALL_COUNT;
  readonly observationSetHash: string;
  readonly assignmentManifestHash: string;
  readonly createdAt: string;
}

export interface SealNovelSkillPaidEvaluationBlindScoresInput {
  readonly batchId: string;
  readonly blindItemId: string;
  readonly reviewerId: string;
  readonly scores: Readonly<Record<NovelSkillEvaluationMetric, number>>;
  readonly scoredAt: string;
  readonly sealedAt: string;
}

/** Content-free proof that one anonymous item's exact rubric was sealed. */
export interface NovelSkillPaidEvaluationBlindScoreReceipt {
  readonly batchId: string;
  readonly blindItemId: string;
  readonly reviewerId: string;
  readonly rubricVersion: PaidEvaluationRubricVersion;
  readonly metricCount: typeof NOVEL_SKILL_EVALUATION_METRICS.length;
  readonly scoresManifestHash: string;
  readonly scoredAt: string;
  readonly sealedAt: string;
}

interface ControlSnapshotRow {
  readonly run_id: string;
  readonly suite_id: string;
  readonly status: NovelSkillPaidEvaluationRunStatus;
  readonly evaluation_status: NovelSkillPaidEvaluationEvaluationStatus;
  readonly revision: number;
  readonly protocol_configured: number;
  readonly target_count: number;
  readonly authorization_id: string | null;
  readonly authorized_call_count: number | null;
  readonly total_cells: number;
  readonly observed_cells: number;
  readonly observation_count: number;
  readonly reserved_count: number;
  readonly bound_count: number;
  readonly dispatched_count: number;
  readonly settled_count: number;
  readonly ambiguous_count: number;
  readonly not_dispatched_count: number;
  readonly authority_snapshot_count: number;
  readonly missing_authority_snapshot_count: number;
  readonly successful_settlement_count: number;
  readonly blind_item_count: number;
  readonly blind_receipt_count: number;
  readonly sealed_score_count: number;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
}

interface RecoverableRunRow {
  readonly run_id: string;
  readonly status: "planned" | "running";
  readonly revision: number;
  readonly authorization_id: string | null;
  readonly authorized_call_count: number | null;
  readonly reserved_count: number;
  readonly bound_count: number;
  readonly dispatched_count: number;
  readonly settled_count: number;
  readonly ambiguous_count: number;
  readonly not_dispatched_count: number;
  readonly successful_settlement_count: number;
  readonly observation_count: number;
  readonly blind_receipt_count: number;
  readonly started_at: string | null;
  readonly created_at: string;
}

interface ExecutionAuthorityRow {
  readonly run_id: string;
  readonly status: NovelSkillPaidEvaluationRunStatus;
  readonly execution_protocol_hash: string;
  readonly authorization_id: string | null;
  readonly authorized_quote_hash: string | null;
}

interface TargetRow {
  readonly run_id: string;
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly connection_id: string;
  readonly catalog_entry_id: string;
  readonly provider_kind_snapshot: string;
  readonly connection_protocol_snapshot: NovelSkillPaidEvaluationControlTarget["connectionProtocol"];
  readonly connection_revision: number;
  readonly catalog_revision: number;
  readonly provider_model_id_snapshot: string;
  readonly model_identity_hash: string;
  readonly model_artifact_hash: string;
  readonly target_hash: string;
  readonly currency: string;
  readonly input_micros_per_million_tokens: string;
  readonly output_micros_per_million_tokens: string;
  readonly cached_input_micros_per_million_tokens: string | null;
  readonly pricing_version: string;
  readonly pricing_snapshot_hash: string;
}

interface ReservationControlRow {
  readonly id: string;
  readonly run_id: string;
  readonly cell_id: string;
  readonly attempt_id: string;
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly dispatch_generation: number;
  readonly state: NovelSkillPaidEvaluationReservationState;
  readonly planned_context_trace_id: string;
  readonly planned_model_invocation_id: string;
  readonly planned_candidate_id: string;
  readonly currency: string;
  readonly reserved_max_cost_micros: string;
  readonly exact_predispatch_estimated_max_cost_micros: string | null;
  readonly authority_snapshot_hash: string | null;
  readonly provider_receipt_shape_hash: string | null;
  readonly final_dispatch_authority_hash: string | null;
  readonly actual_cost_micros: string | null;
  readonly settlement_outcome: NovelSkillPaidEvaluationControlReservation["settlementOutcome"];
  readonly provider_receipt_hash: string | null;
  readonly provider_visible_output_hash: string | null;
  readonly output_candidate_id: string | null;
  readonly reserved_at: string;
  readonly bound_at: string | null;
  readonly dispatched_at: string | null;
  readonly terminal_at: string | null;
  readonly revision: number;
}

interface SettledUnobservedRow {
  readonly reservation_id: string;
  readonly run_id: string;
  readonly cell_id: string;
  readonly attempt_id: string;
  readonly context_trace_id: string;
  readonly model_invocation_id: string;
  readonly output_candidate_id: string;
  readonly terminal_at: string;
  readonly revision: number;
}

interface BlindProtocolRow {
  readonly protocol_hash: string;
  readonly rubric_version: PaidEvaluationRubricVersion;
  readonly rubric_content_hash: string;
  readonly blinding_protocol_version: string;
  readonly blinding_protocol_hash: string;
  readonly randomization_protocol_version: string;
  readonly randomization_protocol_hash: string;
}

interface BlindObservationRow {
  readonly id: string;
  readonly result_hash: string;
  readonly fixture_id: string;
  readonly arm: "no_skill" | "core" | "core_genre" | "core_genre_preferences";
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly repetition: number;
}

interface ExistingBlindBatchRow {
  readonly id: string;
  readonly run_id: string;
  readonly reviewer_id: string;
  readonly observation_set_hash: string;
  readonly assignment_manifest_hash: string;
  readonly created_at: string;
  readonly item_count: number;
  readonly position_count: number;
  readonly observation_count: number;
}

interface BlindReviewProjectionRow {
  readonly blind_item_id: string;
  readonly randomized_position: number;
  readonly fixture_id: string;
  readonly candidate_output: string;
  readonly metric: NovelSkillEvaluationMetric | null;
  readonly score_basis_points: number | null;
}

interface BlindScoreWorkRow {
  readonly run_id: string;
  readonly reviewer_id: string;
  readonly rubric_version: PaidEvaluationRubricVersion;
  readonly rubric_content_hash: string;
  readonly observation_id: string;
  readonly cell_id: string;
  readonly cell_state: "planned" | "observed" | "invalidated";
  readonly assigned_at: string;
  readonly receipt_scores_manifest_hash: string | null;
  readonly receipt_scored_at: string | null;
  readonly receipt_sealed_at: string | null;
  readonly persisted_score_count: number;
}

/**
 * Content-free control plus an allowlisted reviewer projection for the paid
 * 0063 workflow. Candidate text crosses only the reviewer-safe methods; no
 * reviewer-safe method returns an observation, arm, model, slot, repetition,
 * cost or hash.
 */
export class NovelSkillPaidEvaluationControlSqliteStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly blindRandomSource: NovelSkillPaidEvaluationBlindRandomSource = secureBlindRandomBytes,
  ) {}

  public async getControlSnapshot(
    runId: string,
  ): Promise<NovelSkillPaidEvaluationControlSnapshot | null> {
    assertUuidV7(runId, "runId");
    const rows = await this.executor.select<ControlSnapshotRow>(CONTROL_SNAPSHOT_SELECT, [runId]);
    if (rows.length > 1) throw conflict("The paid evaluation run is not unique.");
    return rows[0] === undefined ? null : mapControlSnapshot(rows[0]);
  }

  public async listRecoverableRuns(): Promise<readonly NovelSkillPaidEvaluationRecoverableRun[]> {
    const rows = await this.executor.select<RecoverableRunRow>(RECOVERABLE_RUNS_SELECT);
    return rows.map(mapRecoverableRun);
  }

  public async readExecutionAuthority(
    runId: string,
  ): Promise<NovelSkillPaidEvaluationExecutionAuthority | null> {
    assertUuidV7(runId, "runId");
    const rows = await this.executor.select<ExecutionAuthorityRow>(EXECUTION_AUTHORITY_SELECT, [
      runId,
    ]);
    if (rows.length > 1) throw conflict("The paid evaluation execution authority is not unique.");
    const row = rows[0];
    if (row === undefined) return null;
    assertHash(row.execution_protocol_hash, "execution protocolHash");
    if ((row.authorization_id === null) !== (row.authorized_quote_hash === null)) {
      throw conflict("The paid evaluation authorization authority is incomplete.");
    }
    if (row.authorization_id !== null) {
      assertUuidV7(row.authorization_id, "authorizationId");
      if (row.authorized_quote_hash === null) {
        throw conflict("The paid evaluation authorization quote is missing.");
      }
      assertHash(row.authorized_quote_hash, "authorized quoteHash");
    }
    return {
      runId: row.run_id,
      status: row.status,
      protocolHash: row.execution_protocol_hash,
      authorizationId: row.authorization_id,
      quoteHash: row.authorized_quote_hash,
    };
  }

  public async listTargets(
    runId: string,
  ): Promise<readonly NovelSkillPaidEvaluationControlTarget[]> {
    assertUuidV7(runId, "runId");
    const rows = await this.executor.select<TargetRow>(TARGETS_SELECT, [runId]);
    return rows.map(mapTarget);
  }

  public async listReservations(
    runId: string,
  ): Promise<readonly NovelSkillPaidEvaluationControlReservation[]> {
    assertUuidV7(runId, "runId");
    const rows = await this.executor.select<ReservationControlRow>(RESERVATIONS_SELECT, [runId]);
    return rows.map(mapReservation);
  }

  public async listSettledUnobserved(
    runId: string,
  ): Promise<readonly NovelSkillPaidEvaluationSettledUnobserved[]> {
    assertUuidV7(runId, "runId");
    const rows = await this.executor.select<SettledUnobservedRow>(SETTLED_UNOBSERVED_SELECT, [
      runId,
    ]);
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      runId: row.run_id,
      cellId: row.cell_id,
      attemptId: row.attempt_id,
      contextTraceId: row.context_trace_id,
      modelInvocationId: row.model_invocation_id,
      outputCandidateId: row.output_candidate_id,
      terminalAt: row.terminal_at,
      revision: row.revision,
    }));
  }

  public async createBlindReviewBatch(
    input: CreateNovelSkillPaidEvaluationBlindReviewBatchInput,
  ): Promise<NovelSkillPaidEvaluationBlindReviewBatchRecord> {
    assertExactKeys(input, ["batchId", "runId", "reviewerId", "createdAt"], "blind review batch");
    assertUuidV7(input.batchId, "batchId");
    assertUuidV7(input.runId, "runId");
    assertReviewerId(input.reviewerId);
    assertIsoUtc(input.createdAt, "createdAt");

    return this.executor.transaction(async (transaction) => {
      const existing = await readExistingBlindBatch(transaction, input);
      if (existing !== null) return existing;

      const protocol = await readBlindProtocol(transaction, input.runId);
      const observations = await transaction.select<BlindObservationRow>(
        `SELECT observation.id, observation.result_hash,
                cell.fixture_id, cell.arm, cell.model_slot_id, cell.repetition
         FROM novel_skill_evaluation_observations AS observation
         INNER JOIN novel_skill_evaluation_cells AS cell
           ON cell.id = observation.cell_id AND cell.run_id = observation.run_id
         WHERE observation.run_id = ?
         ORDER BY observation.id ASC`,
        [input.runId],
      );
      assertExactObservationSet(observations);

      const observationSetHash = await hashCanonical({
        kind: "novel_skill_paid_blind_observation_set",
        schemaVersion: 1,
        runId: input.runId,
        observations: observations.map((observation) => ({
          observationId: observation.id,
          resultHash: observation.result_hash,
        })),
      });
      const seed = readBlindRandomSeed(this.blindRandomSource);
      const randomizationSeedHash = await sha256Bytes(seed);
      const positionedAssignments = await randomizeBlindAssignments(input, observations, seed);
      const assignmentManifestHash = await hashCanonical({
        kind: "novel_skill_paid_blind_assignment_manifest",
        schemaVersion: 1,
        batchId: input.batchId,
        runId: input.runId,
        assignments: positionedAssignments,
      });

      const batch = await transaction.execute(
        `INSERT INTO novel_skill_evaluation_review_batches (
           id, run_id, protocol_hash, rubric_version, rubric_content_hash,
           blinding_protocol_version, blinding_protocol_hash,
           randomization_protocol_version, randomization_protocol_hash,
           randomization_seed_hash, observation_set_hash, assignment_manifest_hash,
           reviewer_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.runId,
          protocol.protocol_hash,
          protocol.rubric_version,
          protocol.rubric_content_hash,
          protocol.blinding_protocol_version,
          protocol.blinding_protocol_hash,
          protocol.randomization_protocol_version,
          protocol.randomization_protocol_hash,
          randomizationSeedHash,
          observationSetHash,
          assignmentManifestHash,
          input.reviewerId,
          input.createdAt,
        ],
      );
      assertSingleWrite(batch.rowsAffected, "The blinded review batch changed concurrently.");

      for (const assignment of positionedAssignments) {
        const item = await transaction.execute(
          `INSERT INTO novel_skill_evaluation_review_items (
             batch_id, blind_item_id, observation_id, randomized_position,
             evidence_hash, assigned_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.batchId,
            assignment.blindItemId,
            assignment.observationId,
            assignment.randomizedPosition,
            assignment.evidenceHash,
            input.createdAt,
          ],
        );
        assertSingleWrite(item.rowsAffected, "A blinded review assignment changed concurrently.");
      }

      return {
        batchId: input.batchId,
        runId: input.runId,
        reviewerId: input.reviewerId,
        itemCount: PAID_EVALUATION_CALL_COUNT,
        observationSetHash,
        assignmentManifestHash,
        createdAt: input.createdAt,
      };
    });
  }

  public async readBlindReviewBatch(
    input: ReadNovelSkillPaidEvaluationBlindReviewInput,
  ): Promise<readonly NovelSkillPaidEvaluationBlindReviewItem[]> {
    assertBlindReviewReadInput(input);
    const rows = await this.executor.select<BlindReviewProjectionRow>(
      BLIND_REVIEW_PROJECTION_SELECT,
      [input.batchId, input.reviewerId],
    );
    return projectBlindReviewItems(rows, true);
  }

  public async getNextBlindReviewItem(
    input: ReadNovelSkillPaidEvaluationBlindReviewInput,
  ): Promise<NovelSkillPaidEvaluationBlindReviewItem | null> {
    assertBlindReviewReadInput(input);
    const rows = await this.executor.select<BlindReviewProjectionRow>(
      BLIND_REVIEW_PROJECTION_SELECT,
      [input.batchId, input.reviewerId],
    );
    const items = projectBlindReviewItems(rows, true);
    return (
      items.find((item) => Object.values(item.scores).every((score) => score === null)) ?? null
    );
  }

  public async sealBlindScores(
    input: SealNovelSkillPaidEvaluationBlindScoresInput,
  ): Promise<NovelSkillPaidEvaluationBlindScoreReceipt> {
    assertExactKeys(
      input,
      ["batchId", "blindItemId", "reviewerId", "scores", "scoredAt", "sealedAt"],
      "blind score receipt",
    );
    assertUuidV7(input.batchId, "batchId");
    assertBlindItemId(input.blindItemId);
    assertReviewerId(input.reviewerId);
    assertScores(input.scores);
    assertIsoUtc(input.scoredAt, "scoredAt");
    assertIsoUtc(input.sealedAt, "sealedAt");
    if (input.sealedAt < input.scoredAt) {
      throw invalid("sealedAt must not precede scoredAt.");
    }

    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<BlindScoreWorkRow>(
        `SELECT batch.run_id, batch.reviewer_id, batch.rubric_version,
                batch.rubric_content_hash, item.observation_id,
                observation.cell_id, cell.state AS cell_state, item.assigned_at,
                receipt.scores_manifest_hash AS receipt_scores_manifest_hash,
                receipt.scored_at AS receipt_scored_at,
                receipt.sealed_at AS receipt_sealed_at,
                (SELECT count(*) FROM novel_skill_evaluation_scores AS score
                 WHERE score.observation_id = observation.id
                   AND score.reviewer_id = batch.reviewer_id
                   AND score.rubric_version = batch.rubric_version) AS persisted_score_count
         FROM novel_skill_evaluation_review_batches AS batch
         INNER JOIN novel_skill_evaluation_review_items AS item
           ON item.batch_id = batch.id
         INNER JOIN novel_skill_evaluation_observations AS observation
           ON observation.id = item.observation_id AND observation.run_id = batch.run_id
         INNER JOIN novel_skill_evaluation_cells AS cell
           ON cell.id = observation.cell_id AND cell.run_id = batch.run_id
         LEFT JOIN novel_skill_evaluation_review_receipts AS receipt
           ON receipt.batch_id = batch.id AND receipt.blind_item_id = item.blind_item_id
         WHERE batch.id = ? AND batch.reviewer_id = ? AND item.blind_item_id = ?`,
        [input.batchId, input.reviewerId, input.blindItemId],
      );
      if (rows.length !== 1 || rows[0] === undefined) {
        throw conflict("The anonymous review item is missing, sealed, or no longer active.");
      }
      const work = rows[0];
      if (input.scoredAt < work.assigned_at) {
        throw invalid("scoredAt must not precede the blinded assignment.");
      }

      const scoreManifest = NOVEL_SKILL_EVALUATION_METRICS.map((metric) => ({
        metric,
        scoreBasisPoints: Math.round(input.scores[metric] * 10_000),
      }));
      const scoresManifestHash = await hashCanonical({
        kind: "novel_skill_paid_blind_scores",
        schemaVersion: 1,
        batchId: input.batchId,
        blindItemId: input.blindItemId,
        reviewerId: work.reviewer_id,
        rubricVersion: work.rubric_version,
        scores: scoreManifest,
        scoredAt: input.scoredAt,
      });

      if (work.cell_state === "observed") {
        if (
          work.receipt_scores_manifest_hash === scoresManifestHash &&
          work.receipt_scored_at === input.scoredAt &&
          work.receipt_sealed_at === input.sealedAt &&
          work.persisted_score_count === NOVEL_SKILL_EVALUATION_METRICS.length
        ) {
          return {
            batchId: input.batchId,
            blindItemId: input.blindItemId,
            reviewerId: work.reviewer_id,
            rubricVersion: work.rubric_version,
            metricCount: NOVEL_SKILL_EVALUATION_METRICS.length,
            scoresManifestHash,
            scoredAt: input.scoredAt,
            sealedAt: input.sealedAt,
          };
        }
        throw conflict("The anonymous review item was already sealed with different evidence.");
      }
      if (
        work.cell_state !== "planned" ||
        work.receipt_scores_manifest_hash !== null ||
        work.receipt_scored_at !== null ||
        work.receipt_sealed_at !== null ||
        work.persisted_score_count !== 0
      ) {
        throw conflict("The anonymous review item has inconsistent persisted score evidence.");
      }

      for (const score of scoreManifest) {
        const inserted = await transaction.execute(
          `INSERT INTO novel_skill_evaluation_scores (
             observation_id, metric, score_basis_points, reviewer_id,
             rubric_version, scored_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            work.observation_id,
            score.metric,
            score.scoreBasisPoints,
            work.reviewer_id,
            work.rubric_version,
            input.scoredAt,
          ],
        );
        assertSingleWrite(inserted.rowsAffected, "A blinded rubric score changed concurrently.");
      }

      const receipt = await transaction.execute(
        `INSERT INTO novel_skill_evaluation_review_receipts (
           batch_id, blind_item_id, observation_id, reviewer_id, rubric_version,
           rubric_content_hash, scores_manifest_hash, scored_at, sealed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.batchId,
          input.blindItemId,
          work.observation_id,
          work.reviewer_id,
          work.rubric_version,
          work.rubric_content_hash,
          scoresManifestHash,
          input.scoredAt,
          input.sealedAt,
        ],
      );
      assertSingleWrite(receipt.rowsAffected, "The blinded review receipt changed concurrently.");

      const cell = await transaction.execute(
        `UPDATE novel_skill_evaluation_cells
         SET state = 'observed'
         WHERE id = ? AND run_id = ? AND state = 'planned'`,
        [work.cell_id, work.run_id],
      );
      assertSingleWrite(cell.rowsAffected, "The reviewed evaluation cell changed concurrently.");

      return {
        batchId: input.batchId,
        blindItemId: input.blindItemId,
        reviewerId: work.reviewer_id,
        rubricVersion: work.rubric_version,
        metricCount: NOVEL_SKILL_EVALUATION_METRICS.length,
        scoresManifestHash,
        scoredAt: input.scoredAt,
        sealedAt: input.sealedAt,
      };
    });
  }
}

const CONTROL_SNAPSHOT_SELECT = `
  SELECT run.id AS run_id, run.suite_id, run.status, run.evaluation_status, run.revision,
         CASE WHEN protocol.suite_id IS NULL THEN 0 ELSE 1 END AS protocol_configured,
         (SELECT count(*) FROM novel_skill_evaluation_run_model_targets AS target
          WHERE target.run_id = run.id) AS target_count,
         authorization.id AS authorization_id,
         authorization.authorized_call_count,
         (SELECT count(*) FROM novel_skill_evaluation_cells AS cell
          WHERE cell.run_id = run.id) AS total_cells,
         (SELECT count(*) FROM novel_skill_evaluation_cells AS cell
          WHERE cell.run_id = run.id AND cell.state = 'observed') AS observed_cells,
         (SELECT count(*) FROM novel_skill_evaluation_observations AS observation
          WHERE observation.run_id = run.id) AS observation_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'reserved') AS reserved_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'bound') AS bound_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'dispatched') AS dispatched_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'settled') AS settled_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'ambiguous') AS ambiguous_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'not_dispatched') AS not_dispatched_count,
         (SELECT count(*)
          FROM novel_skill_evaluation_predispatch_authority_snapshots AS snapshot
          WHERE snapshot.run_id = run.id) AS authority_snapshot_count,
         (SELECT count(*)
          FROM novel_skill_evaluation_dispatch_reservations AS reservation
          LEFT JOIN novel_skill_evaluation_predispatch_authority_snapshots AS snapshot
            ON snapshot.reservation_id = reservation.id
          WHERE reservation.run_id = run.id AND snapshot.reservation_id IS NULL)
           AS missing_authority_snapshot_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'settled'
            AND reservation.settlement_outcome = 'succeeded') AS successful_settlement_count,
         (SELECT count(*) FROM novel_skill_evaluation_review_items AS item
          INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = item.batch_id
          WHERE batch.run_id = run.id) AS blind_item_count,
         (SELECT count(*) FROM novel_skill_evaluation_review_receipts AS receipt
          INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = receipt.batch_id
          WHERE batch.run_id = run.id) AS blind_receipt_count,
         (SELECT count(*) FROM novel_skill_evaluation_scores AS score
          INNER JOIN novel_skill_evaluation_observations AS observation
            ON observation.id = score.observation_id
          WHERE observation.run_id = run.id) AS sealed_score_count,
         run.started_at, run.completed_at, run.created_at
  FROM novel_skill_evaluation_runs AS run
  LEFT JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
  LEFT JOIN novel_skill_evaluation_dispatch_authorizations AS authorization
    ON authorization.run_id = run.id
  WHERE run.id = ?`;

const RECOVERABLE_RUNS_SELECT = `
  SELECT run.id AS run_id, run.status, run.revision,
         authorization.id AS authorization_id, authorization.authorized_call_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'reserved') AS reserved_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'bound') AS bound_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'dispatched') AS dispatched_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'settled') AS settled_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'ambiguous') AS ambiguous_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'not_dispatched') AS not_dispatched_count,
         (SELECT count(*) FROM novel_skill_evaluation_dispatch_reservations AS reservation
          WHERE reservation.run_id = run.id AND reservation.state = 'settled'
            AND reservation.settlement_outcome = 'succeeded') AS successful_settlement_count,
         (SELECT count(*) FROM novel_skill_evaluation_observations AS observation
          WHERE observation.run_id = run.id) AS observation_count,
         (SELECT count(*) FROM novel_skill_evaluation_review_receipts AS receipt
          INNER JOIN novel_skill_evaluation_review_batches AS batch ON batch.id = receipt.batch_id
          WHERE batch.run_id = run.id) AS blind_receipt_count,
         run.started_at, run.created_at
  FROM novel_skill_evaluation_runs AS run
  INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
  LEFT JOIN novel_skill_evaluation_dispatch_authorizations AS authorization
    ON authorization.run_id = run.id
  WHERE run.status IN ('planned','running')
  ORDER BY run.created_at ASC, run.id ASC`;

const EXECUTION_AUTHORITY_SELECT = `
  SELECT run.id AS run_id, run.status,
         protocol.protocol_hash AS execution_protocol_hash,
         authorization.id AS authorization_id,
         authorization.quote_hash AS authorized_quote_hash
  FROM novel_skill_evaluation_runs AS run
  INNER JOIN novel_skill_evaluation_protocols AS protocol
    ON protocol.suite_id = run.suite_id
  LEFT JOIN novel_skill_evaluation_dispatch_authorizations AS authorization
    ON authorization.run_id = run.id
  WHERE run.id = ?`;

const TARGETS_SELECT = `
  SELECT target.run_id, target.model_slot_id, target.connection_id, target.catalog_entry_id,
         target.provider_kind_snapshot, target.connection_protocol_snapshot,
         target.connection_revision, target.catalog_revision, target.provider_model_id_snapshot,
         target.model_identity_hash, target.model_artifact_hash, target.target_hash,
         target.currency, target.input_micros_per_million_tokens,
         target.output_micros_per_million_tokens,
         target.cached_input_micros_per_million_tokens, target.pricing_version,
         target.pricing_snapshot_hash
  FROM novel_skill_evaluation_run_model_targets AS target
  WHERE target.run_id = ?
  ORDER BY target.model_slot_id ASC`;

const RESERVATIONS_SELECT = `
  SELECT reservation.id, reservation.run_id, reservation.cell_id, reservation.attempt_id,
         reservation.model_slot_id, reservation.dispatch_generation, reservation.state,
         reservation.planned_context_trace_id, reservation.planned_model_invocation_id,
         reservation.planned_candidate_id, reservation.currency,
         reservation.reserved_max_cost_micros, reservation.actual_cost_micros,
         snapshot.exact_predispatch_estimated_max_cost_micros,
         snapshot.authority_snapshot_hash, snapshot.provider_receipt_shape_hash,
         snapshot.final_dispatch_authority_hash,
         reservation.settlement_outcome, reservation.provider_receipt_hash,
         reservation.provider_visible_output_hash, reservation.output_candidate_id,
         reservation.reserved_at, reservation.bound_at, reservation.dispatched_at,
         reservation.terminal_at, reservation.revision
  FROM novel_skill_evaluation_dispatch_reservations AS reservation
  LEFT JOIN novel_skill_evaluation_predispatch_authority_snapshots AS snapshot
    ON snapshot.reservation_id = reservation.id
  WHERE reservation.run_id = ?
  ORDER BY reservation.cell_id ASC, reservation.dispatch_generation ASC`;

const SETTLED_UNOBSERVED_SELECT = `
  SELECT reservation.id AS reservation_id, reservation.run_id, reservation.cell_id,
         reservation.attempt_id, reservation.planned_context_trace_id AS context_trace_id,
         reservation.planned_model_invocation_id AS model_invocation_id,
         reservation.output_candidate_id, reservation.terminal_at, reservation.revision
  FROM novel_skill_evaluation_dispatch_reservations AS reservation
  LEFT JOIN novel_skill_evaluation_observations AS observation
    ON observation.run_id = reservation.run_id AND observation.cell_id = reservation.cell_id
  WHERE reservation.run_id = ? AND reservation.state = 'settled'
    AND reservation.settlement_outcome = 'succeeded'
    AND reservation.output_candidate_id IS NOT NULL AND reservation.terminal_at IS NOT NULL
    AND observation.id IS NULL
  ORDER BY reservation.terminal_at ASC, reservation.id ASC`;

const BLIND_REVIEW_PROJECTION_SELECT = `
  SELECT item.blind_item_id, item.randomized_position, cell.fixture_id,
         candidate.content AS candidate_output,
         score.metric, score.score_basis_points
  FROM novel_skill_evaluation_review_batches AS batch
  INNER JOIN novel_skill_evaluation_review_items AS item ON item.batch_id = batch.id
  INNER JOIN novel_skill_evaluation_observations AS observation
    ON observation.id = item.observation_id AND observation.run_id = batch.run_id
  INNER JOIN novel_skill_evaluation_cells AS cell
    ON cell.id = observation.cell_id AND cell.run_id = batch.run_id
  INNER JOIN ai_candidates AS candidate ON candidate.id = observation.output_candidate_id
  LEFT JOIN novel_skill_evaluation_scores AS score
    ON score.observation_id = observation.id
   AND score.reviewer_id = batch.reviewer_id
   AND score.rubric_version = batch.rubric_version
  WHERE batch.id = ? AND batch.reviewer_id = ?
  ORDER BY item.randomized_position ASC, score.metric ASC`;

const FIXTURES_BY_ID = new Map(
  listNovelSkillEvaluationFixtures().map((fixture) => [fixture.fixtureId, fixture] as const),
);

async function readExistingBlindBatch(
  transaction: TransactionExecutor,
  input: CreateNovelSkillPaidEvaluationBlindReviewBatchInput,
): Promise<NovelSkillPaidEvaluationBlindReviewBatchRecord | null> {
  const rows = await transaction.select<ExistingBlindBatchRow>(
    `SELECT batch.id, batch.run_id, batch.reviewer_id,
            batch.observation_set_hash, batch.assignment_manifest_hash, batch.created_at,
            (SELECT count(*) FROM novel_skill_evaluation_review_items AS item
             WHERE item.batch_id = batch.id) AS item_count,
            (SELECT count(DISTINCT item.randomized_position)
             FROM novel_skill_evaluation_review_items AS item
             WHERE item.batch_id = batch.id) AS position_count,
            (SELECT count(DISTINCT item.observation_id)
             FROM novel_skill_evaluation_review_items AS item
             WHERE item.batch_id = batch.id) AS observation_count
     FROM novel_skill_evaluation_review_batches AS batch
     WHERE batch.id = ? OR batch.run_id = ?
     ORDER BY batch.id ASC`,
    [input.batchId, input.runId],
  );
  if (rows.length === 0) return null;
  const [row] = rows;
  if (
    rows.length !== 1 ||
    row?.id !== input.batchId ||
    row.run_id !== input.runId ||
    row.reviewer_id !== input.reviewerId ||
    row.item_count !== PAID_EVALUATION_CALL_COUNT ||
    row.position_count !== PAID_EVALUATION_CALL_COUNT ||
    row.observation_count !== PAID_EVALUATION_CALL_COUNT
  ) {
    throw conflict("The blinded review batch identity or evidence already belongs elsewhere.");
  }
  assertHash(row.observation_set_hash, "persisted observationSetHash");
  assertHash(row.assignment_manifest_hash, "persisted assignmentManifestHash");
  return {
    batchId: row.id,
    runId: row.run_id,
    reviewerId: row.reviewer_id,
    itemCount: PAID_EVALUATION_CALL_COUNT,
    observationSetHash: row.observation_set_hash,
    assignmentManifestHash: row.assignment_manifest_hash,
    createdAt: row.created_at,
  };
}

async function readBlindProtocol(
  transaction: TransactionExecutor,
  runId: string,
): Promise<BlindProtocolRow> {
  const rows = await transaction.select<BlindProtocolRow>(
    `SELECT protocol.protocol_hash, protocol.rubric_version, protocol.rubric_content_hash,
            protocol.blinding_protocol_version, protocol.blinding_protocol_hash,
            protocol.randomization_protocol_version, protocol.randomization_protocol_hash
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id
     WHERE run.id = ? AND run.status = 'running'`,
    [runId],
  );
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw conflict("Blind review requires one active paid evaluation protocol.");
  }
  return row;
}

function mapControlSnapshot(row: ControlSnapshotRow): NovelSkillPaidEvaluationControlSnapshot {
  return {
    runId: row.run_id,
    suiteId: row.suite_id,
    status: row.status,
    evaluationStatus: row.evaluation_status,
    revision: row.revision,
    protocolConfigured: row.protocol_configured === 1,
    exactTargetCount: row.target_count,
    authorizationId: row.authorization_id,
    authorizedCallCount: row.authorized_call_count,
    totalCells: row.total_cells,
    observedCells: row.observed_cells,
    observationCount: row.observation_count,
    reservationCounts: reservationCounts(row),
    authoritySnapshotCount: row.authority_snapshot_count,
    missingAuthoritySnapshotCount: row.missing_authority_snapshot_count,
    successfulSettlements: row.successful_settlement_count,
    blindItemCount: row.blind_item_count,
    blindReceiptCount: row.blind_receipt_count,
    sealedScoreCount: row.sealed_score_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function mapRecoverableRun(row: RecoverableRunRow): NovelSkillPaidEvaluationRecoverableRun {
  const counts = reservationCounts(row);
  const requiresManualDispatchDecision = counts.dispatched > 0 || counts.ambiguous > 0;
  return {
    runId: row.run_id,
    status: row.status,
    revision: row.revision,
    authorizationId: row.authorization_id,
    authorizedCallCount: row.authorized_call_count,
    completedProviderCalls: row.successful_settlement_count,
    observationCount: row.observation_count,
    blindReceiptCount: row.blind_receipt_count,
    reservationCounts: counts,
    recoveryKind:
      row.status === "planned"
        ? row.authorization_id === null
          ? "preflight_or_authorization"
          : "authorized_not_started"
        : requiresManualDispatchDecision
          ? "manual_dispatch_decision"
          : row.observation_count === PAID_EVALUATION_CALL_COUNT
            ? "blind_review"
            : "safe_local_resume",
    requiresManualDispatchDecision,
    startedAt: row.started_at,
    createdAt: row.created_at,
  };
}

function reservationCounts(row: {
  readonly reserved_count: number;
  readonly bound_count: number;
  readonly dispatched_count: number;
  readonly settled_count: number;
  readonly ambiguous_count: number;
  readonly not_dispatched_count: number;
}): NovelSkillPaidEvaluationReservationCounts {
  return {
    reserved: row.reserved_count,
    bound: row.bound_count,
    dispatched: row.dispatched_count,
    settled: row.settled_count,
    ambiguous: row.ambiguous_count,
    notDispatched: row.not_dispatched_count,
  };
}

function mapTarget(row: TargetRow): NovelSkillPaidEvaluationControlTarget {
  return {
    runId: row.run_id,
    modelSlotId: row.model_slot_id,
    connectionId: row.connection_id,
    catalogEntryId: row.catalog_entry_id,
    providerKind: row.provider_kind_snapshot,
    connectionProtocol: row.connection_protocol_snapshot,
    connectionRevision: row.connection_revision,
    catalogRevision: row.catalog_revision,
    providerModelId: row.provider_model_id_snapshot,
    modelIdentityHash: row.model_identity_hash,
    modelArtifactHash: row.model_artifact_hash,
    targetHash: row.target_hash,
    currency: row.currency,
    inputMicrosPerMillionTokens: row.input_micros_per_million_tokens,
    outputMicrosPerMillionTokens: row.output_micros_per_million_tokens,
    cachedInputMicrosPerMillionTokens: row.cached_input_micros_per_million_tokens,
    pricingVersion: row.pricing_version,
    pricingSnapshotHash: row.pricing_snapshot_hash,
  };
}

function mapReservation(row: ReservationControlRow): NovelSkillPaidEvaluationControlReservation {
  return {
    reservationId: row.id,
    runId: row.run_id,
    cellId: row.cell_id,
    attemptId: row.attempt_id,
    modelSlotId: row.model_slot_id,
    dispatchGeneration: row.dispatch_generation,
    state: row.state,
    plannedContextTraceId: row.planned_context_trace_id,
    plannedModelInvocationId: row.planned_model_invocation_id,
    plannedCandidateId: row.planned_candidate_id,
    currency: row.currency,
    reservedMaximumCostMicros: row.reserved_max_cost_micros,
    exactPredispatchEstimatedMaximumCostMicros: row.exact_predispatch_estimated_max_cost_micros,
    authoritySnapshotHash: row.authority_snapshot_hash,
    providerReceiptShapeHash: row.provider_receipt_shape_hash,
    finalDispatchAuthorityHash: row.final_dispatch_authority_hash,
    actualCostMicros: row.actual_cost_micros,
    settlementOutcome: row.settlement_outcome,
    settlementReceiptHash: row.provider_receipt_hash,
    visibleOutputHash: row.provider_visible_output_hash,
    outputCandidateId: row.output_candidate_id,
    reservedAt: row.reserved_at,
    boundAt: row.bound_at,
    dispatchedAt: row.dispatched_at,
    terminalAt: row.terminal_at,
    revision: row.revision,
  };
}

function assertExactObservationSet(observations: readonly BlindObservationRow[]): void {
  if (observations.length !== PAID_EVALUATION_CALL_COUNT) {
    throw conflict("Blind review requires exactly 192 persisted observations.");
  }
  const persistedIds = new Set<string>();
  const exactCells = new Set<string>();
  for (const observation of observations) {
    assertUuidV7(observation.id, "persisted observationId");
    assertHash(observation.result_hash, "persisted observation result hash");
    if (
      persistedIds.has(observation.id) ||
      !FIXTURES_BY_ID.has(observation.fixture_id) ||
      !NOVEL_SKILL_EVALUATION_ARMS.includes(observation.arm) ||
      !["text_tier_a", "text_tier_b"].includes(observation.model_slot_id) ||
      ![1, 2].includes(observation.repetition)
    ) {
      throw conflict("The persisted blind observation matrix is invalid or not unique.");
    }
    persistedIds.add(observation.id);
    const cell = `${observation.fixture_id}/${observation.arm}/${observation.model_slot_id}/${String(observation.repetition)}`;
    if (exactCells.has(cell)) {
      throw conflict("The persisted blind observation matrix contains a duplicate cell.");
    }
    exactCells.add(cell);
  }

  for (const fixtureId of FIXTURES_BY_ID.keys()) {
    for (const arm of NOVEL_SKILL_EVALUATION_ARMS) {
      for (const modelSlotId of ["text_tier_a", "text_tier_b"] as const) {
        for (const repetition of [1, 2] as const) {
          if (!exactCells.has(`${fixtureId}/${arm}/${modelSlotId}/${String(repetition)}`)) {
            throw conflict("The persisted blind observation matrix is incomplete.");
          }
        }
      }
    }
  }
}

async function randomizeBlindAssignments(
  input: CreateNovelSkillPaidEvaluationBlindReviewBatchInput,
  observations: readonly BlindObservationRow[],
  seed: Uint8Array,
): Promise<
  readonly Readonly<{
    blindItemId: string;
    observationId: string;
    randomizedPosition: number;
    evidenceHash: string;
  }>[]
> {
  const assignments = await Promise.all(
    observations.map(async (observation) => {
      const blindDigest = await deriveBlindDigest(seed, {
        domain: "blind_item_id",
        batchId: input.batchId,
        runId: input.runId,
        observationId: observation.id,
      });
      const orderKey = await deriveBlindDigest(seed, {
        domain: "blind_random_order",
        batchId: input.batchId,
        runId: input.runId,
        observationId: observation.id,
      });
      return {
        blindItemId: `blind-${blindDigest}`,
        observationId: observation.id,
        evidenceHash: observation.result_hash,
        orderKey,
      };
    }),
  );
  assignments.sort((left, right) =>
    left.orderKey === right.orderKey
      ? left.observationId.localeCompare(right.observationId, "en")
      : left.orderKey.localeCompare(right.orderKey, "en"),
  );
  const ids = new Set(assignments.map(({ blindItemId }) => blindItemId));
  const orderKeys = new Set(assignments.map(({ orderKey }) => orderKey));
  if (ids.size !== PAID_EVALUATION_CALL_COUNT || orderKeys.size !== PAID_EVALUATION_CALL_COUNT) {
    throw conflict("The cryptographic blind randomization produced a duplicate assignment.");
  }
  return Object.freeze(
    assignments.map((assignment, index) =>
      Object.freeze({
        blindItemId: assignment.blindItemId,
        observationId: assignment.observationId,
        randomizedPosition: index + 1,
        evidenceHash: assignment.evidenceHash,
      }),
    ),
  );
}

function assertBlindReviewReadInput(input: ReadNovelSkillPaidEvaluationBlindReviewInput): void {
  assertExactKeys(input, ["batchId", "reviewerId"], "blind review read authority");
  assertUuidV7(input.batchId, "batchId");
  assertReviewerId(input.reviewerId);
}

function projectBlindReviewItems(
  rows: readonly BlindReviewProjectionRow[],
  requireCompleteBatch: boolean,
): readonly NovelSkillPaidEvaluationBlindReviewItem[] {
  const groups = new Map<
    string,
    {
      readonly blindItemId: string;
      readonly position: number;
      readonly fixtureId: string;
      readonly candidateOutput: string;
      readonly scores: Map<NovelSkillEvaluationMetric, number>;
      sawEmptyScore: boolean;
    }
  >();
  for (const row of rows) {
    assertBlindItemId(row.blind_item_id);
    if (
      !Number.isSafeInteger(row.randomized_position) ||
      row.randomized_position < 1 ||
      row.randomized_position > PAID_EVALUATION_CALL_COUNT ||
      typeof row.candidate_output !== "string" ||
      row.candidate_output.trim().length === 0 ||
      Array.from(row.candidate_output).length > MAXIMUM_BLIND_REVIEW_TEXT_CHARACTERS ||
      BLIND_REVIEW_CONTROL_CHARACTER_PATTERN.test(row.candidate_output)
    ) {
      throw conflict("A blinded reviewer projection is invalid.");
    }
    const fixture = FIXTURES_BY_ID.get(row.fixture_id);
    if (fixture === undefined) throw conflict("A blinded reviewer fixture is not code-owned.");
    let group = groups.get(row.blind_item_id);
    if (group === undefined) {
      group = {
        blindItemId: row.blind_item_id,
        position: row.randomized_position,
        fixtureId: row.fixture_id,
        candidateOutput: row.candidate_output,
        scores: new Map(),
        sawEmptyScore: false,
      };
      groups.set(row.blind_item_id, group);
    } else if (
      group.position !== row.randomized_position ||
      group.fixtureId !== row.fixture_id ||
      group.candidateOutput !== row.candidate_output
    ) {
      throw conflict("A blinded reviewer item changed within its frozen projection.");
    }

    if (row.metric === null || row.score_basis_points === null) {
      if (row.metric !== null || row.score_basis_points !== null || group.sawEmptyScore) {
        throw conflict("A blinded reviewer item has incomplete score evidence.");
      }
      group.sawEmptyScore = true;
    } else {
      if (
        !NOVEL_SKILL_EVALUATION_METRICS.includes(row.metric) ||
        !Number.isSafeInteger(row.score_basis_points) ||
        row.score_basis_points < 0 ||
        row.score_basis_points > 10_000 ||
        group.scores.has(row.metric)
      ) {
        throw conflict("A blinded reviewer item has invalid or duplicate score evidence.");
      }
      group.scores.set(row.metric, row.score_basis_points / 10_000);
    }
  }

  if (requireCompleteBatch && groups.size !== PAID_EVALUATION_CALL_COUNT) {
    throw conflict("Blind review access requires the exact 192-item randomized batch.");
  }
  const positions = new Set<number>();
  const result = [...groups.values()]
    .sort((left, right) => left.position - right.position)
    .map((group) => {
      if (
        positions.has(group.position) ||
        (group.sawEmptyScore && group.scores.size !== 0) ||
        (!group.sawEmptyScore && group.scores.size !== NOVEL_SKILL_EVALUATION_METRICS.length)
      ) {
        throw conflict("A blinded reviewer batch has incomplete or conflicting score evidence.");
      }
      positions.add(group.position);
      const fixture = requiredMapValue(FIXTURES_BY_ID, group.fixtureId, "blind fixture");
      const scores = {} as Record<NovelSkillEvaluationMetric, number | null>;
      for (const metric of NOVEL_SKILL_EVALUATION_METRICS) {
        scores[metric] = group.scores.get(metric) ?? null;
      }
      return Object.freeze({
        blindItemId: group.blindItemId,
        position: group.position,
        fixtureTaskContent: fixture.input,
        boundaries: Object.freeze([...fixture.boundaries]),
        lockedFacts: Object.freeze([...fixture.lockedFacts]),
        requestedOutcome: fixture.requestedOutcome,
        candidateOutput: group.candidateOutput,
        scores: Object.freeze(scores),
      });
    });
  if (requireCompleteBatch && result.some((item, index) => item.position !== index + 1)) {
    throw conflict("A blinded reviewer batch has an incomplete randomized position sequence.");
  }
  return Object.freeze(result);
}

function assertScores(scores: Readonly<Record<NovelSkillEvaluationMetric, number>>): void {
  assertExactKeys(scores, [...NOVEL_SKILL_EVALUATION_METRICS], "blind scores");
  for (const metric of NOVEL_SKILL_EVALUATION_METRICS) {
    const score = scores[metric];
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw invalid(`Blind score ${metric} must be a finite number between zero and one.`);
    }
  }
}

function assertExactKeys(value: unknown, keys: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`${label} contains missing or unsupported fields.`);
  }
}

function assertReviewerId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(value)) {
    throw invalid("reviewerId must be a portable pseudonymous locator.");
  }
}

function assertBlindItemId(value: string): void {
  if (!/^[A-Za-z0-9_.:-]{16,128}$/u.test(value)) {
    throw invalid("blindItemId must be a portable 16-128 character identifier.");
  }
}

function assertUuidV7(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw invalid(`${label} must be a lowercase UUIDv7.`);
  }
}

function assertHash(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`${label} must be a lowercase SHA-256 hash.`);
  }
}

function assertIsoUtc(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw invalid(`${label} must be an ISO UTC timestamp with milliseconds.`);
  }
}

function assertSingleWrite(rowsAffected: number, message: string): void {
  if (rowsAffected !== 1) throw conflict(message);
}

function requiredMapValue<Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
  label: string,
): Value {
  const value = map.get(key);
  if (value === undefined) throw conflict(`${label} is missing.`);
  return value;
}

function invalid(message: string): NovelSkillEvaluationStoreError {
  return storeError("NOVEL_SKILL_EVALUATION_INVALID", message);
}

function conflict(message: string): NovelSkillEvaluationStoreError {
  return storeError("NOVEL_SKILL_EVALUATION_CONFLICT", message);
}

function storeError(
  code: NovelSkillEvaluationStoreErrorCode,
  message: string,
): NovelSkillEvaluationStoreError {
  return new NovelSkillEvaluationStoreError(code, message);
}

async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

function secureBlindRandomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function readBlindRandomSeed(source: NovelSkillPaidEvaluationBlindRandomSource): Uint8Array {
  let supplied: Uint8Array;
  try {
    supplied = source(32);
  } catch {
    throw conflict("The local cryptographic blind random source failed.");
  }
  if (!(supplied instanceof Uint8Array) || supplied.byteLength !== 32) {
    throw invalid("Blind review randomization requires an exact 256-bit seed.");
  }
  const seed = new Uint8Array(supplied);
  if (new Set(seed).size < 8) {
    throw invalid("Blind review randomization rejected a low-diversity seed.");
  }
  return seed;
}

async function deriveBlindDigest(
  seed: Uint8Array,
  context: Readonly<Record<string, string>>,
): Promise<string> {
  const encodedContext = new TextEncoder().encode(canonicalJson(context));
  const input = new Uint8Array(seed.byteLength + encodedContext.byteLength);
  input.set(seed, 0);
  input.set(encodedContext, seed.byteLength);
  return sha256Bytes(input);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const NOVEL_SKILL_PAID_EVALUATION_EXPECTED_SCORE_COUNT =
  NOVEL_SKILL_PAID_EVALUATION_SCORE_COUNT;
