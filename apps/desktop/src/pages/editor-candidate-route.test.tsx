import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import {
  AiCandidate,
  AppError,
  ChapterVersion,
  err,
  ok,
  parseContentChecksum,
  parseUuidV7,
  type AiCandidatePurpose,
  type AiCandidateApplicationIntent,
  type AiCandidateSource,
  type Chapter,
  type Project,
} from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";
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
import {
  EDITOR_PREFERENCES_STORAGE_KEY,
  saveEditorPreferences,
} from "../infrastructure/editor-preferences-store";
import { editorCandidateStatusLabel } from "../infrastructure/editor-candidate-status";
import { readSafeOperationIncidents } from "../infrastructure/safe-operation-diagnostics";
import {
  forgetUiRouteDiagnosticsMemoryForTests,
  readSafeUiRouteIncidents,
} from "../infrastructure/ui-route-diagnostics";
import { RuntimeProvider } from "../runtime-context";
import { WRITING_EXPERIENCE_CHANGED_EVENT } from "../hooks/use-writing-experience";

describe("editor candidate route selection", () => {
  it.each([
    ["streaming", "生成中"],
    ["ready", "等待决定"],
    ["accepted", "已接受"],
    ["rejected", "已放弃"],
    ["expired", "已失效"],
    ["unexpected_status", "状态未知"],
  ])("shows a safe Chinese label for candidate status %s", (status, expected) => {
    expect(editorCandidateStatusLabel(status)).toBe(expected);
    expect(editorCandidateStatusLabel(status)).not.toMatch(
      /streaming|ready|accepted|rejected|expired|unexpected/iu,
    );
  });

  it("keeps the newest project chapter visible when an earlier authority read finishes last", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const first = await seedChapter(runtime, "先前项目正文", "先前编辑项目");
    const current = await seedChapter(runtime, "当前项目正文", "当前编辑项目");
    const originalFindById = runtime.repositories.projects.findById.bind(
      runtime.repositories.projects,
    );
    const delayedRead = deferred<Awaited<ReturnType<typeof originalFindById>>>();
    let heldFirstRead = false;
    const findById = vi
      .spyOn(runtime.repositories.projects, "findById")
      .mockImplementation((projectId) => {
        if (projectId === first.project.id && !heldFirstRead) {
          heldFirstRead = true;
          return delayedRead.promise;
        }
        return originalFindById(projectId);
      });
    const user = userEvent.setup();

    renderNavigableEditor(runtime, first, current);

    await waitFor(() => expect(findById).toHaveBeenCalledWith(first.project.id));
    await user.click(screen.getByRole("button", { name: "切换到当前章节" }));
    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue("当前项目正文");

    delayedRead.resolve(await originalFindById(first.project.id));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "章节正文" })).toHaveValue("当前项目正文"),
    );
    expect(screen.getByRole("textbox", { name: "章节正文" })).not.toHaveValue("先前项目正文");
  });

  it("keeps正文 open and records a redacted support id when continuous story state is unavailable", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "不会进入诊断的权威正文");
    const sensitive = "sk-private 正文 C:/Users/writer/continuous-state.txt";
    vi.spyOn(runtime.story.continuousState, "inspectProject").mockRejectedValue(
      new Error(sensitive),
    );

    renderEditor(runtime, project, chapter);

    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue(chapter.content);
    expect(await screen.findByText("连续故事状态暂不可用")).toBeVisible();
    const supportNotice = await screen.findByText(/支持编号：UI-/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(supportNotice.textContent)?.[0];
    if (supportId === undefined) throw new Error("连续故事状态没有生成支持编号。");
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ diagnosticId }) => diagnosticId === supportId,
    );
    expect(incident).toMatchObject({
      diagnosticId: supportId,
      componentName: "EditorPage",
      readStage: "story_governance",
      normalizedErrorCode: "PROJECT_AREA_READ_FAILED",
      recovered: false,
    });
    expect(incident?.reasonCodeChain).toContain("REPOSITORY_ERROR");
    expect(JSON.stringify(incident)).not.toContain(sensitive);
    expect(JSON.stringify(incident)).not.toContain(chapter.content);
    expect(JSON.stringify(window.localStorage)).not.toContain(sensitive);
  });

  it("keeps正文 open, records a stable support id, and rereads after optional candidate failure", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const originalList = runtime.repositories.aiCandidates.listByChapterId.bind(
      runtime.repositories.aiCandidates,
    );
    const candidateId = runtime.ids.next();
    let candidateRowsUnsafe = true;
    vi.spyOn(runtime.repositories.aiCandidates, "listByChapterId").mockImplementation(
      (requestedChapterId) =>
        candidateRowsUnsafe
          ? Promise.resolve(
              err(
                new AppError({
                  code: "REPOSITORY_ERROR",
                  message: "candidate row failed integrity validation",
                  actions: ["CONTACT_SUPPORT"],
                  details: {
                    field: "aiCandidate.contentChecksum",
                    validationCode: "INVALID_CHECKSUM",
                    rowReference: {
                      table: "ai_candidates",
                      candidateId,
                      rowFingerprint: "candidate-7b23d810",
                    },
                  },
                }),
              ),
            )
          : originalList(requestedChapterId),
    );
    const user = userEvent.setup();

    renderEditor(runtime, project, chapter);

    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue(chapter.content);
    expect(await screen.findByText("部分生成记录暂不可用")).toBeVisible();
    const supportNotice = await screen.findByText(/支持编号：UI-/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(supportNotice.textContent)?.[0];
    if (supportId === undefined) throw new Error("missing C2 support id");

    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ diagnosticId }) => diagnosticId === supportId,
    );
    if (incident === undefined) throw new Error("missing C2 diagnostic incident");
    expect(incident).toMatchObject({
      phase: "data_read",
      componentName: "EditorPage",
      errorBoundaryTriggered: false,
      readStage: "ai_candidates",
      triggerIds: { projectId: project.id, chapterId: chapter.id },
      rowReferences: [
        {
          table: "ai_candidates",
          candidateId,
          rowFingerprint: "candidate-7b23d810",
        },
      ],
      recovered: false,
    });
    expect(incident.reasonCodeChain).toEqual(
      expect.arrayContaining(["LEGACY_CANDIDATE_METADATA_INVALID", "INVALID_CHECKSUM"]),
    );
    expect(incident.applicationStack[0]).toMatch(
      /^(?:AppError|Error): LEGACY_CANDIDATE_METADATA_INVALID$/u,
    );
    expect(incident.applicationStack.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^at .+ \(apps\/desktop\/src\/.+:\d+:\d+\)$/u),
      ]),
    );
    expect(incident.reactComponentStack).toEqual(
      expect.arrayContaining([
        "at EditorPage",
        "at DesktopRoutes",
        "at DesktopPersistenceBoundary",
        "at AppErrorBoundary",
        "at EditorDiagnosticTestHost",
      ]),
    );
    expect(incident.reactComponentStack).toEqual(
      expect.not.arrayContaining([expect.stringContaining("(")]),
    );
    expect(JSON.stringify(incident)).not.toContain("candidate row failed integrity validation");
    expect(JSON.stringify(incident)).not.toContain(chapter.content);

    candidateRowsUnsafe = false;
    await user.click(screen.getByRole("button", { name: "重新读取附属资料" }));

    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue(chapter.content);
    await waitFor(() => expect(screen.queryByText("部分生成记录暂不可用")).not.toBeInTheDocument());
    expect(
      readSafeUiRouteIncidents(runtime).find(({ diagnosticId }) => diagnosticId === supportId),
    ).toMatchObject({ recovered: true, recoveryAction: "retry" });
  });

  it("fails closed for unsafe immutable versions and settles the same incident after restart recovery", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const authorityContent = "稳".repeat(40_936);
    const { chapter, project } = await seedChapter(runtime, authorityContent);
    const chapterBefore = await runtime.repositories.chapters.findById(chapter.id);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!chapterBefore.ok || !versionsBefore.ok) {
      throw new Error("failed to read C2 authority baseline");
    }
    const authorityBefore = JSON.stringify({
      chapter: chapterBefore.value?.toSnapshot(),
      versions: versionsBefore.value.map((version) => version.toSnapshot()),
    });
    const originalVersionList = runtime.useCases.listChapterVersions.execute.bind(
      runtime.useCases.listChapterVersions,
    );
    let immutableVersionsUnsafe = true;
    vi.spyOn(runtime.useCases.listChapterVersions, "execute").mockImplementation(
      (requestedChapterId) =>
        immutableVersionsUnsafe
          ? Promise.resolve(
              err(
                new AppError({
                  code: "REPOSITORY_ERROR",
                  message: "must not enter diagnostics",
                  actions: ["EXPORT_DRAFT", "CONTACT_SUPPORT"],
                  details: {
                    field: "chapterVersion.contentChecksum",
                    validationCode: "INVALID_CHECKSUM",
                  },
                }),
              ),
            )
          : originalVersionList(requestedChapterId),
    );

    const firstRender = renderEditor(runtime, project, chapter);
    expect(await screen.findByText(/支持编号：UI-/u)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "章节正文" })).not.toBeInTheDocument();
    expect(screen.getByText("已停止正文写入；本地正文、版本和恢复草稿保持原样。")).toBeVisible();
    const firstSupportText = screen.getByText(/支持编号：UI-/u).textContent;
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(firstSupportText)?.[0];
    if (supportId === undefined) throw new Error("missing authoritative C2 support id");
    firstRender.unmount();
    forgetUiRouteDiagnosticsMemoryForTests(runtime);

    renderEditor(runtime, project, chapter);
    expect(await screen.findByText(new RegExp(supportId, "u"))).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "章节正文" })).not.toBeInTheDocument();
    expect(
      readSafeUiRouteIncidents(runtime).filter(
        ({ diagnosticId, recovered }) => diagnosticId === supportId && !recovered,
      ),
    ).toHaveLength(1);

    immutableVersionsUnsafe = false;
    await userEvent.click(screen.getByRole("button", { name: "重新读取正文" }));

    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue(authorityContent);
    const chapterAfter = await runtime.repositories.chapters.findById(chapter.id);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!chapterAfter.ok || !versionsAfter.ok) {
      throw new Error("failed to read C2 authority after recovery");
    }
    expect(
      JSON.stringify({
        chapter: chapterAfter.value?.toSnapshot(),
        versions: versionsAfter.value.map((version) => version.toSnapshot()),
      }),
    ).toBe(authorityBefore);
    const recoveredIncident = readSafeUiRouteIncidents(runtime).find(
      ({ diagnosticId }) => diagnosticId === supportId,
    );
    if (recoveredIncident === undefined) throw new Error("missing recovered C2 incident");
    expect(recoveredIncident).toMatchObject({
      readStage: "chapter_versions",
      recovered: true,
      recoveryAction: "retry",
    });
    expect(recoveredIncident.reasonCodeChain).toEqual(
      expect.arrayContaining(["LEGACY_VERSION_METADATA_INVALID", "INVALID_CHECKSUM"]),
    );
    expect(recoveredIncident.applicationStack[0]).toMatch(
      /^(?:AppError|Error): LEGACY_VERSION_METADATA_INVALID$/u,
    );
    expect(recoveredIncident.applicationStack.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^at .+ \(apps\/desktop\/src\/.+:\d+:\d+\)$/u),
      ]),
    );
    expect(recoveredIncident.reactComponentStack).toEqual(
      expect.arrayContaining([
        "at EditorPage",
        "at DesktopRoutes",
        "at DesktopPersistenceBoundary",
        "at AppErrorBoundary",
        "at EditorDiagnosticTestHost",
      ]),
    );
    expect(recoveredIncident.reactComponentStack).toEqual(
      expect.not.arrayContaining([expect.stringContaining("(")]),
    );
    const exportedIncident = JSON.stringify(recoveredIncident);
    expect(exportedIncident).not.toContain("must not enter diagnostics");
    expect(exportedIncident).not.toContain("稳".repeat(32));
  });

  it("fails closed when the current immutable version checksum does not match its content", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const authorityContent = "权威正文仍需重新计算校验值。";
    const { chapter, project } = await seedChapter(runtime, authorityContent);
    const hash = vi
      .spyOn(runtime.hasher, "sha256")
      .mockResolvedValue(ok(repeatedContentChecksum("f")));

    renderEditor(runtime, project, chapter);

    expect(await screen.findByText(/支持编号：UI-/u)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "章节正文" })).not.toBeInTheDocument();
    expect(screen.getByText("已停止正文写入；本地正文、版本和恢复草稿保持原样。")).toBeVisible();
    expect(hash).toHaveBeenCalledWith(authorityContent);
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ readStage, recovered }) => readStage === "chapter_versions" && !recovered,
    );
    expect(incident?.reasonCodeChain).toContain("CURRENT_VERSION_CHECKSUM_MISMATCH");
    expect(JSON.stringify(incident)).not.toContain(authorityContent);
  });

  it("identifies the exact corrupted historical immutable version without recording正文", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const authorityContent = "当前权威正文保持不变。";
    const historicalContent = "不得进入诊断的旧版本正文。";
    const { chapter, project } = await seedChapter(runtime, authorityContent);
    const listed = await runtime.useCases.listChapterVersions.execute(chapter.id);
    if (!listed.ok || listed.value[0] === undefined) throw new Error("missing current version");
    const currentVersion = listed.value[0];
    const oldVersionId = parseUuidV7("018f0000-0000-7000-8000-000000000099");
    if (!oldVersionId.ok) throw oldVersionId.error;
    const oldVersion = ChapterVersion.create({
      ...currentVersion.toSnapshot(),
      id: oldVersionId.value,
      parentVersionId: null,
      sequence: 1,
      content: historicalContent,
    });
    if (!oldVersion.ok) throw oldVersion.error;
    const chainedCurrentVersion = ChapterVersion.create({
      ...currentVersion.toSnapshot(),
      parentVersionId: oldVersion.value.id,
      sequence: 2,
    });
    if (!chainedCurrentVersion.ok) throw chainedCurrentVersion.error;
    vi.spyOn(runtime.useCases.listChapterVersions, "execute").mockResolvedValue(
      ok([chainedCurrentVersion.value, oldVersion.value]),
    );
    const originalHash = runtime.hasher.sha256.bind(runtime.hasher);
    vi.spyOn(runtime.hasher, "sha256").mockImplementation((content) =>
      content === historicalContent
        ? Promise.resolve(ok(repeatedContentChecksum("f")))
        : originalHash(content),
    );

    renderEditor(runtime, project, chapter);

    expect(await screen.findByText(/支持编号：UI-/u)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "章节正文" })).not.toBeInTheDocument();
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ readStage, recovered }) => readStage === "chapter_versions" && !recovered,
    );
    expect(incident?.rowReferences).toEqual([
      {
        table: "chapter_versions",
        versionId: oldVersion.value.id,
        sequence: 1,
        rowFingerprint: `version-${currentVersion.toSnapshot().contentChecksum.slice(0, 8)}`,
      },
    ]);
    const serialized = JSON.stringify(incident);
    expect(serialized).not.toContain(historicalContent);
    expect(serialized).not.toContain(authorityContent);
  });

  it("fails closed when immutable version sequence skips an entry", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const authorityContent = "当前权威正文不会因版本链异常而改变。";
    const historicalContent = "安全保留的历史版本。";
    const { chapter, project } = await seedChapter(runtime, authorityContent);
    const listed = await runtime.useCases.listChapterVersions.execute(chapter.id);
    if (!listed.ok || listed.value[0] === undefined) throw new Error("missing current version");
    const currentVersion = listed.value[0];
    const historicalId = parseUuidV7("018f0000-0000-7000-8000-000000000098");
    if (!historicalId.ok) throw historicalId.error;
    const historicalChecksum = await runtime.hasher.sha256(historicalContent);
    if (!historicalChecksum.ok) throw historicalChecksum.error;
    const historicalVersion = ChapterVersion.create({
      ...currentVersion.toSnapshot(),
      id: historicalId.value,
      parentVersionId: null,
      sequence: 1,
      content: historicalContent,
      contentChecksum: historicalChecksum.value,
    });
    if (!historicalVersion.ok) throw historicalVersion.error;
    const skippedCurrentVersion = ChapterVersion.create({
      ...currentVersion.toSnapshot(),
      parentVersionId: historicalVersion.value.id,
      sequence: 3,
    });
    if (!skippedCurrentVersion.ok) throw skippedCurrentVersion.error;
    vi.spyOn(runtime.useCases.listChapterVersions, "execute").mockResolvedValue(
      ok([skippedCurrentVersion.value, historicalVersion.value]),
    );
    const authorityBefore = JSON.stringify({
      chapter: (await runtime.repositories.chapters.findById(chapter.id)).ok
        ? chapter.toSnapshot()
        : null,
      versions: listed.value.map((version) => version.toSnapshot()),
    });

    renderEditor(runtime, project, chapter);

    expect(await screen.findByText(/支持编号：UI-/u)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "章节正文" })).not.toBeInTheDocument();
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ readStage, recovered }) => readStage === "chapter_versions" && !recovered,
    );
    expect(incident?.reasonCodeChain).toContain("VERSION_SEQUENCE_CHAIN_INVALID");
    expect(incident?.rowReferences).toEqual([
      {
        table: "chapter_versions",
        versionId: skippedCurrentVersion.value.id,
        sequence: 3,
        rowFingerprint: `version-${skippedCurrentVersion.value
          .toSnapshot()
          .contentChecksum.slice(0, 8)}`,
      },
    ]);
    const chapterAfter = await runtime.repositories.chapters.findById(chapter.id);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(
      JSON.stringify({
        chapter: chapterAfter.ok ? chapterAfter.value?.toSnapshot() : null,
        versions: versionsAfter.ok
          ? versionsAfter.value.map((version) => version.toSnapshot())
          : [],
      }),
    ).toBe(authorityBefore);
  });

  it("keeps background organization details out of the direct writing surface", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    renderEditor(runtime, project, chapter, "", {
      directOpeningOrganization: {
        kind: "direct_opening_local_organization",
        status: "organized",
        organizedCount: 1,
        importantReviewCount: 1,
      },
    });

    expect(await screen.findByRole("textbox", { name: "章节正文" })).toBeVisible();
    expect(screen.queryByText("已整理 1 条；有 1 条重要设定需要你确认。")).not.toBeInTheDocument();
    expect(screen.queryByText(/direct_opening|LOCAL_|MODEL_/u)).not.toBeInTheDocument();
  });

  it("keeps a complete direct result isolated until explicit use and preserves undo", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("direct");
    const { chapter, project } = await seedChapter(runtime);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const user = userEvent.setup();
    const rendered = renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "续写" }));

    await waitFor(async () => {
      const savedCandidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(savedCandidates.ok && savedCandidates.value[0]?.status).toBe("ready");
    });
    expect(await screen.findByRole("button", { name: "查看并使用" })).toBeVisible();
    const stableBeforeUse = await runtime.repositories.chapters.findById(chapter.id);
    expect(stableBeforeUse.ok && stableBeforeUse.value?.content).toBe(chapter.content);
    const versionsBeforeUse = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    expect(versionsBeforeUse.ok && versionsBeforeUse.value).toHaveLength(
      versionsBefore.value.length,
    );

    await user.click(screen.getByRole("button", { name: "查看并使用" }));
    const review = await screen.findByRole("dialog", { name: "查看创作结果与正文" });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    await waitFor(async () => {
      const savedCandidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(savedCandidates.ok && savedCandidates.value[0]?.status).toBe("accepted");
    });
    const saved = await runtime.repositories.chapters.findById(chapter.id);
    expect(saved.ok && saved.value?.content.length).toBeGreaterThan(chapter.content.length);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(versionsBefore.value.length + 1);

    rendered.unmount();
    const reopened = renderEditor(runtime, project, chapter);
    await user.click(await screen.findByRole("button", { name: "撤销本次续写" }));
    await waitFor(async () => {
      const restored = await runtime.repositories.chapters.findById(chapter.id);
      expect(restored.ok && restored.value?.content).toBe(chapter.content);
    });
    const versionsAfterUndo = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    expect(versionsAfterUndo.ok && versionsAfterUndo.value).toHaveLength(
      versionsBefore.value.length + 2,
    );
    reopened.unmount();
    renderEditor(runtime, project, chapter);
    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue(chapter.content);
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("starts a new installation in direct mode with a visible isolated result", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    expect(preference.directLocalOrganizationAuthorizedAt).not.toBeNull();
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "续写" }));

    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    expect(await screen.findByRole("button", { name: "查看并使用" })).toBeVisible();
    expect(screen.getByText(/创作结果已保存并与正文隔离/u)).toBeVisible();
    const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
    expect(savedChapter.ok && savedChapter.value?.content).toBe(chapter.content);
  });

  it("requires a fresh exact disclosure before one remote call and explicit use", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("direct");
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generatedText =
      "\n林晚来到旧站台。雨沿着玻璃一层层滑下。林晚把那封没有署名的信重新折好，听见远处列车驶入隧道的回声。她没有立刻追上去，只把日记里新出现的一行字记在掌心，然后沿着灯光最暗的方向继续走。";
    let resolveGeneration!: (
      value: Awaited<ReturnType<NativeModelGatewayClient["generate"]>>,
    ) => void;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
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
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "续写" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    expect(
      await within(preflight).findByText(
        /Direct writing remote.*direct-writer.*本次最多向模型服务发送 1 次，自动重试 0 次/u,
      ),
    ).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /确认并开始|使用安全默认值并开始/u }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    resolveGeneration({
      text: generatedText,
      usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
    });

    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await runtime.writingExperience.listActiveDisclosureGrants()).toHaveLength(0);
    const stableBeforeUse = await runtime.repositories.chapters.findById(chapter.id);
    expect(stableBeforeUse.ok && stableBeforeUse.value?.content).toBe(chapter.content);

    await user.click(await screen.findByRole("button", { name: "查看并使用" }));
    const review = await screen.findByRole("dialog", { name: "查看创作结果与正文" });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    const savedChapter = await waitFor(async () => {
      const current = await runtime.repositories.chapters.findById(chapter.id);
      if (!current.ok || current.value === null) {
        throw new Error("明确使用续写后未找到当前正文版本");
      }
      expect(current.value.currentVersionId).not.toBe(chapter.currentVersionId);
      return current.value;
    });
    const savedCurrentVersionId = savedChapter.currentVersionId;
    const storyProjectId = parseStoryUuidV7(project.id);
    if (!storyProjectId.ok) throw storyProjectId.error;
    await waitFor(async () => {
      const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
      if (!facts.ok) throw facts.error;
      const snapshots = facts.value.map((fact) => fact.toSnapshot());
      expect(snapshots.map(({ factType }) => factType)).toEqual(
        expect.arrayContaining(["chapter_summary", "scene_tag"]),
      );
      expect(
        snapshots.every(
          ({ source }) =>
            source.kind === "chapter_span" &&
            String(source.versionId) === String(savedCurrentVersionId) &&
            source.excerpt !== null &&
            source.excerpt.length > 0,
        ),
      ).toBe(true);
    });
  });

  it("requires a fresh exact disclosure before a professional continuation Provider call", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((input) =>
      Promise.resolve({
        text: "\n林晚沿着旧站台继续前行。雨声盖住了远处的脚步，她把信纸收进衣袋，在灯影尽头看见了一扇刚刚打开的门。",
        usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
      }).then((result) => {
        expect(input.config.retryLimit).toBe(0);
        return result;
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
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "生成续写建议" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    expect(
      await within(preflight).findByText(
        /Direct writing remote.*direct-writer.*本次最多向模型服务发送 1 次，自动重试 0 次/u,
      ),
    ).toBeVisible();
    expect(within(preflight).getByText(/当前章节.*故事资料/u)).toBeVisible();
    expect(preflight).not.toHaveTextContent("direct-writing-remote-connection");
    expect(generate).not.toHaveBeenCalled();
    const cancellationCountBefore = readSafeOperationIncidents().filter(
      ({ normalizedErrorCode }) => normalizedErrorCode === "USER_CANCELLED_BEFORE_DISPATCH",
    ).length;

    await user.click(within(preflight).getByRole("button", { name: "暂不生成" }));
    expect(generate).not.toHaveBeenCalled();
    expect(await screen.findByText(/已取消，本次没有调用 AI。支持编号：墨影-/u)).toBeVisible();
    expect(
      readSafeOperationIncidents().filter(
        ({ normalizedErrorCode }) => normalizedErrorCode === "USER_CANCELLED_BEFORE_DISPATCH",
      ),
    ).toHaveLength(cancellationCountBefore + 1);

    await user.click(screen.getByRole("button", { name: "生成续写建议" }));
    const dismissedPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(within(dismissedPreflight).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "生成前检查" })).not.toBeInTheDocument(),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(
      readSafeOperationIncidents().filter(
        ({ normalizedErrorCode }) => normalizedErrorCode === "USER_CANCELLED_BEFORE_DISPATCH",
      ),
    ).toHaveLength(cancellationCountBefore + 2);

    await user.click(screen.getByRole("button", { name: "生成续写建议" }));
    const confirmedPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(
      within(confirmedPreflight).getByRole("button", {
        name: /确认并开始|使用安全默认值并开始/u,
      }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });

  it("records selection rewrite disclosure close and cancel with zero provider calls", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime, "rewrite");
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.reject(new Error("选区改写在确认前不得发送")),
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
    const { chapter, project } = await seedChapter(runtime, "稳定正文等待局部改写");
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    editor.focus();
    editor.setSelectionRange(0, 4);
    fireEvent.select(editor);
    const cancellationCountBefore = readSafeOperationIncidents().filter(
      ({ normalizedErrorCode }) => normalizedErrorCode === "USER_CANCELLED_BEFORE_DISPATCH",
    ).length;

    await user.click(screen.getByRole("button", { name: "查看选区改写发送信息" }));
    const disclosureTitle = await screen.findByText("确认后会发送 1 次", undefined, {
      timeout: 5_000,
    });
    expect(disclosureTitle).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    const disclosureAlert = disclosureTitle.closest('[role="status"]');
    if (!(disclosureAlert instanceof HTMLElement)) {
      throw new Error("没有找到选区改写发送信息提示。");
    }
    await user.click(within(disclosureAlert).getByRole("button", { name: "关闭提示" }));
    expect(await screen.findByText(/已取消，本次没有调用 AI。支持编号：墨影-/u)).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    expect(
      readSafeOperationIncidents().filter(
        ({ normalizedErrorCode }) => normalizedErrorCode === "USER_CANCELLED_BEFORE_DISPATCH",
      ),
    ).toHaveLength(cancellationCountBefore + 1);

    await user.click(screen.getByRole("button", { name: "查看选区改写发送信息" }));
    expect(
      await screen.findByText("确认后会发送 1 次", undefined, { timeout: 5_000 }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消，不发送" }));
    expect(generate).not.toHaveBeenCalled();
    expect(
      readSafeOperationIncidents().filter(
        ({ normalizedErrorCode }) => normalizedErrorCode === "USER_CANCELLED_BEFORE_DISPATCH",
      ),
    ).toHaveLength(cancellationCountBefore + 2);
  });
  it("reuses only an explicit exact continuation confirmation and still requires a summary click", async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({
        text: "\n林晚沿着旧站台继续前行，雨声盖住了远处的脚步。",
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
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "生成续写建议" }));
    const firstPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(
      within(firstPreflight).getByRole("checkbox", {
        name: "在当前会话记住本次确认",
      }),
    );
    await user.click(
      within(firstPreflight).getByRole("button", {
        name: /确认并开始|使用安全默认值并开始/u,
      }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole("button", { name: "放弃" }));
    await user.click(await screen.findByRole("button", { name: "重新生成" }));
    const rememberedPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    expect(within(rememberedPreflight).getByText("已记住本次会话的相同确认")).toBeVisible();
    expect(
      within(rememberedPreflight).queryByRole("checkbox", {
        name: "在当前会话记住本次确认",
      }),
    ).not.toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);

    await user.click(within(rememberedPreflight).getByRole("button", { name: "按本次摘要开始" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  });

  it("stops a professional continuation before dispatch when the disclosed price changes", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({ text: "不应发送", usage: null }),
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
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "生成续写建议" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    const pricing = await runtime.modelHub.findCostPrivacyProfile("direct-writing-remote-catalog");
    if (pricing === null) throw new Error("Expected the disclosed pricing profile.");
    await runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: pricing.catalogEntryId,
      currency: pricing.currency,
      inputMicrosPerMillionTokens: pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: "3000000",
      cachedInputMicrosPerMillionTokens: pricing.cachedInputMicrosPerMillionTokens,
      pricingVersion: "direct-writing-test-v2",
      priceUpdatedAt: "2026-08-20T00:00:00.000Z",
      dataDestination: pricing.dataDestination,
      retentionPolicy: pricing.retentionPolicy,
      trainingPolicy: pricing.trainingPolicy,
      evidenceSource: pricing.evidenceSource,
      evidenceVersion: "direct-writing-test-v2",
      evidenceSummary: pricing.evidenceSummary,
      expectedRevision: pricing.revision,
    });

    await user.click(
      within(preflight).getByRole("button", {
        name: /确认并开始|使用安全默认值并开始/u,
      }),
    );
    expect(await screen.findByText("正文和已保存版本没有变化，你可以继续写作。")).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    expect(candidates.ok && candidates.value).toEqual([]);
  });

  it("rechecks the writing mode before dispatch and makes zero calls after switching to professional", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({ text: "不应生成", usage: null }),
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
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "续写" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    const directPreference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", directPreference.revision);
    window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
    await user.click(
      within(preflight).getByRole("button", { name: /确认并开始|使用安全默认值并开始/u }),
    );

    await waitFor(() => expect(generate).not.toHaveBeenCalled());
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    expect(candidates.ok && candidates.value).toEqual([]);
    expect(await runtime.writingExperience.listActiveDisclosureGrants()).toHaveLength(0);
  });

  it("keeps a delayed direct Candidate isolated while the author continues editing", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generatedText =
      "\n林晚来到旧站台。雨沿着玻璃一层层滑下。林晚把那封没有署名的信重新折好，听见远处列车驶入隧道的回声。她没有立刻追上去，只把日记里新出现的一行字记在掌心，然后沿着灯光最暗的方向继续走。";
    let resolveGeneration!: (
      value: Awaited<ReturnType<NativeModelGatewayClient["generate"]>>,
    ) => void;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
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
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    saveEditorPreferences(window.localStorage, {
      autosaveEnabled: true,
      autosaveDebounceMs: 5_000,
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);
    window.localStorage.removeItem(EDITOR_PREFERENCES_STORAGE_KEY);

    await user.click(await screen.findByRole("button", { name: "续写" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(
      within(preflight).getByRole("button", { name: /确认并开始|使用安全默认值并开始/u }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const editor = screen.getByRole("textbox", { name: "章节正文" });
    await user.click(editor);
    await user.keyboard("{End}作者仍在写");
    expect(editor).toHaveValue(`${chapter.content}作者仍在写`);

    resolveGeneration({
      text: generatedText,
      usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
    });

    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    expect(
      screen.queryByText(
        "正文仍有尚未完成的本地保存，本次结果已保留为隔离 Candidate，没有自动写入正文。",
      ),
    ).not.toBeInTheDocument();
    expect(accept).not.toHaveBeenCalled();
    expect(editor).toHaveValue(`${chapter.content}作者仍在写`);
    const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
    expect(savedChapter.ok && savedChapter.value?.content).toBe(chapter.content);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versionsAfter.ok && versionsAfter.value).toHaveLength(versionsBefore.value.length);
  });

  it("runs exactly one atomic acceptance transaction only after explicit use", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    const { chapter, project } = await seedChapter(runtime);
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "续写" }));
    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    const editor = screen.getByRole("textbox", { name: "章节正文" });
    expect(editor).toHaveValue(chapter.content);
    expect(accept).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "查看并使用" }));
    const review = await screen.findByRole("dialog", { name: "查看创作结果与正文" });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    await waitFor(() => {
      expect(accept).toHaveBeenCalledTimes(1);
      expect((editor as HTMLTextAreaElement).value.length).toBeGreaterThan(chapter.content.length);
    });
  });

  it("prepares exactly three equal directions and replaces them only after an explicit refresh", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const firstGroup = [
      "方向一：林晚追查旧站台的神秘来信，并发现寄信人留下的新线索。",
      "方向二：突如其来的停电迫使林晚与陌生旅客合作寻找出口。",
      "方向三：林晚决定暂时离开站台，先回家核对日记中被改写的内容。",
    ].join("\n");
    const secondGroup = [
      "方向一：列车到站后无人下车，林晚登车寻找声音的来源。",
      "方向二：警方封锁站台，林晚必须在盘问中隐瞒那封来信。",
      "方向三：多年未见的朋友突然出现，要求林晚立刻销毁日记。",
    ].join("\n");
    const generate = installRemoteTextGenerator(runtime, [firstGroup, secondGroup]);
    const { chapter, project } = await seedChapter(runtime);
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "选择方向" }));
    expect(generate).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "确认并生成三个方向" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const firstOptions = await screen.findByLabelText("三个创作方向");
    expect(within(firstOptions).getAllByRole("button")).toHaveLength(3);
    expect(
      within(firstOptions).getByRole("button", {
        name: /方向一：林晚追查旧站台的神秘来信/u,
      }),
    ).toBeVisible();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
    const firstCandidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    if (!firstCandidates.ok) throw firstCandidates.error;
    const firstDirection = firstCandidates.value.find(
      (item) => item.purpose === "continuation_directions",
    );
    if (firstDirection === undefined) throw new Error("缺少第一组方向候选");

    await user.click(screen.getByRole("button", { name: "换一组" }));
    expect(generate).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "确认并生成三个方向" }));
    expect(within(firstOptions).getAllByRole("button")).toHaveLength(3);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("button", {
        name: /方向一：列车到站后无人下车/u,
      }),
    ).toBeVisible();
    expect(screen.getByLabelText("三个创作方向")).toBeVisible();
    expect(within(screen.getByLabelText("三个创作方向")).getAllByRole("button")).toHaveLength(3);
    await waitFor(async () => {
      const persisted = await runtime.repositories.aiCandidates.findById(firstDirection.id);
      expect(persisted.ok && persisted.value?.status).toBe("rejected");
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("reuses system and custom directions for continuation, retaining the group after failure", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const systemDirection = "林晚追上即将离站的列车，在空车厢里寻找寄信人。";
    const directionGroup = [
      "方向一：" + systemDirection,
      "方向二：林晚留在站台调查停电原因，并发现有人一直在监视她。",
      "方向三：林晚先回到住处核对日记，确认哪些记忆已经被篡改。",
    ].join("\n");
    const customDirection = "让林晚先联系旧友，再一起调查站台里的暗门。";
    const completedProse =
      "\n林晚拨通旧友的电话，压低声音说出站台编号。十分钟后，两人在关闭的候车室会合，沿着墙面逐寸寻找，终于在广告牌后摸到一道冰冷的门缝。门内传来的脚步声让他们同时停住，却也证明那封信并非恶作剧。";
    const generate = installRemoteTextGenerator(runtime, [
      directionGroup,
      new Error("provider failed"),
      completedProse,
    ]);
    const { chapter, project } = await seedChapter(runtime);
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "选择方向" }));
    expect(generate).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "确认并生成三个方向" }));
    const systemOption = await screen.findByRole("button", {
      name: /方向一：林晚追上即将离站的列车/u,
    });
    const customInput = screen.getByRole("textbox", { name: /自定义方向/u });
    await user.type(customInput, customDirection);
    await user.click(systemOption);
    const systemPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(
      within(systemPreflight).getByRole("button", {
        name: /确认并开始|使用安全默认值并开始/u,
      }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(
      generate.mock.calls[1]?.[0].messages.some(({ content }) =>
        content.includes(systemDirection.normalize("NFKC")),
      ),
    ).toBe(true);
    expect(await screen.findByText("本次创作未完成")).toBeVisible();
    expect(systemOption).toBeVisible();
    expect(customInput).toHaveValue(customDirection);
    expect(accept).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "按这个方向写" }));
    const customPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(
      within(customPreflight).getByRole("button", {
        name: /确认并开始|使用安全默认值并开始/u,
      }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    expect(
      generate.mock.calls[2]?.[0].messages.some(({ content }) =>
        content.includes(customDirection.normalize("NFKC")),
      ),
    ).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    const stableBeforeUse = await runtime.repositories.chapters.findById(chapter.id);
    expect(stableBeforeUse.ok && stableBeforeUse.value?.content).toBe(chapter.content);
    await user.click(await screen.findByRole("button", { name: "查看并使用" }));
    const review = await screen.findByRole("dialog", {
      name: "查看创作结果与正文",
    });
    expect(within(review).getByRole("textbox", { name: "可编辑的创作结果" })).toHaveValue(
      "\n" + completedProse,
    );
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByLabelText("三个创作方向")).not.toBeInTheDocument());
    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      if (!candidates.ok) throw candidates.error;
      const direction = candidates.value.find((item) => item.purpose === "continuation_directions");
      expect(direction?.status).toBe("rejected");
    });
  });

  it("keeps custom input and exposes retry when a direction response cannot be parsed", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generate = installRemoteTextGenerator(runtime, [
      "只返回了一个模糊方向",
      "方向一：三个方向缺失",
    ]);
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "选择方向" }));
    expect(generate).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "确认并生成三个方向" }));
    expect(await screen.findByText("收到的方向暂时无法使用")).toBeVisible();
    expect(generate).toHaveBeenCalledTimes(1);
    const customInput = screen.getByRole("textbox", { name: /自定义方向/u });
    await user.type(customInput, "保留我输入的方向");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(generate).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "确认并生成三个方向" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(customInput).toHaveValue("保留我输入的方向");
    expect(await screen.findByText("收到的方向暂时无法使用")).toBeVisible();
    expect(screen.queryByLabelText("三个创作方向")).not.toBeInTheDocument();
  });

  it("records the exact zero-send preparation stage and keeps custom direction input", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generate = installRemoteTextGenerator(runtime, ["不应发送的方向内容"]);
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    const customInput = await screen.findByRole("textbox", { name: /自定义方向/u });
    await user.type(customInput, "保留这条用户输入的方向");
    const invocationStart = vi.spyOn(runtime.modelHub, "startInvocation");
    const tasksBefore = await runtime.taskCenter.load();
    vi.spyOn(runtime.projectContextPrivacy, "inspect").mockRejectedValueOnce(
      Object.assign(new Error("controlled local context preparation failure"), {
        code: "DIRECTION_CONTEXT_PREPARATION_FAILED",
      }),
    );

    await user.click(screen.getByRole("button", { name: "选择方向" }));

    const supportNotice = await screen.findByText(/支持编号：墨影-[0-9]{14}-[0-9]{3,}/u);
    expect(supportNotice).toHaveTextContent("准备发送信息");
    expect(supportNotice).toHaveTextContent("本次没有发送");
    expect(customInput).toHaveValue("保留这条用户输入的方向");
    expect(generate).not.toHaveBeenCalled();
    expect(invocationStart).not.toHaveBeenCalled();
    expect(await runtime.taskCenter.load()).toEqual(tasksBefore);
    const supportId = /墨影-[0-9]{14}-[0-9]{3,}/u.exec(supportNotice.textContent)?.[0];
    expect(
      readSafeOperationIncidents().find((incident) => incident.supportId === supportId),
    ).toMatchObject({
      operation: "continuation",
      stage: "prepare_disclosure",
      projectId: project.id,
      chapterId: chapter.id,
      dispatched: false,
      automaticRetryCount: 0,
    });
  });

  it("invalidates saved directions after a正文 version change", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    installRemoteTextGenerator(runtime, [
      [
        "方向一：林晚继续调查站台来信的来源。",
        "方向二：林晚转而寻找日记被改写的原因。",
        "方向三：林晚联系旧友共同检查隐藏暗门。",
      ].join("\n"),
    ]);
    const { chapter, project } = await seedChapter(runtime);
    saveEditorPreferences(window.localStorage, {
      autosaveEnabled: false,
      autosaveDebounceMs: 1_000,
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "选择方向" }));
    await user.click(await screen.findByRole("button", { name: "确认并生成三个方向" }));
    expect(await screen.findByLabelText("三个创作方向")).toBeVisible();
    const directions = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    if (!directions.ok) throw directions.error;
    const direction = directions.value.find((item) => item.purpose === "continuation_directions");
    if (direction === undefined) throw new Error("缺少待失效的方向候选");
    const editor = screen.getByRole("textbox", { name: "章节正文" });
    await user.click(editor);
    await user.keyboard("{End}新的正文");
    await user.click(await screen.findByRole("button", { name: "保存正文" }));
    await waitFor(async () => {
      const persisted = await runtime.repositories.aiCandidates.findById(direction.id);
      expect(persisted.ok && persisted.value?.status).toBe("rejected");
    });
    expect(screen.queryByLabelText("三个创作方向")).not.toBeInTheDocument();
  });

  it("never surfaces or regenerates a direction candidate in professional mode", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    const { chapter, project } = await seedChapter(runtime);
    const direction = await createReadyCandidate(
      runtime,
      project,
      chapter,
      [
        "方向一：林晚继续调查站台来信的来源。",
        "方向二：林晚转而寻找日记被改写的原因。",
        "方向三：林晚联系旧友共同检查隐藏暗门。",
      ].join("\n"),
      { purpose: "continuation_directions" },
    );
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    renderEditor(runtime, project, chapter, "?candidate=" + direction.id);

    expect(await screen.findByRole("heading", { name: "AI 创作助手" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "选择方向" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("三个创作方向")).not.toBeInTheDocument();
    await waitFor(async () => {
      const persisted = await runtime.repositories.aiCandidates.findById(direction.id);
      expect(persisted.ok && persisted.value?.status).toBe("rejected");
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("locks editor input while a manual Candidate acceptance is pending", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const { chapter, project } = await seedChapter(runtime);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const candidate = await createReadyCandidate(runtime, project, chapter, "手动接受的追加正文", {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const executeAcceptance = runtime.useCases.acceptCandidate.execute.bind(
      runtime.useCases.acceptCandidate,
    );
    let releaseAcceptance!: () => void;
    const acceptanceGate = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let markAcceptanceStarted!: () => void;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    const accept = vi
      .spyOn(runtime.useCases.acceptCandidate, "execute")
      .mockImplementation(async (input) => {
        markAcceptanceStarted();
        await acceptanceGate;
        return executeAcceptance(input);
      });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    const acceptButton = within(review).getByRole("button", { name: "使用这版" });
    await user.click(acceptButton);
    await acceptanceStarted;
    fireEvent.click(acceptButton);
    expect(accept).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editor).toHaveAttribute("readonly"));
    expect(review.querySelector(".ink-overlay__footer .ink-button--ai-primary")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(review.querySelector(".ink-overlay__footer")).toBeVisible();
    fireEvent.change(editor, { target: { value: `${chapter.content}不应进入的输入` } });
    expect(editor).toHaveValue(chapter.content);

    releaseAcceptance();
    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    expect(editor).toHaveValue(`${chapter.content}${candidate.content}`);
    expect(providerGenerate).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ organizeLocalStoryFacts: true }));
    const persistedCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persistedCandidate.ok && persistedCandidate.value?.status).toBe("accepted");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(versionsBefore.value.length + 1);
    const originalVersion = versionsBefore.value[0];
    expect(
      versionsAfter.value.find((version) => version.id === originalVersion?.id)?.toSnapshot(),
    ).toEqual(originalVersion?.toSnapshot());
  });

  it("releases a native acceptance after its atomic commit without waiting for derived work", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    Object.assign(runtime, { mode: "tauri" as const });
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "提交后的本地派生可稍后继续",
      {
        source: "polish",
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: chapter.content.length,
          endUtf16: chapter.content.length,
        },
      },
    );
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const originalFindTask = runtime.taskCenter.findTaskByIdempotencyKey.bind(runtime.taskCenter);
    let markTaskLookupStarted!: () => void;
    const taskLookupStarted = new Promise<void>((resolve) => {
      markTaskLookupStarted = resolve;
    });
    let releaseTaskLookup!: () => void;
    const taskLookupGate = new Promise<void>((resolve) => {
      releaseTaskLookup = resolve;
    });
    vi.spyOn(runtime.taskCenter, "findTaskByIdempotencyKey").mockImplementation(async (key) => {
      markTaskLookupStarted();
      await taskLookupGate;
      return originalFindTask(key);
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    await taskLookupStarted;

    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    expect(editor).toHaveValue(`${chapter.content}${candidate.content}`);
    expect(providerGenerate).not.toHaveBeenCalled();
    const accepted = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(accepted.ok && accepted.value?.status).toBe("accepted");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(versionsBefore.value.length + 1);
    const originalVersion = versionsBefore.value[0];
    expect(
      versionsAfter.value.find((version) => version.id === originalVersion?.id)?.toSnapshot(),
    ).toEqual(originalVersion?.toSnapshot());

    releaseTaskLookup();
  });

  it("turns accepted explicit evidence into local pending settings on the production acceptance path", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const { chapter, project } = await seedChapter(runtime, "");
    const acceptedText = [
      "周望是钟楼的管理员。",
      "周望五十七岁。",
      "周望担任钟楼管理员。",
      "周望在旧城守了三十一年。",
      "周望和赵伯是多年的老邻居。",
      "钟摆倒转。",
    ].join("");
    const candidate = await createReadyCandidate(runtime, project, chapter, acceptedText);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    const storyProjectId = parseStoryUuidV7(project.id);
    if (!storyProjectId.ok) throw storyProjectId.error;
    await waitFor(async () => {
      const listed = await runtime.story.facts.listByProjectId(storyProjectId.value);
      if (!listed.ok) throw listed.error;
      const pending = listed.value
        .map((fact) => fact.toSnapshot())
        .filter(({ factType }) => factType !== "chapter_summary");
      expect(pending.length).toBeGreaterThanOrEqual(6);
      expect(pending.map(({ factType }) => factType)).toEqual(
        expect.arrayContaining([
          "character_profile",
          "location_setting",
          "core_relationship",
          "event_category",
        ]),
      );
      expect(
        pending.every(
          ({ status, origin, needsReview, userConfirmed, source }) =>
            status === "unconfirmed" &&
            origin === "system" &&
            needsReview &&
            !userConfirmed &&
            String(source.chapterId) === String(chapter.id) &&
            source.versionId !== null &&
            typeof source.startOffset === "number" &&
            typeof source.endOffset === "number" &&
            source.excerpt !== null &&
            acceptedText.slice(source.startOffset, source.endOffset) === source.excerpt,
        ),
      ).toBe(true);
    });
    const saved = await runtime.repositories.chapters.findById(chapter.id);
    expect(saved.ok && saved.value?.content).toBe(acceptedText);
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("keeps the suggestion isolated when a commit receipt cannot be confirmed", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "结果未知时不得再次提交",
      {
        source: "polish",
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: chapter.content.length,
          endUtf16: chapter.content.length,
        },
      },
    );
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    vi.spyOn(runtime.useCases.acceptCandidate, "execute").mockResolvedValue(
      err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "private commit phase",
          retryable: false,
          actions: ["EXPORT_DRAFT"],
          details: {
            databaseCode: "SQLITE_COMMIT_OUTCOME_UNKNOWN",
            operation: "private SQL",
            outcome: "unknown",
          },
        }),
      ),
    );
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    const unknownOutcomeNotices = await screen.findAllByText(
      "本机暂时无法确认这次写入是否已经完成。请重新打开当前页面，核对正文、版本和 AI 建议草稿状态；系统不会自动再次提交。",
    );
    expect(unknownOutcomeNotices.length).toBeGreaterThan(0);
    for (const notice of unknownOutcomeNotices) expect(notice).toBeVisible();
    expect(editor).toHaveValue(chapter.content);
    expect(editor).not.toHaveAttribute("readonly");
    expect(providerGenerate).not.toHaveBeenCalled();
    const persistedCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persistedCandidate.ok && persistedCandidate.value?.status).toBe("ready");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versionsAfter.ok && versionsAfter.value).toEqual(versionsBefore.value);
    expect(document.body).not.toHaveTextContent("SQLITE_COMMIT_OUTCOME_UNKNOWN");
    expect(document.body).not.toHaveTextContent("private SQL");
  });

  it("does not dispatch manual Candidate acceptance when the chapter became dirty", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "不得覆盖的建议", {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    fireEvent.change(editor, { target: { value: `${chapter.content}用户新输入` } });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    expect(
      await screen.findByText(
        "正文仍有尚未完成的本地保存；这份 AI 建议草稿继续保持隔离，没有写入正文或创建版本。",
      ),
    ).toBeVisible();
    expect(accept).not.toHaveBeenCalled();
    expect(editor).toHaveValue(`${chapter.content}用户新输入`);
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versionsAfter.ok && versionsAfter.value).toHaveLength(versionsBefore.value.length);
  });

  it("locks editor input while a version restore transaction is pending", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const directPreference = await runtime.writingExperience.getOrInitialize();
    const seeded = await seedChapter(runtime);
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      content: "当前第二版正文",
      cursorOffset: 7,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    const restoreVersion = runtime.useCases.restoreChapterVersion.execute.bind(
      runtime.useCases.restoreChapterVersion,
    );
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let markRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    vi.spyOn(runtime.useCases.restoreChapterVersion, "execute").mockImplementation(
      async (input) => {
        markRestoreStarted();
        await restoreGate;
        return restoreVersion(input);
      },
    );
    const user = userEvent.setup();
    renderEditor(runtime, seeded.project, saved.value.chapter);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(screen.getByRole("button", { name: "版本历史" }));
    const history = await screen.findByRole("dialog", { name: "版本历史" });
    await user.click(within(history).getByRole("button", { name: "恢复此版本" }));
    const restore = await screen.findByRole("dialog", { name: /恢复版本/u });
    await user.click(within(restore).getByRole("button", { name: "创建恢复版本" }));
    await restoreStarted;
    await waitFor(() => expect(editor).toHaveAttribute("readonly"));
    fireEvent.change(editor, { target: { value: "恢复期间不应进入的输入" } });
    expect(editor).toHaveValue(saved.value.chapter.content);

    await runtime.writingExperience.switchMode("professional", directPreference.revision);

    releaseRestore();
    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    expect(editor).toHaveValue(seeded.chapter.content);
    const restoredChapter = await runtime.repositories.chapters.findById(seeded.chapter.id);
    if (!restoredChapter.ok || restoredChapter.value === null) {
      throw new Error("Expected the restored chapter.");
    }
    const restoredVersions = await runtime.repositories.chapterVersions.listByChapterId(
      seeded.chapter.id,
    );
    if (!restoredVersions.ok) throw restoredVersions.error;
    const restoredVersion = restoredVersions.value.find(
      (version) => version.id === restoredChapter.value?.currentVersionId,
    );
    const previousVersion = restoredVersions.value.find(
      (version) => version.id === saved.value.chapter.currentVersionId,
    );
    expect(previousVersion?.toSnapshot().organizeLocalStoryFacts).toBe(false);
    expect(restoredVersion?.toSnapshot().organizeLocalStoryFacts).toBe(true);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("professional");
  });

  it("still organizes a restored direct-mode version when background task registration fails", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.getOrInitialize();
    const seeded = await seedChapter(runtime, "周望是钟楼的管理员。");
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      content: "当前第二版正文。",
      cursorOffset: 8,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    vi.spyOn(runtime.taskCenter, "findTaskByIdempotencyKey").mockRejectedValue(
      new Error("TASK_REGISTRATION_UNAVAILABLE"),
    );
    const stageAutomaticFactWithAuthorityFence = vi.spyOn(
      runtime.story.factService,
      "stageAutomaticFactWithAuthorityFence",
    );

    const user = userEvent.setup();
    renderEditor(runtime, seeded.project, saved.value.chapter);
    await user.click(await screen.findByRole("button", { name: "版本历史" }));
    const history = await screen.findByRole("dialog", { name: "版本历史" });
    await user.click(within(history).getByRole("button", { name: "恢复此版本" }));
    const restore = await screen.findByRole("dialog", { name: /恢复版本/u });
    await user.click(within(restore).getByRole("button", { name: "创建恢复版本" }));

    expect(
      await screen.findByText(
        "恢复版本与正文已安全保存；本地设定已整理；后台任务登记失败，可在任务与通知中重试。",
      ),
    ).toBeVisible();
    expect(stageAutomaticFactWithAuthorityFence).toHaveBeenCalled();
    const projectId = parseStoryUuidV7(seeded.project.id);
    if (!projectId.ok) throw projectId.error;
    const facts = await runtime.story.facts.listByProjectId(projectId.value);
    if (!facts.ok) throw facts.error;
    expect(facts.value.map((fact) => fact.toSnapshot().contentText)).toContain(
      "周望是钟楼的管理员。",
    );
  });

  it("keeps a restored正文 version safe when direct fact preflight fails", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.getOrInitialize();
    const seeded = await seedChapter(runtime);
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      content: "当前第二版正文。",
      cursorOffset: 8,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(
      seeded.chapter.id,
    );
    if (!versionsBefore.ok) throw versionsBefore.error;

    const user = userEvent.setup();
    renderEditor(runtime, seeded.project, saved.value.chapter);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });
    vi.spyOn(runtime.story.facts, "listByProjectId").mockRejectedValue(
      new Error("CURRENT_VERSION_FACTS_UNAVAILABLE"),
    );
    const startTask = vi.spyOn(runtime.taskCenter, "startTask");
    const search = vi.spyOn(runtime.search, "rebuildProject");
    const summary = vi.spyOn(runtime.story.chapterSummaries, "summarizeSavedVersion");
    const storyState = vi.spyOn(runtime.story.continuousState, "extractSavedVersion");
    const causal = vi.spyOn(runtime.story.causalProjector, "rebuildProject");

    await user.click(await screen.findByRole("button", { name: "版本历史" }));
    const history = await screen.findByRole("dialog", { name: "版本历史" });
    await user.click(within(history).getByRole("button", { name: "恢复此版本" }));
    const restore = await screen.findByRole("dialog", { name: /恢复版本/u });
    await user.click(within(restore).getByRole("button", { name: "创建恢复版本" }));

    expect(
      await screen.findByText(
        "恢复版本与正文已安全保存；故事资料整理暂未完成，可在任务与通知中重试。",
        undefined,
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue(seeded.chapter.content);
    const restoredChapter = await runtime.repositories.chapters.findById(seeded.chapter.id);
    if (!restoredChapter.ok || restoredChapter.value === null) {
      throw new Error("恢复后的章节不存在。");
    }
    expect(restoredChapter.value.content).toBe(seeded.chapter.content);
    expect(restoredChapter.value.currentVersionId).not.toBe(saved.value.chapter.currentVersionId);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(
      seeded.chapter.id,
    );
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(versionsBefore.value.length + 1);
    for (const stableVersion of versionsBefore.value) {
      expect(versionsAfter.value.find(({ id }) => id === stableVersion.id)?.toSnapshot()).toEqual(
        stableVersion.toSnapshot(),
      );
    }
    const queuedTask = (await runtime.taskCenter.load()).tasks.find(
      (task) => task.status === "queued",
    );
    expect(queuedTask?.metadata).toMatchObject({ organizeLocalStoryFacts: true });
    expect(startTask).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
    expect(storyState).not.toHaveBeenCalled();
    expect(causal).not.toHaveBeenCalled();
  });

  it("opens the exact ready UUIDv7 candidate requested by the query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const requested = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "路由明确指定的候选正文",
    );
    await createReadyCandidate(runtime, project, chapter, "不应替代指定候选的其他正文");

    renderEditor(runtime, project, chapter, `?candidate=${requested.id}`);

    expect(await screen.findByText("路由明确指定的候选正文")).toBeVisible();
    expect(screen.queryByText("不应替代指定候选的其他正文")).not.toBeInTheDocument();
  });

  it("keeps every prose result reachable from chapter history without touching正文 or versions", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const older = await createReadyCandidate(runtime, project, chapter, "较早的隔离结果");
    const newest = await createReadyCandidate(runtime, project, chapter, "较新的隔离结果");
    await createReadyCandidate(runtime, project, chapter, "只用于选择方向，不进入正文历史", {
      purpose: "continuation_directions",
    });
    const chapterBefore = await runtime.repositories.chapters.findById(chapter.id);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!chapterBefore.ok || !versionsBefore.ok) throw new Error("failed to read stable baseline");
    const user = userEvent.setup();

    renderEditor(runtime, project, chapter, `?candidate=${older.id}`);

    expect(await screen.findByText("历史生成结果（2）")).toBeVisible();
    await user.click(screen.getByText("历史生成结果（2）"));
    expect(screen.queryByText("只用于选择方向，不进入正文历史")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看第 1 条生成结果" }));
    expect(
      await screen.findByText("已打开这份隔离结果；只有你明确使用，才会写入正文。"),
    ).toBeVisible();
    expect(screen.getAllByText(newest.content).length).toBeGreaterThan(0);

    const chapterAfterView = await runtime.repositories.chapters.findById(chapter.id);
    const versionsAfterView = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    expect(chapterAfterView).toEqual(chapterBefore);
    expect(versionsAfterView).toEqual(versionsBefore);

    await user.click(screen.getByRole("button", { name: "放弃第 2 条生成结果" }));
    await waitFor(async () => {
      const persisted = await runtime.repositories.aiCandidates.findById(older.id);
      expect(persisted.ok && persisted.value?.status).toBe("rejected");
    });
    const chapterAfterReject = await runtime.repositories.chapters.findById(chapter.id);
    const versionsAfterReject = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    expect(chapterAfterReject).toEqual(chapterBefore);
    expect(versionsAfterReject).toEqual(versionsBefore);
  });

  it.each([
    ["accepted", "已接受"],
    ["rejected", "已放弃"],
    ["expired", "已失效"],
  ] as const)("opens a complete %s historical result as read-only", async (status, statusLabel) => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const completeEnding = `【${statusLabel}结果的完整结尾】`;
    const completeContent = `${"终态历史正文".repeat(700)}${completeEnding}`;
    const ready = await createReadyCandidate(runtime, project, chapter, completeContent);
    const terminal =
      status === "accepted"
        ? ready.accept(runtime.clock.now())
        : status === "rejected"
          ? ready.reject(runtime.clock.now())
          : ready.expire(runtime.clock.now());
    if (!terminal.ok) throw terminal.error;
    const saved = await runtime.repositories.aiCandidates.save(terminal.value, {
      status: "ready",
      revision: ready.revision,
    });
    if (!saved.ok) throw saved.error;
    const chapterBefore = await runtime.repositories.chapters.findById(chapter.id);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!chapterBefore.ok || !versionsBefore.ok) throw new Error("failed to read stable baseline");
    const user = userEvent.setup();

    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByText("历史生成结果（1）"));
    await user.click(screen.getByRole("button", { name: "查看第 1 条生成结果" }));

    expect((await screen.findAllByText(statusLabel)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("完整历史生成结果")).toHaveTextContent(completeEnding);
    expect(screen.queryByText(/面板仅显示前 4,000 个字符/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/不存在或不属于当前项目/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用这版" })).not.toBeInTheDocument();

    const chapterAfter = await runtime.repositories.chapters.findById(chapter.id);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(chapterAfter).toEqual(chapterBefore);
    expect(versionsAfter).toEqual(versionsBefore);
  });

  it("keeps a long ready result bounded behind the existing author decision flow", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const completeEnding = "【等待决定结果的完整结尾】";
    const ready = await createReadyCandidate(
      runtime,
      project,
      chapter,
      `${"等待决定正文".repeat(700)}${completeEnding}`,
    );
    const chapterBefore = await runtime.repositories.chapters.findById(chapter.id);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!chapterBefore.ok || !versionsBefore.ok) throw new Error("failed to read stable baseline");

    renderEditor(runtime, project, chapter, `?candidate=${ready.id}`);

    const preview = await screen.findByLabelText("当前生成结果预览");
    expect(preview).toHaveTextContent(/预览已截断，完整内容仍保留/u);
    expect(preview).not.toHaveTextContent(completeEnding);
    expect(screen.getByText(/面板仅显示前 4,000 个字符/u)).toBeVisible();
    expect(screen.getByRole("button", { name: /查看并使用|比较.*建议/u })).toBeVisible();
    expect(screen.getByRole("button", { name: "放弃" })).toBeVisible();

    const chapterAfter = await runtime.repositories.chapters.findById(chapter.id);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(chapterAfter).toEqual(chapterBefore);
    expect(versionsAfter).toEqual(versionsBefore);
  });
  it("keeps a locally generated opening labeled as a local draft after entering the editor", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "本地开头草案", {
      source: "generate",
    });
    const now = runtime.clock.now();
    await runtime.creativeJourneys.create(
      {
        id: candidate.id,
        kind: "idea",
        status: "active",
        currentState: "opening_selected",
        projectId: project.id,
        chapterId: chapter.id,
        candidateId: null,
        revision: 1,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      {
        id: runtime.ids.next(),
        journeyId: candidate.id,
        sequence: 1,
        kind: "idea",
        questionKey: null,
        generationSource: "local_fallback",
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
      },
    );
    await runtime.creativeJourneys.update(
      {
        id: candidate.id,
        kind: "idea",
        status: "active",
        currentState: "candidate_ready",
        projectId: project.id,
        chapterId: chapter.id,
        candidateId: candidate.id,
        revision: 2,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      1,
      {
        id: runtime.ids.next(),
        journeyId: candidate.id,
        sequence: 2,
        kind: "keep",
        questionKey: null,
        generationSource: "local_fallback",
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: { candidateId: candidate.id, previewSource: "local_fallback" },
        createdAt: now,
      },
    );

    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看本地草案版本" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "比较本地草案" }));
    expect(await screen.findByRole("dialog", { name: "比较本地草案与正文" })).toBeVisible();
  });

  it.each([
    { action: "使用这版", decision: "accepted", finalState: "candidate_accepted" },
    { action: "放弃", decision: "rejected", finalState: "candidate_rejected" },
  ] as const)(
    "settles an active idea journey after the author chooses $action on a blank chapter",
    async ({ action, decision, finalState }) => {
      window.localStorage.clear();
      const runtime = createDevelopmentRuntime(window.localStorage);
      expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("direct");
      const { chapter, project } = await seedChapter(runtime, "");
      const candidate = await createReadyCandidate(runtime, project, chapter, "明确决定的开头", {
        source: "generate",
      });
      await seedActiveIdeaCandidateJourney(runtime, project, chapter, candidate);
      const rejectCandidate = vi.spyOn(runtime.useCases.rejectCandidate, "execute");
      const user = userEvent.setup();

      renderEditor(runtime, project, chapter, "?candidate=" + candidate.id);

      await user.click(await screen.findByRole("button", { name: /查看.*版本/u }));
      const review = await screen.findByRole("dialog");
      const decisionButton = within(review).getByRole("button", { name: action });
      if (action === "放弃") {
        fireEvent.click(decisionButton);
        fireEvent.click(decisionButton);
      } else {
        await user.click(decisionButton);
      }

      await waitFor(async () => {
        const persistedCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
        expect(persistedCandidate.ok && persistedCandidate.value?.status).toBe(decision);
        const journey = await runtime.creativeJourneys.findById(candidate.id);
        expect(journey).toMatchObject({
          status: "completed",
          currentState: finalState,
        });
      });
      const stable = await runtime.repositories.chapters.findById(chapter.id);
      expect(stable.ok && stable.value?.content).toBe(
        decision === "accepted" ? candidate.content : "",
      );
      const versions = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      expect(versions.ok && versions.value).toHaveLength(decision === "accepted" ? 2 : 1);
      expect(await runtime.creativeJourneys.listActive("idea")).toHaveLength(0);
      if (action === "放弃") {
        expect(rejectCandidate).toHaveBeenCalledOnce();
        expect(screen.queryByText(/冲突/u)).not.toBeInTheDocument();
      }
    },
  );

  it("allows only one winner when accept and reject are activated in the same commit cycle", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "");
    const candidate = await createReadyCandidate(runtime, project, chapter, "同周期决定的开头", {
      source: "generate",
    });
    await seedActiveIdeaCandidateJourney(runtime, project, chapter, candidate);
    const acceptCandidate = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const rejectCandidate = vi.spyOn(runtime.useCases.rejectCandidate, "execute");
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, "?candidate=" + candidate.id);

    await user.click(await screen.findByRole("button", { name: /查看.*版本/u }));
    const review = await screen.findByRole("dialog");
    const acceptButton = within(review).getByRole("button", { name: "使用这版" });
    const rejectButton = within(review).getByRole("button", { name: "放弃" });
    fireEvent.click(acceptButton);
    fireEvent.click(rejectButton);

    await waitFor(async () => {
      const persistedCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
      expect(persistedCandidate.ok && persistedCandidate.value?.status).toBe("accepted");
    });
    expect(acceptCandidate).toHaveBeenCalledOnce();
    expect(rejectCandidate).not.toHaveBeenCalled();
    const stableChapter = await runtime.repositories.chapters.findById(chapter.id);
    expect(stableChapter.ok && stableChapter.value?.content).toBe(candidate.content);
    const versions = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versions.ok && versions.value).toHaveLength(2);
    expect(await runtime.creativeJourneys.findById(candidate.id)).toMatchObject({
      status: "completed",
      currentState: "candidate_accepted",
    });
    expect(screen.queryByText(/冲突/u)).not.toBeInTheDocument();
  });

  it("repairs the journey on reopen when acceptance succeeded but its first settlement write failed", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("direct");
    const { chapter, project } = await seedChapter(runtime, "");
    const candidate = await createReadyCandidate(runtime, project, chapter, "重开后结算的开头", {
      source: "generate",
    });
    await seedActiveIdeaCandidateJourney(runtime, project, chapter, candidate);
    const originalUpdate = runtime.creativeJourneys.update.bind(runtime.creativeJourneys);
    let failSettlementOnce = true;
    vi.spyOn(runtime.creativeJourneys, "update").mockImplementation(
      (record, expectedRevision, turn) => {
        if (
          failSettlementOnce &&
          record.status === "completed" &&
          record.currentState === "candidate_accepted"
        ) {
          failSettlementOnce = false;
          return Promise.reject(new Error("simulated journey settlement failure"));
        }
        return originalUpdate(record, expectedRevision, turn);
      },
    );
    const user = userEvent.setup();
    const first = renderEditor(runtime, project, chapter, "?candidate=" + candidate.id);

    await user.click(await screen.findByRole("button", { name: /查看.*版本/u }));
    const review = await screen.findByRole("dialog");
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    await waitFor(async () => {
      const persistedCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
      expect(persistedCandidate.ok && persistedCandidate.value?.status).toBe("accepted");
    });
    expect(await runtime.creativeJourneys.findById(candidate.id)).toMatchObject({
      status: "active",
      currentState: "candidate_ready",
    });
    const stableAfterAcceptance = await runtime.repositories.chapters.findById(chapter.id);
    expect(stableAfterAcceptance.ok && stableAfterAcceptance.value?.content).toBe(
      candidate.content,
    );
    first.unmount();

    renderEditor(runtime, project, chapter, "?candidate=" + candidate.id);

    await waitFor(async () => {
      expect(await runtime.creativeJourneys.findById(candidate.id)).toMatchObject({
        status: "completed",
        currentState: "candidate_accepted",
      });
    });
    const versions = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versions.ok && versions.value).toHaveLength(2);
  });
  it("uses a neutral label when a generate candidate has no trustworthy origin receipt", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "来源记录缺失的候选", {
      source: "generate",
    });

    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看建议版本" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 AI 建议版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看本地草案版本" })).not.toBeInTheDocument();
  });

  it("does not relabel a generate candidate as AI when its origin receipt cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "来源记录读取失败的候选",
      {
        source: "generate",
      },
    );
    vi.spyOn(runtime.creativeJourneys, "findById").mockRejectedValueOnce(
      new Error("journey unavailable"),
    );

    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看建议版本" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 AI 建议版本" })).not.toBeInTheDocument();
  });

  it("shows a visible error and does not fall back for an invalid candidate query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    await createReadyCandidate(runtime, project, chapter, "不可静默打开的默认候选");

    renderEditor(runtime, project, chapter, "?candidate=not-a-uuid");

    expect(
      await screen.findByText("AI 建议链接无效；未自动打开其他建议。请从深度审稿页重新选择。"),
    ).toBeVisible();
    expect(screen.queryByText("不可静默打开的默认候选")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还没有 AI 建议版本" })).toBeVisible();
  });

  it("rejects a ready candidate from another chapter without opening the local default", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const otherChapterResult = await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第二章",
      content: "第二章稳定正文",
    });
    if (!otherChapterResult.ok) {
      throw otherChapterResult.error;
    }
    const crossChapter = await createReadyCandidate(
      runtime,
      project,
      otherChapterResult.value.chapter,
      "其他章节候选",
    );
    await createReadyCandidate(runtime, project, chapter, "当前章节默认候选");

    renderEditor(runtime, project, chapter, `?candidate=${crossChapter.id}`);

    expect(
      await screen.findByText(
        "链接指定的生成结果不存在或不属于当前项目与章节；未自动打开其他结果。",
      ),
    ).toBeVisible();
    expect(screen.queryByText("当前章节默认候选")).not.toBeInTheDocument();
    expect(screen.queryByText("其他章节候选")).not.toBeInTheDocument();
  });

  it("rejects a non-ready candidate and exposes the multi-agent review link only when enabled", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const streaming = AiCandidate.createStreaming({
      id: runtime.ids.next(),
      projectId: project.id,
      chapterId: chapter.id,
      source: "agent",
      baseVersionId: chapter.currentVersionId,
      now: runtime.clock.now(),
    });
    if (!streaming.ok) {
      throw streaming.error;
    }
    const created = await runtime.repositories.aiCandidates.create(streaming.value);
    if (!created.ok) {
      throw created.error;
    }
    Object.assign(runtime, {
      featureFlags: Object.freeze({ ...runtime.featureFlags, multiAgent: true }),
      multiAgentReview: Object.freeze({}),
    });

    renderEditor(runtime, project, chapter, `?candidate=${streaming.value.id}`);

    expect(
      await screen.findByText(
        "链接指定的生成结果不存在或不属于当前项目与章节；未自动打开其他结果。",
      ),
    ).toBeVisible();
    await userEvent.setup().click(screen.getByText("高级工具"));
    expect(
      screen
        .getAllByRole("link", { name: "深度审稿" })
        .find(
          (link) =>
            link.getAttribute("href") ===
            `/projects/${project.id}/chapters/${chapter.id}/multi-agent-review`,
        ),
    ).toBeVisible();
  });

  it("uses the persisted selection-rewrite anchor instead of the current editor selection", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "新稿", {
      source: "polish",
      applicationIntent: {
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16: 2,
        endUtf16: 4,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: "比较 AI 建议" }));
    const review = await screen.findByRole("dialog", { name: "比较 AI 建议与正文" });
    expect(within(review).getByText(/第 2 到第 4 个字符/u)).toBeVisible();
    await user.click(within(review).getByRole("button", { name: "替换选区并创建版本" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "章节正文" })).toHaveValue("稳定新稿"),
    );
  });

  it("offers the four explicit whole-chapter rewrite outcomes", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "整章改写正文", {
      source: "polish",
      applicationIntent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: "比较 AI 建议" }));
    const review = await screen.findByRole("dialog", { name: "比较 AI 建议与正文" });
    expect(within(review).getByRole("button", { name: "取消" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "替换整章并创建版本" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "追加到章末并创建版本" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "保存为新草稿" })).toBeEnabled();
  });

  it.each([5_000, 10_681, 20_000, 50_000, 96_088])(
    "keeps a %i-character continuation complete and reachable through the fixed decision footer",
    async (characterCount) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const { chapter, project } = await seedChapter(runtime);
      const generatedContent = "长".repeat(characterCount);
      const candidate = await createReadyCandidate(runtime, project, chapter, generatedContent, {
        source: "polish",
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: chapter.content.length,
          endUtf16: chapter.content.length,
        },
      });
      const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
      const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsBefore.ok) {
        throw versionsBefore.error;
      }
      const immutableVersionsBefore = versionsBefore.value.map((version) => version.toSnapshot());
      const user = userEvent.setup();
      renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

      await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
      const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
      expect(within(review).getByRole("textbox")).toHaveValue(generatedContent);
      expect(within(review).getByRole("button", { name: "使用这版" })).toBeVisible();
      expect(within(review).getByRole("button", { name: "放弃" })).toBeVisible();

      await user.click(within(review).getByRole("button", { name: "使用这版" }));

      await waitFor(async () => {
        const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
        expect(savedChapter.ok && savedChapter.value?.content).toBe(
          `${chapter.content}${generatedContent}`,
        );
      });
      const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsAfter.ok) {
        throw versionsAfter.error;
      }
      expect(versionsAfter.value).toHaveLength(immutableVersionsBefore.length + 1);
      const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
      if (!savedChapter.ok || savedChapter.value === null) {
        throw new Error("接受长正文后未找到当前章节");
      }
      const acceptedVersion = versionsAfter.value.find(
        (version) => version.id === savedChapter.value?.currentVersionId,
      );
      expect(acceptedVersion?.toSnapshot()).toMatchObject({
        content: chapter.content + generatedContent,
        reason: "candidate_accept",
        sourceCandidateId: candidate.id,
      });
      for (const immutableVersion of immutableVersionsBefore) {
        expect(
          versionsAfter.value.find((version) => version.id === immutableVersion.id)?.toSnapshot(),
        ).toEqual(immutableVersion);
      }
      expect(providerGenerate).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      characterCount: 10_681,
      expectedContent: (stable: string, candidate: string) =>
        `${stable.slice(0, 2)}${candidate}${stable.slice(4)}`,
      intent: {
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16: 2,
        endUtf16: 4,
      } satisfies AiCandidateApplicationIntent,
      action: "替换选区并创建版本",
    },
    {
      characterCount: 20_000,
      expectedContent: (_stable: string, candidate: string) => candidate,
      intent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      } satisfies AiCandidateApplicationIntent,
      action: "替换整章并创建版本",
    },
  ])(
    "applies the complete $characterCount-character $intent.task Candidate through its explicit action",
    async ({ action, characterCount, expectedContent, intent }) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const { chapter, project } = await seedChapter(runtime);
      const generatedContent = "候".repeat(characterCount);
      const candidate = await createReadyCandidate(runtime, project, chapter, generatedContent, {
        source: "polish",
        applicationIntent: intent,
      });
      const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsBefore.ok) throw versionsBefore.error;
      const immutableVersionsBefore = versionsBefore.value.map((version) => version.toSnapshot());
      const user = userEvent.setup();
      renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

      await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
      const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
      expect(within(review).getByRole("textbox")).toHaveValue(generatedContent);
      await user.click(within(review).getByRole("button", { name: action }));

      await waitFor(async () => {
        const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
        expect(savedChapter.ok && savedChapter.value?.content).toBe(
          expectedContent(chapter.content, generatedContent),
        );
      });
      const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsAfter.ok) throw versionsAfter.error;
      expect(versionsAfter.value).toHaveLength(immutableVersionsBefore.length + 1);
      for (const immutableVersion of immutableVersionsBefore) {
        expect(
          versionsAfter.value.find((version) => version.id === immutableVersion.id)?.toSnapshot(),
        ).toEqual(immutableVersion);
      }
    },
  );

  it("accepts an exact 50,000-character author-edited Candidate without changing its base version", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "原".repeat(5_000), {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const immutableVersionsBefore = versionsBefore.value.map((version) => version.toSnapshot());
    const editedContent = "改".repeat(50_000);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    fireEvent.change(within(review).getByRole("textbox"), { target: { value: editedContent } });
    expect(within(review).getByText("50,000 字符", { exact: true })).toBeVisible();
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    await waitFor(async () => {
      const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
      expect(savedChapter.ok && savedChapter.value?.content).toBe(
        `${chapter.content}${editedContent}`,
      );
    });
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(immutableVersionsBefore.length + 1);
    for (const immutableVersion of immutableVersionsBefore) {
      expect(
        versionsAfter.value.find((version) => version.id === immutableVersion.id)?.toSnapshot(),
      ).toEqual(immutableVersion);
    }
  });

  it("keeps a 20,000-character stale Candidate complete behind a bounded three-way conflict", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const generatedContent = "冲".repeat(20_000);
    const candidate = await createReadyCandidate(runtime, project, chapter, generatedContent, {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const changedContent = "当前稳定正文".repeat(1_000).slice(0, 5_000);
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      content: changedContent,
      cursorOffset: changedContent.length,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    const user = userEvent.setup();
    renderEditor(runtime, project, saved.value.chapter, `?candidate=${candidate.id}`);

    const trigger = await screen.findByRole("button", { name: /比较.*建议/u });
    await user.click(trigger);
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    expect(within(review).getByText("正文已在建议生成后变化")).toBeVisible();
    expect(within(review).getByRole("button", { name: "使用这版" })).toBeDisabled();
    expect(within(review).getAllByText(/预览已截断，完整内容仍保留/u)).toHaveLength(2);
    expect(within(review).queryByText(generatedContent)).not.toBeInTheDocument();
    const persisted = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persisted.ok && persisted.value?.content).toBe(generatedContent);
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(changedContent);
  });

  it("keeps a failed Candidate decision visible inside the bounded review", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "错".repeat(10_681), {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    const concurrentRevision = await runtime.useCases.reviseCandidate.execute({
      candidateId: candidate.id,
      expectedCandidateRevision: candidate.revision,
      content: "另一个窗口保存的候选修改",
    });
    if (!concurrentRevision.ok) throw concurrentRevision.error;
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    expect(await within(review).findByText(/比较提示/u)).toBeVisible();
    expect(review.querySelector(".ink-overlay__footer")).toBeVisible();
    expect(review).toBeVisible();
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(chapter.content);
    const persisted = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persisted.ok && persisted.value?.status).toBe("ready");
  });

  it("supports bounded keyboard scrolling, focus containment, Escape, and focus return", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "键".repeat(5_000), {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    const trigger = await screen.findByRole("button", { name: /比较.*建议/u });
    await user.click(trigger);
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    const scrollControl = within(review).getByRole("button", { name: /浏览.*建议内容/u });
    const scrollContainer = review.querySelector<HTMLElement>(".ink-overlay__content");
    if (scrollContainer === null) throw new Error("Candidate review main scroller is missing.");
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 4_000 },
    });
    await waitFor(() => expect(scrollControl).toHaveFocus());

    fireEvent.keyDown(scrollControl, { key: "PageDown" });
    expect(scrollContainer.scrollTop).toBe(340);
    fireEvent.keyDown(scrollControl, { key: "End" });
    expect(scrollContainer.scrollTop).toBe(4_000);
    fireEvent.keyDown(scrollControl, { key: "Home" });
    expect(scrollContainer.scrollTop).toBe(0);
    fireEvent.keyDown(scrollControl, { key: "PageUp" });
    expect(scrollContainer.scrollTop).toBeLessThanOrEqual(0);

    const lastAction = within(review).getByRole("button", { name: "使用这版" });
    lastAction.focus();
    await user.tab();
    expect(review.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(review.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(review).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

function renderEditor(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  search = "",
  state?: unknown,
): ReturnType<typeof render> {
  const pathname = `/projects/${project.id}/chapters/${chapter.id}${search}`;
  return render(
    <MemoryRouter initialEntries={[state === undefined ? pathname : { pathname, state }]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <ComponentOwnershipBoundary name="EditorDiagnosticTestHost">
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

function renderNavigableEditor(
  runtime: DesktopRuntime,
  first: Readonly<{ project: Project; chapter: Chapter }>,
  current: Readonly<{ project: Project; chapter: Chapter }>,
): ReturnType<typeof render> {
  const firstPath = `/projects/${first.project.id}/chapters/${first.chapter.id}`;
  const currentPath = `/projects/${current.project.id}/chapters/${current.chapter.id}`;
  return render(
    <MemoryRouter initialEntries={[firstPath]}>
      <EditorRouteSwitch target={currentPath} />
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <ComponentOwnershipBoundary name="EditorDiagnosticTestHost">
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

function EditorRouteSwitch({ target }: Readonly<{ target: string }>) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(target)}>
      切换到当前章节
    </button>
  );
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve } as const;
}

function repeatedContentChecksum(character: string) {
  const parsed = parseContentChecksum(character.repeat(64));
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

async function seedChapter(
  runtime: DesktopRuntime,
  content = "稳定正文",
  projectName = "候选路由测试项目",
): Promise<{
  readonly project: Project;
  readonly chapter: Chapter;
}> {
  const project = await runtime.useCases.createProject.execute({ name: projectName });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content,
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return { project: project.value, chapter: chapter.value.chapter };
}

async function seedRemoteContinuationRoute(
  runtime: DesktopRuntime,
  task: "continuation" | "rewrite" = "continuation",
): Promise<void> {
  const connection = await runtime.modelHub.saveConnection({
    id: "direct-writing-remote",
    providerKind: "custom_openai_compatible",
    displayName: "Direct writing remote",
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
    syncId: "direct-writing-remote-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "direct-writing-remote-catalog",
        providerModelId: "direct-writer",
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2027-08-18T00:00:00.000Z",
      },
    ],
  });
  await runtime.modelHub.recordCapabilityScan({
    scanId: "direct-writing-remote-scan",
    catalogEntryId: "direct-writing-remote-catalog",
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "direct-writing-test-v1",
    evidence: [
      {
        id: "direct-writing-remote-text-evidence",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await runtime.modelHub.saveCostPrivacyProfile({
    catalogEntryId: "direct-writing-remote-catalog",
    currency: "USD",
    inputMicrosPerMillionTokens: "1000000",
    outputMicrosPerMillionTokens: "2000000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "direct-writing-test-v1",
    priceUpdatedAt: "2026-08-18T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "direct-writing-test-v1",
    expectedRevision: null,
  });
  await runtime.modelHub.saveTaskRoute({
    task,
    primaryCatalogEntryId: "direct-writing-remote-catalog",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

function installRemoteTextGenerator(
  runtime: DesktopRuntime,
  responses: readonly (string | Error)[],
) {
  let responseIndex = 0;
  const generate = vi.fn<NativeModelGatewayClient["generate"]>(() => {
    const response = responses[responseIndex];
    responseIndex += 1;
    if (response instanceof Error) return Promise.reject(response);
    if (response === undefined) return Promise.reject(new Error("没有为本次测试准备返回内容"));
    return Promise.resolve({
      text: response,
      usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
    });
  });
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
  return generate;
}

async function createReadyCandidate(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  content: string,
  options: Readonly<{
    source?: AiCandidateSource;
    purpose?: AiCandidatePurpose;
    applicationIntent?: AiCandidateApplicationIntent;
  }> = {},
): Promise<AiCandidate> {
  const streaming = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: project.id,
    chapterId: chapter.id,
    source: options.source ?? "agent",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.applicationIntent === undefined
      ? {}
      : { applicationIntent: options.applicationIntent }),
  });
  if (!streaming.ok) {
    throw streaming.error;
  }
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    throw checksum.error;
  }
  const ready = streaming.value.markReady(content, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    throw ready.error;
  }
  const created = await runtime.repositories.aiCandidates.create(ready.value);
  if (!created.ok) {
    throw created.error;
  }
  return ready.value;
}

async function seedActiveIdeaCandidateJourney(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  candidate: AiCandidate,
): Promise<void> {
  const now = runtime.clock.now();
  await runtime.creativeJourneys.create(
    {
      id: candidate.id,
      kind: "idea",
      status: "active",
      currentState: "candidate_ready",
      projectId: project.id,
      chapterId: chapter.id,
      candidateId: candidate.id,
      revision: 1,
      snapshot: Object.freeze({ previewSource: "provider" }),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    },
    {
      id: runtime.ids.next(),
      journeyId: candidate.id,
      sequence: 1,
      kind: "keep",
      questionKey: null,
      generationSource: "provider",
      providerId: null,
      modelId: null,
      taskKey: "opening_guidance",
      requestId: candidate.id,
      snapshot: Object.freeze({
        candidateId: candidate.id,
        decision: "ready",
        previewSource: "provider",
      }),
      createdAt: now,
    },
  );
}
