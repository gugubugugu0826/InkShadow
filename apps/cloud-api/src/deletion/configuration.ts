const SECOND_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

export interface CloudDeletionConfiguration {
  readonly backupRetentionMs: number;
  readonly batchSize: number;
  readonly blockedRecheckMs: number;
  readonly gracePeriodMs: number;
  readonly intervalMs: number;
  readonly leaseDurationMs: number;
  readonly retryDelayMs: number;
  readonly tenantsPerRun: number;
  readonly workerId: string | null;
}

export const DEFAULT_CLOUD_DELETION_CONFIGURATION: CloudDeletionConfiguration = Object.freeze({
  backupRetentionMs: 30 * DAY_MS,
  batchSize: 250,
  blockedRecheckMs: 5 * 60 * SECOND_MS,
  gracePeriodMs: 30 * DAY_MS,
  intervalMs: 30 * SECOND_MS,
  leaseDurationMs: 30 * SECOND_MS,
  retryDelayMs: 60 * SECOND_MS,
  tenantsPerRun: 32,
  workerId: null,
});

export function loadCloudDeletionConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): CloudDeletionConfiguration {
  return Object.freeze({
    backupRetentionMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_DELETION_BACKUP_RETENTION_DAYS",
        DEFAULT_CLOUD_DELETION_CONFIGURATION.backupRetentionMs / DAY_MS,
        0,
        3_650,
      ) * DAY_MS,
    batchSize: parseBoundedInteger(
      environment,
      "INKSHADOW_CLOUD_DELETION_BATCH_SIZE",
      DEFAULT_CLOUD_DELETION_CONFIGURATION.batchSize,
      1,
      2_000,
    ),
    blockedRecheckMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_DELETION_BLOCKED_RECHECK_SECONDS",
        DEFAULT_CLOUD_DELETION_CONFIGURATION.blockedRecheckMs / SECOND_MS,
        1,
        86_400,
      ) * SECOND_MS,
    gracePeriodMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_DELETION_GRACE_DAYS",
        DEFAULT_CLOUD_DELETION_CONFIGURATION.gracePeriodMs / DAY_MS,
        1,
        365,
      ) * DAY_MS,
    intervalMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_DELETION_INTERVAL_SECONDS",
        DEFAULT_CLOUD_DELETION_CONFIGURATION.intervalMs / SECOND_MS,
        1,
        86_400,
      ) * SECOND_MS,
    leaseDurationMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_DELETION_LEASE_SECONDS",
        DEFAULT_CLOUD_DELETION_CONFIGURATION.leaseDurationMs / SECOND_MS,
        1,
        600,
      ) * SECOND_MS,
    retryDelayMs:
      parseBoundedInteger(
        environment,
        "INKSHADOW_CLOUD_DELETION_RETRY_SECONDS",
        DEFAULT_CLOUD_DELETION_CONFIGURATION.retryDelayMs / SECOND_MS,
        1,
        86_400,
      ) * SECOND_MS,
    tenantsPerRun: parseBoundedInteger(
      environment,
      "INKSHADOW_CLOUD_DELETION_TENANTS_PER_RUN",
      DEFAULT_CLOUD_DELETION_CONFIGURATION.tenantsPerRun,
      1,
      128,
    ),
    workerId: parseWorkerId(environment.INKSHADOW_CLOUD_DELETION_WORKER_ID),
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

function parseWorkerId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return null;
  }
  if (trimmed.length > 100 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("INKSHADOW_CLOUD_DELETION_WORKER_ID is invalid.");
  }
  return trimmed;
}
