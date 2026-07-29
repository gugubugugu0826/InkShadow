import { readFileSync } from "node:fs";

import {
  Notification,
  Task,
  parseIsoUtcTimestamp,
  parseUuidV7,
  parseWorkerId,
  type Result,
  type TaskEngineError,
} from "@inkshadow/task-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteNotificationRepository,
  SqliteTaskRepository,
} from "../src/task-sqlite-repositories.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0002_tasks_notifications.sql", import.meta.url), "utf8"),
].join("\n");

const NOW = "2026-07-27T00:00:00.000Z";
const LATER = "2026-07-27T00:01:00.000Z";
const EXPIRED = "2026-07-27T00:02:00.000Z";

const IDS = {
  taskOne: "018f9f4a-b3c7-7350-9226-066f57e1e2a3",
  taskTwo: "018f9f4a-b3c7-7350-9226-066f57e1e2a4",
  taskThree: "018f9f4a-b3c7-7350-9226-066f57e1e2a5",
  leaseOne: "018f9f4a-b3c7-7350-9226-066f57e1e2b1",
  leaseTwo: "018f9f4a-b3c7-7350-9226-066f57e1e2b2",
  notificationOne: "018f9f4a-b3c7-7350-9226-066f57e1e2c1",
  notificationTwo: "018f9f4a-b3c7-7350-9226-066f57e1e2c2",
  route: "018f9f4a-b3c7-7350-9226-066f57e1e2d1",
} as const;

const workerId = unwrap(parseWorkerId("desktop-worker"));
const now = unwrap(parseIsoUtcTimestamp(NOW));
const later = unwrap(parseIsoUtcTimestamp(LATER));
const expiredAt = unwrap(parseIsoUtcTimestamp(EXPIRED));
const leaseOne = unwrap(parseUuidV7(IDS.leaseOne));
const leaseTwo = unwrap(parseUuidV7(IDS.leaseTwo));

describe("SQLite task repository", () => {
  let executor: NodeSqliteExecutor;
  let repository: SqliteTaskRepository;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    repository = new SqliteTaskRepository(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("deduplicates the same request and rejects changed semantics", async () => {
    const task = createTask({
      id: IDS.taskOne,
      idempotencyKey: "backup:project:alpha",
      priority: 20,
    });
    const first = unwrap(await repository.createIfAbsent(task));
    expect(first.created).toBe(true);

    const duplicate = createTask({
      id: IDS.taskTwo,
      idempotencyKey: "backup:project:alpha",
      priority: 20,
    });
    const second = unwrap(await repository.createIfAbsent(duplicate));
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(IDS.taskOne);

    const conflicting = createTask({
      id: IDS.taskThree,
      idempotencyKey: "backup:project:alpha",
      priority: 21,
    });
    const conflict = await repository.createIfAbsent(conflicting);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("TASK_IDEMPOTENCY_CONFLICT");
    }
  });

  it("claims the highest-priority due task and persists progress with CAS", async () => {
    const low = createTask({
      id: IDS.taskOne,
      idempotencyKey: "index:project:low",
      priority: 10,
    });
    const high = createTask({
      id: IDS.taskTwo,
      idempotencyKey: "index:project:high",
      priority: 90,
    });
    unwrap(await repository.createIfAbsent(low));
    unwrap(await repository.createIfAbsent(high));

    const claimed = unwrap(
      await repository.claimNext({
        ownerId: workerId,
        leaseToken: leaseOne,
        now,
        leaseExpiresAt: later,
      }),
    );
    expect(claimed?.id).toBe(IDS.taskTwo);
    expect(claimed?.status).toBe("running");
    expect(claimed?.sequence).toBe(2);

    const progressed = unwrap(
      claimed?.reportProgress({
        leaseToken: IDS.leaseOne,
        step: "writing.bundle",
        completedUnits: 1,
        totalUnits: 3,
        now: "2026-07-27T00:00:20.000Z",
      }) ?? failResult(),
    );
    unwrap(await repository.save(progressed, 2));

    const restored = unwrap(await repository.findById(IDS.taskTwo as never));
    expect(restored?.toSnapshot().progress).toMatchObject({
      step: "writing.bundle",
      completedUnits: 1,
      totalUnits: 3,
    });

    const stale = await repository.save(progressed, 2);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("TASK_SEQUENCE_CONFLICT");
    }
  });

  it("lists expired leases for restart recovery and ignores future leases", async () => {
    const first = createTask({
      id: IDS.taskOne,
      idempotencyKey: "recovery:task:first",
      priority: 20,
    });
    const second = createTask({
      id: IDS.taskTwo,
      idempotencyKey: "recovery:task:second",
      priority: 10,
    });
    unwrap(await repository.createIfAbsent(first));
    unwrap(await repository.createIfAbsent(second));

    unwrap(
      await repository.claimNext({
        ownerId: workerId,
        leaseToken: leaseOne,
        now,
        leaseExpiresAt: later,
      }),
    );
    unwrap(
      await repository.claimNext({
        ownerId: workerId,
        leaseToken: leaseTwo,
        now,
        leaseExpiresAt: "2026-07-27T00:03:00.000Z" as never,
      }),
    );

    const expired = unwrap(await repository.listExpiredLeases(expiredAt, 10));
    expect(expired.map(({ id }) => id)).toEqual([IDS.taskOne]);
  });
});

