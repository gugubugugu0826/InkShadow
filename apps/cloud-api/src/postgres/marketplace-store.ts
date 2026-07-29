import type { Pool, PoolClient } from "pg";

import type {
  CloudMarketplaceActor,
  CloudMarketplaceAppealRecord,
  CloudMarketplaceArtifactRecord,
  CloudMarketplaceDownloadAuditRecord,
  CloudMarketplaceIdempotencyRecord,
  CloudMarketplaceModerationEventRecord,
  CloudMarketplaceModerationQueueRecord,
  CloudMarketplacePageAnchor,
  CloudMarketplaceReportRecord,
  CloudMarketplaceVersionRecord,
} from "../domain/marketplace-records.js";
import type {
  CloudMarketplaceStore,
  CloudMarketplaceTransaction,
} from "../repository/marketplace-store.js";

interface MarketplaceArtifactRow {
  readonly artifact_id: string;
  readonly author_account_id: string;
  readonly author_display_name: string;
  readonly created_at: Date;
  readonly kind: CloudMarketplaceArtifactRecord["kind"];
  readonly latest_version_number: number;
  readonly license: CloudMarketplaceArtifactRecord["license"];
  readonly pending_version_id: string | null;
  readonly published_at: Date | null;
  readonly published_version_id: string | null;
  readonly quarantined_at: Date | null;
  readonly retention_until: Date | null;
  readonly revision: number;
  readonly state: CloudMarketplaceArtifactRecord["state"];
  readonly summary: string;
  readonly tags: string[];
  readonly title: string;
  readonly updated_at: Date;
  readonly withdrawn_at: Date | null;
}

interface MarketplaceVersionRow {
  readonly artifact_id: string;
  readonly author_display_name: string;
  readonly author_public_key_spki: string | null;
  readonly author_signature: string | null;
  readonly author_signing_key_fingerprint_sha256: string;
  readonly content: CloudMarketplaceVersionRecord["content"];
  readonly content_bytes: number;
  readonly content_digest_sha256: string;
  readonly created_at: Date;
  readonly kind: CloudMarketplaceVersionRecord["kind"];
  readonly license: CloudMarketplaceVersionRecord["license"];
  readonly published_at: Date | null;
  readonly quarantined_at: Date | null;
  readonly retention_until: Date | null;
  readonly reviewed_at: Date | null;
  readonly semantic_version: string;
  readonly state: CloudMarketplaceVersionRecord["state"];
  readonly submitted_at: Date;
  readonly summary: string;
  readonly tags: string[];
  readonly title: string;
  readonly version_id: string;
  readonly version_number: number;
  readonly withdrawn_at: Date | null;
}

interface MarketplaceReportRow {
  readonly artifact_id: string;
  readonly category: CloudMarketplaceReportRecord["category"];
  readonly created_at: Date;
  readonly reason: string;
  readonly report_id: string;
  readonly reporter_account_id: string;
  readonly resolved_at: Date | null;
  readonly retention_until: Date;
  readonly state: CloudMarketplaceReportRecord["state"];
  readonly version_id: string;
}

interface MarketplaceAppealRow {
  readonly appeal_id: string;
  readonly artifact_id: string;
  readonly author_account_id: string;
  readonly created_at: Date;
  readonly reason: string;
  readonly resolved_at: Date | null;
  readonly retention_until: Date;
  readonly source_state: CloudMarketplaceAppealRecord["sourceState"];
  readonly state: CloudMarketplaceAppealRecord["state"];
  readonly version_id: string;
}

interface MarketplaceIdempotencyRow {
  readonly actor_account_id: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly operation_id: string;
  readonly request_hash_sha256: string;
  readonly response_snapshot: unknown;
  readonly response_status: number;
  readonly result_digest_sha256: string;
  readonly scope_hash_sha256: string;
}

