import type { ContentHasher } from "@inkshadow/application";
import { FineTuningGovernanceSqliteStore, type SqlExecutor } from "@inkshadow/data";
import {
  StoryCoreError,
  FineTuningGovernanceSqliteRepository,
  approveFineTuningDataset,
  computeFineTuningEvaluationAuthorityHash,
  computeFineTuningGovernanceHash,
  createFineTuningDataset,
  createFineTuningTrainingPlan,
  err,
  evaluateFineTuningCandidate,
  ok,
  runFineTuningTrainingPreflight,
  type Clock,
  type FineTuningDatasetSnapshot,
  type FineTuningDeploymentRecord,
  type FineTuningDeploymentTargetRole,
  type FineTuningEvaluationGateInput,
  type FineTuningJobRecord,
  type FineTuningModelArtifactRecord,
  type FineTuningOperationContext,
  type FineTuningQuotaPolicy,
  type FineTuningQuotaPolicyRecord,
  type FineTuningRightsKind,
  type FineTuningSourceKind,
  type FineTuningTrainingPlan,
  type Result,
  type UuidV7Generator,
} from "@inkshadow/story-core";

export type FineTuningPersistenceKind = "native_sqlite" | "browser_development";

export type FineTuningAvailability =
  | Readonly<{
      available: true;
      persistence: "native_sqlite";
      localTrainer:
        | Readonly<{ available: true; providerId: string }>
        | Readonly<{
            available: false;
            reason: "local_trainer_not_configured";
          }>;
    }>
  | Readonly<{
      available: false;
      reason: "feature_disabled" | "native_sqlite_required";
      persistence: FineTuningPersistenceKind;
      localTrainer: Readonly<{
        available: false;
        reason: "feature_unavailable";
      }>;
    }>;

export interface FineTuningRightsSummary {
  readonly kind: FineTuningRightsKind;
  readonly basis: string;
  readonly confirmedAt: string | null;
  readonly allowTraining: boolean;
}

export interface FineTuningSourceDescriptor {
  readonly id: string;
  readonly kind: FineTuningSourceKind;
  readonly revision: number;
  readonly label: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly rights: FineTuningRightsSummary | null;
  readonly rightsDeclarationRequired: boolean;
  readonly status: "eligible" | "governance_blocked";
  readonly blocker: string | null;
}

export interface FineTuningAuditSummary {
  readonly id: string;
  readonly entityType: "dataset" | "policy" | "job" | "artifact" | "evaluation" | "deployment";
  readonly entityId: string;
  readonly action: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly createdAt: string;
}

export interface FineTuningDashboard {
  readonly projectId: string;
  readonly sources: readonly FineTuningSourceDescriptor[];
  readonly datasets: readonly FineTuningDatasetSnapshot[];
  readonly policy: FineTuningQuotaPolicyRecord | null;
  readonly jobs: readonly FineTuningJobRecord[];
  readonly recoverableJobs: readonly FineTuningJobRecord[];
  readonly artifacts: readonly FineTuningModelArtifactRecord[];
  readonly deployments: readonly FineTuningDeploymentRecord[];
  readonly audit: readonly FineTuningAuditSummary[];
}

export interface FineTuningSourceSelection {
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly expectedContentHash: string;
  /**
   * Required only for chapter/import sources. Material rights always come from
   * the authoritative material record and cannot be overridden by the UI.
   */
  readonly rights?: Readonly<{
    readonly kind: FineTuningRightsKind;
    readonly basis: string;
    readonly allowTraining: boolean;
    readonly humanConfirmed: boolean;
  }>;
}

export interface FineTuningLocalTrainingReceipt {
  readonly artifactDigest: string;
  /** Opaque registry token, never a filesystem path. */
  readonly localArtifactRef: string;
  readonly settledCostMicros: number;
  readonly costSource: "local_resource_estimate" | "provider_reported";
  readonly providerReceiptDigest: string;
}

export interface FineTuningProviderReceipt {
  readonly providerReceiptDigest: string;
}

export interface FineTuningLocalTrainer {
  /** Stable lowercase provider key. */
  readonly providerId: string;

  preflight(
    input: Readonly<{
      plan: FineTuningTrainingPlan;
      dataset: FineTuningDatasetSnapshot;
    }>,
  ): Promise<Result<Readonly<{ available: true }>, StoryCoreError>>;

  /**
   * Must be local and idempotent by job.id. Implementations must not upload
   * source text and must return the same receipt after an uncertain retry.
   */
  train(
    input: Readonly<{
      job: FineTuningJobRecord;
      dataset: FineTuningDatasetSnapshot;
      signal: AbortSignal;
    }>,
  ): Promise<Result<FineTuningLocalTrainingReceipt, StoryCoreError>>;

  register(
    input: Readonly<{
      artifact: FineTuningModelArtifactRecord;
      registrationName: string;
    }>,
  ): Promise<Result<FineTuningProviderReceipt, StoryCoreError>>;

  deploy(
    input: Readonly<{
      deploymentId: string;
      artifact: FineTuningModelArtifactRecord;
      targetRole: FineTuningDeploymentTargetRole;
    }>,
  ): Promise<Result<FineTuningProviderReceipt, StoryCoreError>>;

  rollback(
    input: Readonly<{
      deployment: FineTuningDeploymentRecord;
      artifact: FineTuningModelArtifactRecord;
    }>,
  ): Promise<Result<FineTuningProviderReceipt, StoryCoreError>>;

  revoke(
    input: Readonly<{
      artifact: FineTuningModelArtifactRecord;
    }>,
  ): Promise<Result<FineTuningProviderReceipt, StoryCoreError>>;
}

export interface FineTuningDesktopPort {
  readonly availability: FineTuningAvailability;

  inspect(projectId: string): Promise<Result<FineTuningDashboard, StoryCoreError>>;

