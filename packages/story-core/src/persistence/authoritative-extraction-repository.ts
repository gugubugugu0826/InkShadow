import {
  type AuthoritativeExtractionCandidateRecord,
  type AuthoritativeExtractionDecisionClaim,
  type AuthoritativeExtractionDecisionClaimState,
  type AuthoritativeExtractionEnqueueResult,
  type AuthoritativeExtractionEvaluationRecord,
  type AuthoritativeExtractionJob,
  type AuthoritativeExtractionRepository,
  type ClaimAuthoritativeExtractionDecisionInput,
  type ClaimAuthoritativeExtractionJobInput,
  type CompleteAuthoritativeExtractionAttemptInput,
  type FailAuthoritativeExtractionJobInput,
  isAuthoritativeExtractionIdempotencyKey,
  isAuthoritativeExtractionTerminalState,
  validateAuthoritativeExtractionCandidateRecord,
  validateAuthoritativeExtractionDecisionClaim,
  validateAuthoritativeExtractionEvaluationRecord,
  validateAuthoritativeExtractionJob,
} from "../authoritative-extraction-task.js";
import type { AuthoritativeExtractionProvenance } from "../authoritative-extraction.js";
import { StoryCoreError } from "../errors.js";
import type { Result } from "../result.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
} from "../value-objects.js";
import {
  abortCorruptSnapshot,
  abortPersistence,
  parseSnapshot,
  runPersistence,
  serializeSnapshot,
} from "./common.js";
import type { StorySqlExecutor, StorySqlTransaction } from "./executor.js";

interface JobRow {
  readonly id: string;
  readonly project_id: string;
  readonly chapter_id: string;
  readonly source_version_id: string;
  readonly source_checksum_sha256: string;
  readonly prompt_registry_id: string;
  readonly prompt_version: number;
  readonly prompt_checksum_sha256: string;
  readonly model_provider: string;
  readonly model_id: string;
  readonly model_revision: string;
  readonly evaluation_suite_id: string;
  readonly evaluation_version: string;
  readonly execution_mode: string;
  readonly state: string;
  readonly revision: number;
  readonly attempt_count: number;
  readonly cancel_requested: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly failure_code: string | null;
  readonly failure_retryable: number | null;
  readonly snapshot_json: string;
}

interface CandidateRow {
  readonly job_id: string;
  readonly candidate_key: string;
  readonly review_item_id: string;
  readonly project_id: string;
  readonly chapter_id: string;
  readonly source_version_id: string;
  readonly source_checksum_sha256: string;
  readonly prompt_registry_id: string;
  readonly prompt_version: number;
  readonly prompt_checksum_sha256: string;
  readonly model_provider: string;
  readonly model_id: string;
  readonly model_revision: string;
  readonly evaluation_version: string;
  readonly target_record_id: string;
  readonly target_record_kind: string;
  readonly target_expected_revision: number;
  readonly snapshot_json: string;
}

interface EvaluationRow {
  readonly id: string;
  readonly suite_id: string;
  readonly prompt_registry_id: string;
  readonly prompt_version: number;
  readonly prompt_checksum_sha256: string;
  readonly model_provider: string;
  readonly model_id: string;
  readonly model_revision: string;
  readonly evaluation_version: string;
  readonly fixture_count: number;
  readonly protocol_failure_count: number;
  readonly true_positive_count: number;
  readonly false_positive_count: number;
  readonly false_negative_count: number;
  readonly precision: number;
  readonly recall: number;
  readonly minimum_precision: number;
  readonly minimum_recall: number;
  readonly passed: number;
  readonly snapshot_json: string;
}

