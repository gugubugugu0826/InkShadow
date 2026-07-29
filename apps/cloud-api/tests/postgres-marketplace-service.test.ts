import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CloudMarketplaceSubmissionRequestSchema,
  canonicalMarketplaceJson,
  expectedMarketplaceHighRiskConfirmation,
  marketplaceSubmissionSignaturePayload,
  type CloudMarketplaceSubmissionRequest,
} from "@inkshadow/contracts/marketplace";
import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { Pool } from "pg";

import type { CloudMarketplaceActor } from "../src/domain/marketplace-records.js";
import { CloudMarketplaceCursorCodec } from "../src/security/marketplace-cursor.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import { PostgresCloudMarketplaceStore } from "../src/postgres/marketplace-store.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { CloudMarketplaceService } from "../src/service/marketplace-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-29T03:00:00.000Z");

describePostgres("PostgreSQL community marketplace service", () => {
  let pool: Pool;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  let service: CloudMarketplaceService;
  let author: CloudMarketplaceActor;
  let reporter: CloudMarketplaceActor;
  let operator: CloudMarketplaceActor;
  let weakOperator: CloudMarketplaceActor;
  let lifecycleArtifactId: string;
  let lifecycleVersionId: string;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      applicationName: "inkshadow-marketplace-test",
      connectionString: databaseUrl,
      maximumConnections: 8,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    author = actor(uuid(), "member", true);
    reporter = actor(uuid(), "member", true);
    operator = actor(uuid(), "platform_ops", true);
    weakOperator = { ...operator, strongMfa: false };
    await seedAccount(pool, author.accountId, `market-author-${author.accountId}@example.test`);
    await seedAccount(
      pool,
      reporter.accountId,
      `market-reporter-${reporter.accountId}@example.test`,
    );
    await seedAccount(
      pool,
      operator.accountId,
      `market-operator-${operator.accountId}@example.test`,
    );
    service = marketplaceService(pool, uuid, true);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("is disabled by default and fails closed before touching the repository", async () => {
    const disabled = new CloudMarketplaceService({
      cursorCodec: new CloudMarketplaceCursorCodec(Buffer.alloc(32, 0x44)),
      store: new PostgresCloudMarketplaceStore(pool),
      uuid,
    });
    await expect(
      disabled.listCatalog(author, null, null, 50, { requestId: uuid() }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("enforces signed versioning, MFA moderation, report quarantine, appeal and retention", async () => {
    const artifactId = uuid();
    const versionId = uuid();
    lifecycleArtifactId = artifactId;
    lifecycleVersionId = versionId;
    const submission = signedSubmission(author.accountId, artifactId, versionId);
    const created = await service.submitVersion(
      author,
      submission,
      mutation(uuid(), "market-submit-idempotency-0001"),
    );
    const replay = await service.submitVersion(
      author,
      submission,
      mutation(uuid(), "market-submit-idempotency-0001"),
    );
    expect(replay.requestId).not.toBe(created.requestId);
    expect(replay.artifact).toEqual(created.artifact);
    expect(created).toMatchObject({
      artifact: { state: "pending_review", revision: 1, latestVersionNumber: 1 },
      version: { state: "pending_review", versionNumber: 1 },
    });

    const differentSubmission = signedSubmission(author.accountId, uuid(), uuid());
    await expect(
      service.submitVersion(
        author,
        differentSubmission,
        mutation(uuid(), "market-submit-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const approval = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      action: "approve" as const,
      confirmation: expectedMarketplaceHighRiskConfirmation("approve", versionId),
      expectedRevision: created.artifact.revision,
      reason: "Verified structured data, license, digest and author signature.",
    };
    await expect(
      service.moderateVersion(
        reporter,
        artifactId,
        versionId,
        approval,
        mutation(uuid(), "market-member-review-denied-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    await expect(
      service.moderateVersion(
        weakOperator,
        artifactId,
        versionId,
        approval,
        mutation(uuid(), "market-weak-mfa-denied-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    await expect(
      service.moderateVersion(
        operator,
        artifactId,
        versionId,
        { ...approval, confirmation: "APPROVE" },
        mutation(uuid(), "market-confirmation-denied-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const published = await service.moderateVersion(
      operator,
      artifactId,
      versionId,
      approval,
      mutation(uuid(), "market-approve-idempotency-0001"),
    );
    expect(published).toMatchObject({
      artifact: { state: "published", revision: 2, publishedVersionId: versionId },
      version: { state: "published" },
    });
    const catalog = await service.listCatalog(reporter, null, null, 50, {
      requestId: uuid(),
    });
    expect(catalog.artifacts.map((artifact) => artifact.artifactId)).toEqual([artifactId]);

    const downloaded = await service.download(
      reporter,
      artifactId,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, versionId },
      mutation(uuid(), "market-download-idempotency-0001"),
    );
    expect(downloaded.content.sections[0]?.items[0]).toMatchObject({
      itemId: "premise",
      kind: "text",
    });
    expect(Date.parse(downloaded.retentionUntil) - now.getTime()).toBe(90 * 24 * 60 * 60 * 1_000);
    await expect(
      service.download(
        operator,
        artifactId,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, versionId },
        mutation(uuid(), "market-operator-download-denied-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const reportId = uuid();
    const reported = await service.reportVersion(
      reporter,
      artifactId,
      versionId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        reportId,
        category: "copyright",
        reason: "The submitter appears not to own the source template rights.",
      },
      mutation(uuid(), "market-report-idempotency-0001"),
    );
    expect(reported).toMatchObject({
      report: { state: "open" },
      artifact: { state: "quarantined", revision: 3 },
      version: { state: "quarantined" },
    });
    expect(Date.parse(reported.report.retentionUntil) - now.getTime()).toBe(
      90 * 24 * 60 * 60 * 1_000,
    );
    await expect(
      service.download(
        reporter,
        artifactId,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, versionId },
        mutation(uuid(), "market-download-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(
      (
        await service.listCatalog(reporter, null, null, 50, {
          requestId: uuid(),
        })
      ).artifacts,
    ).toEqual([]);

    const queue = await service.listModerationQueue(operator, null, 50, {
      requestId: uuid(),
    });
    const serializedQueue = JSON.stringify(queue);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.artifact.artifactId).toBe(artifactId);
    expect(queue.items[0]?.artifact.state).toBe("quarantined");
    expect(queue.items[0]?.openReportCount).toBe(1);
    expect(serializedQueue).not.toContain("cartographer");
    expect(serializedQueue).not.toContain("authorPublicKeySpki");
    expect(serializedQueue).not.toContain("authorSignature");
    expect(serializedQueue).not.toContain('"content"');

    const upheld = await service.disposeReport(
      operator,
      reportId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        confirmation: expectedMarketplaceHighRiskConfirmation("report_uphold", reportId),
        disposition: "uphold",
        expectedRevision: reported.artifact.revision,
        reason: "Copyright evidence requires continued quarantine pending author appeal.",
      },
      mutation(uuid(), "market-report-uphold-idempotency-0001"),
    );
    expect(upheld).toMatchObject({
      report: { state: "upheld" },
      artifact: { state: "quarantined", revision: 3 },
    });

    const appealId = uuid();
    const appealed = await service.appealVersion(
      author,
      artifactId,
      versionId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        appealId,
        expectedRevision: upheld.artifact.revision,
        reason: "I can provide the original source history and the stated license grant.",
      },
      mutation(uuid(), "market-appeal-idempotency-0001"),
    );
    expect(appealed).toMatchObject({
      appeal: { sourceState: "quarantined", state: "open" },
      artifact: { state: "appeal_pending", revision: 4 },
    });

    const restored = await service.disposeAppeal(
      operator,
      appealId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        confirmation: expectedMarketplaceHighRiskConfirmation("appeal_accept", appealId),
        disposition: "accept",
        expectedRevision: appealed.artifact.revision,
        reason: "Original source history and the license grant were independently verified.",
      },
      mutation(uuid(), "market-appeal-accept-idempotency-0001"),
    );
    expect(restored).toMatchObject({
      appeal: { state: "accepted" },
      artifact: { state: "published", revision: 5 },
      version: { state: "published" },
    });

    const withdrawn = await service.withdrawVersion(
      author,
      artifactId,
      versionId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: restored.artifact.revision,
        reason: "The author is retiring this edition and preserving existing local installs.",
      },
      mutation(uuid(), "market-withdraw-idempotency-0001"),
    );
    expect(withdrawn).toMatchObject({
      artifact: { state: "author_withdrawn", publishedVersionId: null, revision: 6 },
      version: { state: "author_withdrawn" },
    });
    expect(Date.parse(withdrawn.artifact.retentionUntil ?? "") - now.getTime()).toBe(
      90 * 24 * 60 * 60 * 1_000,
    );

    const auditCounts = await pool.query<{
      readonly denied: string;
      readonly downloads: string;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM cloud_marketplace_moderation_events
           WHERE result = 'denied'
             AND artifact_id = $1
         ) AS denied,
         (
           SELECT count(*)::text
           FROM cloud_marketplace_download_audits
           WHERE artifact_id = $1
         ) AS downloads`,
      [artifactId],
    );
    expect(auditCounts.rows[0]).toEqual({ denied: "3", downloads: "1" });
  });

  it("keeps signed bodies invisible to platform operations at the database boundary", async () => {
    const store = new PostgresCloudMarketplaceStore(pool);
    const version = await store.transaction(operator, (transaction) =>
      transaction.findVersion(lifecycleArtifactId, lifecycleVersionId),
    );
    expect(version).toMatchObject({
      artifactId: lifecycleArtifactId,
      versionId: lifecycleVersionId,
    });
    expect(version?.content).toBeNull();
    expect(version?.authorPublicKeySpki).toBeNull();
    expect(version?.authorSignature).toBeNull();
    const forced = await pool.query<{ readonly relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity
       FROM pg_class
       WHERE oid = 'cloud_marketplace_version_bodies'::regclass`,
    );
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
  });
});

function marketplaceService(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  enabled: boolean,
): CloudMarketplaceService {
  return new CloudMarketplaceService({
    clock: () => now,
    cursorCodec: new CloudMarketplaceCursorCodec(Buffer.alloc(32, 0x6d)),
    enabled,
    store: new PostgresCloudMarketplaceStore(pool),
    uuid,
  });
}

function actor(
  accountId: string,
  platformRole: CloudMarketplaceActor["platformRole"],
  strongMfa: boolean,
): CloudMarketplaceActor {
  return {
    accountId,
    deviceId: accountId,
    platformRole,
    strongMfa,
  };
}

async function seedAccount(pool: Pool, accountId: string, email: string): Promise<void> {
  await pool.query(
    `INSERT INTO cloud_accounts (
       account_id,
       email_canonical,
       password_hash,
       state,
       revision,
       verified_at,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, 'active', 1, $4, $4, $4)`,
    [accountId, email, "p".repeat(64), now],
  );
}

function signedSubmission(
  authorAccountId: string,
  artifactId: string,
  versionId: string,
): CloudMarketplaceSubmissionRequest {
  const keyPair = generateKeyPairSync("ed25519");
  const unsigned = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId,
    versionId,
    versionNumber: 1,
    semanticVersion: "1.0.0",
    authorAccountId,
    authorDisplayName: "Ink Cartographer",
    kind: "story_template" as const,
    title: "The Vanished City",
    summary: "A structured story seed for mystery adventures.",
    tags: ["adventure", "mystery"],
    license: "cc-by-4.0" as const,
    content: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      format: "inkshadow.marketplace.structured-artifact.v1" as const,
      sections: [
        {
          sectionId: "story_seed",
          title: "Story seed",
          items: [
            {
              itemId: "premise",
              kind: "text" as const,
              label: "Premise",
              value: "A cartographer discovers a city erased from every map.",
            },
          ],
        },
      ],
    },
  };
  const payload = Buffer.from(
    canonicalMarketplaceJson(marketplaceSubmissionSignaturePayload(unsigned)),
    "utf8",
  );
  const request = {
    ...unsigned,
    contentDigestSha256: createHash("sha256").update(payload).digest("hex"),
    authorPublicKeySpki: keyPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    authorSignature: sign(null, payload, keyPair.privateKey).toString("base64url"),
  };
  payload.fill(0);
  return CloudMarketplaceSubmissionRequestSchema.parse(request);
}

function mutation(requestId: string, idempotencyKey: string) {
  return { requestId, idempotencyKey };
}
