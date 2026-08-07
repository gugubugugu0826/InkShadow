import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MultiAgentReviewSession } from "@inkshadow/data";
import { describe, expect, it, vi } from "vitest";

import { MultiAgentReviewPage, type MultiAgentReviewPageRuntime } from "./multi-agent-review-page";

describe("MultiAgentReviewPage", () => {
  it("keeps a direct feature-disabled page read-only while preserving history and export", async () => {
    const user = userEvent.setup();
    const session = reviewSession({
      status: "running",
      userRequest: "Existing local review remains readable",
    });
    const runtime = fakeRuntime({
      listHistory: vi.fn(() => Promise.resolve([session])),
      exportHistory: vi.fn(() => '{"schemaVersion":1}'),
    });
    const onExportHistory = vi.fn();

    render(
      <MultiAgentReviewPage
        runtime={runtime}
        projectId={session.projectId}
        featureEnabled={false}
        onExportHistory={onExportHistory}
      />,
    );

    expect(await screen.findByText("Existing local review remains readable")).toBeVisible();
    expect(screen.getByText("多智能体创建功能当前关闭")).toBeVisible();
    expect(screen.queryByRole("button", { name: "开始本地审查" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停止审查" })).toBeNull();
    expect(runtime.startReview).not.toHaveBeenCalled();
    expect(runtime.runReview).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "导出公开历史" }));
    expect(runtime.exportHistory).toHaveBeenCalledWith(session);
    expect(onExportHistory).toHaveBeenCalledWith(
      `inkshadow-multi-agent-${session.id}.json`,
      '{"schemaVersion":1}',
    );
  });

  it("surfaces the exact needs-input question and starts a fresh-answer draft", async () => {
    const user = userEvent.setup();
    const session = needsInputSession();
    const runtime = fakeRuntime({
      listHistory: vi.fn(() => Promise.resolve([session])),
    });

    render(<MultiAgentReviewPage runtime={runtime} projectId={session.projectId} featureEnabled />);

    expect(await screen.findByText("主角是否已经知道港口封锁的原因？")).toBeVisible();
    expect(screen.queryByRole("button", { name: "重新开始" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "填写回答并新建审查" }));
    expect(screen.getByRole("textbox", { name: "审查目标" })).toHaveValue(
      `${session.userRequest}\n\n补充回答：`,
    );
    expect(runtime.restartReview).not.toHaveBeenCalled();
  });

  it("keeps stop available during an active start operation and aborts that run", async () => {
    const user = userEvent.setup();
    const running = reviewSession();
    const cancelled = reviewSession({
      status: "cancelled",
      revision: 2,
      cancellationRequested: true,
      completedAt: NOW,
    });
    let observedSignal: AbortSignal | undefined;
    const runReview = vi.fn<MultiAgentReviewPageRuntime["runReview"]>(
      (_sessionId, options) =>
        new Promise<MultiAgentReviewSession>((resolve) => {
          observedSignal = options?.signal;
          options?.signal?.addEventListener("abort", () => resolve(cancelled), { once: true });
        }),
    );
    const runtime = fakeRuntime({
      listHistory: vi.fn(() => Promise.resolve([])),
      startReview: vi.fn(() => Promise.resolve(running)),
      runReview,
      cancelReview: vi.fn(() => Promise.resolve(cancelled)),
    });

    render(<MultiAgentReviewPage runtime={runtime} projectId={running.projectId} featureEnabled />);

    await user.type(await screen.findByRole("textbox", { name: "审查目标" }), "检查终幕伏笔");
    await user.click(screen.getByRole("button", { name: "开始本地审查" }));
    await waitFor(() => expect(runReview).toHaveBeenCalledTimes(1));
    const stop = screen.getByRole("button", { name: "停止审查" });
    expect(stop).toBeEnabled();
    await user.click(stop);

    expect(observedSignal?.aborted).toBe(true);
    expect(runtime.cancelReview).toHaveBeenCalledTimes(1);
  });

  it("shows unavailable provider usage without inventing an estimate", async () => {
    const session = failedSessionWithUnavailableUsage();
    const runtime = fakeRuntime({
      listHistory: vi.fn(() => Promise.resolve([session])),
    });

    render(<MultiAgentReviewPage runtime={runtime} projectId={session.projectId} featureEnabled />);

    expect(await screen.findByText(/提供方未返回，不进行估算/u)).toBeVisible();
    expect(screen.getAllByText("部分未知")).toHaveLength(2);
    expect(screen.getByText("不可核算")).toBeVisible();
  });

  it("keeps candidate rejection explicit and reloads its authoritative status", async () => {
    const user = userEvent.setup();
    const session = candidateReadySession();
    const candidate = session.candidate;
    if (candidate === null) {
      throw new Error("Expected a ready review candidate.");
    }
    const listHistory = vi.fn(() => Promise.resolve([session]));
    const runtime = fakeRuntime({
      listHistory,
      rejectCandidate: vi.fn(() => Promise.resolve(candidate)),
    });

    render(<MultiAgentReviewPage runtime={runtime} projectId={session.projectId} featureEnabled />);

    await user.click(await screen.findByRole("button", { name: "拒绝候选" }));
    await waitFor(() =>
      expect(runtime.rejectCandidate).toHaveBeenCalledWith(candidate.id, candidate.revision),
    );
    expect(listHistory).toHaveBeenCalledTimes(2);
  });
});

