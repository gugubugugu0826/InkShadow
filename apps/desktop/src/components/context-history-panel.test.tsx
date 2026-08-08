import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ContextCompilationTrace,
  ContextCompilationTraceStore,
} from "../infrastructure/context-compilation-trace-store";
import { ContextHistoryPanel } from "./context-history-panel";

const PROJECT_ID = "019a1f9f-4ab3-7000-8000-000000000001";
const TRACE_ID = "019a1f9f-4ab3-7000-8000-000000000002";

describe("context history panel", () => {
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

    render(<ContextHistoryPanel projectId={PROJECT_ID} store={store} />);

    expect(await screen.findByText("继续创作")).toBeInTheDocument();
    expect(screen.getByText(/记录不保存正文、提示词或模型回复/u)).toBeInTheDocument();
    expect(screen.queryByText("不应出现在审计记录里的正文")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看采用与舍弃原因" }));

    expect(await screen.findByText("本次资料选择明细")).toBeInTheDocument();
    expect(screen.getByText("锁定的故事规则")).toBeInTheDocument();
    expect(screen.getByText("当前场景目标")).toBeInTheDocument();
    expect(screen.getByText("已采用")).toBeInTheDocument();
    expect(screen.getByText("未采用")).toBeInTheDocument();
    expect(screen.getByText(/预算不足/u)).toBeInTheDocument();
    expect(findById).toHaveBeenCalledWith(TRACE_ID);
    expect(screen.getByText("已精确关联 AI 建议版本")).toBeInTheDocument();
    expect(screen.getByText("这条记录与 AI 建议版本精确关联")).toBeInTheDocument();
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
    render(<ContextHistoryPanel projectId={PROJECT_ID} store={store} />);

    expect(await screen.findByText("还没有上下文记录")).toBeInTheDocument();
    expect(screen.getByText(/第一次使用“继续创作”/u)).toBeInTheDocument();
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
