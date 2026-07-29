import { fileURLToPath } from "node:url";

import { loadCloudApiConfiguration } from "./config.js";
import { runPeriodicCloudDeletion } from "./deletion/periodic-runner.js";
import { HttpChallengeNotifier } from "./delivery/http-challenge-notifier.js";
import { HttpTeamInvitationNotifier } from "./delivery/http-team-invitation-notifier.js";
import { enterpriseLicenseIsCurrentlyValid } from "./enterprise/configuration.js";
import { EnterpriseOidcClient } from "./enterprise/oidc-client.js";
import { createCloudApiServer } from "./http/server.js";
import { runPeriodicCloudMaintenance } from "./maintenance/periodic-runner.js";
import { CloudMetricsRegistry } from "./operations/metrics.js";
import {
  assertCloudRuntimeDatabaseSecurity,
  configureCloudDatabaseRoleSeparation,
} from "./postgres/database-roles.js";
import { loadCloudMigrationDatabaseConfiguration } from "./postgres/configuration.js";
import { PostgresCloudIdentityStore } from "./postgres/identity-store.js";
import { PostgresCloudEnterpriseStore } from "./postgres/enterprise-store.js";
import { PostgresCloudMaintenanceWorker } from "./postgres/maintenance-worker.js";
import { PostgresCloudMarketplaceStore } from "./postgres/marketplace-store.js";
import { CURRENT_CLOUD_SCHEMA_VERSION, runCloudMigrations } from "./postgres/migrations.js";
import { createCloudPostgresPool } from "./postgres/pool.js";
import { PostgresTeamInvitationOutboxStore } from "./postgres/team-invitation-outbox-store.js";
import { PostgresCloudDeletionStore } from "./postgres/deletion-store.js";
import { PostgresCloudDeletionWorker } from "./postgres/deletion-worker.js";
import { PostgresCloudProjectStore } from "./postgres/project-store.js";
import { PostgresFixedWindowRateLimiter } from "./postgres/rate-limiter.js";
import { PostgresCloudReviewStore } from "./postgres/review-store.js";
import { PostgresCloudTeamStore } from "./postgres/team-store.js";
import { PostgresCloudAiUsageStore } from "./postgres/usage-store.js";
import { PostgresCloudTeamTemplateStore } from "./postgres/team-template-store.js";
import { CloudPageCursorCodec } from "./security/page-cursor.js";
import { CloudMarketplaceCursorCodec } from "./security/marketplace-cursor.js";
import { ScryptPasswordHasher } from "./security/passwords.js";
import { Aes256GcmTeamInvitationTokenProtector } from "./security/team-invitation-token-protector.js";
import { SyncCursorCodec } from "./security/sync-cursor.js";
import { SyncSnapshotCursorCodec } from "./security/sync-snapshot-cursor.js";
import { CloudTokenService } from "./security/tokens.js";
import { createMonotonicUuidV7Factory } from "./security/uuid-v7.js";
import { CloudIdentityService } from "./service/identity-service.js";
import { CloudEnterpriseOidcService } from "./service/enterprise-oidc-service.js";
import { CloudEnterprisePolicyService } from "./service/enterprise-policy-service.js";
import { CloudDeletionDomainService } from "./service/cloud-deletion-service.js";
import { CloudProjectSyncService } from "./service/project-sync-service.js";
import { TeamInvitationOutboxWorker } from "./service/team-invitation-outbox-worker.js";
import {
  CloudTeamService,
  UnavailableTeamInvitationTokenProtector,
} from "./service/team-service.js";
import { CloudTeamProjectKeyService } from "./service/team-project-key-service.js";
import { CloudReviewService } from "./service/review-service.js";
import { CloudAiUsageService } from "./service/usage-service.js";
import { CloudTeamTemplateService } from "./service/team-template-service.js";
import { CloudMarketplaceService } from "./service/marketplace-service.js";
import { parseCloudStartupMode } from "./startup-mode.js";
import { runPeriodicTeamInvitationOutbox } from "./team/outbox-periodic-runner.js";

async function main(): Promise<void> {
  const startupMode = parseCloudStartupMode(process.argv.slice(2));
  if (startupMode === "migrate-only") {
    await runMigrationsOnly();
    return;
  }
  await runCloudApi();
}

async function runMigrationsOnly(): Promise<void> {
  const configuration = loadCloudMigrationDatabaseConfiguration(process.env);
  const migrationPool = createCloudPostgresPool({
    certificateAuthority: configuration.databaseCertificateAuthority,
    connectionString: configuration.databaseMigrationUrl,
    applicationName: "inkshadow-cloud-migrations",
    maximumConnections: 1,
    requireTls: configuration.requireDatabaseTls,
  });
  try {
    const migrationResult = await runCloudMigrations(
      migrationPool,
      fileURLToPath(new URL("../migrations/", import.meta.url)),
      configuration.databaseRolesSeparated
        ? async (client) => {
            await configureCloudDatabaseRoleSeparation(client, {
              migrationRole: configuration.databaseMigrationRole,
              runtimeRole: configuration.databaseRuntimeRole,
            });
          }
        : undefined,
    );
    assertCurrentSchemaVersion(migrationResult.currentVersion);
  } finally {
    await migrationPool.end();
  }
}

