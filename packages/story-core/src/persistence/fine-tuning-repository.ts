import { StoryCoreError } from "../errors.js";
import {
  FINE_TUNING_ARTIFACT_STATES,
  FINE_TUNING_DATASET_STATES,
  FINE_TUNING_JOB_STATES,
  FINE_TUNING_PRIVACY_SCAN_VERSION,
  FINE_TUNING_RIGHTS_KINDS,
  FINE_TUNING_SOURCE_KINDS,
  FINE_TUNING_SPLITS,
  assertFineTuningJobTransition,
  canTransitionFineTuningArtifact,
  computeFineTuningEvaluationAuthorityHash,
  evaluateFineTuningCandidate,
  type FineTuningArtifactState,
  type FineTuningDatasetApproval,
  type FineTuningDatasetReadinessIssue,
  type FineTuningDatasetSample,
  type FineTuningDatasetSnapshot,
  type FineTuningEvaluationGateInput,
  type FineTuningEvaluationGateResult,
  type FineTuningJobState,
  type FineTuningPrivacyFinding,
  type FineTuningQuotaPolicy,
  type FineTuningTrainingPlan,
} from "../fine-tuning-governance.js";
import type { Result } from "../result.js";
import type { IsoUtcTimestamp, SafeIdentifier, UuidV7 } from "../value-objects.js";
import { abortCorruptSnapshot, abortPersistence, parseSnapshot, runPersistence } from "./common.js";
import type { StorySqlExecutor, StorySqlTransaction } from "./executor.js";

export interface FineTuningOperationContext {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly auditEventId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly now: string;
}