describe("SQLite notification repository", () => {
  let executor: NodeSqliteExecutor;
  let repository: SqliteNotificationRepository;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    repository = new SqliteNotificationRepository(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("deduplicates notifications and rejects changed semantics", async () => {
    const notification = createNotification({
      id: IDS.notificationOne,
      dedupeKey: "backup:completed:alpha",
      severity: "success",
    });
    expect(unwrap(await repository.createIfAbsent(notification)).created).toBe(true);

    const duplicate = createNotification({
      id: IDS.notificationTwo,
      dedupeKey: "backup:completed:alpha",
      severity: "success",
    });
    const deduplicated = unwrap(await repository.createIfAbsent(duplicate));
    expect(deduplicated.created).toBe(false);
    expect(deduplicated.notification.id).toBe(IDS.notificationOne);

    const conflicting = createNotification({
      id: IDS.notificationTwo,
      dedupeKey: "backup:completed:alpha",
      severity: "warning",
    });
    const conflict = await repository.createIfAbsent(conflicting);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("NOTIFICATION_DEDUPE_CONFLICT");
    }
  });

  it("persists lifecycle changes and lists only due notifications", async () => {
    const due = createNotification({
      id: IDS.notificationOne,
      dedupeKey: "task:finished:due",
      severity: "success",
      expiresAt: LATER,
    });
    const durable = createNotification({
      id: IDS.notificationTwo,
      dedupeKey: "task:failed:durable",
      severity: "error",
      expiresAt: null,
    });
    unwrap(await repository.createIfAbsent(due));
    unwrap(await repository.createIfAbsent(durable));

    const queued = unwrap(due.queue("2026-07-27T00:00:10.000Z"));
    unwrap(await repository.save(queued, 1));
    const visible = unwrap(queued.markVisible("2026-07-27T00:00:20.000Z"));
    unwrap(await repository.save(visible, 2));

    const dueNotifications = unwrap(await repository.listDueForExpiration(expiredAt, 10));
    expect(dueNotifications.map(({ id }) => id)).toEqual([IDS.notificationOne]);

    const restored = unwrap(await repository.findByDedupeKey("task:finished:due" as never));
    expect(restored?.status).toBe("visible");
    expect(restored?.sequence).toBe(3);
  });
});

function createTask(input: { id: string; idempotencyKey: string; priority: number }): Task {
  return unwrap(
    Task.create({
      id: input.id,
      type: "project_backup",
      idempotencyKey: input.idempotencyKey,
      metadata: { projectId: "project-alpha", generation: 1 },
      priority: input.priority,
      maxAttempts: 3,
      now: NOW,
    }),
  );
}

function createNotification(input: {
  id: string;
  dedupeKey: string;
  severity: "success" | "warning" | "error";
  expiresAt?: string | null;
}): Notification {
  return unwrap(
    Notification.create({
      id: input.id,
      dedupeKey: input.dedupeKey,
      messageKey: "task.finished",
      level: "inbox",
      severity: input.severity,
      route: {
        entityType: "project",
        entityId: IDS.route,
      },
      metadata: { projectId: "project-alpha" },
      requiresResolution: false,
      expiresAt: input.expiresAt === undefined ? "2026-07-28T00:00:00.000Z" : input.expiresAt,
      now: NOW,
    }),
  );
}

function unwrap<Value>(result: Result<Value, TaskEngineError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function failResult(): Result<never, TaskEngineError> {
  return {
    ok: false,
    error: new Error("Expected a claimed task.") as TaskEngineError,
  };
}
