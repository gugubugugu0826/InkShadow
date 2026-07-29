import { Notification, Task, type Result, type TaskEngineError } from "@inkshadow/task-engine";
import { describe, expect, it } from "vitest";

import {
  BrowserDevelopmentTaskCenterStore,
  DEVELOPMENT_TASK_CENTER_KEY,
} from "./task-center-store";

const INITIAL_TIME = "2026-07-26T00:00:00.000Z";
const ACTION_TIME = "2026-07-27T00:01:00.000Z";

describe("BrowserDevelopmentTaskCenterStore", () => {
  it("persists cancellation and notification read transitions across reloads", async () => {
    seedTaskCenter();
    const store = new BrowserDevelopmentTaskCenterStore(window.localStorage, {
      now: () => ACTION_TIME,
    });

    const initial = await store.load();
    expect(initial.tasks[0]?.status).toBe("queued");
    expect(initial.notifications[0]?.status).toBe("visible");

    const cancelled = await store.cancelTask(uuid(1));
    const read = await store.markNotificationRead(uuid(2));

    expect(cancelled.status).toBe("cancelled");
    expect(read.status).toBe("read");

    const reopened = new BrowserDevelopmentTaskCenterStore(window.localStorage, {
      now: () => ACTION_TIME,
    });
    await expect(reopened.load()).resolves.toMatchObject({
      tasks: [{ status: "cancelled" }],
      notifications: [{ status: "read" }],
    });
  });

  it("marks every eligible notification as read without changing read items again", async () => {
    const task = makeTask();
    const first = makeVisibleNotification(2, "task.completed");
    const second = makeVisibleNotification(3, "task.failed");
    const alreadyRead = expectOk(second.markRead("2026-07-27T00:00:02.000Z"));
    writeDatabase([task.toSnapshot()], [first.toSnapshot(), alreadyRead.toSnapshot()]);
    const store = new BrowserDevelopmentTaskCenterStore(window.localStorage, {
      now: () => ACTION_TIME,
    });

    await expect(store.markAllNotificationsRead()).resolves.toBe(1);
    const result = await store.load();
    expect(result.notifications.map(({ status }) => status)).toEqual(["read", "read"]);
  });

  it("runs an idempotent generation task through progress and cancellation acknowledgement", async () => {
    const store = new BrowserDevelopmentTaskCenterStore(window.localStorage, {
      now: () => ACTION_TIME,
    });
    const input = {
      id: uuid(10),
      type: "ai.generate",
      idempotencyKey: "generation:chapter:governed-0001",
      metadata: {
        projectId: uuid(100),
        chapterId: uuid(101),
        modelId: "gpt-test",
      },
      priority: 80,
      maxAttempts: 3,
      now: ACTION_TIME,
    } as const;

    await expect(store.enqueueTask(input)).resolves.toMatchObject({ created: true });
    await expect(store.enqueueTask({ ...input, id: uuid(11) })).resolves.toMatchObject({
      created: false,
      task: { id: uuid(10) },
    });
    await expect(
      store.startTask(uuid(10), "desktop.foreground", uuid(12), "2026-07-27T00:16:00.000Z"),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      store.reportTaskProgress(uuid(10), uuid(12), "model.generating", 2, 5),
    ).resolves.toMatchObject({
      progress: { step: "model.generating", completedUnits: 2, totalUnits: 5 },
    });
    await expect(store.cancelTask(uuid(10))).resolves.toMatchObject({
      status: "running",
      cancelRequestedAt: ACTION_TIME,
    });
    await expect(store.acknowledgeTaskCancellation(uuid(10), uuid(12))).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("recovers an expired foreground lease back to the pending queue", async () => {
    let now = ACTION_TIME;
    const store = new BrowserDevelopmentTaskCenterStore(window.localStorage, {
      now: () => now,
    });
    await store.enqueueTask({
      id: uuid(20),
      type: "ai.generate",
      idempotencyKey: "generation:chapter:recovery-0001",
      metadata: { chapterId: uuid(101) },
      priority: 80,
      maxAttempts: 3,
      now,
    });
    await store.startTask(uuid(20), "desktop.foreground", uuid(21), "2026-07-27T00:02:00.000Z");
    now = "2026-07-27T00:03:00.000Z";

    await expect(store.load()).resolves.toMatchObject({
      tasks: [{ id: uuid(20), status: "queued", lease: null }],
    });
  });

  it("publishes a deduplicated visible inbox notification", async () => {
    const store = new BrowserDevelopmentTaskCenterStore(window.localStorage, {
      now: () => ACTION_TIME,
    });
    const input = {
      id: uuid(30),
      dedupeKey: "notification:generation:completed-0001",
      messageKey: "task.completed",
      level: "inbox",
      severity: "success",
      route: { entityType: "task", entityId: uuid(10) },
      metadata: { taskType: "ai.generate", attempt: 1 },
      requiresResolution: false,
      expiresAt: null,
      now: ACTION_TIME,
    } as const;

    await expect(store.publishNotification(input)).resolves.toMatchObject({
      status: "visible",
      messageKey: "task.completed",
    });
    await expect(store.publishNotification({ ...input, id: uuid(31) })).resolves.toMatchObject({
      id: uuid(30),
      status: "visible",
    });
    await expect(store.load()).resolves.toMatchObject({
      notifications: [{ id: uuid(30), status: "visible" }],
    });
  });

  it("rejects corrupt local data instead of silently discarding task history", async () => {
    window.localStorage.setItem(
      DEVELOPMENT_TASK_CENTER_KEY,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [{ status: "made-up" }],
        notifications: [],
      }),
    );
    const store = new BrowserDevelopmentTaskCenterStore(window.localStorage, {
      now: () => ACTION_TIME,
    });

    await expect(store.load()).rejects.toMatchObject({
      code: "TASK_INVALID_UUID",
    });
  });
});

function seedTaskCenter(): void {
  writeDatabase([makeTask().toSnapshot()], [makeVisibleNotification(2).toSnapshot()]);
}

function writeDatabase(
  tasks: readonly ReturnType<Task["toSnapshot"]>[],
  notifications: readonly ReturnType<Notification["toSnapshot"]>[],
): void {
  window.localStorage.setItem(
    DEVELOPMENT_TASK_CENTER_KEY,
    JSON.stringify({
      schemaVersion: 1,
      tasks,
      notifications,
    }),
  );
}

function makeTask(): Task {
  return expectOk(
    Task.create({
      id: uuid(1),
      type: "ai.generate",
      idempotencyKey: "generation:chapter:task-center-0001",
      metadata: {
        projectId: uuid(100),
        chapterId: uuid(101),
      },
      priority: 80,
      maxAttempts: 3,
      now: INITIAL_TIME,
    }),
  );
}

function makeVisibleNotification(sequence: number, messageKey = "task.completed"): Notification {
  const created = expectOk(
    Notification.create({
      id: uuid(sequence),
      dedupeKey: `notification:task-center:${String(sequence).padStart(4, "0")}`,
      messageKey,
      level: "inbox",
      severity: messageKey === "task.failed" ? "error" : "success",
      route: { entityType: "task", entityId: uuid(1) },
      metadata: { taskType: "ai.generate", attempt: 1 },
      requiresResolution: false,
      expiresAt: null,
      now: INITIAL_TIME,
    }),
  );
  const queued = expectOk(created.queue("2026-07-27T00:00:00.500Z"));
  return expectOk(queued.markVisible("2026-07-27T00:00:01.000Z"));
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
