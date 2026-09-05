import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUuidV7, type UuidV7 } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { APPEARANCE_PREFERENCE_STORAGE_KEY } from "../appearance-preference";
import {
  EDITOR_PREFERENCES_CHANGED_EVENT,
  EDITOR_PREFERENCES_STORAGE_KEY,
} from "../infrastructure/editor-preferences-store";
import {
  EDITOR_TYPOGRAPHY_CHANGED_EVENT,
  EDITOR_VIEW_STATE_STORAGE_KEY,
} from "../infrastructure/editor-view-state-store";
import {
  MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY,
  saveModelHubConnectionIntent,
} from "../infrastructure/model-hub-connection-intent";
import { SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION } from "../infrastructure/selectable-model-catalog-registry";
import { NOVEL_AI_TASKS } from "../infrastructure/model-hub-provider-registry";
import { applyAutomaticModelHubRouting } from "../infrastructure/model-hub-routing-service";
import {
  BrowserDevelopmentModelHubStore,
  ModelHubStoreError,
} from "../infrastructure/model-hub-store";
import { readSafeModelHubSessionDiagnostics } from "../infrastructure/model-hub-ui-diagnostics";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
  type NativeModelGenerationInput,
} from "../infrastructure/runtime";
import { DEVELOPMENT_WRITING_EXPERIENCE_KEY } from "../infrastructure/writing-experience-store";
import { RuntimeProvider } from "../runtime-context";

function parseStoryProjectId(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function seedWritingExperience(mode: "direct" | "professional"): void {
  const timestamp = "2026-08-22T00:00:00.000Z";
  window.localStorage.setItem(
    DEVELOPMENT_WRITING_EXPERIENCE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      preference: {
        mode,
        initializationSource: "user",
        directLocalOrganizationAuthorizedAt: mode === "direct" ? timestamp : null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      grants: {},
      grantAudit: [],
    }),
  );
}

