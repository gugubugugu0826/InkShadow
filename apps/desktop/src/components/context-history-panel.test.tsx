// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ContextCompilationTrace,
  ContextCompilationTraceStore,
  ContextCompilationTraceSummary,
} from "../infrastructure/context-compilation-trace-store";
import { ContextHistoryPanel } from "./context-history-panel";

const PROJECT_ID = "019a1f9f-4ab3-7000-8000-000000000001";
const TRACE_ID = "019a1f9f-4ab3-7000-8000-000000000002";
const NEXT_PROJECT_ID = "019a1f9f-4ab3-7000-8000-000000000007";

describe("context history panel", () => {
  it("ignores a previous project's delayed history after the project changes", async () => {
    const previousTrace = makeTrace();
    const nextTrace: ContextCompilationTrace = {
      ...makeTrace(),
      id: "019a1f9f-4ab3-7000-8000-000000000008",
      projectId: NEXT_PROJECT_ID,
      taskType: "rewrite",
    };
    let resolvePrevious!: (summaries: readonly ContextCompilationTraceSummary[]) => void;
    const previousHistory = new Promise<readonly ContextCompilationTraceSummary[]>((resolve) => {
      resolvePrevious = resolve;
    });
    const listByProjectId = vi.fn((projectId: string) =>
      projectId === PROJECT_ID ? previousHistory : Promise.resolve([makeSummary(nextTrace)]),
    );
    const store = makeStore({ listByProjectId });
    const novelSkills = makeUnavailableNovelSkills();

    const view = render(
      <ContextHistoryPanel projectId={PROJECT_ID} store={store} novelSkills={novelSkills} />,
    );
    await waitFor(() => expect(listByProjectId).toHaveBeenCalledWith(PROJECT_ID, 50));

    view.rerender(
      <ContextHistoryPanel projectId={NEXT_PROJECT_ID} store={store} novelSkills={novelSkills} />,
    );
    expect(await screen.findByText("改写")).toBeTruthy();

    resolvePrevious([makeSummary(previousTrace)]);
    await waitFor(() => expect(screen.queryByText("继续创作")).toBeNull());
    expect(screen.getByText("改写")).toBeTruthy();
  });

  it("ignores a delayed detail response after the project changes", async () => {
    const user = userEvent.setup();
    const previousTrace = makeTrace();
    let resolvePrevious!: (trace: ContextCompilationTrace | null) => void;
    const previousDetail = new Promise<ContextCompilationTrace | null>((resolve) => {
      resolvePrevious = resolve;
    });
    const store = makeStore({
      listByProjectId: vi.fn((projectId: string) =>
        Promise.resolve(projectId === PROJECT_ID ? [makeSummary(previousTrace)] : []),
      ),
      findById: vi.fn(() => previousDetail),
    });
    const novelSkills = makeUnavailableNovelSkills();

    const view = render(
      <ContextHistoryPanel projectId={PROJECT_ID} store={store} novelSkills={novelSkills} />,
    );
    await user.click(await screen.findByRole("button", { name: "查看采用与舍弃原因" }));

    view.rerender(
      <ContextHistoryPanel projectId={NEXT_PROJECT_ID} store={store} novelSkills={novelSkills} />,
    );
    expect(await screen.findByText("还没有上下文记录")).toBeTruthy();

    resolvePrevious(previousTrace);
    await waitFor(() => expect(screen.queryByText("本次资料选择明细")).toBeNull());
    expect(screen.getByText("还没有上下文记录")).toBeTruthy();
  });

  it("shows content-free selection history and loads the exact trace on demand", async () => {
    const user = userEvent.setup();
    const trace = makeTrace();
    const findById = vi.fn(() => Promise.resolve(trace));
    const store: ContextCompilationTraceStore = {
      save: vi.fn(() => Promise.resolve()),
      linkModelInvocation: vi.fn(() => Promise.resolve()),
      linkOutputCandidate: vi.fn(() => Promise.resolve()),
      listByProjectId: vi.fn(() =>
        Promise.resolve([
          {
            id: trace.id,
            projectId: trace.projectId,
            chapterId: trace.chapterId,
            taskType: trace.taskType,
            maximumContextTokens: trace.maximumContextTokens,
            requiredTokens: trace.requiredTokens,
            usedTokens: trace.usedTokens,
            remainingTokens: trace.remainingTokens,
            discardedTokens: trace.discardedTokens,
            tokenEstimateSource: trace.tokenEstimateSource,
            candidateCount: 2,
            includedCount: 1,
            discardedCount: 1,
            createdAt: trace.createdAt,
            execution: trace.execution,
            outputCandidateId: trace.outputCandidateId,
          },
        ]),
      ),
      findById,
      findByOutputCandidateId: vi.fn(() => Promise.resolve(trace)),
    };

    const novelSkills = {
      findInvocationByContextTrace: vi.fn(() =>
        Promise.resolve({
          status: "found" as const,
          availability: { status: "ready" as const, reason: null },
          invocation: {
            taskType: "continuation" as const,
            invocationMode: "draft" as const,
            maximumSkillTokens: 1_200,
            usedSkillTokens: 320,
            createdAt: trace.createdAt,
            methods: [
              {
                displayName: "场景推进",
                summary: "让场景围绕目标和变化前进。",
                version: "1.0.0",
                kind: "core" as const,
                ownerScope: "builtin" as const,
                included: true,
                selectionReason: "selected" as const,
                estimatedTokens: 320,
              },
              {
                displayName: "悬疑与推理",
                summary: "管理线索与揭示。",
                version: "1.0.0",
                kind: "genre" as const,
                ownerScope: "builtin" as const,
                included: false,
                selectionReason: "not_enabled" as const,
                estimatedTokens: 260,
              },
            ],
          },
        }),
      ),
    };

    render(<ContextHistoryPanel projectId={PROJECT_ID} store={store} novelSkills={novelSkills} />);

    expect(await screen.findByText("继续创作")).toBeTruthy();
    expect(screen.getByText(/记录不保存正文、提示词或模型回复/u)).toBeTruthy();
    expect(screen.queryByText("不应出现在审计记录里的正文")).toBeNull();
    await user.click(screen.getByRole("button", { name: "查看采用与舍弃原因" }));

    expect(await screen.findByText("本次资料选择明细")).toBeTruthy();
    expect(screen.getByText("锁定的故事规则")).toBeTruthy();
    expect(screen.getByText("当前场景目标")).toBeTruthy();
    expect(screen.getAllByText("已采用").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("未采用")).toBeTruthy();
    expect(screen.getByText(/可参考文字量已用完/u)).toBeTruthy();
    expect(screen.getByText("锁定的故事规则 · 故事规则")).toBeTruthy();
    expect(screen.getAllByText(/历史记录只保存来源类别、选择原因与文字量/u)).toHaveLength(2);
    expect(findById).toHaveBeenCalledWith(TRACE_ID);
    expect(screen.getByText("已精确关联 AI 建议版本")).toBeTruthy();
    expect(screen.getByText("这条记录与 AI 建议版本精确关联")).toBeTruthy();
    expect(screen.getByText("场景推进")).toBeTruthy();
    expect(screen.getAllByText(/版本 1.0.0/u)).toHaveLength(1);
    expect(screen.queryByText("悬疑与推理")).toBeNull();
    expect(screen.getAllByText(/发送给 AI 的文字量（不是金额）/u).length).toBeGreaterThan(0);
    await user.click(screen.getByText(/查看本次未采用的写作技能及原因/u));
    expect(screen.getByText("悬疑与推理")).toBeTruthy();
    expect(screen.getAllByText(/版本 1.0.0/u)).toHaveLength(2);
    expect(screen.getByText(/没有启用/u)).toBeTruthy();
    expect(screen.queryByText("core.scene_craft")).toBeNull();
    expect(screen.queryByText("a".repeat(64))).toBeNull();
    expect(novelSkills.findInvocationByContextTrace).toHaveBeenCalledWith(TRACE_ID);
    const sourceDetails = screen.getAllByText(/查看来源类别/u);
    expect(sourceDetails).toHaveLength(2);
    const firstSourceDetails = sourceDetails[0];
    if (firstSourceDetails === undefined) throw new Error("Expected source details.");
    await user.click(firstSourceDetails);
    expect(screen.getByText("故事规则")).toBeTruthy();
    expect(screen.queryByText("fact.1")).toBeNull();
    expect(screen.queryByText("revision.2")).toBeNull();
    expect(screen.queryByText("019a1f9f-4ab3-7000-8000-000000000006")).toBeNull();
  });

  it("projects current and unknown historical adoption reasons into natural Chinese", async () => {
    const user = userEvent.setup();
    const [baseEntry] = makeTrace().entries;
    if (baseEntry === undefined) throw new Error("Expected a baseline context entry.");
    const trace: ContextCompilationTrace = {
      ...makeTrace(),
      entries: [
        {
          ...baseEntry,
          contextCandidateId: "english-reason",
          selectionReason: "The author explicitly requested this source for the current task.",
        },
        {
          ...baseEntry,
          contextCandidateId: "unknown-reason",
          selectionReason: "legacy_internal_selection_reason",
        },
        {
          ...baseEntry,
          contextCandidateId: "locked-rule-reason",
          selectionReason:
            "The user confirmed and locked this fact, so it is a required hard constraint.",
        },
        {
          ...baseEntry,
          contextCandidateId: "project-seed-reason",
          selectionReason:
            "The author confirmed this currentDirection creation input; it remains traceable to the project seed.",
        },
        {
          ...baseEntry,
          contextCandidateId: "selection-range-reason",
          selectionReason:
            "The author explicitly selected this exact saved range and supplied a rewrite instruction.",
        },
      ],
    };
    const store = makeStore({
      listByProjectId: vi.fn(() => Promise.resolve([makeSummary(trace)])),
      findById: vi.fn(() => Promise.resolve(trace)),
    });

    render(
      <ContextHistoryPanel
        projectId={PROJECT_ID}
        store={store}
        novelSkills={makeUnavailableNovelSkills()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "查看采用与舍弃原因" }));

    expect(await screen.findByText("作者明确要求本次创作采用这项资料。")).toBeTruthy();
    expect(screen.getByText("本次创作按当前任务与资料范围采用了这项资料。")).toBeTruthy();
    expect(screen.getByText("作者已确认并锁定这项设定，因此本次创作必须遵守。")).toBeTruthy();
    expect(
      screen.getByText("作者已确认这项当前剧情方向；采用时仍可追溯到项目创作种子。"),
    ).toBeTruthy();
    expect(screen.getByText("作者明确选中了这段已保存正文，并为本次处理给出了要求。")).toBeTruthy();
    expect(screen.queryByText(/The author explicitly requested/u)).toBeNull();
    expect(screen.queryByText("legacy_internal_selection_reason")).toBeNull();
  });

  it("uses a safe explanation when an older trace contains an unknown discard reason", async () => {
    const user = userEvent.setup();
    const base = makeTrace();
    const trace: ContextCompilationTrace = {
      ...base,
      entries: base.entries.map((entry) =>
        entry.included ? entry : { ...entry, discardedReason: "raw_internal_discard_reason" },
      ),
    };
    const store = makeStore({
      listByProjectId: vi.fn(() => Promise.resolve([makeSummary(trace)])),
      findById: vi.fn(() => Promise.resolve(trace)),
    });

    render(
      <ContextHistoryPanel
        projectId={PROJECT_ID}
        store={store}
        novelSkills={makeUnavailableNovelSkills()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "查看采用与舍弃原因" }));

    expect(await screen.findByText("因其他安全规则未采用。")).toBeTruthy();
    expect(document.body).not.toHaveTextContent("raw_internal_discard_reason");
  });

  it("gives a useful empty state before the first AI creation", async () => {
    const store: ContextCompilationTraceStore = {
      save: vi.fn(() => Promise.resolve()),
      linkModelInvocation: vi.fn(() => Promise.resolve()),
      linkOutputCandidate: vi.fn(() => Promise.resolve()),
      listByProjectId: vi.fn(() => Promise.resolve([])),
      findById: vi.fn(() => Promise.resolve(null)),
      findByOutputCandidateId: vi.fn(() => Promise.resolve(null)),
    };
    render(
      <ContextHistoryPanel
        projectId={PROJECT_ID}
        store={store}
        novelSkills={{
          findInvocationByContextTrace: vi.fn(() =>
            Promise.resolve({
              status: "unavailable" as const,
              availability: {
                status: "unavailable" as const,
                reason: "浏览器演示不会生成写作技能采用记录。",
              },
              invocation: null,
            }),
          ),
        }}
      />,
    );

    expect(await screen.findByText("还没有上下文记录")).toBeTruthy();
    expect(screen.getByText(/第一次使用“继续创作”/u)).toBeTruthy();
  });

  it("keeps the story context history visible when the optional method receipt cannot be read", async () => {
    const user = userEvent.setup();
    const trace = makeTrace();
    const store: ContextCompilationTraceStore = {
      save: vi.fn(() => Promise.resolve()),
      linkModelInvocation: vi.fn(() => Promise.resolve()),
      linkOutputCandidate: vi.fn(() => Promise.resolve()),
      listByProjectId: vi.fn(() =>
        Promise.resolve([
          {
            id: trace.id,
            projectId: trace.projectId,
            chapterId: trace.chapterId,
            taskType: trace.taskType,
            maximumContextTokens: trace.maximumContextTokens,
            requiredTokens: trace.requiredTokens,
            usedTokens: trace.usedTokens,
            remainingTokens: trace.remainingTokens,
            discardedTokens: trace.discardedTokens,
            tokenEstimateSource: trace.tokenEstimateSource,
            candidateCount: 2,
            includedCount: 1,
            discardedCount: 1,
            createdAt: trace.createdAt,
            execution: trace.execution,
            outputCandidateId: trace.outputCandidateId,
          },
        ]),
      ),
      findById: vi.fn(() => Promise.resolve(trace)),
      findByOutputCandidateId: vi.fn(() => Promise.resolve(trace)),
    };
    render(
      <ContextHistoryPanel
        projectId={PROJECT_ID}
        store={store}
        novelSkills={{
          findInvocationByContextTrace: vi.fn(() =>
            Promise.reject(new Error("corrupt optional receipt")),
          ),
        }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "查看采用与舍弃原因" }));

    expect(await screen.findByText("本次资料选择明细")).toBeTruthy();
    expect(screen.getByText("锁定的故事规则 · 故事规则")).toBeTruthy();
    expect(screen.getByText(/故事资料记录仍可正常查看/u)).toBeTruthy();
  });
});

