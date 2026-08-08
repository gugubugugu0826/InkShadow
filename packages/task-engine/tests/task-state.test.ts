import {
  ExponentialBackoffPolicy,
  Task,
  type TaskEngineError,
  createTaskFailure,
  type Result,
  type TaskFailure,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

import { timestamp, uuid } from "./fakes.js";

describe("Task state machine", () => {
  it("tracks attempt, sequence, lease, progress, retry, and success", () => {
    const queued = makeTask();
    expect(queued.toSnapshot()).toMatchObject({
      status: "queued",
      attempt: 1,
      sequence: 1,
      runAfter: timestamp(0),
      lease: null,
    });

    const running = expectOk(
      queued.claim({
        ownerId: "worker:primary",
        leaseToken: uuid(2),
        now: timestamp(1),
        leaseExpiresAt: timestamp(10),
      }),
    );
    expect(running.toSnapshot()).toMatchObject({
      status: "running",
      attempt: 1,
      sequence: 2,
      startedAt: timestamp(1),
    });

    const progressed = expectOk(
      running.reportProgress({
        leaseToken: uuid(2),
        step: "context.build",
        completedUnits: 3,
        totalUnits: 10,
        now: timestamp(2),
      }),
    );
    expect(progressed.toSnapshot()).toMatchObject({
      sequence: 3,
      progress: {
        step: "context.build",
        completedUnits: 3,
        totalUnits: 10,
      },
    });

    const renewed = expectOk(progressed.renewLease(uuid(2), timestamp(3), timestamp(20)));
    expect(renewed.sequence).toBe(4);
    expect(renewed.lease?.expiresAt).toBe(timestamp(20));

    const waiting = expectOk(
      renewed.recordFailure({
        leaseToken: uuid(2),
        failure: retryableFailure(),
        now: timestamp(4),
        retryAt: timestamp(30),
      }),
    );
    expect(waiting.toSnapshot()).toMatchObject({
      status: "waiting_retry",
      attempt: 2,
      sequence: 5,
      runAfter: timestamp(30),
      lease: null,
      progress: null,
      failure: {
        code: "UPSTREAM_TEMPORARY",
        retryable: true,
      },
    });

    expectErrorCode(
      waiting.claim({
        ownerId: "worker:retry",
        leaseToken: uuid(3),
        now: timestamp(29),
        leaseExpiresAt: timestamp(40),
      }),
      "TASK_NOT_RUNNABLE",
    );

    const retried = expectOk(
      waiting.claim({
        ownerId: "worker:retry",
        leaseToken: uuid(3),
        now: timestamp(30),
        leaseExpiresAt: timestamp(40),
      }),
    );
    expect(retried.toSnapshot()).toMatchObject({
      status: "running",
      attempt: 2,
      sequence: 6,
      failure: null,
    });

    const succeeded = expectOk(retried.complete(uuid(3), timestamp(31)));
    expect(succeeded.toSnapshot()).toMatchObject({
      status: "succeeded",
      attempt: 2,
      sequence: 7,
      lease: null,
      finishedAt: timestamp(31),
    });
  });

  it("rejects stale leases and backwards progress", () => {
    const running = expectOk(
      makeTask().claim({
        ownerId: "worker:primary",
        leaseToken: uuid(2),
        now: timestamp(1),
        leaseExpiresAt: timestamp(10),
      }),
    );
    expectErrorCode(running.complete(uuid(3), timestamp(2)), "TASK_LEASE_MISMATCH");
    expectErrorCode(running.complete(uuid(2), timestamp(10)), "TASK_LEASE_EXPIRED");

    const progressed = expectOk(
      running.reportProgress({
        leaseToken: uuid(2),
        step: "stream.receive",
        completedUnits: 5,
        totalUnits: 10,
        now: timestamp(2),
      }),
    );
    expectErrorCode(
      progressed.reportProgress({
        leaseToken: uuid(2),
        step: "stream.receive",
        completedUnits: 4,
        totalUnits: 10,
        now: timestamp(3),
      }),
      "TASK_VALIDATION_FAILED",
    );
  });

  it("makes a persisted cancellation request win over completion", () => {
    const running = expectOk(
      makeTask().claim({
        ownerId: "worker:primary",
        leaseToken: uuid(2),
        now: timestamp(1),
        leaseExpiresAt: timestamp(10),
      }),
    );
    const cancelling = expectOk(running.requestCancellation(timestamp(2)));
    expect(cancelling.toSnapshot()).toMatchObject({
      status: "running",
      sequence: 3,
      cancelRequestedAt: timestamp(2),
    });
    expectErrorCode(cancelling.complete(uuid(2), timestamp(3)), "TASK_CANCEL_REQUESTED");

    const cancelled = expectOk(cancelling.acknowledgeCancellation(uuid(2), timestamp(3)));
    expect(cancelled.toSnapshot()).toMatchObject({
      status: "cancelled",
      sequence: 4,
      finishedAt: timestamp(3),
      lease: null,
    });
    expect(expectOk(cancelled.requestCancellation(timestamp(4))).sequence).toBe(4);
  });

  it("pauses only at a safe boundary and resumes as queued", () => {
    const queued = makeTask();
    const paused = expectOk(queued.pause(timestamp(1)));
    expect(paused.status).toBe("paused");
    const resumed = expectOk(paused.resume(timestamp(2)));
    expect(resumed.toSnapshot()).toMatchObject({
      status: "queued",
      runAfter: timestamp(2),
      sequence: 3,
    });

    const running = expectOk(
      resumed.claim({
        ownerId: "worker:primary",
        leaseToken: uuid(2),
        now: timestamp(3),
        leaseExpiresAt: timestamp(10),
      }),
    );
    expectErrorCode(running.pause(timestamp(4)), "TASK_LEASE_MISMATCH");
    expect(expectOk(running.pause(timestamp(4), uuid(2))).status).toBe("paused");
  });

  it("lets the author run a scheduled retry now without consuming another attempt", () => {
    const running = expectOk(
      makeTask().claim({
        ownerId: "worker:primary",
        leaseToken: uuid(2),
        now: timestamp(1),
        leaseExpiresAt: timestamp(10),
      }),
    );
    const waiting = expectOk(
      running.recordFailure({
        leaseToken: uuid(2),
        failure: retryableFailure(),
        now: timestamp(2),
        retryAt: timestamp(30),
      }),
    );

    const queued = expectOk(waiting.retryNow(timestamp(3)));
    expect(queued.toSnapshot()).toMatchObject({
      status: "queued",
      attempt: 2,
      runAfter: timestamp(3),
      failure: null,
      sequence: 4,
    });
    const recoveryQueued = expectOk(
      waiting.retryNow(timestamp(3), {
        expectedSequence: waiting.sequence,
        expectedAttempt: waiting.attempt,
        expectedFailureCauseCode: waiting.failure?.causeCode ?? null,
        recoveryProgressStep: "pipeline.retry.v2.a2.full",
      }),
    );
    expect(recoveryQueued.toSnapshot()).toMatchObject({
      status: "queued",
      attempt: 2,
      sequence: 4,
      failure: null,
      progress: {
        step: "pipeline.retry.v2.a2.full",
        completedUnits: 0,
        totalUnits: null,
      },
    });
    expectErrorCode(
      waiting.retryNow(timestamp(3), {
        expectedSequence: waiting.sequence + 1,
        expectedAttempt: waiting.attempt,
        expectedFailureCauseCode: waiting.failure?.causeCode ?? null,
        recoveryProgressStep: "pipeline.retry.v2.a2.full",
      }),
      "TASK_SEQUENCE_CONFLICT",
    );
    expectErrorCode(makeTask().retryNow(timestamp(3)), "TASK_INVALID_TRANSITION");
  });

  it("uses injected jitter deterministically and caps exponential delay", () => {
    const values = [0, 0.5, 1, 0.5];
    const policy = new ExponentialBackoffPolicy({
      baseDelayMilliseconds: 1_000,
      maximumDelayMilliseconds: 8_000,
      multiplier: 2,
      jitterRatio: 0.25,
      random: {
        next: () => values.shift() ?? 0.5,
      },
    });

    expect(expectOk(policy.delayMilliseconds(1))).toBe(750);
    expect(expectOk(policy.delayMilliseconds(2))).toBe(2_000);
    expect(expectOk(policy.delayMilliseconds(3))).toBe(5_000);
    expect(expectOk(policy.delayMilliseconds(8))).toBe(8_000);
  });
});

function makeTask(): Task {
  return expectOk(
    Task.create({
      id: uuid(1),
      type: "ai.generate",
      idempotencyKey: "generation:chapter:0001",
      metadata: {
        projectId: uuid(100),
        chapterId: uuid(101),
        baseVersionId: uuid(102),
      },
      priority: 80,
      maxAttempts: 3,
      now: timestamp(0),
    }),
  );
}

function retryableFailure(): TaskFailure {
  const failure = createTaskFailure({
    code: "UPSTREAM_TEMPORARY",
    retryable: true,
    actions: ["RETRY", "SWITCH_MODEL"],
    requestId: "req-00000001",
  });
  if (!failure.ok) {
    throw failure.error;
  }
  return failure.value;
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
