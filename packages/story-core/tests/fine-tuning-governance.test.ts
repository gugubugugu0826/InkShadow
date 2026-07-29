import { describe, expect, it } from "vitest";

import {
  approveFineTuningDataset,
  assertFineTuningJobTransition,
  createFineTuningDataset,
  createFineTuningTrainingPlan,
  evaluateFineTuningCandidate,
  runFineTuningTrainingPreflight,
  scanFineTuningPrivacy,
  type FineTuningDatasetSnapshot,
  type FineTuningSampleDraft,
} from "../src/index.js";

const ids = {
  dataset: "019fa028-0000-7000-8000-000000000001",
  project: "019fa028-0000-7000-8000-000000000002",
  approval: "019fa028-0000-7000-8000-000000000003",
  samples: [
    "019fa028-0000-7000-8000-000000000011",
    "019fa028-0000-7000-8000-000000000012",
    "019fa028-0000-7000-8000-000000000013",
    "019fa028-0000-7000-8000-000000000014",
  ],
  sources: [
    "019fa028-0000-7000-8000-000000000021",
    "019fa028-0000-7000-8000-000000000022",
    "019fa028-0000-7000-8000-000000000023",
    "019fa028-0000-7000-8000-000000000024",
  ],
} as const;

const now = "2026-07-28T12:00:00.000Z";

describe("fine-tuning data governance", () => {
  it("hashes local samples, excludes exact duplicates, and splits deterministically", async () => {
    const first = await createFineTuningDataset(datasetInput());
    const second = await createFineTuningDataset(datasetInput());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.manifestHash).toBe(second.value.manifestHash);
    expect(first.value.state).toBe("review_required");
    expect(first.value.includedSampleCount).toBe(3);
    expect(first.value.duplicateSampleCount).toBe(1);
    expect(first.value.splitCounts).toEqual({ train: 1, validation: 1, test: 1 });
    expect(
      first.value.samples.map(({ contentHash, duplicateOfSampleId, split }) => ({
        contentHash,
        duplicateOfSampleId,
        split,
      })),
    ).toEqual(
      second.value.samples.map(({ contentHash, duplicateOfSampleId, split }) => ({
        contentHash,
        duplicateOfSampleId,
        split,
      })),
    );
    const duplicate = first.value.samples[3];
    expect(duplicate).toMatchObject({
      split: "excluded",
      duplicateOfSampleId: ids.samples[0],
    });
  });

  it("fails closed when PII, credentials, or training rights are not clean", async () => {
    const scan = scanFineTuningPrivacy(
      "联系 author@example.com，手机 13800138000，api_key=private-secret-value。",
    );
    expect(scan).toMatchObject({
      passed: false,
      piiFindingCount: 2,
      sensitiveFindingCount: 1,
    });
    expect(scan.findings.map(({ category }) => category)).toEqual(["email", "phone", "credential"]);

    const unsafe = await createFineTuningDataset({
      ...datasetInput(),
      samples: datasetInput().samples.map((sample, index) =>
        index === 0
          ? {
              ...sample,
              content: "人物设定。联系 author@example.com。",
              rights: { ...sample.rights, allowTraining: false },
            }
          : sample,
      ),
    });
    expect(unsafe.ok).toBe(true);
    if (!unsafe.ok) return;
    expect(unsafe.value.state).toBe("draft");
    expect(unsafe.value.readinessIssues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["FINE_TUNING_TRAINING_NOT_ALLOWED", "FINE_TUNING_PRIVACY_BLOCKED"]),
    );
  });

  it("binds explicit human approval to the exact dataset revision and manifest", async () => {
    const dataset = await requireDataset();
    const missingHuman = approveFineTuningDataset(dataset, {
      approvalId: ids.approval,
      actorId: "local_owner",
      expectedRevision: dataset.revision,
      expectedManifestHash: dataset.manifestHash,
      privacyReviewed: true,
      copyrightReviewed: true,
      trainingPurposeConfirmed: true,
      humanConfirmed: false,
      now,
    });
    expect(missingHuman).toMatchObject({
      ok: false,
      error: { code: "FINE_TUNING_HUMAN_APPROVAL_REQUIRED" },
    });

    const stale = approveFineTuningDataset(dataset, {
      approvalId: ids.approval,
      actorId: "local_owner",
      expectedRevision: dataset.revision,
      expectedManifestHash: "f".repeat(64),
      privacyReviewed: true,
      copyrightReviewed: true,
      trainingPurposeConfirmed: true,
      humanConfirmed: true,
      now,
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "FINE_TUNING_DATASET_CHANGED", retryable: true },
    });

    const approved = approveDataset(dataset);
    expect(approved.dataset).toMatchObject({
      state: "approved",
      revision: 2,
      approvedBy: "local_owner",
    });
    expect(approved.approval).toMatchObject({
      datasetRevision: 1,
      manifestHash: dataset.manifestHash,
      privacyReviewed: true,
      copyrightReviewed: true,
      trainingPurposeConfirmed: true,
    });
  });
});

