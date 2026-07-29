import { z } from "zod";

import { CloudCursorSchema } from "./cloud-api-schemas.js";
import { PositivePortableIntegerSchema } from "./cloud-schemas.js";
import { CONTRACT_SCHEMA_VERSION, IsoUtcTimestampSchema, UuidV7Schema } from "./schemas.js";

const MAX_MARKETPLACE_PAGE_SIZE = 100;
const MAX_TAGS = 16;
const MAX_SECTIONS = 64;
const MAX_ITEMS_PER_SECTION = 128;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SEMANTIC_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SAFE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SAFE_TAG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const EXECUTABLE_OR_EXTERNAL_REFERENCE_PATTERN =
  /(?:<\s*\/?\s*(?:script|iframe|object|embed|link|meta)\b|(?:javascript|data|file|vbscript|https?|ftp|mailto|tel):|\\\\|(?:^|[\s"'`])\/\/[A-Za-z0-9]|on(?:abort|blur|change|click|error|focus|input|key|load|mouse|pointer|submit|touch|wheel)\s*=)/iu;

const MarketplacePlainTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine(isSafeMarketplaceText, {
    message: "Marketplace text cannot contain executable markup or external references",
  });

const MarketplaceShortTextSchema = MarketplacePlainTextSchema.max(200);
const MarketplaceSummaryTextSchema = MarketplacePlainTextSchema.max(1_000);
const MarketplaceReasonTextSchema = MarketplacePlainTextSchema.min(12).max(2_000);

const MarketplaceTagsSchema = z
  .array(z.string().trim().toLowerCase().regex(SAFE_TAG_PATTERN))
  .max(MAX_TAGS)
  .refine(isStrictlySortedUnique, {
    message: "Marketplace tags must be unique and sorted",
  });

export const CloudMarketplaceArtifactKindSchema = z.enum([
  "story_template",
  "style_template",
  "world_template",
]);

export const CloudMarketplaceLicenseSchema = z.enum([
  "cc0-1.0",
  "cc-by-4.0",
  "cc-by-sa-4.0",
  "inkshadow-community-free-1.0",
]);

export const CloudMarketplaceArtifactStateSchema = z.enum([
  "pending_review",
  "published",
  "quarantined",
  "author_withdrawn",
  "rejected",
  "appeal_pending",
]);

export const CloudMarketplaceVersionStateSchema = z.enum([
  "pending_review",
  "published",
  "superseded",
  "quarantined",
  "author_withdrawn",
  "rejected",
  "appeal_pending",
]);

export const CloudMarketplaceReportCategorySchema = z.enum([
  "copyright",
  "malware_or_executable_content",
  "misleading_metadata",
  "privacy",
  "prohibited_content",
  "other",
]);

export const CloudMarketplaceReportStateSchema = z.enum(["open", "dismissed", "upheld"]);
export const CloudMarketplaceAppealStateSchema = z.enum(["open", "accepted", "denied"]);
export const CloudMarketplaceModerationActionSchema = z.enum([
  "approve",
  "reject",
  "quarantine",
  "restore",
]);
export const CloudMarketplaceReportDispositionSchema = z.enum(["dismiss", "uphold"]);
export const CloudMarketplaceAppealDispositionSchema = z.enum(["accept", "deny"]);

const CloudMarketplaceTextItemSchema = z
  .object({
    itemId: z.string().regex(SAFE_IDENTIFIER_PATTERN),
    kind: z.literal("text"),
    label: MarketplaceShortTextSchema,
    value: MarketplacePlainTextSchema,
  })
  .strict();

const CloudMarketplaceTextListItemSchema = z
  .object({
    itemId: z.string().regex(SAFE_IDENTIFIER_PATTERN),
    kind: z.literal("text_list"),
    label: MarketplaceShortTextSchema,
    value: z.array(MarketplacePlainTextSchema.max(1_000)).max(128),
  })
  .strict();

const CloudMarketplaceNumberItemSchema = z
  .object({
    itemId: z.string().regex(SAFE_IDENTIFIER_PATTERN),
    kind: z.literal("number"),
    label: MarketplaceShortTextSchema,
    value: z.number().min(-1_000_000_000).max(1_000_000_000),
  })
  .strict();

const CloudMarketplaceBooleanItemSchema = z
  .object({
    itemId: z.string().regex(SAFE_IDENTIFIER_PATTERN),
    kind: z.literal("boolean"),
    label: MarketplaceShortTextSchema,
    value: z.boolean(),
  })
  .strict();

export const CloudMarketplaceStructuredItemSchema = z.discriminatedUnion("kind", [
  CloudMarketplaceTextItemSchema,
  CloudMarketplaceTextListItemSchema,
  CloudMarketplaceNumberItemSchema,
  CloudMarketplaceBooleanItemSchema,
]);

export const CloudMarketplaceStructuredSectionSchema = z
  .object({
    sectionId: z.string().regex(SAFE_IDENTIFIER_PATTERN),
    title: MarketplaceShortTextSchema,
    items: z.array(CloudMarketplaceStructuredItemSchema).min(1).max(MAX_ITEMS_PER_SECTION),
  })
  .strict()
  .superRefine((section, context) => {
    requireUniqueValues(
      section.items.map((item) => item.itemId),
      context,
      ["items"],
      "A marketplace section cannot repeat item identifiers",
    );
  });

/**
 * Marketplace artifacts are data-only. The schema deliberately has no URL,
 * HTML, script, command, plugin, macro, import or attachment field.
 */
export const CloudMarketplaceStructuredArtifactSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    format: z.literal("inkshadow.marketplace.structured-artifact.v1"),
    sections: z.array(CloudMarketplaceStructuredSectionSchema).min(1).max(MAX_SECTIONS),
  })
  .strict()
  .superRefine((artifact, context) => {
    requireUniqueValues(
      artifact.sections.map((section) => section.sectionId),
      context,
      ["sections"],
      "A marketplace artifact cannot repeat section identifiers",
    );
  });

export const CloudMarketplaceArtifactSummarySchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    artifactId: UuidV7Schema,
    authorAccountId: UuidV7Schema,
    authorDisplayName: MarketplaceShortTextSchema,
    kind: CloudMarketplaceArtifactKindSchema,
    title: MarketplaceShortTextSchema,
    summary: MarketplaceSummaryTextSchema,
    tags: MarketplaceTagsSchema,
    license: CloudMarketplaceLicenseSchema,
    state: CloudMarketplaceArtifactStateSchema,
    revision: PositivePortableIntegerSchema,
    latestVersionNumber: PositivePortableIntegerSchema,
    pendingVersionId: UuidV7Schema.nullable(),
    publishedVersionId: UuidV7Schema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    publishedAt: IsoUtcTimestampSchema.nullable(),
    quarantinedAt: IsoUtcTimestampSchema.nullable(),
    withdrawnAt: IsoUtcTimestampSchema.nullable(),
    retentionUntil: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine(validateArtifactSummary);

export const CloudMarketplaceVersionMetadataSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    artifactId: UuidV7Schema,
    versionId: UuidV7Schema,
    versionNumber: PositivePortableIntegerSchema,
    semanticVersion: z.string().regex(SEMANTIC_VERSION_PATTERN),
    state: CloudMarketplaceVersionStateSchema,
    contentDigestSha256: z.string().regex(SHA256_PATTERN),
    authorSigningKeyFingerprintSha256: z.string().regex(SHA256_PATTERN),
    contentBytes: z.number().int().positive().max(262_144),
    createdAt: IsoUtcTimestampSchema,
    submittedAt: IsoUtcTimestampSchema,
    reviewedAt: IsoUtcTimestampSchema.nullable(),
    publishedAt: IsoUtcTimestampSchema.nullable(),
    quarantinedAt: IsoUtcTimestampSchema.nullable(),
    withdrawnAt: IsoUtcTimestampSchema.nullable(),
    retentionUntil: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine(validateVersionMetadata);

const MarketplaceSubmissionFieldsSchema = z
  .object({
    artifactId: UuidV7Schema,
    versionId: UuidV7Schema,
    versionNumber: PositivePortableIntegerSchema,
    semanticVersion: z.string().regex(SEMANTIC_VERSION_PATTERN),
    authorAccountId: UuidV7Schema,
    authorDisplayName: MarketplaceShortTextSchema,
    kind: CloudMarketplaceArtifactKindSchema,
    title: MarketplaceShortTextSchema,
    summary: MarketplaceSummaryTextSchema,
    tags: MarketplaceTagsSchema,
    license: CloudMarketplaceLicenseSchema,
    content: CloudMarketplaceStructuredArtifactSchema,
  })
  .strict();

export const CloudMarketplaceSubmissionRequestSchema = MarketplaceSubmissionFieldsSchema.extend({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  contentDigestSha256: z.string().regex(SHA256_PATTERN),
  authorPublicKeySpki: z.string().min(40).max(256).regex(BASE64URL_PATTERN),
  authorSignature: z.string().min(80).max(128).regex(BASE64URL_PATTERN),
}).strict();

export const CloudMarketplaceSubmissionResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    artifact: CloudMarketplaceArtifactSummarySchema,
    version: CloudMarketplaceVersionMetadataSchema,
  })
  .strict()
  .superRefine(requireArtifactVersionScope);

export const CloudMarketplaceCatalogResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    artifacts: z.array(CloudMarketplaceArtifactSummarySchema).max(MAX_MARKETPLACE_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueValues(
      response.artifacts.map((artifact) => artifact.artifactId),
      context,
      ["artifacts"],
      "A marketplace page cannot repeat artifacts",
    );
    if (response.artifacts.some((artifact) => artifact.state !== "published")) {
      context.addIssue({
        code: "custom",
        message: "The public marketplace catalog can contain only published artifacts",
        path: ["artifacts"],
      });
    }
  });

const CloudMarketplaceHighRiskOperationFieldsSchema = z
  .object({
    expectedRevision: PositivePortableIntegerSchema,
    reason: MarketplaceReasonTextSchema,
    confirmation: z.string().trim().min(1).max(200),
  })
  .strict();

export const CloudMarketplaceModerationRequestSchema =
  CloudMarketplaceHighRiskOperationFieldsSchema.extend({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    action: CloudMarketplaceModerationActionSchema,
  }).strict();

export const CloudMarketplaceReportRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    reportId: UuidV7Schema,
    category: CloudMarketplaceReportCategorySchema,
    reason: MarketplaceReasonTextSchema,
  })
  .strict();

export const CloudMarketplaceReportSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    reportId: UuidV7Schema,
    artifactId: UuidV7Schema,
    versionId: UuidV7Schema,
    reporterAccountId: UuidV7Schema,
    category: CloudMarketplaceReportCategorySchema,
    state: CloudMarketplaceReportStateSchema,
    createdAt: IsoUtcTimestampSchema,
    resolvedAt: IsoUtcTimestampSchema.nullable(),
    retentionUntil: IsoUtcTimestampSchema,
  })
  .strict()
  .refine(
    (report) =>
      (report.state === "open" && report.resolvedAt === null) ||
      (report.state !== "open" && report.resolvedAt !== null),
    {
      message: "Marketplace report state and resolution timestamp must agree",
      path: ["resolvedAt"],
    },
  );