interface DecisionClaimRow {
  readonly idempotency_key: string;
  readonly job_id: string;
  readonly candidate_key: string;
  readonly decision_id: string;
  readonly decision_kind: string;
  readonly payload_checksum_sha256: string;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const JOB_SELECT = `SELECT
  id,
  project_id,
  chapter_id,
  source_version_id,
  source_checksum_sha256,
  prompt_registry_id,
  prompt_version,
  prompt_checksum_sha256,
  model_provider,
  model_id,
  model_revision,
  evaluation_suite_id,
  evaluation_version,
  execution_mode,
  state,
  revision,
  attempt_count,
  cancel_requested,
  lease_owner,
  lease_expires_at,
  failure_code,
  failure_retryable,
  snapshot_json
FROM authoritative_extraction_jobs`;

const CANDIDATE_SELECT = `SELECT
  job_id,
  candidate_key,
  review_item_id,
  project_id,
  chapter_id,
  source_version_id,
  source_checksum_sha256,
  prompt_registry_id,
  prompt_version,
  prompt_checksum_sha256,
  model_provider,
  model_id,
  model_revision,
  evaluation_version,
  target_record_id,
  target_record_kind,
  target_expected_revision,
  snapshot_json
FROM authoritative_extraction_candidates`;

const EVALUATION_SELECT = `SELECT
  id,
  suite_id,
  prompt_registry_id,
  prompt_version,
  prompt_checksum_sha256,
  model_provider,
  model_id,
  model_revision,
  evaluation_version,
  fixture_count,
  protocol_failure_count,
  true_positive_count,
  false_positive_count,
  false_negative_count,
  precision,
  recall,
  minimum_precision,
  minimum_recall,
  passed,
  snapshot_json
FROM authoritative_extraction_evaluations`;

const DECISION_SELECT = `SELECT
  idempotency_key,
  job_id,
  candidate_key,
  decision_id,
  decision_kind,
  payload_checksum_sha256,
  state,
  created_at,
  updated_at
FROM authoritative_extraction_decision_claims`;

export class SqliteAuthoritativeExtractionRepository implements AuthoritativeExtractionRepository {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public enqueue(
    job: AuthoritativeExtractionJob,
  ): Promise<Result<AuthoritativeExtractionEnqueueResult, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const validated = requireValidJob(job);
        if (
          validated.state !== "queued" ||
          validated.revision !== 1 ||
          validated.attemptCount !== 0
        ) {
          abortCorruptSnapshot("EXTRACTION_ENQUEUE_NOT_INITIAL");
        }
        const inserted = await transaction.execute(
          `INSERT OR IGNORE INTO authoritative_extraction_jobs (
             id,
             project_id,
             chapter_id,
             source_version_id,
             source_checksum_sha256,
             scope_start,
             scope_end,
             source_length,
             prompt_registry_id,
             prompt_version,
             prompt_checksum_sha256,
             model_provider,
             model_id,
             model_revision,
             evaluation_suite_id,
             evaluation_version,
             execution_mode,
             state,
             revision,
             attempt_count,
             cancel_requested,
             lease_owner,
             lease_expires_at,
             failure_code,
             failure_retryable,
             created_at,
             updated_at,
             snapshot_json
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
             NULL, ?, ?, ?
           )`,
          jobInsertBindings(validated),
        );
        const rows = await transaction.select<JobRow>(
          `${JOB_SELECT}
           WHERE project_id = ?
             AND chapter_id = ?
             AND source_version_id = ?
             AND scope_start = ?
             AND scope_end = ?
             AND prompt_registry_id = ?
             AND prompt_version = ?
             AND prompt_checksum_sha256 = ?
             AND model_provider = ?
             AND model_id = ?
             AND model_revision = ?
             AND evaluation_suite_id = ?
             AND evaluation_version = ?`,
          jobAuthorityBindings(validated),
        );
        const stored = rows[0] === undefined ? null : hydrateJob(rows[0]);
        if (stored === null || !sameJobAuthority(stored, validated)) {
          abortCorruptSnapshot("EXTRACTION_ENQUEUE_AUTHORITY_MISMATCH");
        }
        return Object.freeze({
          job: stored,
          created: inserted.rowsAffected === 1,
        });
      }),
    );
  }

  public listJobsByProject(
    projectId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionJob[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<JobRow>(
        `${JOB_SELECT}
         WHERE project_id = ?
         ORDER BY created_at DESC, id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateJob));
    });
  }

  public findJobById(
    jobId: UuidV7,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>> {
    return runPersistence(() => readJob(this.executor, jobId));
  }

  public recoverExpiredLeases(
    now: IsoUtcTimestamp,
  ): Promise<Result<readonly AuthoritativeExtractionJob[], StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<JobRow>(
          `${JOB_SELECT}
           WHERE state IN ('running', 'materializing')
             AND lease_expires_at <= ?
           ORDER BY lease_expires_at ASC, id ASC`,
          [now],
        );
        const recovered: AuthoritativeExtractionJob[] = [];
        for (const row of rows) {
          const current = hydrateJob(row);
          const next =
            current.state === "running"
              ? transitionJob(current, now, {
                  state: "failed_retryable",
                  cancelRequested: false,
                  failure: Object.freeze({
                    code: parseSafeIdentifierOrAbort("worker_lease_expired"),
                    retryable: true,
                  }),
                  leaseOwner: null,
                  leaseExpiresAt: null,
                })
              : transitionJob(current, now, {
                  state: "materialization_pending",
                  cancelRequested: false,
                  failure: null,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                });
          await updateJob(transaction, next, current.revision);
          recovered.push(next);
        }
        return Object.freeze(recovered);
      }),
    );
  }

  public resumeNetworkJobs(
    projectId: UuidV7,
    now: IsoUtcTimestamp,
  ): Promise<Result<number, StoryCoreError>> {
    return this.resumeBlockedJobs(projectId, now, "waiting_for_network");
  }

  public resumeEvaluationBlockedJobs(
    projectId: UuidV7,
    provenance: AuthoritativeExtractionProvenance,
    now: IsoUtcTimestamp,
  ): Promise<Result<number, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<JobRow>(
          `${JOB_SELECT}
           WHERE project_id = ?
             AND state = 'blocked_evaluation'
             AND prompt_registry_id = ?
             AND prompt_version = ?
             AND prompt_checksum_sha256 = ?
             AND model_provider = ?
             AND model_id = ?
             AND model_revision = ?
             AND evaluation_version = ?
           ORDER BY created_at ASC, id ASC`,
          [
            projectId,
            provenance.prompt.registryId,
            provenance.prompt.version,
            provenance.prompt.checksumSha256,
            provenance.model.provider,
            provenance.model.id,
            provenance.model.revision,
            provenance.evaluationVersion,
          ],
        );
        for (const row of rows) {
          const current = hydrateJob(row);
          await updateJob(
            transaction,
            transitionJob(current, now, {
              state: "queued",
              failure: null,
            }),
            current.revision,
          );
        }
        return rows.length;
      }),
    );
  }

  public claimNext(
    input: ClaimAuthoritativeExtractionJobInput,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>> {
    return this.claimState(input, ["queued", "failed_retryable"], "running", true);
  }

  public claimMaterialization(
    input: ClaimAuthoritativeExtractionJobInput,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>> {
    return this.claimState(input, ["materialization_pending"], "materializing", false);
  }

  public completeAttempt(
    input: CompleteAuthoritativeExtractionAttemptInput,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const expected = requireValidJob(input.job);
        const current = await requireJob(transaction, expected.id);
        requireWorkerMutation(current, input.expectedRevision, input.workerId, "running");
        if (!sameJobAuthority(current, expected)) {
          abortCorruptSnapshot("EXTRACTION_COMPLETE_AUTHORITY_MISMATCH");
        }
        const candidateKeys = new Set<string>();
        const reviewIds = new Set<string>();
        const candidates = input.candidates.map((candidate) => {
          const validated = validateAuthoritativeExtractionCandidateRecord(candidate);
          if (!validated.ok) {
            abortCorruptSnapshot("EXTRACTION_COMPLETE_CANDIDATE_INVALID");
          }
          const value = validated.value;
          if (
            value.jobId !== current.id ||
            !sameSource(value.source, current.source) ||
            !sameProvenance(value.provenance, current.provenance) ||
            candidateKeys.has(value.candidate.key) ||
            reviewIds.has(value.reviewItemId)
          ) {
            abortCorruptSnapshot("EXTRACTION_COMPLETE_CANDIDATE_INVALID");
          }
          candidateKeys.add(value.candidate.key);
          reviewIds.add(value.reviewItemId);
          return value;
        });
        for (const candidate of candidates) {
          await insertCandidate(transaction, candidate);
        }
        const next = transitionJob(current, input.now, {
          state: candidates.length === 0 ? "completed" : "materialization_pending",
          cancelRequested: false,
          leaseOwner: null,
          leaseExpiresAt: null,
          failure: null,
        });
        await updateJob(transaction, next, current.revision);
        return next;
      }),
    );
  }

  public finishMaterialization(
    jobId: UuidV7,
    expectedRevision: number,
    workerId: SafeIdentifier,
    now: IsoUtcTimestamp,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const current = await requireJob(transaction, jobId);
        requireWorkerMutation(current, expectedRevision, workerId, "materializing");
        const countRows = await transaction.select<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM authoritative_extraction_candidates
           WHERE job_id = ?`,
          [jobId],
        );
        if ((countRows[0]?.count ?? 0) < 1) {
          abortCorruptSnapshot("EXTRACTION_MATERIALIZATION_WITHOUT_CANDIDATES");
        }
        const next = transitionJob(current, now, {
          state: "awaiting_review",
          leaseOwner: null,
          leaseExpiresAt: null,
          failure: null,
        });
        await updateJob(transaction, next, current.revision);
        return next;
      }),
    );
  }

  public failJob(
    input: FailAuthoritativeExtractionJobInput,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const current = await requireJob(transaction, input.jobId);
        requireWorkerMutation(current, input.expectedRevision, input.workerId, "running");
        if (
          (input.state === "cancelled") !== (input.failure === null) ||
          (input.failure !== null &&
            input.failure.retryable !== (input.state === "failed_retryable"))
        ) {
          abortCorruptSnapshot("EXTRACTION_FAILURE_STATE_MISMATCH");
        }
        const next = transitionJob(current, input.now, {
          state: input.state,
          cancelRequested: false,
          leaseOwner: null,
          leaseExpiresAt: null,
          failure: input.failure,
        });
        await updateJob(transaction, next, current.revision);
        return next;
      }),
    );
  }

  public requestCancellation(
    jobId: UuidV7,
    now: IsoUtcTimestamp,
  ): Promise<Result<AuthoritativeExtractionJob, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const current = await requireJob(transaction, jobId);
        if (
          isAuthoritativeExtractionTerminalState(current.state) ||
          current.state === "completed"
        ) {
          return current;
        }
        if (current.state === "running") {
          if (current.cancelRequested) {
            return current;
          }
          const next = transitionJob(current, now, { cancelRequested: true });
          await updateJob(transaction, next, current.revision);
          return next;
        }
        if (
          ["queued", "waiting_for_network", "blocked_evaluation", "failed_retryable"].includes(
            current.state,
          )
        ) {
          const next = transitionJob(current, now, {
            state: "cancelled",
            failure: null,
          });
          await updateJob(transaction, next, current.revision);
          return next;
        }
        abortPersistence(
          new StoryCoreError({
            code: "EXTRACTION_INVALID_TRANSITION",
            message: "Candidates are already materialized and can no longer be cancelled.",
            actions: ["REVIEW_EVIDENCE"],
          }),
        );
      }),
    );
  }

  public isCancellationRequested(jobId: UuidV7): Promise<Result<boolean, StoryCoreError>> {
    return runPersistence(async () => {
      const job = await readJob(this.executor, jobId);
      return job?.cancelRequested ?? job?.state === "cancelled";
    });
  }

  public listCandidatesByProject(
    projectId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionCandidateRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<CandidateRow>(
        `${CANDIDATE_SELECT}
         WHERE project_id = ?
         ORDER BY created_at DESC, job_id ASC, candidate_key ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateCandidate));
    });
  }

  public listCandidatesByJob(
    jobId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionCandidateRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<CandidateRow>(
        `${CANDIDATE_SELECT}
         WHERE job_id = ?
         ORDER BY candidate_key ASC`,
        [jobId],
      );
      return Object.freeze(rows.map(hydrateCandidate));
    });
  }

  public findCandidate(
    jobId: UuidV7,
    candidateKey: SafeIdentifier,
  ): Promise<Result<AuthoritativeExtractionCandidateRecord | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<CandidateRow>(
        `${CANDIDATE_SELECT}
         WHERE job_id = ? AND candidate_key = ?`,
        [jobId, candidateKey],
      );
      return rows[0] === undefined ? null : hydrateCandidate(rows[0]);
    });
  }

  public recordEvaluation(
    evaluation: AuthoritativeExtractionEvaluationRecord,
  ): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      const validated = validateAuthoritativeExtractionEvaluationRecord(evaluation);
      if (!validated.ok) {
        abortCorruptSnapshot("EXTRACTION_EVALUATION_INVALID");
      }
      const value = validated.value;
      const inserted = await this.executor.execute(
        `INSERT OR IGNORE INTO authoritative_extraction_evaluations (
           id,
           suite_id,
           prompt_registry_id,
           prompt_version,
           prompt_checksum_sha256,
           model_provider,
           model_id,
           model_revision,
           evaluation_version,
           fixture_count,
           protocol_failure_count,
           true_positive_count,
           false_positive_count,
           false_negative_count,
           precision,
           recall,
           minimum_precision,
           minimum_recall,
           passed,
           created_at,
           snapshot_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          value.id,
          value.suiteId,
          value.provenance.prompt.registryId,
          value.provenance.prompt.version,
          value.provenance.prompt.checksumSha256,
          value.provenance.model.provider,
          value.provenance.model.id,
          value.provenance.model.revision,
          value.provenance.evaluationVersion,
          value.fixtureCount,
          value.protocolFailureCount,
          value.metrics.truePositiveCount,
          value.metrics.falsePositiveCount,
          value.metrics.falseNegativeCount,
          value.metrics.precision,
          value.metrics.recall,
          value.thresholds.minimumPrecision,
          value.thresholds.minimumRecall,
          value.metrics.passed ? 1 : 0,
          value.createdAt,
          serializeSnapshot(value),
        ],
      );
      if (inserted.rowsAffected === 0) {
        const rows = await this.executor.select<EvaluationRow>(
          `${EVALUATION_SELECT} WHERE id = ?`,
          [value.id],
        );
        if (
          rows[0] === undefined ||
          serializeSnapshot(hydrateEvaluation(rows[0])) !== serializeSnapshot(value)
        ) {
          abortCorruptSnapshot("EXTRACTION_EVALUATION_ID_REUSED");
        }
      }
    });
  }

  public findLatestPassingEvaluation(
    suiteId: SafeIdentifier,
    provenance: AuthoritativeExtractionProvenance,
  ): Promise<Result<AuthoritativeExtractionEvaluationRecord | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<EvaluationRow>(
        `${EVALUATION_SELECT}
         WHERE suite_id = ?
           AND prompt_registry_id = ?
           AND prompt_version = ?
           AND prompt_checksum_sha256 = ?
           AND model_provider = ?
           AND model_id = ?
           AND model_revision = ?
           AND evaluation_version = ?
           AND passed = 1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [
          suiteId,
          provenance.prompt.registryId,
          provenance.prompt.version,
          provenance.prompt.checksumSha256,
          provenance.model.provider,
          provenance.model.id,
          provenance.model.revision,
          provenance.evaluationVersion,
        ],
      );
      return rows[0] === undefined ? null : hydrateEvaluation(rows[0]);
    });
  }

  public claimDecision(
    input: ClaimAuthoritativeExtractionDecisionInput,
  ): Promise<Result<AuthoritativeExtractionDecisionClaim, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const proposed = requireValidDecisionClaim({
          ...input,
          state: "claimed",
          createdAt: input.now,
          updatedAt: input.now,
        });
        await transaction.execute(
          `INSERT OR IGNORE INTO authoritative_extraction_decision_claims (
             idempotency_key,
             job_id,
             candidate_key,
             decision_id,
             decision_kind,
             payload_checksum_sha256,
             state,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
          [
            proposed.idempotencyKey,
            proposed.jobId,
            proposed.candidateKey,
            proposed.decisionId,
            proposed.kind,
            proposed.payloadChecksumSha256,
            proposed.createdAt,
            proposed.updatedAt,
          ],
        );
        const stored = await readDecisionClaim(transaction, proposed.idempotencyKey);
        if (
          stored?.jobId !== proposed.jobId ||
          stored.candidateKey !== proposed.candidateKey ||
          stored.kind !== proposed.kind ||
          stored.payloadChecksumSha256 !== proposed.payloadChecksumSha256
        ) {
          abortPersistence(
            new StoryCoreError({
              code: "EXTRACTION_INVALID_TRANSITION",
              message: "The extraction decision idempotency key was reused with another payload.",
              actions: ["RECOMPARE"],
            }),
          );
        }
        return stored;
      }),
    );
  }

  public updateDecisionClaim(
    idempotencyKey: string,
    expectedState: AuthoritativeExtractionDecisionClaimState,
    nextState: AuthoritativeExtractionDecisionClaimState,
    now: IsoUtcTimestamp,
  ): Promise<Result<AuthoritativeExtractionDecisionClaim, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const current = await readDecisionClaim(transaction, idempotencyKey);
        if (current === null) {
          extractionNotFound("EXTRACTION_CANDIDATE_NOT_FOUND", "Decision claim was not found.");
        }
        if (current.state === nextState) {
          return current;
        }
        if (
          current.state !== expectedState ||
          !validDecisionClaimTransition(current.state, nextState)
        ) {
          abortPersistence(
            new StoryCoreError({
              code: "EXTRACTION_INVALID_TRANSITION",
              message: "Extraction decision claim state changed before it was updated.",
              retryable: true,
              actions: ["RETRY", "RECOMPARE"],
              details: {
                expectedState,
                actualState: current.state,
              },
            }),
          );
        }
        const changed = await transaction.execute(
          `UPDATE authoritative_extraction_decision_claims
           SET state = ?, updated_at = ?
           WHERE idempotency_key = ? AND state = ?`,
          [nextState, now, idempotencyKey, expectedState],
        );
        if (changed.rowsAffected !== 1) {
          persistenceConflict("Extraction decision claim changed concurrently.");
        }
        const stored = await readDecisionClaim(transaction, idempotencyKey);
        if (stored?.state !== nextState) {
          abortCorruptSnapshot("EXTRACTION_DECISION_UPDATE_MISSING");
        }
        return stored;
      }),
    );
  }

  public findDecisionClaim(
    idempotencyKey: string,
  ): Promise<Result<AuthoritativeExtractionDecisionClaim | null, StoryCoreError>> {
    return runPersistence(async () => {
      if (!isAuthoritativeExtractionIdempotencyKey(idempotencyKey)) {
        abortCorruptSnapshot("EXTRACTION_DECISION_KEY_INVALID");
      }
      return readDecisionClaim(this.executor, idempotencyKey);
    });
  }

  private resumeBlockedJobs(
    projectId: UuidV7,
    now: IsoUtcTimestamp,
    state: "waiting_for_network",
  ): Promise<Result<number, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<JobRow>(
          `${JOB_SELECT}
           WHERE project_id = ? AND state = ?
           ORDER BY created_at ASC, id ASC`,
          [projectId, state],
        );
        for (const row of rows) {
          const current = hydrateJob(row);
          await updateJob(
            transaction,
            transitionJob(current, now, {
              state: "queued",
              failure: null,
            }),
            current.revision,
          );
        }
        return rows.length;
      }),
    );
  }

  private claimState(
    input: ClaimAuthoritativeExtractionJobInput,
    sourceStates: readonly AuthoritativeExtractionJob["state"][],
    targetState: "running" | "materializing",
    incrementAttempt: boolean,
  ): Promise<Result<AuthoritativeExtractionJob | null, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        if (compareTimestamps(input.leaseExpiresAt, input.now) <= 0) {
          abortCorruptSnapshot("EXTRACTION_LEASE_NOT_FUTURE");
        }
        const placeholders = sourceStates.map(() => "?").join(", ");
        const rows = await transaction.select<JobRow>(
          `${JOB_SELECT}
           WHERE project_id = ?
             AND state IN (${placeholders})
             AND cancel_requested = 0
           ORDER BY created_at ASC, id ASC
           LIMIT 1`,
          [input.projectId, ...sourceStates],
        );
        if (rows[0] === undefined) {
          return null;
        }
        const current = hydrateJob(rows[0]);
        const next = transitionJob(current, input.now, {
          state: targetState,
          attemptCount: current.attemptCount + (incrementAttempt ? 1 : 0),
          cancelRequested: false,
          leaseOwner: input.workerId,
          leaseExpiresAt: input.leaseExpiresAt,
          failure: null,
        });
        await updateJob(transaction, next, current.revision);
        return next;
      }),
    );
  }
}

