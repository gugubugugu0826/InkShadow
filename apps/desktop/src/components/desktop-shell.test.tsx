import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { runGenerationPreflight } from "@inkshadow/ai-core";
import { parseIsoUtcTimestamp } from "@inkshadow/domain";

import {
  recordSafeGenerationPreflightDiagnostic,
  recordSafeGenerationPreflightFailureDiagnostic,
} from "../infrastructure/generation-preflight-diagnostics";
import { MODEL_HUB_READINESS_REFRESH_INTERVAL_MS } from "../infrastructure/model-hub-readiness";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { DesktopShell } from "./desktop-shell";

const projectId = "019f9f4a-b3c7-7350-9226-000000000210";
const chapterId = "019f9f4a-b3c7-7350-9226-000000000211";

function RouteHeading() {
  const location = useLocation();
  const title = location.pathname.endsWith("/outline") ? "规划页面标题" : "项目页面标题";

  return (
    <>
      <h1>{title}</h1>
      <output data-testid="current-route">{location.pathname}</output>
    </>
  );
}

function renderShell(
  route: string,
  runtime: DesktopRuntime = createDevelopmentRuntime(window.localStorage),
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <DesktopShell>
          <RouteHeading />
        </DesktopShell>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

describe("DesktopShell", () => {
  it("shows only the four plain-language project areas on project subpages", () => {
    renderShell(`/projects/${projectId}/chapters/chapter-id`);

    const projectNavigation = screen.getByRole("group", { name: "当前项目" });
    const projectLinks = within(projectNavigation).getAllByRole("link");
    const bodyLink = within(projectNavigation).getByRole("link", { name: "正文" });
    expect(projectLinks).toHaveLength(4);
    expect(bodyLink).toHaveAttribute("href", `/projects/${projectId}`);
    expect(bodyLink).toHaveAttribute("aria-current", "page");
    expect(within(projectNavigation).getByRole("link", { name: "规划" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/outline`,
    );
    expect(within(projectNavigation).getByRole("link", { name: "设定" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/story`,
    );
    expect(within(projectNavigation).getByRole("link", { name: "检查" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/checks`,
    );
    expect(screen.queryByRole("link", { name: "项目搜索" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "故事关系图" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "多智能体审查" })).not.toBeInTheDocument();

    const globalNavigation = screen.getByLabelText("全局导航");
    expect(within(globalNavigation).getAllByRole("link")).toHaveLength(2);
    expect(within(globalNavigation).getByRole("link", { name: "创作首页" })).toHaveAttribute(
      "href",
      "/start",
    );
    expect(within(globalNavigation).getByRole("link", { name: "作品库" })).toHaveAttribute(
      "href",
      "/projects",
    );
    const toolNavigation = screen.getByLabelText("工具导航");
    expect(within(toolNavigation).getAllByRole("link")).toHaveLength(4);
    expect(within(toolNavigation).getByRole("link", { name: "任务与通知" })).toHaveAttribute(
      "href",
      "/tasks",
    );
    expect(within(toolNavigation).getByRole("link", { name: "调用与费用" })).toHaveAttribute(
      "href",
      "/usage",
    );
    expect(within(toolNavigation).getByRole("link", { name: "Model Hub" })).toHaveAttribute(
      "href",
      "/settings#model-center",
    );
    expect(within(toolNavigation).getByRole("link", { name: "设置" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("link", { name: "社区模板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "团队与权限" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导航" })).toHaveAttribute(
      "aria-controls",
      "desktop-primary-navigation",
    );
  });

  it("updates the document title and moves focus to the new route heading", async () => {
    const user = userEvent.setup();
    renderShell(`/projects/${projectId}`);
    expect(document.title).toBe("正文 · InkShadow 墨影");

    await user.click(screen.getByRole("link", { name: "规划" }));

    await waitFor(() => {
      expect(document.title).toBe("规划 · InkShadow 墨影");
      expect(screen.getByRole("heading", { name: "规划页面标题" })).toHaveFocus();
    });
  });

  it("distinguishes Model Hub from general settings when the hash route is active", () => {
    renderShell("/settings#model-center");

    expect(document.title).toBe("Model Hub · InkShadow 墨影");
    expect(screen.getByRole("link", { name: "Model Hub" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "设置" })).not.toHaveAttribute("aria-current");
  });

  it("does not advertise shallow basic readiness when exact continuation inspection is blocked", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const connection = await runtime.modelHub.saveConnection({
      id: "shell-readiness",
      providerKind: "custom_openai_compatible",
      displayName: "Shell readiness",
      baseUrlOverride: "https://models.example/v1",
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await runtime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    await runtime.modelHub.syncCatalog({
      syncId: "shell-readiness-sync",
      connectionId: connection.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "shell-readiness-model",
          providerModelId: "writer",
          lifecycle: "stable",
          inputTokenLimit: 32_000,
          outputTokenLimit: 8_000,
          staleAfter: "2027-08-10T00:00:00.000Z",
        },
      ],
    });
    for (const task of ["prose_generation", "continuation", "rewrite", "polish"] as const) {
      await runtime.modelHub.saveTaskRoute({
        task,
        primaryCatalogEntryId: "shell-readiness-model",
        privacyPolicy: "cloud_allowed",
        failurePolicy: "stop",
        routeOrigin: "user",
        expectedRevision: null,
      });
    }

    const rendered = renderShell("/start", runtime);
    const status = rendered.container.querySelector(".desktop-topbar__ai-status");
    if (!(status instanceof HTMLElement)) throw new Error("Expected the AI status link.");
    await waitFor(() => {
      expect(status).toHaveTextContent("AI 部分能力不可用");
    });
  });

  it("refreshes authoritative readiness when catalog evidence expires without a store mutation", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let now = development.clock.now();
    const generate = vi.fn(() =>
      Promise.reject(new Error("readiness inspection must not dispatch")),
    );
    const runtime: DesktopRuntime = {
      ...development,
      clock: Object.freeze({ now: () => now }),
      modelGateway: Object.freeze({
        available: true,
        checkConnection: () => Promise.reject(new Error("not used")),
        listModels: () => Promise.reject(new Error("not used")),
        generate,
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      }),
    };
    await seedBaseWritingConfiguration(runtime);
    now = development.clock.now();
    let scheduledRefresh: (() => void) | null = null;
    const nativeSetInterval = window.setInterval.bind(window);
    const interceptedTimer = nativeSetInterval(() => undefined, 2_147_483_647);
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((
      handler: Parameters<typeof setInterval>[0],
      delay: Parameters<typeof setInterval>[1],
    ) => {
      if (delay === MODEL_HUB_READINESS_REFRESH_INTERVAL_MS && typeof handler === "function") {
        scheduledRefresh = handler as () => void;
        return interceptedTimer as unknown as ReturnType<typeof setInterval>;
      }
      return nativeSetInterval(handler, delay) as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    const rendered = renderShell("/start", runtime);
    const status = rendered.container.querySelector(".desktop-topbar__ai-status");
    if (!(status instanceof HTMLElement)) throw new Error("Expected the AI status link.");
    await waitFor(() =>
      expect(status).toHaveAccessibleName(expect.stringMatching(/当前 10 \/ 10/u)),
    );
    expect(scheduledRefresh).not.toBeNull();

    const expiredNow = parseIsoUtcTimestamp("2100-08-14T00:00:00.000Z");
    if (!expiredNow.ok) throw expiredNow.error;
    now = expiredNow.value;
    await act(async () => {
      scheduledRefresh?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(status).toHaveAccessibleName(expect.stringMatching(/当前 0 \/ 10/u)),
    );
    expect(generate).not.toHaveBeenCalled();

    rendered.unmount();
    intervalSpy.mockRestore();
  });

  it("replaces base-connection copy with the current chapter blocker and restores it after success", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    await seedBaseWritingConfiguration(development);
    const generate = vi.fn(() => Promise.reject(new Error("status inspection must not dispatch")));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      modelGateway: {
        available: true,
        checkConnection: () => Promise.reject(new Error("not used")),
        listModels: () => Promise.reject(new Error("not used")),
        generate,
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const rendered = renderShell(`/projects/${projectId}/chapters/${chapterId}`, runtime);
    const status = rendered.container.querySelector(".desktop-topbar__ai-status");
    if (!(status instanceof HTMLElement)) throw new Error("Expected the AI status link.");
    await waitFor(() => expect(status).toHaveTextContent("AI 基础连接可用"));

    recordSafeGenerationPreflightFailureDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: true,
      blockerCode: "PRIVATE_CHAPTER_LOCAL_ONLY",
      checkedAt: runtime.clock.now(),
      scope: { projectId, chapterId },
    });

    await waitFor(() => expect(status).toHaveTextContent("当前续写需修复"));
    expect(status).not.toHaveTextContent("AI 基础连接可用");
    expect(status).toHaveAttribute("href", "/settings#model-center");
    expect(status).toHaveAccessibleName(
      expect.stringMatching(
        /续写受影响.*隐私规则.*当前章节明确调整隐私.*本地模型.*正文、不可变版本和隔离建议均未改变/u,
      ),
    );

    recordSafeGenerationPreflightFailureDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: true,
      blockerCode: "MODEL_CONTEXT_WINDOW_EXHAUSTED",
      checkedAt: runtime.clock.now(),
      scope: { projectId, chapterId: "another-chapter" },
    });
    expect(status).toHaveTextContent("当前续写需修复");

    recordSafeGenerationPreflightFailureDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: true,
      blockerCode: "MODEL_CONTEXT_WINDOW_EXHAUSTED",
      checkedAt: runtime.clock.now(),
      scope: { projectId, chapterId },
    });
    await waitFor(() =>
      expect(status).toHaveAccessibleName(
        expect.stringMatching(/输出长度.*超过模型窗口.*缩短输出或上下文/u),
      ),
    );

    recordSafeGenerationPreflightFailureDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: true,
      blockerCode: "STORY_CONTEXT_COMPILATION_FAILED",
      checkedAt: runtime.clock.now(),
      scope: { projectId, chapterId },
    });
    await waitFor(() => expect(status).toHaveAttribute("href", `/projects/${projectId}/context`));
    expect(status).toHaveAccessibleName(
      expect.stringMatching(/上下文未能安全整理.*本次参考.*正文、不可变版本和隔离建议均未改变/u),
    );

    recordSafeGenerationPreflightDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: true,
      connectionUsable: true,
      capabilityStatus: "supported",
      snapshot: readyPreflight(runtime.clock.now()),
      scope: { projectId, chapterId },
    });
    await waitFor(() => expect(status).toHaveTextContent("AI 基础连接可用"));
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps direct legacy tools under the check area without exposing extra navigation", () => {
    renderShell(`/projects/${projectId}/graph`);

    const projectNavigation = screen.getByRole("group", { name: "当前项目" });
    expect(within(projectNavigation).getAllByRole("link")).toHaveLength(4);
    expect(within(projectNavigation).getByRole("link", { name: "检查" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("link", { name: "故事关系图" })).not.toBeInTheDocument();
  });

  it("lets desktop users collapse and restore the navigation rail", async () => {
    const user = userEvent.setup();
    const rendered = renderShell(`/projects/${projectId}`);
    const shell = rendered.container.querySelector(".ink-app-shell");

    await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(shell).toHaveAttribute("data-navigation-collapsed", "true");
    expect(screen.getByRole("link", { name: "作品库" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "正文" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "规划" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设定" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "检查" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(shell).not.toHaveAttribute("data-navigation-collapsed");
  });

  it("maps team review routes and exposes live network status", () => {
    renderShell(`/teams/team-id/projects/${projectId}/reviews`);

    expect(document.title).toBe("团队内容审阅 · InkShadow 墨影");
    const networkStatus = screen.getByText("网络可用");
    expect(networkStatus).toHaveAttribute("role", "status");
    expect(networkStatus).toHaveAttribute("aria-live", "polite");
    expect(networkStatus).toHaveAttribute("aria-atomic", "true");
  });

  it("opens Ctrl+K, filters commands, navigates and returns focus on Escape", async () => {
    const user = userEvent.setup();
    renderShell(`/projects/${projectId}`);
    const trigger = screen.getByRole("button", { name: "搜索页面与命令" });

    trigger.focus();
    await user.keyboard("{Control>}k{/Control}");
    const search = screen.getByRole("searchbox", { name: "搜索命令" });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    await user.keyboard("任务");
    expect(search).toHaveAttribute("aria-activedescendant", "command-tasks");
    expect(screen.getByRole("button", { name: /任务与通知/u })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("current-route")).toHaveTextContent("/tasks");
    });
    expect(screen.queryByRole("dialog", { name: "快速前往" })).not.toBeInTheDocument();

    trigger.focus();
    await user.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("searchbox", { name: "搜索命令" })).toHaveFocus();
    });
    expect(screen.getByRole("searchbox", { name: "搜索命令" })).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("searches real chapters and people alongside writing, AI and export commands", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const projectResult = await runtime.useCases.createProject.execute({ name: "命令搜索作品" });
    if (!projectResult.ok) throw projectResult.error;
    const project = projectResult.value;
    const chapterResult = await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "唯一灯塔章节",
      content: "林遥走进灯塔。",
    });
    if (!chapterResult.ok) throw chapterResult.error;
    const chapter = chapterResult.value.chapter;
    const factResult = await runtime.story.factService.createFormalUserFact({
      projectId: project.id,
      factType: "character_identity",
      contentText: "林遥",
      structuredValue: { name: "林遥", subjectKind: "character" },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!factResult.ok) throw factResult.error;

    const user = userEvent.setup();
    renderShell(`/projects/${project.id}`, runtime);
    const trigger = screen.getByRole("button", { name: "搜索页面与命令" });

    await user.click(trigger);
    let search = screen.getByRole("searchbox", { name: "搜索命令" });
    await user.type(search, "唯一灯塔");
    const chapterCommand = await screen.findByRole("button", { name: /章节：唯一灯塔章节/u });
    expect(chapterCommand).toHaveTextContent("写作");
    await user.click(chapterCommand);
    await waitFor(() => {
      expect(screen.getByTestId("current-route")).toHaveTextContent(
        `/projects/${project.id}/chapters/${chapter.id}`,
      );
    });

    await user.click(trigger);
    search = screen.getByRole("searchbox", { name: "搜索命令" });
    await user.type(search, "林遥");
    const characterCommand = await screen.findByRole("button", { name: /人物：林遥/u });
    await user.click(characterCommand);
    await waitFor(() => {
      expect(screen.getByTestId("current-route")).toHaveTextContent(
        `/projects/${project.id}/story`,
      );
    });

    await user.click(trigger);
    search = screen.getByRole("searchbox", { name: "搜索命令" });
    expect(screen.getByRole("button", { name: /生成小说配图/u })).toBeInTheDocument();
    await user.type(search, "PDF");
    expect(screen.getByRole("button", { name: /导出作品/u })).toHaveTextContent("导出");
  });
});

async function seedBaseWritingConfiguration(
  runtime: DesktopRuntime,
  staleAfter = "2099-08-13T00:00:00.000Z",
): Promise<void> {
  let connection = await runtime.modelHub.saveConnection({
    id: "shell-base-ready",
    providerKind: "custom_openai_compatible",
    displayName: "Shell base ready",
    baseUrlOverride: "https://models.example/v1",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  connection = await runtime.modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  const catalog = await runtime.modelHub.syncCatalog({
    syncId: "shell-base-ready-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "shell-base-ready-model",
        providerModelId: "writer",
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter,
      },
    ],
  });
  const model = catalog[0];
  if (model === undefined) throw new Error("Expected a catalog entry.");
  await runtime.modelHub.recordCapabilityScan({
    scanId: "shell-base-ready-evidence",
    catalogEntryId: model.id,
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "shell-base-ready-v1",
    evidence: [
      {
        id: "shell-base-ready-text",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
      {
        id: "shell-base-ready-structured",
        capability: "structured_output",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await runtime.modelHub.saveCostPrivacyProfile({
    catalogEntryId: model.id,
    currency: "USD",
    inputMicrosPerMillionTokens: "1000",
    outputMicrosPerMillionTokens: "2000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "shell-base-ready-v1",
    priceUpdatedAt: runtime.clock.now(),
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "shell-base-ready-v1",
    expectedRevision: null,
  });
  for (const task of [
    "prose_generation",
    "continuation",
    "rewrite",
    "polish",
    "chapter_summary",
    "long_memory_compression",
    "contradiction_check",
    "pov_check",
    "character_voice_check",
    "content_quality_check",
  ] as const) {
    await runtime.modelHub.saveTaskRoute({
      task,
      primaryCatalogEntryId: model.id,
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
  }
}

function readyPreflight(now: string) {
  return runGenerationPreflight({
    now,
    migrationReady: true,
    chapterExists: true,
    chapterSaved: true,
    projectWritable: true,
    gatewayAvailable: true,
    networkAvailable: true,
    providerLocation: "remote",
    routeResolved: true,
    profileConfigured: true,
    modelSelected: true,
    credentialConfigured: true,
    connectionStatus: "verified",
    selectedModelAvailable: true,
    inputBytes: 1_000,
    maximumInputBytes: 1_000_000,
    inputTokens: 300,
    maximumOutputTokens: 1_000,
    contextWindowTokens: 32_000,
    tokenizerStatus: "approximate",
    pricing: null,
    budgets: [],
  });
}
