import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ContentHasher } from "@inkshadow/application";
import { parseContentChecksum } from "@inkshadow/domain";
import type { SqlExecutor } from "@inkshadow/data";
import {
  StoryCoreError,
  err,
  ok,
  type Clock,
  type Result,
  type UuidV7Generator,
} from "@inkshadow/story-core";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  createFineTuningDesktopRuntime,
  type FineTuningLocalTrainer,
  type FineTuningLocalTrainingReceipt,
  type FineTuningProviderReceipt,
} from "./fine-tuning-governance-runtime";

const migration = [
  readWorkspaceFile("packages", "data", "migrations", "0001_core.sql"),
  readWorkspaceFile("packages", "story-core", "migrations", "0002_materials.sql"),
  readWorkspaceFile("packages", "data", "migrations", "0028_fine_tuning_governance.sql"),
].join("\n");

const PROJECT_ID = uuid(1);
const ACTOR_ID = "local_owner";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const START = "2026-07-29T10:00:00.000Z";

describe("fine-tuning desktop runtime", () => {
  const executors: NodeSqliteExecutor[] = [];

  afterEach(async () => {
    await Promise.all(executors.splice(0).map((executor) => executor.close()));
  });

  it("is default-off, requires native SQLite, and exposes governance without pretending a trainer exists", async () => {
    const dependencies = {
      executor: {} as SqlExecutor,
      hasher: new CryptoContentHasher(),
      clock: new AdvancingClock(START),
      ids: new SequenceIds(500),
    };
    const disabled = createFineTuningDesktopRuntime({
      ...dependencies,
      persistence: "native_sqlite",
    });
    expect(disabled.availability).toEqual({
      available: false,
      reason: "feature_disabled",
      persistence: "native_sqlite",
      localTrainer: {
        available: false,
        reason: "feature_unavailable",
      },
    });
    await expect(disabled.inspect(PROJECT_ID)).resolves.toMatchObject({
      ok: false,
      error: { code: "FINE_TUNING_PROVIDER_UNAVAILABLE" },
    });

    const browser = createFineTuningDesktopRuntime({
      ...dependencies,
      featureEnabled: true,
      persistence: "browser_development",
    });
    expect(browser.availability).toMatchObject({
      available: false,
      reason: "native_sqlite_required",
    });

    const executor = createExecutor(executors);
    const governanceOnly = createFineTuningDesktopRuntime({
      ...dependencies,
      executor,
      featureEnabled: true,
      persistence: "native_sqlite",
    });
    expect(governanceOnly.availability).toEqual({
      available: true,
      persistence: "native_sqlite",
      localTrainer: {
        available: false,
        reason: "local_trainer_not_configured",
      },
    });
    await expect(governanceOnly.inspect(PROJECT_ID)).resolves.toMatchObject({
      ok: true,
      value: { projectId: PROJECT_ID },
    });
    await expect(governanceOnly.queueTraining(trainingInput("missing"))).resolves.toMatchObject({
      ok: false,
      error: { code: "FINE_TUNING_PROVIDER_UNAVAILABLE" },
    });
  });

  it("runs the local-only governed lifecycle from authoritative sources through rollback", async () => {
    const executor = createExecutor(executors);
    seedChapterSources(executor);
    const trainer = new FixtureLocalTrainer();
    const runtime = createFineTuningDesktopRuntime({
      featureEnabled: true,
      persistence: "native_sqlite",
      executor,
      hasher: new CryptoContentHasher(),
      clock: new AdvancingClock(START),
      ids: new SequenceIds(1_000),
      trainer,
      workerId: "fine_tuning.worker",
      leaseDurationMs: 60_000,
    });

    const initial = await expectOk(runtime.inspect(PROJECT_ID));
    expect(initial.sources).toHaveLength(4);
    expect(
      initial.sources.every(({ rightsDeclarationRequired }) => rightsDeclarationRequired),
    ).toBe(true);

    const createInput = {
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      name: "作者自有风格数据集",
      sources: initial.sources.map((source) => ({
        sourceId: source.id,
        expectedRevision: source.revision,
        expectedContentHash: source.contentHash,
        rights: {
          kind: "user_owned" as const,
          basis: "作者确认四个章节均为本人原创，并允许本地训练与商业使用。",
          allowTraining: true,
          humanConfirmed: true,
        },
      })),
      requestKey: "runtime-dataset-create",
    } as const;
    const dataset = await expectOk(runtime.createDataset(createInput));
    const datasetReplay = await expectOk(runtime.createDataset(createInput));
    expect(datasetReplay).toEqual(dataset);
    expect(dataset).toMatchObject({
      state: "review_required",
      includedSampleCount: 4,
      readinessIssues: [],
    });

    const approved = await expectOk(
      runtime.approveDataset({
        datasetId: dataset.id,
        actorId: ACTOR_ID,
        expectedRevision: dataset.revision,
        expectedManifestHash: dataset.manifestHash,
        privacyReviewed: true,
        copyrightReviewed: true,
        trainingPurposeConfirmed: true,
        humanConfirmed: true,
        requestKey: "runtime-dataset-approve",
      }),
    );
    expect(approved).toMatchObject({ state: "approved", revision: 2 });

    await expectOk(
      runtime.configurePolicy({
        projectId: PROJECT_ID,
        actorId: ACTOR_ID,
        policy: {
          allowRemoteTraining: false,
          maximumDatasetBytes: 10_000_000,
          maximumConcurrentJobs: 1,
          maximumSingleJobCostMicros: 500_000,
          monthlyCostLimitMicros: 1_000_000,
          currency: "USD",
        },
        monthKey: "2026-07",
        requestKey: "runtime-policy",
      }),
    );

    const queueInput = {
      ...trainingInput(approved.id),
      requestKey: "runtime-queue",
    } as const;
    const queued = await expectOk(runtime.queueTraining(queueInput));
    const queuedReplay = await expectOk(runtime.queueTraining(queueInput));
    expect(queuedReplay).toEqual(queued);
    expect(queued).toMatchObject({ status: "queued" });
    const completed = await expectOk(runtime.runNextLocalJob(PROJECT_ID, ACTOR_ID));
    if (completed === null) throw new Error("Expected one local training job.");
    expect(completed).toMatchObject({
      job: { status: "artifact_ready", settledCostMicros: 75_000 },
      artifact: { state: "candidate", localArtifactRef: "local_adapter_fixture" },
    });
    expect(trainer.trainCalls).toEqual([queued.id]);

    const evaluated = await expectOk(
      runtime.recordEvaluation({
        projectId: PROJECT_ID,
        artifactId: completed.artifact.id,
        actorId: ACTOR_ID,
        expectedArtifactRevision: completed.artifact.revision,
        evaluatorId: "golden_suite",
        evaluatorVersion: "style-safety.v1",
        gate: {
          baselineModelId: "qwen2.5-7b",
          candidateArtifactId: completed.artifact.id,
          baseline: [
            { name: "style_fidelity", score: 0.7 },
            { name: "memorization_risk", score: 0.02 },
          ],
          candidate: [
            { name: "style_fidelity", score: 0.85 },
            { name: "memorization_risk", score: 0.03 },
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
          ],
        },
        requestKey: "runtime-evaluate",
      }),
    );
    expect(evaluated.state).toBe("evaluation_passed");

    const registrationApproved = await expectOk(
      runtime.approveRegistration({
        artifactId: evaluated.id,
        actorId: ACTOR_ID,
        expectedRevision: evaluated.revision,
        humanConfirmed: true,
        requestKey: "runtime-registration-approve",
      }),
    );
    const registered = await expectOk(
      runtime.registerArtifact({
        artifactId: registrationApproved.id,
        actorId: ACTOR_ID,
        expectedRevision: registrationApproved.revision,
        registrationName: "本地风格模型 v1",
        requestKey: "runtime-register",
      }),
    );
    expect(registered.state).toBe("registered");

    const deploymentApproved = await expectOk(
      runtime.approveDeployment({
        artifactId: registered.id,
        actorId: ACTOR_ID,
        expectedRevision: registered.revision,
        targetRole: "local_private",
        humanConfirmed: true,
        requestKey: "runtime-deployment-approve",
      }),
    );
    const deployed = await expectOk(
      runtime.activateDeployment({
        artifactId: deploymentApproved.id,
        actorId: ACTOR_ID,
        expectedRevision: deploymentApproved.revision,
        targetRole: "local_private",
        requestKey: "runtime-deploy",
      }),
    );
    expect(deployed).toMatchObject({
      status: "active",
      targetRole: "local_private",
    });

    const rolledBack = await expectOk(
      runtime.rollbackDeployment({
        deploymentId: deployed.id,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        requestKey: "runtime-rollback",
      }),
    );
    expect(rolledBack.status).toBe("rolled_back");

    const final = await expectOk(runtime.inspect(PROJECT_ID));
    expect(final.policy).toMatchObject({
      activeJobs: 0,
      reservedMicros: 0,
      spentMicros: 75_000,
    });
    expect(final.audit.map(({ action }) => action)).toEqual(
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
    expect(
      final.audit.every(
        (event) => !("content" in event) && !("prompt" in event) && !("credential" in event),
      ),
    ).toBe(true);
  });

  it("uses authoritative material rights and refuses a WebView override", async () => {
    const executor = createExecutor(executors);
    seedBlockedMaterial(executor);
    const runtime = createFineTuningDesktopRuntime({
      featureEnabled: true,
      persistence: "native_sqlite",
      executor,
      hasher: new CryptoContentHasher(),
      clock: new AdvancingClock(START),
      ids: new SequenceIds(2_000),
    });
    const dashboard = await expectOk(runtime.inspect(PROJECT_ID));
    const material = dashboard.sources.find(({ kind }) => kind === "material");
    expect(material).toMatchObject({
      status: "governance_blocked",
      rightsDeclarationRequired: false,
      rights: {
        kind: "unknown",
        allowTraining: false,
      },
    });
    if (material === undefined) throw new Error("Expected material source.");

    const dataset = await expectOk(
      runtime.createDataset({
        projectId: PROJECT_ID,
        actorId: ACTOR_ID,
        name: "未获授权素材",
        sources: [
          {
            sourceId: material.id,
            expectedRevision: material.revision,
            expectedContentHash: material.contentHash,
            rights: {
              kind: "user_owned",
              basis: "浏览器伪造的覆盖声明",
              allowTraining: true,
              humanConfirmed: true,
            },
          },
        ],
      }),
    );
    expect(dataset.state).toBe("draft");
    expect(dataset.samples[0]?.rights).toMatchObject({
      kind: "unknown",
      allowTraining: false,
      confirmedAt: null,
    });
    expect(dataset.readinessIssues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "FINE_TUNING_SAMPLE_COUNT_TOO_LOW",
        "FINE_TUNING_RIGHTS_UNCONFIRMED",
        "FINE_TUNING_SPLIT_INCOMPLETE",
      ]),
    );
  });
});