export const CloudMarketplaceReportResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    report: CloudMarketplaceReportSchema,
    artifact: CloudMarketplaceArtifactSummarySchema,
    version: CloudMarketplaceVersionMetadataSchema,
  })
  .strict()
  .superRefine(requireArtifactVersionScope);

export const CloudMarketplaceWithdrawalRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    reason: MarketplaceReasonTextSchema,
  })
  .strict();

export const CloudMarketplaceAppealRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    appealId: UuidV7Schema,
    expectedRevision: PositivePortableIntegerSchema,
    reason: MarketplaceReasonTextSchema,
  })
  .strict();

export const CloudMarketplaceAppealSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    appealId: UuidV7Schema,
    artifactId: UuidV7Schema,
    versionId: UuidV7Schema,
    authorAccountId: UuidV7Schema,
    sourceState: z.enum(["quarantined", "rejected"]),
    state: CloudMarketplaceAppealStateSchema,
    createdAt: IsoUtcTimestampSchema,
    resolvedAt: IsoUtcTimestampSchema.nullable(),
    retentionUntil: IsoUtcTimestampSchema,
  })
  .strict()
  .refine(
    (appeal) =>
      (appeal.state === "open" && appeal.resolvedAt === null) ||
      (appeal.state !== "open" && appeal.resolvedAt !== null),
    {
      message: "Marketplace appeal state and resolution timestamp must agree",
      path: ["resolvedAt"],
    },
  );

export const CloudMarketplaceAppealResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    appeal: CloudMarketplaceAppealSchema,
    artifact: CloudMarketplaceArtifactSummarySchema,
    version: CloudMarketplaceVersionMetadataSchema,
  })
  .strict()
  .superRefine(requireArtifactVersionScope);

export const CloudMarketplaceReportDispositionRequestSchema =
  CloudMarketplaceHighRiskOperationFieldsSchema.extend({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    disposition: CloudMarketplaceReportDispositionSchema,
  }).strict();

export const CloudMarketplaceAppealDispositionRequestSchema =
  CloudMarketplaceHighRiskOperationFieldsSchema.extend({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    disposition: CloudMarketplaceAppealDispositionSchema,
  }).strict();

export const CloudMarketplaceDownloadRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    versionId: UuidV7Schema,
  })
  .strict();

export const CloudMarketplaceDownloadResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    downloadAuditId: UuidV7Schema,
    retentionUntil: IsoUtcTimestampSchema,
    artifact: CloudMarketplaceArtifactSummarySchema,
    version: CloudMarketplaceVersionMetadataSchema,
    content: CloudMarketplaceStructuredArtifactSchema,
    authorPublicKeySpki: z.string().min(40).max(256).regex(BASE64URL_PATTERN),
    authorSignature: z.string().min(80).max(128).regex(BASE64URL_PATTERN),
  })
  .strict()
  .superRefine(requireArtifactVersionScope);

export const CloudMarketplaceModerationQueueItemSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    artifact: CloudMarketplaceArtifactSummarySchema,
    version: CloudMarketplaceVersionMetadataSchema,
    openReportCount: z.number().int().min(0).max(2_147_483_647),
    openAppealId: UuidV7Schema.nullable(),
  })
  .strict()
  .superRefine(requireArtifactVersionScope);

export const CloudMarketplaceModerationQueueResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    items: z.array(CloudMarketplaceModerationQueueItemSchema).max(MAX_MARKETPLACE_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueValues(
      response.items.map((item) => item.version.versionId),
      context,
      ["items"],
      "A moderation queue page cannot repeat versions",
    );
  });

export type CloudMarketplaceArtifactKind = z.infer<typeof CloudMarketplaceArtifactKindSchema>;
export type CloudMarketplaceLicense = z.infer<typeof CloudMarketplaceLicenseSchema>;
export type CloudMarketplaceArtifactState = z.infer<typeof CloudMarketplaceArtifactStateSchema>;
export type CloudMarketplaceVersionState = z.infer<typeof CloudMarketplaceVersionStateSchema>;
export type CloudMarketplaceReportCategory = z.infer<typeof CloudMarketplaceReportCategorySchema>;
export type CloudMarketplaceReportState = z.infer<typeof CloudMarketplaceReportStateSchema>;
export type CloudMarketplaceAppealState = z.infer<typeof CloudMarketplaceAppealStateSchema>;
export type CloudMarketplaceModerationAction = z.infer<
  typeof CloudMarketplaceModerationActionSchema
>;
export type CloudMarketplaceStructuredArtifact = z.infer<
  typeof CloudMarketplaceStructuredArtifactSchema