interface MarketplaceQueueRow extends MarketplaceVersionRow {
  readonly queue_appeal_id: string | null;
  readonly queue_appeal_author_account_id: string | null;
  readonly queue_appeal_created_at: Date | null;
  readonly queue_appeal_reason: string | null;
  readonly queue_appeal_resolved_at: Date | null;
  readonly queue_appeal_retention_until: Date | null;
  readonly queue_appeal_source_state: CloudMarketplaceAppealRecord["sourceState"] | null;
  readonly queue_appeal_state: CloudMarketplaceAppealRecord["state"] | null;
  readonly queue_open_report_count: string;
  readonly artifact_author_account_id: string;
  readonly artifact_author_display_name: string;
  readonly artifact_created_at: Date;
  readonly artifact_kind: CloudMarketplaceArtifactRecord["kind"];
  readonly artifact_latest_version_number: number;
  readonly artifact_license: CloudMarketplaceArtifactRecord["license"];
  readonly artifact_pending_version_id: string | null;
  readonly artifact_published_at: Date | null;
  readonly artifact_published_version_id: string | null;
  readonly artifact_quarantined_at: Date | null;
  readonly artifact_retention_until: Date | null;
  readonly artifact_revision: number;
  readonly artifact_state: CloudMarketplaceArtifactRecord["state"];
  readonly artifact_summary: string;
  readonly artifact_tags: string[];
  readonly artifact_title: string;
  readonly artifact_updated_at: Date;
  readonly artifact_withdrawn_at: Date | null;
}

