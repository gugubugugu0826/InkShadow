import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsistencyInvestigationRuntimePort } from "../infrastructure/consistency-investigation-port";
import type {
  ConsistencyInvestigationDisclosure,
  ConsistencyInvestigationSnapshot,
} from "../infrastructure/consistency-investigation-service";
import { ConsistencyInvestigationError } from "../infrastructure/consistency-investigation-service";
import {
  readSafeOperationIncidents,
  resetSafeOperationDiagnosticsForTests,
} from "../infrastructure/safe-operation-diagnostics";
import type { ConsistencyRepairCandidateDisclosure } from "../infrastructure/consistency-repair-candidate-service";
import { ConsistencyInvestigationPanel } from "./consistency-investigation-panel";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const RUN_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const NOW = "2026-08-19T00:00:00.000Z";

describe("ConsistencyInvestigationPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSafeOperationDiagnosticsForTests();
  });

  it("does not start a model action on entry and requires a separate disclosure confirmation", async () => {
    const user = userEvent.setup();
    const disclosure: ConsistencyInvestigationDisclosure = {
      runId: RUN_ID,
      chapterCount: 8,
      estimatedInputTokens: 9_000,
      connectionDisplayName: "我的长篇模型",
      providerKind: "deepseek",
      connectionId: "internal-connection-id",
      catalogEntryId: "internal-catalog-id",
      modelId: "deepseek-v4-flash",
      dataDestination: "remote",
      includesPrivateContent: false,
      maximumModelCalls: 1,
      maximumToolSteps: 5,
      automaticRetryCount: 0,
      maximumDurationMs: 120_000,
      maximumOutputTokens: 4_096,
      estimatedMaximumCostMicros: null,
      currency: null,
      sends: ["当前已接受正文", "已确认故事事实"],
      doesNotSend: ["API Key 或其他凭据", "未接受 Candidate"],
      privacy: "发送前再次核对隐私范围。",
      interruption: "越过网络边界后结果不明不会自动重发。",
    };
    const snapshot = completedSnapshot();
    const finding = snapshot.findings[0];
    if (finding === undefined) throw new Error("Expected a finding fixture.");
    const prepare = vi.fn(() => Promise.resolve(disclosure));
    const run = vi.fn(() => Promise.resolve(snapshot));
    const cancel = vi.fn(() => Promise.resolve(snapshot));
    const get = vi.fn(() => Promise.resolve(snapshot));
    const list = vi.fn(() => Promise.resolve([]));
    const decideFinding = vi.fn(() => Promise.resolve(finding));
    const repairDisclosure: ConsistencyRepairCandidateDisclosure = {
      taskId: "019f9f4a-b3c7-7350-9226-000000000010",
      targetChapterTitle: "第一章",
      connectionDisplayName: "我的修复模型",
      providerKind: "deepseek",
      modelId: "deepseek-v4-flash",
      dataDestination: "remote",
      includesPrivateContent: false,
      taskLabel: "正文修复",
      estimatedInputTokens: 1_200,
      maximumOutputTokens: 8_192,
      maximumModelCalls: 1,
      automaticRetryCount: 0,
      estimatedMaximumCostMicros: null,
      currency: null,
      sends: ["《第一章》当前已接受正文", "调查结论的精确证据"],
      doesNotSend: ["API Key、密码或其他凭据", "未接受 Candidate"],
      privacy: "发送前再次核对隐私范围。",
      interruption: "取消、失败、结果不明或应用重启都不会自动重发。",
    };
    const prepareRepairCandidate = vi.fn(() => Promise.resolve(repairDisclosure));
    const runRepairCandidate = vi.fn(() =>
      Promise.resolve({
        status: "ready" as const,
        candidateId: "019f9f4a-b3c7-7350-9226-000000000011",
        chapterId: "019f9f4a-b3c7-7350-9226-000000000008",
        chapterTitle: "第一章",
      }),
    );
    const cancelRepairCandidate = vi.fn(() => Promise.resolve());
    const runtime: ConsistencyInvestigationRuntimePort = {
      prepare,
      run,
      cancel,
      get,
      list,
      decideFinding,
      prepareRepairCandidate,
      runRepairCandidate,
      cancelRepairCandidate,
    };
    const onOpenCandidate = vi.fn();

    render(
      <ConsistencyInvestigationPanel
        projectId={PROJECT_ID}
        runtime={runtime}
        onOpenCandidate={onOpenCandidate}
      />,
    );
    expect(list).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "查看范围与费用" }));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    const disclosureHeading = await screen.findByRole("heading", {
      name: "发送确认摘要",
      level: 3,
    });
    expect(disclosureHeading).toBeVisible();
    expect(disclosureHeading.closest("section")).toHaveFocus();
    expect(screen.getByText(/模型：我的长篇模型 · deepseek-v4-flash/u)).toBeVisible();
    expect(screen.getByText(/私密内容：不包含私密章节/u)).toBeVisible();
    expect(screen.getByText("最长等待")).not.toBeVisible();
    await user.click(screen.getByText("查看详细信息"));
    expect(await screen.findByText("我的长篇模型 · deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.queryByText(/deepseek ·/u)).not.toBeInTheDocument();
    expect(screen.queryByText("internal-connection-id")).not.toBeInTheDocument();
    expect(screen.getByText("发送到所选远程 AI 服务")).toBeInTheDocument();
    expect(screen.getByText("最多 1 次；自动重试 0 次")).toBeInTheDocument();
    expect(screen.getByText("接口密钥或其他凭据")).toBeInTheDocument();
    expect(screen.getByText("未接受隔离建议")).toBeInTheDocument();
    expect(screen.queryByText(/API Key|Candidate/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认并开始 1 次调查" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ runId: RUN_ID, humanConfirmed: true }));
    expect(await screen.findByRole("combobox", { name: "证据权限" })).toBeInTheDocument();
    expect(screen.getAllByText(/已接受正文/u).length).toBeGreaterThan(0);
    expect(screen.queryByText("019f9f4a-b3c7-7350-9226-000000000008")).not.toBeInTheDocument();

    const evidenceSummary = screen.getByText("查看证据（1）", { exact: true });
    expect(evidenceSummary.tagName).toBe("SUMMARY");
    const evidenceDetails = evidenceSummary.closest("details");
    expect(evidenceDetails).not.toBeNull();
    expect(evidenceDetails).not.toHaveAttribute("open");
    const keyboardEvents: string[] = [];
    evidenceSummary.addEventListener("keydown", (event) => keyboardEvents.push(event.key));
    evidenceSummary.focus();
    expect(evidenceSummary).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(keyboardEvents).toEqual(["Enter", " "]);
    await user.click(evidenceSummary);
    expect(evidenceDetails).toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "查看《第一章》修复范围与费用" }));
    expect(prepareRepairCandidate).toHaveBeenCalledWith({
      runId: RUN_ID,
      findingId: finding.id,
      targetChapterId: finding.evidence[0]?.chapterId,
    });
    expect(runRepairCandidate).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "修复建议发送确认摘要", level: 3 }),
    ).toBeVisible();
    expect(screen.getByText(/模型：我的修复模型 · deepseek-v4-flash/u)).toBeVisible();
    expect(screen.getByText(/私密内容：不包含私密章节/u)).toBeVisible();
    expect(screen.getByText("精确 1 次；自动重试 0 次")).not.toBeVisible();
    await user.click(screen.getByText("查看详细信息"));
    expect(await screen.findByText("精确 1 次；自动重试 0 次")).toBeInTheDocument();
    expect(screen.getByText("我的修复模型 · deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.getByText("接口密钥、密码或其他凭据")).toBeInTheDocument();
    expect(screen.getAllByText("未接受隔离建议").length).toBeGreaterThan(0);
    expect(screen.queryByText(/API Key|Candidate/u)).not.toBeInTheDocument();
    expect(screen.getByText("发送到所选远程 AI 服务")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认并生成 1 个隔离修复建议" }));
    await waitFor(() =>
      expect(runRepairCandidate).toHaveBeenCalledWith({
        taskId: repairDisclosure.taskId,
        humanConfirmed: true,
      }),
    );
    expect(onOpenCandidate).toHaveBeenCalledOnce();
    expect(screen.queryByText("NOT_IMPLEMENTED")).not.toBeInTheDocument();
  });

  it("shows the exact safe preparation cause instead of misreporting a cloud failure", async () => {
    const user = userEvent.setup();
    const prepare = vi.fn(() =>
      Promise.reject(
        new ConsistencyInvestigationError(
          "CONTEXT_TRACE_UNAVAILABLE",
          "无法确认本次会使用的精确故事资料，因此没有创建服务调用。",
        ),
      ),
    );
    const notUsed = vi.fn(() => Promise.reject(new Error("not used")));
    const runtime: ConsistencyInvestigationRuntimePort = {
      prepare,
      run: notUsed,
      cancel: notUsed,
      get: notUsed,
      list: vi.fn(() => Promise.resolve([])),
      decideFinding: notUsed,
      prepareRepairCandidate: notUsed,
      runRepairCandidate: notUsed,
      cancelRepairCandidate: notUsed,
    };

    render(<ConsistencyInvestigationPanel projectId={PROJECT_ID} runtime={runtime} />);
    await user.click(screen.getByRole("button", { name: "查看范围与费用" }));

    expect(await screen.findByText("调查准备未完成")).toBeVisible();
    expect(
      screen.getByText(/无法确认本次会使用的精确故事资料，因此没有创建服务调用/u),
    ).toBeVisible();
    expect(screen.getByText(/问题编号：墨影-.*联系支持时提供/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "重新整理范围与费用" })).toBeEnabled();
    expect(readSafeOperationIncidents()[0]).toMatchObject({
      operation: "consistency_investigation",
      stage: "prepare_disclosure",
      projectId: PROJECT_ID,
      dispatched: false,
      automaticRetryCount: 0,
    });
    expect(screen.queryByText(/云端操作未完成|登录状态|同步授权/u)).not.toBeInTheDocument();
  });

  it("immediately announces range preparation before the local preparation finishes", async () => {
    const user = userEvent.setup();
    const pending = deferred<ConsistencyInvestigationDisclosure>();
    const notUsed = vi.fn(() => Promise.reject(new Error("not used")));
    const runtime: ConsistencyInvestigationRuntimePort = {
      prepare: vi.fn(() => pending.promise),
      run: notUsed,
      cancel: notUsed,
      get: notUsed,
      list: vi.fn(() => Promise.resolve([])),
      decideFinding: notUsed,
      prepareRepairCandidate: notUsed,
      runRepairCandidate: notUsed,
      cancelRepairCandidate: notUsed,
    };

    render(<ConsistencyInvestigationPanel projectId={PROJECT_ID} runtime={runtime} />);
    await user.click(screen.getByRole("button", { name: "查看范围与费用" }));

    expect(screen.getByRole("status")).toHaveTextContent("正在整理调查范围和费用");
    expect(screen.getByRole("button", { name: "正在处理" })).toBeDisabled();
  });

  it("cancels from the disclosure with zero model runs", async () => {
    const user = userEvent.setup();
    const disclosure: ConsistencyInvestigationDisclosure = {
      runId: RUN_ID,
      chapterCount: 8,
      estimatedInputTokens: 9_000,
      connectionDisplayName: "我的长篇模型",
      providerKind: "deepseek",
      connectionId: "internal-connection-id",
      catalogEntryId: "internal-catalog-id",
      modelId: "deepseek-v4-flash",
      dataDestination: "local",
      includesPrivateContent: true,
      maximumModelCalls: 1,
      maximumToolSteps: 5,
      automaticRetryCount: 0,
      maximumDurationMs: 120_000,
      maximumOutputTokens: 4_096,
      estimatedMaximumCostMicros: null,
      currency: null,
      sends: ["当前已接受正文"],
      doesNotSend: ["API Key 或其他凭据"],
      privacy: "只发送给本机模型。",
      interruption: "不会自动重发。",
    };
    const cancelled = {
      ...completedSnapshot(),
      run: { ...completedSnapshot().run, status: "cancelled" as const },
    };
    const run = vi.fn(() => Promise.resolve(completedSnapshot()));
    const cancel = vi.fn(() => Promise.resolve(cancelled));
    const runtime: ConsistencyInvestigationRuntimePort = {
      prepare: vi.fn(() => Promise.resolve(disclosure)),
      run,
      cancel,
      get: vi.fn(() => Promise.resolve(cancelled)),
      list: vi.fn(() => Promise.resolve([])),
      decideFinding: vi.fn(() => Promise.reject(new Error("not used"))),
      prepareRepairCandidate: vi.fn(() => Promise.reject(new Error("not used"))),
      runRepairCandidate: vi.fn(() => Promise.reject(new Error("not used"))),
      cancelRepairCandidate: vi.fn(() => Promise.resolve()),
    };

    render(<ConsistencyInvestigationPanel projectId={PROJECT_ID} runtime={runtime} />);
    await user.click(screen.getByRole("button", { name: "查看范围与费用" }));
    expect(screen.getByText(/私密内容：包含私密章节，只在本机处理/u)).toBeVisible();
    expect(await screen.findByText("仅发送到当前已验证的本机模型")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "不发送并取消" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(RUN_ID));
    expect(run).not.toHaveBeenCalled();
  });

  it("renders a restart-rebuilt ambiguous TaskGraph as a safe blocker without internal ids", async () => {
    const user = userEvent.setup();
    const previousRunId = "019f9f4a-b3c7-7350-9226-000000000020";
    const invocationId = "019f9f4a-b3c7-7350-9226-000000000021";
    const snapshot: ConsistencyInvestigationSnapshot = {
      ...completedSnapshot(),
      run: {
        ...completedSnapshot().run,
        restartOfRunId: previousRunId,
        status: "ambiguous",
        summary: null,
        findingCount: 0,
        failureCode: "DISPATCH_OUTCOME_UNKNOWN",
      },
      steps: [
        {
          id: "019f9f4a-b3c7-7350-9226-000000000022",
          runId: RUN_ID,
          ordinal: 1,
          kind: "model",
          name: "model_synthesis",
          version: "consistency-investigation.v1",
          permission: "model_dispatch",
          inputDigest: "d".repeat(64),
          status: "ambiguous",
          plannedInvocationId: invocationId,
          invocationId,
          observationDigest: null,
          terminalCause: "DISPATCH_OUTCOME_UNKNOWN",
          createdAt: NOW,
          updatedAt: NOW,
          completedAt: NOW,
        },
      ],
      findings: [],
      chapterTitles: {},
    };
    const disclosure: ConsistencyInvestigationDisclosure = {
      runId: RUN_ID,
      chapterCount: 8,
      estimatedInputTokens: 9_000,
      connectionDisplayName: "我的长篇模型",
      providerKind: "deepseek",
      connectionId: "internal-connection-id",
      catalogEntryId: "internal-catalog-id",
      modelId: "deepseek-v4-flash",
      dataDestination: "remote",
      includesPrivateContent: false,
      maximumModelCalls: 1,
      maximumToolSteps: 5,
      automaticRetryCount: 0,
      maximumDurationMs: 120_000,
      maximumOutputTokens: 4_096,
      estimatedMaximumCostMicros: null,
      currency: null,
      sends: ["当前已接受正文", "已确认故事事实"],
      doesNotSend: ["API Key 或其他凭据", "未接受 Candidate"],
      privacy: "发送前再次核对隐私范围。",
      interruption: "越过网络边界后结果不明不会自动重发。",
    };
    const runtime: ConsistencyInvestigationRuntimePort = {
      prepare: vi.fn(() => Promise.resolve(disclosure)),
      run: vi.fn(() => Promise.resolve(snapshot)),
      cancel: vi.fn(() => Promise.resolve(snapshot)),
      get: vi.fn(() => Promise.resolve(snapshot)),
      list: vi.fn(() => Promise.resolve([])),
      decideFinding: vi.fn(() => Promise.reject(new Error("not used"))),
      prepareRepairCandidate: vi.fn(() => Promise.reject(new Error("not used"))),
      runRepairCandidate: vi.fn(() => Promise.reject(new Error("not used"))),
      cancelRepairCandidate: vi.fn(() => Promise.resolve()),
    };

    render(<ConsistencyInvestigationPanel projectId={PROJECT_ID} runtime={runtime} />);
    await user.click(screen.getByRole("button", { name: "查看范围与费用" }));
    await user.click(screen.getByRole("button", { name: "确认并开始 1 次调查" }));

    const graph = await screen.findByRole("list", { name: "只读调查任务图" });
    for (const stage of ["目标", "计划", "行动", "工具", "观察", "核验", "阻断"]) {
      expect(within(graph).getByText(stage)).toBeInTheDocument();
    }
    expect(within(graph).getAllByText("结果不确定")).not.toHaveLength(0);
    expect(within(graph).getAllByText(/不会自动重发/u)).not.toHaveLength(0);
    expect(screen.getByText("这是重新开始的一次独立调查")).toBeInTheDocument();
    expect(screen.getByText(/上一次调查不会被续跑/u)).toBeInTheDocument();
    expect(screen.queryByText(previousRunId)).not.toBeInTheDocument();
    expect(screen.queryByText(invocationId)).not.toBeInTheDocument();
    expect(screen.queryByText("DISPATCH_OUTCOME_UNKNOWN")).not.toBeInTheDocument();
  });
});