class FixtureLocalTrainer implements FineTuningLocalTrainer {
  public readonly providerId = "fixture_local_trainer";
  public readonly trainCalls: string[] = [];

  public preflight(): Promise<Result<Readonly<{ available: true }>, StoryCoreError>> {
    return Promise.resolve(ok(Object.freeze({ available: true as const })));
  }

  public train(input: {
    readonly job: { readonly id: string };
    readonly signal: AbortSignal;
  }): Promise<Result<FineTuningLocalTrainingReceipt, StoryCoreError>> {
    if (input.signal.aborted) {
      return Promise.resolve(
        err(
          new StoryCoreError({
            code: "FINE_TUNING_PROVIDER_UNAVAILABLE",
            message: "Local trainer cancelled.",
            retryable: true,
          }),
        ),
      );
    }
    this.trainCalls.push(input.job.id);
    return Promise.resolve(
      ok(
        Object.freeze({
          artifactDigest: HASH_A,
          localArtifactRef: "local_adapter_fixture",
          settledCostMicros: 75_000,
          costSource: "local_resource_estimate" as const,
          providerReceiptDigest: HASH_B,
        }),
      ),
    );
  }

  public register(): Promise<Result<FineTuningProviderReceipt, StoryCoreError>> {
    return Promise.resolve(ok(Object.freeze({ providerReceiptDigest: HASH_A })));
  }