export class PostgresCloudMarketplaceStore implements CloudMarketplaceStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    actor: CloudMarketplaceActor,
    operation: (transaction: CloudMarketplaceTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT
           set_config('inkshadow.account_id', $1, true),
           set_config('inkshadow.marketplace_role', $2, true)`,
        [actor.accountId, actor.platformRole],
      );
      const result = await operation(new PostgresCloudMarketplaceTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (cause: unknown) {
      await client.query("ROLLBACK").catch(() => {
        // Preserve the original transaction failure.
      });
      throw cause;
    } finally {
      client.release();
    }
  }
}

class PostgresCloudMarketplaceTransaction implements CloudMarketplaceTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async lockIdempotency(scopeHashSha256: string): Promise<void> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7727))", [
      scopeHashSha256,
    ]);
  }

  public async findIdempotency(
    scopeHashSha256: string,
  ): Promise<CloudMarketplaceIdempotencyRecord | null> {
    const result = await this.client.query<MarketplaceIdempotencyRow>(
      `SELECT
         scope_hash_sha256,
         actor_account_id,
         operation_id,
         request_hash_sha256,
         response_status,
         response_snapshot,
         result_digest_sha256,
         created_at,
         expires_at
       FROM cloud_marketplace_idempotency
       WHERE scope_hash_sha256 = $1`,
      [scopeHashSha256],
    );
    return result.rows[0] === undefined ? null : toIdempotency(result.rows[0]);
  }

  public async insertIdempotency(record: CloudMarketplaceIdempotencyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_marketplace_idempotency (
         scope_hash_sha256,
         actor_account_id,
         operation_id,
         request_hash_sha256,
         response_status,
         response_snapshot,
         result_digest_sha256,
         created_at,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (scope_hash_sha256) DO UPDATE
       SET actor_account_id = EXCLUDED.actor_account_id,
           operation_id = EXCLUDED.operation_id,
           request_hash_sha256 = EXCLUDED.request_hash_sha256,
           response_status = EXCLUDED.response_status,
           response_snapshot = EXCLUDED.response_snapshot,
           result_digest_sha256 = EXCLUDED.result_digest_sha256,
           created_at = EXCLUDED.created_at,
           expires_at = EXCLUDED.expires_at
       WHERE cloud_marketplace_idempotency.expires_at <= EXCLUDED.created_at`,
      [
        record.scopeHashSha256,
        record.actorAccountId,
        record.operationId,
        record.requestHashSha256,
        record.responseStatus,
        JSON.stringify(record.responseSnapshot),
        record.resultDigestSha256,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  public async findArtifact(
    artifactId: string,
    forUpdate = false,
  ): Promise<CloudMarketplaceArtifactRecord | null> {
    const result = await this.client.query<MarketplaceArtifactRow>(
      `${artifactSelection()}
       WHERE artifact_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [artifactId],
    );
    return result.rows[0] === undefined ? null : toArtifact(result.rows[0]);
  }

  public async findVersion(
    artifactId: string,
    versionId: string,
    forUpdate = false,
  ): Promise<CloudMarketplaceVersionRecord | null> {
    const result = await this.client.query<MarketplaceVersionRow>(
      `${versionSelection()}
       WHERE version.artifact_id = $1
         AND version.version_id = $2${forUpdate ? " FOR UPDATE OF version" : ""}`,
      [artifactId, versionId],
    );
    return result.rows[0] === undefined ? null : toVersion(result.rows[0]);
  }

  public async listCatalog(
    limit: number,
    anchor: CloudMarketplacePageAnchor | null,
    kind: CloudMarketplaceArtifactRecord["kind"] | null,
  ): Promise<readonly CloudMarketplaceArtifactRecord[]> {
    const result = await this.client.query<MarketplaceArtifactRow>(
      `${artifactSelection()}
       WHERE state = 'published'
         AND ($1::text IS NULL OR kind = $1)
         AND (
           $2::timestamptz IS NULL
           OR (updated_at, artifact_id) < ($2::timestamptz, $3::uuid)
         )
       ORDER BY updated_at DESC, artifact_id DESC
       LIMIT $4`,
      [kind, anchor?.createdAt ?? null, anchor?.id ?? null, limit],
    );
    return result.rows.map(toArtifact);
  }

  public async listModerationQueue(
    limit: number,
    anchor: CloudMarketplacePageAnchor | null,
  ): Promise<readonly CloudMarketplaceModerationQueueRecord[]> {
    const result = await this.client.query<MarketplaceQueueRow>(
      `SELECT
         version.artifact_id,
         version.version_id,
         version.version_number,
         version.semantic_version,
         version.author_display_name,
         version.kind,
         version.title,
         version.summary,
         version.tags,
         version.license,
         version.state,
         version.content_digest_sha256,
         version.author_signing_key_fingerprint_sha256,
         version.content_bytes,
         version.created_at,
         version.submitted_at,
         version.reviewed_at,
         version.published_at,
         version.quarantined_at,
         version.withdrawn_at,
         version.retention_until,
         NULL::text AS author_public_key_spki,
         NULL::text AS author_signature,
         NULL::jsonb AS content,
         artifact.author_account_id AS artifact_author_account_id,
         artifact.author_display_name AS artifact_author_display_name,
         artifact.kind AS artifact_kind,
         artifact.title AS artifact_title,
         artifact.summary AS artifact_summary,
         artifact.tags AS artifact_tags,
         artifact.license AS artifact_license,
         artifact.state AS artifact_state,
         artifact.revision AS artifact_revision,
         artifact.latest_version_number AS artifact_latest_version_number,
         artifact.pending_version_id AS artifact_pending_version_id,
         artifact.published_version_id AS artifact_published_version_id,
         artifact.created_at AS artifact_created_at,
         artifact.updated_at AS artifact_updated_at,
         artifact.published_at AS artifact_published_at,
         artifact.quarantined_at AS artifact_quarantined_at,
         artifact.withdrawn_at AS artifact_withdrawn_at,
         artifact.retention_until AS artifact_retention_until,
         appeal.appeal_id AS queue_appeal_id,
         appeal.author_account_id AS queue_appeal_author_account_id,
         appeal.source_state AS queue_appeal_source_state,
         appeal.reason AS queue_appeal_reason,
         appeal.state AS queue_appeal_state,
         appeal.created_at AS queue_appeal_created_at,
         appeal.resolved_at AS queue_appeal_resolved_at,
         appeal.retention_until AS queue_appeal_retention_until,
         (
           SELECT count(*)::text
           FROM cloud_marketplace_reports AS report
           WHERE report.artifact_id = version.artifact_id
             AND report.version_id = version.version_id
             AND report.state = 'open'
         ) AS queue_open_report_count
       FROM cloud_marketplace_versions AS version
       JOIN cloud_marketplace_artifacts AS artifact
         ON artifact.artifact_id = version.artifact_id
       LEFT JOIN cloud_marketplace_appeals AS appeal
         ON appeal.artifact_id = version.artifact_id
        AND appeal.version_id = version.version_id
        AND appeal.state = 'open'
       WHERE version.state IN ('pending_review', 'quarantined', 'appeal_pending')
         AND (
           $1::timestamptz IS NULL
           OR (version.submitted_at, version.version_id) < ($1::timestamptz, $2::uuid)
         )
       ORDER BY version.submitted_at DESC, version.version_id DESC
       LIMIT $3`,
      [anchor?.createdAt ?? null, anchor?.id ?? null, limit],
    );
    return result.rows.map(toQueueRecord);
  }

  public async insertArtifact(record: CloudMarketplaceArtifactRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_marketplace_artifacts (
         artifact_id,
         author_account_id,
         author_display_name,
         kind,
         title,
         summary,
         tags,
         license,
         state,
         revision,
         latest_version_number,
         pending_version_id,
         published_version_id,
         created_at,
         updated_at,
         published_at,
         quarantined_at,
         withdrawn_at,
         retention_until
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19
       )`,
      artifactValues(record),
    );
  }

  public async insertVersion(record: CloudMarketplaceVersionRecord): Promise<void> {
    if (
      record.content === null ||
      record.authorPublicKeySpki === null ||
      record.authorSignature === null
    ) {
      throw new Error("A marketplace submission requires a complete signed body.");
    }
    await this.client.query(
      `INSERT INTO cloud_marketplace_versions (
         artifact_id,
         version_id,
         version_number,
         semantic_version,
         author_display_name,
         kind,
         title,
         summary,
         tags,
         license,
         state,
         content_digest_sha256,
         author_signing_key_fingerprint_sha256,
         content_bytes,
         created_at,
         submitted_at,
         reviewed_at,
         published_at,
         quarantined_at,
         withdrawn_at,
         retention_until
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21
       )`,
      versionValues(record),
    );
    await this.client.query(
      `INSERT INTO cloud_marketplace_version_bodies (
         artifact_id,
         version_id,
         content,
         author_public_key_spki,
         author_signature,
         created_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        record.artifactId,
        record.versionId,
        JSON.stringify(record.content),
        record.authorPublicKeySpki,
        record.authorSignature,
        record.createdAt,
      ],
    );
  }

  public async updateArtifactCas(
    record: CloudMarketplaceArtifactRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_marketplace_artifacts
       SET author_display_name = $2,
           kind = $3,
           title = $4,
           summary = $5,
           tags = $6::text[],
           license = $7,
           state = $8,
           revision = $9,
           latest_version_number = $10,
           pending_version_id = $11,
           published_version_id = $12,
           updated_at = $13,
           published_at = $14,
           quarantined_at = $15,
           withdrawn_at = $16,
           retention_until = $17
       WHERE artifact_id = $1
         AND revision = $18`,
      [
        record.artifactId,
        record.authorDisplayName,
        record.kind,
        record.title,
        record.summary,
        [...record.tags],
        record.license,
        record.state,
        record.revision,
        record.latestVersionNumber,
        record.pendingVersionId,
        record.publishedVersionId,
        record.updatedAt,
        record.publishedAt,
        record.quarantinedAt,
        record.withdrawnAt,
        record.retentionUntil,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  }

  public async updateVersion(record: CloudMarketplaceVersionRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_marketplace_versions
       SET state = $3,
           reviewed_at = $4,
           published_at = $5,
           quarantined_at = $6,
           withdrawn_at = $7,
           retention_until = $8
       WHERE artifact_id = $1
         AND version_id = $2`,
      [
        record.artifactId,
        record.versionId,
        record.state,
        record.reviewedAt,
        record.publishedAt,
        record.quarantinedAt,
        record.withdrawnAt,
        record.retentionUntil,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Marketplace version update lost its target.");
    }
  }

  public async supersedePublishedVersion(
    artifactId: string,
    excludingVersionId: string,
    at: Date,
  ): Promise<void> {
    await this.client.query(
      `UPDATE cloud_marketplace_versions
       SET state = 'superseded',
           reviewed_at = GREATEST(COALESCE(reviewed_at, $3), $3),
           quarantined_at = NULL,
           withdrawn_at = NULL,
           retention_until = NULL
       WHERE artifact_id = $1
         AND version_id <> $2
         AND state = 'published'`,
      [artifactId, excludingVersionId, at],
    );
  }

  public async findOpenReport(
    artifactId: string,
    versionId: string,
    reporterAccountId: string,
  ): Promise<CloudMarketplaceReportRecord | null> {
    const result = await this.client.query<MarketplaceReportRow>(
      `${reportSelection()}
       WHERE artifact_id = $1
         AND version_id = $2
         AND reporter_account_id = $3
         AND state = 'open'`,
      [artifactId, versionId, reporterAccountId],
    );
    return result.rows[0] === undefined ? null : toReport(result.rows[0]);
  }

  public async findReport(
    reportId: string,
    forUpdate = false,
  ): Promise<CloudMarketplaceReportRecord | null> {
    const result = await this.client.query<MarketplaceReportRow>(
      `${reportSelection()}
       WHERE report_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [reportId],
    );
    return result.rows[0] === undefined ? null : toReport(result.rows[0]);
  }

  public async countOpenReports(artifactId: string, versionId: string): Promise<number> {
    const result = await this.client.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
       FROM cloud_marketplace_reports
       WHERE artifact_id = $1
         AND version_id = $2
         AND state = 'open'`,
      [artifactId, versionId],
    );
    return requireSafeCount(result.rows[0]?.count);
  }

  public async insertReport(record: CloudMarketplaceReportRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_marketplace_reports (
         report_id,
         artifact_id,
         version_id,
         reporter_account_id,
         category,
         reason,
         state,
         created_at,
         resolved_at,
         retention_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      reportValues(record),
    );
  }

  public async updateReport(record: CloudMarketplaceReportRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_marketplace_reports
       SET state = $2,
           resolved_at = $3,
           retention_until = $4
       WHERE report_id = $1
         AND state = 'open'`,
      [record.reportId, record.state, record.resolvedAt, record.retentionUntil],
    );
    if (result.rowCount !== 1) {
      throw new Error("Marketplace report update lost its target.");
    }
  }

  public async findOpenAppeal(
    artifactId: string,
    versionId: string,
  ): Promise<CloudMarketplaceAppealRecord | null> {
    const result = await this.client.query<MarketplaceAppealRow>(
      `${appealSelection()}
       WHERE artifact_id = $1
         AND version_id = $2
         AND state = 'open'`,
      [artifactId, versionId],
    );
    return result.rows[0] === undefined ? null : toAppeal(result.rows[0]);
  }

  public async findAppeal(
    appealId: string,
    forUpdate = false,
  ): Promise<CloudMarketplaceAppealRecord | null> {
    const result = await this.client.query<MarketplaceAppealRow>(
      `${appealSelection()}
       WHERE appeal_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [appealId],
    );
    return result.rows[0] === undefined ? null : toAppeal(result.rows[0]);
  }

  public async insertAppeal(record: CloudMarketplaceAppealRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_marketplace_appeals (
         appeal_id,
         artifact_id,
         version_id,
         author_account_id,
         source_state,
         reason,
         state,
         created_at,
         resolved_at,
         retention_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      appealValues(record),
    );
  }

  public async updateAppeal(record: CloudMarketplaceAppealRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_marketplace_appeals
       SET state = $2,
           resolved_at = $3,
           retention_until = $4
       WHERE appeal_id = $1
         AND state = 'open'`,
      [record.appealId, record.state, record.resolvedAt, record.retentionUntil],
    );
    if (result.rowCount !== 1) {
      throw new Error("Marketplace appeal update lost its target.");
    }
  }

  public async insertModerationEvent(record: CloudMarketplaceModerationEventRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_marketplace_moderation_events (
         event_id,
         actor_account_id,
         artifact_id,
         version_id,
         action,
         reason,
         confirmation_sha256,
         result,
         request_id,
         created_at,
         retention_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.eventId,
        record.actorAccountId,
        record.artifactId,
        record.versionId,
        record.action,
        record.reason,
        record.confirmationSha256,
        record.result,
        record.requestId,
        record.createdAt,
        record.retentionUntil,
      ],
    );
  }

  public async insertDownloadAudit(record: CloudMarketplaceDownloadAuditRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_marketplace_download_audits (
         download_audit_id,
         account_id,
         artifact_id,
         version_id,
         content_digest_sha256,
         request_id,
         created_at,
         retention_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.downloadAuditId,
        record.accountId,
        record.artifactId,
        record.versionId,
        record.contentDigestSha256,
        record.requestId,
        record.createdAt,
        record.retentionUntil,
      ],
    );
  }
}

