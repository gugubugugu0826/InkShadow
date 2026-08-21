import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outline } from "@inkshadow/story-core";
import { describe, expect, it, vi } from "vitest";

import type { StoryPlanningCandidate } from "../infrastructure/story-planning-candidate-store";
import { StoryPlanningPanel, type StoryPlanningPanelProps } from "./story-planning-panel";

const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:01:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const BOOK_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000003";

describe("StoryPlanningPanel", () => {
  it("cancels a prepared planning action without generating", async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    const service = planningService({ generate });
    renderPanel(service);
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "查看故事方向发送信息" }));
    await user.click(screen.getByRole("button", { name: "取消，不调用" }));

    expect(generate).not.toHaveBeenCalled();
    expect(screen.queryByText("确认后会调用 1 次")).not.toBeInTheDocument();
  });

  it("states explicitly that no AI ran when the route is missing", async () => {
    const user = userEvent.setup();
    const generate = vi.fn(() =>
      Promise.resolve({
        status: "skipped" as const,
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
        message: "请先为大纲规划配置 AI 分工。",
      }),
    );
    const service = planningService({ generate });
    renderPanel(service);
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalledWith(PROJECT_ID, 20));

    await confirmStoryPlanning(user);

    expect(await screen.findByText("本次没有调用 AI")).toBeInTheDocument();
    expect(screen.getByText("请先为大纲规划配置 AI 分工。")).toBeInTheDocument();
    expect(screen.queryByText(/MODEL_HUB_ROUTE_NOT_CONFIGURED/u)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("AI 剧情规划建议版本")).not.toBeInTheDocument();
  });

  it("creates a review candidate, requires edits to be saved, then explicitly replaces only the target synopsis", async () => {
    const user = userEvent.setup();
    const generated = candidate();
    const saved = {
      ...generated,
      editableSynopsis: "作者修改后的方向",
      revision: 2,
      updatedAt: LATER,
    };
    const accepted = {
      ...saved,
      status: "accepted" as const,
      acceptedOutlineRevision: 2,
      revision: 3,
      updatedAt: LATER,
      decidedAt: LATER,
    };
    const updateCandidate = vi.fn(() => Promise.resolve(saved));
    const acceptCandidate = vi.fn(() =>
      Promise.resolve({
        candidate: accepted,
        outlineRevision: 2,
        recoveredAfterInterruptedRecording: false,
      }),
    );
    const service = planningService({
      generate: vi.fn(() =>
        Promise.resolve({ status: "completed" as const, candidate: generated }),
      ),
      updateCandidate,
      acceptCandidate,
    });
    const onOutlineChanged = vi.fn();
    renderPanel(service, onOutlineChanged);
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalled());

    await confirmStoryPlanning(user);
    expect(await screen.findByText("已生成待审阅建议")).toBeInTheDocument();
    expect(screen.getByText(/正式大纲和正文都没有改变/u)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(generated.invocationId);
    expect(document.body).not.toHaveTextContent(generated.providerKind);
    expect(screen.getByText(/本次模型结果已记录，可在调用与费用中核对/u)).toBeVisible();

    const decisionSurface = screen.getByLabelText(`${generated.targetNodeTitle}的规划建议草稿决策`);
    expect(decisionSurface).toHaveClass("candidate-decision-surface");
    expect(
      within(decisionSurface).getByLabelText(`${generated.targetNodeTitle}的规划建议草稿内容`),
    ).toHaveAttribute("tabindex", "0");
    expect(decisionSurface.querySelector(":scope > .ink-card__footer")).toHaveClass(
      "candidate-decision-actions",
    );

    const editor = screen.getByRole("textbox", {
      name: new RegExp(
        `^整体替换“${generated.targetNodeTitle}”简介的规划建议草稿内容(?:可选)?$`,
        "u",
      ),
    });
    await user.clear(editor);
    await user.type(editor, "作者修改后的方向");
    const acceptButton = screen.getByRole("button", {
      name: `采纳并替换“${generated.targetNodeTitle}”的简介`,
    });
    expect(acceptButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "保存对建议的修改" }));
    await waitFor(() =>
      expect(updateCandidate).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        editableSynopsis: "作者修改后的方向",
      }),
    );
    expect(acceptButton).toBeEnabled();

    await user.click(acceptButton);
    await waitFor(() =>
      expect(acceptCandidate).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        expectedRevision: 2,
      }),
    );
    expect(onOutlineChanged).toHaveBeenCalledOnce();
    expect(await screen.findByText("建议已采纳")).toBeInTheDocument();
    expect(screen.getByText(/正文、人物设定和世界规则都没有被修改/u)).toBeInTheDocument();
  });

  it("shows the current synopsis and accepts only checked immutable planning rows", async () => {
    const user = userEvent.setup();
    const review = candidate();
    const accepted = {
      ...review,
      status: "accepted" as const,
      acceptedOutlineRevision: 2,
      acceptedItemIds: ["beat:0"],
      revision: 2,
      updatedAt: LATER,
      decidedAt: LATER,
    };
    const acceptCandidateItems = vi.fn(() =>
      Promise.resolve({
        candidate: accepted,
        outlineRevision: 2,
        recoveredAfterInterruptedRecording: false,
        acceptedItemIds: ["beat:0"],
        idempotent: false,
      }),
    );
    const onOutlineChanged = vi.fn();
    const service = planningService({
      listCandidates: vi.fn(() => Promise.resolve([review])),
      acceptCandidateItems,
    });
    renderPanel(service, onOutlineChanged);

    expect(await screen.findByText("原始故事方向")).toBeInTheDocument();
    const selectedBeat = screen.getByRole("checkbox", { name: /剧情节点 1：同行/u });
    await user.click(selectedBeat);
    expect(screen.getByRole("checkbox", { name: /故事方向/u })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "采纳已选 1 项并保留当前简介" }));

    await waitFor(() =>
      expect(acceptCandidateItems).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    );
    expect(onOutlineChanged).toHaveBeenCalledOnce();
    expect(await screen.findByText("已采纳所选规划条目")).toBeInTheDocument();
    expect(screen.getByText(/未选内容、正文和故事设定均未修改/u)).toBeInTheDocument();
  });

  it("restores the persisted applying selection and disables conflicting review actions", async () => {
    const user = userEvent.setup();
    const review = candidate();
    const applying = {
      ...review,
      revision: 2,
      selectiveAcceptanceIntent: {
        schemaVersion: 1 as const,
        selectedItemIds: ["beat:0"],
        selectionSha256: "a".repeat(64),
        baselineOutlineRevision: 1,
        baselineSynopsisSha256: "b".repeat(64),
        proposedSynopsisSha256: "c".repeat(64),
        startedAt: LATER,
      },
    };
    const accepted = {
      ...applying,
      status: "accepted" as const,
      acceptedOutlineRevision: 2,
      acceptedItemIds: ["beat:0"],
      selectiveAcceptanceIntent: null,
      revision: 3,
      decidedAt: LATER,
    };
    const acceptCandidateItems = vi.fn(() =>
      Promise.resolve({
        candidate: accepted,
        outlineRevision: 2,
        recoveredAfterInterruptedRecording: true,
        acceptedItemIds: ["beat:0"],
        idempotent: false,
      }),
    );
    const service = planningService({
      listCandidates: vi.fn(() => Promise.resolve([applying])),
      acceptCandidateItems,
    });
    renderPanel(service);

    expect(await screen.findByText("上次逐项采纳尚未完成")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /剧情节点 1：同行/u })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /剧情节点 1：同行/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存对建议的修改" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: `采纳并替换“${review.targetNodeTitle}”的简介` }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝这份建议" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "恢复上次逐项采纳" }));
    await waitFor(() =>
      expect(acceptCandidateItems).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        expectedRevision: 2,
        selectedItemIds: ["beat:0"],
      }),
    );
  });

  it("rejects one candidate without calling the outline refresh path", async () => {
    const user = userEvent.setup();
    const review = candidate();
    const rejected = {
      ...review,
      status: "rejected" as const,
      revision: 2,
      updatedAt: LATER,
      decidedAt: LATER,
    };
    const rejectCandidate = vi.fn(() => Promise.resolve(rejected));
    const service = planningService({
      listCandidates: vi.fn(() => Promise.resolve([review])),
      rejectCandidate,
    });
    const onOutlineChanged = vi.fn();
    renderPanel(service, onOutlineChanged);

    const heading = await screen.findByRole("heading", {
      name: `故事方向建议：${review.targetNodeTitle}`,
    });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) {
      throw new Error("expected planning candidate card");
    }
    await user.click(within(card).getByRole("button", { name: "拒绝这份建议" }));

    await waitFor(() =>
      expect(rejectCandidate).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
      }),
    );
    expect(onOutlineChanged).not.toHaveBeenCalled();
    expect(await screen.findByText("建议已拒绝")).toBeInTheDocument();
    expect(screen.getByText("正式大纲和正文没有改变。")).toBeInTheDocument();
  });
});

