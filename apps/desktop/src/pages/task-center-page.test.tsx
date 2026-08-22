import { render, screen, waitFor, within } from "@testing-library/react";
import type { UuidV7 } from "@inkshadow/domain";
import userEvent from "@testing-library/user-event";
import {
  Notification,
  Task,
  createTaskFailure,
  type Result,
  type TaskEngineError,
} from "@inkshadow/task-engine";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { DEVELOPMENT_TASK_CENTER_KEY } from "../infrastructure/task-center-store";
import { RuntimeProvider } from "../runtime-context";

const INITIAL_TIME = "2026-07-26T00:00:00.000Z";

describe("TaskCenterPage", () => {
  it("shows durable task state, cancels queued work, and marks notifications read", async () => {
    seedTaskCenter();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime);

    expect(
      await screen.findByRole("heading", { name: "任务与通知", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "AI 章节生成" })).toBeInTheDocument();
    expect(screen.getByText("等待执行")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(uuid(1));

    await user.click(screen.getByRole("button", { name: "取消任务" }));
    expect(await screen.findByRole("dialog", { name: "确认取消任务" })).toBeVisible();
    expect(screen.getByText("取消不会删除已有项目内容")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认取消" }));
    expect(await screen.findByText("已取消")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "通知 1" }));
    expect(await screen.findByRole("heading", { name: "后台任务执行失败" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(uuid(2));
    await user.click(screen.getByRole("button", { name: "全部标为已读" }));

    await waitFor(() => {
      const summary = screen.getByLabelText("任务中心摘要");
      expect(within(summary).getByText("0 条未读")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "全部标为已读" })).toBeDisabled();

    const reopened = createDevelopmentRuntime(window.localStorage);
    const persisted = await reopened.taskCenter.load();
    expect(persisted.tasks[0]?.status).toBe("cancelled");
    expect(persisted.notifications[0]?.status).toBe("read");
  });

  it("retries the accepted正文 pipeline from its persisted metadata", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    const seeded = await seedRetryingAcceptedVersionTask(runtime);
    const currentChapter = await runtime.repositories.chapters.findById(seeded.chapterId);
    expect(currentChapter.ok && currentChapter.value?.currentVersionId).toBe(seeded.versionId);
    const findChapter = vi.spyOn(runtime.repositories.chapters, "findById");
    const findVersion = vi.spyOn(runtime.repositories.chapterVersions, "findVersionById");
    const startTask = vi.spyOn(runtime.taskCenter, "startTask");
    const summary = vi.spyOn(runtime.story.chapterSummaries, "summarizeSavedVersion");
    const storyState = vi.spyOn(runtime.story.continuousState, "extractSavedVersion");
    const causal = vi.spyOn(runtime.story.causalProjector, "rebuildProject");
    const user = userEvent.setup();
    renderRoute(runtime);

    expect(await screen.findByText("等待重试")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "立即重试后台整理" }));

    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(findChapter).toHaveBeenCalledWith(seeded.chapterId);
    expect(findVersion).toHaveBeenCalledWith(seeded.versionId);
    expect(startTask).toHaveBeenCalledWith(
      seeded.taskId,
      "desktop.accepted-version",
      expect.any(String),
      expect.any(String),
    );
    const factVerificationOrder = findVersion.mock.invocationCallOrder[0];
    const taskStartOrder = startTask.mock.invocationCallOrder[0];
    if (factVerificationOrder === undefined || taskStartOrder === undefined) {
      throw new Error("缺少事实预检或任务启动调用记录。");
    }
    expect(factVerificationOrder).toBeLessThan(taskStartOrder);
    await waitFor(async () => {
      const persisted = await runtime.taskCenter.load();
      expect(persisted.tasks.find(({ id }) => id === seeded.taskId)?.status).not.toBe("queued");
    });
    expect(summary).not.toHaveBeenCalled();
    expect(storyState).not.toHaveBeenCalled();
    expect(causal).not.toHaveBeenCalled();
  });

  it("shows the preserved cause after task retries are exhausted", async () => {
    seedRetryExhaustedTask();
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderRoute(runtime);

    expect(await screen.findByText("重试次数已用尽；底层原因：模型服务暂时不可用")).toBeVisible();
    expect(
      screen.queryByText(/TASK_RETRY_EXHAUSTED|PROVIDER_UNAVAILABLE/u),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("provider.internal.secret_step");
    expect(screen.getByText("正在处理后台步骤")).toBeVisible();
    expect(screen.getByRole("link", { name: "调整模型或上下文" })).toBeVisible();
  });

  it("explains accepted正文 changes in user language and links to confirmation", async () => {
    seedAcceptedVersionNotification();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime);

    await user.click(await screen.findByRole("tab", { name: "通知 1" }));
    expect(
      await screen.findByRole("heading", {
        name: "识别到 8 项变化，其中 1 项需要确认",
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "查看待确认设定" })).toHaveAttribute(
      "href",
      `/projects/${uuid(21)}/story`,
    );
    expect(screen.queryByText("story.accepted-version.completed")).not.toBeInTheDocument();
    expect(screen.getByText("整理已接受的正文")).toBeVisible();
    expect(document.body).not.toHaveTextContent(uuid(21));
    expect(document.body).not.toHaveTextContent(uuid(22));
    expect(document.body).not.toHaveTextContent(uuid(23));
    expect(document.body).not.toHaveTextContent(uuid(25));
    expect(screen.queryByText("MODEL_HUB_ROUTE_STALE")).not.toBeInTheDocument();
  });
});

