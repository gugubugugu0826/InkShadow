import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Notification, Task, type Result, type TaskEngineError } from "@inkshadow/task-engine";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

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

    await user.click(screen.getByRole("button", { name: "取消任务" }));
    expect(await screen.findByText("已取消")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "通知 1" }));
    expect(await screen.findByRole("heading", { name: "后台任务执行失败" })).toBeInTheDocument();
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

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function expectOk<Value>(result: Result<Value, TaskEngineError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
