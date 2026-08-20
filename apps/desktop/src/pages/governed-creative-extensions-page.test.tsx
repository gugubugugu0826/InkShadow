import type { GovernedExtensionCandidate, GovernedExtensionRequest } from "@inkshadow/data";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  GovernedCreativeExtensionPreflight,
  GovernedCreativeExtensionSource,
} from "../infrastructure/governed-creative-extensions-runtime";
import {
  GovernedCreativeExtensionsPage,
  type GovernedCreativeExtensionsPageRuntime,
} from "./governed-creative-extensions-page";

const NOW = "2026-07-28T10:00:00.000Z";
const PROJECT_ID = "019fa025-0000-7000-8000-000000000001";
const CHAPTER_ID = "019fa025-0000-7000-8000-000000000002";
const VERSION_ID = "019fa025-0000-7000-8000-000000000003";
const REQUEST_ID = "019fa025-0000-7000-8000-000000000004";
const CANDIDATE_ID = "019fa025-0000-7000-8000-000000000005";
const SOURCE_CHECKSUM = "a".repeat(64);
const PARAGRAPH_CHECKSUM = "b".repeat(64);

describe("GovernedCreativeExtensionsPage", () => {
  it("keeps failed history and export available while the feature flag is off", async () => {
    const exportSpy = vi.fn();
    const request = requestFixture({
      status: "failed_final",
      usage: {
        source: "provider_unavailable",
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        calculatedCostMicros: 120,
        providerReceiptDigest: null,
      },
      errorCode: "EXTENSION_USAGE_UNAVAILABLE",
    });
    const runtime = runtimeFixture({
      flags: { translation: false, shortDrama: false },
      preflight: preflightFixture({ ready: false, featureBlocked: true }),
      requests: [request],
    });

    render(
      <GovernedCreativeExtensionsPage
        runtime={runtime}
        projectId={PROJECT_ID}
        source={sourceFixture()}
        onExportHistory={exportSpy}
      />,
    );

    expect(await screen.findByText("翻译服务尚未启用")).toBeInTheDocument();
    expect((await screen.findAllByText("Token 用量未知")).length).toBeGreaterThan(0);
    expect(screen.getByText(/供应商没有返回可核对的用量/u)).toBeInTheDocument();
    expect(screen.queryByText(/EXTENSION_USAGE_UNAVAILABLE/u)).not.toBeInTheDocument();
    const generate = await screen.findByRole("button", { name: "生成隔离候选" });
    expect(generate).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "导出历史" }));
    await waitFor(() => expect(runtime.exportHistory).toHaveBeenCalledWith(PROJECT_ID));
    expect(exportSpy).toHaveBeenCalledWith(
      "inkshadow-history.json",
      expect.stringContaining("internal_estimate"),
    );
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("discloses the exact remote destination and cannot run before explicit one-time confirmation", async () => {
    let didRun = false;
    const candidate = candidateFixture();
    const readyRequest = requestFixture({
      status: "candidate_ready",
      candidateId: candidate.id,
      usage: providerUsage(),
    });
    const remote = preflightFixture({ remote: true, ready: true });
    const runtime = runtimeFixture({
      flags: { translation: true, shortDrama: false },
      preflight: remote,
      onRun: (prepared, options) => {
        didRun = true;
        expect(prepared.requestFingerprint).toBe(remote.requestFingerprint);
        expect(options?.consentToken).toBe("caller-memory-only-token");
        options?.onRequestStarted?.(
          requestFixture({ status: "running", candidateId: null, usage: null }),
        );
        return Promise.resolve({ request: readyRequest, candidate, replayed: false });
      },
      historyAfterRun: {
        requests: [readyRequest],
        candidates: [candidate],
      },
    });

    render(
      <GovernedCreativeExtensionsPage
        runtime={runtime}
        projectId={PROJECT_ID}
        source={sourceFixture()}
      />,
    );

    expect(await screen.findByText("https://provider.example/v1")).toBeInTheDocument();
    expect(screen.getByText("remote-provider / translation-v1")).toBeInTheDocument();
    expect(screen.queryByText(PROJECT_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(VERSION_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(SOURCE_CHECKSUM)).not.toBeInTheDocument();
    expect(screen.queryByText(remote.requestFingerprint)).not.toBeInTheDocument();
    const blockedRun = screen.getByRole("button", { name: "先确认远程发送" });
    expect(blockedRun).toBeDisabled();
    expect(runtime.run).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /我确认将所列数据发送到上述精确地址、服务方和模型/u,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "创建一次性确认" }));
    await waitFor(() => expect(runtime.confirmRemoteEgress).toHaveBeenCalledWith(remote));
    const enabledRun = await screen.findByRole("button", { name: "生成隔离候选" });
    expect(enabledRun).toBeEnabled();

    await userEvent.click(enabledRun);
    await waitFor(() => expect(didRun).toBe(true));
    expect(await screen.findByText("Rain fell on the bluestone road.")).toBeInTheDocument();
    expect(screen.getByText(/隔离候选已就绪/u)).toBeInTheDocument();
  });

  it("runs an explicit loopback route without creating remote consent", async () => {
    const local = preflightFixture({ remote: false, ready: true });
    const runtime = runtimeFixture({
      flags: { translation: true, shortDrama: false },
      preflight: local,
    });
    render(
      <GovernedCreativeExtensionsPage
        runtime={runtime}
        projectId={PROJECT_ID}
        source={sourceFixture()}
      />,
    );

    expect(await screen.findByText("http://127.0.0.1:11434/v1")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "生成隔离候选" }));
    await waitFor(() => expect(runtime.run).toHaveBeenCalled());
    expect(runtime.confirmRemoteEgress).not.toHaveBeenCalled();
    const runCall = vi.mocked(runtime.run).mock.calls[0];
    expect(runCall?.[0]).toBe(local);
    expect(runCall?.[1]?.consentToken).toBeUndefined();
  });

  it("renders an isolated translation diff and requires an explicit accept decision", async () => {
    const candidate = candidateFixture();
    const request = requestFixture({
      status: "candidate_ready",
      candidateId: candidate.id,
      usage: providerUsage(),
    });
    const runtime = runtimeFixture({
      flags: { translation: true, shortDrama: false },
      requests: [request],
      candidates: [candidate],
    });
    render(
      <GovernedCreativeExtensionsPage
        runtime={runtime}
        projectId={PROJECT_ID}
        source={sourceFixture()}
      />,
    );

    expect(await screen.findByText("雨落在青石路上。")).toBeInTheDocument();
    expect(screen.getByText("Rain fell on the bluestone road.")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("450")).toBeInTheDocument();
    expect(runtime.acceptCandidate).not.toHaveBeenCalled();

    const decisionSurface = screen.getByLabelText("受治理创意成果候选决策");
    expect(decisionSurface).toHaveClass("candidate-decision-surface");
    expect(screen.getByLabelText("受治理创意成果候选内容")).toHaveAttribute("tabindex", "0");
    expect(decisionSurface.querySelector(":scope > .ink-card__footer")).toHaveClass(
      "candidate-decision-actions",
    );

    await userEvent.click(screen.getByRole("button", { name: "采纳为独立成果" }));
    await waitFor(() =>
      expect(runtime.acceptCandidate).toHaveBeenCalledWith(candidate.id, candidate.revision),
    );
    expect(await screen.findByText(/原章节与大纲保持不变/u)).toBeInTheDocument();
  });

  it("exposes the structured short-drama settings as a separate service tab", async () => {
    const runtime = runtimeFixture({
      flags: { translation: true, shortDrama: true },
    });
    render(
      <GovernedCreativeExtensionsPage
        runtime={runtime}
        projectId={PROJECT_ID}
        source={sourceFixture()}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "短剧改编" }));
    expect(await screen.findByText("短剧设置")).toBeInTheDocument();
    expect(screen.getByLabelText("成片格式")).toHaveValue("vertical_micro_drama");
    expect(screen.getByLabelText("目标集数")).toHaveValue(1);
    expect(screen.getByLabelText("单集时长（秒）")).toHaveValue(90);
    await waitFor(() => {
      const dramaCall = vi
        .mocked(runtime.preflight)
        .mock.calls.find(([draft]) => draft.kind === "short_drama");
      expect(dramaCall).toBeDefined();
      const dramaDraft = dramaCall?.[0];
      expect(dramaDraft?.kind).toBe("short_drama");
      if (dramaDraft?.kind === "short_drama") {
        expect(dramaDraft.settings.targetEpisodeCount).toBe(1);
        expect(dramaDraft.settings.targetEpisodeDurationSeconds).toBe(90);
      }
    });
  });
});