  public deploy(): Promise<Result<FineTuningProviderReceipt, StoryCoreError>> {
    return Promise.resolve(ok(Object.freeze({ providerReceiptDigest: HASH_B })));
  }

  public rollback(): Promise<Result<FineTuningProviderReceipt, StoryCoreError>> {
    return Promise.resolve(ok(Object.freeze({ providerReceiptDigest: HASH_A })));
  }

  public revoke(): Promise<Result<FineTuningProviderReceipt, StoryCoreError>> {
    return Promise.resolve(ok(Object.freeze({ providerReceiptDigest: HASH_B })));
  }
}

class CryptoContentHasher implements ContentHasher {
  public sha256(content: string) {
    const parsed = parseContentChecksum(createHash("sha256").update(content, "utf8").digest("hex"));
    if (!parsed.ok) throw parsed.error;
    return Promise.resolve(ok(parsed.value));
  }
}

class SequenceIds implements UuidV7Generator {
  private current: number;

  public constructor(start: number) {
    this.current = start;
  }

  public next(): ReturnType<UuidV7Generator["next"]> {
    const value = uuid(this.current);
    this.current += 1;
    return value;
  }
}

class AdvancingClock implements Clock {
  private current: number;

  public constructor(start: string) {
    this.current = Date.parse(start);
  }

