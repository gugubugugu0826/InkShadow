import { z } from "zod";

import { CloudCursorSchema } from "./cloud-api-schemas.js";
import { PositivePortableIntegerSchema } from "./cloud-schemas.js";
import { CONTRACT_SCHEMA_VERSION, IsoUtcTimestampSchema, UuidV7Schema } from "./schemas.js";

const MAX_TEMPLATE_PAGE_SIZE = 100;
const MAX_TEMPLATE_PLAINTEXT_BYTES = 256 * 1024;
const MAX_TEMPLATE_CIPHERTEXT_BYTES = MAX_TEMPLATE_PLAINTEXT_BYTES + 16;
const MAX_TEMPLATE_CIPHERTEXT_BASE64URL_LENGTH = Math.ceil((MAX_TEMPLATE_CIPHERTEXT_BYTES * 4) / 3);
const ProjectKeyVersionSchema = z.number().int().positive().max(2_147_483_647);

export const CloudTeamTemplateStateSchema = z.enum(["draft", "published", "archived"]);

/**
 * Public, non-sensitive AEAD context. It deliberately contains only immutable
 * identifiers and counters needed to prevent ciphertext substitution across a
 * tenant, team, project, template, version or project-key version.
 */
export const CloudTeamTemplateAadSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    purpose: z.literal("inkshadow.studio.team-template"),
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    templateId: UuidV7Schema,
    versionId: UuidV7Schema,
    versionNumber: PositivePortableIntegerSchema,
    projectKeyVersion: ProjectKeyVersionSchema,
  })
  .strict();

export const CloudTeamTemplateCiphertextEnvelopeSchema = z
  .object({
    algorithm: z.literal("AES-256-GCM"),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z
      .string()
      .min(22)
      .max(MAX_TEMPLATE_CIPHERTEXT_BASE64URL_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/u),
    ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    aad: CloudTeamTemplateAadSchema,
  })
  .strict();

export const CloudTeamTemplateSummarySchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    templateId: UuidV7Schema,
    state: CloudTeamTemplateStateSchema,
    revision: PositivePortableIntegerSchema,
    latestVersionNumber: PositivePortableIntegerSchema,
    publishedVersionNumber: PositivePortableIntegerSchema.nullable(),
    createdByMembershipId: UuidV7Schema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    publishedAt: IsoUtcTimestampSchema.nullable(),
    archivedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((template, context) => {
    requireTimestampOrder(template.createdAt, template.updatedAt, context, ["updatedAt"]);
    const hasPublishedVersion = template.publishedVersionNumber !== null;
    const hasPublishedAt = template.publishedAt !== null;
    if (hasPublishedVersion !== hasPublishedAt) {
      context.addIssue({
        code: "custom",
        message: "Template publication identifiers and timestamp must appear together",
        path: ["publishedVersionNumber"],
      });
    }
    if (template.state === "draft" && (hasPublishedVersion || hasPublishedAt)) {
      context.addIssue({
        code: "custom",
        message: "A draft template cannot contain publication metadata",
        path: ["publishedVersionNumber"],
      });
    }
    if (template.state === "published" && (!hasPublishedVersion || !hasPublishedAt)) {
      context.addIssue({
        code: "custom",
        message: "A published template requires publication metadata",
        path: ["publishedVersionNumber"],
      });
    }
    if (
      template.publishedVersionNumber !== null &&
      template.publishedVersionNumber > template.latestVersionNumber
    ) {
      context.addIssue({
        code: "custom",
        message: "Published template version cannot exceed the latest version",
        path: ["publishedVersionNumber"],
      });
    }
    if ((template.state === "archived") !== (template.archivedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "Archived template state and archivedAt must agree",
        path: ["archivedAt"],
      });
    }
    if (template.publishedAt !== null) {
      requireTimestampOrder(template.createdAt, template.publishedAt, context, ["publishedAt"]);
      requireTimestampOrder(template.publishedAt, template.updatedAt, context, ["updatedAt"]);
    }
    if (template.archivedAt !== null) {
      requireTimestampOrder(template.createdAt, template.archivedAt, context, ["archivedAt"]);
      requireTimestampOrder(template.archivedAt, template.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudTeamTemplateVersionSummarySchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    templateId: UuidV7Schema,
    versionId: UuidV7Schema,
    versionNumber: PositivePortableIntegerSchema,
    projectKeyVersion: ProjectKeyVersionSchema,
    authorMembershipId: UuidV7Schema,
    authorDeviceId: UuidV7Schema,
    clonedFromTemplateId: UuidV7Schema.nullable(),
    clonedFromVersionId: UuidV7Schema.nullable(),
    createdAt: IsoUtcTimestampSchema,
  })
  .strict()
  .superRefine((version, context) => {
    if ((version.clonedFromTemplateId === null) !== (version.clonedFromVersionId === null)) {
      context.addIssue({
        code: "custom",
        message: "Clone source template and version identifiers must appear together",
        path: ["clonedFromVersionId"],
      });
    }
  });

export const CloudTeamTemplateVersionSchema = CloudTeamTemplateVersionSummarySchema.extend({
  payload: CloudTeamTemplateCiphertextEnvelopeSchema,
})
  .strict()
  .superRefine((version, context) => {
    const aad = version.payload.aad;
    if (
      aad.tenantId !== version.tenantId ||
      aad.teamId !== version.teamId ||
      aad.projectId !== version.projectId ||
      aad.templateId !== version.templateId ||
      aad.versionId !== version.versionId ||
      aad.versionNumber !== version.versionNumber ||
      aad.projectKeyVersion !== version.projectKeyVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "Template ciphertext AAD must match the immutable version scope",
        path: ["payload", "aad"],
      });
    }
  });

