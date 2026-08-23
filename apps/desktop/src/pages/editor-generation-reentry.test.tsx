import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chapter, Project } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { AppErrorBoundary } from "../components/app-error-boundary";
import { ComponentOwnershipBoundary } from "../components/component-ownership-path";
import { DesktopPersistenceBoundary } from "../components/desktop-persistence-boundary";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("editor generation reentry", () => {
  it("keeps one continuation disclosure open when the generate action is clicked twice", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({
        text: "\n林晚沿着旧站台继续前行。",
        usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
      }),
    );
    Object.assign(runtime, {
      mode: "tauri" as const,
      modelGateway: {
        available: true,
        listModels: () =>
          Promise.resolve({
            provider: "open_ai_compatible" as const,
            models: [{ id: "direct-writer", displayName: "Direct writer" }],
          }),
        checkConnection: () => Promise.reject(new Error("not used")),
        embed: () => Promise.reject(new Error("not used")),
        generate,
        cancelGeneration: () => Promise.resolve(true),
      } satisfies NativeModelGatewayClient,
    });
    const { chapter, project } = await seedChapter(runtime);
    const recoverExpiredTasks = vi.spyOn(runtime.taskCenter, "recoverExpiredTasks");
    renderEditor(runtime, project, chapter);
    const generateButton = await screen.findByRole("button", { name: "生成续写建议" });
    recoverExpiredTasks.mockClear();

    fireEvent.click(generateButton);
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    fireEvent.click(generateButton);

    expect(preflight).toBeVisible();
    expect(screen.getAllByRole("dialog", { name: "生成前检查" })).toHaveLength(1);
    expect(recoverExpiredTasks).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();

    fireEvent.click(within(preflight).getByRole("button", { name: "暂不生成" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "生成前检查" })).not.toBeInTheDocument(),
    );
    const availableGenerateButton = screen.getByRole("button", { name: "生成续写建议" });
    expect(availableGenerateButton).toBeEnabled();
    fireEvent.click(availableGenerateButton);
    const reopenedPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    expect(recoverExpiredTasks).toHaveBeenCalledTimes(2);

    const confirm = within(reopenedPreflight).getByRole("button", {
      name: /确认并开始|使用安全默认值并开始/u,
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });

  it("does not dispatch a confirmed generation when closing wins while disclosure is rechecked", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({
        text: "\n林晚沿着旧站台继续前行。",
        usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
      }),
    );
    Object.assign(runtime, {
      mode: "tauri" as const,
      modelGateway: {
        available: true,
        listModels: () =>
          Promise.resolve({
            provider: "open_ai_compatible" as const,
            models: [{ id: "direct-writer", displayName: "Direct writer" }],
          }),
        checkConnection: () => Promise.reject(new Error("not used")),
        embed: () => Promise.reject(new Error("not used")),
        generate,
        cancelGeneration: () => Promise.resolve(true),
      } satisfies NativeModelGatewayClient,
    });
    const { chapter, project } = await seedChapter(runtime);
    renderEditor(runtime, project, chapter);
    fireEvent.click(await screen.findByRole("button", { name: "生成续写建议" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });

    const originalFindTaskRoute = runtime.modelHub.findTaskRoute.bind(runtime.modelHub);
    let releaseDisclosure!: () => void;
    const disclosureGate = new Promise<void>((resolve) => {
      releaseDisclosure = resolve;
    });
    let disclosureStarted!: () => void;
    const disclosureStart = new Promise<void>((resolve) => {
      disclosureStarted = resolve;
    });
    const routeLookup = vi
      .spyOn(runtime.modelHub, "findTaskRoute")
      .mockImplementationOnce(async (task) => {
        disclosureStarted();
        await disclosureGate;
        return originalFindTaskRoute(task);
      });

    const confirm = within(preflight).getByRole("button", {
      name: /确认并开始|使用安全默认值并开始/u,
    });
    const cancel = within(preflight).getByRole("button", { name: "暂不生成" });
    act(() => {
      confirm.click();
      cancel.click();
    });
    await disclosureStart;
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "生成前检查" })).not.toBeInTheDocument(),
    );

    const availableGenerateButton = screen.getByRole("button", {
      name: "生成续写建议",
    });
    fireEvent.click(availableGenerateButton);
    const reopened = await screen.findByRole("dialog", { name: "生成前检查" });
    let releaseSecondDisclosure!: () => void;
    const secondDisclosureGate = new Promise<void>((resolve) => {
      releaseSecondDisclosure = resolve;
    });
    let secondDisclosureStarted!: () => void;
    const secondDisclosureStart = new Promise<void>((resolve) => {
      secondDisclosureStarted = resolve;
    });
    routeLookup.mockImplementationOnce(async (task) => {
      secondDisclosureStarted();
      await secondDisclosureGate;
      return originalFindTaskRoute(task);
    });
    const secondConfirm = within(reopened).getByRole("button", {
      name: /确认并开始|使用安全默认值并开始/u,
    });
    expect(secondConfirm).toBeEnabled();
    fireEvent.click(secondConfirm);
    await secondDisclosureStart;
    const secondCancel = within(reopened).getByRole("button", { name: "暂不生成" });
    expect(secondCancel).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(reopened).toBeVisible();

    await act(async () => {
      releaseDisclosure();
      await disclosureGate;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    });
    expect(generate).not.toHaveBeenCalled();
    expect(reopened).toBeVisible();
    expect(secondCancel).toBeDisabled();

    await act(async () => {
      releaseSecondDisclosure();
      await secondDisclosureGate;
    });
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });

  it("does not record a cancellation while an offline deferred request is being saved", async () => {
    const onlineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    try {
      window.localStorage.clear();
      const runtime = createDevelopmentRuntime(window.localStorage);
      const preference = await runtime.writingExperience.getOrInitialize();
      await runtime.writingExperience.switchMode("professional", preference.revision);
      await seedRemoteContinuationRoute(runtime);
      const generate = vi.fn<NativeModelGatewayClient["generate"]>();
      Object.assign(runtime, {
        mode: "tauri" as const,
        modelGateway: {
          available: true,
          listModels: () =>
            Promise.resolve({
              provider: "open_ai_compatible" as const,
              models: [{ id: "direct-writer", displayName: "Direct writer" }],
            }),
          checkConnection: () => Promise.reject(new Error("not used")),
          embed: () => Promise.reject(new Error("not used")),
          generate,
          cancelGeneration: () => Promise.resolve(true),
        } satisfies NativeModelGatewayClient,
      });
      const { chapter, project } = await seedChapter(runtime);
      renderEditor(runtime, project, chapter);
      fireEvent.click(await screen.findByRole("button", { name: "生成续写建议" }));
      const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
      const saveDeferred = within(preflight).getByRole("button", { name: "保存待执行" });
      const cancel = within(preflight).getByRole("button", { name: "先自己写" });

      const originalCreateDeferred = runtime.generationGovernance.createDeferredRequest.bind(
        runtime.generationGovernance,
      );
      let releaseDeferredSave!: () => void;
      const deferredSaveGate = new Promise<void>((resolve) => {
        releaseDeferredSave = resolve;
      });
      let deferredSaveStarted!: () => void;
      const deferredSaveStart = new Promise<void>((resolve) => {
        deferredSaveStarted = resolve;
      });
      let savedDeferred: Awaited<ReturnType<typeof originalCreateDeferred>>["request"] | null =
        null;
      vi.spyOn(runtime.generationGovernance, "createDeferredRequest").mockImplementationOnce(
        async (input) => {
          deferredSaveStarted();
          await deferredSaveGate;
          const created = await originalCreateDeferred(input);
          savedDeferred = created.request;
          return created;
        },
      );

      act(() => {
        saveDeferred.click();
        cancel.click();
      });
      await deferredSaveStart;
      expect(preflight).toBeVisible();
      await waitFor(() => {
        expect(saveDeferred).toBeDisabled();
        expect(cancel).toBeDisabled();
      });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(preflight).toBeVisible();
      expect(document.body).not.toHaveTextContent("已取消，本次没有调用 AI");

      await act(async () => {
        releaseDeferredSave();
        await deferredSaveGate;
      });
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "生成前检查" })).not.toBeInTheDocument(),
      );
      expect(generate).not.toHaveBeenCalled();
      expect(savedDeferred).toMatchObject({ status: "waiting_network" });
      expect(document.body).not.toHaveTextContent("已取消，本次没有调用 AI");
    } finally {
      if (onlineDescriptor === undefined) {
        Reflect.deleteProperty(window.navigator, "onLine");
      } else {
        Object.defineProperty(window.navigator, "onLine", onlineDescriptor);
      }
    }
  });
});