function runtimeFixture(
  options: {
    readonly flags?: { readonly translation: boolean; readonly shortDrama: boolean };
    readonly preflight?: GovernedCreativeExtensionPreflight;
    readonly requests?: readonly GovernedExtensionRequest[];
    readonly candidates?: readonly GovernedExtensionCandidate[];
    readonly onRun?: GovernedCreativeExtensionsPageRuntime["run"];
    readonly historyAfterRun?: {
      readonly requests: readonly GovernedExtensionRequest[];
      readonly candidates: readonly GovernedExtensionCandidate[];
    };
  } = {},
): GovernedCreativeExtensionsPageRuntime {
  let calls = 0;
  const requests = options.requests ?? [];
  const candidates = options.candidates ?? [];
  const prepared = options.preflight ?? preflightFixture({ ready: true });
  const defaultRun: GovernedCreativeExtensionsPageRuntime["run"] = () =>
    Promise.resolve({
      request: requestFixture({ status: "cancelled", usage: unavailableUsage() }),
      candidate: null,
      replayed: false,
    });
  const runImplementation = options.onRun ?? defaultRun;
  return {
    getCapabilities: vi.fn(() => ({
      flags: options.flags ?? { translation: true, shortDrama: true },
      environment: { online: true, readOnly: false },
    })),
    listHistory: vi.fn(() => {
      calls += 1;
      if (calls > 1 && options.historyAfterRun !== undefined) {
        return Promise.resolve(options.historyAfterRun);
      }
      return Promise.resolve({ requests, candidates });
    }),
    preflight: vi.fn(() => Promise.resolve(prepared)),
    confirmRemoteEgress: vi.fn(() =>
      Promise.resolve({
        token: "caller-memory-only-token",
        receiptDigest: "c".repeat(64),
        scopeFingerprint: "d".repeat(64),
        expiresAt: "2026-07-28T10:01:00.000Z",
      }),
    ),
    run: vi.fn(runImplementation),
    cancel: vi.fn(() =>
      Promise.resolve(requestFixture({ status: "cancelled", usage: unavailableUsage() })),
    ),
    prepareRetry: vi.fn(() =>
      Promise.resolve({
        ...prepared,
        retry: { previousRequestId: REQUEST_ID, attempt: 2 },
      }),
    ),
    acceptCandidate: vi.fn(() =>
      Promise.resolve({
        outcome: "accepted" as const,
        candidate: { ...candidateFixture(), status: "accepted" as const, revision: 2 },
        formalOutputId: "019fa025-0000-7000-8000-000000000099",
      }),
    ),
    rejectCandidate: vi.fn(() =>
      Promise.resolve({
        ...candidateFixture(),
        status: "rejected" as const,
        revision: 2,
      }),
    ),
    exportHistory: vi.fn(() =>
      Promise.resolve({
        filename: "inkshadow-history.json",
        content: '{"costSemantics":"internal_estimate"}',
      }),
    ),
  };
}