function renderPanel(
  service: StoryPlanningPanelProps["service"],
  onOutlineChanged: StoryPlanningPanelProps["onOutlineChanged"] = vi.fn(),
) {
  return render(
    <StoryPlanningPanel
      projectId={PROJECT_ID}
      outline={outline()}
      service={service}
      onOutlineChanged={onOutlineChanged}
    />,
  );
}

function planningService(
  overrides: Partial<StoryPlanningPanelProps["service"]> = {},
): StoryPlanningPanelProps["service"] {
  return {
    listCandidates: vi.fn(() => Promise.resolve([])),
    prepareGeneration: vi.fn(() =>
      Promise.resolve({
        fingerprint: "a".repeat(64),
        task: "outline_planning" as const,
        targetTitle: "雨夜车站",
        connectionDisplayName: "我的写作服务",
        modelId: "planning-model",
        dataDestination: "remote" as const,
        privacy: "规划资料会发送到所选 AI 服务。",
        sends: ["当前正式大纲", "已确认设定", "有证据的主线事件"],
        maximumProviderCalls: 1 as const,
        automaticRetryCount: 0 as const,
        estimatedMaximumCostMicros: null,
        currency: null,
      }),
    ),
    generate: vi.fn(() =>
      Promise.resolve({
        status: "skipped" as const,
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
        message: "尚未配置。",
      }),
    ),
    updateCandidate: vi.fn(() => Promise.reject(new Error("unexpected update"))),
    acceptCandidate: vi.fn(() => Promise.reject(new Error("unexpected acceptance"))),
    acceptCandidateItems: vi.fn(() => Promise.reject(new Error("unexpected selective acceptance"))),
    rejectCandidate: vi.fn(() => Promise.reject(new Error("unexpected rejection"))),
    ...overrides,
  };
}