function hydrateJob(row: JobRow): AuthoritativeExtractionJob {
  const validated = validateAuthoritativeExtractionJob(
    parseSnapshot(row.snapshot_json) as AuthoritativeExtractionJob,
  );
  if (!validated.ok) {
    abortCorruptSnapshot(validated.error.code);
  }
  const job = validated.value;
  if (
    row.id !== job.id ||
    row.project_id !== job.source.projectId ||
    row.chapter_id !== job.source.chapterId ||
    row.source_version_id !== job.source.versionId ||
    row.source_checksum_sha256 !== job.source.checksumSha256 ||
    row.prompt_registry_id !== job.provenance.prompt.registryId ||
    row.prompt_version !== job.provenance.prompt.version ||
    row.prompt_checksum_sha256 !== job.provenance.prompt.checksumSha256 ||
    row.model_provider !== job.provenance.model.provider ||
    row.model_id !== job.provenance.model.id ||
    row.model_revision !== job.provenance.model.revision ||
    row.evaluation_suite_id !== job.evaluationSuiteId ||
    row.evaluation_version !== job.provenance.evaluationVersion ||
    row.execution_mode !== job.executionMode ||
    row.state !== job.state ||
    row.revision !== job.revision ||
    row.attempt_count !== job.attemptCount ||
    row.cancel_requested !== (job.cancelRequested ? 1 : 0) ||
    row.lease_owner !== job.leaseOwner ||
    row.lease_expires_at !== job.leaseExpiresAt ||
    row.failure_code !== (job.failure?.code ?? null) ||
    row.failure_retryable !== (job.failure === null ? null : job.failure.retryable ? 1 : 0)
  ) {
    abortCorruptSnapshot("EXTRACTION_JOB_COLUMNS_DIVERGED");
  }
  return job;
}