function preflightFixture(options: {
  readonly ready: boolean;
  readonly remote?: boolean;
  readonly featureBlocked?: boolean;
}): GovernedCreativeExtensionPreflight {
  const remote = options.remote ?? false;
  return {
    snapshot: {
      schemaVersion: 1,
      kind: "translation",
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: SOURCE_CHECKSUM,
      sourceText: sourceFixture().sourceText,
      settings: {
        targetLanguage: { code: "en-US", label: "English (US)" },
        tone: "literary",
        glossaryVersion: "glossary-v1",
        glossary: [],
      },
      provider: {
        location: remote ? "remote" : "loopback",
        providerId: remote ? "remote-provider" : "local-provider",
        baseUrl: remote ? "https://provider.example/v1" : "http://127.0.0.1:11434/v1",
        modelId: "translation-v1",
      },
      dataCategories: ["chapter_text", "glossary", "translation_settings"],
      pricing: {
        inputMicrosPerMillionTokens: 10_000,
        outputMicrosPerMillionTokens: 20_000,
        currency: "USD",
        priceVersion: "price-v1",
        priceUpdatedAt: NOW,
      },
      limits: {
        maximumInputTokens: 4_000,
        maximumOutputTokens: 4_000,
        timeoutMs: 30_000,
      },
    },
    requestFingerprint: "e".repeat(64),
    paragraphAuthorities: [
      {
        index: 0,
        text: sourceFixture().sourceText,
        checksum: PARAGRAPH_CHECKSUM,
      },
    ],
    checks: options.featureBlocked
      ? [
          {
            code: "EXTENSION_FEATURE_DISABLED",
            level: "blocking",
            title: "功能尚未启用",
            detail: "历史可读，服务不执行。",
          },
        ]
      : [
          {
            code: remote ? "EXTENSION_REMOTE_CONSENT_REQUIRED" : "EXTENSION_LOOPBACK_DESTINATION",
            level: remote ? "action" : "notice",
            title: remote ? "需要一次性远程发送确认" : "仅发送到本机回环服务",
            detail: "精确目的地已经披露。",
          },
        ],
    ready: options.ready,
    requiresRemoteConsent: remote,
    destination: {
      location: remote ? "remote" : "loopback",
      providerId: remote ? "remote-provider" : "local-provider",
      baseUrl: remote ? "https://provider.example/v1" : "http://127.0.0.1:11434/v1",
      modelId: "translation-v1",
      dataCategories: ["chapter_text", "glossary", "translation_settings"],
    },
    estimate: {
      estimatedInputTokens: 300,
      estimatedOutputTokens: 450,
      estimatedCostMicros: 12,
      maximumCostMicros: 120,
      currency: "USD",
      semantics: "internal_estimate",
    },
    retry: null,
  };
}

