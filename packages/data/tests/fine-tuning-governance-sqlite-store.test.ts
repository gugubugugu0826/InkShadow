import { readFileSync } from "node:fs";

import {
  approveFineTuningDataset,
  computeFineTuningEvaluationAuthorityHash,
  computeFineTuningGovernanceHash,
  createFineTuningDataset,
  createFineTuningTrainingPlan,
  evaluateFineTuningCandidate,
  FineTuningGovernanceSqliteRepository,
  type FineTuningDatasetApproval,
  type FineTuningDatasetSnapshot,
  type FineTuningEvaluationGateInput,
  type FineTuningOperationContext,
  type FineTuningTrainingPlan,
} from "@inkshadow/story-core";
import { afterEach, describe, expect, it } from "vitest";

import { FineTuningGovernanceSqliteStore } from "../src/fine-tuning-governance-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0028_fine_tuning_governance.sql", import.meta.url), "utf8"),
].join("\n");

const PROJECT_ID = uuid(1);
const OTHER_PROJECT_ID = uuid(2);
const DATASET_ID = uuid(10);
const DATASET_APPROVAL_ID = uuid(11);
const JOB_ID = uuid(20);
const ARTIFACT_ID = uuid(30);
const EVALUATION_ID = uuid(31);
const REGISTRATION_APPROVAL_ID = uuid(32);
const DEPLOYMENT_APPROVAL_ID = uuid(33);
const DEPLOYMENT_ID = uuid(34);
const ROLLBACK_APPROVAL_ID = uuid(35);
const NOW = "2026-07-29T09:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("FineTuningGovernanceSqliteStore", () => {
  const executors: NodeSqliteExecutor[] = [];

  afterEach(async () => {
    await Promise.all(executors.splice(0).map((executor) => executor.close()));
  });

  it("migrates idempotently and rejects cross-project or remote authority", async () => {
    const executor = createExecutor(executors);
    executor.database.exec(
      readFileSync(
        new URL("../migrations/0028_fine_tuning_governance.sql", import.meta.url),
        "utf8",
      ),
    );

    const tables = await executor.select<{ name: string }>(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'fine_tuning_%'
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "fine_tuning_approvals",
      "fine_tuning_audit_events",
      "fine_tuning_datasets",
      "fine_tuning_deployments",
      "fine_tuning_evaluations",
      "fine_tuning_jobs",
      "fine_tuning_model_artifacts",
      "fine_tuning_operation_claims",
      "fine_tuning_quota_policies",
      "fine_tuning_samples",
    ]);

    await expect(
      executor.execute(
        `INSERT INTO fine_tuning_quota_policies (
           project_id, allow_remote_training, maximum_dataset_bytes,
           maximum_concurrent_jobs, maximum_single_job_cost_micros,
           monthly_cost_limit_micros, currency, spent_micros,
           reserved_micros, active_jobs, month_key, revision,
           created_at, updated_at
         ) VALUES (?, 1, 1000, 1, 0, 0, 'USD', 0, 0, 0, '2026-07', 1, ?, ?)`,
        [PROJECT_ID, NOW, NOW],
      ),
    ).rejects.toThrow();

    const dataset = await approvedDataset();
    const store = createGovernanceRepository(executor);
    await expectOk(
      store.createDataset(dataset.unapproved, await operation("create-cross-fixture", 1)),
    );
    await expect(
      executor.execute(
        `INSERT INTO fine_tuning_samples (
           id, dataset_id, project_id, source_kind, source_entity_id,
           source_revision, source_label, content_text, content_hash,
           content_bytes, rights_kind, rights_basis, rights_confirmed_at,
           allow_training, privacy_scan_version, pii_finding_count,
           sensitive_finding_count, privacy_findings_json, privacy_passed,
           split, duplicate_of_sample_id, created_at
         ) VALUES (?, ?, ?, 'material', ?, 1, 'cross', 'x', ?, 1,
                   'user_owned', 'owned', ?, 1, 'inkshadow.privacy-scan.v1',
                   0, 0, '[]', 1, 'excluded', ?, ?)`,
        [uuid(990), DATASET_ID, OTHER_PROJECT_ID, uuid(991), HASH_A, NOW, uuid(100), NOW],
      ),
    ).rejects.toThrow();
  });

  it("persists the full governed lifecycle with deterministic evaluation and deployment approval", async () => {
    const executor = createExecutor(executors);
    const store = createGovernanceRepository(executor);
    const fixture = await approvedDataset();

    const created = await expectOk(
      store.createDataset(fixture.unapproved, await operation("dataset-create", 1)),
    );
    const replayed = await expectOk(
      store.createDataset(fixture.unapproved, await operation("dataset-create", 1)),
    );
    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      state: "review_required",
      includedSampleCount: 3,
      duplicateSampleCount: 1,
      splitCounts: { train: 1, validation: 1, test: 1 },
    });

    const approved = await expectOk(
      store.approveDataset(
        fixture.approved,
        fixture.approval,
        await operationAt("dataset-approve", 2, "2026-07-29T09:00:01.000Z"),
      ),
    );
    expect(approved).toMatchObject({ state: "approved", revision: 2 });

    const policy = await expectOk(
      store.configurePolicy({
        projectId: PROJECT_ID,
        policy: quotaPolicy(),
        monthKey: "2026-07",
        operation: await operation("policy-create", 3),
      }),
    );
    expect(policy).toMatchObject({
      activeJobs: 0,
      reservedMicros: 0,
      spentMicros: 0,
      allowRemoteTraining: false,
    });

    const plan = await localPlan(approved);
    const queued = await expectOk(
      store.queueJob({
        id: JOB_ID,
        projectId: PROJECT_ID,
        datasetApprovalId: DATASET_APPROVAL_ID,
        plan,
        maximumAttempts: 2,
        createdBy: "local_owner",
        monthKey: "2026-07",
        operation: await operation("job-queue", 4),
      }),
    );
    const queueReplay = await expectOk(
      store.queueJob({
        id: JOB_ID,
        projectId: PROJECT_ID,
        datasetApprovalId: DATASET_APPROVAL_ID,
        plan,
        maximumAttempts: 2,
        createdBy: "local_owner",
        monthKey: "2026-07",
        operation: await operation("job-queue", 4),
      }),
    );
    expect(queueReplay).toEqual(queued);
    expect(queued).toMatchObject({ status: "queued", attemptCount: 0 });

    const claimed = await expectOk(
      store.claimNextJob({
        projectId: PROJECT_ID,
        workerId: "local_trainer",
        leaseExpiresAt: "2026-07-29T09:10:00.000Z",
        operation: await operation("job-claim", 5),
      }),
    );
    expect(claimed).toMatchObject({
      id: JOB_ID,
      status: "running",
      attemptCount: 1,
      leaseOwner: "local_trainer",
    });
    if (claimed === null) throw new Error("Expected a claimed job.");

    const completed = await expectOk(
      store.completeJob({
        jobId: JOB_ID,
        workerId: "local_trainer",
        expectedRevision: claimed.revision,
        artifactId: ARTIFACT_ID,
        artifactDigest: HASH_A,
        localArtifactRef: "adapter_local_001",
        settledCostMicros: 80_000,
        costSource: "local_resource_estimate",
        providerReceiptDigest: HASH_B,
        operation: await operation("job-complete", 6),
      }),
    );
    expect(completed).toMatchObject({
      job: { status: "artifact_ready", settledCostMicros: 80_000 },
      artifact: { state: "candidate", localArtifactRef: "adapter_local_001" },
    });

    const gateInput = evaluationInput();
    const gateResult = evaluateFineTuningCandidate(gateInput);
    if (!gateResult.ok) throw gateResult.error;
    const authorityHash = await computeFineTuningEvaluationAuthorityHash(
      gateInput,
      gateResult.value,
    );
    const forged = await store.recordEvaluation({
      id: uuid(930),
      projectId: PROJECT_ID,
      artifactId: ARTIFACT_ID,
      evaluatorId: "local_eval",
      evaluatorVersion: "golden.v1",
      authorityHash,
      gateInput,
      gateResult: { ...gateResult.value, passed: false },
      createdBy: "local_owner",
      expectedArtifactRevision: completed.artifact.revision,
      operation: await operation("evaluation-forged", 7),
    });
    expect(forged).toMatchObject({
      ok: false,
      error: { code: "FINE_TUNING_VALIDATION_FAILED" },
    });

    const evaluated = await expectOk(
      store.recordEvaluation({
        id: EVALUATION_ID,
        projectId: PROJECT_ID,
        artifactId: ARTIFACT_ID,
        evaluatorId: "local_eval",
        evaluatorVersion: "golden.v1",
        authorityHash,
        gateInput,
        gateResult: gateResult.value,
        createdBy: "local_owner",
        expectedArtifactRevision: completed.artifact.revision,
        operation: await operation("evaluation-record", 8),
      }),
    );
    expect(evaluated).toMatchObject({
      evaluation: { result: { passed: true } },
      artifact: { state: "evaluation_passed" },
    });

    const registrationApproved = await expectOk(
      store.approveRegistration({
        approvalId: REGISTRATION_APPROVAL_ID,
        artifactId: ARTIFACT_ID,
        expectedRevision: evaluated.artifact.revision,
        authorityHash: await computeFineTuningGovernanceHash({
          artifactId: ARTIFACT_ID,
          evaluationId: EVALUATION_ID,
          action: "register",
        }),
        humanConfirmed: true,
        operation: await operation("registration-approve", 9),
      }),
    );
    const registered = await expectOk(
      store.registerArtifact({
        artifactId: ARTIFACT_ID,
        expectedRevision: registrationApproved.revision,
        registrationApprovalId: REGISTRATION_APPROVAL_ID,
        registrationName: "本地武侠适配器 v1",
        providerReceiptDigest: HASH_A,
        operation: await operation("artifact-register", 10),
      }),
    );
    expect(registered).toMatchObject({ state: "registered" });

    const deploymentApproved = await expectOk(
      store.approveDeployment({
        approvalId: DEPLOYMENT_APPROVAL_ID,
        artifactId: ARTIFACT_ID,
        expectedRevision: registered.revision,
        targetRole: "local_private",
        authorityHash: await computeFineTuningGovernanceHash({
          artifactId: ARTIFACT_ID,
          targetRole: "local_private",
          action: "deploy",
        }),
        humanConfirmed: true,
        operation: await operation("deployment-approve", 11),
      }),
    );
    const wrongRole = await store.activateDeployment({
      deploymentId: uuid(932),
      artifactId: ARTIFACT_ID,
      expectedArtifactRevision: deploymentApproved.revision,
      deploymentApprovalId: DEPLOYMENT_APPROVAL_ID,
      targetRole: "fast",
      providerReceiptDigest: HASH_B,
      operation: await operation("deployment-wrong-role", 12),
    });
    expect(wrongRole).toMatchObject({
      ok: false,
      error: { code: "FINE_TUNING_VALIDATION_FAILED" },
    });

    const deployed = await expectOk(
      store.activateDeployment({
        deploymentId: DEPLOYMENT_ID,
        artifactId: ARTIFACT_ID,
        expectedArtifactRevision: deploymentApproved.revision,
        deploymentApprovalId: DEPLOYMENT_APPROVAL_ID,
        targetRole: "local_private",
        providerReceiptDigest: HASH_B,
        operation: await operation("deployment-activate", 13),
      }),
    );
    expect(deployed).toMatchObject({
      deployment: { status: "active", targetRole: "local_private" },
      artifact: { state: "deployed" },
    });

    const rolledBack = await expectOk(
      store.rollbackDeployment({
        deploymentId: DEPLOYMENT_ID,
        rollbackApprovalId: ROLLBACK_APPROVAL_ID,
        authorityHash: await computeFineTuningGovernanceHash({
          deploymentId: DEPLOYMENT_ID,
          action: "rollback",
        }),
        humanConfirmed: true,
        providerReceiptDigest: HASH_A,
        operation: await operation("deployment-rollback", 14),
      }),
    );
    expect(rolledBack).toMatchObject({
      deployment: { status: "rolled_back" },
      artifact: { state: "rolled_back" },
      restoredDeployment: null,
    });

    const usage = await expectOk(store.findPolicy(PROJECT_ID));
    expect(usage).toMatchObject({
      activeJobs: 0,
      reservedMicros: 0,
      spentMicros: 80_000,
    });
    const audit = await executor.select<{
      action: string;
      metadata_json: string;
    }>(
      `SELECT action, metadata_json
       FROM fine_tuning_audit_events
       ORDER BY created_at, id`,
    );
    expect(audit.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "dataset_created",
        "dataset_approved",
        "job_queued",
        "artifact_created",
        "evaluation_passed",
        "artifact_registered",
        "deployment_activated",
        "deployment_rolled_back",
      ]),
    );
    expect(audit.map(({ metadata_json }) => metadata_json).join("\n")).not.toContain(
      fixture.unapproved.samples[0]?.content,
    );
    expect(
      await executor.select<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM fine_tuning_operation_claims
         WHERE idempotency_key = 'dataset-create'`,
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("recovers an expired lease and cancels a retryable failure without double-settling quota", async () => {
    const executor = createExecutor(executors);
    const store = createGovernanceRepository(executor);
    const fixture = await seedApprovedDatasetAndPolicy(store);
    const plan = await localPlan(fixture);

    await expectOk(
      store.queueJob({
        id: JOB_ID,
        projectId: PROJECT_ID,
        datasetApprovalId: DATASET_APPROVAL_ID,
        plan,
        maximumAttempts: 3,
        createdBy: "local_owner",
        monthKey: "2026-07",
        operation: await operationAt("recover-queue", 20, "2026-07-29T09:00:03.000Z"),
      }),
    );
    const firstClaim = await expectOk(
      store.claimNextJob({
        projectId: PROJECT_ID,
        workerId: "worker_one",
        leaseExpiresAt: "2026-07-29T09:00:05.000Z",
        operation: await operationAt("recover-claim-one", 21, "2026-07-29T09:00:04.000Z"),
      }),
    );
    if (firstClaim === null) throw new Error("Expected first claim.");
    const recovered = await expectOk(
      store.recoverExpiredJob({
        jobId: JOB_ID,
        expectedRevision: firstClaim.revision,
        operation: await operationAt("recover-expired", 22, "2026-07-29T09:00:06.000Z"),
      }),
    );
    expect(recovered).toMatchObject({
      status: "queued",
      attemptCount: 1,
      leaseOwner: null,
    });

    const secondClaim = await expectOk(
      store.claimNextJob({
        projectId: PROJECT_ID,
        workerId: "worker_two",
        leaseExpiresAt: "2026-07-29T09:10:00.000Z",
        operation: await operationAt("recover-claim-two", 23, "2026-07-29T09:00:07.000Z"),
      }),
    );
    if (secondClaim === null) throw new Error("Expected second claim.");
    const failed = await expectOk(
      store.failJob({
        jobId: JOB_ID,
        workerId: "worker_two",
        expectedRevision: secondClaim.revision,
        errorCode: "LOCAL_TRAINER_INTERRUPTED",
        retryable: true,
        settledCostMicros: 25_000,
        costSource: "local_resource_estimate",
        operation: await operationAt("recover-fail", 24, "2026-07-29T09:00:08.000Z"),
      }),
    );
    expect(failed).toMatchObject({
      status: "failed_retryable",
      failureCode: "LOCAL_TRAINER_INTERRUPTED",
    });
    const cancelled = await expectOk(
      store.requestCancellation({
        jobId: JOB_ID,
        expectedRevision: failed.revision,
        operation: await operationAt("recover-cancel", 25, "2026-07-29T09:00:09.000Z"),
      }),
    );
    expect(cancelled).toMatchObject({
      status: "cancelled",
      failureCode: null,
      settledCostMicros: 25_000,
    });
    const usage = await expectOk(store.findPolicy(PROJECT_ID));
    expect(usage).toMatchObject({
      activeJobs: 0,
      reservedMicros: 0,
      spentMicros: 25_000,
    });
    if (usage === null) throw new Error("Expected a configured quota policy.");

    const currencyChange = await store.configurePolicy({
      projectId: PROJECT_ID,
      policy: { ...quotaPolicy(), currency: "AUD" },
      monthKey: "2026-07",
      expectedRevision: usage.revision,
      operation: await operationAt("currency-change", 26, "2026-07-29T09:00:10.000Z"),
    });
    expect(currencyChange).toMatchObject({
      ok: false,
      error: { code: "STORY_REVISION_CONFLICT" },
    });
  });
});

async function seedApprovedDatasetAndPolicy(
  store: FineTuningGovernanceSqliteRepository,
): Promise<FineTuningDatasetSnapshot> {
  const fixture = await approvedDataset();
  await expectOk(
    store.createDataset(
      fixture.unapproved,
      await operationAt("seed-dataset", 40, "2026-07-29T09:00:00.000Z"),
    ),
  );
  const approved = await expectOk(
    store.approveDataset(
      fixture.approved,
      fixture.approval,
      await operationAt("seed-approval", 41, "2026-07-29T09:00:01.000Z"),
    ),
  );
  await expectOk(
    store.configurePolicy({
      projectId: PROJECT_ID,
      policy: quotaPolicy(),
      monthKey: "2026-07",
      operation: await operationAt("seed-policy", 42, "2026-07-29T09:00:02.000Z"),
    }),
  );
  return approved;
}

async function approvedDataset(): Promise<{
  readonly unapproved: FineTuningDatasetSnapshot;
  readonly approved: FineTuningDatasetSnapshot;
  readonly approval: FineTuningDatasetApproval;
}> {
  const contents = [
    "雨落长街，旅人收起旧伞，决定在黎明前离城。",
    "城门钟声响了三次，守卫才发现通行文书上的暗记。",
    "她没有拔剑，只把那封未寄出的信放在桌上。",
    "雨落长街，旅人收起旧伞，决定在黎明前离城。",
  ] as const;
  const created = await createFineTuningDataset({
    id: DATASET_ID,
    projectId: PROJECT_ID,
    name: "本地自有风格样本",
    samples: contents.map((content, index) => ({
      id: uuid(100 + index),
      source: {
        kind: "material" as const,
        projectId: PROJECT_ID,
        entityId: uuid(200 + index),
        entityRevision: 1,
        label: `素材 ${String(index + 1)}`,
      },
      content,
      rights: {
        kind: "user_owned" as const,
        basis: "作者明确确认本人拥有训练和商业使用权。",
        confirmedAt: NOW,
        allowTraining: true,
      },
    })),
    splitPolicy: {
      seed: "fine_tuning_split_v1",
      trainParts: 8,
      validationParts: 1,
      testParts: 1,
    },
    createdBy: "local_owner",
    now: NOW,
  });
  if (!created.ok) throw created.error;
  const approved = approveFineTuningDataset(created.value, {
    approvalId: DATASET_APPROVAL_ID,
    actorId: "local_owner",
    expectedRevision: created.value.revision,
    expectedManifestHash: created.value.manifestHash,
    privacyReviewed: true,
    copyrightReviewed: true,
    trainingPurposeConfirmed: true,
    humanConfirmed: true,
    now: "2026-07-29T09:00:01.000Z",
  });
  if (!approved.ok) throw approved.error;
  return {
    unapproved: created.value,
    approved: approved.value.dataset,
    approval: approved.value.approval,
  };
}

async function localPlan(dataset: FineTuningDatasetSnapshot): Promise<FineTuningTrainingPlan> {
  const result = await createFineTuningTrainingPlan({
    dataset,
    baseModel: {
      providerId: "ollama_local",
      modelId: "qwen2.5:7b",
      revision: "sha256-base",
      license: {
        licenseId: "apache_2_0",
        licenseVersion: "2.0",
        fineTuningAllowed: true,
        commercialUseAllowed: true,
        redistributionAllowed: true,
        confirmedAt: NOW,
      },
    },
    provider: {
      location: "local",
      providerId: "local_trainer",
      credentialProfileId: null,
      commercialAuthorizationId: null,
    },
    method: "lora",
    hyperparameters: {
      rank: 16,
      alpha: 32,
      dropout: 0.05,
      learningRate: 0.0002,
      epochs: 3,
    },
    limits: {
      maximumDurationMs: 3_600_000,
      maximumCostMicros: 200_000,
      estimatedCostMicros: 100_000,
      estimatedGpuMinutes: 45,
      currency: "USD",
    },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function evaluationInput(): FineTuningEvaluationGateInput {
  return {
    baselineModelId: "qwen2.5-7b",
    candidateArtifactId: ARTIFACT_ID,
    baseline: [
      { name: "style_fidelity", score: 0.7 },
      { name: "memorization_risk", score: 0.02 },
      { name: "safety", score: 0.95 },
    ],
    candidate: [
      { name: "style_fidelity", score: 0.84 },
      { name: "memorization_risk", score: 0.03 },
      { name: "safety", score: 0.96 },
    ],
    rules: [
      {
        metric: "style_fidelity",
        direction: "higher_is_better",
        minimumCandidate: 0.8,
        minimumImprovement: 0.05,
      },
      {
        metric: "memorization_risk",
        direction: "lower_is_better",
        maximumCandidate: 0.05,
        maximumRegression: 0.02,
      },
      {
        metric: "safety",
        direction: "higher_is_better",
        minimumCandidate: 0.93,
        maximumRegression: 0.02,
      },
    ],
  };
}

function quotaPolicy() {
  return {
    allowRemoteTraining: false,
    maximumDatasetBytes: 10_000_000,
    maximumConcurrentJobs: 2,
    maximumSingleJobCostMicros: 500_000,
    monthlyCostLimitMicros: 2_000_000,
    currency: "USD",
  } as const;
}

function createExecutor(executors: NodeSqliteExecutor[]): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(migration);
  executors.push(executor);
  executor.database
    .prepare(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, ?, 'active', 1, 0, ?, ?)`,
    )
    .run(PROJECT_ID, "微调治理项目", NOW, NOW);
  executor.database
    .prepare(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, ?, 'active', 1, 0, ?, ?)`,
    )
    .run(OTHER_PROJECT_ID, "其他项目", NOW, NOW);
  return executor;
}

function createGovernanceRepository(
  executor: NodeSqliteExecutor,
): FineTuningGovernanceSqliteRepository {
  return new FineTuningGovernanceSqliteRepository(new FineTuningGovernanceSqliteStore(executor));
}

async function operation(key: string, sequence: number): Promise<FineTuningOperationContext> {
  return operationAt(key, sequence, `2026-07-29T09:00:${String(sequence).padStart(2, "0")}.000Z`);
}

async function operationAt(
  key: string,
  sequence: number,
  now: string,
): Promise<FineTuningOperationContext> {
  return {
    idempotencyKey: key,
    requestHash: await computeFineTuningGovernanceHash({ key, sequence }),
    auditEventId: `audit-${String(sequence)}`,
    actorId: "local_owner",
    requestId: `request-${String(sequence)}`,
    correlationId: "fine-tuning-test",
    now,
  };
}

async function expectOk<Value>(
  promise: Promise<Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: Error }>>,
): Promise<Value> {
  const result = await promise;
  if (!result.ok) throw result.error;
  return result.value;
}

function uuid(value: number): string {
  return `019fa029-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}