function hydrateCandidate(row: CandidateRow): AuthoritativeExtractionCandidateRecord {
  const validated = validateAuthoritativeExtractionCandidateRecord(
    parseSnapshot(row.snapshot_json) as AuthoritativeExtractionCandidateRecord,
  );
  if (!validated.ok) {
    abortCorruptSnapshot(validated.error.code);
  }
  const record = validated.value;
  if (
    row.job_id !== record.jobId ||
    row.candidate_key !== record.candidate.key ||
    row.review_item_id !== record.reviewItemId ||
    row.project_id !== record.source.projectId ||
    row.chapter_id !== record.source.chapterId ||
    row.source_version_id !== record.source.versionId ||
    row.source_checksum_sha256 !== record.source.checksumSha256 ||
    row.prompt_registry_id !== record.provenance.prompt.registryId ||
    row.prompt_version !== record.provenance.prompt.version ||
    row.prompt_checksum_sha256 !== record.provenance.prompt.checksumSha256 ||
    row.model_provider !== record.provenance.model.provider ||
    row.model_id !== record.provenance.model.id ||
    row.model_revision !== record.provenance.model.revision ||
    row.evaluation_version !== record.provenance.evaluationVersion ||
    row.target_record_id !== record.candidate.target.recordId ||
    row.target_record_kind !== record.candidate.target.kind ||
    row.target_expected_revision !== record.candidate.target.expectedRevision
  ) {
    abortCorruptSnapshot("EXTRACTION_CANDIDATE_COLUMNS_DIVERGED");
  }
  return record;
}