describe("fine-tuning execution and model governance", () => {
  it("permits a bounded local plan but blocks remote training without policy and authorization", async () => {
    const dataset = approveDataset(await requireDataset()).dataset;
    const localPlan = await createPlan(dataset, "local");
    expect(localPlan.ok).toBe(true);
    if (!localPlan.ok) return;

    const allowed = runFineTuningTrainingPreflight({
      featureEnabled: true,
      providerAvailable: true,
      remoteTrainingAuthorized: false,
      dataset,
      plan: localPlan.value,
      policy: policy(),
      usage: { activeJobs: 0, spentMicros: 10_000, reservedMicros: 0 },
    });
    expect(allowed.ready).toBe(true);
    expect(allowed.reservedCostMicros).toBe(200_000);
    expect(allowed.costSemantics).toBe("maximum_reservation_not_provider_bill");

    const remotePlan = await createPlan(dataset, "remote");
    expect(remotePlan.ok).toBe(true);
    if (!remotePlan.ok) return;
    const blocked = runFineTuningTrainingPreflight({
      featureEnabled: true,
      providerAvailable: true,
      remoteTrainingAuthorized: false,
      dataset,
      plan: remotePlan.value,
      policy: policy(),
      usage: { activeJobs: 0, spentMicros: 0, reservedMicros: 0 },
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.checks.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "FINE_TUNING_REMOTE_AUTHORIZATION_REQUIRED",
        "FINE_TUNING_REMOTE_POLICY_BLOCKED",
      ]),
    );
  });

  it("enforces durable job state transitions and a baseline-versus-candidate evaluation gate", () => {
    expect(assertFineTuningJobTransition("queued", "running")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(assertFineTuningJobTransition("queued", "artifact_ready")).toMatchObject({
      ok: false,
      error: { code: "FINE_TUNING_INVALID_TRANSITION" },
    });

    const gate = evaluateFineTuningCandidate({
      baselineModelId: "qwen2.5-7b",
      candidateArtifactId: "adapter-001",
      baseline: [
        { name: "style_fidelity", score: 0.7 },
        { name: "memorization_risk", score: 0.02 },
        { name: "safety", score: 0.95 },
      ],
      candidate: [
        { name: "style_fidelity", score: 0.82 },
        { name: "memorization_risk", score: 0.04 },
        { name: "safety", score: 0.94 },
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
          maximumRegression: 0.03,
        },
        {
          metric: "safety",
          direction: "higher_is_better",
          minimumCandidate: 0.93,
          maximumRegression: 0.03,
        },
      ],
    });
    expect(gate).toMatchObject({ ok: true, value: { passed: true } });

    const failed = evaluateFineTuningCandidate({
      baselineModelId: "qwen2.5-7b",
      candidateArtifactId: "adapter-unsafe",
      baseline: [{ name: "memorization_risk", score: 0.02 }],
      candidate: [{ name: "memorization_risk", score: 0.2 }],
      rules: [
        {
          metric: "memorization_risk",
          direction: "lower_is_better",
          maximumCandidate: 0.05,
          maximumRegression: 0.02,
        },
      ],
    });
    expect(failed).toMatchObject({
      ok: true,
      value: {
        passed: false,
        observations: [
          {
            reasons: expect.arrayContaining([
              "candidate_above_maximum",
              "regression_above_maximum",
            ]),
          },
        ],
      },
    });
  });
});

function datasetInput(): {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly samples: readonly FineTuningSampleDraft[];
  readonly splitPolicy: {
    readonly seed: string;
    readonly trainParts: number;
    readonly validationParts: number;
    readonly testParts: number;
  };
  readonly createdBy: string;
  readonly now: string;
} {
  const contents = [
    "雨落长街，旅人收起旧伞，决定在黎明前离城。",
    "城门钟声响了三次，守卫才发现通行文书上的暗记。",
    "她没有拔剑，只把那封未寄出的信放在桌上。",
    "雨落长街，旅人收起旧伞，决定在黎明前离城。",
  ] as const;
  return {
    id: ids.dataset,
    projectId: ids.project,
    name: "自有武侠风格样本",
    samples: contents.map((content, index) => ({
      id: ids.samples[index] ?? "",
      source: {
        kind: "material" as const,
        projectId: ids.project,
        entityId: ids.sources[index] ?? "",
        entityRevision: 1,
        label: `素材 ${String(index + 1)}`,
      },
      content,
      rights: {
        kind: "user_owned" as const,
        basis: "作者确认这是其本人创作且仅用于本机微调。",
        confirmedAt: now,
        allowTraining: true,
      },
    })),
    splitPolicy: {
      seed: "dataset_split_v1",
      trainParts: 8,
      validationParts: 1,
      testParts: 1,
    },
    createdBy: "local_owner",
    now,
  };
}

async function requireDataset(): Promise<FineTuningDatasetSnapshot> {
  const dataset = await createFineTuningDataset(datasetInput());
  if (!dataset.ok) {
    throw dataset.error;
  }
  return dataset.value;
}

function approveDataset(dataset: FineTuningDatasetSnapshot) {
  const approved = approveFineTuningDataset(dataset, {
    approvalId: ids.approval,
    actorId: "local_owner",
    expectedRevision: dataset.revision,
    expectedManifestHash: dataset.manifestHash,
    privacyReviewed: true,
    copyrightReviewed: true,
    trainingPurposeConfirmed: true,
    humanConfirmed: true,
    now,
  });
  if (!approved.ok) {
    throw approved.error;
  }
  return approved.value;
}

async function createPlan(dataset: FineTuningDatasetSnapshot, location: "local" | "remote") {
  return createFineTuningTrainingPlan({
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
        confirmedAt: now,
      },
    },
    provider: {
      location,
      providerId: location === "local" ? "local_trainer" : "remote_trainer",
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
      maximumDurationMs: 60 * 60 * 1_000,
      maximumCostMicros: 200_000,
      estimatedCostMicros: 100_000,
      estimatedGpuMinutes: 45,
      currency: "USD",
    },
  });
}

function policy() {
  return {
    allowRemoteTraining: false,
    maximumDatasetBytes: 10_000_000,
    maximumConcurrentJobs: 1,
    maximumSingleJobCostMicros: 500_000,
    monthlyCostLimitMicros: 1_000_000,
    currency: "USD",
  } as const;
}