>;
export type CloudMarketplaceArtifactSummary = z.infer<typeof CloudMarketplaceArtifactSummarySchema>;
export type CloudMarketplaceVersionMetadata = z.infer<typeof CloudMarketplaceVersionMetadataSchema>;
export type CloudMarketplaceSubmissionRequest = z.infer<
  typeof CloudMarketplaceSubmissionRequestSchema
>;
export type CloudMarketplaceSubmissionResponse = z.infer<
  typeof CloudMarketplaceSubmissionResponseSchema
>;
export type CloudMarketplaceCatalogResponse = z.infer<typeof CloudMarketplaceCatalogResponseSchema>;
export type CloudMarketplaceModerationRequest = z.infer<
  typeof CloudMarketplaceModerationRequestSchema
>;
export type CloudMarketplaceReportRequest = z.infer<typeof CloudMarketplaceReportRequestSchema>;
export type CloudMarketplaceReport = z.infer<typeof CloudMarketplaceReportSchema>;
export type CloudMarketplaceReportResponse = z.infer<typeof CloudMarketplaceReportResponseSchema>;
export type CloudMarketplaceWithdrawalRequest = z.infer<
  typeof CloudMarketplaceWithdrawalRequestSchema
>;
export type CloudMarketplaceAppealRequest = z.infer<typeof CloudMarketplaceAppealRequestSchema>;
export type CloudMarketplaceAppeal = z.infer<typeof CloudMarketplaceAppealSchema>;
export type CloudMarketplaceAppealResponse = z.infer<typeof CloudMarketplaceAppealResponseSchema>;
export type CloudMarketplaceReportDispositionRequest = z.infer<
  typeof CloudMarketplaceReportDispositionRequestSchema
>;
export type CloudMarketplaceAppealDispositionRequest = z.infer<
  typeof CloudMarketplaceAppealDispositionRequestSchema
>;
export type CloudMarketplaceDownloadRequest = z.infer<typeof CloudMarketplaceDownloadRequestSchema>;
export type CloudMarketplaceDownloadResponse = z.infer<
  typeof CloudMarketplaceDownloadResponseSchema
>;
export type CloudMarketplaceModerationQueueItem = z.infer<
  typeof CloudMarketplaceModerationQueueItemSchema
>;
export type CloudMarketplaceModerationQueueResponse = z.infer<
  typeof CloudMarketplaceModerationQueueResponseSchema
>;

export function canonicalMarketplaceJson(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical marketplace JSON accepts only finite numbers.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalMarketplaceJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalMarketplaceJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical marketplace JSON accepts only JSON-compatible values.");
}

export function marketplaceSubmissionSignaturePayload(
  request: Pick<
    CloudMarketplaceSubmissionRequest,
    | "artifactId"
    | "authorAccountId"
    | "authorDisplayName"
    | "content"
    | "kind"
    | "license"
    | "semanticVersion"
    | "summary"
    | "tags"
    | "title"
    | "versionId"
    | "versionNumber"
  >,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    purpose: "inkshadow.marketplace.artifact-version",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: request.artifactId,
    versionId: request.versionId,
    versionNumber: request.versionNumber,
    semanticVersion: request.semanticVersion,
    authorAccountId: request.authorAccountId,
    authorDisplayName: request.authorDisplayName,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    tags: request.tags,
    license: request.license,
    content: request.content,
  });
}

export function expectedMarketplaceHighRiskConfirmation(
  action: string,
  resourceId: string,
): string {
  return `MARKETPLACE:${action.toUpperCase()}:${resourceId}`;
}

