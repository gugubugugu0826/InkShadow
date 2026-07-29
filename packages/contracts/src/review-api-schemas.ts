import { z } from "zod";

import { PositivePortableIntegerSchema } from "./cloud-schemas.js";
import { CloudCursorSchema } from "./cloud-api-schemas.js";
import { CONTRACT_SCHEMA_VERSION, IsoUtcTimestampSchema, UuidV7Schema } from "./schemas.js";

const MAX_REVIEW_PAGE_SIZE = 100;
const MAX_ENCRYPTED_REVIEW_BYTES = 256 * 1024 + 16;
const MAX_ENCRYPTED_REVIEW_BASE64URL_LENGTH = Math.ceil((MAX_ENCRYPTED_REVIEW_BYTES * 4) / 3);

export const CloudReviewCiphertextEnvelopeSchema = z
  .object({
    algorithm: z.literal("AES-256-GCM"),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ciphertext: z
      .string()
      .min(22)
      .max(MAX_ENCRYPTED_REVIEW_BASE64URL_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/u),
    ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const CloudReviewStateSchema = z.enum(["pending", "approved", "rejected"]);
export const CloudReviewDecisionSchema = z.enum(["approved", "rejected"]);
export const CloudReviewThreadStateSchema = z.enum(["open", "resolved"]);
export const CloudReviewThreadItemTypeSchema = z.enum([
  "comment",
  "suggestion",
  "question",
  "rewrite_request",
  "reply",
]);
export const CloudReviewSuggestionDecisionSchema = z.enum(["pending", "accepted", "rejected"]);

const CloudReviewSummaryFieldsSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    reviewId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    sourceVersionId: UuidV7Schema,
    sourceVersionRevision: PositivePortableIntegerSchema,
    sourceCiphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    projectKeyVersion: z.number().int().positive().max(2_147_483_647),
    submittedByMembershipId: UuidV7Schema,
    state: CloudReviewStateSchema,
    revision: PositivePortableIntegerSchema,
    decisionByMembershipId: UuidV7Schema.nullable(),
    decidedAt: IsoUtcTimestampSchema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudReviewSummarySchema = CloudReviewSummaryFieldsSchema.superRefine(
  (review, context) => {
    requireTimestampOrder(review.createdAt, review.updatedAt, context, ["updatedAt"]);
    if (
      (review.state === "pending" &&
        (review.decisionByMembershipId !== null || review.decidedAt !== null)) ||
      (review.state !== "pending" &&
        (review.decisionByMembershipId === null || review.decidedAt === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Review decision state and decision metadata must agree",
        path: ["state"],
      });
    }
    if (review.decidedAt !== null) {
      requireTimestampOrder(review.createdAt, review.decidedAt, context, ["decidedAt"]);
      requireTimestampOrder(review.decidedAt, review.updatedAt, context, ["updatedAt"]);
    }
  },
);

export const CloudReviewSchema = CloudReviewSummaryFieldsSchema.extend({
  payload: CloudReviewCiphertextEnvelopeSchema,
})
  .strict()
  .superRefine((review, context) => {
    requireTimestampOrder(review.createdAt, review.updatedAt, context, ["updatedAt"]);
    if (
      (review.state === "pending" &&
        (review.decisionByMembershipId !== null || review.decidedAt !== null)) ||
      (review.state !== "pending" &&
        (review.decisionByMembershipId === null || review.decidedAt === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Review decision state and decision metadata must agree",
        path: ["state"],
      });
    }
    if (review.decidedAt !== null) {
      requireTimestampOrder(review.createdAt, review.decidedAt, context, ["decidedAt"]);
      requireTimestampOrder(review.decidedAt, review.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudReviewSubmissionRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    reviewId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    sourceVersionId: UuidV7Schema,
    sourceVersionRevision: PositivePortableIntegerSchema,
    sourceCiphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    projectKeyVersion: z.number().int().positive().max(2_147_483_647),
    payload: CloudReviewCiphertextEnvelopeSchema,
  })
  .strict();

export const CloudReviewDecisionRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    decision: CloudReviewDecisionSchema,
  })
  .strict();

export const CloudReviewResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    review: CloudReviewSchema,
  })
  .strict();

export const CloudReviewListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    reviews: z.array(CloudReviewSummarySchema).max(MAX_REVIEW_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.reviews, "reviewId", context, ["reviews"]);
  });

