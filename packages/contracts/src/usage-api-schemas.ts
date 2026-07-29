import { z } from "zod";

import { PositivePortableIntegerSchema } from "./cloud-schemas.js";
import { CloudCursorSchema } from "./cloud-api-schemas.js";
import { CONTRACT_SCHEMA_VERSION, IsoUtcTimestampSchema, UuidV7Schema } from "./schemas.js";

const PortableIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/u);
const PriceVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u);
const ModelIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/u);

export const CloudAiUsageStatusSchema = z.enum(["unconfigured", "ok", "warning", "hard_cap"]);
export const CloudAiReservationStateSchema = z.enum(["active", "settled", "cancelled", "expired"]);
export const CloudAiUsageEventTypeSchema = z.enum([
  "reserved",
  "settled",
  "cancelled",
  "lease_expired",
]);
export const CloudAiUsagePurposeSchema = z.enum(["content_generation", "read_only_review"]);

export const CloudAiUsageCapabilitiesSchema = z
  .object({
    manageTeamBudget: z.boolean(),
    manageProjectBudget: z.boolean(),
    consume: z.boolean(),
  })
  .strict();

export const CloudAiTeamBudgetSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    currency: CurrencySchema,
    monthlyLimitMicrounits: PositivePortableIntegerSchema,
    warningThresholdBasisPoints: z.literal(8_000),
    hardCap: z.literal(true),
    priceVersion: PriceVersionSchema,
    inputMicrounitsPerMillionTokens: PortableIntegerSchema,
    outputMicrounitsPerMillionTokens: PortableIntegerSchema,
    maximumConcurrentRuns: z.number().int().min(1).max(10_000),
    revision: PositivePortableIntegerSchema,
    updatedByMembershipId: UuidV7Schema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudAiProjectBudgetSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    monthlyLimitMicrounits: PositivePortableIntegerSchema.nullable(),
    maximumConcurrentRuns: z.number().int().min(1).max(10_000).nullable(),
    revision: PositivePortableIntegerSchema,
    updatedByMembershipId: UuidV7Schema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudAiTeamBudgetUpdateRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema.nullable(),
    currency: CurrencySchema,
    monthlyLimitMicrounits: PositivePortableIntegerSchema,
    priceVersion: PriceVersionSchema,
    inputMicrounitsPerMillionTokens: PortableIntegerSchema,
    outputMicrounitsPerMillionTokens: PortableIntegerSchema,
    maximumConcurrentRuns: z.number().int().min(1).max(10_000),
  })
  .strict()
  .refine(
    (request) =>
      request.inputMicrounitsPerMillionTokens > 0 || request.outputMicrounitsPerMillionTokens > 0,
    {
      message: "At least one AI token price must be positive",
      path: ["inputMicrounitsPerMillionTokens"],
    },
  );

export const CloudAiProjectBudgetUpdateRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema.nullable(),
    monthlyLimitMicrounits: PositivePortableIntegerSchema.nullable(),
    maximumConcurrentRuns: z.number().int().min(1).max(10_000).nullable(),
  })
  .strict();

export const CloudAiTeamBudgetResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    budget: CloudAiTeamBudgetSchema,
  })
  .strict();

export const CloudAiProjectBudgetResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    budget: CloudAiProjectBudgetSchema,
  })
  .strict();

export const CloudAiUsageBucketSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    scope: z.enum(["team", "project"]),
    projectId: UuidV7Schema.nullable(),
    monthlyLimitMicrounits: PositivePortableIntegerSchema.nullable(),
    settledMicrounits: PortableIntegerSchema,
    reservedMicrounits: PortableIntegerSchema,
    remainingMicrounits: PortableIntegerSchema.nullable(),
    settledInputTokens: PortableIntegerSchema,
    settledOutputTokens: PortableIntegerSchema,
    reservedInputTokens: PortableIntegerSchema,
    reservedOutputTokens: PortableIntegerSchema,
    status: CloudAiUsageStatusSchema,
    updatedAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((bucket, context) => {
    if (
      (bucket.scope === "team" && bucket.projectId !== null) ||
      (bucket.scope === "project" && bucket.projectId === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "AI usage bucket scope and projectId must agree",
        path: ["projectId"],
      });
    }
    if (
      (bucket.monthlyLimitMicrounits === null &&
        (bucket.remainingMicrounits !== null || bucket.status !== "unconfigured")) ||
      (bucket.monthlyLimitMicrounits !== null &&
        (bucket.remainingMicrounits === null || bucket.status === "unconfigured"))
    ) {
      context.addIssue({
        code: "custom",
        message: "AI usage budget, remaining value and status must agree",
        path: ["status"],
      });
    }
  });