export interface FineTuningQuotaPolicyRecord extends FineTuningQuotaPolicy {
  readonly projectId: UuidV7;
  readonly spentMicros: number;
  readonly reservedMicros: number;
  readonly activeJobs: number;
  readonly monthKey: string;
  readonly revision: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface FineTuningJobRecord {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly datasetId: UuidV7;
  readonly datasetRevision: number;
  readonly datasetManifestHash: string;
  readonly datasetApprovalId: UuidV7;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly plan: FineTuningTrainingPlan;
  readonly status: FineTuningJobState;
  readonly revision: number;
  readonly attemptCount: number;
  readonly maximumAttempts: number;
  readonly cancellationRequested: boolean;
  readonly leaseOwner: SafeIdentifier | null;
  readonly leaseExpiresAt: IsoUtcTimestamp | null;
  readonly reservedCostMicros: number;
  readonly settledCostMicros: number | null;
  readonly costSource: "local_resource_estimate" | "provider_reported" | null;
  readonly currency: string;
  readonly monthKey: string;
  readonly artifactId: UuidV7 | null;
  readonly failureCode: string | null;
  readonly createdBy: SafeIdentifier;
  readonly startedAt: IsoUtcTimestamp | null;
  readonly completedAt: IsoUtcTimestamp | null;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface FineTuningModelArtifactRecord {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly datasetId: UuidV7;
  readonly jobId: UuidV7;
  readonly baseModelProviderId: SafeIdentifier;
  readonly baseModelId: string;
  readonly baseModelRevision: string;
  readonly artifactDigest: string;
  /** Opaque native registry reference, never a WebView-provided file path. */
  readonly localArtifactRef: string;
  readonly state: FineTuningArtifactState;
  readonly revision: number;
  readonly latestEvaluationId: UuidV7 | null;
  readonly registrationName: string | null;
  readonly providerReceiptDigest: string | null;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface FineTuningEvaluationRecord {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly artifactId: UuidV7;
  readonly baselineModelId: string;
  readonly evaluatorId: SafeIdentifier;
  readonly evaluatorVersion: string;
  readonly authorityHash: string;
  readonly input: FineTuningEvaluationGateInput;
  readonly result: FineTuningEvaluationGateResult;
  readonly createdBy: SafeIdentifier;
  readonly createdAt: IsoUtcTimestamp;
}

export type FineTuningDeploymentTargetRole =
  "local_private" | "fast" | "high_quality" | "validation";

export interface FineTuningDeploymentRecord {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly artifactId: UuidV7;
  readonly targetRole: FineTuningDeploymentTargetRole;
  readonly previousDeploymentId: UuidV7 | null;
  readonly approvalId: UuidV7;
  readonly status: "active" | "rolled_back" | "revoked";
  readonly providerReceiptDigest: string;
  readonly activatedAt: IsoUtcTimestamp;
  readonly endedAt: IsoUtcTimestamp | null;
}

interface DatasetRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly state: string;
  readonly revision: number;
  readonly manifest_hash: string;
  readonly manifest_json: string;
  readonly total_content_bytes: number;
  readonly included_sample_count: number;
  readonly duplicate_sample_count: number;
  readonly train_sample_count: number;
  readonly validation_sample_count: number;
  readonly test_sample_count: number;
  readonly readiness_issues_json: string;
  readonly created_by: string;
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SampleRow {
  readonly id: string;
  readonly dataset_id: string;
  readonly project_id: string;
  readonly source_kind: string;
  readonly source_entity_id: string;
  readonly source_revision: number;
  readonly source_label: string;
  readonly content_text: string;
  readonly content_hash: string;
  readonly content_bytes: number;
  readonly rights_kind: string;
  readonly rights_basis: string;
  readonly rights_confirmed_at: string | null;
  readonly allow_training: number;
  readonly privacy_scan_version: string;
  readonly pii_finding_count: number;
  readonly sensitive_finding_count: number;
  readonly privacy_findings_json: string;
  readonly privacy_passed: number;
  readonly split: string;
  readonly duplicate_of_sample_id: string | null;
  readonly created_at: string;
}

interface PolicyRow {
  readonly project_id: string;
  readonly allow_remote_training: number;
  readonly maximum_dataset_bytes: number;
  readonly maximum_concurrent_jobs: number;
  readonly maximum_single_job_cost_micros: number;
  readonly monthly_cost_limit_micros: number;
  readonly currency: string;
  readonly spent_micros: number;
  readonly reserved_micros: number;
  readonly active_jobs: number;
  readonly month_key: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface JobRow {
  readonly id: string;
  readonly project_id: string;
  readonly dataset_id: string;
  readonly dataset_revision: number;
  readonly dataset_manifest_hash: string;
  readonly dataset_approval_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly plan_hash: string;
  readonly plan_json: string;
  readonly provider_location: string;
  readonly provider_id: string;
  readonly status: string;
  readonly revision: number;
  readonly attempt_count: number;
  readonly maximum_attempts: number;
  readonly cancellation_requested: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly reserved_cost_micros: number;
  readonly settled_cost_micros: number | null;
  readonly cost_source: string | null;
  readonly currency: string;
  readonly month_key: string;
  readonly artifact_id: string | null;
  readonly failure_code: string | null;
  readonly created_by: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ArtifactRow {
  readonly id: string;
  readonly project_id: string;
  readonly dataset_id: string;
  readonly job_id: string;
  readonly base_model_provider_id: string;
  readonly base_model_id: string;
  readonly base_model_revision: string;
  readonly artifact_digest: string;
  readonly local_artifact_ref: string;
  readonly state: string;
  readonly revision: number;
  readonly latest_evaluation_id: string | null;
  readonly registration_name: string | null;
  readonly provider_receipt_digest: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EvaluationRow {
  readonly id: string;
  readonly project_id: string;
  readonly artifact_id: string;
  readonly baseline_model_id: string;
  readonly evaluator_id: string;
  readonly evaluator_version: string;
  readonly authority_hash: string;
  readonly baseline_metrics_json: string;
  readonly candidate_metrics_json: string;
  readonly rules_json: string;
  readonly observations_json: string;
  readonly passed: number;
  readonly created_by: string;
  readonly created_at: string;
}

interface DeploymentRow {
  readonly id: string;
  readonly project_id: string;
  readonly artifact_id: string;
  readonly target_role: string;
  readonly previous_deployment_id: string | null;
  readonly approval_id: string;
  readonly status: string;
  readonly provider_receipt_digest: string;
  readonly activated_at: string;
  readonly ended_at: string | null;
}

interface ApprovalRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly entity_revision: number;
  readonly authority_hash: string;
  readonly actor_id: string;
  readonly declarations_json: string;
  readonly created_at: string;
}

interface ClaimRow {
  readonly idempotency_key: string;
  readonly operation: string;
  readonly request_hash: string;
  readonly project_id: string;
  readonly result_entity_type: string;
  readonly result_entity_id: string;
  readonly result_revision: number;
  readonly created_at: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;
const LOWER_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const MONTH_PATTERN = /^(?:20\d{2}|[3-9]\d{3})-(?:0[1-9]|1[0-2])$/u;
const LOCAL_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;

const DATASET_SELECT = `SELECT
  id, project_id, name, state, revision, manifest_hash, manifest_json,
  total_content_bytes, included_sample_count, duplicate_sample_count,
  train_sample_count, validation_sample_count, test_sample_count,
  readiness_issues_json, created_by, approved_by, approved_at,
  created_at, updated_at
FROM fine_tuning_datasets`;

const SAMPLE_SELECT = `SELECT
  id, dataset_id, project_id, source_kind, source_entity_id, source_revision,
  source_label, content_text, content_hash, content_bytes, rights_kind,
  rights_basis, rights_confirmed_at, allow_training, privacy_scan_version,
  pii_finding_count, sensitive_finding_count, privacy_findings_json,
  privacy_passed, split, duplicate_of_sample_id, created_at
FROM fine_tuning_samples`;

const POLICY_SELECT = `SELECT
  project_id, allow_remote_training, maximum_dataset_bytes,
  maximum_concurrent_jobs, maximum_single_job_cost_micros,
  monthly_cost_limit_micros, currency, spent_micros, reserved_micros,
  active_jobs, month_key, revision, created_at, updated_at
FROM fine_tuning_quota_policies`;

const JOB_SELECT = `SELECT
  id, project_id, dataset_id, dataset_revision, dataset_manifest_hash,
  dataset_approval_id, idempotency_key, request_hash, plan_hash, plan_json,
  provider_location, provider_id, status, revision, attempt_count,
  maximum_attempts, cancellation_requested, lease_owner, lease_expires_at,
  reserved_cost_micros, settled_cost_micros, cost_source, currency, month_key,
  artifact_id, failure_code, created_by, started_at, completed_at,
  created_at, updated_at
FROM fine_tuning_jobs`;

const ARTIFACT_SELECT = `SELECT
  id, project_id, dataset_id, job_id, base_model_provider_id, base_model_id,
  base_model_revision, artifact_digest, local_artifact_ref, state, revision,
  latest_evaluation_id, registration_name, provider_receipt_digest,
  created_at, updated_at
FROM fine_tuning_model_artifacts`;

const EVALUATION_SELECT = `SELECT
  id, project_id, artifact_id, baseline_model_id, evaluator_id,
  evaluator_version, authority_hash, baseline_metrics_json,
  candidate_metrics_json, rules_json, observations_json, passed,
  created_by, created_at
FROM fine_tuning_evaluations`;

const DEPLOYMENT_SELECT = `SELECT
  id, project_id, artifact_id, target_role, previous_deployment_id,
  approval_id, status, provider_receipt_digest, activated_at, ended_at
FROM fine_tuning_deployments`;

const APPROVAL_SELECT = `SELECT
  id, project_id, kind, entity_type, entity_id, entity_revision,
  authority_hash, actor_id, declarations_json, created_at
FROM fine_tuning_approvals`;

export class FineTuningGovernanceSqliteRepository {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public createDataset(
    dataset: FineTuningDatasetSnapshot,
    operation: FineTuningOperationContext,
  ): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(operation);
        const replay = await readClaim(transaction, operation);
        if (replay !== null) {
          assertClaimResult(replay, "dataset", dataset.id);
          return requireDataset(transaction, dataset.id);
        }
        if (dataset.state !== "draft" && dataset.state !== "review_required") {
          invalid("Only an unapproved fine-tuning dataset can be created.");
        }
        validateDatasetProjection(dataset);
        await transaction.execute(
          `INSERT INTO fine_tuning_datasets (
             id, project_id, name, state, revision, manifest_hash,
             manifest_json, total_content_bytes, included_sample_count,
             duplicate_sample_count, train_sample_count,
             validation_sample_count, test_sample_count,
             readiness_issues_json, created_by, approved_by, approved_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
          [
            dataset.id,
            dataset.projectId,
            dataset.name,
            dataset.state,
            dataset.revision,
            dataset.manifestHash,
            serializeJson({
              schemaVersion: dataset.schemaVersion,
              splitPolicy: dataset.splitPolicy,
            }),
            dataset.totalContentBytes,
            dataset.includedSampleCount,
            dataset.duplicateSampleCount,
            dataset.splitCounts.train,
            dataset.splitCounts.validation,
            dataset.splitCounts.test,
            serializeJson(dataset.readinessIssues),
            dataset.createdBy,
            dataset.createdAt,
            dataset.updatedAt,
          ],
        );
        for (const sample of dataset.samples) {
          await insertSample(transaction, dataset, sample);
        }
        await insertClaim(transaction, operation, {
          projectId: dataset.projectId,
          operation: "dataset_create",
          entityType: "dataset",
          entityId: dataset.id,
          revision: dataset.revision,
        });
        await insertAudit(transaction, operation, {
          projectId: dataset.projectId,
          entityType: "dataset",
          entityId: dataset.id,
          action: "dataset_created",
          metadata: {
            manifestHash: dataset.manifestHash,
            sampleCount: dataset.samples.length,
            includedSampleCount: dataset.includedSampleCount,
            duplicateSampleCount: dataset.duplicateSampleCount,
            privacyBlockedCount: dataset.readinessIssues.filter(
              ({ code }) => code === "FINE_TUNING_PRIVACY_BLOCKED",
            ).length,
          },
        });
        return requireDataset(transaction, dataset.id);
      }),
    );
  }

  public approveDataset(
    dataset: FineTuningDatasetSnapshot,
    approval: FineTuningDatasetApproval,
    operation: FineTuningOperationContext,
  ): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(operation);
        const replay = await readClaim(transaction, operation);
        if (replay !== null) {
          assertClaimResult(replay, "dataset", dataset.id);
          return requireDataset(transaction, dataset.id);
        }
        if (
          dataset.state !== "approved" ||
          dataset.revision !== approval.datasetRevision + 1 ||
          dataset.id !== approval.datasetId ||
          dataset.manifestHash !== approval.manifestHash ||
          dataset.approvedBy !== approval.actorId ||
          dataset.approvedAt !== approval.createdAt ||
          operation.actorId !== approval.actorId ||
          operation.now !== approval.createdAt
        ) {
          invalid("Dataset approval does not match the validated human decision.");
        }
        const current = await requireDataset(transaction, dataset.id);
        if (
          current.state !== "review_required" ||
          current.revision !== approval.datasetRevision ||
          current.manifestHash !== approval.manifestHash ||
          current.readinessIssues.length !== 0
        ) {
          conflict("The dataset changed before approval was committed.");
        }
        await insertApproval(transaction, {
          id: approval.id,
          projectId: dataset.projectId,
          kind: "dataset_training",
          entityType: "dataset",
          entityId: dataset.id,
          entityRevision: approval.datasetRevision,
          authorityHash: approval.manifestHash,
          actorId: approval.actorId,
          declarations: {
            privacyReviewed: true,
            copyrightReviewed: true,
            trainingPurposeConfirmed: true,
          },
          createdAt: approval.createdAt,
        });
        const updated = await transaction.execute(
          `UPDATE fine_tuning_datasets
           SET state = 'approved', revision = ?, approved_by = ?,
               approved_at = ?, updated_at = ?
           WHERE id = ? AND state = 'review_required' AND revision = ?
             AND manifest_hash = ?`,
          [
            dataset.revision,
            dataset.approvedBy,
            dataset.approvedAt,
            dataset.updatedAt,
            dataset.id,
            approval.datasetRevision,
            approval.manifestHash,
          ],
        );
        if (updated.rowsAffected !== 1) {
          conflict("The dataset changed while its approval was committed.");
        }
        await insertClaim(transaction, operation, {
          projectId: dataset.projectId,
          operation: "dataset_approve",
          entityType: "dataset",
          entityId: dataset.id,
          revision: dataset.revision,
        });
        await insertAudit(transaction, operation, {
          projectId: dataset.projectId,
          entityType: "dataset",
          entityId: dataset.id,
          action: "dataset_approved",
          metadata: {
            manifestHash: dataset.manifestHash,
            approvalId: approval.id,
            approvedRevision: approval.datasetRevision,
          },
        });
        return requireDataset(transaction, dataset.id);
      }),
    );
  }

  public findDataset(
    datasetId: string,
  ): Promise<Result<FineTuningDatasetSnapshot | null, StoryCoreError>> {
    return runPersistence(() => readDataset(this.executor, requireUuid(datasetId, "datasetId")));
  }

  public listDatasets(
    projectId: string,
    limit = 100,
  ): Promise<Result<readonly FineTuningDatasetSnapshot[], StoryCoreError>> {
    return runPersistence(async () => {
      const validProjectId = requireUuid(projectId, "projectId");
      requireInteger(limit, 1, 500, "limit");
      const rows = await this.executor.select<DatasetRow>(
        `${DATASET_SELECT}
         WHERE project_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [validProjectId, limit],
      );
      const datasets: FineTuningDatasetSnapshot[] = [];
      for (const row of rows) {
        datasets.push(await hydrateDataset(this.executor, row));
      }
      return Object.freeze(datasets);
    });
  }

  public configurePolicy(input: {
    readonly projectId: string;
    readonly policy: FineTuningQuotaPolicy;
    readonly monthKey: string;
    readonly expectedRevision?: number | null;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningQuotaPolicyRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const projectId = requireUuid(input.projectId, "projectId");
        validatePolicy(input.policy, input.monthKey);
        if (input.policy.allowRemoteTraining) {
          remoteForbidden();
        }
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "policy", projectId);
          return requirePolicy(transaction, projectId);
        }
        const current = await readPolicy(transaction, projectId);
        if (current === null) {
          if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
            conflict("The fine-tuning quota policy does not exist at the expected revision.");
          }
          await transaction.execute(
            `INSERT INTO fine_tuning_quota_policies (
               project_id, allow_remote_training, maximum_dataset_bytes,
               maximum_concurrent_jobs, maximum_single_job_cost_micros,
               monthly_cost_limit_micros, currency, spent_micros,
               reserved_micros, active_jobs, month_key, revision,
               created_at, updated_at
             ) VALUES (?, 0, ?, ?, ?, ?, ?, 0, 0, 0, ?, 1, ?, ?)`,
            [
              projectId,
              input.policy.maximumDatasetBytes,
              input.policy.maximumConcurrentJobs,
              input.policy.maximumSingleJobCostMicros,
              input.policy.monthlyCostLimitMicros,
              input.policy.currency,
              input.monthKey,
              input.operation.now,
              input.operation.now,
            ],
          );
        } else {
          if (
            input.expectedRevision === undefined ||
            input.expectedRevision === null ||
            input.expectedRevision !== current.revision
          ) {
            conflict("The fine-tuning quota policy revision changed.");
          }
          const monthChanged = current.monthKey !== input.monthKey;
          if (monthChanged && (current.activeJobs !== 0 || current.reservedMicros !== 0)) {
            conflict("A quota month cannot roll over while jobs or reservations remain active.");
          }
          if (
            !monthChanged &&
            current.currency !== input.policy.currency &&
            (current.spentMicros !== 0 || current.reservedMicros !== 0 || current.activeJobs !== 0)
          ) {
            conflict(
              "The quota currency cannot change while the current month has committed usage.",
            );
          }
          const nextSpent = monthChanged ? 0 : current.spentMicros;
          if (nextSpent + current.reservedMicros > input.policy.monthlyCostLimitMicros) {
            quotaExceeded("The updated monthly quota is below committed usage.");
          }
          const updated = await transaction.execute(
            `UPDATE fine_tuning_quota_policies
             SET maximum_dataset_bytes = ?, maximum_concurrent_jobs = ?,
                 maximum_single_job_cost_micros = ?,
                 monthly_cost_limit_micros = ?, currency = ?,
                 spent_micros = ?, month_key = ?, revision = revision + 1,
                 updated_at = ?
             WHERE project_id = ? AND revision = ?`,
            [
              input.policy.maximumDatasetBytes,
              input.policy.maximumConcurrentJobs,
              input.policy.maximumSingleJobCostMicros,
              input.policy.monthlyCostLimitMicros,
              input.policy.currency,
              nextSpent,
              input.monthKey,
              input.operation.now,
              projectId,
              current.revision,
            ],
          );
          if (updated.rowsAffected !== 1) {
            conflict("The quota policy changed concurrently.");
          }
        }
        const policy = await requirePolicy(transaction, projectId);
        await insertClaim(transaction, input.operation, {
          projectId,
          operation: "policy_configure",
          entityType: "policy",
          entityId: projectId,
          revision: policy.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId,
          entityType: "policy",
          entityId: projectId,
          action: "policy_configured",
          metadata: {
            revision: policy.revision,
            monthKey: policy.monthKey,
            maximumDatasetBytes: policy.maximumDatasetBytes,
            maximumConcurrentJobs: policy.maximumConcurrentJobs,
            maximumSingleJobCostMicros: policy.maximumSingleJobCostMicros,
            monthlyCostLimitMicros: policy.monthlyCostLimitMicros,
            currency: policy.currency,
            allowRemoteTraining: false,
          },
        });
        return policy;
      }),
    );
  }

  public findPolicy(
    projectId: string,
  ): Promise<Result<FineTuningQuotaPolicyRecord | null, StoryCoreError>> {
    return runPersistence(() => readPolicy(this.executor, requireUuid(projectId, "projectId")));
  }

  public queueJob(input: {
    readonly id: string;
    readonly projectId: string;
    readonly datasetApprovalId: string;
    readonly plan: FineTuningTrainingPlan;
    readonly maximumAttempts: number;
    readonly createdBy: string;
    readonly monthKey: string;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const id = requireUuid(input.id, "jobId");
        const projectId = requireUuid(input.projectId, "projectId");
        const approvalId = requireUuid(input.datasetApprovalId, "datasetApprovalId");
        const createdBy = requireLowerKey(input.createdBy, "createdBy");
        requireInteger(input.maximumAttempts, 1, 100, "maximumAttempts");
        requireMonth(input.monthKey);
        validatePlan(input.plan);
        if (input.plan.provider.location !== "local") {
          remoteForbidden();
        }
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "job", id);
          return requireJob(transaction, id);
        }
        const dataset = await requireDataset(transaction, input.plan.datasetId);
        if (
          dataset.projectId !== projectId ||
          dataset.state !== "approved" ||
          dataset.revision !== input.plan.datasetRevision ||
          dataset.manifestHash !== input.plan.datasetManifestHash
        ) {
          conflict("The approved dataset no longer matches the immutable training plan.");
        }
        const approval = await requireApproval(transaction, approvalId);
        if (
          approval.project_id !== projectId ||
          approval.kind !== "dataset_training" ||
          approval.entity_type !== "dataset" ||
          approval.entity_id !== dataset.id ||
          approval.entity_revision !== dataset.revision - 1 ||
          approval.authority_hash !== dataset.manifestHash
        ) {
          invalid("The training job is not bound to the dataset's human approval.");
        }
        const policy = await requirePolicy(transaction, projectId);
        enforceJobQuota(policy, dataset, input.plan, input.monthKey);
        const reserved = input.plan.limits.maximumCostMicros;
        const policyUpdated = await transaction.execute(
          `UPDATE fine_tuning_quota_policies
           SET reserved_micros = reserved_micros + ?,
               active_jobs = active_jobs + 1,
               revision = revision + 1,
               updated_at = ?
           WHERE project_id = ? AND revision = ?
             AND active_jobs < maximum_concurrent_jobs
             AND spent_micros + reserved_micros + ? <= monthly_cost_limit_micros`,
          [reserved, input.operation.now, projectId, policy.revision, reserved],
        );
        if (policyUpdated.rowsAffected !== 1) {
          quotaExceeded("The fine-tuning quota changed before the job reservation committed.");
        }
        await transaction.execute(
          `INSERT INTO fine_tuning_jobs (
             id, project_id, dataset_id, dataset_revision,
             dataset_manifest_hash, dataset_approval_id, idempotency_key,
             request_hash, plan_hash, plan_json, provider_location,
             provider_id, status, revision, attempt_count, maximum_attempts,
             cancellation_requested, lease_owner, lease_expires_at,
             reserved_cost_micros, settled_cost_micros, cost_source,
             currency, month_key, artifact_id, failure_code, created_by,
             started_at, completed_at, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, 'queued', 1, 0, ?,
             0, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, ?,
             NULL, NULL, ?, ?
           )`,
          [
            id,
            projectId,
            dataset.id,
            dataset.revision,
            dataset.manifestHash,
            approvalId,
            input.operation.idempotencyKey,
            input.operation.requestHash,
            input.plan.planHash,
            serializeJson(input.plan),
            input.plan.provider.providerId,
            input.maximumAttempts,
            reserved,
            input.plan.limits.currency,
            input.monthKey,
            createdBy,
            input.operation.now,
            input.operation.now,
          ],
        );
        await insertClaim(transaction, input.operation, {
          projectId,
          operation: "job_queue",
          entityType: "job",
          entityId: id,
          revision: 1,
        });
        await insertAudit(transaction, input.operation, {
          projectId,
          entityType: "job",
          entityId: id,
          action: "job_queued",
          metadata: {
            datasetId: dataset.id,
            datasetRevision: dataset.revision,
            planHash: input.plan.planHash,
            providerLocation: "local",
            providerId: input.plan.provider.providerId,
            reservedCostMicros: reserved,
            costSemantics: "maximum_reservation_not_provider_bill",
          },
        });
        return requireJob(transaction, id);
      }),
    );
  }

  public claimNextJob(input: {
    readonly projectId: string;
    readonly workerId: string;
    readonly leaseExpiresAt: string;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningJobRecord | null, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const projectId = requireUuid(input.projectId, "projectId");
        const workerId = requireLowerKey(input.workerId, "workerId");
        requireTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
        if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.operation.now)) {
          invalid("The fine-tuning worker lease must expire in the future.");
        }
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          if (replay.result_entity_type !== "job") {
            idempotencyConflict();
          }
          return readJob(transaction, replay.result_entity_id);
        }
        const rows = await transaction.select<JobRow>(
          `${JOB_SELECT}
           WHERE project_id = ? AND status = 'queued'
             AND cancellation_requested = 0
           ORDER BY created_at ASC, id ASC
           LIMIT 1`,
          [projectId],
        );
        if (rows[0] === undefined) {
          return null;
        }
        const current = hydrateJob(rows[0]);
        const transition = assertFineTuningJobTransition(current.status, "running");
        if (!transition.ok) abortPersistence(transition.error);
        if (current.attemptCount >= current.maximumAttempts) {
          invalid("The queued fine-tuning job exhausted its attempts.");
        }
        const updated = await transaction.execute(
          `UPDATE fine_tuning_jobs
           SET status = 'running', revision = revision + 1,
               attempt_count = attempt_count + 1, lease_owner = ?,
               lease_expires_at = ?, started_at = COALESCE(started_at, ?),
               updated_at = ?
           WHERE id = ? AND revision = ? AND status = 'queued'
             AND cancellation_requested = 0`,
          [
            workerId,
            input.leaseExpiresAt,
            input.operation.now,
            input.operation.now,
            current.id,
            current.revision,
          ],
        );
        if (updated.rowsAffected !== 1) {
          conflict("Another fine-tuning worker claimed the job first.");
        }
        const job = await requireJob(transaction, current.id);
        await insertClaim(transaction, input.operation, {
          projectId,
          operation: "job_claim",
          entityType: "job",
          entityId: job.id,
          revision: job.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId,
          entityType: "job",
          entityId: job.id,
          action: "job_claimed",
          metadata: {
            attemptCount: job.attemptCount,
            leaseExpiresAt: job.leaseExpiresAt,
            workerId,
          },
        });
        return job;
      }),
    );
  }

  public requestCancellation(input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const jobId = requireUuid(input.jobId, "jobId");
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "job", jobId);
          return requireJob(transaction, jobId);
        }
        const current = await requireJob(transaction, jobId);
        requireRevision(current.revision, input.expectedRevision);
        let next: FineTuningJobState;
        if (current.status === "queued" || current.status === "failed_retryable") {
          next = "cancelled";
        } else if (current.status === "running") {
          next = "cancelling";
        } else if (current.status === "cancelling" || current.status === "cancelled") {
          return current;
        } else {
          invalid("This fine-tuning job can no longer be cancelled.");
        }
        const transition = assertFineTuningJobTransition(current.status, next);
        if (!transition.ok) abortPersistence(transition.error);
        if (next === "cancelled" && current.status === "queued") {
          await releaseReservation(transaction, current, 0, input.operation.now);
        }
        const updated = await transaction.execute(
          `UPDATE fine_tuning_jobs
           SET status = ?, revision = revision + 1,
               cancellation_requested = 1,
               lease_owner = CASE WHEN ? = 'cancelled' THEN NULL ELSE lease_owner END,
               lease_expires_at = CASE WHEN ? = 'cancelled' THEN NULL ELSE lease_expires_at END,
               completed_at = CASE WHEN ? = 'cancelled' THEN ? ELSE NULL END,
               failure_code = CASE WHEN ? = 'cancelled' THEN NULL ELSE failure_code END,
               updated_at = ?
           WHERE id = ? AND revision = ?`,
          [
            next,
            next,
            next,
            next,
            input.operation.now,
            next,
            input.operation.now,
            current.id,
            current.revision,
          ],
        );
        if (updated.rowsAffected !== 1) conflict("The job changed before cancellation committed.");
        const job = await requireJob(transaction, jobId);
        await insertClaim(transaction, input.operation, {
          projectId: job.projectId,
          operation: "job_cancel",
          entityType: "job",
          entityId: job.id,
          revision: job.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: job.projectId,
          entityType: "job",
          entityId: job.id,
          action: next === "cancelled" ? "job_cancelled" : "job_cancel_requested",
          metadata: { previousState: current.status, nextState: next },
        });
        return job;
      }),
    );
  }

  public finalizeCancellation(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly settledCostMicros: number;
    readonly costSource: "local_resource_estimate" | "provider_reported";
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const jobId = requireUuid(input.jobId, "jobId");
        const workerId = requireLowerKey(input.workerId, "workerId");
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "job", jobId);
          return requireJob(transaction, jobId);
        }
        const current = await requireJob(transaction, jobId);
        requireWorkerJob(current, input.expectedRevision, workerId, ["cancelling"]);
        requireSettlement(input.settledCostMicros, current.reservedCostMicros);
        const transition = assertFineTuningJobTransition(current.status, "cancelled");
        if (!transition.ok) abortPersistence(transition.error);
        await releaseReservation(
          transaction,
          current,
          input.settledCostMicros,
          input.operation.now,
        );
        await updateTerminalJob(transaction, current, {
          status: "cancelled",
          settledCostMicros: input.settledCostMicros,
          costSource: input.costSource,
          failureCode: null,
          artifactId: null,
          now: input.operation.now,
        });
        const job = await requireJob(transaction, jobId);
        await insertClaim(transaction, input.operation, {
          projectId: job.projectId,
          operation: "job_cancel",
          entityType: "job",
          entityId: job.id,
          revision: job.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: job.projectId,
          entityType: "job",
          entityId: job.id,
          action: "job_cancelled",
          metadata: {
            settledCostMicros: input.settledCostMicros,
            costSource: input.costSource,
          },
        });
        return job;
      }),
    );
  }

  public completeJob(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly artifactId: string;
    readonly artifactDigest: string;
    readonly localArtifactRef: string;
    readonly settledCostMicros: number;
    readonly costSource: "local_resource_estimate" | "provider_reported";
    readonly providerReceiptDigest?: string | null;
    readonly operation: FineTuningOperationContext;
  }): Promise<
    Result<
      Readonly<{ job: FineTuningJobRecord; artifact: FineTuningModelArtifactRecord }>,
      StoryCoreError
    >
  > {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const jobId = requireUuid(input.jobId, "jobId");
        const artifactId = requireUuid(input.artifactId, "artifactId");
        const workerId = requireLowerKey(input.workerId, "workerId");
        requireHash(input.artifactDigest, "artifactDigest");
        requireLocalRef(input.localArtifactRef);
        const receipt = requireNullableHash(input.providerReceiptDigest, "providerReceiptDigest");
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "artifact", artifactId);
          return {
            job: await requireJob(transaction, jobId),
            artifact: await requireArtifact(transaction, artifactId),
          };
        }
        const current = await requireJob(transaction, jobId);
        requireWorkerJob(current, input.expectedRevision, workerId, ["running"]);
        if (current.cancellationRequested) {
          conflict("Cancellation was requested before the training artifact completed.");
        }
        requireSettlement(input.settledCostMicros, current.reservedCostMicros);
        const transition = assertFineTuningJobTransition(current.status, "artifact_ready");
        if (!transition.ok) abortPersistence(transition.error);
        await transaction.execute(
          `INSERT INTO fine_tuning_model_artifacts (
             id, project_id, dataset_id, job_id, base_model_provider_id,
             base_model_id, base_model_revision, artifact_digest,
             local_artifact_ref, state, revision, latest_evaluation_id,
             registration_name, provider_receipt_digest, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, NULL, NULL, ?, ?, ?)`,
          [
            artifactId,
            current.projectId,
            current.datasetId,
            current.id,
            current.plan.baseModel.providerId,
            current.plan.baseModel.modelId,
            current.plan.baseModel.revision,
            input.artifactDigest,
            input.localArtifactRef,
            receipt,
            input.operation.now,
            input.operation.now,
          ],
        );
        await releaseReservation(
          transaction,
          current,
          input.settledCostMicros,
          input.operation.now,
        );
        await updateTerminalJob(transaction, current, {
          status: "artifact_ready",
          settledCostMicros: input.settledCostMicros,
          costSource: input.costSource,
          failureCode: null,
          artifactId,
          now: input.operation.now,
        });
        const job = await requireJob(transaction, jobId);
        const artifact = await requireArtifact(transaction, artifactId);
        await insertClaim(transaction, input.operation, {
          projectId: job.projectId,
          operation: "job_complete",
          entityType: "artifact",
          entityId: artifact.id,
          revision: artifact.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: job.projectId,
          entityType: "artifact",
          entityId: artifact.id,
          action: "artifact_created",
          metadata: {
            jobId: job.id,
            datasetId: job.datasetId,
            artifactDigest: artifact.artifactDigest,
            localArtifactRef: artifact.localArtifactRef,
            settledCostMicros: input.settledCostMicros,
            costSource: input.costSource,
          },
        });
        return Object.freeze({ job, artifact });
      }),
    );
  }

  public failJob(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly errorCode: string;
    readonly retryable: boolean;
    readonly settledCostMicros: number;
    readonly costSource: "local_resource_estimate" | "provider_reported";
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const jobId = requireUuid(input.jobId, "jobId");
        const workerId = requireLowerKey(input.workerId, "workerId");
        requireErrorCode(input.errorCode);
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "job", jobId);
          return requireJob(transaction, jobId);
        }
        const current = await requireJob(transaction, jobId);
        requireWorkerJob(current, input.expectedRevision, workerId, ["running", "cancelling"]);
        requireSettlement(input.settledCostMicros, current.reservedCostMicros);
        const requestedState: FineTuningJobState =
          input.retryable && current.attemptCount < current.maximumAttempts
            ? "failed_retryable"
            : "failed_final";
        const transition = assertFineTuningJobTransition(current.status, requestedState);
        if (!transition.ok) abortPersistence(transition.error);
        await releaseReservation(
          transaction,
          current,
          input.settledCostMicros,
          input.operation.now,
        );
        await updateTerminalJob(transaction, current, {
          status: requestedState,
          settledCostMicros: input.settledCostMicros,
          costSource: input.costSource,
          failureCode: input.errorCode,
          artifactId: null,
          now: input.operation.now,
        });
        const job = await requireJob(transaction, jobId);
        await insertClaim(transaction, input.operation, {
          projectId: job.projectId,
          operation: "job_fail",
          entityType: "job",
          entityId: job.id,
          revision: job.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: job.projectId,
          entityType: "job",
          entityId: job.id,
          action: "job_failed",
          metadata: {
            errorCode: input.errorCode,
            retryable: requestedState === "failed_retryable",
            attemptCount: job.attemptCount,
            settledCostMicros: input.settledCostMicros,
            costSource: input.costSource,
          },
        });
        return job;
      }),
    );
  }

  public retryFailedJob(input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const jobId = requireUuid(input.jobId, "jobId");
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "job", jobId);
          return requireJob(transaction, jobId);
        }
        const current = await requireJob(transaction, jobId);
        requireRevision(current.revision, input.expectedRevision);
        if (
          current.status !== "failed_retryable" ||
          current.attemptCount >= current.maximumAttempts
        ) {
          invalid("Only a retryable job with attempts remaining can be requeued.");
        }
        const transition = assertFineTuningJobTransition(current.status, "queued");
        if (!transition.ok) abortPersistence(transition.error);
        const policy = await requirePolicy(transaction, current.projectId);
        if (
          policy.monthKey !== current.monthKey ||
          policy.activeJobs >= policy.maximumConcurrentJobs ||
          policy.spentMicros + policy.reservedMicros + current.reservedCostMicros >
            policy.monthlyCostLimitMicros
        ) {
          quotaExceeded("The retry cannot reacquire its original bounded reservation.");
        }
        const policyUpdated = await transaction.execute(
          `UPDATE fine_tuning_quota_policies
           SET active_jobs = active_jobs + 1,
               reserved_micros = reserved_micros + ?,
               revision = revision + 1, updated_at = ?
           WHERE project_id = ? AND revision = ?`,
          [current.reservedCostMicros, input.operation.now, current.projectId, policy.revision],
        );
        if (policyUpdated.rowsAffected !== 1) {
          quotaExceeded("The retry quota changed concurrently.");
        }
        const updated = await transaction.execute(
          `UPDATE fine_tuning_jobs
           SET status = 'queued', revision = revision + 1,
               cancellation_requested = 0, settled_cost_micros = NULL,
               cost_source = NULL, failure_code = NULL, completed_at = NULL,
               updated_at = ?
           WHERE id = ? AND revision = ? AND status = 'failed_retryable'`,
          [input.operation.now, current.id, current.revision],
        );
        if (updated.rowsAffected !== 1) conflict("The retryable job changed concurrently.");
        const job = await requireJob(transaction, jobId);
        await insertClaim(transaction, input.operation, {
          projectId: job.projectId,
          operation: "job_recover",
          entityType: "job",
          entityId: job.id,
          revision: job.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: job.projectId,
          entityType: "job",
          entityId: job.id,
          action: "job_recovered",
          metadata: {
            recoveryKind: "explicit_retry",
            attemptCount: job.attemptCount,
            maximumAttempts: job.maximumAttempts,
          },
        });
        return job;
      }),
    );
  }

  public recoverExpiredJob(input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const jobId = requireUuid(input.jobId, "jobId");
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "job", jobId);
          return requireJob(transaction, jobId);
        }
        const current = await requireJob(transaction, jobId);
        requireRevision(current.revision, input.expectedRevision);
        if (
          (current.status !== "running" && current.status !== "cancelling") ||
          current.leaseExpiresAt === null ||
          Date.parse(current.leaseExpiresAt) >= Date.parse(input.operation.now)
        ) {
          invalid("The fine-tuning job does not have an expired recoverable lease.");
        }
        let next: FineTuningJobState;
        if (current.cancellationRequested || current.status === "cancelling") {
          next = "cancelled";
        } else if (current.attemptCount < current.maximumAttempts) {
          next = "queued";
        } else {
          next = "failed_final";
        }
        if (next === "cancelled" || next === "failed_final") {
          await releaseReservation(transaction, current, 0, input.operation.now);
        }
        const updated = await transaction.execute(
          `UPDATE fine_tuning_jobs
           SET status = ?, revision = revision + 1, lease_owner = NULL,
               lease_expires_at = NULL,
               failure_code = CASE WHEN ? = 'failed_final'
                 THEN 'FINE_TUNING_WORKER_LEASE_EXHAUSTED' ELSE NULL END,
               completed_at = CASE WHEN ? IN ('cancelled', 'failed_final')
                 THEN ? ELSE NULL END,
               updated_at = ?
           WHERE id = ? AND revision = ?
             AND status IN ('running', 'cancelling')
             AND lease_expires_at < ?`,
          [
            next,
            next,
            next,
            input.operation.now,
            input.operation.now,
            current.id,
            current.revision,
            input.operation.now,
          ],
        );
        if (updated.rowsAffected !== 1) conflict("The worker lease changed before recovery.");
        const job = await requireJob(transaction, jobId);
        await insertClaim(transaction, input.operation, {
          projectId: job.projectId,
          operation: "job_recover",
          entityType: "job",
          entityId: job.id,
          revision: job.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: job.projectId,
          entityType: "job",
          entityId: job.id,
          action:
            next === "cancelled"
              ? "job_cancelled"
              : next === "failed_final"
                ? "job_failed"
                : "job_recovered",
          metadata: {
            recoveryKind: "expired_lease",
            previousState: current.status,
            nextState: next,
            attemptCount: current.attemptCount,
          },
        });
        return job;
      }),
    );
  }

  public listRecoverableJobs(
    projectId: string,
    now: string,
    limit = 100,
  ): Promise<Result<readonly FineTuningJobRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const validProjectId = requireUuid(projectId, "projectId");
      requireTimestamp(now, "now");
      requireInteger(limit, 1, 500, "limit");
      const rows = await this.executor.select<JobRow>(
        `${JOB_SELECT}
         WHERE project_id = ?
           AND (
             status IN ('queued', 'failed_retryable')
             OR (
               status IN ('running', 'cancelling')
               AND lease_expires_at < ?
             )
           )
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
        [validProjectId, now, limit],
      );
      return Object.freeze(rows.map(hydrateJob));
    });
  }

  public findJob(jobId: string): Promise<Result<FineTuningJobRecord | null, StoryCoreError>> {
    return runPersistence(() => readJob(this.executor, requireUuid(jobId, "jobId")));
  }

  public listJobs(
    projectId: string,
    limit = 100,
  ): Promise<Result<readonly FineTuningJobRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const validProjectId = requireUuid(projectId, "projectId");
      requireInteger(limit, 1, 500, "limit");
      const rows = await this.executor.select<JobRow>(
        `${JOB_SELECT}
         WHERE project_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [validProjectId, limit],
      );
      return Object.freeze(rows.map(hydrateJob));
    });
  }

  public recordEvaluation(input: {
    readonly id: string;
    readonly projectId: string;
    readonly artifactId: string;
    readonly evaluatorId: string;
    readonly evaluatorVersion: string;
    readonly authorityHash: string;
    readonly gateInput: FineTuningEvaluationGateInput;
    readonly gateResult: FineTuningEvaluationGateResult;
    readonly createdBy: string;
    readonly expectedArtifactRevision: number;
    readonly operation: FineTuningOperationContext;
  }): Promise<
    Result<
      Readonly<{
        evaluation: FineTuningEvaluationRecord;
        artifact: FineTuningModelArtifactRecord;
      }>,
      StoryCoreError
    >
  > {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const id = requireUuid(input.id, "evaluationId");
        const projectId = requireUuid(input.projectId, "projectId");
        const artifactId = requireUuid(input.artifactId, "artifactId");
        const evaluatorId = requireLowerKey(input.evaluatorId, "evaluatorId");
        requireText(input.evaluatorVersion, 1, 256, "evaluatorVersion");
        requireHash(input.authorityHash, "authorityHash");
        const createdBy = requireLowerKey(input.createdBy, "createdBy");
        if (
          input.gateResult.candidateArtifactId !== artifactId ||
          input.gateInput.candidateArtifactId !== artifactId ||
          input.gateResult.baselineModelId !== input.gateInput.baselineModelId
        ) {
          invalid("Evaluation result does not match its immutable authority input.");
        }
        const recomputed = evaluateFineTuningCandidate(input.gateInput);
        if (!recomputed.ok) {
          abortPersistence(recomputed.error);
        }
        const recomputedAuthorityHash = await computeFineTuningEvaluationAuthorityHash(
          input.gateInput,
          recomputed.value,
        );
        if (
          recomputedAuthorityHash !== input.authorityHash ||
          serializeJson(recomputed.value) !== serializeJson(input.gateResult)
        ) {
          invalid("Evaluation result or authority hash does not match the deterministic gate.");
        }
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "evaluation", id);
          return {
            evaluation: await requireEvaluation(transaction, id),
            artifact: await requireArtifact(transaction, artifactId),
          };
        }
        const artifact = await requireArtifact(transaction, artifactId);
        requireRevision(artifact.revision, input.expectedArtifactRevision);
        if (
          artifact.projectId !== projectId ||
          (artifact.state !== "candidate" && artifact.state !== "evaluation_failed")
        ) {
          invalid("Only an unevaluated or failed candidate artifact can be evaluated.");
        }
        const nextState: FineTuningArtifactState = input.gateResult.passed
          ? "evaluation_passed"
          : "evaluation_failed";
        if (!canTransitionFineTuningArtifact(artifact.state, nextState)) {
          invalid("The artifact cannot enter the evaluation result state.");
        }
        await transaction.execute(
          `INSERT INTO fine_tuning_evaluations (
             id, project_id, artifact_id, baseline_model_id, evaluator_id,
             evaluator_version, authority_hash, baseline_metrics_json,
             candidate_metrics_json, rules_json, observations_json, passed,
             created_by, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            projectId,
            artifactId,
            input.gateInput.baselineModelId,
            evaluatorId,
            input.evaluatorVersion,
            input.authorityHash,
            serializeJson(input.gateInput.baseline),
            serializeJson(input.gateInput.candidate),
            serializeJson(input.gateInput.rules),
            serializeJson(input.gateResult.observations),
            input.gateResult.passed ? 1 : 0,
            createdBy,
            input.operation.now,
          ],
        );
        await transitionArtifact(transaction, artifact, nextState, input.operation.now, {
          latestEvaluationId: id,
        });
        const evaluation = await requireEvaluation(transaction, id);
        const updatedArtifact = await requireArtifact(transaction, artifactId);
        await insertClaim(transaction, input.operation, {
          projectId,
          operation: "evaluation_record",
          entityType: "evaluation",
          entityId: id,
          revision: 1,
        });
        await insertAudit(transaction, input.operation, {
          projectId,
          entityType: "evaluation",
          entityId: id,
          action: input.gateResult.passed ? "evaluation_passed" : "evaluation_failed",
          metadata: {
            artifactId,
            authorityHash: input.authorityHash,
            baselineModelId: input.gateInput.baselineModelId,
            evaluatorId,
            evaluatorVersion: input.evaluatorVersion,
            passed: input.gateResult.passed,
            failedMetricCount: input.gateResult.observations.filter(({ passed }) => !passed).length,
          },
        });
        return Object.freeze({ evaluation, artifact: updatedArtifact });
      }),
    );
  }

  public approveRegistration(input: {
    readonly approvalId: string;
    readonly artifactId: string;
    readonly expectedRevision: number;
    readonly authorityHash: string;
    readonly humanConfirmed: unknown;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return this.approveArtifactStep({
      ...input,
      kind: "model_registration",
      operationName: "registration_approve",
      currentState: "evaluation_passed",
      nextState: "registration_approved",
      auditAction: "registration_approved",
    });
  }

  public registerArtifact(input: {
    readonly artifactId: string;
    readonly expectedRevision: number;
    readonly registrationApprovalId: string;
    readonly registrationName: string;
    readonly providerReceiptDigest: string;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const artifactId = requireUuid(input.artifactId, "artifactId");
        const approvalId = requireUuid(input.registrationApprovalId, "registrationApprovalId");
        const registrationName = requireText(input.registrationName, 1, 200, "registrationName");
        requireHash(input.providerReceiptDigest, "providerReceiptDigest");
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "artifact", artifactId);
          return requireArtifact(transaction, artifactId);
        }
        const artifact = await requireArtifact(transaction, artifactId);
        requireRevision(artifact.revision, input.expectedRevision);
        const approval = await requireApproval(transaction, approvalId);
        requireArtifactApproval(approval, artifact, "model_registration");
        if (
          artifact.state !== "registration_approved" ||
          !canTransitionFineTuningArtifact(artifact.state, "registered")
        ) {
          invalid("The artifact does not have a current registration approval.");
        }
        await transitionArtifact(transaction, artifact, "registered", input.operation.now, {
          registrationName,
          providerReceiptDigest: input.providerReceiptDigest,
        });
        const updated = await requireArtifact(transaction, artifactId);
        await insertClaim(transaction, input.operation, {
          projectId: updated.projectId,
          operation: "artifact_register",
          entityType: "artifact",
          entityId: updated.id,
          revision: updated.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: updated.projectId,
          entityType: "artifact",
          entityId: updated.id,
          action: "artifact_registered",
          metadata: {
            registrationApprovalId: approvalId,
            registrationName,
            providerReceiptDigest: input.providerReceiptDigest,
          },
        });
        return updated;
      }),
    );
  }

  public approveDeployment(input: {
    readonly approvalId: string;
    readonly artifactId: string;
    readonly expectedRevision: number;
    readonly targetRole: FineTuningDeploymentTargetRole;
    readonly authorityHash: string;
    readonly humanConfirmed: unknown;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    requireDeploymentTargetRole(input.targetRole);
    return this.approveArtifactStep({
      ...input,
      kind: "model_deployment",
      operationName: "deployment_approve",
      currentState: "registered",
      nextState: "deployment_approved",
      auditAction: "deployment_approved",
      approvalDeclarations: {
        targetRole: input.targetRole,
      },
    });
  }

  public activateDeployment(input: {
    readonly deploymentId: string;
    readonly artifactId: string;
    readonly expectedArtifactRevision: number;
    readonly deploymentApprovalId: string;
    readonly targetRole: FineTuningDeploymentTargetRole;
    readonly providerReceiptDigest: string;
    readonly operation: FineTuningOperationContext;
  }): Promise<
    Result<
      Readonly<{
        deployment: FineTuningDeploymentRecord;
        artifact: FineTuningModelArtifactRecord;
      }>,
      StoryCoreError
    >
  > {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const deploymentId = requireUuid(input.deploymentId, "deploymentId");
        const artifactId = requireUuid(input.artifactId, "artifactId");
        const approvalId = requireUuid(input.deploymentApprovalId, "deploymentApprovalId");
        requireDeploymentTargetRole(input.targetRole);
        requireHash(input.providerReceiptDigest, "providerReceiptDigest");
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "deployment", deploymentId);
          return {
            deployment: await requireDeployment(transaction, deploymentId),
            artifact: await requireArtifact(transaction, artifactId),
          };
        }
        const artifact = await requireArtifact(transaction, artifactId);
        requireRevision(artifact.revision, input.expectedArtifactRevision);
        const approval = await requireApproval(transaction, approvalId);
        requireArtifactApproval(approval, artifact, "model_deployment", {
          targetRole: input.targetRole,
        });
        if (
          artifact.state !== "deployment_approved" ||
          !canTransitionFineTuningArtifact(artifact.state, "deployed")
        ) {
          invalid("The artifact is not approved for deployment.");
        }
        const previousRows = await transaction.select<DeploymentRow>(
          `${DEPLOYMENT_SELECT}
           WHERE project_id = ? AND target_role = ? AND status = 'active'
           LIMIT 1`,
          [artifact.projectId, input.targetRole],
        );
        const previous = previousRows[0] === undefined ? null : hydrateDeployment(previousRows[0]);
        if (previous !== null) {
          await transaction.execute(
            `UPDATE fine_tuning_deployments
             SET status = 'rolled_back', ended_at = ?
             WHERE id = ? AND status = 'active'`,
            [input.operation.now, previous.id],
          );
          const previousArtifact = await requireArtifact(transaction, previous.artifactId);
          if (
            previousArtifact.state === "deployed" &&
            canTransitionFineTuningArtifact(previousArtifact.state, "rolled_back")
          ) {
            await transitionArtifact(
              transaction,
              previousArtifact,
              "rolled_back",
              input.operation.now,
            );
          }
        }
        await transaction.execute(
          `INSERT INTO fine_tuning_deployments (
             id, project_id, artifact_id, target_role,
             previous_deployment_id, approval_id, status,
             provider_receipt_digest, activated_at, ended_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
          [
            deploymentId,
            artifact.projectId,
            artifact.id,
            input.targetRole,
            previous?.id ?? null,
            approvalId,
            input.providerReceiptDigest,
            input.operation.now,
          ],
        );
        await transitionArtifact(transaction, artifact, "deployed", input.operation.now);
        const deployment = await requireDeployment(transaction, deploymentId);
        const updatedArtifact = await requireArtifact(transaction, artifactId);
        await insertClaim(transaction, input.operation, {
          projectId: artifact.projectId,
          operation: "deployment_activate",
          entityType: "deployment",
          entityId: deployment.id,
          revision: 1,
        });
        await insertAudit(transaction, input.operation, {
          projectId: artifact.projectId,
          entityType: "deployment",
          entityId: deployment.id,
          action: "deployment_activated",
          metadata: {
            artifactId,
            targetRole: input.targetRole,
            previousDeploymentId: previous?.id ?? null,
            approvalId,
            providerReceiptDigest: input.providerReceiptDigest,
          },
        });
        return Object.freeze({ deployment, artifact: updatedArtifact });
      }),
    );
  }

  public rollbackDeployment(input: {
    readonly deploymentId: string;
    readonly rollbackApprovalId: string;
    readonly authorityHash: string;
    readonly humanConfirmed: unknown;
    readonly providerReceiptDigest: string;
    readonly operation: FineTuningOperationContext;
  }): Promise<
    Result<
      Readonly<{
        deployment: FineTuningDeploymentRecord;
        artifact: FineTuningModelArtifactRecord;
        restoredDeployment: FineTuningDeploymentRecord | null;
      }>,
      StoryCoreError
    >
  > {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const deploymentId = requireUuid(input.deploymentId, "deploymentId");
        const approvalId = requireUuid(input.rollbackApprovalId, "rollbackApprovalId");
        requireHash(input.authorityHash, "authorityHash");
        requireHash(input.providerReceiptDigest, "providerReceiptDigest");
        if (input.humanConfirmed !== true) humanApprovalRequired();
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "deployment", deploymentId);
          const deployment = await requireDeployment(transaction, deploymentId);
          return {
            deployment,
            artifact: await requireArtifact(transaction, deployment.artifactId),
            restoredDeployment:
              deployment.previousDeploymentId === null
                ? null
                : await readDeployment(transaction, deployment.previousDeploymentId),
          };
        }
        const deployment = await requireDeployment(transaction, deploymentId);
        if (deployment.status !== "active") {
          invalid("Only an active fine-tuned model deployment can be rolled back.");
        }
        const artifact = await requireArtifact(transaction, deployment.artifactId);
        if (
          artifact.state !== "deployed" ||
          !canTransitionFineTuningArtifact(artifact.state, "rolled_back")
        ) {
          invalid("The deployed artifact is not rollback-eligible.");
        }
        await insertApproval(transaction, {
          id: approvalId,
          projectId: artifact.projectId,
          kind: "model_rollback",
          entityType: "deployment",
          entityId: deployment.id,
          entityRevision: artifact.revision,
          authorityHash: input.authorityHash,
          actorId: requireLowerKey(input.operation.actorId, "actorId"),
          declarations: {
            humanConfirmed: true,
            targetRole: deployment.targetRole,
            providerReceiptDigest: input.providerReceiptDigest,
          },
          createdAt: input.operation.now,
        });
        await transaction.execute(
          `UPDATE fine_tuning_deployments
           SET status = 'rolled_back', ended_at = ?
           WHERE id = ? AND status = 'active'`,
          [input.operation.now, deployment.id],
        );
        await transitionArtifact(transaction, artifact, "rolled_back", input.operation.now);

        let restoredDeployment: FineTuningDeploymentRecord | null = null;
        if (deployment.previousDeploymentId !== null) {
          const previous = await requireDeployment(transaction, deployment.previousDeploymentId);
          const previousArtifact = await requireArtifact(transaction, previous.artifactId);
          if (previous.status === "rolled_back" && previousArtifact.state === "rolled_back") {
            await transaction.execute(
              `UPDATE fine_tuning_deployments
               SET status = 'active', ended_at = NULL,
                   provider_receipt_digest = ?
               WHERE id = ? AND status = 'rolled_back'`,
              [input.providerReceiptDigest, previous.id],
            );
            // Rollback is the only governed reverse edge: it restores a
            // previously approved deployment rather than creating a new model.
            await transaction.execute(
              `UPDATE fine_tuning_model_artifacts
               SET state = 'deployed', revision = revision + 1, updated_at = ?
               WHERE id = ? AND revision = ? AND state = 'rolled_back'`,
              [input.operation.now, previousArtifact.id, previousArtifact.revision],
            );
            restoredDeployment = await requireDeployment(transaction, previous.id);
          }
        }
        const rolledBack = await requireDeployment(transaction, deploymentId);
        const rolledBackArtifact = await requireArtifact(transaction, artifact.id);
        await insertClaim(transaction, input.operation, {
          projectId: artifact.projectId,
          operation: "deployment_rollback",
          entityType: "deployment",
          entityId: deployment.id,
          revision: rolledBackArtifact.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: artifact.projectId,
          entityType: "deployment",
          entityId: deployment.id,
          action: "deployment_rolled_back",
          metadata: {
            artifactId: artifact.id,
            targetRole: deployment.targetRole,
            restoredDeploymentId: restoredDeployment?.id ?? null,
            rollbackApprovalId: approvalId,
            providerReceiptDigest: input.providerReceiptDigest,
          },
        });
        return Object.freeze({
          deployment: rolledBack,
          artifact: rolledBackArtifact,
          restoredDeployment,
        });
      }),
    );
  }

  public revokeArtifact(input: {
    readonly approvalId: string;
    readonly artifactId: string;
    readonly expectedRevision: number;
    readonly authorityHash: string;
    readonly humanConfirmed: unknown;
    readonly operation: FineTuningOperationContext;
  }): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const approvalId = requireUuid(input.approvalId, "approvalId");
        const artifactId = requireUuid(input.artifactId, "artifactId");
        requireHash(input.authorityHash, "authorityHash");
        if (input.humanConfirmed !== true) humanApprovalRequired();
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "artifact", artifactId);
          return requireArtifact(transaction, artifactId);
        }
        const artifact = await requireArtifact(transaction, artifactId);
        requireRevision(artifact.revision, input.expectedRevision);
        if (!canTransitionFineTuningArtifact(artifact.state, "revoked")) {
          invalid("The fine-tuned model artifact is already terminal.");
        }
        const activeDeployments = await transaction.select<DeploymentRow>(
          `${DEPLOYMENT_SELECT}
           WHERE artifact_id = ? AND status = 'active'`,
          [artifact.id],
        );
        for (const row of activeDeployments) {
          await transaction.execute(
            `UPDATE fine_tuning_deployments
             SET status = 'revoked', ended_at = ?
             WHERE id = ? AND status = 'active'`,
            [input.operation.now, row.id],
          );
        }
        await insertApproval(transaction, {
          id: approvalId,
          projectId: artifact.projectId,
          kind: "model_revocation",
          entityType: "artifact",
          entityId: artifact.id,
          entityRevision: artifact.revision,
          authorityHash: input.authorityHash,
          actorId: requireLowerKey(input.operation.actorId, "actorId"),
          declarations: {
            humanConfirmed: true,
            activeDeploymentCount: activeDeployments.length,
          },
          createdAt: input.operation.now,
        });
        await transitionArtifact(transaction, artifact, "revoked", input.operation.now);
        const updated = await requireArtifact(transaction, artifact.id);
        await insertClaim(transaction, input.operation, {
          projectId: artifact.projectId,
          operation: "artifact_revoke",
          entityType: "artifact",
          entityId: artifact.id,
          revision: updated.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: artifact.projectId,
          entityType: "artifact",
          entityId: artifact.id,
          action: "artifact_revoked",
          metadata: {
            approvalId,
            previousState: artifact.state,
            activeDeploymentCount: activeDeployments.length,
          },
        });
        return updated;
      }),
    );
  }

  public findArtifact(
    artifactId: string,
  ): Promise<Result<FineTuningModelArtifactRecord | null, StoryCoreError>> {
    return runPersistence(() => readArtifact(this.executor, requireUuid(artifactId, "artifactId")));
  }

  public listArtifacts(
    projectId: string,
    limit = 100,
  ): Promise<Result<readonly FineTuningModelArtifactRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const validProjectId = requireUuid(projectId, "projectId");
      requireInteger(limit, 1, 500, "limit");
      const rows = await this.executor.select<ArtifactRow>(
        `${ARTIFACT_SELECT}
         WHERE project_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [validProjectId, limit],
      );
      return Object.freeze(rows.map(hydrateArtifact));
    });
  }

  public listDeployments(
    projectId: string,
    limit = 100,
  ): Promise<Result<readonly FineTuningDeploymentRecord[], StoryCoreError>> {
    return runPersistence(async () => {
      const validProjectId = requireUuid(projectId, "projectId");
      requireInteger(limit, 1, 500, "limit");
      const rows = await this.executor.select<DeploymentRow>(
        `${DEPLOYMENT_SELECT}
         WHERE project_id = ?
         ORDER BY activated_at DESC, id DESC
         LIMIT ?`,
        [validProjectId, limit],
      );
      return Object.freeze(rows.map(hydrateDeployment));
    });
  }

  private approveArtifactStep(input: {
    readonly approvalId: string;
    readonly artifactId: string;
    readonly expectedRevision: number;
    readonly authorityHash: string;
    readonly humanConfirmed: unknown;
    readonly operation: FineTuningOperationContext;
    readonly kind: "model_registration" | "model_deployment";
    readonly operationName: "registration_approve" | "deployment_approve";
    readonly currentState: "evaluation_passed" | "registered";
    readonly nextState: "registration_approved" | "deployment_approved";
    readonly auditAction: "registration_approved" | "deployment_approved";
    readonly approvalDeclarations?: Readonly<Record<string, unknown>>;
  }): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateOperation(input.operation);
        const approvalId = requireUuid(input.approvalId, "approvalId");
        const artifactId = requireUuid(input.artifactId, "artifactId");
        requireHash(input.authorityHash, "authorityHash");
        if (input.humanConfirmed !== true) humanApprovalRequired();
        const replay = await readClaim(transaction, input.operation);
        if (replay !== null) {
          assertClaimResult(replay, "artifact", artifactId);
          return requireArtifact(transaction, artifactId);
        }
        const artifact = await requireArtifact(transaction, artifactId);
        requireRevision(artifact.revision, input.expectedRevision);
        if (
          artifact.state !== input.currentState ||
          !canTransitionFineTuningArtifact(artifact.state, input.nextState)
        ) {
          invalid("The artifact is not eligible for this human approval.");
        }
        if (input.kind === "model_registration") {
          if (artifact.latestEvaluationId === null) {
            invalid("Model registration requires a passed baseline comparison.");
          }
          const evaluation = await requireEvaluation(transaction, artifact.latestEvaluationId);
          if (!evaluation.result.passed) {
            invalid("A failed candidate evaluation cannot be approved for registration.");
          }
        }
        await insertApproval(transaction, {
          id: approvalId,
          projectId: artifact.projectId,
          kind: input.kind,
          entityType: "artifact",
          entityId: artifact.id,
          entityRevision: artifact.revision,
          authorityHash: input.authorityHash,
          actorId: requireLowerKey(input.operation.actorId, "actorId"),
          declarations: {
            humanConfirmed: true,
            artifactDigest: artifact.artifactDigest,
            latestEvaluationId: artifact.latestEvaluationId,
            previousState: artifact.state,
            ...(input.approvalDeclarations ?? {}),
          },
          createdAt: input.operation.now,
        });
        await transitionArtifact(transaction, artifact, input.nextState, input.operation.now);
        const updated = await requireArtifact(transaction, artifactId);
        await insertClaim(transaction, input.operation, {
          projectId: artifact.projectId,
          operation: input.operationName,
          entityType: "artifact",
          entityId: artifact.id,
          revision: updated.revision,
        });
        await insertAudit(transaction, input.operation, {
          projectId: artifact.projectId,
          entityType: "artifact",
          entityId: artifact.id,
          action: input.auditAction,
          metadata: {
            approvalId,
            authorityHash: input.authorityHash,
            previousState: artifact.state,
            nextState: input.nextState,
          },
        });
        return updated;
      }),
    );
  }
}

async function readDataset(
  executor: StorySqlTransaction,
  datasetId: string,
): Promise<FineTuningDatasetSnapshot | null> {
  const rows = await executor.select<DatasetRow>(`${DATASET_SELECT} WHERE id = ?`, [datasetId]);
  return rows[0] === undefined ? null : hydrateDataset(executor, rows[0]);
}

async function requireDataset(
  executor: StorySqlTransaction,
  datasetId: string,
): Promise<FineTuningDatasetSnapshot> {
  const dataset = await readDataset(executor, datasetId);
  if (dataset === null) notFound("Fine-tuning dataset was not found.");
  return dataset;
}

async function hydrateDataset(
  executor: StorySqlTransaction,
  row: DatasetRow,
): Promise<FineTuningDatasetSnapshot> {
  const manifest = parseJsonObject(row.manifest_json, "dataset manifest");
  if (manifest.schemaVersion !== 1 || !isRecord(manifest.splitPolicy)) {
    corrupt("FINE_TUNING_DATASET_MANIFEST_INVALID");
  }
  const samples = (
    await executor.select<SampleRow>(
      `${SAMPLE_SELECT}
       WHERE dataset_id = ?
       ORDER BY created_at ASC, id ASC`,
      [row.id],
    )
  ).map(hydrateSample);
  const readinessIssues = parseJsonArray(
    row.readiness_issues_json,
    "dataset readiness issues",
  ) as unknown as FineTuningDatasetReadinessIssue[];
  const dataset = deepFreeze({
    schemaVersion: 1 as const,
    id: row.id as UuidV7,
    projectId: row.project_id as UuidV7,
    name: row.name,
    state: row.state as FineTuningDatasetSnapshot["state"],
    revision: row.revision,
    splitPolicy: {
      seed: manifest.splitPolicy.seed as SafeIdentifier,
      trainParts: manifest.splitPolicy.trainParts as number,
      validationParts: manifest.splitPolicy.validationParts as number,
      testParts: manifest.splitPolicy.testParts as number,
    },
    samples,
    manifestHash: row.manifest_hash,
    totalContentBytes: row.total_content_bytes,
    includedSampleCount: row.included_sample_count,
    duplicateSampleCount: row.duplicate_sample_count,
    splitCounts: {
      train: row.train_sample_count,
      validation: row.validation_sample_count,
      test: row.test_sample_count,
    },
    readinessIssues,
    approvedBy: row.approved_by as SafeIdentifier | null,
    approvedAt: row.approved_at as IsoUtcTimestamp | null,
    createdBy: row.created_by as SafeIdentifier,
    createdAt: row.created_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  });
  validateDatasetProjection(dataset);
  return dataset;
}

function hydrateSample(row: SampleRow): FineTuningDatasetSample {
  if (
    !FINE_TUNING_SOURCE_KINDS.includes(
      row.source_kind as (typeof FINE_TUNING_SOURCE_KINDS)[number],
    ) ||
    !FINE_TUNING_RIGHTS_KINDS.includes(
      row.rights_kind as (typeof FINE_TUNING_RIGHTS_KINDS)[number],
    ) ||
    !FINE_TUNING_SPLITS.includes(row.split as (typeof FINE_TUNING_SPLITS)[number]) ||
    row.privacy_scan_version !== FINE_TUNING_PRIVACY_SCAN_VERSION
  ) {
    corrupt("FINE_TUNING_SAMPLE_ENUM_INVALID");
  }
  const findings = parseJsonArray(
    row.privacy_findings_json,
    "privacy findings",
  ) as unknown as FineTuningPrivacyFinding[];
  return deepFreeze({
    id: row.id as UuidV7,
    source: {
      kind: row.source_kind as FineTuningDatasetSample["source"]["kind"],
      projectId: row.project_id as UuidV7,
      entityId: row.source_entity_id as UuidV7,
      entityRevision: row.source_revision,
      label: row.source_label,
    },
    content: row.content_text,
    contentHash: row.content_hash,
    contentBytes: row.content_bytes,
    rights: {
      kind: row.rights_kind as FineTuningDatasetSample["rights"]["kind"],
      basis: row.rights_basis,
      confirmedAt: row.rights_confirmed_at as IsoUtcTimestamp | null,
      allowTraining: booleanInteger(row.allow_training, "allow_training"),
    },
    privacy: {
      version: FINE_TUNING_PRIVACY_SCAN_VERSION,
      piiFindingCount: row.pii_finding_count,
      sensitiveFindingCount: row.sensitive_finding_count,
      findings,
      passed: booleanInteger(row.privacy_passed, "privacy_passed"),
    },
    split: row.split as FineTuningDatasetSample["split"],
    duplicateOfSampleId: row.duplicate_of_sample_id as UuidV7 | null,
  });
}

async function insertSample(
  transaction: StorySqlTransaction,
  dataset: FineTuningDatasetSnapshot,
  sample: FineTuningDatasetSample,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO fine_tuning_samples (
       id, dataset_id, project_id, source_kind, source_entity_id,
       source_revision, source_label, content_text, content_hash,
       content_bytes, rights_kind, rights_basis, rights_confirmed_at,
       allow_training, privacy_scan_version, pii_finding_count,
       sensitive_finding_count, privacy_findings_json, privacy_passed,
       split, duplicate_of_sample_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sample.id,
      dataset.id,
      dataset.projectId,
      sample.source.kind,
      sample.source.entityId,
      sample.source.entityRevision,
      sample.source.label,
      sample.content,
      sample.contentHash,
      sample.contentBytes,
      sample.rights.kind,
      sample.rights.basis,
      sample.rights.confirmedAt,
      sample.rights.allowTraining ? 1 : 0,
      sample.privacy.version,
      sample.privacy.piiFindingCount,
      sample.privacy.sensitiveFindingCount,
      serializeJson(sample.privacy.findings),
      sample.privacy.passed ? 1 : 0,
      sample.split,
      sample.duplicateOfSampleId,
      dataset.createdAt,
    ],
  );
}

function validateDatasetProjection(dataset: FineTuningDatasetSnapshot): void {
  if (
    !FINE_TUNING_DATASET_STATES.includes(dataset.state) ||
    !UUID_V7_PATTERN.test(dataset.id) ||
    !UUID_V7_PATTERN.test(dataset.projectId) ||
    !SHA256_PATTERN.test(dataset.manifestHash) ||
    dataset.samples.length === 0 ||
    dataset.samples.length > 20_000 ||
    dataset.totalContentBytes !==
      dataset.samples.reduce((sum, sample) => sum + sample.contentBytes, 0) ||
    dataset.includedSampleCount !==
      dataset.samples.filter(({ split }) => split !== "excluded").length ||
    dataset.duplicateSampleCount !==
      dataset.samples.filter(({ duplicateOfSampleId }) => duplicateOfSampleId !== null).length ||
    dataset.splitCounts.train !== dataset.samples.filter(({ split }) => split === "train").length ||
    dataset.splitCounts.validation !==
      dataset.samples.filter(({ split }) => split === "validation").length ||
    dataset.splitCounts.test !== dataset.samples.filter(({ split }) => split === "test").length
  ) {
    corrupt("FINE_TUNING_DATASET_PROJECTION_MISMATCH");
  }
  for (const sample of dataset.samples) {
    if (
      sample.source.projectId !== dataset.projectId ||
      !SHA256_PATTERN.test(sample.contentHash) ||
      sample.contentBytes !== new TextEncoder().encode(sample.content).byteLength
    ) {
      corrupt("FINE_TUNING_SAMPLE_PROJECTION_MISMATCH");
    }
  }
}

async function readPolicy(
  executor: StorySqlTransaction,
  projectId: string,
): Promise<FineTuningQuotaPolicyRecord | null> {
  const rows = await executor.select<PolicyRow>(`${POLICY_SELECT} WHERE project_id = ?`, [
    projectId,
  ]);
  return rows[0] === undefined ? null : hydratePolicy(rows[0]);
}

async function requirePolicy(
  executor: StorySqlTransaction,
  projectId: string,
): Promise<FineTuningQuotaPolicyRecord> {
  const policy = await readPolicy(executor, projectId);
  if (policy === null) {
    quotaExceeded("A fine-tuning quota policy must be configured before training.");
  }
  return policy;
}

function hydratePolicy(row: PolicyRow): FineTuningQuotaPolicyRecord {
  if (row.allow_remote_training !== 0) {
    corrupt("FINE_TUNING_REMOTE_POLICY_CORRUPT");
  }
  return deepFreeze({
    projectId: row.project_id as UuidV7,
    allowRemoteTraining: false,
    maximumDatasetBytes: row.maximum_dataset_bytes,
    maximumConcurrentJobs: row.maximum_concurrent_jobs,
    maximumSingleJobCostMicros: row.maximum_single_job_cost_micros,
    monthlyCostLimitMicros: row.monthly_cost_limit_micros,
    currency: row.currency,
    spentMicros: row.spent_micros,
    reservedMicros: row.reserved_micros,
    activeJobs: row.active_jobs,
    monthKey: row.month_key,
    revision: row.revision,
    createdAt: row.created_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  });
}

async function readJob(
  executor: StorySqlTransaction,
  jobId: string,
): Promise<FineTuningJobRecord | null> {
  const rows = await executor.select<JobRow>(`${JOB_SELECT} WHERE id = ?`, [jobId]);
  return rows[0] === undefined ? null : hydrateJob(rows[0]);
}

async function requireJob(
  executor: StorySqlTransaction,
  jobId: string,
): Promise<FineTuningJobRecord> {
  const job = await readJob(executor, jobId);
  if (job === null) notFound("Fine-tuning job was not found.");
  return job;
}

function hydrateJob(row: JobRow): FineTuningJobRecord {
  const plan = parseSnapshot(row.plan_json) as FineTuningTrainingPlan;
  if (
    !FINE_TUNING_JOB_STATES.includes(row.status as FineTuningJobState) ||
    plan.planHash !== row.plan_hash ||
    plan.provider.location !== row.provider_location ||
    plan.provider.providerId !== row.provider_id ||
    plan.datasetId !== row.dataset_id ||
    plan.datasetRevision !== row.dataset_revision ||
    plan.datasetManifestHash !== row.dataset_manifest_hash
  ) {
    corrupt("FINE_TUNING_JOB_PROJECTION_MISMATCH");
  }
  return deepFreeze({
    id: row.id as UuidV7,
    projectId: row.project_id as UuidV7,
    datasetId: row.dataset_id as UuidV7,
    datasetRevision: row.dataset_revision,
    datasetManifestHash: row.dataset_manifest_hash,
    datasetApprovalId: row.dataset_approval_id as UuidV7,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    plan,
    status: row.status as FineTuningJobState,
    revision: row.revision,
    attemptCount: row.attempt_count,
    maximumAttempts: row.maximum_attempts,
    cancellationRequested: booleanInteger(row.cancellation_requested, "cancellation_requested"),
    leaseOwner: row.lease_owner as SafeIdentifier | null,
    leaseExpiresAt: row.lease_expires_at as IsoUtcTimestamp | null,
    reservedCostMicros: row.reserved_cost_micros,
    settledCostMicros: row.settled_cost_micros,
    costSource: row.cost_source as FineTuningJobRecord["costSource"],
    currency: row.currency,
    monthKey: row.month_key,
    artifactId: row.artifact_id as UuidV7 | null,
    failureCode: row.failure_code,
    createdBy: row.created_by as SafeIdentifier,
    startedAt: row.started_at as IsoUtcTimestamp | null,
    completedAt: row.completed_at as IsoUtcTimestamp | null,
    createdAt: row.created_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  });
}

async function readArtifact(
  executor: StorySqlTransaction,
  artifactId: string,
): Promise<FineTuningModelArtifactRecord | null> {
  const rows = await executor.select<ArtifactRow>(`${ARTIFACT_SELECT} WHERE id = ?`, [artifactId]);
  return rows[0] === undefined ? null : hydrateArtifact(rows[0]);
}

async function requireArtifact(
  executor: StorySqlTransaction,
  artifactId: string,
): Promise<FineTuningModelArtifactRecord> {
  const artifact = await readArtifact(executor, artifactId);
  if (artifact === null) notFound("Fine-tuning model artifact was not found.");
  return artifact;
}

function hydrateArtifact(row: ArtifactRow): FineTuningModelArtifactRecord {
  if (!FINE_TUNING_ARTIFACT_STATES.includes(row.state as FineTuningArtifactState)) {
    corrupt("FINE_TUNING_ARTIFACT_STATE_INVALID");
  }
  return deepFreeze({
    id: row.id as UuidV7,
    projectId: row.project_id as UuidV7,
    datasetId: row.dataset_id as UuidV7,
    jobId: row.job_id as UuidV7,
    baseModelProviderId: row.base_model_provider_id as SafeIdentifier,
    baseModelId: row.base_model_id,
    baseModelRevision: row.base_model_revision,
    artifactDigest: row.artifact_digest,
    localArtifactRef: row.local_artifact_ref,
    state: row.state as FineTuningArtifactState,
    revision: row.revision,
    latestEvaluationId: row.latest_evaluation_id as UuidV7 | null,
    registrationName: row.registration_name,
    providerReceiptDigest: row.provider_receipt_digest,
    createdAt: row.created_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  });
}

async function requireEvaluation(
  executor: StorySqlTransaction,
  evaluationId: string,
): Promise<FineTuningEvaluationRecord> {
  const rows = await executor.select<EvaluationRow>(`${EVALUATION_SELECT} WHERE id = ?`, [
    evaluationId,
  ]);
  if (rows[0] === undefined) notFound("Fine-tuning evaluation was not found.");
  return hydrateEvaluation(rows[0]);
}

function hydrateEvaluation(row: EvaluationRow): FineTuningEvaluationRecord {
  const input: FineTuningEvaluationGateInput = {
    baselineModelId: row.baseline_model_id,
    candidateArtifactId: row.artifact_id,
    baseline: parseJsonArray(
      row.baseline_metrics_json,
      "baseline metrics",
    ) as unknown as FineTuningEvaluationGateInput["baseline"],
    candidate: parseJsonArray(
      row.candidate_metrics_json,
      "candidate metrics",
    ) as unknown as FineTuningEvaluationGateInput["candidate"],
    rules: parseJsonArray(
      row.rules_json,
      "evaluation rules",
    ) as unknown as FineTuningEvaluationGateInput["rules"],
  };
  const result: FineTuningEvaluationGateResult = {
    passed: booleanInteger(row.passed, "evaluation passed"),
    baselineModelId: row.baseline_model_id,
    candidateArtifactId: row.artifact_id,
    observations: parseJsonArray(
      row.observations_json,
      "evaluation observations",
    ) as unknown as FineTuningEvaluationGateResult["observations"],
  };
  return deepFreeze({
    id: row.id as UuidV7,
    projectId: row.project_id as UuidV7,
    artifactId: row.artifact_id as UuidV7,
    baselineModelId: row.baseline_model_id,
    evaluatorId: row.evaluator_id as SafeIdentifier,
    evaluatorVersion: row.evaluator_version,
    authorityHash: row.authority_hash,
    input,
    result,
    createdBy: row.created_by as SafeIdentifier,
    createdAt: row.created_at as IsoUtcTimestamp,
  });
}

async function readDeployment(
  executor: StorySqlTransaction,
  deploymentId: string,
): Promise<FineTuningDeploymentRecord | null> {
  const rows = await executor.select<DeploymentRow>(`${DEPLOYMENT_SELECT} WHERE id = ?`, [
    deploymentId,
  ]);
  return rows[0] === undefined ? null : hydrateDeployment(rows[0]);
}

async function requireDeployment(
  executor: StorySqlTransaction,
  deploymentId: string,
): Promise<FineTuningDeploymentRecord> {
  const deployment = await readDeployment(executor, deploymentId);
  if (deployment === null) notFound("Fine-tuning model deployment was not found.");
  return deployment;
}

function hydrateDeployment(row: DeploymentRow): FineTuningDeploymentRecord {
  requireDeploymentTargetRole(row.target_role);
  if (row.status !== "active" && row.status !== "rolled_back" && row.status !== "revoked") {
    corrupt("FINE_TUNING_DEPLOYMENT_STATUS_INVALID");
  }
  return deepFreeze({
    id: row.id as UuidV7,
    projectId: row.project_id as UuidV7,
    artifactId: row.artifact_id as UuidV7,
    targetRole: row.target_role as FineTuningDeploymentTargetRole,
    previousDeploymentId: row.previous_deployment_id as UuidV7 | null,
    approvalId: row.approval_id as UuidV7,
    status: row.status,
    providerReceiptDigest: row.provider_receipt_digest,
    activatedAt: row.activated_at as IsoUtcTimestamp,
    endedAt: row.ended_at as IsoUtcTimestamp | null,
  });
}

async function requireApproval(
  executor: StorySqlTransaction,
  approvalId: string,
): Promise<ApprovalRow> {
  const rows = await executor.select<ApprovalRow>(`${APPROVAL_SELECT} WHERE id = ?`, [approvalId]);
  if (rows[0] === undefined) notFound("Fine-tuning approval was not found.");
  return rows[0];
}

async function insertApproval(
  executor: StorySqlTransaction,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly kind:
      | "dataset_training"
      | "model_registration"
      | "model_deployment"
      | "model_rollback"
      | "model_revocation";
    readonly entityType: "dataset" | "artifact" | "deployment";
    readonly entityId: string;
    readonly entityRevision: number;
    readonly authorityHash: string;
    readonly actorId: string;
    readonly declarations: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  },
): Promise<void> {
  await executor.execute(
    `INSERT INTO fine_tuning_approvals (
       id, project_id, kind, entity_type, entity_id, entity_revision,
       authority_hash, actor_id, declarations_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.projectId,
      input.kind,
      input.entityType,
      input.entityId,
      input.entityRevision,
      input.authorityHash,
      input.actorId,
      serializeJson(input.declarations),
      input.createdAt,
    ],
  );
}