  createDataset(
    input: Readonly<{
      projectId: string;
      actorId: string;
      name: string;
      sources: readonly FineTuningSourceSelection[];
      splitPolicy?: Readonly<{
        seed: string;
        trainParts: number;
        validationParts: number;
        testParts: number;
      }>;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>>;

  approveDataset(
    input: Readonly<{
      datasetId: string;
      actorId: string;
      expectedRevision: number;
      expectedManifestHash: string;
      privacyReviewed: boolean;
      copyrightReviewed: boolean;
      trainingPurposeConfirmed: boolean;
      humanConfirmed: boolean;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>>;

  configurePolicy(
    input: Readonly<{
      projectId: string;
      actorId: string;
      policy: FineTuningQuotaPolicy;
      monthKey: string;
      expectedRevision?: number | null;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningQuotaPolicyRecord, StoryCoreError>>;

  queueTraining(
    input: Readonly<{
      projectId: string;
      datasetId: string;
      actorId: string;
      requestKey?: string;
      maximumAttempts: number;
      baseModel: Readonly<{
        providerId: string;
        modelId: string;
        revision: string;
        licenseId: string;
        licenseVersion: string;
        fineTuningAllowed: boolean;
        commercialUseAllowed: boolean;
        redistributionAllowed: boolean;
        humanConfirmed: boolean;
      }>;
      method: "lora" | "qlora";
      hyperparameters: FineTuningTrainingPlan["hyperparameters"];
      limits: FineTuningTrainingPlan["limits"];
    }>,
  ): Promise<Result<FineTuningJobRecord, StoryCoreError>>;

  runNextLocalJob(
    projectId: string,
    actorId: string,
  ): Promise<
    Result<
      Readonly<{
        job: FineTuningJobRecord;
        artifact: FineTuningModelArtifactRecord;
      }> | null,
      StoryCoreError
    >
  >;

  cancelJob(
    input: Readonly<{
      jobId: string;
      actorId: string;
      expectedRevision: number;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningJobRecord, StoryCoreError>>;

  retryJob(
    input: Readonly<{
      jobId: string;
      actorId: string;
      expectedRevision: number;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningJobRecord, StoryCoreError>>;

  recoverExpiredJobs(
    projectId: string,
    actorId: string,
  ): Promise<Result<readonly FineTuningJobRecord[], StoryCoreError>>;

  recordEvaluation(
    input: Readonly<{
      projectId: string;
      artifactId: string;
      actorId: string;
      expectedArtifactRevision: number;
      evaluatorId: string;
      evaluatorVersion: string;
      gate: FineTuningEvaluationGateInput;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>>;

  approveRegistration(
    input: Readonly<{
      artifactId: string;
      actorId: string;
      expectedRevision: number;
      humanConfirmed: boolean;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>>;

  registerArtifact(
    input: Readonly<{
      artifactId: string;
      actorId: string;
      expectedRevision: number;
      registrationName: string;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>>;

  approveDeployment(
    input: Readonly<{
      artifactId: string;
      actorId: string;
      expectedRevision: number;
      targetRole: FineTuningDeploymentTargetRole;
      humanConfirmed: boolean;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>>;

  activateDeployment(
    input: Readonly<{
      artifactId: string;
      actorId: string;
      expectedRevision: number;
      targetRole: FineTuningDeploymentTargetRole;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningDeploymentRecord, StoryCoreError>>;

  rollbackDeployment(
    input: Readonly<{
      deploymentId: string;
      actorId: string;
      humanConfirmed: boolean;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningDeploymentRecord, StoryCoreError>>;

  revokeArtifact(
    input: Readonly<{
      artifactId: string;
      actorId: string;
      expectedRevision: number;
      humanConfirmed: boolean;
      requestKey?: string;
    }>,
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>>;
}

export interface CreateFineTuningDesktopRuntimeOptions {
  /** Safe default: governance and every mutation stay unavailable. */
  readonly featureEnabled?: boolean;
  readonly persistence: FineTuningPersistenceKind;
  readonly executor: SqlExecutor;
  readonly hasher: ContentHasher;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
  readonly trainer?: FineTuningLocalTrainer;
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
}

interface ChapterSourceRow {
  readonly id: string;
  readonly project_id: string;
  readonly sequence: number;
  readonly content: string;
  readonly content_checksum: string;
  readonly reason: string;
  readonly title: string;
}

interface MaterialSourceRow {
  readonly id: string;
  readonly project_id: string;
  readonly revision: number;
  readonly status: string;
  readonly snapshot_json: string;
}

interface AuditRow {
  readonly id: string;
  readonly entity_type: FineTuningAuditSummary["entityType"];
  readonly entity_id: string;
  readonly action: string;
  readonly actor_id: string;
  readonly request_id: string;
  readonly created_at: string;
}

interface ApprovalLookupRow {
  readonly id: string;
}

interface OperationClaimRow {
  readonly operation: string;
  readonly request_hash: string;
  readonly result_entity_type:
    "dataset" | "policy" | "job" | "artifact" | "evaluation" | "deployment";
  readonly result_entity_id: string;
}

interface ResolvedFineTuningSource {
  readonly descriptor: FineTuningSourceDescriptor;
  readonly content: string;
}

const DEFAULT_SPLIT_POLICY = Object.freeze({
  seed: "fine_tuning_split_v1",
  trainParts: 8,
  validationParts: 1,
  testParts: 1,
});
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1_000;

export function createFineTuningDesktopRuntime(
  options: CreateFineTuningDesktopRuntimeOptions,
): FineTuningDesktopPort {
  const featureEnabled = options.featureEnabled ?? false;
  if (!featureEnabled) {
    return new UnavailableFineTuningDesktopRuntime({
      available: false,
      reason: "feature_disabled",
      persistence: options.persistence,
      localTrainer: {
        available: false,
        reason: "feature_unavailable",
      },
    });
  }
  if (options.persistence !== "native_sqlite") {
    return new UnavailableFineTuningDesktopRuntime({
      available: false,
      reason: "native_sqlite_required",
      persistence: options.persistence,
      localTrainer: {
        available: false,
        reason: "feature_unavailable",
      },
    });
  }
  return new SqliteFineTuningDesktopRuntime(options);
}

class SqliteFineTuningDesktopRuntime implements FineTuningDesktopPort {
  public readonly availability: FineTuningAvailability;
  private readonly store: FineTuningGovernanceSqliteRepository;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly leaseDurationMs: number;

  public constructor(private readonly options: CreateFineTuningDesktopRuntimeOptions) {
    this.store = new FineTuningGovernanceSqliteRepository(
      new FineTuningGovernanceSqliteStore(options.executor),
    );
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.availability = Object.freeze({
      available: true,
      persistence: "native_sqlite",
      localTrainer:
        options.trainer === undefined
          ? Object.freeze({
              available: false as const,
              reason: "local_trainer_not_configured" as const,
            })
          : Object.freeze({
              available: true as const,
              providerId: options.trainer.providerId,
            }),
    });
  }

  public async inspect(projectId: string): Promise<Result<FineTuningDashboard, StoryCoreError>> {
    try {
      const sources = await this.resolveProjectSources(projectId);
      if (!sources.ok) return sources;
      const datasets = await this.store.listDatasets(projectId);
      if (!datasets.ok) return datasets;
      const policy = await this.store.findPolicy(projectId);
      if (!policy.ok) return policy;
      const jobs = await this.store.listJobs(projectId);
      if (!jobs.ok) return jobs;
      const recoverable = await this.store.listRecoverableJobs(projectId, this.options.clock.now());
      if (!recoverable.ok) return recoverable;
      const artifacts = await this.store.listArtifacts(projectId);
      if (!artifacts.ok) return artifacts;
      const deployments = await this.store.listDeployments(projectId);
      if (!deployments.ok) return deployments;
      const audit = await this.readAudit(projectId);
      return ok(
        Object.freeze({
          projectId,
          sources: Object.freeze(sources.value.map(({ descriptor }) => descriptor)),
          datasets: datasets.value,
          policy: policy.value,
          jobs: jobs.value,
          recoverableJobs: recoverable.value,
          artifacts: artifacts.value,
          deployments: deployments.value,
          audit,
        }),
      );
    } catch (cause: unknown) {
      return repositoryError(cause);
    }
  }

  public async createDataset(
    input: Parameters<FineTuningDesktopPort["createDataset"]>[0],
  ): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>> {
    const operationAuthority = {
      projectId: input.projectId,
      actorId: input.actorId,
      name: input.name,
      sources: input.sources,
      splitPolicy: input.splitPolicy ?? DEFAULT_SPLIT_POLICY,
    };
    const replay = await this.replayClaim(
      input.requestKey,
      "dataset_create",
      operationAuthority,
      "dataset",
    );
    if (!replay.ok) return replay;
    if (replay.value !== null) {
      const dataset = await this.store.findDataset(replay.value.result_entity_id);
      return dataset.ok && dataset.value !== null
        ? ok(dataset.value)
        : dataset.ok
          ? notFoundError("幂等数据集回执指向不存在的记录。")
          : dataset;
    }
    const allSources = await this.resolveProjectSources(input.projectId);
    if (!allSources.ok) return allSources;
    if (input.sources.length === 0 || input.sources.length > 20_000) {
      return validationError("请选择至少一条且不超过 20,000 条本地训练来源。");
    }
    const byId = new Map(allSources.value.map((source) => [source.descriptor.id, source]));
    const drafts = [];
    for (const selection of input.sources) {
      const source = byId.get(selection.sourceId);
      if (source === undefined) {
        return sourceChangedError("所选训练来源已不存在或不属于当前项目。");
      }
      if (
        source.descriptor.revision !== selection.expectedRevision ||
        source.descriptor.contentHash !== selection.expectedContentHash
      ) {
        return sourceChangedError("训练来源在预览后发生变化，请重新比较。");
      }
      let rights = source.descriptor.rights;
      if (rights === null) {
        if (selection.rights?.humanConfirmed !== true) {
          return humanApprovalError("章节或导入来源需要明确的版权与训练用途声明。");
        }
        rights = {
          kind: selection.rights.kind,
          basis: selection.rights.basis,
          allowTraining: selection.rights.allowTraining,
          confirmedAt: this.options.clock.now(),
        };
      }
      drafts.push({
        id: this.options.ids.next(),
        source: {
          kind: source.descriptor.kind,
          projectId: input.projectId,
          entityId: source.descriptor.id,
          entityRevision: source.descriptor.revision,
          label: source.descriptor.label,
        },
        content: source.content,
        expectedContentHash: source.descriptor.contentHash,
        rights,
      });
    }
    const created = await createFineTuningDataset({
      id: this.options.ids.next(),
      projectId: input.projectId,
      name: input.name,
      samples: drafts,
      splitPolicy: input.splitPolicy ?? DEFAULT_SPLIT_POLICY,
      createdBy: input.actorId,
      now: this.options.clock.now(),
    });
    if (!created.ok) return created;
    const operation = await this.operation(
      "dataset_create",
      input.actorId,
      operationAuthority,
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.createDataset(created.value, operation.value);
  }

  public async approveDataset(
    input: Parameters<FineTuningDesktopPort["approveDataset"]>[0],
  ): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>> {
    const operationAuthority = {
      datasetId: input.datasetId,
      actorId: input.actorId,
      expectedRevision: input.expectedRevision,
      expectedManifestHash: input.expectedManifestHash,
      privacyReviewed: input.privacyReviewed,
      copyrightReviewed: input.copyrightReviewed,
      trainingPurposeConfirmed: input.trainingPurposeConfirmed,
      humanConfirmed: input.humanConfirmed,
    };
    const replay = await this.replayClaim(
      input.requestKey,
      "dataset_approve",
      operationAuthority,
      "dataset",
    );
    if (!replay.ok) return replay;
    if (replay.value !== null) {
      const dataset = await this.store.findDataset(replay.value.result_entity_id);
      return dataset.ok && dataset.value !== null
        ? ok(dataset.value)
        : dataset.ok
          ? notFoundError("幂等审批回执指向不存在的数据集。")
          : dataset;
    }
    const current = await this.store.findDataset(input.datasetId);
    if (!current.ok) return current;
    if (current.value === null) return notFoundError("微调数据集不存在。");
    const now = this.options.clock.now();
    const decision = approveFineTuningDataset(current.value, {
      approvalId: this.options.ids.next(),
      actorId: input.actorId,
      expectedRevision: input.expectedRevision,
      expectedManifestHash: input.expectedManifestHash,
      privacyReviewed: input.privacyReviewed,
      copyrightReviewed: input.copyrightReviewed,
      trainingPurposeConfirmed: input.trainingPurposeConfirmed,
      humanConfirmed: input.humanConfirmed,
      now,
    });
    if (!decision.ok) return decision;
    const operation = await this.operation(
      "dataset_approve",
      input.actorId,
      operationAuthority,
      input.requestKey,
      now,
    );
    if (!operation.ok) return operation;
    return this.store.approveDataset(
      decision.value.dataset,
      decision.value.approval,
      operation.value,
    );
  }

  public async configurePolicy(
    input: Parameters<FineTuningDesktopPort["configurePolicy"]>[0],
  ): Promise<Result<FineTuningQuotaPolicyRecord, StoryCoreError>> {
    if (input.policy.allowRemoteTraining) {
      return remoteForbiddenError();
    }
    const operationAuthority = {
      projectId: input.projectId,
      actorId: input.actorId,
      policy: input.policy,
      monthKey: input.monthKey,
      expectedRevision: input.expectedRevision ?? null,
    };
    const replay = await this.replayClaim(
      input.requestKey,
      "policy_configure",
      operationAuthority,
      "policy",
    );
    if (!replay.ok) return replay;
    if (replay.value !== null) {
      const policy = await this.store.findPolicy(input.projectId);
      return policy.ok && policy.value !== null
        ? ok(policy.value)
        : policy.ok
          ? notFoundError("幂等策略回执指向不存在的记录。")
          : policy;
    }
    const operation = await this.operation(
      "policy_configure",
      input.actorId,
      operationAuthority,
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.configurePolicy({
      projectId: input.projectId,
      policy: input.policy,
      monthKey: input.monthKey,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      operation: operation.value,
    });
  }

  public async queueTraining(
    input: Parameters<FineTuningDesktopPort["queueTraining"]>[0],
  ): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    const operationAuthority = {
      projectId: input.projectId,
      datasetId: input.datasetId,
      actorId: input.actorId,
      maximumAttempts: input.maximumAttempts,
      baseModel: input.baseModel,
      method: input.method,
      hyperparameters: input.hyperparameters,
      limits: input.limits,
    };
    const replay = await this.replayClaim(input.requestKey, "job_queue", operationAuthority, "job");
    if (!replay.ok) return replay;
    if (replay.value !== null) {
      const job = await this.store.findJob(replay.value.result_entity_id);
      return job.ok && job.value !== null
        ? ok(job.value)
        : job.ok
          ? notFoundError("幂等训练回执指向不存在的作业。")
          : job;
    }
    const trainer = this.options.trainer;
    if (trainer === undefined) return providerUnavailableError();
    if (!input.baseModel.humanConfirmed) {
      return humanApprovalError("必须人工确认基础模型许可证允许微调与商业使用。");
    }
    const dataset = await this.store.findDataset(input.datasetId);
    if (!dataset.ok) return dataset;
    if (dataset.value === null) return notFoundError("微调数据集不存在。");
    const policy = await this.store.findPolicy(input.projectId);
    if (!policy.ok) return policy;
    if (policy.value === null) {
      return quotaError("开始训练前必须配置本地费用与并发硬上限。");
    }
    const plan = await createFineTuningTrainingPlan({
      dataset: dataset.value,
      baseModel: {
        providerId: input.baseModel.providerId,
        modelId: input.baseModel.modelId,
        revision: input.baseModel.revision,
        license: {
          licenseId: input.baseModel.licenseId,
          licenseVersion: input.baseModel.licenseVersion,
          fineTuningAllowed: input.baseModel.fineTuningAllowed,
          commercialUseAllowed: input.baseModel.commercialUseAllowed,
          redistributionAllowed: input.baseModel.redistributionAllowed,
          confirmedAt: this.options.clock.now(),
        },
      },
      provider: {
        location: "local",
        providerId: trainer.providerId,
        credentialProfileId: null,
        commercialAuthorizationId: null,
      },
      method: input.method,
      hyperparameters: input.hyperparameters,
      limits: input.limits,
    });
    if (!plan.ok) return plan;
    const providerCheck = await trainer.preflight({
      plan: plan.value,
      dataset: dataset.value,
    });
    const preflight = runFineTuningTrainingPreflight({
      featureEnabled: true,
      providerAvailable: providerCheck.ok,
      remoteTrainingAuthorized: false,
      dataset: dataset.value,
      plan: plan.value,
      policy: policy.value,
      usage: policy.value,
    });
    if (!providerCheck.ok) return providerCheck;
    if (!preflight.ready) {
      return preflightError(preflight.checks);
    }
    const approvalId = await this.findDatasetApprovalId(dataset.value);
    if (!approvalId.ok) return approvalId;
    const jobId = this.options.ids.next();
    const operation = await this.operation(
      "job_queue",
      input.actorId,
      operationAuthority,
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.queueJob({
      id: jobId,
      projectId: input.projectId,
      datasetApprovalId: approvalId.value,
      plan: plan.value,
      maximumAttempts: input.maximumAttempts,
      createdBy: input.actorId,
      monthKey: policy.value.monthKey,
      operation: operation.value,
    });
  }

  public async runNextLocalJob(
    projectId: string,
    actorId: string,
  ): Promise<
    Result<
      Readonly<{
        job: FineTuningJobRecord;
        artifact: FineTuningModelArtifactRecord;
      }> | null,
      StoryCoreError
    >
  > {
    const trainer = this.options.trainer;
    if (trainer === undefined) return providerUnavailableError();
    const now = this.options.clock.now();
    const leaseExpiresAt = new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
    const claimOperation = await this.operation("job_claim", actorId, {
      projectId,
      leaseExpiresAt,
    });
    if (!claimOperation.ok) return claimOperation;
    const claimed = await this.store.claimNextJob({
      projectId,
      workerId: this.options.workerId ?? "fine_tuning.desktop",
      leaseExpiresAt,
      operation: claimOperation.value,
    });
    if (!claimed.ok) return claimed;
    if (claimed.value === null) return ok(null);
    const job = claimed.value;
    const dataset = await this.store.findDataset(job.datasetId);
    if (!dataset.ok) return dataset;
    if (dataset.value === null) return notFoundError("训练作业绑定的数据集不存在。");
    const controller = new AbortController();
    this.activeControllers.set(job.id, controller);
    try {
      const receipt = await trainer.train({
        job,
        dataset: dataset.value,
        signal: controller.signal,
      });
      if (!receipt.ok) {
        return await this.persistTrainingFailure(job, receipt.error, actorId);
      }
      const artifactId = this.options.ids.next();
      const operation = await this.operation("job_complete", actorId, {
        jobId: job.id,
        artifactId,
        artifactDigest: receipt.value.artifactDigest,
        providerReceiptDigest: receipt.value.providerReceiptDigest,
      });
      if (!operation.ok) return operation;
      return await this.store.completeJob({
        jobId: job.id,
        workerId: this.options.workerId ?? "fine_tuning.desktop",
        expectedRevision: job.revision,
        artifactId,
        artifactDigest: receipt.value.artifactDigest,
        localArtifactRef: receipt.value.localArtifactRef,
        settledCostMicros: receipt.value.settledCostMicros,
        costSource: receipt.value.costSource,
        providerReceiptDigest: receipt.value.providerReceiptDigest,
        operation: operation.value,
      });
    } catch (cause: unknown) {
      return await this.persistTrainingFailure(
        job,
        new StoryCoreError({
          code: "FINE_TUNING_PROVIDER_UNAVAILABLE",
          message: "本地训练器异常退出；作业已进入可恢复失败状态。",
          retryable: true,
          actions: ["RETRY", "CONFIGURE_LOCAL_TRAINER"],
          details: {
            causeName: cause instanceof Error ? cause.name : "UnknownError",
          },
        }),
        actorId,
      );
    } finally {
      this.activeControllers.delete(job.id);
    }
  }

  public async cancelJob(
    input: Parameters<FineTuningDesktopPort["cancelJob"]>[0],
  ): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    const operation = await this.operation(
      "job_cancel",
      input.actorId,
      {
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
      },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    const cancelled = await this.store.requestCancellation({
      jobId: input.jobId,
      expectedRevision: input.expectedRevision,
      operation: operation.value,
    });
    if (cancelled.ok) {
      this.activeControllers.get(input.jobId)?.abort();
    }
    return cancelled;
  }

  public async retryJob(
    input: Parameters<FineTuningDesktopPort["retryJob"]>[0],
  ): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    const operation = await this.operation(
      "job_recover",
      input.actorId,
      {
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        kind: "explicit_retry",
      },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.retryFailedJob({
      jobId: input.jobId,
      expectedRevision: input.expectedRevision,
      operation: operation.value,
    });
  }

  public async recoverExpiredJobs(
    projectId: string,
    actorId: string,
  ): Promise<Result<readonly FineTuningJobRecord[], StoryCoreError>> {
    const recoverable = await this.store.listRecoverableJobs(
      projectId,
      this.options.clock.now(),
      500,
    );
    if (!recoverable.ok) return recoverable;
    const recovered: FineTuningJobRecord[] = [];
    for (const job of recoverable.value) {
      if (job.status !== "running" && job.status !== "cancelling") {
        continue;
      }
      const operation = await this.operation("job_recover", actorId, {
        jobId: job.id,
        expectedRevision: job.revision,
        kind: "expired_lease",
      });
      if (!operation.ok) return operation;
      const result = await this.store.recoverExpiredJob({
        jobId: job.id,
        expectedRevision: job.revision,
        operation: operation.value,
      });
      if (!result.ok) return result;
      recovered.push(result.value);
    }
    return ok(Object.freeze(recovered));
  }

  public async recordEvaluation(
    input: Parameters<FineTuningDesktopPort["recordEvaluation"]>[0],
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    const operationAuthority = {
      projectId: input.projectId,
      artifactId: input.artifactId,
      actorId: input.actorId,
      expectedArtifactRevision: input.expectedArtifactRevision,
      evaluatorId: input.evaluatorId,
      evaluatorVersion: input.evaluatorVersion,
      gate: input.gate,
    };
    const replay = await this.replayClaim(
      input.requestKey,
      "evaluation_record",
      operationAuthority,
      "evaluation",
    );
    if (!replay.ok) return replay;
    if (replay.value !== null) {
      const artifact = await this.store.findArtifact(input.artifactId);
      return artifact.ok && artifact.value !== null
        ? ok(artifact.value)
        : artifact.ok
          ? notFoundError("幂等评测回执绑定的模型产物不存在。")
          : artifact;
    }
    if (input.gate.candidateArtifactId !== input.artifactId) {
      return validationError("评测候选与所选模型产物不一致。");
    }
    const gate = evaluateFineTuningCandidate(input.gate);
    if (!gate.ok) return gate;
    const authorityHash = await computeFineTuningEvaluationAuthorityHash(input.gate, gate.value);
    const operation = await this.operation(
      "evaluation_record",
      input.actorId,
      operationAuthority,
      input.requestKey,
    );
    if (!operation.ok) return operation;
    const result = await this.store.recordEvaluation({
      id: this.options.ids.next(),
      projectId: input.projectId,
      artifactId: input.artifactId,
      evaluatorId: input.evaluatorId,
      evaluatorVersion: input.evaluatorVersion,
      authorityHash,
      gateInput: input.gate,
      gateResult: gate.value,
      createdBy: input.actorId,
      expectedArtifactRevision: input.expectedArtifactRevision,
      operation: operation.value,
    });
    return result.ok ? ok(result.value.artifact) : result;
  }

  public async approveRegistration(
    input: Parameters<FineTuningDesktopPort["approveRegistration"]>[0],
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    const authorityHash = await computeFineTuningGovernanceHash({
      action: "model_registration",
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
    });
    const operation = await this.operation(
      "registration_approve",
      input.actorId,
      { authorityHash },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.approveRegistration({
      approvalId: this.options.ids.next(),
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      authorityHash,
      humanConfirmed: input.humanConfirmed,
      operation: operation.value,
    });
  }

  public async registerArtifact(
    input: Parameters<FineTuningDesktopPort["registerArtifact"]>[0],
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    const trainer = this.options.trainer;
    if (trainer === undefined) return providerUnavailableError();
    const artifact = await this.store.findArtifact(input.artifactId);
    if (!artifact.ok) return artifact;
    if (artifact.value === null) return notFoundError("微调模型产物不存在。");
    if (artifact.value.revision !== input.expectedRevision) {
      return revisionConflictError();
    }
    const approval = await this.findArtifactApprovalId(artifact.value, "model_registration");
    if (!approval.ok) return approval;
    const receipt = await trainer.register({
      artifact: artifact.value,
      registrationName: input.registrationName,
    });
    if (!receipt.ok) return receipt;
    const operation = await this.operation(
      "artifact_register",
      input.actorId,
      {
        artifactId: input.artifactId,
        registrationName: input.registrationName,
        providerReceiptDigest: receipt.value.providerReceiptDigest,
      },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.registerArtifact({
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      registrationApprovalId: approval.value,
      registrationName: input.registrationName,
      providerReceiptDigest: receipt.value.providerReceiptDigest,
      operation: operation.value,
    });
  }

  public async approveDeployment(
    input: Parameters<FineTuningDesktopPort["approveDeployment"]>[0],
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    const authorityHash = await computeFineTuningGovernanceHash({
      action: "model_deployment",
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      targetRole: input.targetRole,
    });
    const operation = await this.operation(
      "deployment_approve",
      input.actorId,
      {
        authorityHash,
        targetRole: input.targetRole,
      },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.approveDeployment({
      approvalId: this.options.ids.next(),
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      targetRole: input.targetRole,
      authorityHash,
      humanConfirmed: input.humanConfirmed,
      operation: operation.value,
    });
  }

  public async activateDeployment(
    input: Parameters<FineTuningDesktopPort["activateDeployment"]>[0],
  ): Promise<Result<FineTuningDeploymentRecord, StoryCoreError>> {
    const trainer = this.options.trainer;
    if (trainer === undefined) return providerUnavailableError();
    const artifact = await this.store.findArtifact(input.artifactId);
    if (!artifact.ok) return artifact;
    if (artifact.value === null) return notFoundError("微调模型产物不存在。");
    if (artifact.value.revision !== input.expectedRevision) {
      return revisionConflictError();
    }
    const approval = await this.findArtifactApprovalId(
      artifact.value,
      "model_deployment",
      input.targetRole,
    );
    if (!approval.ok) return approval;
    const deploymentId = this.options.ids.next();
    const receipt = await trainer.deploy({
      deploymentId,
      artifact: artifact.value,
      targetRole: input.targetRole,
    });
    if (!receipt.ok) return receipt;
    const operation = await this.operation(
      "deployment_activate",
      input.actorId,
      {
        deploymentId,
        artifactId: input.artifactId,
        targetRole: input.targetRole,
        providerReceiptDigest: receipt.value.providerReceiptDigest,
      },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    const result = await this.store.activateDeployment({
      deploymentId,
      artifactId: input.artifactId,
      expectedArtifactRevision: input.expectedRevision,
      deploymentApprovalId: approval.value,
      targetRole: input.targetRole,
      providerReceiptDigest: receipt.value.providerReceiptDigest,
      operation: operation.value,
    });
    return result.ok ? ok(result.value.deployment) : result;
  }

  public async rollbackDeployment(
    input: Parameters<FineTuningDesktopPort["rollbackDeployment"]>[0],
  ): Promise<Result<FineTuningDeploymentRecord, StoryCoreError>> {
    const trainer = this.options.trainer;
    if (trainer === undefined) return providerUnavailableError();
    if (!input.humanConfirmed) return humanApprovalError("回滚模型部署需要人工确认。");
    const dashboard = await this.findDeployment(input.deploymentId);
    if (!dashboard.ok) return dashboard;
    const artifact = await this.store.findArtifact(dashboard.value.artifactId);
    if (!artifact.ok) return artifact;
    if (artifact.value === null) return notFoundError("部署绑定的模型产物不存在。");
    const receipt = await trainer.rollback({
      deployment: dashboard.value,
      artifact: artifact.value,
    });
    if (!receipt.ok) return receipt;
    const authorityHash = await computeFineTuningGovernanceHash({
      action: "model_rollback",
      deploymentId: input.deploymentId,
      targetRole: dashboard.value.targetRole,
      artifactId: artifact.value.id,
    });
    const operation = await this.operation(
      "deployment_rollback",
      input.actorId,
      {
        authorityHash,
        providerReceiptDigest: receipt.value.providerReceiptDigest,
      },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    const result = await this.store.rollbackDeployment({
      deploymentId: input.deploymentId,
      rollbackApprovalId: this.options.ids.next(),
      authorityHash,
      humanConfirmed: true,
      providerReceiptDigest: receipt.value.providerReceiptDigest,
      operation: operation.value,
    });
    return result.ok ? ok(result.value.deployment) : result;
  }

  public async revokeArtifact(
    input: Parameters<FineTuningDesktopPort["revokeArtifact"]>[0],
  ): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    const trainer = this.options.trainer;
    if (trainer === undefined) return providerUnavailableError();
    if (!input.humanConfirmed) return humanApprovalError("撤销模型需要人工确认。");
    const artifact = await this.store.findArtifact(input.artifactId);
    if (!artifact.ok) return artifact;
    if (artifact.value === null) return notFoundError("微调模型产物不存在。");
    if (artifact.value.revision !== input.expectedRevision) {
      return revisionConflictError();
    }
    const receipt = await trainer.revoke({ artifact: artifact.value });
    if (!receipt.ok) return receipt;
    const authorityHash = await computeFineTuningGovernanceHash({
      action: "model_revocation",
      artifactId: artifact.value.id,
      revision: artifact.value.revision,
      providerReceiptDigest: receipt.value.providerReceiptDigest,
    });
    const operation = await this.operation(
      "artifact_revoke",
      input.actorId,
      { authorityHash },
      input.requestKey,
    );
    if (!operation.ok) return operation;
    return this.store.revokeArtifact({
      approvalId: this.options.ids.next(),
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      authorityHash,
      humanConfirmed: true,
      operation: operation.value,
    });
  }

  private async persistTrainingFailure(
    job: FineTuningJobRecord,
    failure: StoryCoreError,
    actorId: string,
  ): Promise<Result<never, StoryCoreError>> {
    const operation = await this.operation("job_fail", actorId, {
      jobId: job.id,
      errorCode: failure.code,
      retryable: failure.retryable,
    });
    if (!operation.ok) return operation;
    const persisted = await this.store.failJob({
      jobId: job.id,
      workerId: this.options.workerId ?? "fine_tuning.desktop",
      expectedRevision: job.revision,
      errorCode: failure.code,
      retryable: failure.retryable,
      settledCostMicros: 0,
      costSource: "local_resource_estimate",
      operation: operation.value,
    });
    if (!persisted.ok) return persisted;
    return err(failure);
  }

  private async resolveProjectSources(
    projectId: string,
  ): Promise<Result<readonly ResolvedFineTuningSource[], StoryCoreError>> {
    try {
      const chapters = await this.options.executor.select<ChapterSourceRow>(
        `SELECT version.id, version.project_id, version.sequence,
                version.content, version.content_checksum, version.reason,
                chapter.title
         FROM chapter_versions AS version
         INNER JOIN chapters AS chapter ON chapter.id = version.chapter_id
         WHERE version.project_id = ? AND chapter.status = 'active'
         ORDER BY version.created_at DESC, version.id DESC
         LIMIT 500`,
        [projectId],
      );
      const materials = await this.options.executor.select<MaterialSourceRow>(
        `SELECT id, project_id, revision, status, snapshot_json
         FROM story_materials
         WHERE project_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 500`,
        [projectId],
      );
      const resolved: ResolvedFineTuningSource[] = [];
      for (const row of chapters) {
        const hash = await this.hashContent(row.content);
        if (!hash.ok) return hash;
        const kind: FineTuningSourceKind =
          row.reason === "import" ? "local_import" : "chapter_version";
        resolved.push(
          Object.freeze({
            content: row.content,
            descriptor: Object.freeze({
              id: row.id,
              kind,
              revision: row.sequence,
              label:
                kind === "local_import"
                  ? `${row.title} · 导入版本 ${String(row.sequence)}`
                  : `${row.title} · 版本 ${String(row.sequence)}`,
              contentHash: hash.value,
              contentBytes: new TextEncoder().encode(row.content).byteLength,
              rights: null,
              rightsDeclarationRequired: true,
              status: "governance_blocked",
              blocker: "需要人工声明版权基础与训练许可。",
            }),
          }),
        );
      }
      for (const row of materials) {
        const snapshot = parseMaterialSnapshot(row.snapshot_json);
        if (!snapshot.ok) return snapshot;
        const hash = await this.hashContent(snapshot.value.body);
        if (!hash.ok) return hash;
        const rights: FineTuningRightsSummary = {
          kind: mapMaterialRights(snapshot.value.license),
          basis: snapshot.value.rightsBasis,
          confirmedAt: snapshot.value.rightsConfirmedAt,
          allowTraining: snapshot.value.allowTraining,
        };
        const blocked =
          row.status !== "active" ||
          rights.kind === "unknown" ||
          rights.confirmedAt === null ||
          !rights.allowTraining;
        resolved.push(
          Object.freeze({
            content: snapshot.value.body,
            descriptor: Object.freeze({
              id: row.id,
              kind: "material",
              revision: row.revision,
              label: snapshot.value.title,
              contentHash: hash.value,
              contentBytes: new TextEncoder().encode(snapshot.value.body).byteLength,
              rights: Object.freeze(rights),
              rightsDeclarationRequired: false,
              status: blocked ? "governance_blocked" : "eligible",
              blocker:
                row.status !== "active"
                  ? "素材已删除或合并。"
                  : rights.kind === "unknown" || rights.confirmedAt === null
                    ? "素材版权或授权基础尚未确认。"
                    : !rights.allowTraining
                      ? "素材明确禁止用于训练。"
                      : null,
            }),
          }),
        );
      }
      return ok(Object.freeze(resolved));
    } catch (cause: unknown) {
      return repositoryError(cause);
    }
  }

  private async hashContent(content: string): Promise<Result<string, StoryCoreError>> {
    const hash = await this.options.hasher.sha256(content);
    return hash.ok
      ? ok(hash.value)
      : err(
          new StoryCoreError({
            code: "STORY_REPOSITORY_ERROR",
            message: "无法校验本地训练来源的内容哈希。",
            retryable: hash.error.retryable,
            actions: ["RETRY", "CONTACT_SUPPORT"],
          }),
        );
  }

  private async readAudit(projectId: string): Promise<readonly FineTuningAuditSummary[]> {
    const rows = await this.options.executor.select<AuditRow>(
      `SELECT id, entity_type, entity_id, action, actor_id,
              request_id, created_at
       FROM fine_tuning_audit_events
       WHERE project_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      [projectId],
    );
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: row.id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          action: row.action,
          actorId: row.actor_id,
          requestId: row.request_id,
          createdAt: row.created_at,
        }),
      ),
    );
  }

  private async findDatasetApprovalId(
    dataset: FineTuningDatasetSnapshot,
  ): Promise<Result<string, StoryCoreError>> {
    try {
      const rows = await this.options.executor.select<ApprovalLookupRow>(
        `SELECT id
         FROM fine_tuning_approvals
         WHERE project_id = ? AND kind = 'dataset_training'
           AND entity_type = 'dataset' AND entity_id = ?
           AND entity_revision = ? AND authority_hash = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [dataset.projectId, dataset.id, dataset.revision - 1, dataset.manifestHash],
      );
      return rows[0] === undefined
        ? humanApprovalError("找不到与当前数据集版本绑定的训练审批。")
        : ok(rows[0].id);
    } catch (cause: unknown) {
      return repositoryError(cause);
    }
  }

  private async findArtifactApprovalId(
    artifact: FineTuningModelArtifactRecord,
    kind: "model_registration" | "model_deployment",
    targetRole?: FineTuningDeploymentTargetRole,
  ): Promise<Result<string, StoryCoreError>> {
    try {
      const rows = await this.options.executor.select<ApprovalLookupRow>(
        `SELECT id
         FROM fine_tuning_approvals
         WHERE project_id = ? AND kind = ? AND entity_type = 'artifact'
           AND entity_id = ? AND entity_revision = ?
           AND (
             ? IS NULL
             OR json_extract(declarations_json, '$.targetRole') = ?
           )
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [
          artifact.projectId,
          kind,
          artifact.id,
          artifact.revision - 1,
          targetRole ?? null,
          targetRole ?? null,
        ],
      );
      return rows[0] === undefined
        ? humanApprovalError("找不到与当前模型版本及目标绑定的人工审批。")
        : ok(rows[0].id);
    } catch (cause: unknown) {
      return repositoryError(cause);
    }
  }

  private async findDeployment(
    deploymentId: string,
  ): Promise<Result<FineTuningDeploymentRecord, StoryCoreError>> {
    try {
      const rows = await this.options.executor.select<{
        readonly project_id: string;
      }>(
        `SELECT project_id
         FROM fine_tuning_deployments
         WHERE id = ?`,
        [deploymentId],
      );
      if (rows[0] === undefined) return notFoundError("模型部署记录不存在。");
      const deployments = await this.store.listDeployments(rows[0].project_id, 500);
      if (!deployments.ok) return deployments;
      const deployment = deployments.value.find(({ id }) => id === deploymentId);
      return deployment === undefined ? notFoundError("模型部署记录不存在。") : ok(deployment);
    } catch (cause: unknown) {
      return repositoryError(cause);
    }
  }

  private async replayClaim(
    requestKey: string | undefined,
    operation: string,
    authority: unknown,
    expectedEntityType: OperationClaimRow["result_entity_type"],
  ): Promise<Result<OperationClaimRow | null, StoryCoreError>> {
    if (requestKey === undefined) return ok(null);
    try {
      const requestHash = await computeFineTuningGovernanceHash({
        action: operation,
        authority,
      });
      const rows = await this.options.executor.select<OperationClaimRow>(
        `SELECT operation, request_hash, result_entity_type, result_entity_id
         FROM fine_tuning_operation_claims
         WHERE idempotency_key = ?`,
        [requestKey],
      );
      const claim = rows[0];
      if (claim === undefined) return ok(null);
      if (
        claim.operation !== operation ||
        claim.request_hash !== requestHash ||
        claim.result_entity_type !== expectedEntityType
      ) {
        return idempotencyConflictError();
      }
      return ok(claim);
    } catch (cause: unknown) {
      return repositoryError(cause);
    }
  }

  private async operation(
    action: string,
    actorId: string,
    authority: unknown,
    requestKey?: string,
    fixedNow?: string,
  ): Promise<Result<FineTuningOperationContext, StoryCoreError>> {
    try {
      const idempotencyKey = requestKey ?? this.options.ids.next();
      return ok(
        Object.freeze({
          idempotencyKey,
          requestHash: await computeFineTuningGovernanceHash({
            action,
            authority,
          }),
          auditEventId: this.options.ids.next(),
          actorId,
          requestId: this.options.ids.next(),
          correlationId: idempotencyKey,
          now: fixedNow ?? this.options.clock.now(),
        }),
      );
    } catch (cause: unknown) {
      return repositoryError(cause);
    }
  }
}

class UnavailableFineTuningDesktopRuntime implements FineTuningDesktopPort {
  public constructor(public readonly availability: FineTuningAvailability) {}

  public inspect(): Promise<Result<FineTuningDashboard, StoryCoreError>> {
    return unavailablePromise();
  }

  public createDataset(): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>> {
    return unavailablePromise();
  }

  public approveDataset(): Promise<Result<FineTuningDatasetSnapshot, StoryCoreError>> {
    return unavailablePromise();
  }

  public configurePolicy(): Promise<Result<FineTuningQuotaPolicyRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public queueTraining(): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public runNextLocalJob(): Promise<
    Result<
      Readonly<{
        job: FineTuningJobRecord;
        artifact: FineTuningModelArtifactRecord;
      }> | null,
      StoryCoreError
    >
  > {
    return unavailablePromise();
  }

  public cancelJob(): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public retryJob(): Promise<Result<FineTuningJobRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public recoverExpiredJobs(): Promise<Result<readonly FineTuningJobRecord[], StoryCoreError>> {
    return unavailablePromise();
  }

  public recordEvaluation(): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public approveRegistration(): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public registerArtifact(): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public approveDeployment(): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public activateDeployment(): Promise<Result<FineTuningDeploymentRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public rollbackDeployment(): Promise<Result<FineTuningDeploymentRecord, StoryCoreError>> {
    return unavailablePromise();
  }

  public revokeArtifact(): Promise<Result<FineTuningModelArtifactRecord, StoryCoreError>> {
    return unavailablePromise();
  }
}

function parseMaterialSnapshot(value: string): Result<
  Readonly<{
    title: string;
    body: string;
    license: "owned" | "licensed" | "public_domain" | "permission_unknown";
    rightsBasis: string;
    rightsConfirmedAt: string | null;
    allowTraining: boolean;
  }>,
  StoryCoreError
> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.permissions)) {
      return corruptSourceError();
    }
    if (
      typeof parsed.title !== "string" ||
      typeof parsed.body !== "string" ||
      !["owned", "licensed", "public_domain", "permission_unknown"].includes(
        String(parsed.license),
      ) ||
      typeof parsed.permissions.rightsBasis !== "string" ||
      (parsed.permissions.rightsConfirmedAt !== null &&
        typeof parsed.permissions.rightsConfirmedAt !== "string") ||
      typeof parsed.permissions.allowTraining !== "boolean"
    ) {
      return corruptSourceError();
    }
    return ok(
      Object.freeze({
        title: parsed.title,
        body: parsed.body,
        license: parsed.license as "owned" | "licensed" | "public_domain" | "permission_unknown",
        rightsBasis: parsed.permissions.rightsBasis,
        rightsConfirmedAt: parsed.permissions.rightsConfirmedAt,
        allowTraining: parsed.permissions.allowTraining,
      }),
    );
  } catch {
    return corruptSourceError();
  }
}

function mapMaterialRights(
  license: "owned" | "licensed" | "public_domain" | "permission_unknown",
): FineTuningRightsKind {
  switch (license) {
    case "owned":
      return "user_owned";
    case "licensed":
      return "licensed_for_training";
    case "public_domain":
      return "public_domain";
    case "permission_unknown":
      return "unknown";
  }
}

function unavailablePromise<Value>(): Promise<Result<Value, StoryCoreError>> {
  return Promise.resolve(
    err(
      new StoryCoreError({
        code: "FINE_TUNING_PROVIDER_UNAVAILABLE",
        message: "微调治理功能当前未启用或此运行环境不受支持。",
        actions: ["CONFIGURE_LOCAL_TRAINER"],
      }),
    ),
  );
}

function validationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_VALIDATION_FAILED",
      message,
      actions: ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function sourceChangedError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_SOURCE_CHANGED",
      message,
      retryable: true,
      actions: ["RECOMPARE"],
    }),
  );
}

function humanApprovalError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_HUMAN_APPROVAL_REQUIRED",
      message,
      actions: ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function providerUnavailableError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_PROVIDER_UNAVAILABLE",
      message: "尚未配置经过验证的本地训练器；不会创建或提交训练作业。",
      actions: ["CONFIGURE_LOCAL_TRAINER"],
    }),
  );
}

function remoteForbiddenError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_REMOTE_SUBMISSION_FORBIDDEN",
      message: "桌面微调治理仅允许本地执行，远端训练默认关闭且不会自动提交。",
      actions: ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function quotaError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_QUOTA_EXCEEDED",
      message,
      actions: ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function preflightError(
  checks: ReturnType<typeof runFineTuningTrainingPreflight>["checks"],
): Result<never, StoryCoreError> {
  const blocking = checks.filter(({ level }) => level === "blocking");
  const providerBlocked = blocking.some(({ code }) => code === "FINE_TUNING_PROVIDER_UNAVAILABLE");
  return err(
    new StoryCoreError({
      code: providerBlocked ? "FINE_TUNING_PROVIDER_UNAVAILABLE" : "FINE_TUNING_QUOTA_EXCEEDED",
      message: blocking.map(({ detail }) => detail).join(" "),
      actions: providerBlocked ? ["CONFIGURE_LOCAL_TRAINER"] : ["REVIEW_FINE_TUNING_GOVERNANCE"],
    }),
  );
}

function notFoundError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_NOT_FOUND",
      message,
    }),
  );
}

function revisionConflictError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "微调治理对象已变化，请刷新后重新比较。",
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
    }),
  );
}

function idempotencyConflictError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "FINE_TUNING_IDEMPOTENCY_CONFLICT",
      message: "同一个幂等键已绑定到不同的微调治理请求。",
      actions: ["CONTACT_SUPPORT"],
    }),
  );
}

function corruptSourceError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message: "本地素材记录未通过完整性校验。",
      actions: ["CONTACT_SUPPORT"],
    }),
  );
}

function repositoryError(cause: unknown): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message: "读取或写入本地微调治理数据失败。",
      retryable: true,
      actions: ["RETRY", "CONTACT_SUPPORT"],
      details: {
        causeName: cause instanceof Error ? cause.name : "UnknownError",
      },
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