function artifactSelection(): string {
  return `SELECT
    artifact_id,
    author_account_id,
    author_display_name,
    kind,
    title,
    summary,
    tags,
    license,
    state,
    revision,
    latest_version_number,
    pending_version_id,
    published_version_id,
    created_at,
    updated_at,
    published_at,
    quarantined_at,
    withdrawn_at,
    retention_until
  FROM cloud_marketplace_artifacts`;
}

function versionSelection(): string {
  return `SELECT
    version.artifact_id,
    version.version_id,
    version.version_number,
    version.semantic_version,
    version.author_display_name,
    version.kind,
    version.title,
    version.summary,
    version.tags,
    version.license,
    version.state,
    version.content_digest_sha256,
    version.author_signing_key_fingerprint_sha256,
    version.content_bytes,
    version.created_at,
    version.submitted_at,
    version.reviewed_at,
    version.published_at,
    version.quarantined_at,
    version.withdrawn_at,
    version.retention_until,
    body.content,
    body.author_public_key_spki,
    body.author_signature
  FROM cloud_marketplace_versions AS version
  LEFT JOIN cloud_marketplace_version_bodies AS body
    ON body.artifact_id = version.artifact_id
   AND body.version_id = version.version_id
   AND inkshadow_marketplace_role() <> 'platform_ops'`;
}

