import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION,
  loadCloudMaintenanceConfiguration,
} from "../src/maintenance/configuration.js";
import { runPeriodicCloudMaintenance } from "../src/maintenance/periodic-runner.js";
import {
  drainBoundedBatches,
  type CloudMaintenanceRunResult,
} from "../src/postgres/maintenance-worker.js";

describe("cloud maintenance configuration and scheduling", () => {
  it("uses conservative defaults and rejects out-of-bounds deployment values", () => {
    expect(loadCloudMaintenanceConfiguration({})).toEqual(DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION);
    expect(() =>
      loadCloudMaintenanceConfiguration({
        INKSHADOW_CLOUD_MAINTENANCE_BATCH_SIZE: "9",
      }),
    ).toThrow("between 10 and 2000");
    expect(() =>
      loadCloudMaintenanceConfiguration({
        INKSHADOW_CLOUD_SESSION_RETENTION_DAYS: "6",
      }),
    ).toThrow("between 7 and 365");
    expect(() =>
      loadCloudMaintenanceConfiguration({
        INKSHADOW_CLOUD_TOMBSTONE_ACK_GRACE_DAYS: "29",
      }),
    ).toThrow("between 30 and 365");

    expect(
      loadCloudMaintenanceConfiguration({
        INKSHADOW_CLOUD_CHALLENGE_RETENTION_DAYS: "14",
        INKSHADOW_CLOUD_IDEMPOTENCY_GRACE_HOURS: "0",
        INKSHADOW_CLOUD_MAINTENANCE_BATCH_SIZE: "100",
        INKSHADOW_CLOUD_MAINTENANCE_INTERVAL_SECONDS: "600",
        INKSHADOW_CLOUD_MAINTENANCE_MAX_BATCHES_PER_TARGET: "4",
        INKSHADOW_CLOUD_SESSION_RETENTION_DAYS: "45",
        INKSHADOW_CLOUD_SYNC_BATCH_RETENTION_DAYS: "60",
        INKSHADOW_CLOUD_TOMBSTONE_ACK_GRACE_DAYS: "45",
      }),
    ).toMatchObject({
      batchSize: 100,
      challengeRetentionMs: 14 * 24 * 60 * 60 * 1_000,
      idempotencyGraceMs: 0,
      intervalMs: 600_000,
      maximumBatchesPerTarget: 4,
      sessionRetentionMs: 45 * 24 * 60 * 60 * 1_000,
      syncBatchRetentionMs: 60 * 24 * 60 * 60 * 1_000,
      tombstoneAcknowledgementGraceMs: 45 * 24 * 60 * 60 * 1_000,
    });
  });

  it("repeats full batches until a short batch and honors the hard batch cap", async () => {
    const deleteBatch = vi
      .fn<(batchSize: number) => Promise<number>>()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    await expect(
      drainBoundedBatches({
        batchSize: 2,
        deleteBatch,
        maximumBatches: 5,
      }),
    ).resolves.toEqual({
      batchesExecuted: 3,
      deleted: 5,
      reachedBatchLimit: false,
      stoppedEarly: false,
    });
    expect(deleteBatch).toHaveBeenCalledTimes(3);

    await expect(
      drainBoundedBatches({
        batchSize: 1,
        deleteBatch: () => Promise.resolve(1),
        maximumBatches: 2,
      }),
    ).resolves.toEqual({
      batchesExecuted: 2,
      deleted: 2,
      reachedBatchLimit: true,
      stoppedEarly: false,
    });
  });

  it("continues after one failed iteration and exits promptly on abort", async () => {
    const controller = new AbortController();
    const failure = new Error("database unavailable");
    const onError = vi.fn();
    const worker = {
      runOnce: vi.fn((): Promise<CloudMaintenanceRunResult> => {
        if (worker.runOnce.mock.calls.length === 1) {
          return Promise.reject(failure);
        }
        controller.abort();
        return Promise.resolve(emptyRunResult());
      }),
    };
    const wait = vi.fn(() => Promise.resolve());

    await runPeriodicCloudMaintenance({
      intervalMs: 30_000,
      onError,
      signal: controller.signal,
      wait,
      worker,
    });

    expect(worker.runOnce).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

function emptyRunResult(): CloudMaintenanceRunResult {
  return {
    acquiredLock: true,
    batchesExecuted: 0,
    deleted: {
      ciphertextChunks: 0,
      idempotencyRecords: 0,
      identityChallenges: 0,
      rateLimitWindows: 0,
      sessions: 0,
      syncBatches: 0,
      tombstones: 0,
    },
    stoppedEarly: false,
    tenantsVisited: 0,
  };
}