function requireArtifactApproval(
  approval: ApprovalRow,
  artifact: FineTuningModelArtifactRecord,
  kind: "model_registration" | "model_deployment",
  expectedDeclarations: Readonly<Record<string, unknown>> = {},
): void {
  if (
    approval.project_id !== artifact.projectId ||
    approval.kind !== kind ||
    approval.entity_type !== "artifact" ||
    approval.entity_id !== artifact.id ||
    approval.entity_revision !== artifact.revision - 1
  ) {
    invalid("The model action is not bound to the current artifact approval.");
  }
  const declarations = parseJsonObject(
    approval.declarations_json,
    "fine-tuning approval declarations",
  );
  for (const [key, expected] of Object.entries(expectedDeclarations)) {
    if (declarations[key] !== expected) {
      invalid("The model action changed after its human approval.");
    }
  }
}

async function transitionArtifact(
  transaction: StorySqlTransaction,
  artifact: FineTuningModelArtifactRecord,
  nextState: FineTuningArtifactState,
  now: string,
  changes: {
    readonly latestEvaluationId?: string;
    readonly registrationName?: string;
    readonly providerReceiptDigest?: string;
  } = {},
): Promise<void> {
  if (!canTransitionFineTuningArtifact(artifact.state, nextState)) {
    invalid(`Artifact cannot move from ${artifact.state} to ${nextState}.`);
  }
  const updated = await transaction.execute(
    `UPDATE fine_tuning_model_artifacts
     SET state = ?, revision = revision + 1,
         latest_evaluation_id = COALESCE(?, latest_evaluation_id),
         registration_name = COALESCE(?, registration_name),
         provider_receipt_digest = COALESCE(?, provider_receipt_digest),
         updated_at = ?
     WHERE id = ? AND revision = ? AND state = ?`,
    [
      nextState,
      changes.latestEvaluationId ?? null,
      changes.registrationName ?? null,
      changes.providerReceiptDigest ?? null,
      now,
      artifact.id,
      artifact.revision,
      artifact.state,
    ],
  );
  if (updated.rowsAffected !== 1) {
    conflict("The fine-tuned model artifact changed concurrently.");
  }
}