function makeTrace(): ContextCompilationTrace {
  return {
    id: TRACE_ID,
    projectId: PROJECT_ID,
    chapterId: "019a1f9f-4ab3-7000-8000-000000000003",
    taskType: "continuation",
    maximumContextTokens: 100,
    requiredTokens: 20,
    usedTokens: 20,
    remainingTokens: 80,
    discardedTokens: 90,
    tokenEstimateSource: "utf8_conservative",
    createdAt: "2026-08-01T01:02:03.000Z",
    execution: {
      generationId: "019a1f9f-4ab3-7000-8000-000000000004",
      generationRunId: null,
      modelInvocationId: "019a1f9f-4ab3-7000-8000-000000000005",
    },
    outputCandidateId: "019a1f9f-4ab3-7000-8000-000000000006",
    entries: [
      {
        contextCandidateId: "locked-rule.1",
        layer: "locked_hard_rules",
        selectionReason: "用户已锁定，必须参与本次创作。",
        included: true,
        discardedReason: null,
        estimatedTokens: 20,
        evaluationOrder: 1,
        layerOrder: 1,
        priority: 100,
        relevanceScore: null,
        required: true,
        budgetRemainingBefore: 100,
        budgetRemainingAfter: 80,
        sources: [
          {
            sourceType: "story_rule",
            sourceId: "fact.1",
            sourceVersionId: "revision.2",
            locator: "story-fact:fact.1",
            contentHash: "a".repeat(64),
          },
        ],
      },
      {
        contextCandidateId: "scene.1",
        layer: "scene_goal",
        selectionReason: "当前场景候选。",
        included: false,
        discardedReason: "token_budget_exhausted",
        estimatedTokens: 90,
        evaluationOrder: 2,
        layerOrder: 3,
        priority: 50,
        relevanceScore: 0.8,
        required: false,
        budgetRemainingBefore: 80,
        budgetRemainingAfter: 80,
        sources: [
          {
            sourceType: "scene_plan",
            sourceId: "scene.1",
            sourceVersionId: null,
            locator: "scene:1",
            contentHash: null,
          },
        ],
      },
    ],
  };
}

