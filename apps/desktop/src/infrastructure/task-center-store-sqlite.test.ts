import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { TauriTaskCenterStore } from "./task-center-store";

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0002_tasks_notifications.sql"),
].join("\n");

const CREATED_AT = "2026-08-08T00:00:00.000Z";
const NEWER_AT = "2026-08-08T00:00:10.000Z";
const NOW = "2026-08-08T00:00:32.000Z";
const RETRY_AT = "2026-08-08T00:00:31.000Z";

describe("TauriTaskCenterStore", () => {
  it("dismisses read notifications from the inbox without deleting their SQLite audit rows", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriTaskCenterStore(executor, { now: () => NOW });

    try {
      const first = await store.publishNotification(notificationInput(301, "task.completed"));
      const second = await store.publishNotification(notificationInput(302, "task.failed"));
      await store.markNotificationRead(second.id);

      await expect(store.dismissAllReadNotifications()).resolves.toBe(1);
      await expect(store.load()).resolves.toMatchObject({
        notifications: [{ id: first.id, status: "visible" }],
      });
      await expect(
        executor.select<{ readonly id: string; readonly status: string }>(
          "SELECT id, status FROM notifications ORDER BY id ASC",
        ),
      ).resolves.toEqual([
        { id: first.id, status: "visible" },
        { id: second.id, status: "dismissed" },
      ]);
    } finally {
      await executor.close();
    }
  });

  it("dismisses every read notification even when the durable inbox exceeds the visible limit", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriTaskCenterStore(executor, { now: () => NOW });

    try {
      for (let index = 0; index < 201; index += 1) {
        const notification = await store.publishNotification(
          notificationInput(400 + index, "task.completed"),
        );
        await store.markNotificationRead(notification.id);
      }

      await expect(store.dismissAllReadNotifications()).resolves.toBe(201);
      await expect(
        executor.select<{ readonly status: string; readonly count: number }>(
          "SELECT status, COUNT(*) AS count FROM notifications GROUP BY status",
        ),
      ).resolves.toEqual([{ status: "dismissed", count: 201 }]);
    } finally {
      await executor.close();
    }
  });

  it("marks every unread notification in one action when the durable inbox exceeds the visible limit", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriTaskCenterStore(executor, { now: () => NOW });

    try {
      for (let index = 0; index < 201; index += 1) {
        await store.publishNotification(notificationInput(1_000 + index, "task.completed"));
      }

      await expect(store.markAllNotificationsRead()).resolves.toBe(201);
      await expect(
        executor.select<{ readonly status: string; readonly count: number }>(
          "SELECT status, COUNT(*) AS count FROM notifications GROUP BY status",
        ),
      ).resolves.toEqual([{ status: "read", count: 201 }]);
    } finally {
      await executor.close();
    }
  });

  it("reports an older read notification when the newest visible page contains only unread items", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriTaskCenterStore(executor, { now: () => NOW });

    try {
      const olderRead = await store.publishNotification(notificationInput(700, "task.completed"));
      await store.markNotificationRead(olderRead.id);
      for (let index = 0; index < 200; index += 1) {
        await store.publishNotification(notificationInput(701 + index, "task.completed"));
      }

      const snapshot = await store.load();
      expect(snapshot.notifications).toHaveLength(200);
      expect(snapshot.notifications.every(({ status }) => status === "visible")).toBe(true);
      expect(snapshot.notifications.some(({ id }) => id === olderRead.id)).toBe(false);
      expect(snapshot.hasReadNotifications).toBe(true);

      await expect(store.dismissAllReadNotifications()).resolves.toBe(1);
      await expect(store.load()).resolves.toMatchObject({ hasReadNotifications: false });
    } finally {
      await executor.close();
    }
  });

  it("finds an old due worker task independently from the newest-first UI limit", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriTaskCenterStore(executor, { now: () => NOW });
    const durableTask = acceptedTask(1, 101, CREATED_AT);
    const laterDurableTask = acceptedTask(2, 102, "2026-08-08T00:00:01.000Z");

    try {
      await store.enqueueTask(durableTask);
      await store.enqueueTask(laterDurableTask);
      for (let index = 0; index < 205; index += 1) {
        await store.enqueueTask({
          id: uuid(1_000 + index),
          type: "maintenance.unrelated",
          idempotencyKey: `maintenance.unrelated:${String(index).padStart(4, "0")}`,
          metadata: { operation: "unrelated" },
          priority: 50,
          maxAttempts: 1,
          now: NEWER_AT,
        });
      }

      const uiSnapshot = await store.load();
      expect(uiSnapshot.tasks).toHaveLength(200);
      expect(uiSnapshot.tasks.some(({ id }) => id === durableTask.id)).toBe(false);
      const firstPage = await store.listDueTasks({
        taskType: "story.accepted-version.process",
        metadataOperation: "rebuild-derived-story-state",
        now: NOW,
        queuedUpdatedAtOrBefore: "2026-08-08T00:00:01.000Z",
        after: null,
        limit: 1,
      });
      expect(firstPage).toMatchObject([{ id: durableTask.id, status: "queued" }]);
      const first = firstPage[0];
      if (first?.runAfter == null) {
        throw new Error("Expected the first due task page.");
      }
      await expect(
        store.listDueTasks({
          taskType: "story.accepted-version.process",
          metadataOperation: "rebuild-derived-story-state",
          now: NOW,
          queuedUpdatedAtOrBefore: "2026-08-08T00:00:01.000Z",
          after: { runAfter: first.runAfter, createdAt: first.createdAt, id: first.id },
          limit: 1,
        }),
      ).resolves.toMatchObject([{ id: laterDurableTask.id, status: "queued" }]);
    } finally {
      await executor.close();
    }
  });

  it("includes legal due retries but excludes fresh queued and future work", async () => {
    const executor = new NodeSqliteExecutor(migration);
    let clockNow = "2026-08-08T00:00:30.000Z";
    const store = new TauriTaskCenterStore(executor, { now: () => clockNow });
    const retryTask = acceptedTask(10, 110, CREATED_AT);

    try {
      await store.enqueueTask(retryTask);
      await store.startTask(retryTask.id, "desktop.test", uuid(20), "2026-08-08T00:10:00.000Z");
      await store.failTask(
        retryTask.id,
        uuid(20),
        {
          code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
          retryable: true,
          actions: ["RETRY"],
          requestId: "req-due-task-query",
        },
        RETRY_AT,
      );
      const freshTask = acceptedTask(11, 111, "2026-08-08T00:00:30.000Z");
      const futureTask = {
        ...acceptedTask(12, 112, CREATED_AT),
        runAfter: "2026-08-08T00:05:00.000Z",
      };
      await store.enqueueTask(freshTask);
      await store.enqueueTask(futureTask);
      clockNow = NOW;

      await expect(
        store.listDueTasks({
          taskType: "story.accepted-version.process",
          metadataOperation: "rebuild-derived-story-state",
          now: NOW,
          queuedUpdatedAtOrBefore: "2026-08-08T00:00:01.000Z",
          after: null,
          limit: 200,
        }),
      ).resolves.toMatchObject([{ id: retryTask.id, status: "waiting_retry" }]);
    } finally {
      await executor.close();
    }
  });
});

function notificationInput(sequence: number, messageKey: string) {
  return {
    id: uuid(sequence),
    dedupeKey: `notification:sqlite:${String(sequence).padStart(4, "0")}`,
    messageKey,
    level: "inbox",
    severity: messageKey === "task.failed" ? ("error" as const) : ("success" as const),
    route: { entityType: "task", entityId: uuid(sequence + 100) },
    metadata: { taskType: "ai.generate", attempt: 1 },
    requiresResolution: false,
    expiresAt: null,
    now: CREATED_AT,
  } as const;
}

function acceptedTask(sequence: number, versionSequence: number, now: string) {
  return {
    id: uuid(sequence),
    type: "story.accepted-version.process",
    idempotencyKey: `story.accepted-version:${uuid(versionSequence)}`,
    metadata: {
      projectId: uuid(201),
      chapterId: uuid(202),
      versionId: uuid(versionSequence),
      source: "candidate_accept",
      acceptedCharacterCount: 128,
      operation: "rebuild-derived-story-state",
    },
    priority: 75,
    maxAttempts: 3,
    now,
  } as const;
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