async function updateTerminalJob(
  transaction: StorySqlTransaction,
  current: FineTuningJobRecord,
  next: {
    readonly status: "cancelled" | "failed_retryable" | "failed_final" | "artifact_ready";
    readonly settledCostMicros: number;
    readonly costSource: "local_resource_estimate" | "provider_reported";
    readonly failureCode: string | null;
    readonly artifactId: string | null;
    readonly now: string;
  },
): Promise<void> {
  const updated = await transaction.execute(
    `UPDATE fine_tuning_jobs
     SET status = ?, revision = revision + 1, lease_owner = NULL,
         lease_expires_at = NULL, settled_cost_micros = ?, cost_source = ?,
         artifact_id = ?, failure_code = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND revision = ? AND status = ?`,
    [
      next.status,
      next.settledCostMicros,
      next.costSource,
      next.artifactId,
      next.failureCode,
      next.now,
      next.now,
      current.id,
      current.revision,
      current.status,
    ],
  );
  if (updated.rowsAffected !== 1) {
    conflict("The fine-tuning job changed before its terminal result committed.");
  }
}

async function releaseReservation(
  transaction: StorySqlTransaction,
  job: FineTuningJobRecord,
  settledCostMicros: number,
  now: string,
): Promise<void> {
  const updated = await transaction.execute(
    `UPDATE fine_tuning_quota_policies
     SET reserved_micros = reserved_micros - ?,
         spent_micros = spent_micros + ?,
         active_jobs = active_jobs - 1,
         revision = revision + 1,
         updated_at = ?
     WHERE project_id = ? AND month_key = ?
       AND reserved_micros >= ? AND active_jobs >= 1
       AND spent_micros + ? <= monthly_cost_limit_micros`,
    [
      job.reservedCostMicros,
      settledCostMicros,
      now,
      job.projectId,
      job.monthKey,
      job.reservedCostMicros,
      settledCostMicros,
    ],
  );
  if (updated.rowsAffected !== 1) {
    corrupt("FINE_TUNING_RESERVATION_SETTLEMENT_FAILED");
  }
}

