const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export interface CloudMaintenanceConfiguration {
  /**
   * A short post-expiry grace for completed idempotency responses. The
   * application-level expiry remains authoritative; this only delays physical
   * deletion.
   */
  readonly idempotencyGraceMs: number;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly maximumBatchesPerTarget: number;
  /**
   * Completed or expired one-time challenges remain available for short-lived,
   * content-free operational investigation.
   */
  readonly challengeRetentionMs: number;
  /**
   * Session hashes remain past refresh expiry so refresh-token replay evidence
   * is not removed early.
   */
  readonly sessionRetentionMs: number;
  /**
   * A completed sync batch is an idempotent response cache, not project
   * content. Thirty days is deliberately longer than the public 24-hour
   * idempotency contract.
   */
  readonly syncBatchRetentionMs: number;
  /**
   * The product policy requires an additional thirty days after both the
   * tombstone retention date and the final currently trusted device
   * acknowledgement.
   */
  readonly tombstoneAcknowledgementGraceMs: number;
}

export const DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION: CloudMaintenanceConfiguration = Object.freeze(
  {
    batchSize: 250,
    challengeRetentionMs: 7 * DAY_MS,
    idempotencyGraceMs: 24 * HOUR_MS,
    intervalMs: 5 * 60 * 1_000,
    maximumBatchesPerTarget: 8,
    sessionRetentionMs: 30 * DAY_MS,
    syncBatchRetentionMs: 30 * DAY_MS,
    tombstoneAcknowledgementGraceMs: 30 * DAY_MS,
  },
);

export function loadCloudMaintenanceConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): CloudMaintenanceConfiguration {
  return Object.freeze({
    batchSize: parseBoundedInteger(
      environment,
      "INKSHADOW_CLOUD_MAINTENANCE_BATCH_SIZE",
      DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.batchSize,
      10,
      2_000,
    ),
    challengeRetentionMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_CHALLENGE_RETENTION_DAYS",
        DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.challengeRetentionMs / DAY_MS,
        1,
        90,
      ) * DAY_MS,
    idempotencyGraceMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_IDEMPOTENCY_GRACE_HOURS",
        DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.idempotencyGraceMs / HOUR_MS,
        0,
        168,
      ) * HOUR_MS,
    intervalMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_MAINTENANCE_INTERVAL_SECONDS",
        DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.intervalMs / 1_000,
        30,
        86_400,
      ) * 1_000,
    maximumBatchesPerTarget: parseBoundedInteger(
      environment,
      "INKSHADOW_CLOUD_MAINTENANCE_MAX_BATCHES_PER_TARGET",
      DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.maximumBatchesPerTarget,
      1,
      100,
    ),
    sessionRetentionMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_SESSION_RETENTION_DAYS",
        DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.sessionRetentionMs / DAY_MS,
        7,
        365,
      ) * DAY_MS,
    syncBatchRetentionMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_SYNC_BATCH_RETENTION_DAYS",
        DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.syncBatchRetentionMs / DAY_MS,
        7,
        365,
      ) * DAY_MS,
    tombstoneAcknowledgementGraceMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_TOMBSTONE_ACK_GRACE_DAYS",
        DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION.tombstoneAcknowledgementGraceMs / DAY_MS,
        30,
        365,
      ) * DAY_MS,
  });
}

function parseBoundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^(0|[1-9]\d*)$/u.test(raw)) {
    throw new Error(`${name} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${String(minimum)} and ${String(maximum)}.`);
  }
  return value;
}