function hydrateEvaluation(row: EvaluationRow): AuthoritativeExtractionEvaluationRecord {
  const validated = validateAuthoritativeExtractionEvaluationRecord(
    parseSnapshot(row.snapshot_json) as AuthoritativeExtractionEvaluationRecord,
  );
  if (!validated.ok) {
    abortCorruptSnapshot(validated.error.code);
  }
  const value = validated.value;
  if (
    row.id !== value.id ||
    row.suite_id !== value.suiteId ||
    row.prompt_registry_id !== value.provenance.prompt.registryId ||
    row.prompt_version !== value.provenance.prompt.version ||
    row.prompt_checksum_sha256 !== value.provenance.prompt.checksumSha256 ||
    row.model_provider !== value.provenance.model.provider ||
    row.model_id !== value.provenance.model.id ||
    row.model_revision !== value.provenance.model.revision ||
    row.evaluation_version !== value.provenance.evaluationVersion ||
    row.fixture_count !== value.fixtureCount ||
    row.protocol_failure_count !== value.protocolFailureCount ||
    row.true_positive_count !== value.metrics.truePositiveCount ||
    row.false_positive_count !== value.metrics.falsePositiveCount ||
    row.false_negative_count !== value.metrics.falseNegativeCount ||
    row.precision !== value.metrics.precision ||
    row.recall !== value.metrics.recall ||
    row.minimum_precision !== value.thresholds.minimumPrecision ||
    row.minimum_recall !== value.thresholds.minimumRecall ||
    row.passed !== (value.metrics.passed ? 1 : 0)
  ) {
    abortCorruptSnapshot("EXTRACTION_EVALUATION_COLUMNS_DIVERGED");
  }
  return value;
}