function enforceJobQuota(
  policy: FineTuningQuotaPolicyRecord,
  dataset: FineTuningDatasetSnapshot,
  plan: FineTuningTrainingPlan,
  monthKey: string,
): void {
  if (
    policy.monthKey !== monthKey ||
    policy.currency !== plan.limits.currency ||
    dataset.totalContentBytes > policy.maximumDatasetBytes ||
    plan.limits.maximumCostMicros > policy.maximumSingleJobCostMicros ||
    policy.activeJobs >= policy.maximumConcurrentJobs ||
    policy.spentMicros + policy.reservedMicros + plan.limits.maximumCostMicros >
      policy.monthlyCostLimitMicros
  ) {
    quotaExceeded("The training plan exceeds its current dataset, concurrency, or cost quota.");
  }
}

function requireWorkerJob(
  job: FineTuningJobRecord,
  expectedRevision: number,
  workerId: string,
  states: readonly FineTuningJobState[],
): void {
  if (
    job.revision !== expectedRevision ||
    job.leaseOwner !== workerId ||
    !states.includes(job.status) ||
    job.leaseExpiresAt === null
  ) {
    conflict("The fine-tuning worker lease or job revision is no longer current.");
  }
}

async function readClaim(
  executor: StorySqlTransaction,
  operation: FineTuningOperationContext,
): Promise<ClaimRow | null> {
  const rows = await executor.select<ClaimRow>(
    `SELECT idempotency_key, operation, request_hash, project_id,
            result_entity_type, result_entity_id, result_revision, created_at
     FROM fine_tuning_operation_claims
     WHERE idempotency_key = ?`,
    [operation.idempotencyKey],
  );
  if (rows[0] === undefined) return null;
  if (rows[0].request_hash !== operation.requestHash) {
    idempotencyConflict();
  }
  return rows[0];
}