describe("SettingsPage model routing", () => {
  it("excludes failed connections from normal task choices while retaining an edit recovery path", async () => {
    const fixture = await createReadyDeepSeekProbeRuntime("failed-routing-choice");
    const connection = await fixture.runtime.modelHub.findConnection("failed-routing-choice");
    if (connection === null) throw new Error("缺少测试连接");
    await fixture.runtime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "error",
      errorCode: "MODEL_PROVIDER_UNAVAILABLE",
      errorSummary: "controlled failure",
      expectedRevision: connection.revision,
    });
    const user = userEvent.setup();
    renderRoute(fixture.runtime, "/settings?connectionId=failed-routing-choice#model-routing");
    await user.click(await screen.findByRole("button", { name: "专家设置" }));
    const primary = await screen.findByRole("combobox", { name: "主模型", hidden: true });
    await waitFor(() => expect(screen.queryByText("正在读取模型目录…")).not.toBeInTheDocument());
    expect(
      within(primary).queryByRole("option", {
        name: /deepseek-v4-flash-vision-exp|DeepSeek V4 Flash Vision/iu,
        hidden: true,
      }),
    ).not.toBeInTheDocument();
    expect(
      Array.from((primary as HTMLSelectElement).options).map(({ value }) => value),
    ).not.toContain(fixture.catalogEntryId);
    const catalogBrowser = screen.getByRole("region", { name: "可选模型目录", hidden: true });
    await user.click(within(catalogBrowser).getByText("浏览全部可选模型"));
    expect(catalogBrowser.querySelectorAll('[data-connected="true"]')).toHaveLength(0);
    expect(await fixture.runtime.modelHub.findConnection(connection.id)).toMatchObject({
      enabled: true,
      connectionStatus: "error",
    });
  });
  it("offers basic planning verification outside expert task assignments and cancels with zero sends", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("basic-planning-entry");
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "basic-planning-text",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "test-text-v1",
      evidence: [
        {
          id: "basic-planning-text-evidence",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
    const generate = vi.spyOn(prepared.runtime.modelGateway, "generate");
    const user = userEvent.setup();
    renderRoute(prepared.runtime, "/settings#model-routing");
    const missingPlanning = await waitFor(() => {
      const row = document.getElementById("model-routing-task-outline_planning");
      if (row === null) throw new Error("尚未显示缺失的规划安排");
      return row;
    });
    expect(
      await within(missingPlanning).findByRole(
        "button",
        { name: "查看验证说明", hidden: true },
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "准备大纲与规划" }));
    const confirmation = await screen.findByRole("dialog", { name: "确认 1 次模型能力检查？" });
    expect(confirmation).toHaveTextContent("结构化");
    expect(confirmation).not.toHaveTextContent("unknown");
    expect(generate).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "取消（不发送）" }));
    expect(generate).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    window.localStorage.clear();
    seedWritingExperience("professional");
  });

  it("uses a page heading and level-two headings for primary setting sections", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderRoute(runtime, "/settings");

    expect(
      await screen.findByRole("heading", { name: "全局设置", level: 1 }, { timeout: 5_000 }),
    ).toBeVisible();
    const quickJump = screen.getByRole("navigation", { name: "全局设置快速跳转" });
    expect(within(quickJump).getByText("快速跳转")).toBeVisible();
    expect(within(quickJump).queryByRole("tab")).not.toBeInTheDocument();
    expect(within(quickJump).getAllByRole("link").length).toBeGreaterThan(1);

    for (const name of [
      "外观",
      "正文阅读与自动保存",
      "写作体验",
      "数据与隐私",
      "项目 AI 记忆",
      "同步安全",
      "本地数据维护",
      "安全更新",
      "脱敏诊断包",
    ]) {
      expect(await screen.findByRole("heading", { name, level: 2 })).toBeVisible();
    }
    expect(screen.queryByRole("heading", { name: "墨影模型中心" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "创作任务安排" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "模型基础评测" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "生成小说配图" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开模型中心" })).toHaveAttribute(
      "href",
      "/settings#model-center",
    );
  });
  it("opens and focuses a model capability deep link without changing direct writing mode", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);

    renderRoute(runtime, "/settings?targetSection=model-capabilities#model-center");

    expect(
      await screen.findByRole("heading", { name: "墨影模型中心", level: 2 }, { timeout: 5_000 }),
    ).toBeVisible();
    const target = await screen.findByRole("heading", { name: "模型能力确认", level: 3 });
    await waitFor(() => expect(target).toHaveFocus());
    await expect(runtime.writingExperience.getOrInitialize()).resolves.toMatchObject({
      mode: "direct",
    });
    expect(screen.getByRole("button", { name: "收起专家设置" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("switches the authoritative writing experience without invoking a provider", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("direct");
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#writing-experience");

    const switchToProfessional = await screen.findByRole(
      "button",
      { name: "切换到专业模式" },
      { timeout: 15_000 },
    );
    expect(switchToProfessional).toBeVisible();
    expect(screen.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
    for (const name of ["外观", "备份与恢复", "写作方式"]) {
      expect(await screen.findByRole("heading", { name, level: 2 })).toBeVisible();
    }
    expect(screen.getByRole("main")).not.toHaveTextContent(
      /AI|模型|调用|上下文|路由|令牌|追踪|候选|费用|待确认/u,
    );
    await user.click(switchToProfessional);

    await waitFor(async () => {
      expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("professional");
    });
    expect(providerGenerate).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "全局设置", level: 1 })).toBeVisible();
  });

  it("does not switch an existing professional user to direct mode until the one-time authorization is confirmed", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "既有作品" });
    if (!project.ok) throw project.error;
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("professional");
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#writing-experience");

    const directMode = await screen.findByRole("button", { name: "直接写作" }, { timeout: 5_000 });
    expect(screen.getByRole("button", { name: "专业创作" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(directMode);
    expect(await screen.findByRole("dialog", { name: "启用直接模式前，请确认一次" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("professional");

    await user.click(directMode);
    await user.click(screen.getByRole("button", { name: "同意并启用直接模式" }));
    await waitFor(async () => {
      const preference = await runtime.writingExperience.getOrInitialize();
      expect(preference.mode).toBe("direct");
      expect(preference.directLocalOrganizationAuthorizedAt).not.toBeNull();
    });
    await user.click(await screen.findByRole("button", { name: "切换到专业模式" }));
    await waitFor(async () => {
      expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("professional");
    });
    await user.click(await screen.findByRole("button", { name: "撤销本地整理授权" }));
    await waitFor(async () => {
      const preference = await runtime.writingExperience.getOrInitialize();
      expect(preference).toMatchObject({
        mode: "professional",
        directLocalOrganizationAuthorizedAt: null,
      });
    });
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("finishes loading an existing professional preference and exposes both writing modes as actions", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("professional");
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    renderRoute(runtime, "/settings#writing-experience");

    const professional = await screen.findByRole(
      "button",
      { name: "专业创作" },
      { timeout: 5_000 },
    );
    expect(professional).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "直接写作" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const modeGroup = screen.getByRole("group", { name: "默认写作方式" });
    const hintId = modeGroup.getAttribute("aria-describedby");
    expect(hintId).not.toBeNull();
    expect(document.getElementById(hintId ?? "")).toHaveTextContent(
      "生成中切换只影响下一次操作；备份恢复后仍保留这个选择。",
    );
    expect(document.body).not.toHaveTextContent("正在读取本机设置");
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("keeps an exact unconnected model choice pending until connection and explicit assignment", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-routing");

    await screen.findByRole("heading", { name: "创作任务安排" }, { timeout: 5_000 });
    await user.click(screen.getByText("查看尚未配置的 22 项"));
    const taskRow = screen
      .getAllByText("正文生成")
      .find((element) => element.tagName === "STRONG")
      ?.closest("li");
    if (taskRow === null || taskRow === undefined) {
      throw new Error("Expected the prose generation task row.");
    }
    await user.click(within(taskRow).getByText(/查看可选模型/u));
    const modelRow = within(taskRow).getByText("DeepSeek V4 Flash").closest("li");
    if (modelRow === null) throw new Error("Expected the DeepSeek candidate row.");
    await user.click(within(modelRow).getByRole("button", { name: "选择并连接" }));

    expect(
      await screen.findByText(/正在为“正文生成”连接模型/u, {}, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.getByText(/deepseek-v4-flash.*原有创作任务安排不会改变/u)).toBeVisible();
    expect(
      JSON.parse(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({
      task: "prose_generation",
      providerKind: "deepseek",
      providerModelId: "deepseek-v4-flash",
    });
    await expect(runtime.modelHub.findTaskRoute("prose_generation")).resolves.toBeNull();

    await user.click(screen.getByRole("button", { name: "取消选择" }));
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).toBeNull();
    await expect(runtime.modelHub.findTaskRoute("prose_generation")).resolves.toBeNull();
  }, 10_000);

  it("opens the ordinary global catalog lazily and hands an official choice to connection without routing it", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-routing");

    await screen.findByRole("heading", { name: "创作任务安排" }, { timeout: 5_000 });
    expect(screen.queryByRole("searchbox", { name: "搜索模型、供应商或用途" })).toBeNull();
    await user.click(screen.getByText("浏览全部可选模型"));
    const search = screen.getByRole("searchbox", { name: "搜索模型、供应商或用途" });
    await user.type(search, "gpt-5.6-sol");
    await user.click(screen.getByRole("button", { name: /选择 GPT-5.6 Sol/u }));

    expect(await screen.findByRole("heading", { name: "模型中心 · 连接与模型" })).toBeVisible();
    expect(screen.getByText(/准备连接 GPT-5.6 Sol.*不会参与创作任务安排/u)).toBeVisible();
    expect(screen.queryByText(/更改已保存.*需要刷新/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新模型中心状态" })).not.toBeInTheDocument();
    await expect(runtime.modelHub.findTaskRoute("prose_generation")).resolves.toBeNull();
    expect(screen.queryByText(/OpenAI model catalog/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /供应商证据/u })).not.toBeInTheDocument();
  }, 10_000);

  it("keeps provider-declared capability rows visibly pending until InkShadow verifies them", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    let connection = await developmentRuntime.modelHub.saveConnection({
      id: "catalog-declaration-only",
      providerKind: "openai",
      displayName: "Declaration-only provider",
      credentialRef: "keyring:model-hub:catalog-declaration-only",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await developmentRuntime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    const catalog = await developmentRuntime.modelHub.syncCatalog({
      syncId: "catalog-declaration-only-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        {
          id: "catalog-declaration-only-entry",
          providerModelId: "declaration-only-model",
          displayName: "Declaration-only model",
        },
      ],
    });
    await developmentRuntime.modelHub.recordCapabilityScan({
      scanId: "catalog-declaration-only-scan",
      catalogEntryId: catalog[0]?.id ?? "missing",
      scanKind: "provider_metadata",
      status: "succeeded",
      evidenceVersion: "provider-catalog-v1",
      evidence: [
        {
          id: "catalog-declaration-only-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "provider_metadata",
        },
      ],
    });
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-routing");

    await screen.findByRole("heading", { name: "创作任务安排" }, { timeout: 5_000 });
    await user.click(screen.getByText("浏览全部可选模型"));
    const search = screen.getByRole("searchbox", { name: "搜索模型、供应商或用途" });
    await user.type(search, "declaration-only-model");
    const modelRow = screen
      .getByRole("button", { name: /选择 Declaration-only model/u })
      .closest("li");
    if (modelRow === null) throw new Error("Expected the declaration-only catalog row.");
    expect(within(modelRow).getByText("待应用验证")).toBeVisible();
    expect(within(modelRow).queryByText("已通过应用验证")).not.toBeInTheDocument();
  }, 10_000);

  it("keeps a catalog-only pending choice in Model Center without provider calls or route changes", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-return-intent");
    const currentConnection =
      await prepared.runtime.modelHub.findConnection("deepseek-return-intent");
    if (currentConnection === null) throw new Error("Expected the pending connection.");
    await prepared.runtime.modelHub.recordConnectionTest({
      connectionId: currentConnection.id,
      status: "ready",
      expectedRevision: currentConnection.revision,
    });
    const checkConnection = vi.spyOn(prepared.runtime.modelGateway, "checkConnection");
    const listModels = vi.spyOn(prepared.runtime.modelGateway, "listModels");
    const generate = vi.spyOn(prepared.runtime.modelGateway, "generate");
    expect(
      saveModelHubConnectionIntent(window.localStorage, {
        task: "prose_generation",
        providerKind: "deepseek",
        providerModelId: "deepseek-v4-flash",
        catalogRegistryVersion: SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
        now: prepared.runtime.clock.now(),
      }),
    ).not.toBeNull();

    renderRoute(prepared.runtime, "/settings#model-center");

    expect(
      await screen.findByRole("heading", { name: "墨影模型中心" }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(
      await screen.findByText("所选模型已发现，仍需验证能力", {}, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "验证能力" })).toHaveAttribute(
      "href",
      "/settings#model-center",
    );
    expect(document.getElementById("model-routing-task-prose_generation")).toBeNull();
    await expect(prepared.runtime.modelHub.findTaskRoute("prose_generation")).resolves.toBeNull();
    expect(checkConnection).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).not.toBeNull();
  }, 10_000);

  it("returns a verified exact intent to an expanded task and assigns only after explicit confirmation", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-verified-return-intent");
    let retiredDuplicate = await prepared.runtime.modelHub.saveConnection({
      id: "deepseek-retired-return-duplicate",
      providerKind: "deepseek",
      displayName: "Retired duplicate",
      credentialRef: "keyring:model-hub:deepseek-retired-return-duplicate",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    await prepared.runtime.modelHub.syncCatalog({
      syncId: "deepseek-retired-return-duplicate-sync",
      connectionId: retiredDuplicate.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        {
          id: "deepseek-retired-return-duplicate-catalog",
          providerModelId: "deepseek-v4-flash",
          displayName: "Retired deepseek-v4-flash",
        },
      ],
    });
    const currentRetiredDuplicate = await prepared.runtime.modelHub.findConnection(
      retiredDuplicate.id,
    );
    if (currentRetiredDuplicate === null) throw new Error("Expected the duplicate connection.");
    retiredDuplicate = await prepared.runtime.modelHub.retireConnection({
      connectionId: retiredDuplicate.id,
      expectedRevision: currentRetiredDuplicate.revision,
    });
    expect(retiredDuplicate.enabled).toBe(false);
    let activeDuplicate = await prepared.runtime.modelHub.saveConnection({
      id: "zz-deepseek-active-return-duplicate",
      providerKind: "deepseek",
      displayName: "Active duplicate",
      credentialRef: "keyring:model-hub:zz-deepseek-active-return-duplicate",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    activeDuplicate = await prepared.runtime.modelHub.recordConnectionTest({
      connectionId: activeDuplicate.id,
      status: "ready",
      expectedRevision: activeDuplicate.revision,
    });
    const activeDuplicateCatalog = await prepared.runtime.modelHub.syncCatalog({
      syncId: "zz-deepseek-active-return-duplicate-sync",
      connectionId: activeDuplicate.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        {
          id: "zz-deepseek-active-return-duplicate-catalog",
          providerModelId: "deepseek-v4-flash",
          displayName: "Active duplicate deepseek-v4-flash",
        },
      ],
    });
    const activeDuplicateCatalogEntry = activeDuplicateCatalog[0];
    if (activeDuplicateCatalogEntry === undefined) {
      throw new Error("Expected the active duplicate catalog entry.");
    }
    const checkConnection = vi.spyOn(prepared.runtime.modelGateway, "checkConnection");
    const listModels = vi.spyOn(prepared.runtime.modelGateway, "listModels");
    const generate = vi.spyOn(prepared.runtime.modelGateway, "generate");
    const startInvocation = vi.spyOn(prepared.runtime.modelHub, "startInvocation");
    expect(
      saveModelHubConnectionIntent(window.localStorage, {
        task: "prose_generation",
        providerKind: "deepseek",
        providerModelId: "deepseek-v4-flash",
        catalogRegistryVersion: SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
        now: prepared.runtime.clock.now(),
      }),
    ).not.toBeNull();
    const user = userEvent.setup();

    renderRoute(prepared.runtime, "/settings#model-center");

    expect(
      await screen.findByText("所选模型已发现，仍需验证能力", {}, { timeout: 5_000 }),
    ).toBeVisible();
    const verify = screen.getByRole("button", { name: "确认 1 次固定验证" });
    await waitFor(() => expect(verify).toBeEnabled());
    await user.click(verify);

    expect(
      await screen.findByRole("heading", { name: "创作任务安排" }, { timeout: 5_000 }),
    ).toBeVisible();
    await waitFor(() =>
      expect(document.getElementById("model-routing-task-prose_generation")).toHaveFocus(),
    );
    const taskRow = document.getElementById("model-routing-task-prose_generation");
    if (taskRow === null) throw new Error("Expected the prose generation task row.");
    const outerDisclosure = taskRow.closest("details");
    const modelDisclosure = taskRow.querySelector<HTMLDetailsElement>(
      ":scope > details.model-routing-model-options",
    );
    expect(outerDisclosure).toHaveAttribute("open");
    expect(modelDisclosure).toHaveAttribute("open");
    expect(taskRow).toBeVisible();
    if (modelDisclosure === null) throw new Error("Expected the task model disclosure.");
    const probedCatalogEntries = (
      await Promise.all(
        [prepared.catalogEntryId, activeDuplicateCatalogEntry.id].map(async (catalogEntryId) => ({
          catalogEntryId,
          evidence: await prepared.runtime.modelHub.listCapabilityEvidence(catalogEntryId),
        })),
      )
    ).filter(({ evidence }) =>
      evidence.some(
        ({ capability, verdict }) => capability === "text_generation" && verdict === "supported",
      ),
    );
    expect(probedCatalogEntries).toHaveLength(1);
    const probedCatalogEntry = probedCatalogEntries[0];
    if (probedCatalogEntry === undefined) throw new Error("Expected one probed catalog entry.");
    const probedConnectionId =
      probedCatalogEntry.catalogEntryId === activeDuplicateCatalogEntry.id
        ? activeDuplicate.id
        : "deepseek-verified-return-intent";
    const probedDisplayName =
      probedCatalogEntry.catalogEntryId === activeDuplicateCatalogEntry.id
        ? "Active duplicate deepseek-v4-flash"
        : "deepseek-v4-flash";
    const probedModelLabel = within(modelDisclosure).getByText(probedDisplayName, {
      selector: "strong",
    });
    expect(probedModelLabel).toBeVisible();
    expect(
      within(modelDisclosure).queryByText("Retired deepseek-v4-flash"),
    ).not.toBeInTheDocument();

    const routesAfterProbe = await Promise.all(
      NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)),
    );
    expect(routesAfterProbe.every((route) => route === null)).toBe(true);
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).not.toBeNull();
    expect(checkConnection).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
    expect(startInvocation).toHaveBeenCalledOnce();
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "capability_probe",
        routeTask: null,
        connectionId: probedConnectionId,
        catalogEntryId: probedCatalogEntry.catalogEntryId,
        providerKindSnapshot: "deepseek",
        modelIdSnapshot: "deepseek-v4-flash",
        routeReason: "user_override",
        attempt: 1,
        maximumCostMicros: null,
        currency: null,
      }),
    );
    const probeInvocationId = startInvocation.mock.calls[0]?.[0].id ?? "missing";
    const probeInvocation = await prepared.runtime.modelHub.findInvocation(probeInvocationId);
    expect(probeInvocation).toMatchObject({
      task: "capability_probe",
      status: "succeeded",
      connectionId: probedConnectionId,
      catalogEntryId: probedCatalogEntry.catalogEntryId,
      modelIdSnapshot: "deepseek-v4-flash",
      inputTokens: 4,
      outputTokens: 1,
      estimatedCostMicros: null,
    });
    expect(typeof probeInvocation?.providerDispatchStartedAt).toBe("string");
    const serializedProbeInvocation = JSON.stringify(probeInvocation);
    expect(serializedProbeInvocation).not.toContain("只回复：OK");
    expect(serializedProbeInvocation).not.toContain("https://api.deepseek.com");
    expect(serializedProbeInvocation).not.toContain("keyring:");

    const probedModelRow = probedModelLabel.closest("li");
    if (probedModelRow === null) throw new Error("Expected the probed model row.");
    expect(within(probedModelRow).getByText("当前建议 · 请使用上方操作")).toBeVisible();
    const probedTaskRow = document.getElementById("model-routing-task-prose_generation");
    if (probedTaskRow === null) throw new Error("未找到正文生成任务。");
    await user.click(within(probedTaskRow).getByRole("button", { name: "用于此任务" }));

    await waitFor(() =>
      expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).toBeNull(),
    );
    const routesAfterAssignment = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(routesAfterAssignment).toHaveLength(1);
    expect(routesAfterAssignment[0]).toMatchObject({
      task: "prose_generation",
      primaryCatalogEntryId: probedCatalogEntry.catalogEntryId,
      routeOrigin: "user",
      enabled: true,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("returns a text-verified translation task to its probe action without assigning it", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-translation-return-intent");
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-translation-return-text-scan",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "translation-return-text-v1",
      evidence: [
        {
          id: "deepseek-translation-return-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
    expect(
      saveModelHubConnectionIntent(window.localStorage, {
        task: "translation",
        providerKind: "deepseek",
        providerModelId: "deepseek-v4-flash",
        catalogRegistryVersion: SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
        now: prepared.runtime.clock.now(),
      }),
    ).not.toBeNull();
    const generate = vi.spyOn(prepared.runtime.modelGateway, "generate");
    const startInvocation = vi.spyOn(prepared.runtime.modelHub, "startInvocation");

    renderRoute(prepared.runtime, "/settings#model-center");

    expect(
      await screen.findByRole("heading", { name: "创作任务安排" }, { timeout: 5_000 }),
    ).toBeVisible();
    await waitFor(() =>
      expect(document.getElementById("model-routing-task-translation")).toHaveFocus(),
    );
    const taskRow = document.getElementById("model-routing-task-translation");
    if (taskRow === null) throw new Error("Expected the translation task row.");
    expect(taskRow.closest("details")).toHaveAttribute("open");
    const modelDisclosure = taskRow.querySelector<HTMLDetailsElement>(
      ":scope > details.model-routing-model-options",
    );
    if (modelDisclosure === null) throw new Error("Expected the task model disclosure.");
    expect(modelDisclosure).toHaveAttribute("open");
    const disclosureButton = within(taskRow).getByRole("button", {
      name: "查看验证说明",
    });
    expect(disclosureButton).toBeVisible();
    await expect(prepared.runtime.modelHub.findTaskRoute("translation")).resolves.toBeNull();
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).not.toBeNull();
    expect(generate).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(disclosureButton);
    const confirmation = await screen.findByRole("dialog", {
      name: "确认 1 次模型能力检查？",
    });
    expect(within(confirmation).getByText(/DeepSeek/u)).toBeVisible();
    expect(within(confirmation).getByText(/deepseek-v4-flash/u)).toBeVisible();
    await user.click(within(confirmation).getByText("高级诊断详情：固定验证内容"));
    expect(within(confirmation).getByText(/固定用户句：雨停了。/u)).toBeVisible();
    expect(
      within(confirmation).getByText(/最大输出：\s*AI 最多返回 64\s*个文字量单位（这不是金额）/u),
    ).toBeVisible();
    expect(
      within(confirmation).getByText(/最多向模型服务发送：\s*1 次；自动重试：\s*0 次/u),
    ).toBeVisible();
    expect(within(confirmation).getByText(/费用上限：暂无法估算/u)).toBeVisible();
    expect(generate).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole("button", { name: "取消（不发送）" }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(generate).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
  }, 10_000);

  it.each([
    { task: "what_if_simulation" as const, label: "结构化输出" },
    { task: "translation" as const, label: "翻译" },
  ])(
    "shows an uncertain $label probe as pending review without another dispatch",
    async ({ task }) => {
      const prepared = await createReadyDeepSeekProbeRuntime(`deepseek-${task}-ambiguous`);
      await prepared.runtime.modelHub.recordCapabilityScan({
        scanId: `deepseek-${task}-ambiguous-text-scan`,
        catalogEntryId: prepared.catalogEntryId,
        scanKind: "user_review",
        status: "succeeded",
        evidenceVersion: `${task}-ambiguous-text-v1`,
        evidence: [
          {
            id: `deepseek-${task}-ambiguous-text`,
            capability: "text_generation",
            verdict: "supported",
            evidenceSource: "user_confirmed",
          },
        ],
      });
      expect(
        saveModelHubConnectionIntent(window.localStorage, {
          task,
          providerKind: "deepseek",
          providerModelId: "deepseek-v4-flash",
          catalogRegistryVersion: SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
          now: prepared.runtime.clock.now(),
        }),
      ).not.toBeNull();
      const generate = vi.spyOn(prepared.runtime.modelGateway, "generate").mockRejectedValue(
        Object.assign(new Error("connection ended before a response"), {
          code: "MODEL_NETWORK_TIMEOUT",
          retryable: true,
          diagnostics: { stage: "transport" },
        }),
      );
      const commitCapabilityProbeResult = vi.spyOn(
        prepared.runtime.modelHub,
        "commitCapabilityProbeResult",
      );
      const user = userEvent.setup();
      renderRoute(prepared.runtime, "/settings#model-center");

      expect(
        await screen.findByRole("heading", { name: "创作任务安排" }, { timeout: 5_000 }),
      ).toBeVisible();
      const taskRow = await waitFor(() => {
        const row = document.getElementById(`model-routing-task-${task}`);
        if (row === null) throw new Error("Expected the focused task row.");
        expect(row).toHaveFocus();
        return row;
      });
      const disclosureButton = await within(taskRow).findByRole(
        "button",
        { name: "查看验证说明" },
        { timeout: 5_000 },
      );
      await user.click(disclosureButton);
      const confirmation = await screen.findByRole("dialog", {
        name: "确认 1 次模型能力检查？",
      });
      await user.click(
        within(confirmation).getByRole("button", {
          name: "确认 1 次验证并用于此任务",
        }),
      );

      await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      expect((await screen.findAllByText("模型能力检查结果待核对")).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/系统不会自动重发/u).length).toBeGreaterThan(0);
      expect(screen.queryByText("创作任务安排没有保存")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重试保存" })).not.toBeInTheDocument();
      expect(within(taskRow).getByRole("button", { name: "结果待核对" })).toBeDisabled();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(commitCapabilityProbeResult).not.toHaveBeenCalled();
      await expect(prepared.runtime.modelHub.findTaskRoute(task)).resolves.toBeNull();
      const failures = await prepared.runtime.modelHub.listRecentAiFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0]?.diagnosticId.startsWith("model_invocation:")).toBe(true);
      expect(failures[0]?.normalizedErrorCode).toBe("PROVIDER_RESULT_AMBIGUOUS");
    },
    20_000,
  );

  it("makes zero calls after privacy drift and requires a fresh confirmation before translation probing", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-translation-disclosure");
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-translation-disclosure-text-scan",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "translation-disclosure-text-v1",
      evidence: [
        {
          id: "deepseek-translation-disclosure-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
    const generate = vi.spyOn(prepared.runtime.modelGateway, "generate").mockResolvedValue({
      text: "The rain has stopped.",
      usage: { inputTokens: 20, outputTokens: 6, cachedInputTokens: null },
      streamed: false,
    });
    expect(
      saveModelHubConnectionIntent(window.localStorage, {
        task: "translation",
        providerKind: "deepseek",
        providerModelId: "deepseek-v4-flash",
        catalogRegistryVersion: SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
        now: prepared.runtime.clock.now(),
      }),
    ).not.toBeNull();
    const user = userEvent.setup();
    renderRoute(prepared.runtime, "/settings#model-center");

    expect(
      await screen.findByRole("heading", { name: "创作任务安排" }, { timeout: 5_000 }),
    ).toBeVisible();
    const taskRow = await waitFor(() => {
      const row = document.getElementById("model-routing-task-translation");
      if (row === null) throw new Error("Expected the translation task row.");
      expect(row).toHaveFocus();
      return row;
    });
    const disclosureButton = await within(taskRow).findByRole(
      "button",
      { name: "查看验证说明" },
      { timeout: 5_000 },
    );
    await user.click(disclosureButton);
    let confirmation = await screen.findByRole("dialog", {
      name: "确认 1 次模型能力检查？",
    });
    expect(generate).not.toHaveBeenCalled();

    await prepared.runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: prepared.catalogEntryId,
      currency: "USD",
      inputMicrosPerMillionTokens: "1000",
      outputMicrosPerMillionTokens: "2000",
      pricingVersion: "changed-after-disclosure",
      priceUpdatedAt: "2026-08-20T00:00:00.000Z",
      dataDestination: "remote",
      retentionPolicy: "provider_default",
      trainingPolicy: "unknown",
      evidenceSource: "provider_policy",
      evidenceVersion: "changed-after-disclosure",
      expectedRevision: null,
    });
    await user.click(
      within(confirmation).getByRole("button", {
        name: "确认 1 次验证并用于此任务",
      }),
    );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(generate).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "连接、模型、创作任务安排、费用或隐私设置已经变化；本次没有发送，请重新查看说明后确认。",
      ),
    ).toBeVisible();
    await expect(prepared.runtime.modelHub.findTaskRoute("translation")).resolves.toBeNull();

    await user.click(within(taskRow).getByRole("button", { name: "查看验证说明" }));
    confirmation = await screen.findByRole("dialog", {
      name: "确认 1 次模型能力检查？",
    });
    expect(within(confirmation).getByText(/遵循供应商默认政策/u)).toBeVisible();
    await user.click(
      within(confirmation).getByRole("button", {
        name: "确认 1 次验证并用于此任务",
      }),
    );

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      model: "deepseek-v4-flash",
      config: { retryLimit: 0 },
      maxOutputTokens: 64,
      messages: [
        {
          role: "system",
          content: "Translate the fixed Chinese sentence to English. Return the translation only.",
        },
        { role: "user", content: "雨停了。" },
      ],
    });
    await waitFor(async () => {
      await expect(prepared.runtime.modelHub.findTaskRoute("translation")).resolves.toMatchObject({
        primaryCatalogEntryId: prepared.catalogEntryId,
        routeOrigin: "user",
        enabled: true,
      });
    });
  }, 15_000);

  it("lets the user choose and persist an appearance without exposing technical settings", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings");

    const appearance = await screen.findByRole("combobox", { name: /^外观模式/u });
    expect(appearance).toHaveValue("system");
    expect(document.documentElement).not.toHaveAttribute("data-surface");
    expect(appearance).toHaveAccessibleDescription(/当前跟随系统；电脑此刻为(?:浅色|深色)。/u);

    await user.selectOptions(appearance, "light");
    expect(document.documentElement).toHaveAttribute("data-surface", "light");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("light");
    expect(appearance).toHaveAccessibleDescription("当前使用浅色。");

    await user.selectOptions(appearance, "dark");
    expect(document.documentElement).toHaveAttribute("data-surface", "dark");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("dark");
    expect(appearance).toHaveAccessibleDescription("当前使用深色。");

    await user.selectOptions(appearance, "system");
    expect(document.documentElement).not.toHaveAttribute("data-surface");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("system");
  });

  it("persists writing typography and autosave preferences with live editor events", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const typographyChanged = vi.fn();
    const preferencesChanged = vi.fn();
    window.addEventListener(EDITOR_TYPOGRAPHY_CHANGED_EVENT, typographyChanged);
    window.addEventListener(EDITOR_PREFERENCES_CHANGED_EVENT, preferencesChanged);
    renderRoute(runtime, "/settings");

    const fontSize = await screen.findByRole("combobox", { name: /^字号/u });
    const lineHeight = screen.getByRole("combobox", { name: /^行距/u });
    const measure = screen.getByRole("combobox", { name: /^正文宽度/u });
    const autosave = screen.getByRole("checkbox", { name: /自动保存正式版本/u });
    const delay = screen.getByRole("combobox", { name: /^自动保存等待时间/u });

    expect(fontSize).toHaveValue("16");
    expect(lineHeight).toHaveValue("1.75");
    expect(measure).toHaveValue("comfortable");
    expect(autosave).toBeChecked();
    expect(delay).toHaveValue("1000");

    await user.selectOptions(fontSize, "20");
    await user.selectOptions(measure, "wide");
    await user.click(autosave);

    expect(delay).toBeDisabled();
    expect(typographyChanged).toHaveBeenCalledTimes(2);
    expect(preferencesChanged).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({
      typography: { fontSize: 20, lineHeight: 1.75, measure: "wide" },
    });
    expect(
      JSON.parse(window.localStorage.getItem(EDITOR_PREFERENCES_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({
      autosaveEnabled: false,
      autosaveDebounceMs: 1000,
    });

    window.removeEventListener(EDITOR_TYPOGRAPHY_CHANGED_EVENT, typographyChanged);
    window.removeEventListener(EDITOR_PREFERENCES_CHANGED_EVENT, preferencesChanged);
  });

  it("clears exactly one selected project's AI memory and preserves other projects", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = await runtime.useCases.createProject.execute({ name: "要清空的项目" });
    const otherProject = await runtime.useCases.createProject.execute({ name: "保留的项目" });
    if (!firstProject.ok || !otherProject.ok) throw new Error("无法准备项目。 ");
    const policy = await runtime.story.memoryService.ensureDefaultPolicy(firstProject.value.id);
    if (!policy.ok) throw policy.error;
    const enabled = await runtime.story.memoryService.setAutomaticLearning({
      projectId: firstProject.value.id,
      enabled: true,
      humanConfirmed: true,
      expectedRevision: policy.value.revision,
    });
    if (!enabled.ok) throw enabled.error;
    for (const [projectId, content] of [
      [firstProject.value.id, "第一条待忘记记忆"],
      [firstProject.value.id, "第二条待忘记记忆"],
      [otherProject.value.id, "不能被跨项目清空的记忆"],
    ] as const) {
      const created = await runtime.story.memoryService.createRecord({
        projectId,
        level: "L2",
        content,
        source: { kind: "user_rule", sourceId: runtime.story.actorId, sourceVersionId: null },
        origin: "user",
        humanConfirmed: true,
      });
      if (!created.ok) throw created.error;
    }

    const user = userEvent.setup();
    renderRoute(runtime, "/settings");
    const memoryHeading = await screen.findByRole("heading", { name: "项目 AI 记忆", level: 2 });
    const memoryCard = memoryHeading.closest(".ink-card");
    if (!(memoryCard instanceof HTMLElement)) throw new Error("找不到项目 AI 记忆设置。 ");
    const projectSelect = await within(memoryCard).findByRole("combobox", {
      name: /^选择项目/u,
    });
    await user.selectOptions(projectSelect, firstProject.value.id);
    expect(await screen.findByText("当前有 2 条可用记忆")).toBeVisible();
    await user.click(within(memoryCard).getByRole("button", { name: "清空该项目全部 AI 记忆" }));
    const dialog = screen.getByRole("dialog", { name: "清空该项目的全部 AI 记忆？" });
    expect(within(dialog).getByText(/不会被删除/u)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "确认清空该项目记忆" }));
    expect(await screen.findByText("项目 AI 记忆已清空")).toBeVisible();

    const selectedId = parseStoryProjectId(firstProject.value.id);
    const otherId = parseStoryProjectId(otherProject.value.id);
    const selectedRecords = await runtime.story.memoryRecords.listByProjectId(selectedId);
    const otherRecords = await runtime.story.memoryRecords.listByProjectId(otherId);
    const storedPolicy = await runtime.story.memoryPolicies.findByProjectId(selectedId);
    if (!selectedRecords.ok || !otherRecords.ok || !storedPolicy.ok) {
      throw new Error("无法读取清空后的项目记忆。 ");
    }
    expect(selectedRecords.value).toHaveLength(2);
    expect(selectedRecords.value.every((record) => record.toSnapshot().excluded)).toBe(true);
    expect(storedPolicy.value?.automaticLearningEnabled).toBe(false);
    expect(otherRecords.value).toHaveLength(1);
    expect(otherRecords.value[0]?.toSnapshot().excluded).toBe(false);
    const stored = JSON.parse(
      window.localStorage.getItem("inkshadow.development.story.v1") ?? "{}",
    ) as { memoryGovernanceEvents?: Record<string, { projectId: string }> };
    expect(Object.values(stored.memoryGovernanceEvents ?? {})).toMatchObject([
      { projectId: firstProject.value.id },
    ]);
  }, 15_000);

  it.each([
    ["model-center", "模型中心 · 连接与模型", "连接与模型", "墨影模型中心"],
    ["model-routing", "模型中心 · 创作任务安排", "创作任务安排", "创作任务安排"],
    ["model-evaluation", "模型中心 · 模型评测", "模型评测", "模型基础评测"],
    ["image-generation", "模型中心 · 图片生成", "图片生成", "生成小说配图"],
  ] as const)(
    "separates the %s Model Hub view from global settings",
    async (sectionId, pageTitle, navigationLabel, activeSectionHeading) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      renderRoute(runtime, `/settings#${sectionId}`);

      expect(await screen.findByRole("heading", { name: pageTitle, level: 1 })).toBeVisible();
      expect(screen.getByRole("navigation", { name: "模型中心分区" })).toBeVisible();
      expect(screen.getByRole("link", { name: navigationLabel })).toHaveAttribute(
        "aria-current",
        "page",
      );
      for (const sectionHeading of [
        "墨影模型中心",
        "创作任务安排",
        "模型基础评测",
        "生成小说配图",
      ]) {
        if (sectionHeading === activeSectionHeading) {
          expect(await screen.findByRole("heading", { name: sectionHeading })).toBeVisible();
        } else {
          expect(screen.queryByRole("heading", { name: sectionHeading })).not.toBeInTheDocument();
        }
      }
      expect(screen.queryByRole("heading", { name: "外观" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "数据与隐私" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "同步安全" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "本地数据维护" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "安全更新" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "脱敏诊断包" })).not.toBeInTheDocument();
      expect(screen.queryByText("导入与导出")).not.toBeInTheDocument();
    },
  );

  it("mounts paid Skill evaluation only after expert mode and an explicit fold action", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const initializePaidEvaluation = vi.fn(() => runtime.novelSkillPaidEvaluation.initialize());
    const observedRuntime = Object.freeze({
      ...runtime,
      novelSkillPaidEvaluation: Object.freeze({
        ...runtime.novelSkillPaidEvaluation,
        initialize: initializePaidEvaluation,
      }),
    });
    const user = userEvent.setup();
    renderRoute(observedRuntime, "/settings#model-evaluation");

    expect(await screen.findByRole("heading", { name: "模型中心 · 模型评测" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "写作技能对照验证（专家）" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "内置写作技能付费对照验证" }),
    ).not.toBeInTheDocument();
    expect(initializePaidEvaluation).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const expand = screen.getByRole("button", { name: "写作技能对照验证（专家）" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("heading", { name: "内置写作技能付费对照验证" }),
    ).not.toBeInTheDocument();
    expect(initializePaidEvaluation).not.toHaveBeenCalled();

    await user.click(expand);
    expect(await screen.findByRole("heading", { name: "内置写作技能付费对照验证" })).toBeVisible();
    expect(initializePaidEvaluation).toHaveBeenCalledTimes(1);
    expect(screen.getByText("当前不能进行付费评测")).toBeVisible();
    expect(generate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "收起专家设置" }));
    expect(
      screen.queryByRole("heading", { name: "内置写作技能付费对照验证" }),
    ).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps technical connection fields hidden until expert settings are opened", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-center");

    expect(await screen.findByRole("heading", { name: "墨影模型中心" })).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "需要 AI 时，再连接一个模型服务" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("基础地址")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("认证方式")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^单次可发送的文字量上限（不是金额）/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Google Gemini" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "专家设置" }));

    expect(screen.getByRole("option", { name: "Google Gemini" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Anthropic Claude" })).toBeInTheDocument();
    expect(screen.getByLabelText("基础地址")).toBeVisible();
    expect(screen.getByLabelText("认证方式")).toBeVisible();
    expect(screen.getByLabelText(/^单次可发送的文字量上限（不是金额）/u)).toBeInTheDocument();
    expect(screen.getByText("重试不会重复计费请求")).toBeVisible();
    expect(screen.queryByText("专家兼容设置：旧 7 角色任务安排")).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "创作任务安排" }));
    expect(screen.getByText("专家兼容设置：旧 7 角色任务安排")).toBeVisible();

    const matrixHeading = screen.getByRole("heading", { name: "22 项任务矩阵" });
    const matrix = matrixHeading.closest("section");
    if (!(matrix instanceof HTMLElement)) throw new Error("找不到任务矩阵区域");
    expect(within(matrix).getAllByText("文本生成").length).toBeGreaterThan(0);
    expect(matrix).toHaveTextContent("没有可读证据");
    expect(matrix).not.toHaveTextContent(
      /text_generation|structured_output|token_counting|provider_metadata|cloud_allowed|local_preferred|local_only|unknown|none/iu,
    );
  });

  it("shows one current AI readiness state and explains all seven user-facing states", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-center");

    expect(
      await screen.findByRole("heading", { name: "需要 AI 时，再连接一个模型服务" }),
    ).toBeVisible();
    expect(screen.queryByText(/保存供应商与模型暂不可用/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/测试连接并发现模型暂不可用/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/验证写作能力暂不可用/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "连接 AI 服务" }));

    const currentStateHeading = await screen.findByRole("heading", {
      name: "未连接",
      level: 3,
    });
    expect(currentStateHeading).toBeVisible();
    const readiness = currentStateHeading.closest("section");
    if (!(readiness instanceof HTMLElement)) throw new Error("找不到 AI 状态区域");
    expect(within(readiness).getAllByText(/先连接并测试一个模型/u)[0]).toBeVisible();
    await user.click(screen.getByText("了解全部 7 种 AI 状态"));
    const legend = screen.getByRole("list", { name: "AI 状态说明" });
    for (const label of [
      "未连接",
      "正在验证",
      "基础配置可用",
      "AI 写作功能已准备好",
      "部分能力不可用",
      "连接失败",
      "额度不足",
    ]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
  });

  it("explains disabled model-center save, discovery and capability actions", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-center");

    await user.click(
      await screen.findByRole("button", { name: "连接 AI 服务" }, { timeout: 5_000 }),
    );

    const save = screen.getByRole("button", { name: "保存供应商与模型" });
    const discover = screen.getByRole("button", { name: "测试连接并发现模型" });
    const verify = screen.getByRole("button", { name: "确认 1 次固定验证" });
    for (const action of [save, discover, verify]) {
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("aria-describedby");
      const helpId = action.getAttribute("aria-describedby");
      expect(helpId).not.toBeNull();
      expect(document.getElementById(helpId ?? "")).toBeVisible();
    }
    expect(save).toHaveAccessibleDescription(/暂时不能保存.*填写.*接口密钥.*完成.*后/u);
    expect(discover).toHaveAccessibleDescription(
      /暂时不能测试连接并发现模型.*桌面应用.*接口密钥.*本次不会发送/u,
    );
    expect(verify).toHaveAccessibleDescription(
      /暂时不能验证模型能力.*桌面应用.*先完成连接测试.*选择.*文本模型.*本次不会发送/u,
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps cold-start credential and catalog loading non-terminal until the authoritative snapshot is ready", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let connection = await development.modelHub.saveConnection({
      id: "deepseek-cold-page",
      providerKind: "deepseek",
      displayName: "DeepSeek",
      credentialRef: "keyring:model-hub:deepseek-cold-page",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await development.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    await development.modelHub.syncCatalog({
      syncId: "deepseek-cold-page-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        { id: "deepseek-cold-page-fast", providerModelId: "deepseek-fast" },
        { id: "deepseek-cold-page-quality", providerModelId: "deepseek-quality" },
      ],
    });
    const credential = deferred<{ configured: boolean; lastFour: string | null }>();
    const getSummary = vi.fn(() => credential.promise);
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary,
        save: () => Promise.resolve({ configured: true, lastFour: "3172" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    };

    renderRouteInStrictMode(runtime);
    const credentialTitle = await screen.findByText("系统凭据库");
    const credentialCard = credentialTitle.closest(".secret-settings");
    if (!(credentialCard instanceof HTMLElement)) throw new Error("找不到系统凭据状态区域");
    await waitFor(() => expect(getSummary).toHaveBeenCalled());
    expect(within(credentialCard).queryByText("未配置")).not.toBeInTheDocument();
    expect(within(credentialCard).getByText(/正在检查系统凭据/u)).toBeVisible();
    expect(screen.queryByText("还没有读取模型")).not.toBeInTheDocument();
    expect(screen.queryByText("没有发现可用模型")).not.toBeInTheDocument();

    credential.resolve({ configured: true, lastFour: "3172" });

    expect(await screen.findByRole("option", { name: "deepseek-fast" })).toBeInTheDocument();
    expect(await within(credentialCard).findByText("已配置 ····3172")).toBeVisible();
    expect(screen.getByRole("combobox", { name: /^现有供应商连接/u })).toHaveValue(
      "deepseek-cold-page",
    );
  });

  it("retains the cached model catalog when provider discovery fails", async () => {
    const fixture = await createReadyDeepSeekProbeRuntime("deepseek-cache-retained");
    const failingRuntime: DesktopRuntime = {
      ...fixture.runtime,
      modelGateway: {
        ...fixture.runtime.modelGateway,
        available: true,
        checkConnection: () =>
          Promise.reject(
            Object.assign(new Error("provider unavailable"), {
              code: "MODEL_DIRECTORY_UNAVAILABLE",
            }),
          ),
        listModels: () => Promise.reject(new Error("provider unavailable")),
      },
    };
    const user = userEvent.setup();
    renderRoute(failingRuntime);

    expect(await screen.findByRole("option", { name: "deepseek-v4-flash" })).toBeInTheDocument();
    const discover = screen.getByRole("button", { name: "测试连接并发现模型" });
    await waitFor(() => expect(discover).toBeEnabled());
    await user.click(discover);

    expect(await screen.findByText("正在使用上次保存的模型目录")).toBeVisible();
    expect(screen.getByRole("option", { name: "deepseek-v4-flash" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("deepseek-v4-flash");
  });

  it("resets credential and catalog state when switching from Ollama to a DeepSeek draft", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let ollama = await development.modelHub.saveConnection({
      id: "ollama-provider-draft",
      providerKind: "ollama",
      displayName: "Ollama",
      credentialRef: null,
      credentialState: "missing",
      authenticationMode: "none",
      enabled: true,
      expectedRevision: null,
    });
    ollama = await development.modelHub.recordConnectionTest({
      connectionId: ollama.id,
      status: "ready",
      expectedRevision: ollama.revision,
    });
    await development.modelHub.syncCatalog({
      syncId: "ollama-provider-draft-sync",
      connectionId: ollama.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "ollama-provider-draft-model", providerModelId: "local-writer" }],
    });
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: false, lastFour: null }),
        save: () => Promise.resolve({ configured: true, lastFour: "3172" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-center");

    const provider = await screen.findByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(provider).toBeEnabled());
    expect(provider).toHaveValue("ollama");
    expect(screen.getByRole("option", { name: "local-writer" })).toBeInTheDocument();

    await user.selectOptions(provider, "deepseek");

    const credentialTitle = await screen.findByText("系统凭据库");
    const credentialCard = credentialTitle.closest(".secret-settings");
    if (!(credentialCard instanceof HTMLElement)) throw new Error("找不到系统凭据状态区域");
    expect(within(credentialCard).getByText("未配置")).toBeVisible();
    expect(within(credentialCard).queryByText("此连接不需要密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "local-writer" })).not.toBeInTheDocument();
  });

  it("clears a failed provider warning when starting a different provider draft", async () => {
    const fixture = await createReadyDeepSeekProbeRuntime("deepseek-failed-draft");
    const runtime: DesktopRuntime = {
      ...fixture.runtime,
      modelGateway: {
        ...fixture.runtime.modelGateway,
        checkConnection: () =>
          Promise.reject(
            Object.assign(new Error("provider unavailable"), {
              code: "MODEL_DIRECTORY_UNAVAILABLE",
            }),
          ),
        listModels: () => Promise.reject(new Error("provider unavailable")),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("option", { name: "deepseek-v4-flash" });
    await user.click(screen.getByRole("button", { name: "测试连接并发现模型" }));
    expect(await screen.findByText("正在使用上次保存的模型目录")).toBeVisible();
    expect(screen.getByText(/AI 服务暂未完成本次操作/u)).toBeVisible();
    expect(screen.queryByText(/MODEL_DIRECTORY_UNAVAILABLE/u)).not.toBeInTheDocument();

    const provider = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(provider).toBeEnabled());
    await user.selectOptions(provider, "ollama");

    expect(screen.queryByText("正在使用上次保存的模型目录")).not.toBeInTheDocument();
    expect(screen.queryByText(/MODEL_DIRECTORY_UNAVAILABLE/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "deepseek-v4-flash" })).not.toBeInTheDocument();
  });

  it("ignores a late capability probe after a newer connection hydration wins", async () => {
    const fixture = await createReadyDeepSeekProbeRuntime("deepseek-race-old");
    let current = await fixture.runtime.modelHub.saveConnection({
      id: "openai-race-current",
      providerKind: "openai",
      displayName: "OpenAI current",
      credentialRef: "keyring:model-hub:openai-race-current",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    current = await fixture.runtime.modelHub.recordConnectionTest({
      connectionId: current.id,
      status: "ready",
      expectedRevision: current.revision,
    });
    await fixture.runtime.modelHub.syncCatalog({
      syncId: "openai-race-current-sync",
      connectionId: current.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "openai-race-current-model", providerModelId: "gpt-current" }],
    });
    const generation = deferred<{
      text: string;
      usage: { inputTokens: number; outputTokens: number; cachedInputTokens: null };
      streamed: boolean;
    }>();
    const generate = vi.fn(() => generation.promise);
    const runtime: DesktopRuntime = {
      ...fixture.runtime,
      modelGateway: { ...fixture.runtime.modelGateway, generate },
    };
    const user = userEvent.setup();
    renderRoute(runtime, "/settings?connectionId=deepseek-race-old#model-center");

    await screen.findByRole("option", { name: "deepseek-v4-flash" });
    const verify = screen.getByRole("button", { name: "确认 1 次固定验证" });
    await waitFor(() => expect(verify).toBeEnabled());
    await user.click(verify);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    const provider = screen.getByRole("combobox", { name: "供应商" });
    const storedConnection = screen.getByRole("combobox", { name: /^现有供应商连接/u });
    const selectedModel = screen.getByRole("combobox", { name: "模型" });
    expect(provider).toBeDisabled();
    expect(storedConnection).toBeDisabled();
    expect(selectedModel).toBeDisabled();

    // Force the event to prove stale-result isolation even if a future UI path can
    // change the target while a provider request is still returning.
    storedConnection.removeAttribute("disabled");
    fireEvent.change(storedConnection, { target: { value: "openai-race-current" } });
    await waitFor(() => expect(storedConnection).toHaveValue("openai-race-current"));
    expect(await screen.findByRole("option", { name: "gpt-current" })).toBeInTheDocument();

    generation.resolve({
      text: "OK",
      usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
      streamed: false,
    });

    await waitFor(() => expect(provider).toBeEnabled());
    expect(storedConnection).toHaveValue("openai-race-current");
    expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("gpt-current");
    expect(screen.queryByText("写作能力已验证")).not.toBeInTheDocument();
    const routes = await Promise.all(
      NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task)),
    );
    expect(routes.every((route) => route === null)).toBe(true);
  });

  it("saves, tests and reopens a custom single-Header connection with exact expert options", async () => {
    let credentialConfigured = false;
    const observedConfigs: unknown[] = [];
    const createRuntime = (): DesktopRuntime => {
      const development = createDevelopmentRuntime(window.localStorage);
      const modelGateway: NativeModelGatewayClient = {
        available: true,
        checkConnection: (config) => {
          observedConfigs.push(config);
          return Promise.resolve({
            provider: "open_ai_compatible",
            endpointOrigin: "https://custom-models.example",
            modelCount: 1,
            latencyMs: 12,
          });
        },
        listModels: (config) => {
          observedConfigs.push(config);
          return Promise.resolve({
            provider: "open_ai_compatible",
            models: [{ id: "writer-model", displayName: "Writer model" }],
          });
        },
        generate: (input) => {
          observedConfigs.push(input.config);
          return Promise.resolve({
            text: "OK",
            usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: null },
          });
        },
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      };
      return {
        ...development,
        mode: "tauri",
        credentials: {
          getSummary: () =>
            Promise.resolve({
              configured: credentialConfigured,
              lastFour: credentialConfigured ? "alue" : null,
            }),
          save: (_providerId, secret) => {
            expect(secret).toBe("super-secret-header-value");
            credentialConfigured = true;
            return Promise.resolve({ configured: true, lastFour: "alue" });
          },
          delete: () => {
            credentialConfigured = false;
            return Promise.resolve({ configured: false, lastFour: null });
          },
        },
        modelGateway,
      };
    };
    const user = userEvent.setup();
    const runtime = createRuntime();
    const view = renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" }, { timeout: 5_000 });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled());
    fireEvent.change(providerSelect, { target: { value: "custom_openai_compatible" } });
    expect(providerSelect).toHaveValue("custom_openai_compatible");
    expect(screen.getByRole("button", { name: "收起专家设置" })).toBeVisible();
    expect(screen.getByLabelText(/^模型目录路径/u)).toBeVisible();
    act(() => {
      fireEvent.change(screen.getByLabelText("服务根地址"), {
        target: { value: "https://custom-models.example/v1" },
      });
      fireEvent.change(screen.getByLabelText("配置标识"), {
        target: { value: "custom-safe" },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "认证方式" }), {
        target: { value: "custom_header_keyring" },
      });
    });
    expect(providerSelect).toHaveValue("custom_openai_compatible");
    expect(screen.getByRole("button", { name: "收起专家设置" })).toBeVisible();
    const modelDiscoveryPath = await screen.findByLabelText(/^模型目录路径/u);
    const textGenerationPath = screen.getByLabelText(/^文本生成路径/u);
    const embeddingPath = screen.getByLabelText(/^查找相关故事资料路径/u);
    const credentialHeaderName = screen.getByLabelText("认证请求头名称");
    const requestTimeout = screen.getByLabelText("请求超时（毫秒）");
    const retryLimit = screen.getByLabelText("安全重试次数");
    const credentialHeaderValue = screen.getByLabelText("认证请求头内容");
    act(() => {
      fireEvent.change(modelDiscoveryPath, { target: { value: "/catalog/models" } });
      fireEvent.change(textGenerationPath, { target: { value: "/text/chat" } });
      fireEvent.change(embeddingPath, { target: { value: "/vectors/embed" } });
      fireEvent.change(credentialHeaderName, { target: { value: "X-API-Key" } });
      fireEvent.change(requestTimeout, { target: { value: "47000" } });
      fireEvent.change(retryLimit, { target: { value: "2" } });
      fireEvent.change(credentialHeaderValue, {
        target: { value: "super-secret-header-value" },
      });
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));

    const check = screen.getByRole("button", { name: "测试连接并发现模型" });
    await waitFor(() => expect(check).toBeEnabled());
    await user.click(check);
    expect(await screen.findByText(/12 毫秒/u)).toBeVisible();
    expect(screen.queryByText(/12 ms/u)).not.toBeInTheDocument();
    await screen.findByRole("option", { name: "Writer model" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "要检查的能力" }),
      "text_generation",
    );
    await user.click(screen.getByRole("button", { name: "确认 1 次固定验证" }));
    expect(await screen.findByText("写作能力已验证")).toBeVisible();

    const expectedConfig = {
      providerId: expect.stringMatching(/^model-key-/u) as unknown,
      provider: "open_ai_compatible",
      baseUrl: "https://custom-models.example/v1",
      authentication: "custom_header_keyring",
      credentialHeaderName: "x-api-key",
      modelDiscoveryPath: "/catalog/models",
      textGenerationPath: "/text/chat",
      embeddingPath: "/vectors/embed",
      requestTimeoutMs: 47_000,
      retryLimit: 2,
    };
    expect(observedConfigs).toEqual(expect.arrayContaining([expectedConfig]));
    expect(JSON.stringify(window.localStorage)).not.toContain("super-secret-header-value");

    view.unmount();
    renderRoute(createRuntime());
    await screen.findByRole("heading", { name: "墨影模型中心" }, { timeout: 5_000 });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    await waitFor(() => {
      expect(screen.getByLabelText("配置标识")).toHaveValue("custom-safe");
      expect(screen.getByRole("combobox", { name: "认证方式" })).toHaveValue(
        "custom_header_keyring",
      );
      expect(screen.getByLabelText("认证请求头名称")).toHaveValue("x-api-key");
      expect(screen.getByLabelText(/^模型目录路径/u)).toHaveValue("/catalog/models");
      expect(screen.getByLabelText(/^文本生成路径/u)).toHaveValue("/text/chat");
      expect(screen.getByLabelText(/^查找相关故事资料路径/u)).toHaveValue("/vectors/embed");
      expect(screen.getByLabelText("请求超时（毫秒）")).toHaveValue(47_000);
      expect(screen.getByLabelText("安全重试次数")).toHaveValue(2);
    });
  }, 20_000);

  it("confirms safe connection removal, deletes the credential, and keeps an auditable retired row", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const connection = await development.modelHub.saveConnection({
      id: "ui-retired-provider",
      providerKind: "custom_openai_compatible",
      displayName: "可移除写作连接",
      baseUrlOverride: "https://retire-ui.example/v1",
      credentialRef: "keyring:model-hub:ui-retired-provider",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    await development.modelCenter.save({
      providerId: connection.id,
      provider: "open_ai_compatible",
      baseUrl: connection.baseUrl,
      authentication: "bearer_keyring",
      selectedModel: "writer-model",
      expectedRevision: null,
    });
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: deleteCredential,
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const remove = await screen.findByRole("button", { name: "退役连接" });
    await user.click(remove);
    const dialog = screen.getByRole("dialog", { name: "退役“可移除写作连接”连接？" });
    expect(within(dialog).getByText(/永久停止这条连接参与选择、推荐和创作任务安排/u)).toBeVisible();
    expect(within(dialog).getByText("退役不同于删除凭据或暂时停用")).toBeVisible();
    expect(
      within(dialog).getByText(/正文、AI 建议版本、模型使用记录和费用凭据不会删除/u),
    ).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "确认退役连接" }));
    expect(await screen.findByText(/已退役：不会再参与选择、推荐或创作任务安排/u)).toBeVisible();
    expect(deleteCredential).toHaveBeenCalledWith(connection.id);
    await expect(runtime.modelHub.findConnection(connection.id)).resolves.toMatchObject({
      enabled: false,
      connectionStatus: "disabled",
      credentialRef: null,
      credentialState: "missing",
      lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
    });
    await expect(runtime.modelCenter.findByProviderId(connection.id)).resolves.toMatchObject({
      selectedModel: null,
    });
    expect(screen.queryByRole("button", { name: "退役连接" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /已退役/u })).not.toBeInTheDocument();
    expect(screen.getByText("已退役连接历史（1）")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    expect(screen.getByLabelText("配置标识")).toHaveValue("custom-provider");
  }, 10_000);

  it("opens a failed active connection for non-sensitive editing without changing its credential", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let connection = await development.modelHub.saveConnection({
      id: "failed-editable-provider",
      providerKind: "custom_openai_compatible",
      displayName: "待修复写作连接",
      baseUrlOverride: "https://failed-edit.example/v1",
      credentialRef: "keyring:model-hub:failed-editable-provider",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    connection = await development.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "error",
      errorCode: "MODEL_HTTP_NOT_FOUND",
      errorSummary: "provider returned not found",
      expectedRevision: connection.revision,
    });
    const saveCredential = vi.fn(() => Promise.resolve({ configured: true, lastFour: "1234" }));
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: saveCredential,
        delete: deleteCredential,
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime, "/settings?connectionId=failed-editable-provider#model-center");

    const editAndRetry = await screen.findByRole("button", { name: "编辑并重试" });
    expect(screen.getByText(/连接设置和已保存密钥都仍然保留/u)).toBeVisible();
    await user.click(editAndRetry);

    const baseUrlInput = await screen.findByLabelText("基础地址");
    await waitFor(() => expect(baseUrlInput).toHaveFocus());
    expect(baseUrlInput).toHaveValue("https://failed-edit.example/v1");
    expect(screen.getByLabelText("接口密钥")).toHaveValue("");
    expect(saveCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnection(connection.id)).resolves.toMatchObject({
      credentialRef: "keyring:model-hub:failed-editable-provider",
      credentialState: "present",
      enabled: true,
      connectionStatus: "error",
    });
  });

  it("uses the loaded connection revision so a stale page cannot overwrite a newer edit", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const loaded = await development.modelHub.saveConnection({
      id: "stale-edit-provider",
      providerKind: "custom_openai_compatible",
      displayName: "并发编辑连接",
      baseUrlOverride: "https://loaded.example/v1",
      credentialRef: "keyring:model-hub:stale-edit-provider",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    const originalSaveConnection = development.modelHub.saveConnection.bind(development.modelHub);
    const observedSaveInputs: Parameters<typeof development.modelHub.saveConnection>[0][] = [];
    vi.spyOn(development.modelHub, "saveConnection").mockImplementation(async (input) => {
      observedSaveInputs.push(input);
      return originalSaveConnection(input);
    });
    const saveCredential = vi.fn(() => Promise.resolve({ configured: true, lastFour: "1234" }));
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: saveCredential,
        delete: deleteCredential,
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const baseUrlInput = await screen.findByLabelText("基础地址");
    expect(baseUrlInput).toHaveValue("https://loaded.example/v1");

    await originalSaveConnection({
      id: loaded.id,
      providerKind: loaded.providerKind,
      displayName: loaded.displayName,
      baseUrlOverride: "https://newer.example/v1",
      credentialRef: loaded.credentialRef,
      credentialState: loaded.credentialState,
      authenticationMode: loaded.authenticationMode,
      enabled: true,
      expectedRevision: loaded.revision,
    });
    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, "https://stale.example/v1");
    await user.click(screen.getByRole("button", { name: "保存供应商与模型" }));

    await waitFor(() => expect(observedSaveInputs.length).toBeGreaterThan(0));
    expect(observedSaveInputs.at(-1)?.expectedRevision).toBe(loaded.revision);
    await expect(runtime.modelHub.findConnection(loaded.id)).resolves.toMatchObject({
      baseUrl: "https://newer.example/v1",
      credentialRef: loaded.credentialRef,
      credentialState: "present",
    });
    expect(saveCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("restores a no-credential retirement with unfinished legacy cleanup after restart", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const connection = await development.modelHub.saveConnection({
      id: "ui-retirement-cleanup-retry",
      providerKind: "custom_openai_compatible",
      displayName: "可重试退役连接",
      baseUrlOverride: "https://retire-retry.example/v1",
      credentialRef: null,
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await development.modelCenter.save({
      providerId: connection.id,
      provider: "open_ai_compatible",
      baseUrl: connection.baseUrl,
      authentication: "none",
      selectedModel: "writer-model",
      expectedRevision: null,
    });
    const saveLegacyProfile = vi.spyOn(development.modelCenter, "save");
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: false, lastFour: null }),
        save: () => Promise.resolve({ configured: false, lastFour: null }),
        delete: deleteCredential,
      },
    };
    const user = userEvent.setup();
    const view = renderRoute(runtime);

    const retireButton = await screen.findByRole("button", { name: "退役连接" });
    saveLegacyProfile.mockClear();
    saveLegacyProfile.mockRejectedValue(new Error("temporary legacy selection failure"));
    await user.click(retireButton);
    let dialog = screen.getByRole("dialog", { name: "退役“可重试退役连接”连接？" });
    await user.click(within(dialog).getByRole("button", { name: "确认退役连接" }));
    await waitFor(() => expect(saveLegacyProfile).toHaveBeenCalledTimes(2));
    await expect(runtime.modelHub.findConnection(connection.id)).resolves.toMatchObject({
      enabled: false,
      revision: connection.revision + 1,
      credentialRef: null,
      lastErrorCode: "MODEL_HUB_CONNECTION_RETIREMENT_INCOMPLETE",
    });

    view.unmount();
    const reopenedDevelopment = createDevelopmentRuntime(window.localStorage);
    const reopened: DesktopRuntime = {
      ...reopenedDevelopment,
      mode: "tauri",
      credentials: runtime.credentials,
    };
    renderRoute(reopened);

    expect(await screen.findByText("退役尚未完成")).toBeVisible();
    expect(screen.queryByRole("list", { name: "当前 AI 连接" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "继续清理并完成退役" }));
    dialog = screen.getByRole("dialog", { name: "退役“可重试退役连接”连接？" });
    const retry = within(dialog).getByRole("button", { name: "确认退役连接" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    expect(await screen.findByText(/可重试退役连接.*已退役/u)).toBeVisible();
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(reopened.modelHub.findConnection(connection.id)).resolves.toMatchObject({
      enabled: false,
      credentialRef: null,
      credentialState: "missing",
      lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
      revision: connection.revision + 2,
    });
  }, 15_000);

  it("deletes a credential, survives restart, and rebinds the same ordinary connection id", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let connection = await development.modelHub.saveConnection({
      id: "deepseek",
      providerKind: "deepseek",
      displayName: "DeepSeek",
      credentialRef: "keyring:model-hub:deepseek-original-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await development.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    await development.modelHub.syncCatalog({
      syncId: "deepseek-original-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "deepseek-original-model", providerModelId: "deepseek-v4-flash" }],
    });
    const secrets = new Map([["deepseek-original-slot", "test-old-key"]]);
    const credentials = {
      getSummary: vi.fn((providerId: string) =>
        Promise.resolve({
          configured: secrets.has(providerId),
          lastFour: secrets.get(providerId)?.slice(-4) ?? null,
        }),
      ),
      save: vi.fn((providerId: string, secret: string) => {
        secrets.set(providerId, secret);
        return Promise.resolve({ configured: true, lastFour: secret.slice(-4) });
      }),
      delete: vi.fn((providerId: string) => {
        secrets.delete(providerId);
        return Promise.resolve({ configured: false, lastFour: null });
      }),
    };
    const runtime: DesktopRuntime = { ...development, mode: "tauri", credentials };
    const user = userEvent.setup();
    const view = renderRoute(runtime);

    expect(
      await screen.findByRole("button", { name: "删除密钥" }, { timeout: 5_000 }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "删除密钥" }));
    expect(await screen.findByText("凭据已删除，可重新绑定")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "未连接", level: 3 })).toBeVisible();
    expect(screen.queryByText("AI 写作已就绪")).not.toBeInTheDocument();
    await expect(runtime.modelHub.findConnection("deepseek")).resolves.toMatchObject({
      enabled: false,
      credentialRef: null,
      credentialState: "missing",
      connectionStatus: "disabled",
    });
    expect(credentials.delete).toHaveBeenCalledWith("deepseek-original-slot");

    view.unmount();
    const reopenedDevelopment = createDevelopmentRuntime(window.localStorage);
    const reopened: DesktopRuntime = {
      ...reopenedDevelopment,
      mode: "tauri",
      credentials,
    };
    renderRoute(reopened);

    expect(await screen.findByText("凭据已删除，可重新绑定")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "未连接", level: 3 })).toBeVisible();
    expect(screen.queryByText("AI 写作已就绪")).not.toBeInTheDocument();
    const keyInput = screen.getByLabelText("接口密钥");
    await user.type(keyInput, "test-rebound-key");
    await user.click(screen.getByRole("button", { name: "重新绑定原连接" }));
    await waitFor(() =>
      expect(screen.queryByText(/MODEL_HUB_CONNECTION_ID_CONFLICT/u)).not.toBeInTheDocument(),
    );
    await expect(reopened.modelHub.findConnection("deepseek")).resolves.toMatchObject({
      id: "deepseek",
      enabled: true,
      credentialState: "present",
      connectionStatus: "not_tested",
    });
    expect(credentials.save).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("keeps a retired connection historical after restart and rebuilds the same provider with a new id", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let retired = await development.modelHub.saveConnection({
      id: "deepseek",
      providerKind: "deepseek",
      displayName: "旧 DeepSeek 连接",
      credentialRef: "keyring:model-hub:deepseek",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    retired = await development.modelHub.retireConnection({
      connectionId: retired.id,
      expectedRevision: retired.revision,
    });
    const secrets = new Map<string, string>();
    const credentials = {
      getSummary: vi.fn((providerId: string) =>
        Promise.resolve({
          configured: secrets.has(providerId),
          lastFour: secrets.get(providerId)?.slice(-4) ?? null,
        }),
      ),
      save: vi.fn((providerId: string, secret: string) => {
        secrets.set(providerId, secret);
        return Promise.resolve({ configured: true, lastFour: secret.slice(-4) });
      }),
      delete: vi.fn((providerId: string) => {
        secrets.delete(providerId);
        return Promise.resolve({ configured: false, lastFour: null });
      }),
    };
    const reopenedModelHub = new BrowserDevelopmentModelHubStore(
      window.localStorage,
      development.clock,
    );
    await expect(reopenedModelHub.listConnections()).resolves.toEqual([
      expect.objectContaining({ id: retired.id, enabled: false }),
    ]);
    const runtime: DesktopRuntime = {
      ...development,
      modelHub: reopenedModelHub,
      mode: "tauri",
      credentials,
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    expect(await screen.findByText("已退役连接历史（1）")).toBeVisible();
    expect(screen.queryByText("连接已退役")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /旧 DeepSeek 连接/u })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "供应商" }), "deepseek");
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    expect(screen.getByLabelText("配置标识")).toHaveValue("deepseek-2");
    await user.type(screen.getByLabelText("接口密钥"), "new-test-key");
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));

    await waitFor(async () => {
      await expect(runtime.modelHub.findConnection("deepseek-2")).resolves.toMatchObject({
        enabled: true,
        credentialState: "present",
      });
    });
    await expect(runtime.modelHub.findConnection(retired.id)).resolves.toMatchObject({
      enabled: false,
      connectionStatus: "disabled",
      lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
    });
    expect(credentials.save).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("validates custom paths and Header names before writing the operating-system credential", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const saveCredential = vi.fn(() => Promise.resolve({ configured: true, lastFour: "alue" }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: false, lastFour: null }),
        save: saveCredential,
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" });
    await user.click(await screen.findByRole("button", { name: "连接 AI 服务" }));
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled());
    await user.selectOptions(providerSelect, "custom_openai_compatible");
    fireEvent.change(screen.getByLabelText("服务根地址"), {
      target: { value: "https://custom-models.example/v1" },
    });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    expect(providerSelect).toHaveValue("custom_openai_compatible");
    expect(screen.getByRole("button", { name: "收起专家设置" })).toBeVisible();
    expect(screen.getByLabelText(/^模型目录路径/u)).toBeVisible();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "认证方式" }),
      "custom_header_keyring",
    );
    expect(providerSelect).toHaveValue("custom_openai_compatible");
    expect(screen.getByRole("button", { name: "收起专家设置" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("认证请求头名称"), {
      target: { value: "Host" },
    });
    fireEvent.change(screen.getByLabelText("认证请求头内容"), {
      target: { value: "super-secret-header-value" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));
    expect(await screen.findByText(/AI 服务暂未完成本次操作/u)).toBeVisible();
    expect(
      screen.queryByText(/MODEL_PROVIDER_CREDENTIAL_HEADER_FORBIDDEN/u),
    ).not.toBeInTheDocument();
    expect(saveCredential).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("认证请求头名称"), {
      target: { value: "x-api-key" },
    });
    fireEvent.change(await screen.findByLabelText(/^模型目录路径/u), {
      target: { value: "//attacker.example/models" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));
    expect(await screen.findByText(/AI 服务暂未完成本次操作/u)).toBeVisible();
    expect(screen.queryByText(/MODEL_PROVIDER_API_PATH_INVALID/u)).not.toBeInTheDocument();
    expect(saveCredential).not.toHaveBeenCalled();
  }, 15_000);

  it("rejects a cross-provider connection id before writing a credential", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    await development.modelHub.saveConnection({
      id: "shared-provider-id",
      providerKind: "openai",
      displayName: "Existing OpenAI",
      credentialRef: "keyring:model-hub:shared-provider-id",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const saveCredential = vi.fn(() => Promise.resolve({ configured: true, lastFour: "alue" }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: false, lastFour: null }),
        save: saveCredential,
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" });
    const beginConnection = screen.queryByRole("button", { name: "连接 AI 服务" });
    if (beginConnection !== null) await user.click(beginConnection);
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled(), { timeout: 8_000 });
    await user.selectOptions(providerSelect, "custom_openai_compatible");
    fireEvent.change(screen.getByLabelText("服务根地址"), {
      target: { value: "https://custom-models.example/v1" },
    });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    fireEvent.change(providerId, { target: { value: "shared-provider-id" } });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "认证方式" }),
      "custom_header_keyring",
    );
    fireEvent.change(await screen.findByLabelText("认证请求头名称"), {
      target: { value: "x-api-key" },
    });
    fireEvent.change(screen.getByLabelText("认证请求头内容"), {
      target: { value: "never-written-secret" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));

    expect(
      await screen.findByText(/AI 服务暂未完成本次操作/u, undefined, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.queryByText(/MODEL_HUB_PROVIDER_KIND_IMMUTABLE/u)).not.toBeInTheDocument();
    expect(saveCredential).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnection("shared-provider-id")).resolves.toMatchObject({
      providerKind: "openai",
    });
  }, 15_000);

  it("invalidates the delete action when a loaded connection id is changed across providers", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    await development.modelHub.saveConnection({
      id: "custom-delete-owner",
      providerKind: "custom_openai_compatible",
      displayName: "Custom delete owner",
      baseUrlOverride: "https://custom-delete.example/v1",
      credentialRef: "keyring:model-hub:custom-delete-owner",
      credentialState: "present",
      authenticationMode: "custom_header_keyring",
      credentialHeaderName: "x-api-key",
      expectedRevision: null,
    });
    await development.modelHub.saveConnection({
      id: "shared-delete-provider",
      providerKind: "openai",
      displayName: "Protected OpenAI",
      credentialRef: "keyring:model-hub:shared-delete-provider",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        save: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        delete: deleteCredential,
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" }, { timeout: 5_000 });
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled());
    await user.selectOptions(
      screen.getByRole("combobox", { name: /^现有供应商连接/u }),
      "custom-delete-owner",
    );
    await waitFor(() => expect(providerSelect).toHaveValue("custom_openai_compatible"));
    expect(await screen.findByRole("button", { name: "删除密钥" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    expect(providerId).toHaveValue("custom-delete-owner");
    fireEvent.change(providerId, { target: { value: "shared-delete-provider" } });

    expect(screen.queryByRole("button", { name: "删除密钥" })).not.toBeInTheDocument();
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnection("shared-delete-provider")).resolves.toMatchObject({
      providerKind: "openai",
      credentialState: "present",
    });
    await expect(runtime.modelHub.findConnection("custom-delete-owner")).resolves.toMatchObject({
      providerKind: "custom_openai_compatible",
      credentialState: "present",
    });
  }, 10_000);

  it("rejects writing a credential through another loaded connection of the same provider", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    await development.modelHub.saveConnection({
      id: "same-provider-owner",
      providerKind: "custom_openai_compatible",
      displayName: "Same provider owner",
      baseUrlOverride: "https://same-provider-owner.example/v1",
      credentialRef: "keyring:model-hub:same-provider-owner",
      credentialState: "present",
      authenticationMode: "custom_header_keyring",
      credentialHeaderName: "x-api-key",
      expectedRevision: null,
    });
    await development.modelHub.saveConnection({
      id: "same-provider-target",
      providerKind: "custom_openai_compatible",
      displayName: "Same provider target",
      baseUrlOverride: "https://same-provider-target.example/v1",
      credentialRef: "keyring:model-hub:same-provider-target",
      credentialState: "present",
      authenticationMode: "custom_header_keyring",
      credentialHeaderName: "x-target-key",
      expectedRevision: null,
    });
    const saveCredential = vi.fn(() => Promise.resolve({ configured: true, lastFour: "alue" }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        save: saveCredential,
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" });
    const storedConnections = await screen.findByRole("combobox", {
      name: /^现有供应商连接/u,
    });
    await waitFor(() => expect(storedConnections).toBeEnabled());
    await user.selectOptions(storedConnections, "same-provider-owner");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "供应商" })).toHaveValue(
        "custom_openai_compatible",
      ),
    );
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    fireEvent.change(providerId, { target: { value: "same-provider-target" } });
    fireEvent.change(screen.getByLabelText("认证请求头内容"), {
      target: { value: "never-overwrite-target" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));

    expect(await screen.findByText(/AI 服务暂未完成本次操作/u)).toBeVisible();
    expect(screen.queryByText(/MODEL_HUB_CONNECTION_ID_CONFLICT/u)).not.toBeInTheDocument();
    expect(saveCredential).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnection("same-provider-owner")).resolves.toMatchObject({
      baseUrl: "https://same-provider-owner.example/v1",
      credentialHeaderName: "x-api-key",
    });
    await expect(runtime.modelHub.findConnection("same-provider-target")).resolves.toMatchObject({
      baseUrl: "https://same-provider-target.example/v1",
      credentialHeaderName: "x-target-key",
    });
  }, 10_000);

  it("rejects saving connection metadata through another loaded connection of the same provider", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    await development.modelHub.saveConnection({
      id: "same-metadata-owner",
      providerKind: "custom_openai_compatible",
      displayName: "Same metadata owner",
      baseUrlOverride: "https://same-metadata-owner.example/v1",
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await development.modelHub.saveConnection({
      id: "same-metadata-target",
      providerKind: "custom_openai_compatible",
      displayName: "Same metadata target",
      baseUrlOverride: "https://same-metadata-target.example/v1",
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await development.modelHub.syncCatalog({
      syncId: "same-metadata-target-sync",
      connectionId: "same-metadata-target",
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "same-metadata-target-model",
          providerModelId: "target-model",
        },
      ],
    });
    await development.modelHub.saveTaskRoute({
      task: "rewrite",
      primaryCatalogEntryId: "same-metadata-target-model",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: false, lastFour: null }),
        save: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" }, { timeout: 5_000 });
    const storedConnections = await screen.findByRole("combobox", {
      name: /^现有供应商连接/u,
    });
    await waitFor(() => expect(storedConnections).toBeEnabled());
    await user.selectOptions(storedConnections, "same-metadata-owner");
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    fireEvent.change(providerId, { target: { value: "same-metadata-target" } });
    await user.click(screen.getByRole("button", { name: "保存供应商与模型" }));

    expect(await screen.findByText(/AI 服务暂未完成本次操作/u)).toBeVisible();
    expect(screen.queryByText(/MODEL_HUB_CONNECTION_ID_CONFLICT/u)).not.toBeInTheDocument();
    await expect(runtime.modelHub.findConnection("same-metadata-owner")).resolves.toMatchObject({
      baseUrl: "https://same-metadata-owner.example/v1",
    });
    await expect(runtime.modelHub.findConnection("same-metadata-target")).resolves.toMatchObject({
      baseUrl: "https://same-metadata-target.example/v1",
    });
    await expect(runtime.modelHub.listCatalog("same-metadata-target")).resolves.toMatchObject([
      { id: "same-metadata-target-model", providerModelId: "target-model" },
    ]);
    await expect(runtime.modelHub.findTaskRoute("rewrite")).resolves.toMatchObject({
      primaryCatalogEntryId: "same-metadata-target-model",
    });
  }, 10_000);

  it("invalidates deletion when the id is changed to another connection of the same provider", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    for (const [id, baseUrlOverride] of [
      ["same-delete-owner", "https://same-delete-owner.example/v1"],
      ["same-delete-target", "https://same-delete-target.example/v1"],
    ] as const) {
      await development.modelHub.saveConnection({
        id,
        providerKind: "custom_openai_compatible",
        displayName: id,
        baseUrlOverride,
        credentialRef: `keyring:model-hub:${id}`,
        credentialState: "present",
        authenticationMode: "custom_header_keyring",
        credentialHeaderName: "x-api-key",
        expectedRevision: null,
      });
    }
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        save: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        delete: deleteCredential,
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" }, { timeout: 5_000 });
    const storedConnections = await screen.findByRole(
      "combobox",
      { name: /^现有供应商连接/u },
      { timeout: 5_000 },
    );
    await waitFor(() => expect(storedConnections).toBeEnabled(), { timeout: 5_000 });
    await user.selectOptions(storedConnections, "same-delete-owner");
    expect(await screen.findByRole("button", { name: "删除密钥" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    fireEvent.change(providerId, { target: { value: "same-delete-target" } });

    expect(screen.queryByRole("button", { name: "删除密钥" })).not.toBeInTheDocument();
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnection("same-delete-owner")).resolves.toMatchObject({
      credentialState: "present",
    });
    await expect(runtime.modelHub.findConnection("same-delete-target")).resolves.toMatchObject({
      credentialState: "present",
    });
  }, 10_000);

  it("does not expose deletion after a loaded connection id is changed to a new id", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    await development.modelHub.saveConnection({
      id: "new-id-delete-owner",
      providerKind: "custom_openai_compatible",
      displayName: "New id delete owner",
      baseUrlOverride: "https://new-id-delete-owner.example/v1",
      credentialRef: "keyring:model-hub:new-id-delete-owner",
      credentialState: "present",
      authenticationMode: "custom_header_keyring",
      credentialHeaderName: "x-api-key",
      expectedRevision: null,
    });
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        save: () => Promise.resolve({ configured: true, lastFour: "alue" }),
        delete: deleteCredential,
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    await screen.findByRole("heading", { name: "墨影模型中心" }, { timeout: 5_000 });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /^现有供应商连接/u })).toBeEnabled(),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /^现有供应商连接/u }),
      "new-id-delete-owner",
    );
    expect(await screen.findByRole("button", { name: "删除密钥" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    fireEvent.change(providerId, { target: { value: "brand-new-provider-id" } });

    expect(screen.queryByRole("button", { name: "删除密钥" })).not.toBeInTheDocument();
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnection("brand-new-provider-id")).resolves.toBeNull();
    await expect(runtime.modelHub.findConnection("new-id-delete-owner")).resolves.toMatchObject({
      credentialState: "present",
    });
  }, 10_000);

  it("keeps focus on the requested settings section during hash navigation", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const originalDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderRoute(runtime, "/settings");
      const pageHeading = await screen.findByRole("heading", { name: "全局设置", level: 1 });
      await user.click(screen.getByRole("link", { name: "导入与导出" }));

      const target = document.getElementById("data-transfer");
      expect(target).not.toBeNull();
      const targetHeading = screen.getByRole("heading", { name: "导入与导出", level: 2 });
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: "smooth",
          block: "start",
        });
        expect(targetHeading).toHaveFocus();
        expect(screen.getByRole("link", { name: "导入与导出" })).toHaveAttribute(
          "aria-current",
          "location",
        );
        expect(pageHeading).not.toHaveFocus();
      });
    } finally {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalDescriptor);
      }
    }
  });

  it("runs the active quick jump again when the same settings link is selected", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const originalDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderRoute(runtime, "/settings#data-transfer");
      const link = await screen.findByRole("link", { name: "导入与导出" });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

      screen.getByRole("heading", { name: "全局设置", level: 1 }).focus();
      const callsBeforeRepeat = scrollIntoView.mock.calls.length;
      await user.click(link);

      await waitFor(() =>
        expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBeforeRepeat),
      );
      expect(screen.getByRole("heading", { name: "导入与导出", level: 2 })).toHaveFocus();
    } finally {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalDescriptor);
      }
    }
  });

  it("restores the import and export section from a direct deep link", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const originalDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderRoute(runtime, "/settings#data-transfer");

      const targetHeading = await screen.findByRole("heading", {
        name: "导入与导出",
        level: 2,
      });
      await waitFor(() => {
        expect(targetHeading).toHaveFocus();
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      });
      expect(screen.getByRole("link", { name: "导入与导出" })).toHaveAttribute(
        "aria-current",
        "location",
      );
      expect(screen.getByRole("heading", { name: "导出项目", level: 3 })).toBeVisible();
    } finally {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalDescriptor);
      }
    }
  });

  it("restores the import and export section from a direct deep link in direct writing mode", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("direct", preference.revision);
    const originalDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderRoute(runtime, "/settings#data-transfer");

      const targetHeading = await screen.findByRole("heading", {
        name: "导入与导出",
        level: 2,
      });
      await waitFor(() => {
        expect(targetHeading).toHaveFocus();
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      });
      expect(screen.getByRole("link", { name: "导入与导出" })).toHaveAttribute(
        "aria-current",
        "location",
      );
      expect(screen.getByRole("heading", { name: "导出项目", level: 3 })).toBeVisible();
    } finally {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalDescriptor);
      }
    }
  });

  it("opens the real diagnostics section from a direct writing mode deep link", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const originalDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderRoute(runtime, "/settings#diagnostics");

      expect(
        await screen.findByRole("heading", { name: "全局设置", level: 1 }, { timeout: 5_000 }),
      ).toBeVisible();
      const targetHeading = await screen.findByRole("heading", {
        name: "脱敏诊断包",
        level: 2,
      });
      await waitFor(() => {
        expect(targetHeading).toHaveFocus();
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      });
      expect(screen.getByRole("link", { name: "诊断" })).toHaveAttribute(
        "aria-current",
        "location",
      );
      expect(screen.getByRole("button", { name: "下载脱敏诊断包" })).toBeVisible();
      expect(screen.getByText("不含正文与密钥")).toBeVisible();
      await expect(runtime.writingExperience.getOrInitialize()).resolves.toMatchObject({
        mode: "direct",
      });
    } finally {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalDescriptor);
      }
    }
  });

  it("persists an exact primary and fallback model snapshot for a role", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelCenter.save({
      providerId: "remote-writer",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example/v1",
      authentication: "none",
      selectedModel: "writer-pro",
      pricing: pricing("remote-2026-07"),
      expectedRevision: null,
    });
    await runtime.modelCenter.save({
      providerId: "local-writer",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "qwen-local",
      pricing: pricing("local-zero-cost"),
      expectedRevision: null,
    });
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-routing");

    const heading = await screen.findByRole("heading", { name: "创作任务安排" });
    const routingCard = heading.closest<HTMLElement>(".ink-card");
    if (routingCard === null) {
      throw new Error("Expected the model routing card.");
    }
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const primaryControl = within(routingCard).getByRole("combobox", { name: "兼容主模型" });
    const fallbackControl = within(routingCard).getByRole("combobox", {
      name: /^兼容备用模型/u,
    });
    await user.selectOptions(primaryControl, "remote-writer");
    await user.selectOptions(fallbackControl, "local-writer");
    await user.click(within(routingCard).getByRole("button", { name: "保存角色任务安排" }));

    await waitFor(async () => {
      await expect(runtime.modelRouting.findRoute("high_quality")).resolves.toMatchObject({
        role: "high_quality",
        primaryProviderId: "remote-writer",
        primaryModelId: "writer-pro",
        fallbackProviderId: "local-writer",
        fallbackModelId: "qwen-local",
        revision: 1,
      });
    });
    const reopened = createDevelopmentRuntime(window.localStorage);
    await expect(reopened.modelRouting.findRoute("high_quality")).resolves.toMatchObject({
      primaryProviderId: "remote-writer",
      primaryModelId: "writer-pro",
      fallbackProviderId: "local-writer",
      fallbackModelId: "qwen-local",
    });
  });

  it("checks loopback Ollama while offline and shows only a conservative capacity verdict", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    await developmentRuntime.modelCenter.save({
      providerId: "ollama-local",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: null,
      pricing: null,
      expectedRevision: null,
    });
    const checkConnection = vi.fn<NativeModelGatewayClient["checkConnection"]>(() =>
      Promise.resolve({
        provider: "ollama",
        endpointOrigin: "http://127.0.0.1:11434",
        modelCount: 1,
        latencyMs: 7,
      }),
    );
    const modelGateway: NativeModelGatewayClient = {
      available: true,
      checkConnection,
      listModels: () =>
        Promise.resolve({
          provider: "ollama",
          models: [
            {
              id: "qwen2.5:7b-instruct",
              displayName: "qwen2.5:7b-instruct",
              sizeBytes: 4 * 1024 ** 3,
            },
          ],
        }),
      inspectCapacity: () =>
        Promise.resolve({
          logicalCpuCount: 8,
          physicalMemory: {
            status: "measured",
            totalBytes: 16 * 1024 ** 3,
            availableBytes: 8 * 1024 ** 3,
            reason: null,
          },
          applicationDataDisk: {
            status: "measured",
            totalBytes: 512 * 1024 ** 3,
            availableBytes: 200 * 1024 ** 3,
            reason: null,
          },
          gpuMemory: {
            status: "unavailable",
            totalBytes: null,
            availableBytes: null,
            reason: "gpu_capacity_not_measured",
          },
        }),
      embed: () => Promise.reject(new Error("not used")),
      generate: () => Promise.reject(new Error("not used")),
      cancelGeneration: () => Promise.resolve(false),
    };
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      modelGateway,
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const checkButton = await screen.findByRole("button", {
      name: "测试连接并发现模型",
    });
    await waitFor(() => expect(checkButton).toBeEnabled());
    await user.click(checkButton);

    expect(await screen.findByText("本地模型容量初步体检")).toBeInTheDocument();
    expect(screen.getByText(/内存余量初步通过/u)).toHaveTextContent("GPU/显存未测量");
    expect(checkConnection).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "保存供应商与模型" }));
    await waitFor(async () => {
      await expect(runtime.modelCenter.findByProviderId("ollama-local")).resolves.toMatchObject({
        selectedModel: "qwen2.5:7b-instruct",
      });
    });
    const localCatalog = await runtime.modelHub.listCatalog("ollama-local");
    await expect(
      runtime.modelHub.findCostPrivacyProfile(localCatalog[0]?.id ?? "missing"),
    ).resolves.toMatchObject({
      dataDestination: "local",
      retentionPolicy: "none",
      trainingPolicy: "not_used",
    });

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "要检查的能力" }),
      "text_generation",
    );
    expect(await screen.findByText(/请求只在本机运行/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const editedBaseUrl = screen.getByLabelText("基础地址");
    await user.clear(editedBaseUrl);
    await user.type(editedBaseUrl, "https://remote-after-confirmation.example/v1");
    expect(await screen.findByText(/请求会发送到所选远程供应商/u)).toBeVisible();
    expect(screen.queryByText(/请求只在本机运行/u)).not.toBeInTheDocument();
  });

  it("records a remote Ollama endpoint as remote instead of local privacy", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    await developmentRuntime.modelCenter.save({
      providerId: "ollama-remote",
      provider: "ollama",
      baseUrl: "https://remote-ollama.example",
      authentication: "none",
      selectedModel: null,
      pricing: null,
      expectedRevision: null,
    });
    const modelGateway: NativeModelGatewayClient = {
      available: true,
      checkConnection: () =>
        Promise.resolve({
          provider: "ollama",
          endpointOrigin: "https://remote-ollama.example",
          modelCount: 1,
          latencyMs: 12,
        }),
      listModels: () =>
        Promise.resolve({
          provider: "ollama",
          models: [{ id: "remote-model", displayName: "remote-model", sizeBytes: null }],
        }),
      inspectCapacity: () =>
        Promise.resolve({
          logicalCpuCount: 1,
          physicalMemory: {
            status: "unavailable",
            totalBytes: null,
            availableBytes: null,
            reason: "not_local",
          },
          applicationDataDisk: {
            status: "unavailable",
            totalBytes: null,
            availableBytes: null,
            reason: "not_local",
          },
          gpuMemory: {
            status: "unavailable",
            totalBytes: null,
            availableBytes: null,
            reason: "not_local",
          },
        }),
      embed: () => Promise.reject(new Error("not used")),
      generate: () => Promise.reject(new Error("not used")),
      cancelGeneration: () => Promise.resolve(false),
    };
    const runtime: DesktopRuntime = { ...developmentRuntime, modelGateway };
    const user = userEvent.setup();
    renderRoute(runtime);

    await user.click(await screen.findByRole("button", { name: "测试连接并发现模型" }));
    await screen.findByRole("option", { name: "remote-model" });
    await user.click(screen.getByRole("button", { name: "保存供应商与模型" }));

    await waitFor(async () => {
      const catalog = await runtime.modelHub.listCatalog("ollama-remote");
      await expect(
        runtime.modelHub.findCostPrivacyProfile(catalog[0]?.id ?? "missing"),
      ).resolves.toMatchObject({
        dataDestination: "remote",
        retentionPolicy: "provider_default",
        trainingPolicy: "unknown",
      });
    });
  });

  it("lets Qwen users refresh /models before running the matching embedding probe", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    await developmentRuntime.modelHub.saveConnection({
      id: "qwen-embedding",
      providerKind: "alibaba_qwen",
      displayName: "阿里云百炼 / Qwen",
      region: "singapore",
      baseUrlOverride: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      credentialRef: "keyring:legacy-model-profile:qwen-embedding",
      credentialState: "present",
      expectedRevision: null,
    });
    const listModels = vi.fn<NativeModelGatewayClient["listModels"]>(() =>
      Promise.resolve({
        provider: "open_ai_compatible",
        models: [
          {
            id: "text-embedding-v4",
            displayName: "text-embedding-v4",
          },
        ],
      }),
    );
    const generate = vi.fn<NativeModelGatewayClient["generate"]>();
    const embed = vi.fn<NativeModelGatewayClient["embed"]>(() =>
      Promise.resolve({
        provider: "open_ai_compatible",
        endpointOrigin: "https://dashscope-intl.aliyuncs.com",
        model: "text-embedding-v4",
        vectorCount: 1,
        dimension: 3,
        embeddings: [[0.25, -0.5, 0.75]],
      }),
    );
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
      modelGateway: {
        available: true,
        checkConnection: () =>
          Promise.resolve({
            provider: "open_ai_compatible",
            endpointOrigin: "https://dashscope-intl.aliyuncs.com",
            modelCount: 1,
            latencyMs: 12,
          }),
        listModels,
        generate,
        embed,
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const refreshButton = await screen.findByRole("button", {
      name: "重新读取模型列表",
    });
    await waitFor(() => expect(refreshButton).toBeEnabled());
    await user.click(refreshButton);

    expect(await screen.findByText("text-embedding-v4")).toBeVisible();
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    const catalogAfterRefresh = await runtime.modelHub.listCatalog("qwen-embedding");
    expect(catalogAfterRefresh).toEqual([
      expect.objectContaining({
        providerModelId: "text-embedding-v4",
        catalogSource: "provider_api",
      }),
    ]);
    const refreshedConnection = await runtime.modelHub.findConnection("qwen-embedding");
    expect(refreshedConnection?.catalogSyncStatus).toBe("succeeded");
    expect(typeof refreshedConnection?.lastCatalogSyncedAt).toBe("string");
    expect(screen.getByRole("combobox", { name: "要检查的能力" })).toHaveValue("embedding");

    const verifyButton = screen.getByRole("button", {
      name: "确认 1 次固定验证",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("语义向量能力已验证")).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledTimes(1);
    const embeddingInput = embed.mock.calls[0]?.[0];
    expect(embeddingInput).toMatchObject({
      dispatchScope: { kind: "non_project", reason: "connection_probe" },
      config: {
        providerId: "qwen-embedding",
        provider: "open_ai_compatible",
        retryLimit: 0,
      },
      model: "text-embedding-v4",
      inputs: ["墨影向量能力检查"],
    });
    const selected = catalogAfterRefresh[0];
    await expect(
      runtime.modelHub.listCapabilityEvidence(selected?.id ?? "missing"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "embedding",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        }),
      ]),
    );
    await expect(
      runtime.modelHub.findCostPrivacyProfile(selected?.id ?? "missing"),
    ).resolves.toMatchObject({
      dataDestination: "remote",
      retentionPolicy: "provider_default",
      trainingPolicy: "unknown",
      evidenceSource: "provider_metadata",
    });
  }, 30_000);

  it("preserves a manual Qwen model and its persisted source when /models refresh fails", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    await developmentRuntime.modelHub.saveConnection({
      id: "qwen-refresh-failure",
      providerKind: "alibaba_qwen",
      displayName: "Qwen 刷新失败测试",
      region: "singapore",
      baseUrlOverride: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      credentialRef: "keyring:model-hub:qwen-refresh-failure",
      credentialState: "present",
      expectedRevision: null,
    });
    await developmentRuntime.modelHub.syncCatalog({
      syncId: "qwen-refresh-failure-manual-sync",
      connectionId: "qwen-refresh-failure",
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "catalog-qwen-manual",
          providerModelId: "qwen-manual-model",
          displayName: "Qwen 手动模型",
        },
      ],
    });
    const listModels = vi.fn<NativeModelGatewayClient["listModels"]>(() =>
      Promise.reject(new Error("MODEL_HUB_HTTP_STATUS:404")),
    );
    const generate = vi.fn<NativeModelGatewayClient["generate"]>();
    const embed = vi.fn<NativeModelGatewayClient["embed"]>();
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
      modelGateway: {
        available: true,
        checkConnection: () =>
          Promise.resolve({
            provider: "open_ai_compatible",
            endpointOrigin: "https://dashscope-intl.aliyuncs.com",
            modelCount: 0,
            latencyMs: 10,
          }),
        listModels,
        generate,
        embed,
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const user = userEvent.setup();
    const firstRender = renderRoute(runtime);

    expect(await screen.findByText(/手动添加/u)).toBeVisible();
    const refreshButton = screen.getByRole("button", { name: "重新读取模型列表" });
    await waitFor(() => expect(refreshButton).toBeEnabled());
    await user.click(refreshButton);

    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/手动添加/u)).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnection("qwen-refresh-failure")).resolves.toMatchObject({
      catalogSyncStatus: "failed",
    });
    await expect(runtime.modelHub.listCatalog("qwen-refresh-failure")).resolves.toEqual([
      expect.objectContaining({
        providerModelId: "qwen-manual-model",
        catalogSource: "manual",
      }),
    ]);

    firstRender.unmount();
    renderRoute(runtime);
    expect(await screen.findByText(/手动添加/u)).toBeVisible();
    expect(screen.queryByText(/从服务商读取/u)).not.toBeInTheDocument();
  }, 30_000);

  it("discloses and sends the same effective Volcengine 接入点编号 when both model fields differ", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    await developmentRuntime.modelHub.saveConnection({
      id: "doubao-effective-model",
      providerKind: "volcengine_doubao",
      displayName: "豆包有效接入点测试",
      endpointId: "doubao-endpoint-actual",
      baseUrlOverride: "https://ark.cn-beijing.volces.com/api/v3",
      credentialRef: "keyring:legacy-model-profile:doubao-effective-model",
      credentialState: "present",
      expectedRevision: null,
    });
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({
        text: "OK",
        usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
        streamed: false,
      }),
    );
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
      modelGateway: {
        available: true,
        checkConnection: () => Promise.reject(new Error("manual provider uses the probe")),
        listModels: () => Promise.reject(new Error("manual provider must not call /models")),
        generate,
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const endpointInput = await screen.findByRole("textbox", { name: /^接入点编号/u });
    expect(endpointInput).toHaveValue("doubao-endpoint-actual");
    const modelInput = screen.getByRole("textbox", { name: "模型名称或接入点编号" });
    await user.type(modelInput, "doubao-model-only-visible-field");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "要检查的能力" }),
      "text_generation",
    );

    expect(
      await screen.findByText(/的“doubao-endpoint-actual”发送固定短句“只回复：OK”/u),
    ).toBeVisible();
    expect(
      screen.queryByText(/的“doubao-model-only-visible-field”发送固定短句“只回复：OK”/u),
    ).not.toBeInTheDocument();

    const verifyButton = screen.getByRole("button", {
      name: "确认 1 次固定验证并检查连接",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      model: "doubao-endpoint-actual",
      dispatchScope: { kind: "non_project", reason: "connection_probe" },
      messages: [{ role: "user", content: "只回复：OK" }],
      maxOutputTokens: 64,
      config: { retryLimit: 0 },
    });
  }, 30_000);

  it("uses the DeepSeek probe policy and automatically configures only compatible text tasks", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    let connection = await developmentRuntime.modelHub.saveConnection({
      id: "deepseek-writing",
      providerKind: "deepseek",
      displayName: "DeepSeek",
      credentialRef: "keyring:model-hub:deepseek-writing",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await developmentRuntime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    await developmentRuntime.modelHub.syncCatalog({
      syncId: "deepseek-writing-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        {
          id: "deepseek-v4-flash-catalog",
          providerModelId: "deepseek-v4-flash",
          displayName: "deepseek-v4-flash",
        },
      ],
    });
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({
        text: "OK",
        usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
        streamed: false,
      }),
    );
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
      modelGateway: {
        available: true,
        checkConnection: () => Promise.reject(new Error("not used")),
        listModels: () => Promise.reject(new Error("not used")),
        generate,
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "要检查的能力" }),
      "text_generation",
    );
    expect(await screen.findByText(/AI 最多返回 64 个文字量单位/u)).toBeVisible();
    expect(screen.queryByText(/AI 最多返回 8 个文字量单位/u)).not.toBeInTheDocument();
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      model: "deepseek-v4-flash",
      maxOutputTokens: 64,
      reasoningMode: "disabled",
    });
    const catalog = await runtime.modelHub.listCatalog("deepseek-writing");
    await expect(
      runtime.modelHub.findCostPrivacyProfile(catalog[0]?.id ?? "missing"),
    ).resolves.toMatchObject({
      dataDestination: "remote",
      evidenceSource: "provider_metadata",
    });
    const enabledRoutes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task)))
    ).flatMap((route) => (route?.enabled === true ? [route] : []));
    expect(enabledRoutes).toHaveLength(14);
    expect(
      enabledRoutes.every(({ primaryCatalogEntryId }) => primaryCatalogEntryId === catalog[0]?.id),
    ).toBe(true);
    await expect(runtime.modelHub.findTaskRoute("embedding")).resolves.toBeNull();
    await expect(runtime.modelHub.findTaskRoute("image_generation")).resolves.toBeNull();
    await expect(runtime.modelHub.findTaskRoute("outline_planning")).resolves.toBeNull();
    await expect(runtime.modelHub.findTaskRoute("scene_breakdown")).resolves.toBeNull();
  });

  it("repairs an interrupted current automatic smart plan without revising matching routes", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-routing-recovery");
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-routing-recovery-seed-scan",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "routing-recovery-v1",
      evidence: [
        {
          id: "deepseek-routing-recovery-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
    const seeded = await applyAutomaticModelHubRouting({
      modelHub: prepared.runtime.modelHub,
      legacyRouting: prepared.runtime.modelRouting,
      legacyReadyModels: [],
      scheme: "smart",
      now: "2026-08-09T20:00:00.000Z",
    });
    expect(seeded.savedNovelTaskCount).toBe(14);
    const missingRoute = await prepared.runtime.modelHub.findTaskRoute("content_quality_check");
    const unchangedRoute = await prepared.runtime.modelHub.findTaskRoute("idea_discussion");
    if (missingRoute === null || unchangedRoute === null) {
      throw new Error("Expected the seeded text routes.");
    }
    await prepared.runtime.modelHub.deleteTaskRoute(missingRoute.task, missingRoute.revision);
    const interruptedRoutes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(interruptedRoutes).toHaveLength(13);

    const user = userEvent.setup();
    renderRoute(prepared.runtime);
    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "创作任务安排" }));
    expect(await screen.findByText("14 / 22 类已配置 · 8 类缺能力")).toBeVisible();
    const recovered = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).flatMap((route) => (route?.enabled === true ? [route] : []));
    expect(recovered).toHaveLength(14);
    await expect(
      prepared.runtime.modelHub.findTaskRoute("content_quality_check"),
    ).resolves.toMatchObject({
      routeOrigin: "automatic",
      presetId: "automatic-smart",
      enabled: true,
    });
    await expect(prepared.runtime.modelHub.findTaskRoute("idea_discussion")).resolves.toEqual(
      unchangedRoute,
    );
  });

  it("recalculates a v1 automatic plan while preserving an exact manual route", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-routing-v1-recalculation");
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-routing-v1-recalculation-seed-scan",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "routing-v1-recalculation",
      evidence: [
        {
          id: "deepseek-routing-v1-recalculation-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
    const seeded = await applyAutomaticModelHubRouting({
      modelHub: prepared.runtime.modelHub,
      legacyRouting: prepared.runtime.modelRouting,
      legacyReadyModels: [],
      scheme: "smart",
      now: "2026-08-09T20:00:00.000Z",
    });
    expect(seeded.savedNovelTaskCount).toBe(14);
    for (const task of ["outline_planning", "scene_breakdown"] as const) {
      await prepared.runtime.modelHub.saveTaskRoute({
        task,
        primaryCatalogEntryId: prepared.catalogEntryId,
        presetId: "automatic-smart",
        privacyPolicy: "cloud_allowed",
        failurePolicy: "ask_user",
        routeOrigin: "automatic",
        expectedRevision: null,
      });
    }
    const existingManualTarget = await prepared.runtime.modelHub.findTaskRoute("prose_generation");
    if (existingManualTarget === null) {
      throw new Error("Expected the seeded prose route.");
    }
    const manual = await prepared.runtime.modelHub.saveTaskRoute({
      task: existingManualTarget.task,
      primaryCatalogEntryId: existingManualTarget.primaryCatalogEntryId,
      fallbackCatalogEntryId: existingManualTarget.fallbackCatalogEntryId,
      presetId: null,
      parameterPolicy: existingManualTarget.parameterPolicy,
      maximumCostMicros: existingManualTarget.maximumCostMicros,
      currency: existingManualTarget.currency,
      privacyPolicy: existingManualTarget.privacyPolicy,
      failurePolicy: "stop",
      routeOrigin: "user",
      enabled: true,
      expectedRevision: existingManualTarget.revision,
    });
    const activePreset = await prepared.runtime.modelHub.findActivePreset();
    if (activePreset === null) {
      throw new Error("Expected the seeded automatic preset.");
    }
    await prepared.runtime.modelHub.savePreset({
      id: activePreset.id,
      scheme: activePreset.scheme,
      displayName: activePreset.displayName,
      status: activePreset.status,
      privacyPolicy: activePreset.privacyPolicy,
      costPriority: activePreset.costPriority,
      routeGenerationVersion: "model-hub-evidence-router-v1",
      expectedRevision: activePreset.revision,
    });

    const before = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(before).toHaveLength(16);

    const user = userEvent.setup();
    renderRoute(prepared.runtime);
    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    await waitFor(async () => {
      await expect(prepared.runtime.modelHub.findActivePreset()).resolves.toMatchObject({
        id: "automatic-smart",
        routeGenerationVersion: "model-hub-evidence-router-v3",
      });
    });
    await expect(prepared.runtime.modelHub.findTaskRoute("outline_planning")).resolves.toBeNull();
    await expect(prepared.runtime.modelHub.findTaskRoute("scene_breakdown")).resolves.toBeNull();
    await expect(prepared.runtime.modelHub.findTaskRoute("prose_generation")).resolves.toEqual(
      manual,
    );
    const recalculated = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(recalculated).toHaveLength(14);
  });

  it("keeps a successful writing probe visible when the initial routing transaction fails", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-routing-write-failure");
    vi.spyOn(prepared.runtime.modelHub, "applyAutomaticRoutingPlan").mockRejectedValue(
      new ModelHubStoreError(
        "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
        "injected routing transaction failure",
        true,
      ),
    );
    const user = userEvent.setup();
    renderRoute(prepared.runtime);

    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    expect(screen.getByText(/写作能力证据已保留；自动安排未完成/u)).toBeVisible();
    expect(screen.getByText("创作任务安排没有保存")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "创作任务安排" }));
    expect(screen.getByText("配置写入失败")).toBeVisible();
    expect(screen.getAllByText("创作任务安排没有保存").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/模型中心的 22 项创作任务安排没有被修改，本次保存已完整撤销/u),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "重试保存" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导出脱敏诊断" })).toBeVisible();
    expect(screen.queryByText(/INSERT INTO|UPDATE novel_task_routes/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/MODEL_HUB_ROUTING_PLAN_WRITE_FAILED/u)).not.toBeInTheDocument();
    await expect(
      prepared.runtime.modelHub.listCapabilityEvidence(prepared.catalogEntryId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        }),
      ]),
    );
    const routes = await Promise.all(
      NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)),
    );
    expect(routes.every((route) => route === null)).toBe(true);
  });

  it("reports the fail-closed legacy projection truthfully when local privacy routing fails", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-local-privacy-failure");
    await prepared.runtime.modelCenter.save({
      providerId: "deepseek-local-privacy-failure",
      provider: "open_ai_compatible",
      baseUrl: "https://api.deepseek.com",
      authentication: "bearer_keyring",
      selectedModel: "deepseek-v4-flash",
      pricing: null,
      expectedRevision: null,
    });
    await prepared.runtime.modelRouting.saveRoute({
      role: "high_quality",
      primaryProviderId: "deepseek-local-privacy-failure",
      fallbackProviderId: null,
      expectedRevision: null,
    });
    vi.spyOn(prepared.runtime.modelHub, "applyAutomaticRoutingPlan").mockRejectedValue(
      new ModelHubStoreError(
        "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
        "injected local privacy routing failure",
        true,
      ),
    );
    const user = userEvent.setup();
    renderRoute(prepared.runtime, "/settings#model-routing");

    const scheme = await screen.findByRole("combobox", { name: "使用方案" });
    await user.selectOptions(scheme, "local_privacy");
    await user.click(screen.getByRole("button", { name: "应用创作任务安排" }));

    expect(
      await screen.findByText(/模型中心的 22 项创作任务安排未修改.*旧版兼容设置可能已被安全停用/u),
    ).toBeVisible();
    expect(screen.queryByText(/之前的创作任务安排没有被修改，事务已回滚/u)).not.toBeInTheDocument();
    await expect(prepared.runtime.modelRouting.listRoutes()).resolves.toEqual([]);
    const routes = await Promise.all(
      NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)),
    );
    expect(routes.every((route) => route === null)).toBe(true);
  });

  it("shows a partial capability status while preserving a committed plan when legacy sync fails", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-manual-routing");
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-manual-routing-scan",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "manual-routing-v1",
      evidence: [
        {
          id: "deepseek-manual-routing-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
    const user = userEvent.setup();
    renderRoute(prepared.runtime, "/settings#model-routing");
    await screen.findByRole("heading", { name: "创作任务安排" });
    vi.spyOn(prepared.runtime.modelRouting, "listRoutes").mockRejectedValue(
      new Error("injected legacy projection failure"),
    );

    await user.click(screen.getByRole("button", { name: "应用创作任务安排" }));

    expect(await screen.findByText("14 / 22 类已配置 · 8 类缺能力")).toBeVisible();
    expect(await screen.findByText("模型连接或创作任务安排需要修复")).toBeVisible();
    expect(screen.queryByText("AI 基础配置已可用")).not.toBeInTheDocument();
    expect(screen.getAllByText(/基础配置检查未通过.*数据去向与隐私信息尚未确认/u)).toHaveLength(10);
    expect(screen.getByRole("heading", { name: "当前模型能做什么" })).toBeVisible();
    expect(screen.getByText(/由用户确认，尚未实测 · 用户确认/u)).toBeVisible();
    await user.click(screen.getByText("查看已配置的 14 项"));
    expect(screen.getAllByText("正文生成").length).toBeGreaterThan(0);
    await user.click(screen.getByText("查看尚未配置的 8 项"));
    expect(screen.getAllByText("语义记忆").length).toBeGreaterThan(0);
    expect(screen.getAllByText("其他基础配置不受影响").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "完善全部功能还需要" })).toBeVisible();
    expect(await screen.findByText(/旧版兼容设置暂未同步/u)).toBeVisible();
    expect(screen.getByText("创作任务安排部分配置完成")).toBeVisible();
    expect(screen.queryByText(/MODEL_HUB_LEGACY_SYNC_FAILED/u)).not.toBeInTheDocument();
    const routes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).flatMap((route) => (route?.enabled === true ? [route] : []));
    expect(routes).toHaveLength(14);
  });

  it("keeps capability failure codes out of the ordinary Model Hub view", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-safe-capability-failure");
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-safe-capability-supported",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "safe-capability-v1",
      evidence: [
        {
          id: "deepseek-safe-capability-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-safe-capability-failure",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "lightweight_probe",
      status: "failed",
      evidenceVersion: "safe-capability-v2",
      errorCode: "MODEL_OUTPUT_TRUNCATED",
    });

    renderRoute(prepared.runtime, "/settings#model-routing");

    expect(
      await screen.findByRole("heading", { name: "当前模型能做什么" }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.getAllByText(/最近一次验证未返回完整可见内容/u).length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent("MODEL_OUTPUT_TRUNCATED");
  });

  it("shows the exact Chinese capability failure stage and keeps HTTP details advanced", async () => {
    const prepared = await createReadyDeepSeekProbeRuntime("deepseek-capability-not-found");
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.reject(
        Object.assign(new Error("provider returned not found"), {
          code: "MODEL_HTTP_NOT_FOUND",
          retryable: false,
          diagnostics: { httpStatus: 404 },
        }),
      ),
    );
    const runtime: DesktopRuntime = {
      ...prepared.runtime,
      modelGateway: {
        ...prepared.runtime.modelGateway,
        generate,
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    const failureTitle = await screen.findByText("模型能力检查失败");
    const alert = failureTitle.closest("[role='alert']");
    if (!(alert instanceof HTMLElement)) throw new Error("Expected a capability failure alert.");
    expect(within(alert).getByText(/阶段：服务商响应/u)).toBeVisible();
    expect(within(alert).getByText(/模型或接口路径.*证据不足以判断是哪一项不匹配/u)).toBeVisible();
    expect(within(alert).getByText(/同时核对模型标识和接口路径/u)).toBeVisible();
    expect(within(alert).getByText(/问题编号：墨影-.*联系支持时提供/u)).toBeVisible();
    expect(within(alert).queryByText(/404|MODEL_HTTP_NOT_FOUND/u)).not.toBeInTheDocument();

    const advanced = screen.getByText("查看高级诊断详情").closest("details");
    if (!(advanced instanceof HTMLDetailsElement)) {
      throw new Error("Expected advanced capability diagnostics.");
    }
    expect(advanced.open).toBe(false);
    await user.click(within(advanced).getByText("查看高级诊断详情"));
    expect(within(advanced).getByText(/内部错误编号：MODEL_HTTP_NOT_FOUND/u)).toBeVisible();
    expect(within(advanced).getByText(/服务响应状态：404/u)).toBeVisible();
    expect(generate).toHaveBeenCalledTimes(1);
    const invocations = await runtime.modelHub.listRecentAiFailures();
    expect(invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedErrorCode: "MODEL_HTTP_NOT_FOUND",
          httpStatus: 404,
          taskType: "capability_probe",
        }),
      ]),
    );
  }, 15_000);

  it("shows an uncertain capability result as pending review without a failed scan or redispatch", async () => {
    const connectionId = "deepseek-ambiguous-capability";
    const prepared = await createReadyDeepSeekProbeRuntime(connectionId);
    await prepared.runtime.modelHub.recordCapabilityScan({
      scanId: "deepseek-ambiguous-prior-success",
      catalogEntryId: prepared.catalogEntryId,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "ambiguous-prior-success-v1",
      evidence: [
        {
          id: "deepseek-ambiguous-prior-success-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    });
    const generate = vi.fn(async (input: NativeModelGenerationInput) => {
      const ledger = input.invocationDispatchLedger;
      if (ledger === undefined) throw new Error("测试缺少原生调用账本边界。");
      const invocation = await prepared.runtime.modelHub.markInvocationDispatched({
        id: ledger.invocationId,
        dispatchedAt: prepared.runtime.clock.now(),
        expectedRevision: ledger.expectedRevision,
      });
      void invocation;
      throw Object.assign(new Error("simulated invalid native dispatch receipt"), {
        code: "MODEL_INVOCATION_DISPATCH_RECEIPT_INVALID",
      });
    });
    const runtime: DesktopRuntime = {
      ...prepared.runtime,
      modelGateway: {
        ...prepared.runtime.modelGateway,
        supportsNativeInvocationDispatchLedger: true,
        generate,
      },
    };
    const user = userEvent.setup();
    const first = renderRoute(runtime);
    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("模型能力检查结果待核对")).toBeVisible();
    expect(screen.getByText(/系统不会自动重发；连接和模型目录会保留/u)).toBeVisible();
    expect(screen.queryByText("写作能力验证失败")).not.toBeInTheDocument();
    expect(screen.queryByText(/修正模型或接入点后可以重试/u)).not.toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
    await expect(runtime.modelHub.findConnection(connectionId)).resolves.toMatchObject({
      connectionStatus: "ready",
    });
    expect(
      readSafeModelHubSessionDiagnostics(runtime, runtime.clock.now()).recentModelHubActions.find(
        ({ action }) => action === "verify_capability",
      ),
    ).toMatchObject({
      outcome: "succeeded_with_warning",
      backendCommitted: true,
    });
    await waitFor(async () => {
      const recentFailures = await runtime.modelHub.listRecentAiFailures();
      expect(recentFailures).toHaveLength(1);
      expect(recentFailures[0]).toMatchObject({
        taskType: "capability_probe",
        normalizedErrorCode: "PROVIDER_RESULT_AMBIGUOUS",
      });
      expect(recentFailures[0]?.diagnosticId.startsWith("model_invocation:")).toBe(true);
    });
    await expect(runtime.modelHub.listCapabilityEvidence(prepared.catalogEntryId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "deepseek-ambiguous-prior-success-text",
          verdict: "supported",
        }),
      ]),
    );

    first.unmount();
    renderRoute(runtime, "/settings#model-routing");
    expect(
      await screen.findByRole("heading", { name: "当前模型能做什么" }, { timeout: 5_000 }),
    ).toBeVisible();
    const textGeneration = screen
      .getAllByText("文本生成")
      .map((label) => label.closest("li"))
      .find((item) => item !== null);
    expect(textGeneration).not.toBeNull();
    expect(within(textGeneration as HTMLElement).getByText(/结果待核对/u)).toBeVisible();
    expect(
      within(textGeneration as HTMLElement).getByText(
        /请求可能已经发出，暂时无法确认结果；系统不会自动重发/u,
      ),
    ).toBeVisible();
    expect(screen.getByText("最近结果待核对")).toBeVisible();
    expect(screen.queryByText("验证失败")).not.toBeInTheDocument();
    expect(screen.queryByText("最近一次验证未通过")).not.toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("never replaces an existing disabled custom route after a successful probe", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    let connection = await developmentRuntime.modelHub.saveConnection({
      id: "deepseek-existing-route",
      providerKind: "deepseek",
      displayName: "DeepSeek existing route",
      credentialRef: "keyring:model-hub:deepseek-existing-route",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await developmentRuntime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    const catalog = await developmentRuntime.modelHub.syncCatalog({
      syncId: "deepseek-existing-route-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        {
          id: "deepseek-existing-route-catalog",
          providerModelId: "deepseek-v4-pro",
          displayName: "deepseek-v4-pro",
        },
      ],
    });
    const existingPrivacy = await developmentRuntime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: catalog[0]?.id ?? "missing",
      dataDestination: "remote",
      retentionPolicy: "unknown",
      trainingPolicy: "not_used",
      evidenceSource: "user_confirmed",
      evidenceVersion: "user-policy-v1",
      evidenceSummary: "User-owned policy",
      expectedRevision: null,
    });
    const existingRoute = await developmentRuntime.modelHub.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: catalog[0]?.id ?? "missing",
      fallbackCatalogEntryId: null,
      privacyPolicy: "cloud_allowed",
      failurePolicy: "ask_user",
      routeOrigin: "user",
      enabled: false,
      expectedRevision: null,
    });
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
      modelGateway: {
        available: true,
        checkConnection: () => Promise.reject(new Error("not used")),
        listModels: () => Promise.reject(new Error("not used")),
        generate: () => Promise.resolve({ text: "OK", usage: null, streamed: false }),
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);
    expect(await screen.findByText("写作能力已验证")).toBeVisible();

    await expect(runtime.modelHub.findTaskRoute("prose_generation")).resolves.toEqual(
      existingRoute,
    );
    await expect(
      runtime.modelHub.findCostPrivacyProfile(catalog[0]?.id ?? "missing"),
    ).resolves.toEqual(existingPrivacy);
    const savedRoutes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(savedRoutes).toEqual([existingRoute]);
  });

  it("makes zero calls when the confirmed current form drifts from local to remote", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    let connection = await developmentRuntime.modelHub.saveConnection({
      id: "ollama-confirmed-local",
      providerKind: "ollama",
      displayName: "Ollama",
      baseUrlOverride: "http://127.0.0.1:11434",
      credentialRef: null,
      credentialState: "missing",
      authenticationMode: "none",
      enabled: true,
      expectedRevision: null,
    });
    connection = await developmentRuntime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    await developmentRuntime.modelHub.syncCatalog({
      syncId: "ollama-confirmed-local-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        {
          id: "ollama-confirmed-local-catalog",
          providerModelId: "qwen2.5:7b-instruct",
          displayName: "qwen2.5:7b-instruct",
        },
      ],
    });
    const originalSaveConnection = developmentRuntime.modelHub.saveConnection.bind(
      developmentRuntime.modelHub,
    );
    const saveEntered = deferred<undefined>();
    const releaseSave = deferred<undefined>();
    let holdConfirmedSave = false;
    vi.spyOn(developmentRuntime.modelHub, "saveConnection").mockImplementation(async (input) => {
      if (holdConfirmedSave && input.id === connection.id) {
        holdConfirmedSave = false;
        saveEntered.resolve(undefined);
        await releaseSave.promise;
      }
      return originalSaveConnection(input);
    });
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({
        text: "OK",
        usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
        streamed: false,
      }),
    );
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      credentials: {
        getSummary: () => Promise.resolve({ configured: false, lastFour: null }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
      modelGateway: {
        available: true,
        checkConnection: () => Promise.reject(new Error("not used")),
        listModels: () => Promise.reject(new Error("not used")),
        generate,
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const verifyButton = await screen.findByRole("button", {
      name: "确认 1 次固定验证",
    });
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "要检查的能力" }),
      "text_generation",
    );
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const baseUrlInput = screen.getByLabelText("基础地址");
    expect(baseUrlInput).toHaveValue("http://127.0.0.1:11434");
    await waitFor(() => expect(verifyButton).toBeEnabled());
    holdConfirmedSave = true;
    await user.click(verifyButton);
    await saveEntered.promise;

    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, "https://remote-after-confirmation.example/v1");
    expect(await screen.findByText(/请求会发送到所选远程供应商/u)).toBeVisible();
    releaseSave.resolve(undefined);

    expect(
      await screen.findByText(/本次没有发送请求.*重新查看固定验证说明并再次确认/u),
    ).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(["endpoint", "credential", "model"] as const)(
    "stops a manual model probe before dispatch when the authoritative %s changes after confirmation",
    async (mutationKind) => {
      const developmentRuntime = createDevelopmentRuntime(window.localStorage);
      await developmentRuntime.modelHub.saveConnection({
        id: "qwen-guarded",
        providerKind: "zhipu_glm",
        displayName: "智谱 GLM",
        region: "singapore",
        baseUrlOverride: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        credentialRef: "keyring:legacy-model-profile:qwen-guarded",
        credentialState: "present",
        expectedRevision: null,
      });
      const originalFindConnection = developmentRuntime.modelHub.findConnection.bind(
        developmentRuntime.modelHub,
      );
      const originalListCatalog = developmentRuntime.modelHub.listCatalog.bind(
        developmentRuntime.modelHub,
      );
      let mutationArmed = false;
      let mutationApplied = false;
      vi.spyOn(developmentRuntime.modelHub, "findConnection").mockImplementation(
        async (connectionId) => {
          const connection = await originalFindConnection(connectionId);
          const catalog = await originalListCatalog(connectionId);
          if (
            mutationArmed &&
            !mutationApplied &&
            connection !== null &&
            catalog.some(({ providerModelId }) => providerModelId === "qwen-guarded-model")
          ) {
            mutationApplied = true;
            if (mutationKind === "model") {
              await developmentRuntime.modelHub.syncCatalog({
                syncId: "concurrent-probe-model-sync",
                connectionId: connection.id,
                source: "manual",
                status: "succeeded",
                models: [
                  {
                    id: "unused-concurrent-catalog-id",
                    providerModelId: "qwen-guarded-model",
                    displayName: "concurrently-updated-model",
                  },
                ],
              });
            } else {
              await developmentRuntime.modelHub.saveConnection({
                id: connection.id,
                providerKind: connection.providerKind,
                displayName: connection.displayName,
                region: mutationKind === "endpoint" ? "us_virginia" : connection.region,
                workspaceId: connection.workspaceId,
                endpointId:
                  mutationKind === "endpoint" ? "rotated-endpoint" : connection.endpointId,
                baseUrlOverride:
                  mutationKind === "endpoint"
                    ? "https://dashscope-us.aliyuncs.com/compatible-mode/v1"
                    : connection.baseUrl,
                credentialRef:
                  mutationKind === "credential"
                    ? "keyring:model-hub:qwen-guarded-rotated"
                    : connection.credentialRef,
                credentialState: "present",
                authenticationMode: connection.authenticationMode,
                credentialHeaderName: connection.credentialHeaderName,
                modelDiscoveryPath: connection.modelDiscoveryPath,
                textGenerationPath: connection.textGenerationPath,
                embeddingPath: connection.embeddingPath,
                requestTimeoutMs: connection.requestTimeoutMs,
                retryLimit: connection.retryLimit,
                enabled: true,
                expectedRevision: connection.revision,
              });
            }
          }
          return connection;
        },
      );
      const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
        Promise.resolve({
          text: "OK",
          usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
        }),
      );
      const runtime: DesktopRuntime = {
        ...developmentRuntime,
        mode: "tauri",
        credentials: {
          getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
          save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
          delete: () => Promise.resolve({ configured: false, lastFour: null }),
        },
        modelGateway: {
          available: true,
          checkConnection: () => Promise.reject(new Error("manual provider uses the probe")),
          listModels: () => Promise.reject(new Error("manual provider must not call /models")),
          generate,
          embed: () => Promise.reject(new Error("not used")),
          cancelGeneration: () => Promise.resolve(false),
        },
      };
      const user = userEvent.setup();
      renderRoute(runtime);

      const modelInput = await screen.findByRole("textbox", { name: "模型标识" });
      await user.type(modelInput, "qwen-guarded-model");
      await user.selectOptions(
        screen.getByRole("combobox", { name: "要检查的能力" }),
        "text_generation",
      );
      const verifyButton = screen.getByRole("button", {
        name: "确认 1 次固定验证并检查连接",
      });
      await waitFor(() => expect(verifyButton).toBeEnabled());
      mutationArmed = true;
      await user.click(verifyButton);

      expect(
        await screen.findByText(/本次没有发送请求.*重新查看固定验证说明并再次确认/u),
      ).toBeVisible();
      expect(
        screen.queryByText(/MODEL_HUB_CONFIGURATION_CHANGED_BEFORE_DISPATCH/u),
      ).not.toBeInTheDocument();
      expect(mutationApplied).toBe(true);
      expect(generate).not.toHaveBeenCalled();
      const currentConnection = await originalFindConnection("qwen-guarded");
      expect(currentConnection?.connectionStatus).not.toBe("error");
      if (mutationKind === "endpoint") {
        expect(currentConnection).toMatchObject({
          enabled: true,
          region: "us_virginia",
          endpointId: "rotated-endpoint",
          baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
          credentialRef: "keyring:legacy-model-profile:qwen-guarded",
          credentialState: "present",
        });
      } else if (mutationKind === "credential") {
        expect(currentConnection).toMatchObject({
          enabled: true,
          credentialRef: "keyring:model-hub:qwen-guarded-rotated",
          credentialState: "present",
        });
      } else {
        const catalog = await originalListCatalog("qwen-guarded");
        expect(
          catalog.find(({ providerModelId }) => providerModelId === "qwen-guarded-model"),
        ).toMatchObject({
          availability: "available",
          displayName: "concurrently-updated-model",
          revision: 2,
        });
      }
    },
  );

  it.each(["retired", "catalog-ready"] as const)(
    "does not let a completed probe overwrite a %s target during its final atomic write",
    async (mutationKind) => {
      const developmentRuntime = createDevelopmentRuntime(window.localStorage);
      await developmentRuntime.modelHub.saveConnection({
        id: "qwen-final-write-guard",
        providerKind: "zhipu_glm",
        displayName: "GLM final write guard",
        region: "singapore",
        baseUrlOverride: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        credentialRef: "keyring:model-hub:qwen-final-write-guard",
        credentialState: "present",
        expectedRevision: null,
      });
      const originalCommit = developmentRuntime.modelHub.commitCapabilityProbeResult.bind(
        developmentRuntime.modelHub,
      );
      let mutationApplied = false;
      vi.spyOn(developmentRuntime.modelHub, "commitCapabilityProbeResult").mockImplementation(
        async (input) => {
          if (!mutationApplied) {
            mutationApplied = true;
            const current = await developmentRuntime.modelHub.findConnection(input.connectionId);
            if (current === null) throw new Error("Expected the current probe connection.");
            if (mutationKind === "retired") {
              await developmentRuntime.modelHub.retireConnection({
                connectionId: current.id,
                expectedRevision: current.revision,
              });
            } else {
              await developmentRuntime.modelHub.syncCatalog({
                syncId: "final-write-concurrent-sync",
                connectionId: current.id,
                source: "manual",
                status: "succeeded",
                models: [
                  {
                    id: "unused-final-write-catalog-id",
                    providerModelId: input.expectedProviderModelId,
                    displayName: "Concurrently refreshed model",
                  },
                ],
              });
              const refreshed = await developmentRuntime.modelHub.findConnection(current.id);
              if (refreshed === null) throw new Error("Expected the refreshed connection.");
              await developmentRuntime.modelHub.recordConnectionTest({
                connectionId: refreshed.id,
                status: "ready",
                expectedRevision: refreshed.revision,
              });
            }
          }
          return originalCommit(input);
        },
      );
      const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
        Promise.resolve({
          text: "OK",
          usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
        }),
      );
      const runtime: DesktopRuntime = {
        ...developmentRuntime,
        mode: "tauri",
        credentials: {
          getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
          save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
          delete: () => Promise.resolve({ configured: false, lastFour: null }),
        },
        modelGateway: {
          available: true,
          checkConnection: () => Promise.reject(new Error("manual provider uses the probe")),
          listModels: () => Promise.reject(new Error("manual provider must not call /models")),
          generate,
          embed: () => Promise.reject(new Error("not used")),
          cancelGeneration: () => Promise.resolve(false),
        },
      };
      const user = userEvent.setup();
      renderRoute(runtime);

      await screen.findByRole("heading", { name: "墨影模型中心" });
      const modelInput = await screen.findByRole("textbox", { name: "模型标识" });
      await user.type(modelInput, "qwen-final-write-model");
      await user.selectOptions(
        screen.getByRole("combobox", { name: "要检查的能力" }),
        "text_generation",
      );
      const verifyButton = screen.getByRole("button", {
        name: "确认 1 次固定验证并检查连接",
      });
      await waitFor(() => expect(verifyButton).toBeEnabled());
      await user.click(verifyButton);

      expect(await screen.findByText(/AI 服务暂未完成本次操作/u)).toBeVisible();
      expect(
        screen.queryByText(/MODEL_HUB_CONFIGURATION_CHANGED_BEFORE_DISPATCH/u),
      ).not.toBeInTheDocument();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(mutationApplied).toBe(true);
      const catalog = await developmentRuntime.modelHub.listCatalog("qwen-final-write-guard");
      const selected = catalog.find(
        ({ providerModelId }) => providerModelId === "qwen-final-write-model",
      );
      expect(selected).toBeDefined();
      await expect(
        developmentRuntime.modelHub.listCapabilityEvidence(selected?.id ?? "missing"),
      ).resolves.toEqual([]);
      const current = await developmentRuntime.modelHub.findConnection("qwen-final-write-guard");
      expect(current).toMatchObject(
        mutationKind === "retired"
          ? {
              enabled: false,
              connectionStatus: "disabled",
              lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
            }
          : {
              enabled: true,
              connectionStatus: "ready",
              lastErrorCode: null,
            },
      );
    },
  );
});