function validateArtifactSummary(
  artifact: z.infer<typeof CloudMarketplaceArtifactSummarySchema>,
  context: z.RefinementCtx,
): void {
  requireTimestampOrder(artifact.createdAt, artifact.updatedAt, context, ["updatedAt"]);
  if (artifact.state === "published" && artifact.publishedVersionId === null) {
    context.addIssue({
      code: "custom",
      message: "A published marketplace artifact requires a published version",
      path: ["publishedVersionId"],
    });
  }
  if (
    artifact.state === "pending_review" &&
    artifact.pendingVersionId === null &&
    artifact.publishedVersionId === null
  ) {
    context.addIssue({
      code: "custom",
      message: "A pending marketplace artifact requires a pending or prior published version",
      path: ["pendingVersionId"],
    });
  }
  if ((artifact.quarantinedAt !== null) !== (artifact.state === "quarantined")) {
    context.addIssue({
      code: "custom",
      message: "Marketplace quarantine state and timestamp must agree",
      path: ["quarantinedAt"],
    });
  }
  if ((artifact.withdrawnAt !== null) !== (artifact.state === "author_withdrawn")) {
    context.addIssue({
      code: "custom",
      message: "Marketplace withdrawal state and timestamp must agree",
      path: ["withdrawnAt"],
    });
  }
  if (
    ["quarantined", "author_withdrawn", "rejected", "appeal_pending"].includes(artifact.state) &&
    artifact.retentionUntil === null
  ) {
    context.addIssue({
      code: "custom",
      message: "Restricted marketplace artifacts require an explicit retention deadline",
      path: ["retentionUntil"],
    });
  }
}

function validateVersionMetadata(
  version: z.infer<typeof CloudMarketplaceVersionMetadataSchema>,
  context: z.RefinementCtx,
): void {
  requireTimestampOrder(version.createdAt, version.submittedAt, context, ["submittedAt"]);
  if (version.reviewedAt !== null) {
    requireTimestampOrder(version.submittedAt, version.reviewedAt, context, ["reviewedAt"]);
  }
  if (["published", "superseded"].includes(version.state) && version.publishedAt === null) {
    context.addIssue({
      code: "custom",
      message: "Published marketplace versions require a publication timestamp",
      path: ["publishedAt"],
    });
  }
  if (["pending_review", "rejected"].includes(version.state) && version.publishedAt !== null) {
    context.addIssue({
      code: "custom",
      message: "Never-published marketplace versions cannot have a publication timestamp",
      path: ["publishedAt"],
    });
  }
  if ((version.quarantinedAt !== null) !== (version.state === "quarantined")) {
    context.addIssue({
      code: "custom",
      message: "Marketplace version quarantine state and timestamp must agree",
      path: ["quarantinedAt"],
    });
  }
  if ((version.withdrawnAt !== null) !== (version.state === "author_withdrawn")) {
    context.addIssue({
      code: "custom",
      message: "Marketplace version withdrawal state and timestamp must agree",
      path: ["withdrawnAt"],
    });
  }
  if (
    ["quarantined", "author_withdrawn", "rejected", "appeal_pending"].includes(version.state) &&
    version.retentionUntil === null
  ) {
    context.addIssue({
      code: "custom",
      message: "Restricted marketplace versions require an explicit retention deadline",
      path: ["retentionUntil"],
    });
  }
}

function requireArtifactVersionScope(
  value: {
    readonly artifact: z.infer<typeof CloudMarketplaceArtifactSummarySchema>;
    readonly version: z.infer<typeof CloudMarketplaceVersionMetadataSchema>;
  },
  context: z.RefinementCtx,
): void {
  if (value.artifact.artifactId !== value.version.artifactId) {
    context.addIssue({
      code: "custom",
      message: "Marketplace response crossed its artifact scope",
      path: ["version", "artifactId"],
    });
  }
}

function requireTimestampOrder(
  earlier: string,
  later: string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (Date.parse(earlier) > Date.parse(later)) {
    context.addIssue({
      code: "custom",
      message: "Marketplace timestamp order is invalid",
      path,
    });
  }
}

function requireUniqueValues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message, path });
  }
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) {
      return false;
    }
  }
  return true;
}

function isSafeMarketplaceText(value: string): boolean {
  return (
    !EXECUTABLE_OR_EXTERNAL_REFERENCE_PATTERN.test(value) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}
