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

describe("TauriTaskCenterStore due task query", () => {
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