async function confirmStoryPlanning(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "查看故事方向发送信息" }));
  expect(screen.getByText(/我的写作服务 · planning-model/u)).toBeInTheDocument();
  expect(screen.getByText(/自动重试 0 次/u)).toBeInTheDocument();
  expect(screen.getByText(/当前无法核定费用上限/u)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "确认并生成故事方向建议" }));
}

function outline(): Outline {
  const result = Outline.create({
    projectId: PROJECT_ID,
    bookId: BOOK_ID,
    title: "雨夜车站",
    synopsis: "原始故事方向",
    now: NOW,
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function candidate(): StoryPlanningCandidate {
  return {
    id: CANDIDATE_ID,
    projectId: PROJECT_ID,
    task: "outline_planning",
    targetNodeId: BOOK_ID,
    targetNodeTitle: "雨夜车站",
    baselineOutlineRevision: 1,
    baselineTargetSynopsis: "原始故事方向",
    status: "review",
    payload: {
      schemaVersion: 1,
      task: "outline_planning",
      title: "雨夜之后",
      direction: "两人从误会走向共同选择",
      beats: [{ title: "同行", purpose: "建立合作", outcome: "发现共同目标" }],
      constraintsApplied: ["主角不会杀人"],
      openQuestions: [],
    },
    editableSynopsis: "模型生成的待审阅方向",
    context: {
      formalFactIds: ["019f9f4a-b3c7-7350-9226-000000000004"],
      lockedFactIds: ["019f9f4a-b3c7-7350-9226-000000000004"],
      causalEventIds: ["event-one"],
      causalGraphStatus: "available",
    },
    invocationId: "invocation-one",
    connectionId: "connection-one",
    catalogEntryId: "catalog-one",
    providerKind: "openai",
    modelId: "planning-model",
    usedFallback: false,
    acceptedOutlineRevision: null,
    acceptedItemIds: null,
    selectiveAcceptanceIntent: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    decidedAt: null,
  };
}
