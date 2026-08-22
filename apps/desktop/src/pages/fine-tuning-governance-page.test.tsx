import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StoryCoreError,
  err,
  ok,
  type FineTuningDatasetSnapshot,
  type FineTuningModelArtifactRecord,
} from "@inkshadow/story-core";
import { describe, expect, it, vi } from "vitest";

import {
  type FineTuningDashboard,
  type FineTuningDesktopPort,
} from "../infrastructure/fine-tuning-governance-runtime";
import { FineTuningGovernancePage } from "./fine-tuning-governance-page";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const ACTOR_ID = "local_owner";
const SOURCE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const DATASET_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const ARTIFACT_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const NOW = "2026-07-29T05:00:00.000Z";
const HASH = "a".repeat(64);

describe("FineTuningGovernancePage", () => {
  it("keeps the default-off feature from touching persistence", () => {
    const inspect = vi.fn();
    const runtime = {
      ...unavailableRuntime(),
      inspect,
    } as unknown as FineTuningDesktopPort;

    render(
      <FineTuningGovernancePage runtime={runtime} projectId={PROJECT_ID} actorId={ACTOR_ID} />,
    );

    expect(screen.getByRole("heading", { name: "微调治理（实验）" })).toBeVisible();
    expect(screen.getByText("微调治理默认关闭")).toBeVisible();
    expect(screen.getByText(/没有启动训练，也没有发送任何内容/)).toBeVisible();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("requires an explicit rights declaration before freezing chapter sources", async () => {
    const user = userEvent.setup();
    const fixture = readyRuntime({
      sources: [
        {
          id: SOURCE_ID,
          kind: "chapter_version",
          revision: 1,
          label: "第一章 · 版本 1",
          contentHash: HASH,
          contentBytes: 3_600,
          rights: null,
          rightsDeclarationRequired: true,
          status: "governance_blocked",
          blocker: "需要人工声明版权基础与训练许可。",
        },
      ],
    });

    render(
      <FineTuningGovernancePage runtime={fixture.port} projectId={PROJECT_ID} actorId={ACTOR_ID} />,
    );

    await user.click(await screen.findByRole("checkbox", { name: /第一章 · 版本 1/ }));
    await user.type(screen.getByRole("textbox", { name: "数据集名称" }), "本地风格样本");
    await user.type(
      screen.getByRole("textbox", { name: "授权依据" }),
      "作者本人原创并保留训练与商业使用权。",
    );

    const create = screen.getByRole("button", { name: "创建待审数据集" });
    expect(create).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", {
        name: "我确认所选章节或导入内容允许用于模型训练。",
      }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "我已人工核对上述版权依据，且它适用于当前精确来源版本。",
      }),
    );
    await user.click(create);

    await waitFor(() => {
      expect(fixture.createDataset).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        actorId: ACTOR_ID,
        name: "本地风格样本",
        sources: [
          {
            sourceId: SOURCE_ID,
            expectedRevision: 1,
            expectedContentHash: HASH,
            rights: {
              kind: "user_owned",
              basis: "作者本人原创并保留训练与商业使用权。",
              allowTraining: true,
              humanConfirmed: true,
            },
          },
        ],
      });
    });
    expect(await screen.findByText("操作已完成")).toBeVisible();
    expect(screen.getByText(/远端训练固定关闭/)).toBeVisible();
  });

  it("binds all three human checks to the exact dataset revision and manifest", async () => {
    const user = userEvent.setup();
    const dataset = datasetFixture();
    const fixture = readyRuntime({ datasets: [dataset] });

    render(
      <FineTuningGovernancePage runtime={fixture.port} projectId={PROJECT_ID} actorId={ACTOR_ID} />,
    );

    expect(await screen.findByText("待人工审批")).toBeVisible();
    const approve = screen.getByRole("button", { name: "批准当前清单版本" });
    expect(approve).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "我已核对隐私扫描与必要的源头脱敏。" }));
    await user.click(screen.getByRole("checkbox", { name: "我已核对每条来源的版权或许可依据。" }));
    await user.click(
      screen.getByRole("checkbox", {
        name: "我确认此数据集只用于已说明的本地训练目的。",
      }),
    );
    await user.click(approve);

    await waitFor(() => {
      expect(fixture.approveDataset).toHaveBeenCalledWith({
        datasetId: DATASET_ID,
        actorId: ACTOR_ID,
        expectedRevision: 1,
        expectedManifestHash: HASH,
        privacyReviewed: true,
        copyrightReviewed: true,
        trainingPurposeConfirmed: true,
        humanConfirmed: true,
      });
    });
  });

  it("never invents candidate evaluation scores when no evaluator output was imported", async () => {
    const fixture = readyRuntime({ artifacts: [artifactFixture()] });

    render(
      <FineTuningGovernancePage runtime={fixture.port} projectId={PROJECT_ID} actorId={ACTOR_ID} />,
    );

    expect(await screen.findByText("待评测候选")).toBeVisible();
    expect(screen.getByText(/页面只解析并提交，不生成默认分数/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "基线指标结构化数据" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "候选指标结构化数据" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "门禁规则结构化数据" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "重新计算并记录评测" })).toBeDisabled();
    expect(fixture.recordEvaluation).not.toHaveBeenCalled();
  });
});

