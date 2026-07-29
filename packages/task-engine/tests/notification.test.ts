import { NotificationService, type TaskEngineError, type Result } from "../src/index.js";
import { describe, expect, it } from "vitest";

import {
  InMemoryNotificationRepository,
  ManualClock,
  SequenceUuidV7Generator,
  timestamp,
  uuid,
} from "./fakes.js";

describe("NotificationService", () => {
  it("atomically deduplicates notifications and rejects semantic key reuse", async () => {
    const harness = createHarness();
    const command = notificationCommand();

    const [left, right] = await Promise.all([
      harness.service.publish(command),
      harness.service.publish(command),
    ]);
    const notifications = [expectOk(left), expectOk(right)];
    expect(notifications.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(notifications[0]?.notification.id).toBe(notifications[1]?.notification.id);

    expectErrorCode(
      await harness.service.publish({
        ...command,
        messageKey: "task.failed",
      }),
      "NOTIFICATION_DEDUPE_CONFLICT",
    );
  });

  it("enforces created, queued, visible, read, dismissed, and expired transitions", async () => {
    const harness = createHarness();
    const created = expectOk(await harness.service.publish(notificationCommand())).notification;

    expectErrorCode(await harness.service.markRead(created.id), "NOTIFICATION_INVALID_TRANSITION");
    const queued = expectOk(await harness.service.queue(created.id));
    const visible = expectOk(await harness.service.markVisible(created.id));
    harness.clock.set(timestamp(1));
    const read = expectOk(await harness.service.markRead(created.id));
    harness.clock.set(timestamp(2));
    const dismissed = expectOk(await harness.service.dismiss(created.id));

    expect(queued.sequence).toBe(2);
    expect(visible.sequence).toBe(3);
    expect(read.sequence).toBe(4);
    expect(dismissed.toSnapshot()).toMatchObject({
      status: "dismissed",
      sequence: 5,
      visibleAt: timestamp(0),
      readAt: timestamp(1),
      dismissedAt: timestamp(2),
    });

    expect(expectOk(await harness.service.expireDue()).expired).toBe(0);
    harness.clock.set(timestamp(10));
    expect(expectOk(await harness.service.expireDue())).toEqual({
      expired: 1,
      conflicts: 0,
      retained: 0,
    });
    const expired = expectPresent(
      expectOk(await harness.service.findByDedupeKey(notificationCommand().dedupeKey)),
    );
    expect(expired.toSnapshot()).toMatchObject({
      status: "expired",
      sequence: 6,
      expiredAt: timestamp(10),
    });
  });

  it("does not auto-expire blocking or unresolved notifications", async () => {
    const harness = createHarness();
    expectErrorCode(
      await harness.service.publish({
        ...notificationCommand(),
        dedupeKey: "notification:blocking:0001",
        level: "blocking",
        expiresAt: timestamp(10),
      }),
      "TASK_VALIDATION_FAILED",
    );

    const unresolved = expectOk(
      await harness.service.publish({
        ...notificationCommand(),
        dedupeKey: "notification:unresolved:0001",
        level: "inbox",
        severity: "error",
        requiresResolution: true,
        expiresAt: null,
      }),
    ).notification;
    expectOk(await harness.service.queue(unresolved.id));
    const visible = expectOk(await harness.service.markVisible(unresolved.id));
    expectErrorCode(visible.expire(timestamp(60)), "NOTIFICATION_INVALID_TRANSITION");
  });

  it("rejects sensitive notification interpolation metadata", async () => {
    const harness = createHarness();
    for (const metadata of [
      { body: "正文片段" },
      { prompt: "system instructions" },
      { apiKey: "not-allowed" },
      { reference: "Bearer private-token-value" },
    ]) {
      expectErrorCode(
        await harness.service.publish({
          ...notificationCommand(),
          dedupeKey: `notification:unsafe:${String(Object.keys(metadata)[0])}`,
          metadata,
        }),
        "TASK_SENSITIVE_DATA_REJECTED",
      );
    }
  });
});

function createHarness(): {
  clock: ManualClock;
  service: NotificationService;
} {
  const clock = new ManualClock(timestamp(0));
  return {
    clock,
    service: new NotificationService({
      notifications: new InMemoryNotificationRepository(),
      clock,
      ids: new SequenceUuidV7Generator(),
    }),
  };
}

function notificationCommand() {
  return {
    dedupeKey: "notification:task-complete:0001",
    messageKey: "task.completed",
    level: "inbox" as const,
    severity: "success" as const,
    route: {
      entityType: "task",
      entityId: uuid(500),
    },
    metadata: {
      taskType: "ai.generate",
      attempt: 1,
    },
    requiresResolution: false,
    expiresAt: timestamp(10),
  };
}

function expectOk<Value>(result: Result<Value, TaskEngineError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function expectErrorCode(result: Result<unknown, TaskEngineError>, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected ${code}.`);
  }
  expect(result.error.code).toBe(code);
}

function expectPresent<Value>(value: Value | null): Value {
  expect(value).not.toBeNull();
  if (value === null) {
    throw new Error("Expected a value.");
  }
  return value;
}
