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
import { ModelHubStoreError } from "../infrastructure/model-hub-store";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

function parseStoryProjectId(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe("SettingsPage model routing", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses a page heading and level-two headings for primary setting sections", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderRoute(runtime, "/settings");

    expect(
      await screen.findByRole("heading", { name: "全局设置", level: 1 }, { timeout: 5_000 }),
    ).toBeVisible();
    for (const name of [
      "外观",
      "正文阅读与自动保存",
      "数据与隐私",
      "项目 AI 记忆",
      "同步安全",
      "本地数据维护",
      "安全更新",
      "脱敏诊断包",
    ]) {
      expect(await screen.findByRole("heading", { name, level: 2 })).toBeVisible();
    }
    expect(screen.queryByRole("heading", { name: "InkShadow Model Hub" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI 分工" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "模型基础评测" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "生成小说配图" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 Model Hub" })).toHaveAttribute(
      "href",
      "/settings#model-center",
    );
  });

  it("keeps an exact unconnected model choice pending until connection and explicit assignment", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-routing");

    await screen.findByRole("heading", { name: "AI 分工" }, { timeout: 5_000 });
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
    expect(screen.getByText(/deepseek-v4-flash.*原有 AI 分工不会改变/u)).toBeVisible();
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

    await screen.findByRole("heading", { name: "AI 分工" }, { timeout: 5_000 });
    expect(screen.queryByRole("searchbox", { name: "搜索模型、供应商或用途" })).toBeNull();
    await user.click(screen.getByText("浏览全部可选模型"));
    const search = screen.getByRole("searchbox", { name: "搜索模型、供应商或用途" });
    await user.type(search, "gpt-5.6-sol");
    await user.click(screen.getByRole("button", { name: /选择 GPT-5.6 Sol/u }));

    expect(await screen.findByRole("heading", { name: "Model Hub · 连接与模型" })).toBeVisible();
    expect(screen.getByText(/准备连接 GPT-5.6 Sol.*不会参与 AI 分工/u)).toBeVisible();
    expect(screen.queryByText(/更改已保存.*需要刷新/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新 Model Hub 状态" })).not.toBeInTheDocument();
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

    await screen.findByRole("heading", { name: "AI 分工" }, { timeout: 5_000 });
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
      await screen.findByRole("heading", { name: "InkShadow Model Hub" }, { timeout: 5_000 }),
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
    const verify = screen.getByRole("button", { name: "验证写作能力" });
    await waitFor(() => expect(verify).toBeEnabled());
    await user.click(verify);

    expect(
      await screen.findByRole("heading", { name: "AI 分工" }, { timeout: 5_000 }),
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

    const probedModelRow = probedModelLabel.closest("li");
    if (probedModelRow === null) throw new Error("Expected the probed model row.");
    await user.click(within(probedModelRow).getByRole("button", { name: "用于此任务" }));

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

    renderRoute(prepared.runtime, "/settings#model-center");

    expect(
      await screen.findByRole("heading", { name: "AI 分工" }, { timeout: 5_000 }),
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
    expect(within(modelDisclosure).getByRole("button", { name: "验证并用于此任务" })).toBeVisible();
    await expect(prepared.runtime.modelHub.findTaskRoute("translation")).resolves.toBeNull();
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).not.toBeNull();
    expect(generate).not.toHaveBeenCalled();
  }, 10_000);

  it("lets the user choose and persist an appearance without exposing technical settings", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings");

    const appearance = await screen.findByRole("combobox", { name: /^外观模式/u });
    expect(appearance).toHaveValue("system");
    expect(document.documentElement).not.toHaveAttribute("data-surface");
    expect(screen.getByText(/正在跟随系统，当前为(?:浅色|深色)/u)).toBeVisible();

    await user.selectOptions(appearance, "light");
    expect(document.documentElement).toHaveAttribute("data-surface", "light");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("light");
    expect(screen.getByText("当前固定为浅色。")).toBeVisible();

    await user.selectOptions(appearance, "dark");
    expect(document.documentElement).toHaveAttribute("data-surface", "dark");
    expect(window.localStorage.getItem(APPEARANCE_PREFERENCE_STORAGE_KEY)).toBe("dark");
    expect(screen.getByText("当前固定为深色。")).toBeVisible();

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
    ["model-center", "Model Hub · 连接与模型", "连接与模型", "InkShadow Model Hub"],
    ["model-routing", "Model Hub · AI 分工", "AI 分工", "AI 分工"],
    ["model-evaluation", "Model Hub · 模型评测", "模型评测", "模型基础评测"],
    ["image-generation", "Model Hub · 图片生成", "图片生成", "生成小说配图"],
  ] as const)(
    "separates the %s Model Hub view from global settings",
    async (sectionId, pageTitle, navigationLabel, activeSectionHeading) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      renderRoute(runtime, `/settings#${sectionId}`);

      expect(await screen.findByRole("heading", { name: pageTitle, level: 1 })).toBeVisible();
      expect(screen.getByRole("navigation", { name: "Model Hub 分区" })).toBeVisible();
      expect(screen.getByRole("link", { name: navigationLabel })).toHaveAttribute(
        "aria-current",
        "page",
      );
      for (const sectionHeading of [
        "InkShadow Model Hub",
        "AI 分工",
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

    expect(await screen.findByRole("heading", { name: "Model Hub · 模型评测" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "写作方法 A/B 评测（专家）" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "内置小说 Skill 付费 A/B 评测" }),
    ).not.toBeInTheDocument();
    expect(initializePaidEvaluation).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const expand = screen.getByRole("button", { name: "写作方法 A/B 评测（专家）" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("heading", { name: "内置小说 Skill 付费 A/B 评测" }),
    ).not.toBeInTheDocument();
    expect(initializePaidEvaluation).not.toHaveBeenCalled();

    await user.click(expand);
    expect(
      await screen.findByRole("heading", { name: "内置小说 Skill 付费 A/B 评测" }),
    ).toBeVisible();
    expect(initializePaidEvaluation).toHaveBeenCalledTimes(1);
    expect(screen.getByText("当前不能进行付费评测")).toBeVisible();
    expect(generate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "收起专家设置" }));
    expect(
      screen.queryByRole("heading", { name: "内置小说 Skill 付费 A/B 评测" }),
    ).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps technical connection fields hidden until expert settings are opened", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-center");

    expect(await screen.findByRole("heading", { name: "InkShadow Model Hub" })).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "需要 AI 时，再连接一个模型服务" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("基础地址")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("认证方式")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^上下文窗口（token）/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Google Gemini" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "专家设置" }));

    expect(screen.getByRole("option", { name: "Google Gemini" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Anthropic Claude" })).toBeInTheDocument();
    expect(screen.getByLabelText("基础地址")).toBeVisible();
    expect(screen.getByLabelText("认证方式")).toBeVisible();
    expect(screen.getByLabelText(/^上下文窗口（token）/u)).toBeInTheDocument();
    expect(screen.getByText("重试不会重复计费请求")).toBeVisible();
    expect(screen.queryByText("专家兼容设置：旧 7 角色路由")).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "AI 分工" }));
    expect(screen.getByText("专家兼容设置：旧 7 角色路由")).toBeVisible();
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
      "基础配置完整",
      "部分能力不可用",
      "连接失败",
      "额度不足",
    ]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
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
    expect(screen.getByRole("combobox", { name: /^已连接的供应商/u })).toHaveValue(
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
    expect(screen.getByText(/MODEL_DIRECTORY_UNAVAILABLE/u)).toBeVisible();

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
    const verify = screen.getByRole("button", { name: "验证写作能力" });
    await waitFor(() => expect(verify).toBeEnabled());
    await user.click(verify);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    const provider = screen.getByRole("combobox", { name: "供应商" });
    const storedConnection = screen.getByRole("combobox", { name: /^已连接的供应商/u });
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" }, { timeout: 5_000 });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled());
    fireEvent.change(providerSelect, { target: { value: "custom_openai_compatible" } });
    expect(providerSelect).toHaveValue("custom_openai_compatible");
    expect(screen.getByRole("button", { name: "收起专家设置" })).toBeVisible();
    expect(screen.getByLabelText(/^模型目录路径/u)).toBeVisible();
    act(() => {
      fireEvent.change(screen.getByLabelText("Base URL"), {
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
    const embeddingPath = screen.getByLabelText(/^Embedding 路径/u);
    const credentialHeaderName = screen.getByLabelText("认证 Header 名称");
    const requestTimeout = screen.getByLabelText("请求超时（毫秒）");
    const retryLimit = screen.getByLabelText("安全重试次数");
    const credentialHeaderValue = screen.getByLabelText("认证 Header 值");
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
    await screen.findByRole("option", { name: "Writer model" });
    await user.click(screen.getByRole("button", { name: "验证写作能力" }));
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
    await screen.findByRole("heading", { name: "InkShadow Model Hub" }, { timeout: 5_000 });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    await waitFor(() => {
      expect(screen.getByLabelText("配置标识")).toHaveValue("custom-safe");
      expect(screen.getByRole("combobox", { name: "认证方式" })).toHaveValue(
        "custom_header_keyring",
      );
      expect(screen.getByLabelText("认证 Header 名称")).toHaveValue("x-api-key");
      expect(screen.getByLabelText(/^模型目录路径/u)).toHaveValue("/catalog/models");
      expect(screen.getByLabelText(/^文本生成路径/u)).toHaveValue("/text/chat");
      expect(screen.getByLabelText(/^Embedding 路径/u)).toHaveValue("/vectors/embed");
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
    expect(within(dialog).getByText(/永久停止这条连接参与选择、推荐和 AI 分工/u)).toBeVisible();
    expect(within(dialog).getByText("退役不同于删除凭据或暂时停用")).toBeVisible();
    expect(
      within(dialog).getByText(/正文、AI 建议版本、模型调用记录和费用凭据不会删除/u),
    ).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "确认退役连接" }));
    expect(await screen.findByText(/已退役：不会再参与选择、推荐或 AI 分工/u)).toBeVisible();
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

  it("refreshes the authoritative revision after partial retirement cleanup and retries safely", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const connection = await development.modelHub.saveConnection({
      id: "ui-retirement-cleanup-retry",
      providerKind: "custom_openai_compatible",
      displayName: "可重试退役连接",
      baseUrlOverride: "https://retire-retry.example/v1",
      credentialRef: "keyring:model-hub:ui-retirement-cleanup-retry",
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
    const deleteCredential = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary vault failure"))
      .mockResolvedValue({ configured: false, lastFour: null });
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

    await user.click(await screen.findByRole("button", { name: "退役连接" }));
    let dialog = screen.getByRole("dialog", { name: "退役“可重试退役连接”连接？" });
    await user.click(within(dialog).getByRole("button", { name: "确认退役连接" }));
    await waitFor(() => expect(deleteCredential).toHaveBeenCalledTimes(1));
    await expect(runtime.modelHub.findConnection(connection.id)).resolves.toMatchObject({
      enabled: false,
      revision: connection.revision + 1,
      credentialRef: "keyring:model-hub:ui-retirement-cleanup-retry",
      lastErrorCode: null,
    });

    dialog = screen.getByRole("dialog", { name: "退役“可重试退役连接”连接？" });
    const retry = within(dialog).getByRole("button", { name: "确认退役连接" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    expect(await screen.findByText(/可重试退役连接.*已退役/u)).toBeVisible();
    expect(deleteCredential).toHaveBeenCalledTimes(2);
    await expect(runtime.modelHub.findConnection(connection.id)).resolves.toMatchObject({
      enabled: false,
      credentialRef: null,
      credentialState: "missing",
      lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
      revision: connection.revision + 2,
    });
  }, 10_000);

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

    expect(await screen.findByRole("button", { name: "删除密钥" })).toBeVisible();
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
    const keyInput = screen.getByLabelText("API Key（接口访问密钥）");
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" });
    await user.click(await screen.findByRole("button", { name: "连接 AI 服务" }));
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled());
    await user.selectOptions(providerSelect, "custom_openai_compatible");
    fireEvent.change(screen.getByLabelText("Base URL"), {
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
    fireEvent.change(screen.getByLabelText("认证 Header 名称"), {
      target: { value: "Host" },
    });
    fireEvent.change(screen.getByLabelText("认证 Header 值"), {
      target: { value: "super-secret-header-value" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));
    expect(await screen.findByText(/MODEL_PROVIDER_CREDENTIAL_HEADER_FORBIDDEN/u)).toBeVisible();
    expect(saveCredential).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("认证 Header 名称"), {
      target: { value: "x-api-key" },
    });
    fireEvent.change(await screen.findByLabelText(/^模型目录路径/u), {
      target: { value: "//attacker.example/models" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));
    expect(await screen.findByText(/MODEL_PROVIDER_API_PATH_INVALID/u)).toBeVisible();
    expect(saveCredential).not.toHaveBeenCalled();
  }, 15_000);

  it("rejects a cross-provider connection id before writing a credential", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    await development.modelHub.saveConnection({
      id: "shared-provider-id",
      providerKind: "openai",
      displayName: "Existing OpenAI",
      credentialState: "missing",
      authenticationMode: "bearer_keyring",
      enabled: false,
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" });
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled());
    await user.selectOptions(providerSelect, "custom_openai_compatible");
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://custom-models.example/v1" },
    });
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    fireEvent.change(providerId, { target: { value: "shared-provider-id" } });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "认证方式" }),
      "custom_header_keyring",
    );
    fireEvent.change(await screen.findByLabelText("认证 Header 名称"), {
      target: { value: "x-api-key" },
    });
    fireEvent.change(screen.getByLabelText("认证 Header 值"), {
      target: { value: "never-written-secret" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));

    expect(
      await screen.findByText(/MODEL_HUB_PROVIDER_KIND_IMMUTABLE/u, undefined, {
        timeout: 5_000,
      }),
    ).toBeVisible();
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" }, { timeout: 5_000 });
    const providerSelect = screen.getByRole("combobox", { name: "供应商" });
    await waitFor(() => expect(providerSelect).toBeEnabled());
    await user.selectOptions(
      screen.getByRole("combobox", { name: /^已连接的供应商/u }),
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" });
    const storedConnections = await screen.findByRole("combobox", {
      name: /^已连接的供应商/u,
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
    fireEvent.change(screen.getByLabelText("认证 Header 值"), {
      target: { value: "never-overwrite-target" },
    });
    await user.click(screen.getByRole("button", { name: "保存到系统凭据库" }));

    expect(await screen.findByText(/MODEL_HUB_CONNECTION_ID_CONFLICT/u)).toBeVisible();
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" }, { timeout: 5_000 });
    const storedConnections = await screen.findByRole("combobox", {
      name: /^已连接的供应商/u,
    });
    await waitFor(() => expect(storedConnections).toBeEnabled());
    await user.selectOptions(storedConnections, "same-metadata-owner");
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    const providerId = screen.getByLabelText("配置标识");
    fireEvent.change(providerId, { target: { value: "same-metadata-target" } });
    await user.click(screen.getByRole("button", { name: "保存供应商与模型" }));

    expect(await screen.findByText(/MODEL_HUB_CONNECTION_ID_CONFLICT/u)).toBeVisible();
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" }, { timeout: 5_000 });
    const storedConnections = await screen.findByRole(
      "combobox",
      { name: /^已连接的供应商/u },
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

    await screen.findByRole("heading", { name: "InkShadow Model Hub" }, { timeout: 5_000 });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /^已连接的供应商/u })).toBeEnabled(),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /^已连接的供应商/u }),
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
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: "smooth",
          block: "start",
        });
        expect(target).toHaveFocus();
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

    const heading = await screen.findByRole("heading", { name: "AI 分工" });
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
    await user.click(within(routingCard).getByRole("button", { name: "保存角色路由" }));

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

  it("verifies a manual Qwen model with the shared 64-token probe without calling /models", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    await developmentRuntime.modelHub.saveConnection({
      id: "qwen-writing",
      providerKind: "alibaba_qwen",
      displayName: "阿里云百炼 / Qwen",
      region: "singapore",
      baseUrlOverride: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      credentialRef: "keyring:legacy-model-profile:qwen-writing",
      credentialState: "present",
      expectedRevision: null,
    });
    const listModels = vi.fn<NativeModelGatewayClient["listModels"]>(() =>
      Promise.reject(new Error("manual provider must not call /models")),
    );
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((input) => {
      input.onDelta?.("OK");
      return Promise.resolve({
        text: "OK",
        usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: null },
        streamed: true,
      });
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
        checkConnection: () => Promise.reject(new Error("manual provider uses the probe")),
        listModels,
        generate,
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      },
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const modelInput = await screen.findByRole("textbox", { name: "模型标识" });
    await user.type(modelInput, "qwen-writing-model");
    const verifyButton = screen.getByRole("button", { name: "验证连接与写作能力" });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    expect(listModels).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    const generatedInput = generate.mock.calls[0]?.[0];
    expect(generatedInput).toMatchObject({
      config: {
        providerId: "qwen-writing",
        provider: "open_ai_compatible",
      },
      model: "qwen-writing-model",
      maxOutputTokens: 64,
    });
    expect(generatedInput).not.toHaveProperty("temperature");
    const catalog = await runtime.modelHub.listCatalog("qwen-writing");
    const selected = catalog.find(
      ({ providerModelId }) => providerModelId === "qwen-writing-model",
    );
    expect(selected).toBeDefined();
    await expect(
      runtime.modelHub.listCapabilityEvidence(selected?.id ?? "missing"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        }),
        expect.objectContaining({
          capability: "streaming",
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
  });

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

    const verifyButton = await screen.findByRole("button", { name: "验证写作能力" });
    expect(await screen.findByText(/最多请求 64 个输出 token/u)).toBeVisible();
    expect(screen.queryByText(/最多请求 8 个输出 token/u)).not.toBeInTheDocument();
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
    expect(enabledRoutes).toHaveLength(16);
    expect(
      enabledRoutes.every(({ primaryCatalogEntryId }) => primaryCatalogEntryId === catalog[0]?.id),
    ).toBe(true);
    await expect(runtime.modelHub.findTaskRoute("embedding")).resolves.toBeNull();
    await expect(runtime.modelHub.findTaskRoute("image_generation")).resolves.toBeNull();
  });

  it("repairs the exact legacy 15-route automatic smart prefix without revising matching routes", async () => {
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
    expect(seeded.savedNovelTaskCount).toBe(16);
    const missingRoute = await prepared.runtime.modelHub.findTaskRoute("content_quality_check");
    const unchangedRoute = await prepared.runtime.modelHub.findTaskRoute("idea_discussion");
    if (missingRoute === null || unchangedRoute === null) {
      throw new Error("Expected the seeded text routes.");
    }
    await prepared.runtime.modelHub.deleteTaskRoute(missingRoute.task, missingRoute.revision);
    const interruptedRoutes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(interruptedRoutes).toHaveLength(15);

    const user = userEvent.setup();
    renderRoute(prepared.runtime);
    const verifyButton = await screen.findByRole("button", { name: "验证写作能力" });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "AI 分工" }));
    expect(await screen.findByText("16 / 22 类已配置 · 6 类缺能力")).toBeVisible();
    const recovered = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).flatMap((route) => (route?.enabled === true ? [route] : []));
    expect(recovered).toHaveLength(16);
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

    const verifyButton = await screen.findByRole("button", { name: "验证写作能力" });
    await waitFor(() => expect(verifyButton).toBeEnabled());
    await user.click(verifyButton);

    expect(await screen.findByText("写作能力已验证")).toBeVisible();
    expect(screen.getByText(/写作能力证据已保留；自动分工未完成/u)).toBeVisible();
    expect(screen.getByText("AI 分工没有保存")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "AI 分工" }));
    expect(screen.getByText("配置写入失败")).toBeVisible();
    expect(screen.getAllByText("AI 分工没有保存").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Model Hub 的 22 项分工没有被修改，本次任务路由事务已回滚/u),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "重试保存" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导出脱敏诊断" })).toBeVisible();
    expect(screen.queryByText(/INSERT INTO|UPDATE novel_task_routes/u)).not.toBeInTheDocument();
    expect(screen.getByText(/MODEL_HUB_ROUTING_PLAN_WRITE_FAILED/u)).toBeVisible();
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
    await user.click(screen.getByRole("button", { name: "应用 AI 分工" }));

    expect(
      await screen.findByText(/Model Hub 的 22 项分工未修改.*旧版兼容分工可能已被安全停用/u),
    ).toBeVisible();
    expect(screen.queryByText(/之前的 AI 分工没有被修改，事务已回滚/u)).not.toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "AI 分工" });
    vi.spyOn(prepared.runtime.modelRouting, "listRoutes").mockRejectedValue(
      new Error("injected legacy projection failure"),
    );

    await user.click(screen.getByRole("button", { name: "应用 AI 分工" }));

    expect(await screen.findByText("16 / 22 类已配置 · 6 类缺能力")).toBeVisible();
    expect(await screen.findByText("AI 连接或分工需要修复")).toBeVisible();
    expect(screen.queryByText("AI 基础配置已可用")).not.toBeInTheDocument();
    expect(screen.getAllByText(/基础配置检查未通过.*数据去向与隐私信息尚未确认/u)).toHaveLength(10);
    expect(screen.getByRole("heading", { name: "当前模型能做什么" })).toBeVisible();
    expect(screen.getByText(/由用户确认，尚未实测 · 用户确认/u)).toBeVisible();
    await user.click(screen.getByText("查看已配置的 16 项"));
    expect(screen.getAllByText("正文生成").length).toBeGreaterThan(0);
    await user.click(screen.getByText("查看尚未配置的 6 项"));
    expect(screen.getAllByText("语义记忆").length).toBeGreaterThan(0);
    expect(screen.getAllByText("其他基础配置不受影响").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "完善全部功能还需要" })).toBeVisible();
    expect(await screen.findByText(/旧版兼容分工暂未同步/u)).toBeVisible();
    expect(screen.getByText("AI 分工部分配置完成")).toBeVisible();
    expect(screen.queryByText(/MODEL_HUB_LEGACY_SYNC_FAILED/u)).not.toBeInTheDocument();
    const routes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => prepared.runtime.modelHub.findTaskRoute(task)))
    ).flatMap((route) => (route?.enabled === true ? [route] : []));
    expect(routes).toHaveLength(16);
  });

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

    const verifyButton = await screen.findByRole("button", { name: "验证写作能力" });
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

  it.each(["connection", "catalog"] as const)(
    "stops a manual model probe before dispatch when the authoritative %s changes",
    async (mutationKind) => {
      const developmentRuntime = createDevelopmentRuntime(window.localStorage);
      await developmentRuntime.modelHub.saveConnection({
        id: "qwen-guarded",
        providerKind: "alibaba_qwen",
        displayName: "阿里云百炼 / Qwen",
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
            if (mutationKind === "connection") {
              await developmentRuntime.modelHub.saveConnection({
                id: connection.id,
                providerKind: connection.providerKind,
                displayName: connection.displayName,
                region: "us_virginia",
                workspaceId: null,
                endpointId: "rotated-endpoint",
                baseUrlOverride: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
                credentialRef: "keyring:model-hub:qwen-guarded-rotated",
                credentialState: "present",
                authenticationMode: connection.authenticationMode,
                requestTimeoutMs: connection.requestTimeoutMs,
                retryLimit: connection.retryLimit,
                enabled: true,
                expectedRevision: connection.revision,
              });
            } else {
              await developmentRuntime.modelHub.syncCatalog({
                syncId: "concurrent-probe-catalog-sync",
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
      const verifyButton = screen.getByRole("button", { name: "验证连接与写作能力" });
      await waitFor(() => expect(verifyButton).toBeEnabled());
      mutationArmed = true;
      await user.click(verifyButton);

      expect(
        await screen.findByText(/MODEL_HUB_CONFIGURATION_CHANGED_BEFORE_DISPATCH/u),
      ).toBeVisible();
      expect(mutationApplied).toBe(true);
      expect(generate).not.toHaveBeenCalled();
      const currentConnection = await originalFindConnection("qwen-guarded");
      expect(currentConnection?.connectionStatus).not.toBe("error");
      if (mutationKind === "connection") {
        expect(currentConnection).toMatchObject({
          enabled: true,
          region: "us_virginia",
          endpointId: "rotated-endpoint",
          baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
          credentialRef: "keyring:model-hub:qwen-guarded-rotated",
          credentialState: "present",
        });
      } else {
        const catalog = await originalListCatalog("qwen-guarded");
        expect(
          catalog.find(({ providerModelId }) => providerModelId === "qwen-guarded-model"),
        ).toMatchObject({ revision: 2, displayName: "concurrently-updated-model" });
      }
    },
  );

  it.each(["retired", "catalog-ready"] as const)(
    "does not let a completed probe overwrite a %s target during its final atomic write",
    async (mutationKind) => {
      const developmentRuntime = createDevelopmentRuntime(window.localStorage);
      await developmentRuntime.modelHub.saveConnection({
        id: "qwen-final-write-guard",
        providerKind: "alibaba_qwen",
        displayName: "Qwen final write guard",
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

      await screen.findByRole("heading", { name: "InkShadow Model Hub" });
      const modelInput = await screen.findByRole("textbox", { name: "模型标识" });
      await user.type(modelInput, "qwen-final-write-model");
      const verifyButton = screen.getByRole("button", { name: "验证连接与写作能力" });
      await waitFor(() => expect(verifyButton).toBeEnabled());
      await user.click(verifyButton);

      expect(
        await screen.findByText(/MODEL_HUB_CONFIGURATION_CHANGED_BEFORE_DISPATCH/u),
      ).toBeVisible();
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