function unavailableRuntime(): FineTuningDesktopPort {
  const unavailable = () =>
    Promise.resolve(
      err(
        new StoryCoreError({
          code: "FINE_TUNING_PROVIDER_UNAVAILABLE",
          message: "Fine-tuning governance is disabled.",
        }),
      ),
    );
  return {
    availability: {
      available: false,
      reason: "feature_disabled",
      persistence: "native_sqlite",
      localTrainer: { available: false, reason: "feature_unavailable" },
    },
    inspect: unavailable,
    createDataset: unavailable,
    approveDataset: unavailable,
    configurePolicy: unavailable,
    queueTraining: unavailable,
    runNextLocalJob: unavailable,
    cancelJob: unavailable,
    retryJob: unavailable,
    recoverExpiredJobs: unavailable,
    recordEvaluation: unavailable,
    approveRegistration: unavailable,
    registerArtifact: unavailable,
    approveDeployment: unavailable,
    activateDeployment: unavailable,
    rollbackDeployment: unavailable,
    revokeArtifact: unavailable,
  };
}

function readyRuntime(overrides: Partial<FineTuningDashboard> = {}): {
  readonly port: FineTuningDesktopPort;
  readonly createDataset: ReturnType<typeof vi.fn>;
  readonly approveDataset: ReturnType<typeof vi.fn>;
  readonly recordEvaluation: ReturnType<typeof vi.fn>;
} {
  const dashboard: FineTuningDashboard = {
    projectId: PROJECT_ID,
    sources: [],
    datasets: [],
    policy: null,
    jobs: [],
    recoverableJobs: [],
    artifacts: [],
    deployments: [],
    audit: [],
    ...overrides,
  };
  const inspect = vi.fn(() => Promise.resolve(ok(dashboard)));
  const createDataset = vi.fn(() => Promise.resolve(ok(datasetFixture())));
  const approveDataset = vi.fn(() =>
    Promise.resolve(ok({ ...datasetFixture(), state: "approved" as const })),
  );
  const recordEvaluation = vi.fn(() => Promise.resolve(ok(artifactFixture())));
  const unused = vi.fn(() => Promise.resolve(ok({})));
  return {
    port: {
      availability: {
        available: true,
        persistence: "native_sqlite",
        localTrainer: {
          available: false,
          reason: "local_trainer_not_configured",
        },
      },
      inspect,
      createDataset,
      approveDataset,
      configurePolicy: unused,
      queueTraining: unused,
      runNextLocalJob: unused,
      cancelJob: unused,
      retryJob: unused,
      recoverExpiredJobs: unused,
      recordEvaluation,
      approveRegistration: unused,
      registerArtifact: unused,
      approveDeployment: unused,
      activateDeployment: unused,
      rollbackDeployment: unused,
      revokeArtifact: unused,
    } as unknown as FineTuningDesktopPort,
    createDataset,
    approveDataset,
    recordEvaluation,
  };
}

function datasetFixture(): FineTuningDatasetSnapshot {
  return {
    schemaVersion: 1,
    id: DATASET_ID,
    projectId: PROJECT_ID,
    name: "本地风格样本",
    state: "review_required",
    revision: 1,
    splitPolicy: {
      seed: "fine_tuning_split_v1",
      trainParts: 8,
      validationParts: 1,
      testParts: 1,
    },
    samples: [],
    manifestHash: HASH,
    totalContentBytes: 12_000,
    includedSampleCount: 4,
    duplicateSampleCount: 0,
    splitCounts: { train: 2, validation: 1, test: 1 },
    readinessIssues: [],
    approvedBy: null,
    approvedAt: null,
    createdBy: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as FineTuningDatasetSnapshot;
}

function artifactFixture(): FineTuningModelArtifactRecord {
  return {
    id: ARTIFACT_ID,
    projectId: PROJECT_ID,
    datasetId: DATASET_ID,
    jobId: "019f9f4a-b3c7-7350-9226-000000000005",
    baseModelProviderId: "local",
    baseModelId: "inkshadow-base",
    baseModelRevision: "r1",
    artifactDigest: "b".repeat(64),
    localArtifactRef: "registry:fixture",
    state: "candidate",
    revision: 1,
    latestEvaluationId: null,
    registrationName: null,
    providerReceiptDigest: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as FineTuningModelArtifactRecord;
}
