import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
  ExecuteResult,
  SqlExecutor,
  SqlPrimitive,
  TransactionExecutor,
} from "@inkshadow/data";
import { TaskEngineError, type TaskSnapshot } from "@inkshadow/task-engine";
import { describe, expect, it } from "vitest";

import {
  fileSqliteIt,
  NodeSqliteExecutor,
} from "../../../../packages/data/tests/node-sqlite-executor.js";

import type { CreativeJourneyRecord, CreativeJourneyStore } from "./creative-journey-store";
import { createDevelopmentRuntime } from "./runtime";
import {
  advanceOpeningJourneyRun,
  checkpointOpeningJourneyRun,
  createOpeningJourneyRun,
  ensureOpeningJourneyTask,
  openingJourneyRunElapsedMs,
  openingJourneyRunRecoveryDecision,
  openingJourneySupportNumber,
  openingJourneyTaskInput,
  projectOpeningJourneyTaskStage,
  readOpeningJourneyRun,
} from "./opening-journey-run";
import { TauriTaskCenterStore, type TaskCenterStore } from "./task-center-store";

const JOURNEY_ID = "0198f7e0-0000-7000-8000-000000000001";
const BATCH_ID = "0198f7e0-0000-7000-8000-000000000002";
const TASK_ID = "0198f7e0-0000-7000-8000-000000000003";
const CONFLICT_TASK_ID = "0198f7e0-0000-7000-8000-000000000007";
const LEASE_ID = "0198f7e0-0000-7000-8000-000000000008";
const SECOND_LEASE_ID = "0198f7e0-0000-7000-8000-000000000009";
const REQUEST_IDS = [
  "0198f7e0-0000-7000-8000-000000000004",
  "0198f7e0-0000-7000-8000-000000000005",
  "0198f7e0-0000-7000-8000-000000000006",
] as const;
const STARTED_AT = "2026-08-23T10:00:00.000Z";
const TASK_SQLITE_MIGRATION = [
  readTaskMigration("0001_core.sql"),
  readTaskMigration("0002_tasks_notifications.sql"),
].join("\n");