function renderRoute(runtime: DesktopRuntime, initialEntry = "/settings#model-center") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function renderRouteInStrictMode(runtime: DesktopRuntime, initialEntry = "/settings#model-center") {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[initialEntry]}>
        <RuntimeProvider runtime={runtime}>
          <ToastProvider>
            <DesktopRoutes />
          </ToastProvider>
        </RuntimeProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function pricing(pricingVersion: string) {
  return {
    contextWindowTokens: 32_000,
    currency: "USD",
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion,
    priceUpdatedAt: "2026-07-27T00:00:00.000Z",
  } as const;
}

async function createReadyDeepSeekProbeRuntime(connectionId: string): Promise<
  Readonly<{
    runtime: DesktopRuntime;
    catalogEntryId: string;
  }>
> {
  const developmentRuntime = createDevelopmentRuntime(window.localStorage);
  let connection = await developmentRuntime.modelHub.saveConnection({
    id: connectionId,
    providerKind: "deepseek",
    displayName: "DeepSeek",
    credentialRef: `keyring:model-hub:${connectionId}`,
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    enabled: true,
    expectedRevision: null,
  });
  connection = await developmentRuntime.modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  const catalog = await developmentRuntime.modelHub.syncCatalog({
    syncId: `${connectionId}-sync`,
    connectionId: connection.id,
    source: "provider_api",
    status: "succeeded",
    models: [
      {
        id: `${connectionId}-catalog`,
        providerModelId: "deepseek-v4-flash",
        displayName: "deepseek-v4-flash",
      },
    ],
  });
  const catalogEntry = catalog[0];
  if (catalogEntry === undefined) throw new Error("Expected the DeepSeek catalog entry.");
  const runtime: DesktopRuntime = {
    ...developmentRuntime,
    mode: "tauri",
    credentials: {
      getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
      save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
      delete: () => Promise.resolve({ configured: false, lastFour: null }),
    },
    modelGateway: {
      available: true,
      checkConnection: () => Promise.reject(new Error("not used")),
      listModels: () => Promise.reject(new Error("not used")),
      generate: () =>
        Promise.resolve({
          text: "OK",
          usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
          streamed: false,
        }),
      embed: () => Promise.reject(new Error("not used")),
      cancelGeneration: () => Promise.resolve(false),
    },
  };
  return Object.freeze({ runtime, catalogEntryId: catalogEntry.id });
}
