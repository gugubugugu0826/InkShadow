import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armOpeningJourneyDeadline,
  clearOpeningJourneyDeadlinesForTests,
  disarmOpeningJourneyDeadline,
  settleOpeningJourneyDeadlineOnce,
  type OpeningJourneyDeadlineScope,
} from "./opening-journey-deadline-coordinator";

const NOW = "2026-08-23T00:00:00.000Z";
const JOURNEY_ID = "019f9f4a-b3c7-7350-9226-000000000401";
const BATCH_ID = "019f9f4a-b3c7-7350-9226-000000000402";
const TASK_ID = "019f9f4a-b3c7-7350-9226-000000000403";

describe("opening journey deadline coordinator", () => {
  const owner = {};

  afterEach(() => {
    clearOpeningJourneyDeadlinesForTests(owner);
    vi.useRealTimers();
  });

  it("fires once at the persisted deadline even when the arming page no longer exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onDeadline = vi.fn(() => undefined);
    const onFailure = vi.fn();

    armOpeningJourneyDeadline(owner, scope(), { onDeadline, onFailure });

    await vi.advanceTimersByTimeAsync(179_999);
    expect(onDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDeadline).toHaveBeenCalledOnce();
    expect(onDeadline).toHaveBeenCalledWith(scope());
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it("keeps only the newest batch for one journey and fences a stale disarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const oldDeadline = vi.fn(() => undefined);
    const newDeadline = vi.fn(() => undefined);
    const onFailure = vi.fn();
    const replacementBatchId = "019f9f4a-b3c7-7350-9226-000000000404";
    const replacementTaskId = "019f9f4a-b3c7-7350-9226-000000000405";
    const replacement = scope({
      batchId: replacementBatchId,
      supportId: replacementBatchId,
      taskId: replacementTaskId,
      startedAt: "2026-08-23T00:00:01.000Z",
      deadlineAt: "2026-08-23T00:03:01.000Z",
    });

    armOpeningJourneyDeadline(owner, scope(), { onDeadline: oldDeadline, onFailure });
    armOpeningJourneyDeadline(owner, replacement, { onDeadline: newDeadline, onFailure });
    disarmOpeningJourneyDeadline(owner, {
      journeyId: JOURNEY_ID,
      batchId: BATCH_ID,
      supportId: BATCH_ID,
    });

    await vi.advanceTimersByTimeAsync(180_000);
    expect(oldDeadline).not.toHaveBeenCalled();
    expect(newDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(newDeadline).toHaveBeenCalledOnce();
  });

  it("reports a local deadline-settlement failure once without retrying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const failure = new Error("local settlement failed");
    const onDeadline = vi.fn(() => {
      throw failure;
    });
    const onFailure = vi.fn();

    armOpeningJourneyDeadline(owner, scope(), { onDeadline, onFailure });
    await vi.advanceTimersByTimeAsync(180_000);

    expect(onDeadline).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(scope(), failure);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(onDeadline).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent settlement and permits one later explicit retry after failure", async () => {
    const failure = new Error("local settlement failed");
    let release!: () => void;
    const firstAttempt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          release = () => reject(failure);
        }),
    );

    const first = settleOpeningJourneyDeadlineOnce(owner, scope(), firstAttempt);
    const concurrent = settleOpeningJourneyDeadlineOnce(owner, scope(), firstAttempt);
    await vi.waitFor(() => expect(firstAttempt).toHaveBeenCalledOnce());
    release();
    await expect(first).rejects.toBe(failure);
    await expect(concurrent).rejects.toBe(failure);
    expect(firstAttempt).toHaveBeenCalledOnce();

    const explicitRetry = vi.fn(() => undefined);
    await settleOpeningJourneyDeadlineOnce(owner, scope(), explicitRetry);
    expect(explicitRetry).toHaveBeenCalledOnce();
  });

  it("rejects malformed scope and fires an already expired scope on the next timer turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T00:04:00.000Z");
    const onDeadline = vi.fn(() => undefined);
    const onFailure = vi.fn();

    expect(() =>
      armOpeningJourneyDeadline(owner, scope({ supportId: "not-a-support-id" }), {
        onDeadline,
        onFailure,
      }),
    ).toThrow();

    armOpeningJourneyDeadline(owner, scope(), { onDeadline, onFailure });
    expect(onDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(onDeadline).toHaveBeenCalledOnce();
  });
});

function scope(overrides: Partial<OpeningJourneyDeadlineScope> = {}): OpeningJourneyDeadlineScope {
  return Object.freeze({
    journeyId: JOURNEY_ID,
    batchId: BATCH_ID,
    taskId: TASK_ID,
    supportId: BATCH_ID,
    startedAt: NOW,
    deadlineAt: "2026-08-23T00:03:00.000Z",
    ...overrides,
  });
}
