// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  NovelSkillPaidEvaluationPanel,
  type NovelSkillPaidEvaluationPanelPort,
  type NovelSkillPaidEvaluationSnapshot,
  type NovelSkillPaidEvaluationTargetOption,
} from "./novel-skill-paid-evaluation-panel";

const TARGETS: readonly NovelSkillPaidEvaluationTargetOption[] = [
  {
    targetId: "target-a",
    providerLabel: "DeepSeek",
    modelLabel: "写作模型 A",
    providerModelId: "deepseek-v4-flash",
  },
  {
    targetId: "target-b",
    providerLabel: "OpenAI",
    modelLabel: "写作模型 B",
    providerModelId: "gpt-writing-2026-08",
  },
];

describe("NovelSkillPaidEvaluationPanel", () => {
  it("is absent outside expert mode and performs no operation by default", () => {
    const initialize = vi.fn(() => Promise.resolve(snapshot()));
    const port = createPort({ initialize });

    render(<NovelSkillPaidEvaluationPanel targets={TARGETS} port={port} />);

    expect(screen.queryByText("内置写作技能付费对照验证")).not.toBeInTheDocument();
    expect(initialize).not.toHaveBeenCalled();
    expectEveryPortMethodToHaveNoCalls(port);
  });

  it("loads local recovery only after the expert panel is mounted and never starts dispatch", async () => {
    const recovered = snapshot({
      phase: "authorized_not_started",
      runId: "run-recovered",
      quote: quote(),
      authorizationId: "authorization-recovered",
    });
    const initialize = vi.fn(() => Promise.resolve(recovered));
    const port = createPort({ initialize });

    render(<NovelSkillPaidEvaluationPanel expertMode targets={TARGETS} port={port} />);

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("商业授权已保存，但尚未产生调用")).toBeVisible();
    expect(port.prepareAndQuote).not.toHaveBeenCalled();
    expect(port.authorizeCommercialRun).not.toHaveBeenCalled();
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
  });

  it("isolates a local recovery failure without starting any paid operation", async () => {
    const rawMessage = "Candidate invocation recovery record is unreadable";
    const initialize = vi.fn(() => Promise.reject(new Error(rawMessage)));
    const port = createPort({ initialize });

    render(<NovelSkillPaidEvaluationPanel expertMode targets={TARGETS} port={port} />);

    expect(await screen.findByText(/本地恢复检查没有完成/u)).toBeVisible();
    expect(screen.getByText(/发生了未预期的本地错误/u)).toBeVisible();
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
    expect(port.prepareAndQuote).not.toHaveBeenCalled();
    expect(port.authorizeCommercialRun).not.toHaveBeenCalled();
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
  });

  it("keeps local preparation, commercial authorization and manual start separate", async () => {
    const user = userEvent.setup();
    const quoted = snapshot({
      phase: "awaiting_authorization",
      runId: "run-1",
      quote: quote(),
    });
    const authorized = snapshot({
      phase: "authorized_not_started",
      runId: "run-1",
      quote: quote(),
      authorizationId: "authorization-1",
    });
    const afterStart = snapshot({
      phase: "running_waiting",
      runId: "run-1",
      quote: quote(),
      authorizationId: "authorization-1",
      completedProviderCalls: 1,
    });
    const port = createPort({
      prepareAndQuote: vi.fn(() => Promise.resolve(quoted)),
      authorizeCommercialRun: vi.fn(() => Promise.resolve(authorized)),
      startAuthorizedRun: vi.fn<NovelSkillPaidEvaluationPanelPort["startAuthorizedRun"]>(
        ({ onProgress }) => {
          onProgress(afterStart);
          return Promise.resolve(afterStart);
        },
      ),
    });

    const firstMount = render(
      <NovelSkillPaidEvaluationPanel expertMode targets={TARGETS} port={port} />,
    );

    expect(screen.getByText("这是固定 192 次的商业模型评测")).toBeVisible();
    expect(screen.getByText(/不会自动改用备用模型，也不会自动重试/u)).toBeVisible();
    expect(screen.getByText(/取消或崩溃后不会自动重发/u)).toBeVisible();
    expect(screen.getByText("0 / 192")).toBeVisible();
    expect(screen.getByText("0 / 2,496")).toBeVisible();
    expectEveryPortMethodToHaveNoCalls(port);

    await user.selectOptions(screen.getByLabelText("模型 A"), "target-a");
    await user.selectOptions(screen.getByLabelText("模型 B"), "target-b");
    await user.click(screen.getByRole("button", { name: "生成本地预检报价" }));

    expect(port.prepareAndQuote).toHaveBeenCalledWith({
      exactTargetIds: ["target-a", "target-b"],
    });
    expect(port.authorizeCommercialRun).not.toHaveBeenCalled();
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
    expect(await screen.findByText("0 次模型调用")).toBeVisible();
    expect(screen.getByText(/USD 2\.000000/u)).toBeVisible();
    expect(screen.getByText(/CNY 14\.000000/u)).toBeVisible();

    await user.click(
      screen.getByRole("checkbox", {
        name: /我确认固定 192 次调用/u,
      }),
    );
    await user.click(screen.getByRole("button", { name: "仅保存商业授权" }));

    expect(port.authorizeCommercialRun).toHaveBeenCalledWith({
      runId: "run-1",
      quoteId: "quote-1",
      commercialUseAcknowledged: true,
    });
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
    expect(await screen.findByText("商业授权已保存，但尚未产生调用")).toBeVisible();

    firstMount.unmount();
    render(
      <NovelSkillPaidEvaluationPanel
        expertMode
        targets={TARGETS}
        port={port}
        initialSnapshot={authorized}
      />,
    );

    expect(screen.getByText("商业授权已保存，但尚未产生调用")).toBeVisible();
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "手动开始 192 次付费调用" }));

    await waitFor(() => expect(port.startAuthorizedRun).toHaveBeenCalledTimes(1));
    expect(screen.getByText("1 / 192")).toBeVisible();
  });

  it("shows durable progress and cancellation without automatically starting or resending", async () => {
    const user = userEvent.setup();
    const stopped = snapshot({
      phase: "invalidated_ambiguous",
      runId: "run-1",
      quote: quote(),
      authorizationId: "authorization-1",
      completedProviderCalls: 37,
    });
    const port = createPort({ cancelRun: vi.fn(() => Promise.resolve(stopped)) });

    render(
      <NovelSkillPaidEvaluationPanel
        expertMode
        targets={TARGETS}
        port={port}
        initialSnapshot={snapshot({
          phase: "running_active",
          runId: "run-1",
          quote: quote(),
          authorizationId: "authorization-1",
          completedProviderCalls: 37,
        })}
      />,
    );

    expect(screen.getByText("37 / 192")).toBeVisible();
    expect(screen.getByText("0 / 2,496")).toBeVisible();
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消并停止后续调用" }));

    expect(port.cancelRun).toHaveBeenCalledWith({ runId: "run-1" });
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
    expect(await screen.findByText("运行已停止，需要人工核对")).toBeVisible();
    expect(screen.getByText(/为避免重复计费.+不会自动重发/u)).toBeVisible();
  });

  it("keeps cancellation available while an explicitly started run is still pending", async () => {
    const user = userEvent.setup();
    const pendingStart = deferred<NovelSkillPaidEvaluationSnapshot>();
    const running = snapshot({
      phase: "running_active",
      runId: "run-1",
      quote: quote(),
      authorizationId: "authorization-1",
      completedProviderCalls: 1,
    });
    const stopped = snapshot({
      ...running,
      phase: "invalidated_ambiguous",
    });
    const port = createPort({
      startAuthorizedRun: vi.fn<NovelSkillPaidEvaluationPanelPort["startAuthorizedRun"]>(
        ({ onProgress }) => {
          onProgress(running);
          return pendingStart.promise;
        },
      ),
      cancelRun: vi.fn(() => Promise.resolve(stopped)),
    });

    render(
      <NovelSkillPaidEvaluationPanel
        expertMode
        targets={TARGETS}
        port={port}
        initialSnapshot={snapshot({
          phase: "authorized_not_started",
          runId: "run-1",
          quote: quote(),
          authorizationId: "authorization-1",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "手动开始 192 次付费调用" }));
    const cancelButton = await screen.findByRole("button", { name: "取消并停止后续调用" });
    expect(cancelButton).toBeEnabled();

    await user.click(cancelButton);
    expect(port.cancelRun).toHaveBeenCalledWith({ runId: "run-1" });
    expect(await screen.findByText("运行已停止，需要人工核对")).toBeVisible();

    pendingStart.resolve(stopped);
    await waitFor(() => expect(port.startAuthorizedRun).toHaveBeenCalledTimes(1));
  });

  it("keeps blind items anonymous and seals exactly 13 manual scores", async () => {
    const user = userEvent.setup();
    const blindReview = snapshot({
      phase: "blind_reviewing",
      runId: "run-1",
      quote: quote(),
      authorizationId: "authorization-1",
      completedProviderCalls: 192,
      sealedManualScores: 13,
      blindItem: {
        blindItemId: "blind-2",
        randomizedPosition: 2,
        boundaries: ["不得改变既定视角"],
        lockedFacts: ["来信仍未拆封"],
        requestedOutcome: "推进当前场景",
        fixtureLabel: "续写任务 · 匿名材料 02",
        candidateText: "雨点敲在窗沿，她把没有寄出的信重新折好。",
      },
    });
    const nextBlindReview = snapshot({
      ...blindReview,
      sealedManualScores: 26,
      blindItem: {
        blindItemId: "blind-3",
        randomizedPosition: 3,
        boundaries: ["不得改变既定视角"],
        lockedFacts: ["来信仍未拆封"],
        requestedOutcome: "推进当前场景",
        fixtureLabel: "续写任务 · 匿名材料 03",
        candidateText: "门外的脚步停了片刻。",
      },
    });
    const sealBlindScores = vi.fn<NovelSkillPaidEvaluationPanelPort["sealBlindScores"]>(() =>
      Promise.resolve(nextBlindReview),
    );
    const port = createPort({ sealBlindScores });

    render(
      <NovelSkillPaidEvaluationPanel
        expertMode
        targets={TARGETS}
        port={port}
        initialSnapshot={blindReview}
      />,
    );

    expect(screen.getByText("192 / 192")).toBeVisible();
    expect(screen.getByText("13 / 2,496")).toBeVisible();
    expect(screen.getByText("不得改变既定视角")).toBeVisible();
    expect(screen.getByText("来信仍未拆封")).toBeVisible();
    expect(screen.getByText("推进当前场景")).toBeVisible();
    expect(screen.getByText("匿名样本 2 / 192")).toBeVisible();
    expect(screen.getByText("模型与实验分组已隐藏")).toBeVisible();
    expect(screen.queryByText(/deepseek-v4-flash/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/gpt-writing-2026-08/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/no_skill|core_genre/u)).not.toBeInTheDocument();

    const scoreFields = screen.getAllByRole("combobox");
    expect(scoreFields).toHaveLength(13);
    for (const field of scoreFields) await user.selectOptions(field, "1");
    await user.click(screen.getByRole("button", { name: "封存本项 13 个评分" }));

    expect(sealBlindScores).toHaveBeenCalledTimes(1);
    const submitted = sealBlindScores.mock.calls[0]?.[0];
    expect(submitted?.runId).toBe("run-1");
    expect(submitted?.blindItemId).toBe("blind-2");
    expect(Object.keys(submitted?.scores ?? {})).toHaveLength(13);
    expect(Object.values(submitted?.scores ?? {})).toEqual(Array.from({ length: 13 }, () => 1));
    expect(await screen.findByText("26 / 2,496")).toBeVisible();
    expect(screen.getByText("匿名样本 3 / 192")).toBeVisible();
  });

  it("keeps failures visible and never turns a failed preflight into an automatic start", async () => {
    const user = userEvent.setup();
    const rawMessage = "Model B Candidate invocation price is missing";
    const port = createPort({
      prepareAndQuote: vi.fn(() => Promise.reject(new Error(rawMessage))),
    });

    render(<NovelSkillPaidEvaluationPanel expertMode targets={TARGETS} port={port} />);
    await user.selectOptions(screen.getByLabelText("模型 A"), "target-a");
    await user.selectOptions(screen.getByLabelText("模型 B"), "target-b");
    await user.click(screen.getByRole("button", { name: "生成本地预检报价" }));

    expect(await screen.findByText("这一步没有完成")).toBeVisible();
    expect(screen.getByText(/发生了未预期的本地错误/u)).toBeVisible();
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
    expect(screen.getByText(/系统不会自动调用或重发/u)).toBeVisible();
    expect(port.authorizeCommercialRun).not.toHaveBeenCalled();
    expect(port.startAuthorizedRun).not.toHaveBeenCalled();
  });
});