export const CloudReviewThreadSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    threadId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    reviewId: UuidV7Schema,
    rootItemId: UuidV7Schema,
    state: CloudReviewThreadStateSchema,
    revision: PositivePortableIntegerSchema,
    itemCount: PositivePortableIntegerSchema,
    createdByMembershipId: UuidV7Schema,
    resolvedByMembershipId: UuidV7Schema.nullable(),
    resolvedAt: IsoUtcTimestampSchema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict()
  .superRefine((thread, context) => {
    requireTimestampOrder(thread.createdAt, thread.updatedAt, context, ["updatedAt"]);
    if (
      (thread.state === "open" &&
        (thread.resolvedByMembershipId !== null || thread.resolvedAt !== null)) ||
      (thread.state === "resolved" &&
        (thread.resolvedByMembershipId === null || thread.resolvedAt === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Review-thread state and resolution metadata must agree",
        path: ["state"],
      });
    }
    if (thread.resolvedAt !== null) {
      requireTimestampOrder(thread.createdAt, thread.resolvedAt, context, ["resolvedAt"]);
      requireTimestampOrder(thread.resolvedAt, thread.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudReviewThreadItemSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    itemId: UuidV7Schema,
    threadId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    reviewId: UuidV7Schema,
    itemType: CloudReviewThreadItemTypeSchema,
    parentItemId: UuidV7Schema.nullable(),
    payload: CloudReviewCiphertextEnvelopeSchema,
    createdByMembershipId: UuidV7Schema,
    revision: PositivePortableIntegerSchema,
    suggestionDecision: CloudReviewSuggestionDecisionSchema.nullable(),
    suggestionDecidedByMembershipId: UuidV7Schema.nullable(),
    suggestionDecidedAt: IsoUtcTimestampSchema.nullable(),
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict()
  .superRefine((item, context) => {
    requireTimestampOrder(item.createdAt, item.updatedAt, context, ["updatedAt"]);
    if ((item.itemType === "reply") !== (item.parentItemId !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only a reply may identify a parent review item",
        path: ["parentItemId"],
      });
    }
    if (item.itemType !== "suggestion") {
      if (
        item.suggestionDecision !== null ||
        item.suggestionDecidedByMembershipId !== null ||
        item.suggestionDecidedAt !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Only a suggestion may contain suggestion-decision metadata",
          path: ["suggestionDecision"],
        });
      }
      return;
    }
    if (
      (item.suggestionDecision === "pending" &&
        (item.suggestionDecidedByMembershipId !== null || item.suggestionDecidedAt !== null)) ||
      (item.suggestionDecision !== "pending" &&
        (item.suggestionDecidedByMembershipId === null || item.suggestionDecidedAt === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Suggestion decision and decision metadata must agree",
        path: ["suggestionDecision"],
      });
    }
    if (item.suggestionDecidedAt !== null) {
      requireTimestampOrder(item.createdAt, item.suggestionDecidedAt, context, [
        "suggestionDecidedAt",
      ]);
      requireTimestampOrder(item.suggestionDecidedAt, item.updatedAt, context, ["updatedAt"]);
    }
  });

export const CloudReviewThreadItemAppendRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    threadId: UuidV7Schema,
    itemId: UuidV7Schema,
    itemType: CloudReviewThreadItemTypeSchema,
    parentItemId: UuidV7Schema.nullable(),
    expectedThreadRevision: PositivePortableIntegerSchema.nullable(),
    payload: CloudReviewCiphertextEnvelopeSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const reply = request.itemType === "reply";
    if (
      reply !== (request.parentItemId !== null) ||
      reply !== (request.expectedThreadRevision !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A reply requires a parent item and expected thread revision; a root item accepts neither",
        path: ["itemType"],
      });
    }
  });

export const CloudReviewThreadResolutionRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
  })
  .strict();

export const CloudReviewSuggestionDecisionRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    decision: z.enum(["accepted", "rejected"]),
  })
  .strict();

export const CloudReviewThreadResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    thread: CloudReviewThreadSchema,
  })
  .strict();

export const CloudReviewThreadListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    threads: z.array(CloudReviewThreadSchema).max(MAX_REVIEW_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.threads, "threadId", context, ["threads"]);
  });

export const CloudReviewThreadItemResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    thread: CloudReviewThreadSchema,
    item: CloudReviewThreadItemSchema,
  })
  .strict()
  .superRefine((response, context) => {
    requireThreadItemScope(response.thread, response.item, context, ["item"]);
  });

export const CloudReviewSuggestionDecisionResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    effect: z.literal("metadata_only_no_content_mutation"),
    thread: CloudReviewThreadSchema,
    item: CloudReviewThreadItemSchema,
  })
  .strict()
  .superRefine((response, context) => {
    requireThreadItemScope(response.thread, response.item, context, ["item"]);
    if (response.item.itemType !== "suggestion" || response.item.suggestionDecision === "pending") {
      context.addIssue({
        code: "custom",
        message: "Suggestion-decision response requires a decided suggestion",
        path: ["item", "suggestionDecision"],
      });
    }
  });

export const CloudReviewThreadItemListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    thread: CloudReviewThreadSchema,
    items: z.array(CloudReviewThreadItemSchema).max(MAX_REVIEW_PAGE_SIZE),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    requireUniqueIds(response.items, "itemId", context, ["items"]);
    for (const [index, item] of response.items.entries()) {
      requireThreadItemScope(response.thread, item, context, ["items", index]);
    }
  });

export type CloudReviewCiphertextEnvelope = z.infer<typeof CloudReviewCiphertextEnvelopeSchema>;
export type CloudReviewState = z.infer<typeof CloudReviewStateSchema>;
export type CloudReviewDecision = z.infer<typeof CloudReviewDecisionSchema>;
export type CloudReviewThreadState = z.infer<typeof CloudReviewThreadStateSchema>;
export type CloudReviewThreadItemType = z.infer<typeof CloudReviewThreadItemTypeSchema>;
export type CloudReviewSuggestionDecision = z.infer<typeof CloudReviewSuggestionDecisionSchema>;
export type CloudReviewSummary = z.infer<typeof CloudReviewSummarySchema>;
export type CloudReview = z.infer<typeof CloudReviewSchema>;
export type CloudReviewSubmissionRequest = z.infer<typeof CloudReviewSubmissionRequestSchema>;
export type CloudReviewDecisionRequest = z.infer<typeof CloudReviewDecisionRequestSchema>;
export type CloudReviewResponse = z.infer<typeof CloudReviewResponseSchema>;
export type CloudReviewListResponse = z.infer<typeof CloudReviewListResponseSchema>;
export type CloudReviewThread = z.infer<typeof CloudReviewThreadSchema>;
export type CloudReviewThreadItem = z.infer<typeof CloudReviewThreadItemSchema>;
export type CloudReviewThreadItemAppendRequest = z.infer<
  typeof CloudReviewThreadItemAppendRequestSchema
>;
export type CloudReviewThreadResolutionRequest = z.infer<
  typeof CloudReviewThreadResolutionRequestSchema
>;
export type CloudReviewSuggestionDecisionRequest = z.infer<
  typeof CloudReviewSuggestionDecisionRequestSchema
>;
export type CloudReviewThreadResponse = z.infer<typeof CloudReviewThreadResponseSchema>;
export type CloudReviewThreadListResponse = z.infer<typeof CloudReviewThreadListResponseSchema>;
export type CloudReviewThreadItemResponse = z.infer<typeof CloudReviewThreadItemResponseSchema>;
export type CloudReviewSuggestionDecisionResponse = z.infer<
  typeof CloudReviewSuggestionDecisionResponseSchema
>;
export type CloudReviewThreadItemListResponse = z.infer<
  typeof CloudReviewThreadItemListResponseSchema
>;

function requireTimestampOrder(
  earlier: string,
  later: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  if (Date.parse(earlier) > Date.parse(later)) {
    context.addIssue({
      code: "custom",
      message: "Timestamp chronology is invalid",
      path: [...path],
    });
  }
}

function requireUniqueIds<Key extends string>(
  records: readonly Readonly<Record<Key, string>>[],
  key: Key,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  if (new Set(records.map((record) => record[key])).size !== records.length) {
    context.addIssue({
      code: "custom",
      message: `A page cannot contain duplicate ${key} values`,
      path: [...path],
    });
  }
}

function requireThreadItemScope(
  thread: z.infer<typeof CloudReviewThreadSchema>,
  item: z.infer<typeof CloudReviewThreadItemSchema>,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  if (
    item.tenantId !== thread.tenantId ||
    item.teamId !== thread.teamId ||
    item.projectId !== thread.projectId ||
    item.reviewId !== thread.reviewId ||
    item.threadId !== thread.threadId
  ) {
    context.addIssue({
      code: "custom",
      message: "Review item crossed its thread scope",
      path: [...path],
    });
  }
}