async function runCloudApi(): Promise<void> {
  const configuration = loadCloudApiConfiguration();
  const databaseRoles = {
    migrationRole: configuration.databaseMigrationRole,
    runtimeRole: configuration.databaseRuntimeRole,
  };
  if (configuration.appEnvironment !== "production") {
    if (configuration.databaseRolesSeparated) {
      throw new Error(
        "Separated non-production database roles require an explicit --migrate-only run before the API starts.",
      );
    }
    const developmentMigrationPool = createCloudPostgresPool({
      certificateAuthority: configuration.databaseCertificateAuthority,
      connectionString: configuration.databaseUrl,
      applicationName: "inkshadow-cloud-development-migrations",
      maximumConnections: 1,
      requireTls: configuration.requireDatabaseTls,
    });
    try {
      const migrationResult = await runCloudMigrations(
        developmentMigrationPool,
        fileURLToPath(new URL("../migrations/", import.meta.url)),
      );
      assertCurrentSchemaVersion(migrationResult.currentVersion);
    } finally {
      await developmentMigrationPool.end();
    }
  }

  const pool = createCloudPostgresPool({
    certificateAuthority: configuration.databaseCertificateAuthority,
    connectionString: configuration.databaseUrl,
    applicationName: "inkshadow-cloud-api",
    maximumConnections: 20,
    requireTls: configuration.requireDatabaseTls,
  });
  try {
    if (configuration.databaseRolesSeparated) {
      await assertCloudRuntimeDatabaseSecurity(pool, databaseRoles);
    }
  } catch (cause: unknown) {
    await pool.end();
    throw cause;
  }

  const uuid = createMonotonicUuidV7Factory();
  const metrics = new CloudMetricsRegistry({
    deploymentMode: configuration.deploymentMode,
    licenseExpiryTimestampSeconds:
      configuration.enterprise.license === null
        ? null
        : Date.parse(configuration.enterprise.license.validUntil) / 1_000,
    licenseNotBeforeTimestampSeconds:
      configuration.enterprise.license === null
        ? null
        : Date.parse(configuration.enterprise.license.notBefore) / 1_000,
    poolSnapshot: () => ({
      idleConnections: pool.idleCount,
      totalConnections: pool.totalCount,
      waitingRequests: pool.waitingCount,
    }),
  });
  const passwordHasher = new ScryptPasswordHasher();
  const pageCursorCodec = new CloudPageCursorCodec(configuration.pageCursorKey);
  const enterpriseStore = new PostgresCloudEnterpriseStore(pool);
  const enterprisePolicyService = new CloudEnterprisePolicyService({
    configuration: configuration.enterprise,
    store: enterpriseStore,
    uuid,
  });
  const identityService = new CloudIdentityService({
    minimumClientVersion: configuration.minimumClientVersion,
    notifier: new HttpChallengeNotifier({
      endpoint: configuration.challengeDeliveryEndpoint,
      token: configuration.challengeDeliveryToken,
    }),
    pageCursorCodec,
    passwordHasher,
    passwordLoginPolicy: enterprisePolicyService,
    store: new PostgresCloudIdentityStore(pool),
    tokenService: new CloudTokenService({
      challengeCodeKey: configuration.challengeCodeKey,
      challengeHashKey: configuration.challengeHashKey,
      sessionTokenKey: configuration.sessionTokenKey,
    }),
    uuid,
  });
  const enterpriseOidcService = new CloudEnterpriseOidcService({
    configuration: configuration.enterprise,
    identityService,
    oidcClient: new EnterpriseOidcClient({
      cacheMs: configuration.enterprise.metadataCacheMs,
    }),
    store: enterpriseStore,
    uuid,
  });
  const deletionService = new CloudDeletionDomainService({
    backupRetentionMs: configuration.deletion.backupRetentionMs,
    gracePeriodMs: configuration.deletion.gracePeriodMs,
    passwordHasher,
    store: new PostgresCloudDeletionStore(pool),
    uuid,
  });
  const projectSyncService = new CloudProjectSyncService({
    cursorCodec: new SyncCursorCodec(configuration.syncCursorKey),
    snapshotCursorCodec: new SyncSnapshotCursorCodec(configuration.syncCursorKey),
    store: new PostgresCloudProjectStore(pool),
    uuid,
  });
  const teamInvitationTokenProtector =
    configuration.teamInvitationDelivery === null
      ? new UnavailableTeamInvitationTokenProtector()
      : new Aes256GcmTeamInvitationTokenProtector({
          keys: configuration.teamInvitationDelivery.encryptionKeys,
          primaryKeyId: configuration.teamInvitationDelivery.encryptionKeyId,
        });
  const teamService = new CloudTeamService({
    invitationTokenProtector: teamInvitationTokenProtector,
    pageCursorCodec,
    store: new PostgresCloudTeamStore(pool),
    uuid,
  });
  const teamProjectKeyService = new CloudTeamProjectKeyService({
    store: new PostgresCloudTeamStore(pool),
    uuid,
  });
  const reviewService = new CloudReviewService({
    pageCursorCodec,
    store: new PostgresCloudReviewStore(pool),
    uuid,
  });
  const usageService = new CloudAiUsageService({
    pageCursorCodec,
    store: new PostgresCloudAiUsageStore(pool),
    uuid,
  });
  const teamTemplateService = new CloudTeamTemplateService({
    pageCursorCodec,
    store: new PostgresCloudTeamTemplateStore(pool),
    uuid,
  });
  const marketplaceService =
    configuration.marketplace.cursorKey === null
      ? undefined
      : new CloudMarketplaceService({
          cursorCodec: new CloudMarketplaceCursorCodec(configuration.marketplace.cursorKey),
          enabled: configuration.marketplace.enabled,
          store: new PostgresCloudMarketplaceStore(pool),
          uuid,
        });
  const server = createCloudApiServer({
    deletionService,
    enterpriseOidcService,
    enterprisePolicyService,
    identityService,
    metrics,
    metricsBearerTokenHash: configuration.metricsBearerTokenHash,
    ...(marketplaceService === undefined ? {} : { marketplaceService }),
    projectSyncService,
    rateLimiter: new PostgresFixedWindowRateLimiter(pool),
    readinessCheck: async () => {
      if (
        configuration.deploymentMode === "private" &&
        !enterpriseLicenseIsCurrentlyValid(
          configuration.enterprise,
          new Date(),
          "enterprise.private_deployment",
        )
      ) {
        return false;
      }
      try {
        const client = await pool.connect();
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL statement_timeout = '2000ms'");
          await client.query("SELECT 1");
          await client.query("COMMIT");
        } catch (error: unknown) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        return true;
      } catch {
        return false;
      }
    },
    requireHttps: configuration.requireHttps,
    reviewService,
    teamProjectKeyService,
    teamService,
    teamTemplateService,
    usageService,
    trustProxy: configuration.trustedProxies === false ? false : [...configuration.trustedProxies],
    uuid,
  });
  const maintenanceAbortController = new AbortController();
  const maintenancePromise = runPeriodicCloudMaintenance({
    intervalMs: configuration.maintenance.intervalMs,
    onError: () => {
      process.stderr.write("InkShadow cloud maintenance iteration failed.\n");
    },
    signal: maintenanceAbortController.signal,
    worker: new PostgresCloudMaintenanceWorker(pool, configuration.maintenance),
  }).catch(() => {
    process.stderr.write("InkShadow cloud maintenance runner stopped unexpectedly.\n");
  });
  const deletionAbortController = new AbortController();
  const deletionPromise = runPeriodicCloudDeletion({
    intervalMs: configuration.deletion.intervalMs,
    onError: () => {
      process.stderr.write("InkShadow cloud deletion iteration failed.\n");
    },
    signal: deletionAbortController.signal,
    worker: new PostgresCloudDeletionWorker(pool, {
      batchSize: configuration.deletion.batchSize,
      blockedRecheckMs: configuration.deletion.blockedRecheckMs,
      leaseDurationMs: configuration.deletion.leaseDurationMs,
      retryDelayMs: configuration.deletion.retryDelayMs,
      tenantsPerRun: configuration.deletion.tenantsPerRun,
      workerId: configuration.deletion.workerId ?? `inkshadow-cloud-api:${String(process.pid)}`,
    }),
  }).catch(() => {
    process.stderr.write("InkShadow cloud deletion runner stopped unexpectedly.\n");
  });
  const teamInvitationAbortController = new AbortController();
  const teamInvitationPromise =
    configuration.teamInvitationDelivery === null
      ? Promise.resolve()
      : runPeriodicTeamInvitationOutbox({
          intervalMs: 5_000,
          onError: () => {
            process.stderr.write("InkShadow team invitation delivery iteration failed.\n");
          },
          signal: teamInvitationAbortController.signal,
          worker: new TeamInvitationOutboxWorker({
            delivery: new HttpTeamInvitationNotifier({
              endpoint: configuration.teamInvitationDelivery.endpoint,
              token: configuration.teamInvitationDelivery.token,
            }),
            protector: teamInvitationTokenProtector,
            store: new PostgresTeamInvitationOutboxStore(pool),
            workerId: uuid(),
          }),
        }).catch(() => {
          process.stderr.write("InkShadow team invitation delivery runner stopped unexpectedly.\n");
        });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      maintenanceAbortController.abort();
      deletionAbortController.abort();
      teamInvitationAbortController.abort();
      await server.close();
      await Promise.all([maintenancePromise, deletionPromise, teamInvitationPromise]);
      await pool.end();
    })();
    return shutdownPromise;
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  try {
    await server.listen({
      host: configuration.host,
      port: configuration.port,
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

function assertCurrentSchemaVersion(currentVersion: number): void {
  if (currentVersion !== CURRENT_CLOUD_SCHEMA_VERSION) {
    throw new Error("InkShadow cloud migrations did not reach the required schema version.");
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error && /^[A-Z0-9_ .:-]+$/iu.test(error.message)
      ? error.message
      : "InkShadow cloud API failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
