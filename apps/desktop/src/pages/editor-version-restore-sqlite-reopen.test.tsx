import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CreateChapter,
  CreateProject,
  EditChapter,
  ListChapterVersions,
  RestoreChapterVersion,
  SaveChapter,
} from "@inkshadow/application";
import { createSqliteRepositories, type SqliteRepositories } from "@inkshadow/data";
import { RecoveryDraft, type UuidV7 } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { DesktopRoutes } from "../app";
import { AppErrorBoundary } from "../components/app-error-boundary";
import { ComponentOwnershipBoundary } from "../components/component-ownership-path";
import { DesktopPersistenceBoundary } from "../components/desktop-persistence-boundary";
import {
  createAcceptedVersionTaskFactory,
  createDevelopmentRuntime,
  type DesktopRuntime,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

it("restores a historical version, closes production SQLite, reopens it, and renders the exact正文", async () => {
  window.localStorage.clear();
  const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-version-restore-reopen-"));
  const databasePath = path.join(directory, "inkshadow.sqlite");
  let executor: NodeSqliteExecutor | null = null;
  let reopenedExecutor: NodeSqliteExecutor | null = null;
  try {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    executor = new NodeSqliteExecutor(readCurrentLocalSchema(), databasePath);
    const repositories = createSqliteRepositories(executor, {
      acceptedVersionTaskFactory: createAcceptedVersionTaskFactory(baseRuntime.ids),
    });
    const runtime = sqliteEditorRuntime(baseRuntime, repositories);
    const createdProject = await runtime.useCases.createProject.execute({
      name: "生产 SQLite 恢复重开测试",
    });
    if (!createdProject.ok) throw createdProject.error;
    const createdChapter = await runtime.useCases.createChapter.execute({
      projectId: createdProject.value.id,
      title: "第一章",
      content: "第一版稳定正文",
    });
    if (!createdChapter.ok) throw createdChapter.error;
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: createdChapter.value.chapter.id,
      expectedRevision: createdChapter.value.chapter.revision,
      content: "第二版稳定正文",
      cursorOffset: 7,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: createdChapter.value.chapter.id,
      expectedRevision: createdChapter.value.chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    if (saved.value.version === null) throw new Error("手动保存没有创建不可变版本。");
    const savedVersion = saved.value.version;
    const beforeRestore = await runtime.useCases.listChapterVersions.execute(
      createdChapter.value.chapter.id,
    );
    if (!beforeRestore.ok) throw beforeRestore.error;
    const firstVersion = beforeRestore.value.find((version) => version.sequence === 1);
    if (firstVersion === undefined) throw new Error("没有找到第一版不可变正文。");
    const olderDraft = RecoveryDraft.create({
      id: runtime.ids.next(),
      projectId: createdProject.value.id,
      chapterId: createdChapter.value.chapter.id,
      baseRevision: saved.value.chapter.revision,
      content: "恢复操作前留下的本地草稿",
      cursorOffset: 6,
      now: runtime.clock.now(),
    });
    if (!olderDraft.ok) throw olderDraft.error;
    const draftStored = await repositories.recoveryDrafts.upsert(olderDraft.value);
    if (!draftStored.ok) throw draftStored.error;
    const restored = await runtime.useCases.restoreChapterVersion.execute({
      chapterId: createdChapter.value.chapter.id,
      versionId: firstVersion.id,
      expectedRevision: saved.value.chapter.revision,
      organizeLocalStoryFacts: false,
    });
    if (!restored.ok) throw restored.error;
    const summaryBeforeRestart = await authoritySummary(repositories, restored.value.chapter.id);

    await executor.close();
    executor = null;
    reopenedExecutor = new NodeSqliteExecutor("PRAGMA foreign_keys = ON;", databasePath);
    const reopenedRepositories = createSqliteRepositories(reopenedExecutor, {
      acceptedVersionTaskFactory: createAcceptedVersionTaskFactory(baseRuntime.ids),
    });
    const reopenedRuntime = sqliteEditorRuntime(baseRuntime, reopenedRepositories);

    renderEditor(reopenedRuntime, createdProject.value.id, restored.value.chapter.id);

    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue("第一版稳定正文");
    const recoveryDialog = await screen.findByRole("dialog", { name: "发现未完成的本地草稿" });
    expect(recoveryDialog).toHaveTextContent("恢复操作前留下的本地草稿");
    expect(recoveryDialog).toHaveTextContent("第一版稳定正文");
    expect(await authoritySummary(reopenedRepositories, restored.value.chapter.id)).toEqual(
      summaryBeforeRestart,
    );
    const reopenedVersions = await reopenedRuntime.useCases.listChapterVersions.execute(
      restored.value.chapter.id,
    );
    if (!reopenedVersions.ok) throw reopenedVersions.error;
    expect(
      reopenedVersions.value.map((version) => {
        const snapshot = version.toSnapshot();
        return {
          sequence: snapshot.sequence,
          parentVersionId: snapshot.parentVersionId,
          reason: snapshot.reason,
        };
      }),
    ).toEqual([
      {
        sequence: 3,
        parentVersionId: savedVersion.id,
        reason: "recovery",
      },
      {
        sequence: 2,
        parentVersionId: createdChapter.value.version.id,
        reason: "manual",
      },
      {
        sequence: 1,
        parentVersionId: null,
        reason: "created",
      },
    ]);
  } finally {
    await executor?.close().catch(() => undefined);
    await reopenedExecutor?.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

function sqliteEditorRuntime(
  baseRuntime: DesktopRuntime,
  repositories: SqliteRepositories,
): DesktopRuntime {
  return Object.freeze({
    ...baseRuntime,
    repositories,
    useCases: Object.freeze({
      ...baseRuntime.useCases,
      createProject: new CreateProject(repositories.projects, baseRuntime.ids, baseRuntime.clock),
      createChapter: new CreateChapter(
        repositories.projects,
        repositories.contentCommits,
        baseRuntime.ids,
        baseRuntime.clock,
        baseRuntime.hasher,
        repositories.chapters,
        repositories.chapterVersions,
      ),
      editChapter: new EditChapter(
        repositories.chapters,
        repositories.recoveryDrafts,
        baseRuntime.ids,
        baseRuntime.clock,
      ),
      saveChapter: new SaveChapter(
        repositories.chapters,
        repositories.recoveryDrafts,
        repositories.contentCommits,
        baseRuntime.ids,
        baseRuntime.clock,
        baseRuntime.hasher,
      ),
      listChapterVersions: new ListChapterVersions(repositories.chapterVersions),
      restoreChapterVersion: new RestoreChapterVersion(
        repositories.chapters,
        repositories.chapterVersions,
        repositories.contentCommits,
        baseRuntime.ids,
        baseRuntime.clock,
        baseRuntime.hasher,
      ),
    }),
  });
}

function renderEditor(runtime: DesktopRuntime, projectId: string, chapterId: string): void {
  render(
    <MemoryRouter initialEntries={[`/projects/${projectId}/chapters/${chapterId}`]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <ComponentOwnershipBoundary name="VersionRestoreSqliteReopenTestHost">
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

async function authoritySummary(repositories: SqliteRepositories, chapterId: UuidV7) {
  const chapter = await repositories.chapters.findById(chapterId);
  if (!chapter.ok || chapter.value === null) {
    throw chapter.ok ? new Error("重开后章节不存在。") : chapter.error;
  }
  const versions = await repositories.chapterVersions.listByChapterId(chapter.value.id);
  if (!versions.ok) throw versions.error;
  const recoveryDraft = await repositories.recoveryDrafts.findByChapterId(chapter.value.id);
  if (!recoveryDraft.ok) throw recoveryDraft.error;
  return Object.freeze({
    chapter: chapter.value.toSnapshot(),
    versions: versions.value.map((version) => version.toSnapshot()),
    recoveryDraft: recoveryDraft.value?.toSnapshot() ?? null,
  });
}

function readCurrentLocalSchema(): string {
  const workspaceRoot = findWorkspaceRoot();
  const dataDirectory = path.join(workspaceRoot, "packages", "data", "migrations");
  const sql: string[] = [];
  for (const fileName of readdirSync(dataDirectory)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort()) {
    sql.push(readFileSync(path.join(dataDirectory, fileName), "utf8"));
    if (fileName === "0002_tasks_notifications.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0001_story_core.sql"),
          "utf8",
        ),
      );
    }
    if (fileName === "0004_model_profiles.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0002_materials.sql"),
          "utf8",
        ),
      );
    }
    if (fileName === "0020_graph_rag_projection.sql") {
      sql.push(
        readFileSync(
          path.join(workspaceRoot, "packages", "story-core", "migrations", "0003_ideation.sql"),
          "utf8",
        ),
      );
    }
  }
  return sql.join("\n");
}

function findWorkspaceRoot(): string {
  let current = path.resolve(process.cwd());
  while (!existsSync(path.join(current, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("找不到 InkShadow 工作区根目录。");
    current = parent;
  }
  return current;
}