function sourceFixture(): GovernedCreativeExtensionSource {
  return {
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    sourceVersionId: VERSION_ID,
    sourceChecksum: SOURCE_CHECKSUM,
    chapterTitle: "雨夜",
    sourceText: "雨落在青石路上。",
  };
}

function requestFixture(
  overrides: Partial<GovernedExtensionRequest> = {},
): GovernedExtensionRequest {
  return {
    id: REQUEST_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    sourceVersionId: VERSION_ID,
    sourceChecksum: SOURCE_CHECKSUM,
    kind: "translation",
    attempt: 1,
    retryOfRequestId: null,
    idempotencyKey: "extension-test-key",
    requestFingerprint: "e".repeat(64),
    requestSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      sourceText: sourceFixture().sourceText,
    }),
    providerLocation: "loopback",
    providerId: "local-provider",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "translation-v1",
    dataCategories: ["chapter_text", "glossary", "translation_settings"],
    pricing: {
      inputMicrosPerMillionTokens: 10_000,
      outputMicrosPerMillionTokens: 20_000,
      currency: "USD",
      priceVersion: "price-v1",
      priceUpdatedAt: NOW,
    },
    limits: {
      maximumInputTokens: 4_000,
      maximumOutputTokens: 4_000,
      timeoutMs: 30_000,
    },
    reservedCostMicros: 120,
    status: "failed_final",
    revision: 1,
    candidateId: null,
    usage: unavailableUsage(),
    cancellationRequested: false,
    errorCode: "EXTENSION_USAGE_UNAVAILABLE",
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function candidateFixture(): GovernedExtensionCandidate {
  return {
    id: CANDIDATE_ID,
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    sourceVersionId: VERSION_ID,
    sourceChecksum: SOURCE_CHECKSUM,
    kind: "translation",
    payloadJson: JSON.stringify({
      schemaVersion: 1,
      kind: "translation",
      source: {
        chapterId: CHAPTER_ID,
        sourceVersionId: VERSION_ID,
        sourceChecksum: SOURCE_CHECKSUM,
      },
      targetLanguage: { code: "en-US", label: "English (US)" },
      tone: "literary",
      glossaryVersion: "glossary-v1",
      paragraphs: [
        {
          sourceParagraph: 0,
          sourceChecksum: PARAGRAPH_CHECKSUM,
          translatedText: "Rain fell on the bluestone road.",
          glossaryTerms: [],
        },
      ],
    }),
    payloadChecksum: "f".repeat(64),
    status: "ready",
    revision: 1,
    formalOutputId: null,
    createdAt: NOW,
    updatedAt: NOW,
    decidedAt: null,
  };
}

function providerUsage(): NonNullable<GovernedExtensionRequest["usage"]> {
  return {
    source: "provider_reported",
    inputTokens: 300,
    outputTokens: 450,
    cachedInputTokens: 0,
    calculatedCostMicros: 12,
    providerReceiptDigest: null,
  };
}

function unavailableUsage(): NonNullable<GovernedExtensionRequest["usage"]> {
  return {
    source: "provider_unavailable",
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    calculatedCostMicros: 120,
    providerReceiptDigest: null,
  };
}
