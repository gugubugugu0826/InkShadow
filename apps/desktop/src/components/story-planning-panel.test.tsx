import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outline } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSafeOperationIncidents,
  resetSafeOperationDiagnosticsForTests,
} from "../infrastructure/safe-operation-diagnostics";
import type { StoryPlanningCandidate } from "../infrastructure/story-planning-candidate-store";
import { StoryPlanningPanel, type StoryPlanningPanelProps } from "./story-planning-panel";

const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:01:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const BOOK_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const VOLUME_ID = "019f9f4a-b3c7-7350-9226-000000000005";

describe("StoryPlanningPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSafeOperationDiagnosticsForTests();
  });

  it("offers direct structure actions instead of leaving scene planning at a dead end", async () => {
    const user = userEvent.setup();
    const onCreateVolume = vi.fn();
    const onAddChapter = vi.fn();
    const service = planningService();
    const rendered = render(
      <StoryPlanningPanel
        projectId={PROJECT_ID}
        outline={outline()}
        service={service}
        onOutlineChanged={vi.fn()}
        onCreateVolume={onCreateVolume}
        onAddChapter={onAddChapter}
      />,
    );
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText("这次想规划什么"), "scene_breakdown");

    expect(screen.getByRole("option", { name: "规划章节场景" })).toBeVisible();
    expect(screen.getByText("还没有可规划的章节")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "新建卷" }));
    expect(onCreateVolume).toHaveBeenCalledTimes(1);
    expect(onAddChapter).not.toHaveBeenCalled();

    rendered.rerender(
      <StoryPlanningPanel
        projectId={PROJECT_ID}
        outline={outlineWithVolume()}
        service={service}
        onOutlineChanged={vi.fn()}
        onCreateVolume={onCreateVolume}
        onAddChapter={onAddChapter}
      />,
    );
    await user.click(screen.getByRole("button", { name: "添加章节" }));
    expect(onAddChapter).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/创建后会留在这里继续规划章节场景/u)).toBeVisible();
  });

  it("cancels a prepared planning action without generating", async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    const service = planningService({ generate });
    renderPanel(service);
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "查看发送前说明" }));
    await user.click(screen.getByRole("button", { name: "取消，不发送" }));

    expect(generate).not.toHaveBeenCalled();
    expect(screen.queryByText("确认后会发送 1 次")).not.toBeInTheDocument();
  });

  it("shows normal sending information when the current plan is empty", async () => {
    const emptyOutline = Outline.create({
      projectId: PROJECT_ID,
      bookId: BOOK_ID,
      title: "雨夜车站",
      synopsis: "",
      now: NOW,
    });
    if (!emptyOutline.ok) throw emptyOutline.error;
    const user = userEvent.setup();
    const generate = vi.fn();
    const service = planningService({ generate });
    render(
      <StoryPlanningPanel
        projectId={PROJECT_ID}
        outline={emptyOutline.value}
        service={service}
        onOutlineChanged={vi.fn()}
      />,
    );
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "查看发送前说明" }));

    expect(screen.getByText("发送确认摘要")).toBeVisible();
    expect(screen.getByText(/我的写作服务 · planning-model/u)).toBeVisible();
    const detailsSummary = screen.getByText("查看详细信息");
    expect(detailsSummary).toBeVisible();
    const details = detailsSummary.closest("details");
    if (!(details instanceof HTMLElement)) throw new Error("规划发送信息缺少展开详情。 ");
    expect(within(details).getByText(/自动重试 0 次/u)).not.toBeVisible();
    await user.click(detailsSummary);
    expect(within(details).getByText(/自动重试 0 次/u)).toBeVisible();
    expect(screen.queryByText("AI 剧情规划未完成")).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
  });

  it("shows an exact unsent preparation failure with a stable support number", async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    const preparationFailure = Object.assign(new Error("private provider detail"), {
      code: "MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED",
    });
    const service = planningService({
      prepareGeneration: vi.fn(() => Promise.reject(preparationFailure)),
      generate,
    });
    renderPanel(service);
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "查看发送前说明" }));

    expect(await screen.findByText("故事方向发送前说明尚未准备好")).toBeVisible();
    expect(screen.getByText(/整理发送前说明时发现所选模型尚未通过规划格式检查/u)).toBeVisible();
    expect(screen.getByText(/本次没有向模型服务发送内容/u)).toBeVisible();
    expect(screen.getByText(/问题编号：墨影-.*联系支持时提供/u)).toBeVisible();
    expect(screen.queryByText("AI 剧情规划未完成")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED");
    expect(document.body).not.toHaveTextContent("private provider detail");
    expect(generate).not.toHaveBeenCalled();
  });

  it("states explicitly that no AI ran when the route is missing", async () => {
    const user = userEvent.setup();
    const generate = vi.fn(() =>
      Promise.resolve({
        status: "skipped" as const,
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
        message: "请先为大纲规划配置创作任务安排。",
      }),
    );
    const service = planningService({ generate });
    renderPanel(service);
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalledWith(PROJECT_ID, 20));

    await confirmStoryPlanning(user);

    expect(await screen.findByText("本次没有调用 AI")).toBeInTheDocument();
    expect(screen.getByText("请先为大纲规划配置创作任务安排。")).toBeInTheDocument();
    expect(screen.queryByText(/MODEL_HUB_ROUTE_NOT_CONFIGURED/u)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("AI 剧情规划建议版本")).not.toBeInTheDocument();
    expect(readSafeOperationIncidents()[0]).toMatchObject({
      stage: "pre_dispatch_check",
      dispatched: false,
    });
  });

  it("records a post-dispatch candidate save failure at the result persistence stage", async () => {
    const user = userEvent.setup();
    const failure = Object.assign(new Error("candidate storage failed"), {
      code: "STORY_PLANNING_RESULT_PERSIST_FAILED",
      dispatched: true,
      planningStage: "persist_result",
    });
    const service = planningService({
      generate: vi.fn(() => Promise.reject(failure)),
    });
    renderPanel(service);
    await waitFor(() => expect(service.listCandidates).toHaveBeenCalled());

    await confirmStoryPlanning(user);

    expect(await screen.findByText("故事方向结果尚未保存")).toBeVisible();
    expect(screen.getByText(/模型结果已经返回，但待审阅建议没有安全保存/u)).toBeVisible();
    expect(screen.getByText(/问题编号：墨影-.*联系支持时提供/u)).toBeVisible();
    expect(readSafeOperationIncidents()[0]).toMatchObject({
      stage: "persist_result",
      dispatched: true,
      normalizedErrorCode: "STORY_PLANNING_RESULT_PERSIST_FAILED",
    });
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
    expect(screen.getByText(/本次模型结果已记录，可在模型使用与费用中核对/u)).toBeVisible();

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
  await user.click(screen.getByRole("button", { name: "查看发送前说明" }));
  expect(screen.getByText(/我的写作服务 · planning-model/u)).toBeInTheDocument();
  await user.click(screen.getByText("查看详细信息"));
  expect(screen.getByText(/自动重试 0 次/u)).toBeInTheDocument();
  expect(
    screen.getByText(/服务商没有提供可计算的单价，实际费用请以服务商账单为准/u),
  ).toBeInTheDocument();
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

function outlineWithVolume(): Outline {
  const volume = outline().addNode({
    id: VOLUME_ID,
    kind: "volume",
    parentId: BOOK_ID,
    title: "第一卷",
    expectedRevision: 1,
    now: LATER,
  });
  if (!volume.ok) {
    throw volume.error;
  }
  return volume.value;
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