const CloudTeamTemplateVersionWriteFieldsSchema = z
  .object({
    versionId: UuidV7Schema,
    versionNumber: PositivePortableIntegerSchema,
    projectKeyVersion: ProjectKeyVersionSchema,
    authorDeviceId: UuidV7Schema,
    payload: CloudTeamTemplateCiphertextEnvelopeSchema,
  })
  .strict();

export const CloudTeamTemplateCreateRequestSchema =
  CloudTeamTemplateVersionWriteFieldsSchema.extend({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    templateId: UuidV7Schema,
  })
    .strict()
    .superRefine((request, context) => {
      if (request.versionNumber !== 1) {
        context.addIssue({
          code: "custom",
          message: "A new template must begin at version 1",
          path: ["versionNumber"],
        });
      }
      requireEnvelopeRequestScope(request, request.templateId, context);
    });

export const CloudTeamTemplateVersionCreateRequestSchema =
  CloudTeamTemplateVersionWriteFieldsSchema.extend({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
  })
    .strict()
    .superRefine((request, context) => {
      requireEnvelopeRequestScope(request, request.payload.aad.templateId, context);
    });

export const CloudTeamTemplateCloneRequestSchema = CloudTeamTemplateVersionWriteFieldsSchema.extend(
  {
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedSourceRevision: PositivePortableIntegerSchema,
    sourceVersionId: UuidV7Schema,
    targetTemplateId: UuidV7Schema,
  },
)
  .strict()
  .superRefine((request, context) => {
    if (request.versionNumber !== 1) {
      context.addIssue({
        code: "custom",
        message: "A cloned template must begin at version 1",
        path: ["versionNumber"],
      });
    }
    requireEnvelopeRequestScope(request, request.targetTemplateId, context);
  });

export const CloudTeamTemplatePublishRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    versionId: UuidV7Schema,
  })
  .strict();

export const CloudTeamTemplateArchiveRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
  })
  .strict();

export const CloudTeamTemplateApplyRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    applicationId: UuidV7Schema,
    expectedRevision: PositivePortableIntegerSchema,
    versionId: UuidV7Schema,
  })
  .strict();

export const CloudTeamTemplateResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    template: CloudTeamTemplateSummarySchema,
  })
  .strict();

export const CloudTeamTemplateMutationResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    template: CloudTeamTemplateSummarySchema,
    version: CloudTeamTemplateVersionSummarySchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.template.tenantId !== response.version.tenantId ||
      response.template.teamId !== response.version.teamId ||
      response.template.projectId !== response.version.projectId ||
      response.template.templateId !== response.version.templateId
    ) {
      context.addIssue({
        code: "custom",
        message: "Template mutation response crossed its version scope",
        path: ["version"],
      });
    }
  });