function reportSelection(): string {
  return `SELECT
    report_id,
    artifact_id,
    version_id,
    reporter_account_id,
    category,
    reason,
    state,
    created_at,
    resolved_at,
    retention_until
  FROM cloud_marketplace_reports`;
}

function appealSelection(): string {
  return `SELECT
    appeal_id,
    artifact_id,
    version_id,
    author_account_id,
    source_state,
    reason,
    state,
    created_at,
    resolved_at,
    retention_until
  FROM cloud_marketplace_appeals`;
}

function artifactValues(record: CloudMarketplaceArtifactRecord): unknown[] {
  return [
    record.artifactId,
    record.authorAccountId,
    record.authorDisplayName,
    record.kind,
    record.title,
    record.summary,
    [...record.tags],
    record.license,
    record.state,
    record.revision,
    record.latestVersionNumber,
    record.pendingVersionId,
    record.publishedVersionId,
    record.createdAt,
    record.updatedAt,
    record.publishedAt,
    record.quarantinedAt,
    record.withdrawnAt,
    record.retentionUntil,
  ];
}

function versionValues(record: CloudMarketplaceVersionRecord): unknown[] {
  return [
    record.artifactId,
    record.versionId,
    record.versionNumber,
    record.semanticVersion,
    record.authorDisplayName,
    record.kind,
    record.title,
    record.summary,
    [...record.tags],
    record.license,
    record.state,
    record.contentDigestSha256,
    record.authorSigningKeyFingerprintSha256,
    record.contentBytes,
    record.createdAt,
    record.submittedAt,
    record.reviewedAt,
    record.publishedAt,
    record.quarantinedAt,
    record.withdrawnAt,
    record.retentionUntil,
  ];
}