function hydrateDecisionClaim(row: DecisionClaimRow): AuthoritativeExtractionDecisionClaim {
  return requireValidDecisionClaim({
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id as UuidV7,
    candidateKey: row.candidate_key as SafeIdentifier,
    decisionId: row.decision_id as UuidV7,
    kind: row.decision_kind as AuthoritativeExtractionDecisionClaim["kind"],
    payloadChecksumSha256: row.payload_checksum_sha256,
    state: row.state as AuthoritativeExtractionDecisionClaimState,
    createdAt: row.created_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  });
}

async function readJob(
  transaction: StorySqlTransaction,
  jobId: UuidV7,
): Promise<AuthoritativeExtractionJob | null> {
  const rows = await transaction.select<JobRow>(`${JOB_SELECT} WHERE id = ?`, [jobId]);
  return rows[0] === undefined ? null : hydrateJob(rows[0]);
}

async function requireJob(
  transaction: StorySqlTransaction,
  jobId: UuidV7,
): Promise<AuthoritativeExtractionJob> {
  const job = await readJob(transaction, jobId);
  if (job === null) {
    extractionNotFound("EXTRACTION_JOB_NOT_FOUND", "Extraction job was not found.");
  }
  return job;
}

async function updateJob(
  transaction: StorySqlTransaction,
  job: AuthoritativeExtractionJob,
  expectedRevision: number,
): Promise<void> {
  const validated = requireValidJob(job);
  if (validated.revision !== expectedRevision + 1) {
    abortCorruptSnapshot("EXTRACTION_JOB_REVISION_STEP_INVALID");
  }
  const result = await transaction.execute(
    `UPDATE authoritative_extraction_jobs
     SET state = ?,
         revision = ?,
         attempt_count = ?,
         cancel_requested = ?,
         lease_owner = ?,
         lease_expires_at = ?,
         failure_code = ?,
         failure_retryable = ?,
         updated_at = ?,
         snapshot_json = ?
     WHERE id = ? AND revision = ?`,
    [
      validated.state,
      validated.revision,
      validated.attemptCount,
      validated.cancelRequested ? 1 : 0,
      validated.leaseOwner,
      validated.leaseExpiresAt,
      validated.failure?.code ?? null,
      validated.failure === null ? null : validated.failure.retryable ? 1 : 0,
      validated.updatedAt,
      serializeSnapshot(validated),
      validated.id,
      expectedRevision,
    ],
  );
  if (result.rowsAffected !== 1) {
    persistenceConflict("Extraction job changed before the durable transition committed.");
  }
}

