import {
  ExponentialBackoffPolicy,
  type TaskEngineError,
  TaskScheduler,
  type Result,
  type TaskLogEvent,
  type TaskLogSink,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

import {
  InMemoryTaskRepository,
  ManualClock,
  SequenceUuidV7Generator,
  timestamp,
} from "./fakes.js";

describe("TaskScheduler", () => {
  it("atomically allows only one worker to claim a task", async () => {
    const harness = createHarness();
    expectOk(
      await harness.scheduler.enqueue({
        type: "ai.generate",
        idempotencyKey: "generation:claim:0001",
        metadata: { inputRef: "chapter-version:1" },
      }),
    );

    const [first, second] = await Promise.all([
      harness.scheduler.claimNext("worker:first"),
      harness.scheduler.claimNext("worker:second"),
    ]);
    const claims = [expectOk(first), expectOk(second)].filter((task) => task !== null);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe("running");
    expect([first, second].filter((result) => result.ok && result.value === null)).toHaveLength(1);
  });

  it("recovers an expired crash lease without resetting persisted attempt", async () => {
    const harness = createHarness();
    const created = expectOk(
      await harness.scheduler.enqueue({
        type: "backup.project",
        idempotencyKey: "backup:crash:0001",
        metadata: { projectId: "project-ref:1" },
      }),
    );
    const firstClaim = expectPresent(expectOk(await harness.scheduler.claimNext("worker:crashed")));
    expect(firstClaim.attempt).toBe(1);

    harness.clock.advance(60_001);
    const recovered = expectOk(await harness.scheduler.recoverExpiredLeases());
    expect(recovered).toEqual({
      recovered: 1,
      cancelled: 0,
      conflicts: 0,
    });
    const queued = expectPresent(harness.tasks.get(created.task.id));
    expect(queued.toSnapshot()).toMatchObject({
      status: "queued",
      attempt: 1,
      lease: null,
    });

    const secondClaim = expectPresent(
      expectOk(await harness.scheduler.claimNext("worker:recovery")),
    );
    expect(secondClaim.toSnapshot()).toMatchObject({
      status: "running",
      attempt: 1,
      lease: { ownerId: "worker:recovery" },
    });
  });

  it("deduplicates concurrent enqueue and rejects key reuse with different input", async () => {
    const harness = createHarness();
    const command = {
      type: "index.project",
      idempotencyKey: "index:project:0001",
      metadata: { projectId: "project-ref:1" },
      priority: 25,
      maxAttempts: 4,
    } as const;

    const [left, right] = await Promise.all([
      harness.scheduler.enqueue(command),
      harness.scheduler.enqueue(command),
    ]);
    const results = [expectOk(left), expectOk(right)];
    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(results[0]?.task.id).toBe(results[1]?.task.id);

    expectErrorCode(
      await harness.scheduler.enqueue({
        ...command,
        metadata: { projectId: "project-ref:2" },
      }),
      "TASK_IDEMPOTENCY_CONFLICT",
    );
  });

  it("applies deterministic retry delay and stops at maxAttempts", async () => {
    const harness = createHarness();
    const created = expectOk(
      await harness.scheduler.enqueue({
        type: "ai.generate",
        idempotencyKey: "generation:retry:0001",
        metadata: { inputRef: "chapter-version:1" },
        maxAttempts: 2,
      }),
    );
    const firstRun = expectPresent(expectOk(await harness.scheduler.claimNext("worker:primary")));
    const firstLease = expectPresent(firstRun.lease);

    const waiting = expectOk(
      await harness.scheduler.fail(created.task.id, firstLease.token, {
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
        actions: ["RETRY", "SWITCH_MODEL"],
        requestId: "req-retry-0001",
      }),
    );
    expect(waiting.toSnapshot()).toMatchObject({
      status: "waiting_retry",
      attempt: 2,
      runAfter: new Date(Date.parse(timestamp(0)) + 1_000).toISOString(),
    });
    expect(expectOk(await harness.scheduler.claimNext("worker:too-early"))).toBeNull();

    harness.clock.advance(1_000);
    const secondRun = expectPresent(expectOk(await harness.scheduler.claimNext("worker:retry")));
    const secondLease = expectPresent(secondRun.lease);
    const failed = expectOk(
      await harness.scheduler.fail(created.task.id, secondLease.token, {
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
        actions: ["RETRY", "SWITCH_MODEL"],
        requestId: "req-retry-0002",
      }),
    );

    expect(failed.toSnapshot()).toMatchObject({
      status: "failed",
      attempt: 2,
      failure: {
        code: "TASK_RETRY_EXHAUSTED",
        causeCode: "PROVIDER_UNAVAILABLE",
        retryable: false,
        actions: ["SWITCH_MODEL"],
      },
    });
  });

  it("resolves completion versus cancellation with repository sequence CAS", async () => {
    const harness = createHarness();
    const created = expectOk(
      await harness.scheduler.enqueue({
        type: "export.project",
        idempotencyKey: "export:cancel-race:0001",
        metadata: { projectId: "project-ref:1" },
      }),
    );
    const running = expectPresent(expectOk(await harness.scheduler.claimNext("worker:export")));
    const lease = expectPresent(running.lease);

    harness.tasks.beforeNextSave = (repository, candidate) => {
      repository.mutateStored(candidate.id, (stored) =>
        expectOk(stored.requestCancellation(harness.clock.now())),
      );
    };
    expectErrorCode(
      await harness.scheduler.complete(created.task.id, lease.token),
      "TASK_SEQUENCE_CONFLICT",
    );

    const cancelling = expectPresent(harness.tasks.get(created.task.id));
    expect(cancelling.toSnapshot()).toMatchObject({
      status: "running",
      cancelRequestedAt: timestamp(0),
    });

    const cancelled = expectOk(
      await harness.scheduler.acknowledgeCancellation(created.task.id, lease.token),
    );
    expect(cancelled.status).toBe("cancelled");
  });

  it("never logs metadata and rejects content, prompts, and secrets before persistence", async () => {
    const harness = createHarness();

    for (const metadata of [
      { content: "用户正文" },
      { prompt: "完整 prompt" },
      { secret: "credential" },
      { alias: "sk-supersecret123" },
    ]) {
      expectErrorCode(
        await harness.scheduler.enqueue({
          type: "ai.generate",
          idempotencyKey: `safe:reject:${String(Object.keys(metadata)[0]).padEnd(8, "0")}`,
          metadata,
        }),
        "TASK_SENSITIVE_DATA_REJECTED",
      );
    }
    expect(harness.logs.events).toEqual([]);

    const created = expectOk(
      await harness.scheduler.enqueue({
        type: "ai.generate",
        idempotencyKey: "safe:logging:0001",
        metadata: {
          projectId: "project-ref:1",
          inputRef: "chapter-version:1",
        },
      }),
    );
    expectPresent(expectOk(await harness.scheduler.claimNext("worker:safe")));

    const serialized = JSON.stringify(harness.logs.events);
    expect(serialized).not.toContain("metadata");
    expect(serialized).not.toContain("inputRef");
    expect(serialized).not.toContain("chapter-version:1");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("secret");
    expect(serialized).toContain(created.task.id);
  });
});

function createHarness(): {
  clock: ManualClock;
  tasks: InMemoryTaskRepository;
  logs: CollectingLogSink;
  scheduler: TaskScheduler;
} {
  const clock = new ManualClock(timestamp(0));
  const tasks = new InMemoryTaskRepository();
  const logs = new CollectingLogSink();
  const scheduler = new TaskScheduler({
    tasks,
    clock,
    ids: new SequenceUuidV7Generator(),
    backoff: new ExponentialBackoffPolicy({
      baseDelayMilliseconds: 1_000,
      maximumDelayMilliseconds: 60_000,
      multiplier: 2,
      jitterRatio: 0,
      random: { next: () => 0.5 },
    }),
    leaseDurationMilliseconds: 60_000,
    log: logs,
  });
  return { clock, tasks, logs, scheduler };
}

class CollectingLogSink implements TaskLogSink {
  public readonly events: TaskLogEvent[] = [];

  public async write(event: TaskLogEvent): Promise<void> {
    this.events.push(event);
  }
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
