import type {
  CloudAiReservationState,
  CloudAiUsagePurpose,
  CloudAiUsageEventType,
  CloudApiOperationId,
} from "@inkshadow/contracts";

export interface CloudAiTeamBudgetRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly currency: string;
  readonly monthlyLimitMicrounits: number;
  readonly warningThresholdBasisPoints: 8_000;
  readonly hardCap: true;
  readonly priceVersion: string;
  readonly inputMicrounitsPerMillionTokens: number;
  readonly outputMicrounitsPerMillionTokens: number;
  readonly maximumConcurrentRuns: number;
  readonly revision: number;
  readonly updatedByMembershipId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CloudAiProjectBudgetRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly monthlyLimitMicrounits: number | null;
  readonly maximumConcurrentRuns: number | null;
  readonly revision: number;
  readonly updatedByMembershipId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CloudAiUsageMonthRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string | null;
  readonly periodStart: string;
  readonly settledMicrounits: number;
  readonly reservedMicrounits: number;
  readonly settledInputTokens: number;
  readonly settledOutputTokens: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly updatedAt: Date;
}

export interface CloudAiUsageReservationRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly reservationId: string;
  readonly membershipId: string;
  readonly modelIdentifier: string;
  readonly purpose: CloudAiUsagePurpose;
  readonly priceVersion: string;
  readonly currency: string;
  readonly state: CloudAiReservationState;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedMicrounits: number;
  readonly inputMicrounitsPerMillionTokens: number;
  readonly outputMicrounitsPerMillionTokens: number;
  readonly settledInputTokens: number;
  readonly settledOutputTokens: number;
  readonly settledMicrounits: number;
  readonly revision: number;
  readonly requestHashSha256: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly settledAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly expiredAt: Date | null;
}

export interface CloudAiUsageIdempotencyRecord {
  readonly idempotencyKeyHashSha256: string;
  readonly actorAccountId: string;
  readonly operationId: Extract<
    CloudApiOperationId,
    | "aiBudgets.updateTeam"
    | "aiBudgets.updateProject"
    | "aiUsage.reserve"
    | "aiUsage.settle"
    | "aiUsage.cancel"
  >;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string | null;
  readonly resourceId: string;
  readonly requestHashSha256: string;
  readonly resultRevision: number;
  readonly responseDigestSha256: string;
  readonly responseSnapshot: unknown;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface CloudAiUsageEventRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly membershipId: string;
  readonly reservationId: string;
  readonly requestId: string;
  readonly eventType: CloudAiUsageEventType;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrounits: number;
  readonly currency: string;
  readonly priceVersion: string;
  readonly modelIdentifier: string;
  readonly purpose: CloudAiUsagePurpose;
  readonly createdAt: Date;
}