function renderEditor(runtime: DesktopRuntime, project: Project, chapter: Chapter): void {
  const pathname = `/projects/${project.id}/chapters/${chapter.id}`;
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <ComponentOwnershipBoundary name="EditorGenerationReentryTestHost">
            <AppErrorBoundary>
              <DesktopPersistenceBoundary>
                <DesktopRoutes />
              </DesktopPersistenceBoundary>
            </AppErrorBoundary>
          </ComponentOwnershipBoundary>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

async function seedChapter(
  runtime: DesktopRuntime,
): Promise<{ readonly project: Project; readonly chapter: Chapter }> {
  const project = await runtime.useCases.createProject.execute({ name: "生成重入测试项目" });
  if (!project.ok) throw project.error;
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "稳定正文",
  });
  if (!chapter.ok) throw chapter.error;
  return { project: project.value, chapter: chapter.value.chapter };
}

async function seedRemoteContinuationRoute(runtime: DesktopRuntime): Promise<void> {
  const connection = await runtime.modelHub.saveConnection({
    id: "continuation-reentry-remote",
    providerKind: "custom_openai_compatible",
    displayName: "续写重入测试连接",
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
    syncId: "continuation-reentry-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "continuation-reentry-catalog",
        providerModelId: "direct-writer",
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2027-08-24T00:00:00.000Z",
      },
    ],
  });
  await runtime.modelHub.recordCapabilityScan({
    scanId: "continuation-reentry-scan",
    catalogEntryId: "continuation-reentry-catalog",
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "continuation-reentry-v1",
    evidence: [
      {
        id: "continuation-reentry-text-evidence",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await runtime.modelHub.saveCostPrivacyProfile({
    catalogEntryId: "continuation-reentry-catalog",
    currency: "USD",
    inputMicrosPerMillionTokens: "1000000",
    outputMicrosPerMillionTokens: "2000000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "continuation-reentry-v1",
    priceUpdatedAt: "2026-08-24T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "continuation-reentry-v1",
    expectedRevision: null,
  });
  await runtime.modelHub.saveTaskRoute({
    task: "continuation",
    primaryCatalogEntryId: "continuation-reentry-catalog",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}