const CloudAiUsageSummaryFields = {
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  tenantId: UuidV7Schema,
  teamId: UuidV7Schema,
  periodStart: MonthSchema,
  currency: CurrencySchema.nullable(),
  priceVersion: PriceVersionSchema.nullable(),
  teamBudget: CloudAiTeamBudgetSchema.nullable(),
  projectBudget: CloudAiProjectBudgetSchema.nullable(),
  team: CloudAiUsageBucketSchema.nullable(),
  project: CloudAiUsageBucketSchema.nullable(),
  leaseExpiredCount: PortableIntegerSchema,
  activeLeaseCount: PortableIntegerSchema,
  maximumConcurrentRuns: z.number().int().min(1).max(10_000).nullable(),
  activeProjectLeaseCount: PortableIntegerSchema.nullable(),
  projectMaximumConcurrentRuns: z.number().int().min(1).max(10_000).nullable(),
  effectiveMaximumConcurrentRuns: z.number().int().min(1).max(10_000).nullable(),
  concurrencyHardCapReached: z.boolean(),
  capabilities: CloudAiUsageCapabilitiesSchema,
  serverTime: IsoUtcTimestampSchema,
} as const;

const CloudAiUsageSummarySchema = z
  .object(CloudAiUsageSummaryFields)
  .strict()
  .superRefine(validateUsageSummary);

export const CloudAiUsageSummaryResponseSchema = z
  .object({
    ...CloudAiUsageSummaryFields,
    requestId: UuidV7Schema,
  })
  .strict()
  .superRefine(validateUsageSummary);

export const CloudAiUsageReservationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    reservationId: UuidV7Schema,
    modelIdentifier: ModelIdentifierSchema,
    purpose: CloudAiUsagePurposeSchema,
    priceVersion: PriceVersionSchema,
    estimatedInputTokens: PortableIntegerSchema,
    estimatedOutputTokens: PortableIntegerSchema,
    leaseTtlSeconds: z.number().int().min(30).max(3_600),
  })
  .strict()
  .refine((request) => request.estimatedInputTokens > 0 || request.estimatedOutputTokens > 0, {
    message: "An AI usage reservation must contain at least one token",
    path: ["estimatedInputTokens"],
  });

export const CloudAiUsageSettlementRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
    actualInputTokens: PortableIntegerSchema,
    actualOutputTokens: PortableIntegerSchema,
  })
  .strict();

export const CloudAiUsageCancellationRequestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    expectedRevision: PositivePortableIntegerSchema,
  })
  .strict();

export const CloudAiUsageReservationSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    reservationId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    membershipId: UuidV7Schema,
    modelIdentifier: ModelIdentifierSchema,
    purpose: CloudAiUsagePurposeSchema,
    priceVersion: PriceVersionSchema,
    currency: CurrencySchema,
    state: CloudAiReservationStateSchema,
    reservedInputTokens: PortableIntegerSchema,
    reservedOutputTokens: PortableIntegerSchema,
    reservedMicrounits: PortableIntegerSchema,
    settledInputTokens: PortableIntegerSchema,
    settledOutputTokens: PortableIntegerSchema,
    settledMicrounits: PortableIntegerSchema,
    revision: PositivePortableIntegerSchema,
    createdAt: IsoUtcTimestampSchema,
    updatedAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    settledAt: IsoUtcTimestampSchema.nullable(),
    cancelledAt: IsoUtcTimestampSchema.nullable(),
    expiredAt: IsoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((reservation, context) => {
    const terminalFields = [
      reservation.settledAt !== null,
      reservation.cancelledAt !== null,
      reservation.expiredAt !== null,
    ].filter(Boolean).length;
    if (
      (reservation.state === "active" && terminalFields !== 0) ||
      (reservation.state !== "active" && terminalFields !== 1)
    ) {
      context.addIssue({
        code: "custom",
        message: "AI reservation state and terminal timestamps must agree",
        path: ["state"],
      });
    }
    if (
      reservation.settledInputTokens > reservation.reservedInputTokens ||
      reservation.settledOutputTokens > reservation.reservedOutputTokens ||
      reservation.settledMicrounits > reservation.reservedMicrounits
    ) {
      context.addIssue({
        code: "custom",
        message: "Settled AI usage cannot exceed its reservation",
        path: ["settledMicrounits"],
      });
    }
  });

export const CloudAiUsageReservationResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    reservation: CloudAiUsageReservationSchema,
    summary: CloudAiUsageSummarySchema,
  })
  .strict();

export const CloudAiUsageEventSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    eventId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    membershipId: UuidV7Schema,
    reservationId: UuidV7Schema,
    requestId: UuidV7Schema,
    eventType: CloudAiUsageEventTypeSchema,
    inputTokens: PortableIntegerSchema,
    outputTokens: PortableIntegerSchema,
    costMicrounits: PortableIntegerSchema,
    currency: CurrencySchema,
    priceVersion: PriceVersionSchema,
    modelIdentifier: ModelIdentifierSchema,
    purpose: CloudAiUsagePurposeSchema,
    createdAt: IsoUtcTimestampSchema,
  })
  .strict();

export const CloudAiUsageEventListResponseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    requestId: UuidV7Schema,
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema.nullable(),
    events: z.array(CloudAiUsageEventSchema).max(100),
    nextCursor: CloudCursorSchema.nullable(),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      response.events.some(
        (event) =>
          event.tenantId !== response.tenantId ||
          event.teamId !== response.teamId ||
          (response.projectId !== null && event.projectId !== response.projectId),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "AI usage event page crossed its requested scope",
        path: ["events"],
      });
    }
  });

function validateUsageSummary(
  response: {
    readonly currency: string | null;
    readonly priceVersion: string | null;
    readonly teamBudget: CloudAiTeamBudget | null;
    readonly projectBudget: CloudAiProjectBudget | null;
    readonly project: unknown;
    readonly team: unknown;
    readonly activeLeaseCount: number;
    readonly maximumConcurrentRuns: number | null;
    readonly activeProjectLeaseCount: number | null;
    readonly projectMaximumConcurrentRuns: number | null;
    readonly effectiveMaximumConcurrentRuns: number | null;
    readonly concurrencyHardCapReached: boolean;
  },
  context: z.RefinementCtx,
): void {
  if ((response.currency === null) !== (response.priceVersion === null)) {
    context.addIssue({
      code: "custom",
      message: "AI usage currency and price version must be configured together",
      path: ["priceVersion"],
    });
  }
  if (response.team === null && response.project === null) {
    context.addIssue({
      code: "custom",
      message: "AI usage summary must expose at least one authorized scope",
      path: ["team"],
    });
  }
  if (
    (response.teamBudget !== null && response.team === null) ||
    (response.projectBudget !== null && response.project === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "AI budget details cannot cross an unauthorized usage scope",
      path: ["teamBudget"],
    });
  }
  const expectedEffectiveLimit =
    response.maximumConcurrentRuns === null
      ? null
      : response.projectMaximumConcurrentRuns === null
        ? response.maximumConcurrentRuns
        : Math.min(response.maximumConcurrentRuns, response.projectMaximumConcurrentRuns);
  const teamCapReached =
    response.maximumConcurrentRuns !== null &&
    response.activeLeaseCount >= response.maximumConcurrentRuns;
  const projectCapReached =
    response.projectMaximumConcurrentRuns !== null &&
    response.activeProjectLeaseCount !== null &&
    response.activeProjectLeaseCount >= response.projectMaximumConcurrentRuns;
  if (
    (response.maximumConcurrentRuns === null && response.activeLeaseCount !== 0) ||
    (response.activeProjectLeaseCount === null && response.projectMaximumConcurrentRuns !== null) ||
    response.effectiveMaximumConcurrentRuns !== expectedEffectiveLimit ||
    response.concurrencyHardCapReached !== (teamCapReached || projectCapReached)
  ) {
    context.addIssue({
      code: "custom",
      message: "AI usage concurrency count, limit and hard-cap state must agree",
      path: ["concurrencyHardCapReached"],
    });
  }
}

export type CloudAiUsageStatus = z.infer<typeof CloudAiUsageStatusSchema>;
export type CloudAiReservationState = z.infer<typeof CloudAiReservationStateSchema>;
export type CloudAiUsageEventType = z.infer<typeof CloudAiUsageEventTypeSchema>;
export type CloudAiUsagePurpose = z.infer<typeof CloudAiUsagePurposeSchema>;
export type CloudAiUsageCapabilities = z.infer<typeof CloudAiUsageCapabilitiesSchema>;
export type CloudAiTeamBudget = z.infer<typeof CloudAiTeamBudgetSchema>;
export type CloudAiProjectBudget = z.infer<typeof CloudAiProjectBudgetSchema>;
export type CloudAiTeamBudgetUpdateRequest = z.infer<typeof CloudAiTeamBudgetUpdateRequestSchema>;
export type CloudAiProjectBudgetUpdateRequest = z.infer<
  typeof CloudAiProjectBudgetUpdateRequestSchema
>;
export type CloudAiTeamBudgetResponse = z.infer<typeof CloudAiTeamBudgetResponseSchema>;
export type CloudAiProjectBudgetResponse = z.infer<typeof CloudAiProjectBudgetResponseSchema>;
export type CloudAiUsageBucket = z.infer<typeof CloudAiUsageBucketSchema>;
export type CloudAiUsageSummaryResponse = z.infer<typeof CloudAiUsageSummaryResponseSchema>;
export type CloudAiUsageReservationRequest = z.infer<typeof CloudAiUsageReservationRequestSchema>;
export type CloudAiUsageSettlementRequest = z.infer<typeof CloudAiUsageSettlementRequestSchema>;
export type CloudAiUsageCancellationRequest = z.infer<typeof CloudAiUsageCancellationRequestSchema>;
export type CloudAiUsageReservation = z.infer<typeof CloudAiUsageReservationSchema>;
export type CloudAiUsageReservationResponse = z.infer<typeof CloudAiUsageReservationResponseSchema>;
export type CloudAiUsageEvent = z.infer<typeof CloudAiUsageEventSchema>;
export type CloudAiUsageEventListResponse = z.infer<typeof CloudAiUsageEventListResponseSchema>;