async function insertClaim(
  executor: StorySqlTransaction,
  operation: FineTuningOperationContext,
  input: {
    readonly projectId: string;
    readonly operation:
      | "dataset_create"
      | "dataset_approve"
      | "policy_configure"
      | "job_queue"
      | "job_claim"
      | "job_cancel"
      | "job_complete"
      | "job_fail"
      | "job_recover"
      | "evaluation_record"
      | "registration_approve"
      | "artifact_register"
      | "deployment_approve"
      | "deployment_activate"
      | "deployment_rollback"
      | "artifact_revoke";
    readonly entityType: "dataset" | "policy" | "job" | "artifact" | "evaluation" | "deployment";
    readonly entityId: string;
    readonly revision: number;
  },
): Promise<void> {
  await executor.execute(
    `INSERT INTO fine_tuning_operation_claims (
       idempotency_key, operation, request_hash, project_id,
       result_entity_type, result_entity_id, result_revision, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      operation.idempotencyKey,
      input.operation,
      operation.requestHash,
      input.projectId,
      input.entityType,
      input.entityId,
      input.revision,
      operation.now,
    ],
  );
}

function assertClaimResult(
  claim: ClaimRow,
  entityType: ClaimRow["result_entity_type"],
  entityId: string,
): void {
  if (claim.result_entity_type !== entityType || claim.result_entity_id !== entityId) {
    idempotencyConflict();
  }
}

async function insertAudit(
  executor: StorySqlTransaction,
  operation: FineTuningOperationContext,
  input: {
    readonly projectId: string;
    readonly entityType: "dataset" | "policy" | "job" | "artifact" | "evaluation" | "deployment";
    readonly entityId: string;
    readonly action:
      | "dataset_created"
      | "dataset_approved"
      | "policy_configured"
      | "job_queued"
      | "job_claimed"
      | "job_cancel_requested"
      | "job_cancelled"
      | "job_failed"
      | "job_recovered"
      | "artifact_created"
      | "evaluation_passed"
      | "evaluation_failed"
      | "registration_approved"
      | "artifact_registered"
      | "deployment_approved"
      | "deployment_activated"
      | "deployment_rolled_back"
      | "artifact_revoked";
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  validateAuditMetadata(input.metadata);
  await executor.execute(
    `INSERT INTO fine_tuning_audit_events (
       id, project_id, entity_type, entity_id, action, actor_id,
       request_id, correlation_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      operation.auditEventId,
      input.projectId,
      input.entityType,
      input.entityId,
      input.action,
      operation.actorId,
      operation.requestId,
      operation.correlationId,
      serializeJson(input.metadata),
      operation.now,
    ],
  );
}