function renderRoute(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function seedTaskCenter(): void {
  const task = expectOk(
    Task.create({
      id: uuid(1),
      type: "ai.generate",
      idempotencyKey: "generation:chapter:page-0001",
      metadata: { projectId: uuid(100), chapterId: uuid(101) },
      priority: 80,
      maxAttempts: 3,
      now: INITIAL_TIME,
    }),
  );
  const created = expectOk(
    Notification.create({
      id: uuid(2),
      dedupeKey: "notification:task-center:page-0001",
      messageKey: "task.failed",
      level: "inbox",
      severity: "error",
      route: { entityType: "task", entityId: task.id },
      metadata: { taskType: "ai.generate", attempt: 1, reasonCode: "UPSTREAM_TEMPORARY" },
      requiresResolution: false,
      expiresAt: null,
      now: INITIAL_TIME,
    }),
  );
  const queued = expectOk(created.queue("2026-07-27T00:00:00.500Z"));
  const visible = expectOk(queued.markVisible("2026-07-27T00:00:01.000Z"));

  window.localStorage.setItem(
    DEVELOPMENT_TASK_CENTER_KEY,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [task.toSnapshot()],
      notifications: [visible.toSnapshot()],
    }),
  );
}

async function seedRetryingAcceptedVersionTask(
  runtime: DesktopRuntime,
): Promise<Readonly<{ taskId: string; chapterId: UuidV7; versionId: UuidV7 }>> {
  const project = await runtime.useCases.createProject.execute({ name: "任务重试测试作品" });
  if (!project.ok) throw project.error;
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "林晚来到旧站台。",
  });
  if (!chapter.ok) throw chapter.error;
  const updatedContent = "林晚来到旧站台，远处钟声响起。";
  const edited = await runtime.useCases.editChapter.execute({
    chapterId: chapter.value.chapter.id,
    expectedRevision: chapter.value.chapter.revision,
    content: updatedContent,
    cursorOffset: updatedContent.length,
  });
  if (!edited.ok) throw edited.error;
  const saved = await runtime.useCases.saveChapter.execute({
    chapterId: chapter.value.chapter.id,
    expectedRevision: chapter.value.chapter.revision,
    reason: "manual",
    organizeLocalStoryFacts: true,
  });
  if (!saved.ok) throw saved.error;
  if (saved.value.version === null) throw new Error("没有生成用于重试的不可变版本。");
  const savedVersion = saved.value.version;
  const queued = (await runtime.taskCenter.load()).tasks.find(
    ({ metadata }) => metadata.versionId === savedVersion.id,
  );
  if (queued === undefined) throw new Error("没有生成用于重试的后台任务。");
  const leaseToken = uuid(14);
  await runtime.taskCenter.startTask(
    queued.id,
    "desktop.test",
    leaseToken,
    "2099-12-01T00:15:00.000Z",
  );
  await runtime.taskCenter.failTask(
    queued.id,
    leaseToken,
    {
      code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
      causeCode: "PIPELINE_STAGES_SEARCH",
      retryable: true,
      actions: ["RETRY", "OPEN_SETTINGS", "EXPORT_DIAGNOSTICS"],
      requestId: "req-task-center-page-retry",
    },
    "2099-12-01T00:00:00.000Z",
  );
  return Object.freeze({
    taskId: queued.id,
    chapterId: chapter.value.chapter.id,
    versionId: savedVersion.id,
  });
}

