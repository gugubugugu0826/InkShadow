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

export interface CloudMarketplaceTransaction {
  lockIdempotency(scopeHashSha256: string): Promise<void>;
  findIdempotency(scopeHashSha256: string): Promise<CloudMarketplaceIdempotencyRecord | null>;
  insertIdempotency(record: CloudMarketplaceIdempotencyRecord): Promise<void>;

  findArtifact(
    artifactId: string,
    forUpdate?: boolean,
  ): Promise<CloudMarketplaceArtifactRecord | null>;
  findVersion(
    artifactId: string,
    versionId: string,
    forUpdate?: boolean,
  ): Promise<CloudMarketplaceVersionRecord | null>;
  listCatalog(
    limit: number,
    anchor: CloudMarketplacePageAnchor | null,
    kind: CloudMarketplaceArtifactRecord["kind"] | null,
  ): Promise<readonly CloudMarketplaceArtifactRecord[]>;
  listModerationQueue(
    limit: number,
    anchor: CloudMarketplacePageAnchor | null,
  ): Promise<readonly CloudMarketplaceModerationQueueRecord[]>;
  insertArtifact(record: CloudMarketplaceArtifactRecord): Promise<void>;
  insertVersion(record: CloudMarketplaceVersionRecord): Promise<void>;
  updateArtifactCas(
    record: CloudMarketplaceArtifactRecord,
    expectedRevision: number,
  ): Promise<boolean>;
  updateVersion(record: CloudMarketplaceVersionRecord): Promise<void>;
  supersedePublishedVersion(
    artifactId: string,
    excludingVersionId: string,
    at: Date,
  ): Promise<void>;

  findOpenReport(
    artifactId: string,
    versionId: string,
    reporterAccountId: string,
  ): Promise<CloudMarketplaceReportRecord | null>;
  findReport(reportId: string, forUpdate?: boolean): Promise<CloudMarketplaceReportRecord | null>;
  countOpenReports(artifactId: string, versionId: string): Promise<number>;
  insertReport(record: CloudMarketplaceReportRecord): Promise<void>;
  updateReport(record: CloudMarketplaceReportRecord): Promise<void>;

  findOpenAppeal(
    artifactId: string,
    versionId: string,
  ): Promise<CloudMarketplaceAppealRecord | null>;
  findAppeal(appealId: string, forUpdate?: boolean): Promise<CloudMarketplaceAppealRecord | null>;
  insertAppeal(record: CloudMarketplaceAppealRecord): Promise<void>;
  updateAppeal(record: CloudMarketplaceAppealRecord): Promise<void>;

  insertModerationEvent(record: CloudMarketplaceModerationEventRecord): Promise<void>;
  insertDownloadAudit(record: CloudMarketplaceDownloadAuditRecord): Promise<void>;
}

export interface CloudMarketplaceStore {
  transaction<T>(
    actor: CloudMarketplaceActor,
    operation: (transaction: CloudMarketplaceTransaction) => Promise<T>,
  ): Promise<T>;
}