describe("opening journey run", () => {
  it("projects a stable spoken support number without exposing the durable UUID after restart", () => {
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });
    const restored = readOpeningJourneyRun(JSON.parse(JSON.stringify(run)));
    if (restored === null) throw new Error("开书旅程重启后没有恢复。");

    const beforeRestart = openingJourneySupportNumber(run);
    const afterRestart = openingJourneySupportNumber(restored);

    expect(beforeRestart).toBe("墨影-20260823100000-000002");
    expect(afterRestart).toBe(beforeRestart);
    expect(beforeRestart).not.toContain(BATCH_ID);
    expect(restored.supportId).toBe(BATCH_ID);
    expect(restored.batchId).toBe(BATCH_ID);
  });

  it("persists one stable support number, exact request identifiers, deadline, and zero automatic retries", () => {
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });

    expect(run).toMatchObject({
      version: 1,
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      supportId: BATCH_ID,
      requestIds: REQUEST_IDS,
      stage: "journey_saved",
      startedAt: STARTED_AT,
      stageStartedAt: STARTED_AT,
      deadlineAt: "2026-08-23T10:03:00.000Z",
      terminalAt: null,
      failureCode: null,
      autoRetryCount: 0,
    });

    expect(openingJourneyTaskInput(run, STARTED_AT)).toMatchObject({
      id: TASK_ID,
      type: "ai.opening.generate",
      idempotencyKey: `idea.opening:${JOURNEY_ID}:${BATCH_ID}`,
      maxAttempts: 1,
      metadata: {
        operation: "creative_opening",
        journeyId: JOURNEY_ID,
        batchId: BATCH_ID,
        startedAt: STARTED_AT,
        supportId: BATCH_ID,
      },
    });
  });

  it("keeps identifiers stable while advancing stages and derives elapsed time from persisted timestamps", () => {
    const initial = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });
    expect(() =>
      advanceOpeningJourneyRun(initial, {
        stage: "provider_waiting",
        now: "2026-08-23T10:00:07.000Z",
      }),
    ).toThrow("not allowed");
    const awaiting = advanceRunToAwaitingConfirmation(initial, "2026-08-23T10:00:05.000Z");
    const confirmed = advanceOpeningJourneyRun(awaiting, {
      stage: "confirmed",
      now: "2026-08-23T10:00:06.000Z",
    });
    const reserving = advanceOpeningJourneyRun(confirmed, {
      stage: "invocation_reserving",
      now: "2026-08-23T10:00:07.000Z",
    });
    const waiting = advanceOpeningJourneyRun(reserving, {
      stage: "provider_waiting",
      now: "2026-08-23T10:00:08.000Z",
    });
    const pending = advanceOpeningJourneyRun(waiting, {
      stage: "result_pending",
      now: "2026-08-23T10:03:00.000Z",
      failureCode: "OPENING_RESULT_PENDING_REVIEW",
    });

    expect(waiting).toMatchObject({
      supportId: BATCH_ID,
      requestIds: REQUEST_IDS,
      autoRetryCount: 0,
      stageStartedAt: "2026-08-23T10:00:08.000Z",
    });
    expect(openingJourneyRunElapsedMs(waiting, "2026-08-23T10:00:38.000Z")).toBe(38_000);
    expect(pending).toMatchObject({
      supportId: BATCH_ID,
      stage: "result_pending",
      terminalAt: "2026-08-23T10:03:00.000Z",
      failureCode: "OPENING_RESULT_PENDING_REVIEW",
      autoRetryCount: 0,
    });
  });

  it("starts a fresh bounded execution deadline only after the author confirms sending", () => {
    const initial = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });
    const awaiting = advanceRunToAwaitingConfirmation(initial, "2026-08-23T10:05:00.000Z");
    const confirmed = advanceOpeningJourneyRun(awaiting, {
      stage: "confirmed",
      now: "2026-08-23T10:10:00.000Z",
      timeoutMs: 1_140_000,
    });

    expect(awaiting.deadlineAt).toBe("2026-08-23T10:03:00.000Z");
    expect(confirmed).toMatchObject({
      startedAt: STARTED_AT,
      stageStartedAt: "2026-08-23T10:10:00.000Z",
      deadlineAt: "2026-08-23T10:29:00.000Z",
      autoRetryCount: 0,
    });
    expect(() =>
      advanceOpeningJourneyRun(confirmed, {
        stage: "invocation_reserving",
        now: "2026-08-23T10:10:01.000Z",
        timeoutMs: 180_000,
      }),
    ).toThrow("only start at confirmation");
  });

  it("rejects skipped stages and terminal states outside their explicit dispatch boundary", () => {
    const initial = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });
    for (const stage of ["confirmed", "completed", "result_pending"] as const) {
      expect(() =>
        advanceOpeningJourneyRun(initial, {
          stage,
          now: "2026-08-23T10:00:01.000Z",
        }),
      ).toThrow("not allowed");
    }
    const awaiting = advanceRunToAwaitingConfirmation(initial, "2026-08-23T10:00:01.000Z");
    const confirmed = advanceOpeningJourneyRun(awaiting, {
      stage: "confirmed",
      now: "2026-08-23T10:00:02.000Z",
    });
    expect(() =>
      advanceOpeningJourneyRun(confirmed, {
        stage: "completed",
        now: "2026-08-23T10:00:03.000Z",
      }),
    ).toThrow("not allowed");
    const reserving = advanceOpeningJourneyRun(confirmed, {
      stage: "invocation_reserving",
      now: "2026-08-23T10:00:03.000Z",
    });
    expect(() =>
      advanceOpeningJourneyRun(reserving, {
        stage: "result_pending",
        now: "2026-08-23T10:00:04.000Z",
      }),
    ).toThrow("not allowed");
    const waiting = advanceOpeningJourneyRun(reserving, {
      stage: "provider_waiting",
      now: "2026-08-23T10:00:04.000Z",
    });
    expect(() =>
      advanceOpeningJourneyRun(waiting, {
        stage: "cancelled_before_confirmation",
        now: "2026-08-23T10:00:05.000Z",
      }),
    ).toThrow("not allowed");
  });

  it("distinguishes confirmation exit, pre-send timeout, dispatched uncertainty, and an in-time wait", () => {
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });
    const awaitingConfirmation = advanceRunToAwaitingConfirmation(run, "2026-08-23T10:00:02.000Z");
    const confirmed = advanceOpeningJourneyRun(awaitingConfirmation, {
      stage: "confirmed",
      now: "2026-08-23T10:00:08.000Z",
    });
    const reserving = advanceOpeningJourneyRun(confirmed, {
      stage: "invocation_reserving",
      now: "2026-08-23T10:00:09.000Z",
    });
    const waiting = advanceOpeningJourneyRun(reserving, {
      stage: "provider_waiting",
      now: "2026-08-23T10:00:10.000Z",
    });

    expect(
      openingJourneyRunRecoveryDecision({
        run: awaitingConfirmation,
        now: "2026-08-23T10:00:05.000Z",
        pageExited: true,
        invocations: [],
      }),
    ).toBe("cancel_before_confirmation");
    expect(
      openingJourneyRunRecoveryDecision({
        run: waiting,
        now: "2026-08-23T10:03:01.000Z",
        pageExited: false,
        invocations: REQUEST_IDS.map((requestId) => ({
          requestId,
          status: "missing" as const,
          providerDispatchStartedAt: null,
        })),
      }),
    ).toBe("fail_not_sent");
    expect(
      openingJourneyRunRecoveryDecision({
        run: waiting,
        now: "2026-08-23T10:03:01.000Z",
        pageExited: false,
        invocations: [
          {
            requestId: REQUEST_IDS[0],
            status: "running",
            providerDispatchStartedAt: "2026-08-23T10:00:11.000Z",
          },
        ],
      }),
    ).toBe("result_pending");
    expect(
      openingJourneyRunRecoveryDecision({
        run: waiting,
        now: "2026-08-23T10:02:59.000Z",
        pageExited: false,
        invocations: [],
      }),
    ).toBe("continue_waiting");
  });

  it("rejects empty identifiers and backwards persisted time ranges", () => {
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });
    expect(readOpeningJourneyRun({ ...run, journeyId: "" })).toBeNull();
    expect(readOpeningJourneyRun({ ...run, requestIds: [""] })).toBeNull();
    expect(
      readOpeningJourneyRun({
        ...run,
        deadlineAt: "2026-08-23T09:59:59.000Z",
      }),
    ).toBeNull();
    expect(
      readOpeningJourneyRun({
        ...run,
        stageStartedAt: "2026-08-23T09:59:59.000Z",
      }),
    ).toBeNull();
    expect(
      readOpeningJourneyRun({
        ...run,
        journeyId: "pricing_unavailable",
      }),
    ).toBeNull();
    expect(
      readOpeningJourneyRun({
        ...run,
        batchId: "pricing_unavailable",
        supportId: "pricing_unavailable",
      }),
    ).toBeNull();
    expect(() =>
      createOpeningJourneyRun({
        journeyId: "x",
        batchId: BATCH_ID,
        taskId: TASK_ID,
        requestIds: REQUEST_IDS,
        now: STARTED_AT,
        timeoutMs: 180_000,
      }),
    ).toThrow("identifiers");
  });

  it("fails closed when an idempotency key points at a task outside the opening run scope", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now,
      timeoutMs: 180_000,
    });
    const expected = openingJourneyTaskInput(run, now);
    await runtime.taskCenter.enqueueTask({
      ...expected,
      id: CONFLICT_TASK_ID,
      metadata: Object.freeze({
        operation: "creative_opening",
        journeyId: JOURNEY_ID,
        batchId: BATCH_ID,
        supportId: REQUEST_IDS[0],
        requestCount: REQUEST_IDS.length,
        autoRetryCount: 0,
      }),
    });
    const before = await runtime.taskCenter.load();

    await expect(ensureOpeningJourneyTask(runtime.taskCenter, run, now)).rejects.toMatchObject({
      code: "OPENING_JOURNEY_TASK_SCOPE_MISMATCH",
      supportId: BATCH_ID,
    });
    expect(await runtime.taskCenter.load()).toEqual(before);
  });

  it("rejects terminal task statuses that contradict the persisted opening run stage", async () => {
    window.localStorage.clear();
    const firstRuntime = createDevelopmentRuntime(window.localStorage);
    const firstNow = firstRuntime.clock.now();
    const awaitingRun = advanceRunToAwaitingConfirmation(
      createOpeningJourneyRun({
        journeyId: JOURNEY_ID,
        batchId: BATCH_ID,
        taskId: TASK_ID,
        requestIds: REQUEST_IDS,
        now: firstNow,
        timeoutMs: 180_000,
      }),
      firstNow,
    );
    await ensureOpeningJourneyTask(firstRuntime.taskCenter, awaitingRun, firstNow);
    await firstRuntime.taskCenter.startTask(
      TASK_ID,
      "opening-journey-ui",
      LEASE_ID,
      new Date(Date.parse(firstNow) + 60_000).toISOString(),
    );
    await firstRuntime.taskCenter.completeTask(TASK_ID, LEASE_ID);
    const succeededBefore = await firstRuntime.taskCenter.load();

    await expect(
      ensureOpeningJourneyTask(firstRuntime.taskCenter, awaitingRun, firstNow),
    ).rejects.toMatchObject({
      code: "OPENING_JOURNEY_TASK_SCOPE_MISMATCH",
      supportId: BATCH_ID,
    });
    expect(await firstRuntime.taskCenter.load()).toEqual(succeededBefore);

    window.localStorage.clear();
    const secondRuntime = createDevelopmentRuntime(window.localStorage);
    const secondNow = secondRuntime.clock.now();
    const waitingRun = advanceRunToProviderWaiting(
      createOpeningJourneyRun({
        journeyId: JOURNEY_ID,
        batchId: BATCH_ID,
        taskId: TASK_ID,
        requestIds: REQUEST_IDS,
        now: secondNow,
        timeoutMs: 180_000,
      }),
      secondNow,
    );
    const completedRun = advanceOpeningJourneyRun(waitingRun, {
      stage: "completed",
      now: secondNow,
    });
    await ensureOpeningJourneyTask(secondRuntime.taskCenter, completedRun, secondNow);
    await secondRuntime.taskCenter.startTask(
      TASK_ID,
      "opening-journey-ui",
      SECOND_LEASE_ID,
      new Date(Date.parse(secondNow) + 60_000).toISOString(),
    );
    await secondRuntime.taskCenter.failTask(
      TASK_ID,
      SECOND_LEASE_ID,
      {
        code: "OPENING_GENERATION_FAILED",
        retryable: false,
        actions: ["EXPORT_DIAGNOSTICS", "CONTACT_SUPPORT"],
        requestId: BATCH_ID,
      },
      null,
    );
    const failedBefore = await secondRuntime.taskCenter.load();

    await expect(
      ensureOpeningJourneyTask(secondRuntime.taskCenter, completedRun, secondNow),
    ).rejects.toMatchObject({
      code: "OPENING_JOURNEY_TASK_SCOPE_MISMATCH",
      supportId: BATCH_ID,
    });
    expect(await secondRuntime.taskCenter.load()).toEqual(failedBefore);
  });

  it("projects confirmed and provider-waiting stages into the same one-attempt task", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now,
      timeoutMs: 180_000,
    });
    await ensureOpeningJourneyTask(runtime.taskCenter, run, now);

    const confirmed = await projectOpeningJourneyTaskStage(
      runtime.taskCenter,
      run,
      "opening.invocation",
      now,
    );
    const waiting = await projectOpeningJourneyTaskStage(
      runtime.taskCenter,
      run,
      "opening.provider_waiting",
      now,
    );

    expect(confirmed).toMatchObject({ id: TASK_ID, status: "running", attempt: 1, maxAttempts: 1 });
    expect(waiting.progress).toMatchObject({
      step: "opening.provider_waiting",
      completedUnits: 0,
      totalUnits: null,
    });
  });
  it("fails closed without changing an unreadable persisted opening run", async () => {
    const validRun = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now: STARTED_AT,
      timeoutMs: 180_000,
    });
    const trustedRecord = openingJourneyRecord({
      ...validRun,
      stage: "unknown_internal_stage",
    });
    const trustedBefore = structuredClone(trustedRecord);
    let trustedUpdates = 0;

    await expect(
      checkpointOpeningJourneyRun(
        readOnlyJourneyStore(trustedRecord, () => {
          trustedUpdates += 1;
        }),
        JOURNEY_ID,
        { stage: "workspace_provisioning", now: STARTED_AT },
      ),
    ).rejects.toMatchObject({
      code: "OPENING_JOURNEY_RUN_SCOPE_MISMATCH",
      supportId: BATCH_ID,
    });
    expect(trustedUpdates).toBe(0);
    expect(trustedRecord).toEqual(trustedBefore);

    const internalValue = "pricing_unavailable";
    const untrustedRecord = openingJourneyRecord({
      ...validRun,
      batchId: internalValue,
      supportId: internalValue,
    });
    const untrustedBefore = structuredClone(untrustedRecord);
    const error = await checkpointOpeningJourneyRun(
      readOnlyJourneyStore(untrustedRecord),
      JOURNEY_ID,
      { stage: "workspace_provisioning", now: STARTED_AT },
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "OPENING_JOURNEY_RUN_SCOPE_MISMATCH",
      supportId: null,
    });
    expect(String(error)).not.toContain(internalValue);
    expect(untrustedRecord).toEqual(untrustedBefore);
  });

  it("validates the task returned by a concurrent idempotent enqueue before reusing it", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now,
      timeoutMs: 180_000,
    });
    const correct = (await runtime.taskCenter.enqueueTask(openingJourneyTaskInput(run, now))).task;
    const concurrentTask = Object.freeze({
      ...correct,
      id: CONFLICT_TASK_ID as TaskSnapshot["id"],
      metadata: Object.freeze({
        ...correct.metadata,
        supportId: REQUEST_IDS[0],
      }),
    }) as TaskSnapshot;
    const concurrentBefore = structuredClone(concurrentTask);
    let enqueueCalls = 0;
    const concurrentStore = taskCenterProxy(runtime.taskCenter, {
      findTaskByIdempotencyKey: () => Promise.resolve(null),
      enqueueTask: () => {
        enqueueCalls += 1;
        return Promise.resolve({ task: concurrentTask, created: false });
      },
    });

    await expect(ensureOpeningJourneyTask(concurrentStore, run, now)).rejects.toMatchObject({
      code: "OPENING_JOURNEY_TASK_SCOPE_MISMATCH",
      supportId: BATCH_ID,
    });
    expect(enqueueCalls).toBe(1);
    expect(concurrentTask).toEqual(concurrentBefore);
  });

  it("treats a concurrent progress report at the same or later opening step as idempotent", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now,
      timeoutMs: 180_000,
    });
    await ensureOpeningJourneyTask(runtime.taskCenter, run, now);
    await runtime.taskCenter.startTask(
      TASK_ID,
      "opening-journey-ui",
      TASK_ID,
      new Date(Date.parse(now) + 60_000).toISOString(),
    );
    let reportCalls = 0;
    const concurrentStore = taskCenterProxy(runtime.taskCenter, {
      reportTaskProgress: async (...args) => {
        reportCalls += 1;
        await runtime.taskCenter.reportTaskProgress(
          args[0],
          args[1],
          "opening.provider_waiting",
          args[3],
          args[4],
        );
        throw taskSequenceConflict();
      },
    });

    const projected = await projectOpeningJourneyTaskStage(
      concurrentStore,
      run,
      "opening.invocation",
      now,
    );

    expect(reportCalls).toBe(1);
    expect(projected.progress?.step).toBe("opening.provider_waiting");
  });

  it("recovers when another owner starts the opening task during the local claim", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now,
      timeoutMs: 180_000,
    });
    await ensureOpeningJourneyTask(runtime.taskCenter, run, now);
    let startCalls = 0;
    const concurrentStore = taskCenterProxy(runtime.taskCenter, {
      startTask: async (...args) => {
        startCalls += 1;
        await runtime.taskCenter.startTask(...args);
        throw taskSequenceConflict();
      },
    });

    const projected = await projectOpeningJourneyTaskStage(
      concurrentStore,
      run,
      "opening.invocation",
      now,
    );

    expect(startCalls).toBe(1);
    expect(projected).toMatchObject({
      id: TASK_ID,
      status: "running",
      progress: { step: "opening.invocation" },
    });
  });

  it("retries a bounded number of stale progress reports and preserves the last sequence conflict", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now,
      timeoutMs: 180_000,
    });
    await ensureOpeningJourneyTask(runtime.taskCenter, run, now);
    await runtime.taskCenter.startTask(
      TASK_ID,
      "opening-journey-ui",
      TASK_ID,
      new Date(Date.parse(now) + 60_000).toISOString(),
    );
    const conflict = taskSequenceConflict();
    let reportCalls = 0;
    const staleStore = taskCenterProxy(runtime.taskCenter, {
      reportTaskProgress: () => {
        reportCalls += 1;
        return Promise.reject(conflict);
      },
    });

    await expect(
      projectOpeningJourneyTaskStage(staleStore, run, "opening.provider_waiting", now),
    ).rejects.toBe(conflict);
    expect(reportCalls).toBe(4);
  });

  it("rechecks task scope after a sequence conflict and does not swallow other failures", async () => {
    window.localStorage.clear();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const run = createOpeningJourneyRun({
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      requestIds: REQUEST_IDS,
      now,
      timeoutMs: 180_000,
    });
    await ensureOpeningJourneyTask(runtime.taskCenter, run, now);
    await runtime.taskCenter.startTask(
      TASK_ID,
      "opening-journey-ui",
      TASK_ID,
      new Date(Date.parse(now) + 60_000).toISOString(),
    );
    const current = await runtime.taskCenter.findTaskByIdempotencyKey(
      openingJourneyTaskInput(run, now).idempotencyKey,
    );
    if (current === null) throw new Error("Controlled opening task was not found.");
    const wrongScope = Object.freeze({
      ...current,
      metadata: Object.freeze({
        ...current.metadata,
        supportId: REQUEST_IDS[0],
      }),
    }) as TaskSnapshot;
    let reads = 0;
    const mismatchedStore = taskCenterProxy(runtime.taskCenter, {
      findTaskByIdempotencyKey: () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? current : wrongScope);
      },
      reportTaskProgress: () => Promise.reject(taskSequenceConflict()),
    });

    await expect(
      projectOpeningJourneyTaskStage(mismatchedStore, run, "opening.provider_waiting", now),
    ).rejects.toMatchObject({
      code: "OPENING_JOURNEY_TASK_SCOPE_MISMATCH",
      supportId: BATCH_ID,
    });

    const repositoryFailure = new TaskEngineError({
      code: "TASK_REPOSITORY_ERROR",
      message: "controlled repository failure",
    });
    let nonConflictReports = 0;
    const failingStore = taskCenterProxy(runtime.taskCenter, {
      reportTaskProgress: () => {
        nonConflictReports += 1;
        return Promise.reject(repositoryFailure);
      },
    });
    await expect(
      projectOpeningJourneyTaskStage(failingStore, run, "opening.provider_waiting", now),
    ).rejects.toBe(repositoryFailure);
    expect(nonConflictReports).toBe(1);
  });
  fileSqliteIt(
    "recovers a real SQLite task CAS conflict without regressing three-slot progress or duplicating work",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "inkshadow-opening-task-cas-"));
      const databasePath = join(directory, "opening-task.sqlite");
      const firstRaw = new NodeSqliteExecutor(TASK_SQLITE_MIGRATION, databasePath);
      const firstExecutor = new InterleavingTaskSqlExecutor(firstRaw);
      const firstStore = new TauriTaskCenterStore(firstExecutor, { now: () => STARTED_AT });
      let secondRaw: NodeSqliteExecutor | null = null;

      try {
        const run = createOpeningJourneyRun({
          journeyId: JOURNEY_ID,
          batchId: BATCH_ID,
          taskId: TASK_ID,
          requestIds: REQUEST_IDS,
          now: STARTED_AT,
          timeoutMs: 180_000,
        });
        await ensureOpeningJourneyTask(firstStore, run, STARTED_AT);
        await projectOpeningJourneyTaskStage(firstStore, run, "opening.invocation", STARTED_AT);

        secondRaw = new NodeSqliteExecutor("", databasePath);
        const secondStore = new TauriTaskCenterStore(secondRaw, { now: () => STARTED_AT });
        firstExecutor.interleaveNextTaskUpdate(async () => {
          await secondStore.reportTaskProgress(
            TASK_ID,
            TASK_ID,
            "opening.provider_waiting",
            0,
            null,
          );
        });

        const waiting = await projectOpeningJourneyTaskStage(
          firstStore,
          run,
          "opening.provider_waiting",
          STARTED_AT,
        );
        const beforeLateInvocation = await firstStore.findTaskByIdempotencyKey(
          openingJourneyTaskInput(run, STARTED_AT).idempotencyKey,
        );
        const lateInvocation = await projectOpeningJourneyTaskStage(
          firstStore,
          run,
          "opening.invocation",
          STARTED_AT,
        );
        const snapshot = await firstStore.load();

        expect(firstExecutor.interleavedConflictCount).toBe(1);
        expect(snapshot.tasks).toHaveLength(1);
        expect(snapshot.tasks[0]).toMatchObject({
          id: TASK_ID,
          status: "running",
          attempt: 1,
          maxAttempts: 1,
          progress: { step: "opening.provider_waiting" },
          failure: null,
          metadata: {
            requestCount: 3,
            autoRetryCount: 0,
            supportId: BATCH_ID,
          },
        });
        expect(waiting.progress?.step).toBe("opening.provider_waiting");
        expect(lateInvocation.progress?.step).toBe("opening.provider_waiting");
        expect(lateInvocation.sequence).toBe(beforeLateInvocation?.sequence);
        expect(run.requestIds).toHaveLength(3);
        expect(run.autoRetryCount).toBe(0);
      } finally {
        if (secondRaw !== null) await secondRaw.close();
        await firstRaw.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

class InterleavingTaskSqlExecutor implements SqlExecutor {
  public interleavedConflictCount = 0;
  private beforeNextTaskUpdate: (() => Promise<void>) | null = null;

  public constructor(private readonly delegate: SqlExecutor) {}

  public interleaveNextTaskUpdate(action: () => Promise<void>): void {
    this.beforeNextTaskUpdate = action;
  }

  public select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public async execute(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<ExecuteResult> {
    const action = query.includes("UPDATE background_tasks") ? this.beforeNextTaskUpdate : null;
    if (action === null) return this.delegate.execute(query, bindValues);
    this.beforeNextTaskUpdate = null;
    await action();
    const result = await this.delegate.execute(query, bindValues);
    if (result.rowsAffected === 0) this.interleavedConflictCount += 1;
    return result;
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction(operation);
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

function readTaskMigration(fileName: string): string {
  let workspaceRoot = resolve(process.cwd());
  while (!existsSync(join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}

function openingJourneyRecord(openingRun: unknown): CreativeJourneyRecord {
  return Object.freeze({
    id: JOURNEY_ID,
    kind: "idea" as const,
    status: "active" as const,
    currentState: "opening_generation",
    projectId: null,
    chapterId: null,
    candidateId: null,
    revision: 1,
    snapshot: Object.freeze({ openingRun }),
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    completedAt: null,
  });
}

function readOnlyJourneyStore(
  record: CreativeJourneyRecord,
  onUpdate: () => void = () => undefined,
): CreativeJourneyStore {
  return {
    findById: (id) => Promise.resolve(id === record.id ? record : null),
    listActive: () => Promise.resolve([record]),
    listTurns: () => Promise.resolve([]),
    create: () => Promise.resolve(),
    update: () => {
      onUpdate();
      return Promise.resolve();
    },
  };
}

function taskCenterProxy(
  target: TaskCenterStore,
  overrides: Partial<TaskCenterStore>,
): TaskCenterStore {
  return new Proxy(target, {
    get(store, property, receiver) {
      const override = Reflect.get(overrides, property, receiver) as unknown;
      if (override !== undefined) return override;
      const value = Reflect.get(store, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (value as (...args: unknown[]) => unknown).bind(store);
    },
  });
}

function taskSequenceConflict(): TaskEngineError {
  return new TaskEngineError({
    code: "TASK_SEQUENCE_CONFLICT",
    message: "controlled task sequence conflict",
    retryable: true,
  });
}

function advanceRunToAwaitingConfirmation(
  initial: ReturnType<typeof createOpeningJourneyRun>,
  now: string,
) {
  const workspace = advanceOpeningJourneyRun(initial, {
    stage: "workspace_provisioning",
    now,
  });
  const preflight = advanceOpeningJourneyRun(workspace, {
    stage: "preflight",
    now,
  });
  return advanceOpeningJourneyRun(preflight, {
    stage: "awaiting_confirmation",
    now,
  });
}

function advanceRunToProviderWaiting(
  initial: ReturnType<typeof createOpeningJourneyRun>,
  now: string,
) {
  const awaiting = advanceRunToAwaitingConfirmation(initial, now);
  const confirmed = advanceOpeningJourneyRun(awaiting, {
    stage: "confirmed",
    now,
  });
  const reserving = advanceOpeningJourneyRun(confirmed, {
    stage: "invocation_reserving",
    now,
  });
  return advanceOpeningJourneyRun(reserving, {
    stage: "provider_waiting",
    now,
  });
}