  public now(): ReturnType<Clock["now"]> {
    const value = new Date(this.current).toISOString();
    this.current += 1_000;
    return value;
  }
}

function trainingInput(datasetId: string) {
  return {
    projectId: PROJECT_ID,
    datasetId,
    actorId: ACTOR_ID,
    maximumAttempts: 2,
    baseModel: {
      providerId: "ollama_local",
      modelId: "qwen2.5:7b",
      revision: "sha256-base",
      licenseId: "apache_2_0",
      licenseVersion: "2.0",
      fineTuningAllowed: true,
      commercialUseAllowed: true,
      redistributionAllowed: true,
      humanConfirmed: true,
    },
    method: "lora" as const,
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
  };
}

function createExecutor(executors: NodeSqliteExecutor[]): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(migration);
  executors.push(executor);
  executor.database
    .prepare(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, '微调运行时项目', 'active', 1, 0, ?, ?)`,
    )
    .run(PROJECT_ID, START, START);
  return executor;
}

function seedChapterSources(executor: NodeSqliteExecutor): void {
  const contents = [
    "雨落长街，旅人收起旧伞，决定在黎明前离城。",
    "城门钟声响了三次，守卫才发现通行文书上的暗记。",
    "她没有拔剑，只把那封未寄出的信放在桌上。",
    "风从山口掠过，旧旗在暮色里发出轻响。",
  ];
  executor.database.exec("BEGIN IMMEDIATE");
  try {
    contents.forEach((content, index) => {
      const chapterId = uuid(100 + index);
      const versionId = uuid(200 + index);
      executor.database
        .prepare(
          `INSERT INTO chapters (
             id, project_id, title, content, status, revision,
             current_version_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        )
        .run(chapterId, PROJECT_ID, `第 ${String(index + 1)} 章`, content, versionId, START, START);
      executor.database
        .prepare(
          `INSERT INTO chapter_versions (
             id, project_id, chapter_id, parent_version_id, sequence,
             content, content_checksum, reason, source_candidate_id, created_at
           ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'manual', NULL, ?)`,
        )
        .run(
          versionId,
          PROJECT_ID,
          chapterId,
          content,
          createHash("sha256").update(content, "utf8").digest("hex"),
          START,
        );
    });
    executor.database.exec("COMMIT");
  } catch (error: unknown) {
    executor.database.exec("ROLLBACK");
    throw error;
  }
}

function seedBlockedMaterial(executor: NodeSqliteExecutor): void {
  const snapshot = {
    id: uuid(300),
    projectId: PROJECT_ID,
    title: "授权未知的网络摘录",
    sourceName: "未知来源",
    author: null,
    sourceUrl: null,
    license: "permission_unknown",
    permissions: {
      rightsBasis: "尚未确认原作者或训练许可。",
      rightsConfirmedAt: null,
      allowGeneration: false,
      allowTraining: false,
    },
    tags: [],
    summary: "待治理",
    body: "这段素材的训练授权尚未确认。",
    contentFingerprint: HASH_A,
    status: "active",
    mergedIntoId: null,
    deletedAt: null,
    retentionUntil: null,
    dispositionReferenceCount: null,
    revision: 1,
    createdAt: START,
    updatedAt: START,
  };
  executor.database
    .prepare(
      `INSERT INTO story_materials (
         id, project_id, status, license, rights_confirmed,
         allow_generation, allow_training, content_fingerprint, revision,
         merged_into_id, deleted_at, retention_until,
         disposition_reference_count, created_at, updated_at, snapshot_json
       ) VALUES (?, ?, 'active', 'permission_unknown', 0, 0, 0, ?, 1,
                 NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(uuid(300), PROJECT_ID, HASH_A, START, START, JSON.stringify(snapshot));
}

async function expectOk<Value>(promise: Promise<Result<Value, StoryCoreError>>): Promise<Value> {
  const result = await promise;
  if (!result.ok) throw result.error;
  return result.value;
}

function uuid(value: number): string {
  return `019fa029-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function readWorkspaceFile(...segments: string[]): string {
  const workspaceRoot = [process.cwd(), path.resolve(process.cwd(), "..", "..")].find((candidate) =>
    existsSync(path.join(candidate, "packages", "data", "migrations", "0001_core.sql")),
  );
  if (workspaceRoot === undefined) {
    throw new Error("Unable to locate the InkShadow workspace root.");
  }
  return readFileSync(path.resolve(workspaceRoot, ...segments), "utf8");
}