function validateOperation(operation: FineTuningOperationContext): void {
  requirePortableKey(operation.idempotencyKey, "idempotencyKey");
  requireHash(operation.requestHash, "requestHash");
  requirePortableKey(operation.auditEventId, "auditEventId");
  requireLowerKey(operation.actorId, "actorId");
  requirePortableKey(operation.requestId, "requestId");
  requirePortableKey(operation.correlationId, "correlationId");
  requireTimestamp(operation.now, "now");
}

function validatePolicy(policy: FineTuningQuotaPolicy, monthKey: string): void {
  requireMonth(monthKey);
  if (
    typeof policy.allowRemoteTraining !== "boolean" ||
    !Number.isSafeInteger(policy.maximumDatasetBytes) ||
    policy.maximumDatasetBytes < 1 ||
    policy.maximumDatasetBytes > 2_000_000_000 ||
    !Number.isSafeInteger(policy.maximumConcurrentJobs) ||
    policy.maximumConcurrentJobs < 1 ||
    policy.maximumConcurrentJobs > 128 ||
    !Number.isSafeInteger(policy.maximumSingleJobCostMicros) ||
    policy.maximumSingleJobCostMicros < 0 ||
    !Number.isSafeInteger(policy.monthlyCostLimitMicros) ||
    policy.monthlyCostLimitMicros < 0 ||
    policy.maximumSingleJobCostMicros > policy.monthlyCostLimitMicros ||
    !CURRENCY_PATTERN.test(policy.currency)
  ) {
    invalid("Fine-tuning quota policy is invalid.");
  }
}