function reportValues(record: CloudMarketplaceReportRecord): unknown[] {
  return [
    record.reportId,
    record.artifactId,
    record.versionId,
    record.reporterAccountId,
    record.category,
    record.reason,
    record.state,
    record.createdAt,
    record.resolvedAt,
    record.retentionUntil,
  ];
}

function appealValues(record: CloudMarketplaceAppealRecord): unknown[] {
  return [
    record.appealId,
    record.artifactId,
    record.versionId,
    record.authorAccountId,
    record.sourceState,
    record.reason,
    record.state,
    record.createdAt,
    record.resolvedAt,
    record.retentionUntil,
  ];
}

function toArtifact(row: MarketplaceArtifactRow): CloudMarketplaceArtifactRecord {
  return {
    artifactId: row.artifact_id,
    authorAccountId: row.author_account_id,
    authorDisplayName: row.author_display_name,
    createdAt: row.created_at,
    kind: row.kind,
    latestVersionNumber: row.latest_version_number,
    license: row.license,
    pendingVersionId: row.pending_version_id,
    publishedAt: row.published_at,
    publishedVersionId: row.published_version_id,
    quarantinedAt: row.quarantined_at,
    retentionUntil: row.retention_until,
    revision: row.revision,
    state: row.state,
    summary: row.summary,
    tags: Object.freeze([...row.tags]),
    title: row.title,
    updatedAt: row.updated_at,
    withdrawnAt: row.withdrawn_at,
  };
}