const NOW = "2026-07-28T08:00:00.000Z";

function reviewSession(override: Partial<MultiAgentReviewSession> = {}): MultiAgentReviewSession {
  return {
    id: "review-1",
    projectId: "project-1",
    idempotencyKey: "request-1",
    requestFingerprint: "a".repeat(64),
    restartOfSessionId: null,
    mode: "outline_review",
    targetKind: "outline",
    chapterId: null,
    baseVersionId: null,
    baseOutlineRevision: 1,
    baseAuthorityChecksum: "b".repeat(64),
    userRequest: "检查第二幕的因果链",
    status: "running",
    revision: 1,
    attempt: 1,
    limits: {
      maximumRounds: 1,
      maximumTurns: 1,
      maximumInputTokens: 120_000,
      maximumOutputTokens: 32_000,
      maximumCostMicros: 10_000_000,
      maximumDurationMs: 900_000,
      currency: "USD",
    },
    cancellationRequested: false,
    failureCode: null,
    startedAt: NOW,
    deadlineAt: "2026-07-28T08:15:00.000Z",
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    participants: [
      {
        participantId: "participant-1",
        ordinal: 0,
        role: "critic",
        enabled: true,
        status: "idle",
        providerId: "provider-1",
        providerKind: "open_ai_compatible",
        endpointUrl: "https://models.example/v1",
        authentication: "bearer_keyring",
        providerProfileRevision: 1,
        modelId: "review-model",
        modelRevision: "1.1",
        maximumTurns: 1,
        contextWindowTokens: 8_192,
        inputMicrosPerMillionTokens: 1_000,
        outputMicrosPerMillionTokens: 1_000,
        cachedInputMicrosPerMillionTokens: null,
        pricingVersion: "price-1",
        priceUpdatedAt: NOW,
        errorCode: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    turns: [],
    candidate: null,
    ...override,
  };
}

function needsInputSession(): MultiAgentReviewSession {
  const session = reviewSession({
    status: "needs_input",
    revision: 3,
    userRequest: "检查港口段落的动机",
  });
  return {
    ...session,
    participants: session.participants.map((participant) => ({
      ...participant,
      status: "needs_input",
    })),
    turns: [
      {
        id: "turn-1",
        sequence: 1,
        attempt: 1,
        participantId: "participant-1",
        idempotencyKey: "turn-request-1",
        resultFingerprint: "c".repeat(64),
        generationId: "generation-1",
        runRevisionBefore: 1,
        status: "needs_input",
        reservation: {
          maximumInputTokens: 4_000,
          maximumOutputTokens: 1_000,
          maximumCostMicros: 5,
        },
        publicMessage: "需要确认人物掌握的信息。",
        responseJson: JSON.stringify({
          schemaVersion: 1,
          publicMessage: "需要确认人物掌握的信息。",
          conclusions: [],
          candidate: null,
          needsInput: {
            question: "主角是否已经知道港口封锁的原因？",
          },
        }),
        usageSource: "provider_reported",
        inputTokens: 2_000,
        outputTokens: 120,
        cachedInputTokens: null,
        costMicros: 3,
        errorCode: null,
        startedAt: NOW,
        completedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        conclusions: [],
      },
    ],
  };
}

function failedSessionWithUnavailableUsage(): MultiAgentReviewSession {
  const session = reviewSession({
    status: "failed",
    revision: 3,
    failureCode: "MODEL_USAGE_UNAVAILABLE",
    completedAt: NOW,
  });
  return {
    ...session,
    participants: session.participants.map((participant) => ({
      ...participant,
      status: "error",
      errorCode: "MODEL_USAGE_UNAVAILABLE",
    })),
    turns: [
      {
        id: "turn-1",
        sequence: 1,
        attempt: 1,
        participantId: "participant-1",
        idempotencyKey: "turn-request-1",
        resultFingerprint: null,
        generationId: "generation-1",
        runRevisionBefore: 1,
        status: "failed",
        reservation: {
          maximumInputTokens: 4_000,
          maximumOutputTokens: 1_000,
          maximumCostMicros: 5,
        },
        publicMessage: null,
        responseJson: null,
        usageSource: "provider_unavailable",
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        costMicros: null,
        errorCode: "MODEL_USAGE_UNAVAILABLE",
        startedAt: NOW,
        completedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        conclusions: [],
      },
    ],
  };
}

function candidateReadySession(): MultiAgentReviewSession {
  const session = reviewSession({
    status: "candidate_ready",
    revision: 4,
    completedAt: NOW,
  });
  return {
    ...session,
    participants: session.participants.map((participant) => ({
      ...participant,
      status: "done",
    })),
    turns: [
      {
        id: "turn-1",
        sequence: 1,
        attempt: 1,
        participantId: "participant-1",
        idempotencyKey: "turn-request-1",
        resultFingerprint: "c".repeat(64),
        generationId: "generation-1",
        runRevisionBefore: 1,
        status: "completed",
        reservation: {
          maximumInputTokens: 4_000,
          maximumOutputTokens: 1_000,
          maximumCostMicros: 5,
        },
        publicMessage: "候选已生成。",
        responseJson: JSON.stringify({
          schemaVersion: 1,
          publicMessage: "候选已生成。",
          conclusions: [],
          candidate: {
            kind: "outline_patch",
            changes: [
              {
                nodeId: "node-1",
                expectedNodeRevision: 1,
                title: "新的标题",
                synopsis: null,
              },
            ],
          },
          needsInput: null,
        }),
        usageSource: "provider_reported",
        inputTokens: 2_000,
        outputTokens: 300,
        cachedInputTokens: null,
        costMicros: 3,
        errorCode: null,
        startedAt: NOW,
        completedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        conclusions: [],
      },
    ],
    candidate: {
      id: "candidate-1",
      sessionId: session.id,
      projectId: session.projectId,
      targetKind: "outline",
      chapterCandidateId: null,
      baseVersionId: null,
      baseOutlineRevision: 1,
      payloadJson: JSON.stringify({
        kind: "outline_patch",
        changes: [
          {
            nodeId: "node-1",
            expectedNodeRevision: 1,
            title: "新的标题",
            synopsis: null,
          },
        ],
      }),
      payloadChecksum: "d".repeat(64),
      status: "ready",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      decidedAt: null,
      acceptedOutlineSnapshotJson: null,
      acceptedOutlineRevision: null,
    },
  };
}

function fakeRuntime(
  overrides: Partial<MultiAgentReviewPageRuntime> = {},
): MultiAgentReviewPageRuntime & Record<string, ReturnType<typeof vi.fn>> {
  return {
    acceptOutlineCandidate: vi.fn(),
    cancelReview: vi.fn(),
    exportHistory: vi.fn(() => "{}"),
    expireCandidate: vi.fn(),
    listHistory: vi.fn(() => Promise.resolve([])),
    rejectCandidate: vi.fn(),
    restartReview: vi.fn(),
    runReview: vi.fn(),
    startReview: vi.fn(),
    ...overrides,
  } as unknown as MultiAgentReviewPageRuntime & Record<string, ReturnType<typeof vi.fn>>;
}