function validatePlan(plan: FineTuningTrainingPlan): void {
  if (
    !UUID_V7_PATTERN.test(plan.datasetId) ||
    !SHA256_PATTERN.test(plan.datasetManifestHash) ||
    !SHA256_PATTERN.test(plan.planHash) ||
    plan.provider.location !== "local" ||
    plan.provider.credentialProfileId !== null ||
    plan.provider.commercialAuthorizationId !== null ||
    !LOWER_KEY_PATTERN.test(plan.provider.providerId) ||
    !LOWER_KEY_PATTERN.test(plan.baseModel.providerId) ||
    !plan.baseModel.license.fineTuningAllowed ||
    !plan.baseModel.license.commercialUseAllowed
  ) {
    invalid("Only a licensed, local-only fine-tuning plan can be persisted.");
  }
}

function validateAuditMetadata(metadata: Readonly<Record<string, unknown>>): void {
  const stack: unknown[] = [metadata];
  const forbidden = new Set([
    "content",
    "sourceText",
    "prompt",
    "messages",
    "key",
    "secret",
    "credential",
    "password",
  ]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      const values: unknown[] = current;
      for (const value of values) {
        stack.push(value);
      }
    } else if (isRecord(current)) {
      for (const [key, value] of Object.entries(current)) {
        if (forbidden.has(key)) {
          invalid("Fine-tuning audit metadata cannot contain source text or secrets.");
        }
        stack.push(value);
      }
    }
  }
  if (serializeJson(metadata).length > 16_384) {
    invalid("Fine-tuning audit metadata exceeds its bounded size.");
  }
}

function parseJsonObject(value: string, field: string): Record<string, unknown> {
  const parsed = parseSnapshot(value);
  if (!isRecord(parsed)) corrupt(`${field.toUpperCase().replaceAll(" ", "_")}_INVALID`);
  return parsed;
}

function parseJsonArray(value: string, field: string): unknown[] {
  const parsed = parseSnapshot(value);
  if (!Array.isArray(parsed)) corrupt(`${field.toUpperCase().replaceAll(" ", "_")}_INVALID`);
  return parsed;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function requireUuid(value: string, field: string): string {
  if (!UUID_V7_PATTERN.test(value)) invalid(`${field} must be a UUIDv7.`);
  return value.toLowerCase();
}

function requirePortableKey(value: string, field: string): string {
  if (!SAFE_KEY_PATTERN.test(value)) invalid(`${field} is not a bounded portable key.`);
  return value;
}

function requireLowerKey(value: string, field: string): string {
  if (!LOWER_KEY_PATTERN.test(value)) invalid(`${field} is not a lowercase stable key.`);
  return value;
}

function requireHash(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) invalid(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

function requireNullableHash(value: string | null | undefined, field: string): string | null {
  return value === undefined || value === null ? null : requireHash(value, field);
}

function requireLocalRef(value: string): string {
  if (!LOCAL_REF_PATTERN.test(value)) {
    invalid("The native artifact reference must be opaque and path-free.");
  }
  return value;
}

function requireErrorCode(value: string): string {
  if (!ERROR_CODE_PATTERN.test(value)) invalid("Fine-tuning error code is invalid.");
  return value;
}

function requireText(value: string, minimum: number, maximum: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    invalid(`${field} is invalid.`);
  }
  return value.normalize("NFC");
}

function requireInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${field} is outside its integer boundary.`);
  }
  return value;
}

function requireTimestamp(value: string, field: string): string {
  if (
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u.test(
      value,
    ) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalid(`${field} must be a canonical UTC timestamp.`);
  }
  return value;
}

function requireMonth(value: string): string {
  if (!MONTH_PATTERN.test(value)) invalid("Fine-tuning quota month is invalid.");
  return value;
}

function requireRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1 || actual !== expected) {
    conflict("Fine-tuning entity revision changed before the operation committed.");
  }
}

function requireSettlement(settled: number, reserved: number): void {
  if (!Number.isSafeInteger(settled) || settled < 0 || settled > reserved) {
    invalid("Fine-tuning settlement must be a bounded value within its reservation.");
  }
}

function requireDeploymentTargetRole(value: string): void {
  if (!["local_private", "fast", "high_quality", "validation"].includes(value)) {
    invalid("Fine-tuning deployment target role is invalid.");
  }
}

function booleanInteger(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) corrupt(`FINE_TUNING_${field.toUpperCase()}_INVALID`);
  return value === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function invalid(message: string): never {
  abortPersistence(
    new StoryCoreError({
      code: "FINE_TUNING_VALIDATION_FAILED",
      message,
      actions: ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function conflict(message: string): never {
  abortPersistence(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message,
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
    }),
  );
}

function quotaExceeded(message: string): never {
  abortPersistence(
    new StoryCoreError({
      code: "FINE_TUNING_QUOTA_EXCEEDED",
      message,
      actions: ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function humanApprovalRequired(): never {
  abortPersistence(
    new StoryCoreError({
      code: "FINE_TUNING_HUMAN_APPROVAL_REQUIRED",
      message: "This fine-tuning model action requires an explicit human approval.",
      actions: ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function remoteForbidden(): never {
  abortPersistence(
    new StoryCoreError({
      code: "FINE_TUNING_REMOTE_SUBMISSION_FORBIDDEN",
      message: "This desktop governance slice never persists or submits a remote fine-tuning plan.",
      actions: ["CONFIGURE_LOCAL_TRAINER"],
    }),
  );
}

function idempotencyConflict(): never {
  abortPersistence(
    new StoryCoreError({
      code: "FINE_TUNING_IDEMPOTENCY_CONFLICT",
      message: "A fine-tuning idempotency key was reused for another authority payload.",
      actions: ["CONTACT_SUPPORT"],
    }),
  );
}

function notFound(message: string): never {
  abortPersistence(
    new StoryCoreError({
      code: "FINE_TUNING_NOT_FOUND",
      message,
    }),
  );
}

function corrupt(code: string): never {
  abortCorruptSnapshot(code);
}