function createPort(
  overrides: Partial<NovelSkillPaidEvaluationPanelPort> = {},
): NovelSkillPaidEvaluationPanelPort {
  return {
    prepareAndQuote: vi.fn(() => Promise.resolve(snapshot())),
    authorizeCommercialRun: vi.fn(() => Promise.resolve(snapshot())),
    startAuthorizedRun: vi.fn(() => Promise.resolve(snapshot())),
    cancelRun: vi.fn(() => Promise.resolve(snapshot())),
    beginBlindReview: vi.fn(() => Promise.resolve(snapshot())),
    sealBlindScores: vi.fn(() => Promise.resolve(snapshot())),
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function expectEveryPortMethodToHaveNoCalls(port: NovelSkillPaidEvaluationPanelPort): void {
  expect(port.prepareAndQuote).not.toHaveBeenCalled();
  expect(port.authorizeCommercialRun).not.toHaveBeenCalled();
  expect(port.startAuthorizedRun).not.toHaveBeenCalled();
  expect(port.cancelRun).not.toHaveBeenCalled();
  expect(port.beginBlindReview).not.toHaveBeenCalled();
  expect(port.sealBlindScores).not.toHaveBeenCalled();
}

function snapshot(
  overrides: Partial<NovelSkillPaidEvaluationSnapshot> = {},
): NovelSkillPaidEvaluationSnapshot {
  return {
    phase: "not_prepared",
    runId: null,
    quote: null,
    authorizationId: null,
    completedProviderCalls: 0,
    sealedManualScores: 0,
    blindItem: null,
    ...overrides,
  };
}

function quote() {
  return {
    quoteId: "quote-1",
    exactTargetIds: ["target-a", "target-b"] as const,
    currencies: [
      {
        currencyCode: "USD",
        estimatedCostMicros: 2_000_000,
        hardCeilingMicros: 3_000_000,
      },
      {
        currencyCode: "CNY",
        estimatedCostMicros: 14_000_000,
        hardCeilingMicros: 21_000_000,
      },
    ],
  };
}