function completedSnapshot(): ConsistencyInvestigationSnapshot {
  return {
    run: {
      id: RUN_ID,
      taskId: "019f9f4a-b3c7-7350-9226-000000000003",
      projectId: PROJECT_ID,
      restartOfRunId: null,
      idempotencyKey: "consistency-investigation:test",
      requestFingerprint: "a".repeat(64),
      status: "succeeded",
      chapterCount: 8,
      policy: {
        maximumModelCalls: 1,
        maximumToolSteps: 5,
        maximumContextCharacters: 120_000,
        maximumOutputTokens: 4_096,
        maximumDurationMs: 120_000,
        automaticRetryCount: 0,
      },
      estimatedInputTokens: 9_000,
      estimatedMaximumCostMicros: null,
      currency: null,
      connectionId: "internal-connection-id",
      catalogEntryId: "internal-catalog-id",
      providerKind: "deepseek",
      modelId: "deepseek-v4-flash",
      privacyFingerprint: "b".repeat(64),
      contextTraceId: "019f9f4a-b3c7-7350-9226-000000000004",
      generationId: "019f9f4a-b3c7-7350-9226-000000000005",
      summary: "本次调查形成 1 项带精确来源的结论。",
      findingCount: 1,
      droppedFindingCount: 0,
      cancellationRequested: false,
      failureCode: null,
      revision: 4,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    steps: [],
    chapterTitles: {
      "019f9f4a-b3c7-7350-9226-000000000008": "第一章",
    },
    findings: [
      {
        id: "019f9f4a-b3c7-7350-9226-000000000006",
        runId: RUN_ID,
        modelStepId: "019f9f4a-b3c7-7350-9226-000000000007",
        ordinal: 1,
        severity: "warning",
        authorityGroup: "accepted_body",
        category: "timeline",
        title: "时间顺序需要复核",
        explanation: "两处当前证据的先后关系不一致。",
        status: "pending",
        evidence: [
          {
            projectId: PROJECT_ID,
            chapterId: "019f9f4a-b3c7-7350-9226-000000000008",
            immutableVersionId: "019f9f4a-b3c7-7350-9226-000000000009",
            sourceKind: "chapter",
            locator: { kind: "utf16", startOffset: 10, endOffset: 20, sourceLength: 100 },
            excerptDigest: "c".repeat(64),
            sourceCreatedAt: NOW,
            observedAt: NOW,
            currentness: "current",
            branchId: null,
            privacy: "standard",
          },
        ],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        decidedAt: null,
      },
    ],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
