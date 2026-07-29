import type {
  CloudMarketplaceAppealState,
  CloudMarketplaceArtifactKind,
  CloudMarketplaceArtifactState,
  CloudMarketplaceLicense,
  CloudMarketplaceReportCategory,
  CloudMarketplaceReportState,
  CloudMarketplaceStructuredArtifact,
  CloudMarketplaceVersionState,
} from "@inkshadow/contracts/marketplace";

export type CloudMarketplacePlatformRole = "member" | "platform_ops";

export interface CloudMarketplaceActor {
  readonly accountId: string;
  readonly deviceId: string;
  readonly platformRole: CloudMarketplacePlatformRole;
  readonly strongMfa: boolean;
}

export interface CloudMarketplaceArtifactRecord {
  readonly artifactId: string;
  readonly authorAccountId: string;
  readonly authorDisplayName: string;
  readonly createdAt: Date;
  readonly kind: CloudMarketplaceArtifactKind;
  readonly latestVersionNumber: number;
  readonly license: CloudMarketplaceLicense;
  readonly pendingVersionId: string | null;
  readonly publishedAt: Date | null;
  readonly publishedVersionId: string | null;
  readonly quarantinedAt: Date | null;
  readonly retentionUntil: Date | null;
  readonly revision: number;
  readonly state: CloudMarketplaceArtifactState;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly title: string;
  readonly updatedAt: Date;
  readonly withdrawnAt: Date | null;
}

export interface CloudMarketplaceVersionRecord {
  readonly artifactId: string;
  readonly authorDisplayName: string;
  readonly authorPublicKeySpki: string | null;
  readonly authorSignature: string | null;
  readonly authorSigningKeyFingerprintSha256: string;
  readonly content: CloudMarketplaceStructuredArtifact | null;
  readonly contentBytes: number;
  readonly contentDigestSha256: string;
  readonly createdAt: Date;
  readonly kind: CloudMarketplaceArtifactKind;
  readonly license: CloudMarketplaceLicense;
  readonly publishedAt: Date | null;
  readonly quarantinedAt: Date | null;
  readonly retentionUntil: Date | null;
  readonly reviewedAt: Date | null;
  readonly semanticVersion: string;
  readonly state: CloudMarketplaceVersionState;
  readonly submittedAt: Date;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly title: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly withdrawnAt: Date | null;
}

export interface CloudMarketplaceReportRecord {
  readonly artifactId: string;
  readonly category: CloudMarketplaceReportCategory;
  readonly createdAt: Date;
  readonly reason: string;
  readonly reportId: string;
  readonly reporterAccountId: string;
  readonly resolvedAt: Date | null;
  readonly retentionUntil: Date;
  readonly state: CloudMarketplaceReportState;
  readonly versionId: string;
}

export interface CloudMarketplaceAppealRecord {
  readonly appealId: string;
  readonly artifactId: string;
  readonly authorAccountId: string;
  readonly createdAt: Date;
  readonly reason: string;
  readonly resolvedAt: Date | null;
  readonly retentionUntil: Date;
  readonly sourceState: "quarantined" | "rejected";
  readonly state: CloudMarketplaceAppealState;
  readonly versionId: string;
}

export interface CloudMarketplaceModerationEventRecord {
  readonly action: string;
  readonly actorAccountId: string;
  readonly artifactId: string;
  readonly confirmationSha256: string;
  readonly createdAt: Date;
  readonly eventId: string;
  readonly reason: string;
  readonly requestId: string;
  readonly result: "allowed" | "denied" | "failed";
  readonly retentionUntil: Date;
  readonly versionId: string;
}

export interface CloudMarketplaceDownloadAuditRecord {
  readonly accountId: string;
  readonly artifactId: string;
  readonly contentDigestSha256: string;
  readonly createdAt: Date;
  readonly downloadAuditId: string;
  readonly requestId: string;
  readonly retentionUntil: Date;
  readonly versionId: string;
}

export interface CloudMarketplaceIdempotencyRecord {
  readonly actorAccountId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly operationId: string;
  readonly requestHashSha256: string;
  readonly responseSnapshot: unknown;
  readonly responseStatus: number;
  readonly resultDigestSha256: string;
  readonly scopeHashSha256: string;
}

export interface CloudMarketplaceModerationQueueRecord {
  readonly appeal: CloudMarketplaceAppealRecord | null;
  readonly artifact: CloudMarketplaceArtifactRecord;
  readonly openReportCount: number;
  readonly version: CloudMarketplaceVersionRecord;
}

export interface CloudMarketplacePageAnchor {
  readonly createdAt: Date;
  readonly id: string;
}