function seedAcceptedVersionNotification(): void {
  const created = expectOk(
    Notification.create({
      id: uuid(20),
      dedupeKey: "notification:accepted-version:test",
      messageKey: "story.accepted-version.completed",
      level: "inbox",
      severity: "success",
      route: { entityType: "task", entityId: uuid(24) },
      metadata: {
        taskType: "story.accepted-version.process",
        projectId: uuid(21),
        chapterId: uuid(22),
        versionId: uuid(23),
        pipelineStatus: "completed",
        detectedCount: 8,
        needsConfirmationCount: 1,
        connectionId: uuid(25),
        internalDebugCode: "MODEL_HUB_ROUTE_STALE",
      },
      requiresResolution: false,
      expiresAt: null,
      now: INITIAL_TIME,
    }),
  );
  const visible = expectOk(
    expectOk(created.queue("2026-07-26T00:00:00.500Z")).markVisible("2026-07-26T00:00:01.000Z"),
  );
  window.localStorage.setItem(
    DEVELOPMENT_TASK_CENTER_KEY,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [],
      notifications: [visible.toSnapshot()],
    }),
  );
}

function seedRetryExhaustedTask(): void {
  const queued = expectOk(
    Task.create({
      id: uuid(30),
      type: "ai.generate",
      idempotencyKey: "generation:retry-exhausted:0001",
      metadata: { projectId: uuid(32), chapterId: uuid(33) },
      priority: 80,
      maxAttempts: 1,
      now: INITIAL_TIME,
    }),
  );
  const running = expectOk(
    queued.claim({
      ownerId: "desktop.test",
      leaseToken: uuid(31),
      now: "2026-07-26T00:00:01.000Z",
      leaseExpiresAt: "2026-07-26T00:15:00.000Z",
    }),
  );
  const failure = expectOk(
    createTaskFailure({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      actions: ["RETRY", "SWITCH_MODEL"],
      requestId: "req-task-center-page-retry-exhausted",
    }),
  );
  const progressing = expectOk(
    running.reportProgress({
      leaseToken: uuid(31),
      step: "provider.internal.secret_step",
      completedUnits: 1,
      totalUnits: null,
      now: "2026-07-26T00:00:01.500Z",
    }),
  );
  const exhausted = expectOk(
    progressing.recordFailure({
      leaseToken: uuid(31),
      failure,
      now: "2026-07-26T00:00:02.000Z",
      retryAt: null,
    }),
  );
  window.localStorage.setItem(
    DEVELOPMENT_TASK_CENTER_KEY,
    JSON.stringify({
      schemaVersion: 1,
      tasks: [exhausted.toSnapshot()],
      notifications: [],
    }),
  );
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function expectOk<Value>(result: Result<Value, TaskEngineError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