function makeSummary(trace: ContextCompilationTrace): ContextCompilationTraceSummary {
  return {
    id: trace.id,
    projectId: trace.projectId,
    chapterId: trace.chapterId,
    taskType: trace.taskType,
    maximumContextTokens: trace.maximumContextTokens,
    requiredTokens: trace.requiredTokens,
    usedTokens: trace.usedTokens,
    remainingTokens: trace.remainingTokens,
    discardedTokens: trace.discardedTokens,
    tokenEstimateSource: trace.tokenEstimateSource,
    candidateCount: trace.entries.length,
    includedCount: trace.entries.filter(({ included }) => included).length,
    discardedCount: trace.entries.filter(({ included }) => !included).length,
    createdAt: trace.createdAt,
    execution: trace.execution,
    outputCandidateId: trace.outputCandidateId,
  };
}

function makeStore(
  overrides: Partial<ContextCompilationTraceStore> = {},
): ContextCompilationTraceStore {
  return {
    save: vi.fn(() => Promise.resolve()),
    linkModelInvocation: vi.fn(() => Promise.resolve()),
    linkOutputCandidate: vi.fn(() => Promise.resolve()),
    listByProjectId: vi.fn(() => Promise.resolve([])),
    findById: vi.fn(() => Promise.resolve(null)),
    findByOutputCandidateId: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

function makeUnavailableNovelSkills() {
  return {
    findInvocationByContextTrace: vi.fn(() =>
      Promise.resolve({
        status: "unavailable" as const,
        availability: {
          status: "unavailable" as const,
          reason: "当前运行环境没有写作技能采用记录。",
        },
        invocation: null,
      }),
    ),
  };
}