export const CloudTeamTemplateListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    templates: z.array(CloudTeamTemplateSummarySchema).max(MAX_TEMPLATE_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.templates, "templateId", context, ["templates"]);
  });

export const CloudTeamTemplateVersionResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    version: CloudTeamTemplateVersionSchema,
  })
  .strict();

export const CloudTeamTemplateVersionListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    versions: z.array(CloudTeamTemplateVersionSummarySchema).max(MAX_TEMPLATE_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.versions, "versionId", context, ["versions"]);
  });

export const CloudTeamTemplateApplicationResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    applicationId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    templateId: UuidV7Schema,
    versionId: UuidV7Schema,
    appliedByMembershipId: UuidV7Schema,
    appliedAt: IsoUtcTimestampSchema,
    effect: z.literal("metadata_only_no_server_content_mutation"),
  })
  .strict();

export type CloudTeamTemplateState = z.infer<typeof CloudTeamTemplateStateSchema>;
export type CloudTeamTemplateAad = z.infer<typeof CloudTeamTemplateAadSchema>;
export type CloudTeamTemplateCiphertextEnvelope = z.infer<
  typeof CloudTeamTemplateCiphertextEnvelopeSchema
>;
export type CloudTeamTemplateSummary = z.infer<typeof CloudTeamTemplateSummarySchema>;
export type CloudTeamTemplateVersionSummary = z.infer<typeof CloudTeamTemplateVersionSummarySchema>;
export type CloudTeamTemplateVersion = z.infer<typeof CloudTeamTemplateVersionSchema>;
export type CloudTeamTemplateCreateRequest = z.infer<typeof CloudTeamTemplateCreateRequestSchema>;
export type CloudTeamTemplateVersionCreateRequest = z.infer<
  typeof CloudTeamTemplateVersionCreateRequestSchema
>;
export type CloudTeamTemplateCloneRequest = z.infer<typeof CloudTeamTemplateCloneRequestSchema>;
export type CloudTeamTemplatePublishRequest = z.infer<typeof CloudTeamTemplatePublishRequestSchema>;
export type CloudTeamTemplateArchiveRequest = z.infer<typeof CloudTeamTemplateArchiveRequestSchema>;
export type CloudTeamTemplateApplyRequest = z.infer<typeof CloudTeamTemplateApplyRequestSchema>;
export type CloudTeamTemplateResponse = z.infer<typeof CloudTeamTemplateResponseSchema>;
export type CloudTeamTemplateMutationResponse = z.infer<
  typeof CloudTeamTemplateMutationResponseSchema
>;
export type CloudTeamTemplateListResponse = z.infer<typeof CloudTeamTemplateListResponseSchema>;
export type CloudTeamTemplateVersionResponse = z.infer<
  typeof CloudTeamTemplateVersionResponseSchema
>;
export type CloudTeamTemplateVersionListResponse = z.infer<
  typeof CloudTeamTemplateVersionListResponseSchema
>;
export type CloudTeamTemplateApplicationResponse = z.infer<
  typeof CloudTeamTemplateApplicationResponseSchema
>;

function requireEnvelopeRequestScope(
  request: z.infer<typeof CloudTeamTemplateVersionWriteFieldsSchema>,
  templateId: string,
  context: z.RefinementCtx,
): void {
  const aad = request.payload.aad;
  if (
    aad.templateId !== templateId ||
    aad.versionId !== request.versionId ||
    aad.versionNumber !== request.versionNumber ||
    aad.projectKeyVersion !== request.projectKeyVersion
  ) {
    context.addIssue({
      code: "custom",
      message: "Template ciphertext AAD must match its write request",
      path: ["payload", "aad"],
    });
  }
}

function requireUniqueIds<T extends Readonly<Record<string, unknown>>>(
  values: readonly T[],
  field: keyof T,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const identifiers = values.map((value) => value[field]);
  if (new Set(identifiers).size !== identifiers.length) {
    context.addIssue({
      code: "custom",
      message: `A page cannot repeat ${String(field)}`,
      path,
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
      message: "Timestamp order is invalid",
      path,
    });
  }
}