function toVersion(row: MarketplaceVersionRow): CloudMarketplaceVersionRecord {
  return {
    artifactId: row.artifact_id,
    authorDisplayName: row.author_display_name,
    authorPublicKeySpki: row.author_public_key_spki,
    authorSignature: row.author_signature,
    authorSigningKeyFingerprintSha256: row.author_signing_key_fingerprint_sha256,
    content: row.content,
    contentBytes: row.content_bytes,
    contentDigestSha256: row.content_digest_sha256,
    createdAt: row.created_at,
    kind: row.kind,
    license: row.license,
    publishedAt: row.published_at,
    quarantinedAt: row.quarantined_at,
    retentionUntil: row.retention_until,
    reviewedAt: row.reviewed_at,
    semanticVersion: row.semantic_version,
    state: row.state,
    submittedAt: row.submitted_at,
    summary: row.summary,
    tags: Object.freeze([...row.tags]),
    title: row.title,
    versionId: row.version_id,
    versionNumber: row.version_number,
    withdrawnAt: row.withdrawn_at,
  };
}

function toReport(row: MarketplaceReportRow): CloudMarketplaceReportRecord {
  return {
    artifactId: row.artifact_id,
    category: row.category,
    createdAt: row.created_at,
    reason: row.reason,
    reportId: row.report_id,
    reporterAccountId: row.reporter_account_id,
    resolvedAt: row.resolved_at,
    retentionUntil: row.retention_until,
    state: row.state,
    versionId: row.version_id,
  };
}

function toAppeal(row: MarketplaceAppealRow): CloudMarketplaceAppealRecord {
  return {
    appealId: row.appeal_id,
    artifactId: row.artifact_id,
    authorAccountId: row.author_account_id,
    createdAt: row.created_at,
    reason: row.reason,
    resolvedAt: row.resolved_at,
    retentionUntil: row.retention_until,
    sourceState: row.source_state,
    state: row.state,
    versionId: row.version_id,
  };
}

function toIdempotency(row: MarketplaceIdempotencyRow): CloudMarketplaceIdempotencyRecord {
  return {
    actorAccountId: row.actor_account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    operationId: row.operation_id,
    requestHashSha256: row.request_hash_sha256,
    responseSnapshot: row.response_snapshot,
    responseStatus: row.response_status,
    resultDigestSha256: row.result_digest_sha256,
    scopeHashSha256: row.scope_hash_sha256,
  };
}

function toQueueRecord(row: MarketplaceQueueRow): CloudMarketplaceModerationQueueRecord {
  const artifact: CloudMarketplaceArtifactRecord = {
    artifactId: row.artifact_id,
    authorAccountId: row.artifact_author_account_id,
    authorDisplayName: row.artifact_author_display_name,
    createdAt: row.artifact_created_at,
    kind: row.artifact_kind,
    latestVersionNumber: row.artifact_latest_version_number,
    license: row.artifact_license,
    pendingVersionId: row.artifact_pending_version_id,
    publishedAt: row.artifact_published_at,
    publishedVersionId: row.artifact_published_version_id,
    quarantinedAt: row.artifact_quarantined_at,
    retentionUntil: row.artifact_retention_until,
    revision: row.artifact_revision,
    state: row.artifact_state,
    summary: row.artifact_summary,
    tags: Object.freeze([...row.artifact_tags]),
    title: row.artifact_title,
    updatedAt: row.artifact_updated_at,
    withdrawnAt: row.artifact_withdrawn_at,
  };
  const appeal =
    row.queue_appeal_id === null
      ? null
      : {
          appealId: row.queue_appeal_id,
          artifactId: row.artifact_id,
          authorAccountId: requireQueueValue(row.queue_appeal_author_account_id),
          createdAt: requireQueueValue(row.queue_appeal_created_at),
          reason: requireQueueValue(row.queue_appeal_reason),
          resolvedAt: row.queue_appeal_resolved_at,
          retentionUntil: requireQueueValue(row.queue_appeal_retention_until),
          sourceState: requireQueueValue(row.queue_appeal_source_state),
          state: requireQueueValue(row.queue_appeal_state),
          versionId: row.version_id,
        };
  return {
    appeal,
    artifact,
    openReportCount: requireSafeCount(row.queue_open_report_count),
    version: toVersion(row),
  };
}

function requireSafeCount(value: string | undefined): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("PostgreSQL returned an invalid marketplace count.");
  }
  return count;
}

function requireQueueValue<T>(value: T | null): T {
  if (value === null) {
    throw new Error("PostgreSQL returned an incomplete marketplace queue row.");
  }
  return value;
}
