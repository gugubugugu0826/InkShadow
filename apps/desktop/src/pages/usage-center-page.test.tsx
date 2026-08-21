import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  UsageCenterError,
  type UsageAggregate,
  type UsageBreakdownDimension,
  type UsageBreakdownEntry,
  type UsageCenterEvent,
  type UsageCenterReader,
  type UsageCenterSnapshot,
} from "../infrastructure/usage-center-service";
import { UsageCenterPage } from "./usage-center-page";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const NOW = () => new Date("2026-08-08T12:00:00.000Z");

describe("UsageCenterPage", () => {
  it("shows real token, cost, result and privacy facts and applies every filter", async () => {
    const read = vi.fn<UsageCenterReader["read"]>().mockResolvedValue(SNAPSHOT);
    const reader: UsageCenterReader = { read };
    const user = userEvent.setup();
    render(<UsageCenterPage reader={reader} now={NOW} />);

    expect(
      await screen.findByRole("heading", { name: "调用与费用", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("¥0.12").length).toBeGreaterThan(0);
    expect(screen.getByText("1 次费用未知 · 已知金额均为估算")).toBeInTheDocument();
    expect(screen.getByText("供应商未返回")).toBeInTheDocument();
    expect(screen.getByText("调用账本有 1 次失败或结果不明确、1 次费用未知")).toBeVisible();
    expect(screen.getByText("第一章 雨停以前")).toBeVisible();
    expect(screen.getAllByText("本地运算").length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent("deepseek-connection");
    expect(document.body).not.toHaveTextContent("ollama-connection");
    expect(screen.getByText(/AI 服务暂未完成本次操作。请到设置中的 AI 模型检查/u)).toBeVisible();
    expect(screen.queryByText("LOCAL_MODEL_UNAVAILABLE_INTERNAL_SENTINEL")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "这里不保存正文、提示词或 API Key。金额是按本地价格元数据计算的估算，不代表供应商最终账单；缺少 token 回执或价格时会明确显示“费用未知”。",
      ),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("作品"), PROJECT_ID);
    await waitFor(() => {
      expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: PROJECT_ID }));
    });
    await user.selectOptions(screen.getByLabelText("任务"), "continuation");
    await user.selectOptions(screen.getByLabelText("供应商"), "deepseek-connection");
    await user.selectOptions(screen.getByLabelText("模型"), "deepseek-chat");
    await waitFor(() => {
      expect(read).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          task: "continuation",
          providerId: "deepseek-connection",
          modelId: "deepseek-chat",
        }),
      );
    });

    await user.selectOptions(screen.getByLabelText("汇总方式"), "provider");
    const breakdown = screen.getByRole("table", { name: "分类调用汇总" });
    expect(within(breakdown).getByRole("columnheader", { name: "供应商" })).toBeInTheDocument();
  });

  it("shows an actionable empty state without invented sample usage", async () => {
    const reader: UsageCenterReader = {
      read: vi.fn<UsageCenterReader["read"]>().mockResolvedValue(EMPTY_SNAPSHOT),
    };
    render(<UsageCenterPage reader={reader} now={NOW} />);

    expect(await screen.findByText("还没有调用记录")).toBeInTheDocument();
    expect(screen.getByText(/完成一次真实 AI 调用后/u)).toBeInTheDocument();
    expect(screen.queryByText("¥4.20")).not.toBeInTheDocument();
  });

  it("shows a capability probe as one ordinary Chinese ledger row without private internals", async () => {
    const record: UsageCenterEvent = Object.freeze({
      id: "hub:capability-probe-public-row",
      source: "model_hub_invocation",
      occurredAt: "2026-08-08T11:00:00.000Z",
      projectId: null,
      projectName: null,
      chapterId: null,
      chapterName: null,
      task: "capability_probe",
      providerId: "private-connection-id",
      providerLabel: "写作模型服务",
      modelId: "writer-model-v1",
      status: "succeeded",
      inputTokens: 11,
      outputTokens: 2,
      cachedInputTokens: 3,
      costMicros: null,
      currency: null,
      costSource: "unknown",
      privacyPolicy: "cloud_allowed",
      dataDestination: "remote",
      errorCode: null,
    });
    const reader: UsageCenterReader = {
      read: vi.fn<UsageCenterReader["read"]>().mockResolvedValue({
        ...EMPTY_SNAPSHOT,
        summary: {
          ...EMPTY_AGGREGATE,
          invocationCount: 1,
          successCount: 1,
          remoteCount: 1,
          inputTokens: 11,
          outputTokens: 2,
          cachedInputTokens: 3,
          costUnknownCount: 1,
        },
        records: [record],
        totalMatchingRecords: 1,
        facets: {
          projects: [],
          tasks: [{ value: "capability_probe", label: "模型能力验证" }],
          providers: [{ value: record.providerId, label: record.providerLabel }],
          models: [{ value: record.modelId, label: record.modelId }],
        },
      }),
    };

    render(<UsageCenterPage reader={reader} now={NOW} />);

    const details = await screen.findByRole("table", { name: "调用明细" });
    const row = within(details).getByRole("row", { name: /模型能力验证/u });
    expect(row).toHaveTextContent("写作模型服务");
    expect(row).toHaveTextContent("writer-model-v1");
    expect(row).toHaveTextContent("输入 11 · 输出 2 · 缓存 3");
    expect(row).toHaveTextContent("费用未知");
    expect(row).toHaveTextContent("成功");
    expect(document.body).not.toHaveTextContent("private-connection-id");
    expect(document.body).not.toHaveTextContent("https://api.example.test/v1");
    expect(document.body).not.toHaveTextContent("只回复：OK");
    expect(document.body).not.toHaveTextContent("secret-credential-value");
  });

  it("raises unfinished and unknown-cost calls above the neutral summaries", async () => {
    const reader: UsageCenterReader = {
      read: vi.fn<UsageCenterReader["read"]>().mockResolvedValue({
        ...SNAPSHOT,
        summary: {
          ...SUMMARY,
          failureCount: 0,
          activeCount: 2,
          costUnknownCount: 2,
        },
      }),
    };
    render(<UsageCenterPage reader={reader} now={NOW} />);

    const title = await screen.findByText("调用账本有 2 次尚未终结、2 次费用未知");
    expect(title.closest(".ink-inline-alert")).toHaveClass("ink-inline-alert--warning");
  });

  it("recovers from a local ledger read failure", async () => {
    const privateCause = "sqlite table invocation_ledger is malformed";
    const read = vi
      .fn<UsageCenterReader["read"]>()
      .mockRejectedValueOnce(new UsageCenterError("USAGE_CENTER_LEDGER_INVALID", privateCause))
      .mockResolvedValue(EMPTY_SNAPSHOT);
    const reader: UsageCenterReader = {
      read,
    };
    const user = userEvent.setup();
    render(<UsageCenterPage reader={reader} now={NOW} />);

    expect(await screen.findByText("暂时无法读取调用账本")).toBeInTheDocument();
    expect(screen.getByText(/发生了未预期的本地错误。请先重试/u)).toBeInTheDocument();
    expect(screen.queryByText("USAGE_CENTER_LEDGER_INVALID")).not.toBeInTheDocument();
    expect(screen.queryByText(privateCause)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取" }));

    expect(await screen.findByText("还没有调用记录")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

const REMOTE_RECORD: UsageCenterEvent = Object.freeze({
  id: "generation:one:1",
  source: "generation_attempt",
  occurredAt: "2026-08-08T10:00:00.000Z",
  projectId: PROJECT_ID,
  projectName: "五更夜巡",
  chapterId: "019f9f4a-b3c7-7350-9226-000000000002",
  chapterName: "第一章 雨停以前",
  task: "continuation",
  providerId: "deepseek-connection",
  providerLabel: "DeepSeek",
  modelId: "deepseek-chat",
  status: "succeeded",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 10,
  costMicros: "120000",
  currency: "CNY",
  costSource: "provider_usage_estimate",
  privacyPolicy: "cloud_allowed",
  dataDestination: "remote",
  errorCode: null,
});

const LOCAL_RECORD: UsageCenterEvent = Object.freeze({
  id: "hub:two",
  source: "model_hub_invocation",
  occurredAt: "2026-08-08T09:00:00.000Z",
  projectId: null,
  projectName: null,
  chapterId: null,
  chapterName: null,
  task: "embedding",
  providerId: "ollama-connection",
  providerLabel: "本机 Ollama",
  modelId: "nomic-embed-text",
  status: "failed",
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  costMicros: null,
  currency: null,
  costSource: "unknown",
  privacyPolicy: "local_only",
  dataDestination: "local",
  errorCode: "LOCAL_MODEL_UNAVAILABLE_INTERNAL_SENTINEL",
});

const SUMMARY: UsageAggregate = Object.freeze({
  invocationCount: 2,
  successCount: 1,
  failureCount: 1,
  cancelledCount: 0,
  activeCount: 0,
  localCount: 1,
  remoteCount: 1,
  destinationUnknownCount: 0,
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 10,
  tokenUsageUnknownCount: 1,
  costTotals: [{ currency: "CNY", micros: "120000", invocationCount: 1 }],
  costUnknownCount: 1,
});

const EMPTY_AGGREGATE: UsageAggregate = Object.freeze({
  invocationCount: 0,
  successCount: 0,
  failureCount: 0,
  cancelledCount: 0,
  activeCount: 0,
  localCount: 0,
  remoteCount: 0,
  destinationUnknownCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  tokenUsageUnknownCount: 0,
  costTotals: [],
  costUnknownCount: 0,
});

const BREAKDOWN: UsageBreakdownEntry = Object.freeze({
  key: "2026-08-08",
  label: "2026-08-08",
  ...SUMMARY,
});

const BREAKDOWNS: Readonly<Record<UsageBreakdownDimension, readonly UsageBreakdownEntry[]>> =
  Object.freeze({
    time: [BREAKDOWN],
    project: [{ ...BREAKDOWN, key: PROJECT_ID, label: "五更夜巡" }],
    task: [{ ...BREAKDOWN, key: "continuation", label: "续写" }],
    provider: [{ ...BREAKDOWN, key: "deepseek-connection", label: "DeepSeek" }],
    model: [{ ...BREAKDOWN, key: "deepseek-chat", label: "deepseek-chat" }],
  });

const SNAPSHOT: UsageCenterSnapshot = Object.freeze({
  summary: SUMMARY,
  records: [REMOTE_RECORD, LOCAL_RECORD],
  totalMatchingRecords: 2,
  detailsTruncated: false,
  facets: {
    projects: [{ value: PROJECT_ID, label: "五更夜巡" }],
    tasks: [
      { value: "continuation", label: "续写" },
      { value: "embedding", label: "语义记忆" },
    ],
    providers: [
      { value: "deepseek-connection", label: "DeepSeek" },
      { value: "ollama-connection", label: "本机 Ollama" },
    ],
    models: [
      { value: "deepseek-chat", label: "deepseek-chat" },
      { value: "nomic-embed-text", label: "nomic-embed-text" },
    ],
  },
  breakdowns: BREAKDOWNS,
  budgets: [
    {
      scopeKey: "month:2026-08:CNY",
      scope: "month" as const,
      projectId: null,
      projectName: null,
      monthKey: "2026-08",
      currency: "CNY",
      limitMicros: "30000000",
      enforcement: "warn" as const,
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ],
});

const EMPTY_BREAKDOWNS: Readonly<Record<UsageBreakdownDimension, readonly UsageBreakdownEntry[]>> =
  Object.freeze({ time: [], project: [], task: [], provider: [], model: [] });

const EMPTY_SNAPSHOT: UsageCenterSnapshot = Object.freeze({
  summary: EMPTY_AGGREGATE,
  records: [],
  totalMatchingRecords: 0,
  detailsTruncated: false,
  facets: { projects: [], tasks: [], providers: [], models: [] },
  breakdowns: EMPTY_BREAKDOWNS,
  budgets: [],
});