async function insertCandidate(
  transaction: StorySqlTransaction,
  record: AuthoritativeExtractionCandidateRecord,
): Promise<void> {
  const result = await transaction.execute(
    `INSERT INTO authoritative_extraction_candidates (
       job_id,
       candidate_key,
       review_item_id,
       project_id,
       chapter_id,
       source_version_id,
       source_checksum_sha256,
       evidence_start,
       evidence_end,
       prompt_registry_id,
       prompt_version,
       prompt_checksum_sha256,
       model_provider,
       model_id,
       model_revision,
       evaluation_version,
       target_record_id,
       target_record_kind,
       target_expected_revision,
       created_at,
       snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.jobId,
      record.candidate.key,
      record.reviewItemId,
      record.source.projectId,
      record.source.chapterId,
      record.source.versionId,
      record.source.checksumSha256,
      record.candidate.evidence.range.start,
      record.candidate.evidence.range.end,
      record.provenance.prompt.registryId,
      record.provenance.prompt.version,
      record.provenance.prompt.checksumSha256,
      record.provenance.model.provider,
      record.provenance.model.id,
      record.provenance.model.revision,
      record.provenance.evaluationVersion,
      record.candidate.target.recordId,
      record.candidate.target.kind,
      record.candidate.target.expectedRevision,
      record.createdAt,
      serializeSnapshot(record),
    ],
  );
  if (result.rowsAffected !== 1) {
    abortCorruptSnapshot("EXTRACTION_CANDIDATE_INSERT_FAILED");
  }
}

async function readDecisionClaim(
  transaction: StorySqlTransaction,
  idempotencyKey: string,
): Promise<AuthoritativeExtractionDecisionClaim | null> {
  const rows = await transaction.select<DecisionClaimRow>(
    `${DECISION_SELECT} WHERE idempotency_key = ?`,
    [idempotencyKey],
  );
  return rows[0] === undefined ? null : hydrateDecisionClaim(rows[0]);
}

function transitionJob(
  current: AuthoritativeExtractionJob,
  now: IsoUtcTimestamp,
  change: Partial<
    Pick<
      AuthoritativeExtractionJob,
      "state" | "attemptCount" | "cancelRequested" | "leaseOwner" | "leaseExpiresAt" | "failure"
    >
  >,
): AuthoritativeExtractionJob {
  const updatedAt = parseIsoUtcTimestamp(now);
  if (!updatedAt.ok || compareTimestamps(updatedAt.value, current.updatedAt) < 0) {
    abortCorruptSnapshot("EXTRACTION_JOB_TIME_REGRESSION");
  }
  return requireValidJob({
    ...current,
    ...change,
    revision: current.revision + 1,
    updatedAt: updatedAt.value,
  });
}

function requireWorkerMutation(
  current: AuthoritativeExtractionJob,
  expectedRevision: number,
  workerId: SafeIdentifier,
  state: "running" | "materializing",
): void {
  if (
    current.revision !== expectedRevision ||
    current.state !== state ||
    current.leaseOwner !== workerId
  ) {
    persistenceConflict("Extraction worker lease or revision is no longer current.");
  }
}

function requireValidJob(job: AuthoritativeExtractionJob): AuthoritativeExtractionJob {
  const validated = validateAuthoritativeExtractionJob(job);
  if (!validated.ok) {
    abortCorruptSnapshot(validated.error.code);
  }
  return validated.value;
}

function requireValidDecisionClaim(
  claim: AuthoritativeExtractionDecisionClaim,
): AuthoritativeExtractionDecisionClaim {
  const validated = validateAuthoritativeExtractionDecisionClaim(claim);
  if (!validated.ok) {
    abortCorruptSnapshot(validated.error.code);
  }
  return validated.value;
}

function sameJobAuthority(
  left: AuthoritativeExtractionJob,
  right: AuthoritativeExtractionJob,
): boolean {
  return (
    sameSource(left.source, right.source) &&
    sameProvenance(left.provenance, right.provenance) &&
    left.evaluationSuiteId === right.evaluationSuiteId &&
    left.executionMode === right.executionMode
  );
}

function sameSource(
  left: AuthoritativeExtractionJob["source"],
  right: AuthoritativeExtractionJob["source"],
): boolean {
  return (
    left.projectId === right.projectId &&
    left.chapterId === right.chapterId &&
    left.versionId === right.versionId &&
    left.checksumSha256 === right.checksumSha256 &&
    left.scope.start === right.scope.start &&
    left.scope.end === right.scope.end &&
    left.scope.sourceLength === right.scope.sourceLength
  );
}

function sameProvenance(
  left: AuthoritativeExtractionProvenance,
  right: AuthoritativeExtractionProvenance,
): boolean {
  return (
    left.prompt.registryId === right.prompt.registryId &&
    left.prompt.version === right.prompt.version &&
    left.prompt.checksumSha256 === right.prompt.checksumSha256 &&
    left.model.provider === right.model.provider &&
    left.model.id === right.model.id &&
    left.model.revision === right.model.revision &&
    left.evaluationVersion === right.evaluationVersion
  );
}

function jobInsertBindings(job: AuthoritativeExtractionJob) {
  return [
    job.id,
    job.source.projectId,
    job.source.chapterId,
    job.source.versionId,
    job.source.checksumSha256,
    job.source.scope.start,
    job.source.scope.end,
    job.source.scope.sourceLength,
    job.provenance.prompt.registryId,
    job.provenance.prompt.version,
    job.provenance.prompt.checksumSha256,
    job.provenance.model.provider,
    job.provenance.model.id,
    job.provenance.model.revision,
    job.evaluationSuiteId,
    job.provenance.evaluationVersion,
    job.executionMode,
    job.state,
    job.revision,
    job.attemptCount,
    job.cancelRequested ? 1 : 0,
    job.createdAt,
    job.updatedAt,
    serializeSnapshot(job),
  ] as const;
}

function jobAuthorityBindings(job: AuthoritativeExtractionJob) {
  return [
    job.source.projectId,
    job.source.chapterId,
    job.source.versionId,
    job.source.scope.start,
    job.source.scope.end,
    job.provenance.prompt.registryId,
    job.provenance.prompt.version,
    job.provenance.prompt.checksumSha256,
    job.provenance.model.provider,
    job.provenance.model.id,
    job.provenance.model.revision,
    job.evaluationSuiteId,
    job.provenance.evaluationVersion,
  ] as const;
}

function parseSafeIdentifierOrAbort(value: string): SafeIdentifier {
  const parsed = parseSafeIdentifier(value);
  if (!parsed.ok) {
    abortCorruptSnapshot(parsed.error.code);
  }
  return parsed.value;
}

function validDecisionClaimTransition(
  current: AuthoritativeExtractionDecisionClaimState,
  next: AuthoritativeExtractionDecisionClaimState,
): boolean {
  return (
    (current === "claimed" &&
      (next === "committed" || next === "projection_pending" || next === "completed")) ||
    (current === "committed" && (next === "projection_pending" || next === "completed")) ||
    (current === "projection_pending" && next === "completed")
  );
}

function extractionNotFound(
  code: "EXTRACTION_JOB_NOT_FOUND" | "EXTRACTION_CANDIDATE_NOT_FOUND",
  message: string,
): never {
  abortPersistence(
    new StoryCoreError({
      code,
      message,
    }),
  );
}

function persistenceConflict(message: string): never {
  abortPersistence(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message,
      retryable: true,
      actions: ["RETRY", "RECOMPARE"],
    }),
  );
}
