import { describe, expect, it } from "vitest";

import {
  CLOUD_API_OPERATIONS,
  CloudAiProjectBudgetUpdateRequestSchema,
  CloudAiTeamBudgetUpdateRequestSchema,
  CloudAiUsageReservationRequestSchema,
  CloudAiUsageReservationResponseSchema,
  CloudAiUsageSummaryResponseSchema,
  CONTRACT_SCHEMA_VERSION,
} from "../src/index.js";
import { INKSHADOW_CLOUD_OPENAPI } from "@inkshadow/contracts/openapi";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const RESERVATION_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const NOW = "2026-07-28T00:00:00.000Z";
const EXPIRES = "2026-07-28T00:05:00.000Z";

describe("cloud AI usage contracts", () => {
  it("imports at runtime and exposes all seven usage operations in OpenAPI", () => {
    expect(
      CLOUD_API_OPERATIONS.filter((operation) => operation.operationId.startsWith("ai")),
    ).toHaveLength(7);
    const document = INKSHADOW_CLOUD_OPENAPI as {
      readonly components: { readonly schemas: Readonly<Record<string, unknown>> };
    };
    expect(document.components.schemas.AiUsageSummaryResponse).toBeDefined();
    expect(document.components.schemas.AiUsageReservationResponse).toBeDefined();
  });

  it("accepts only portable integer prices and server-price reservations", () => {
    expect(
      CloudAiTeamBudgetUpdateRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 50_000_000,
        priceVersion: "studio-aud-2026-07",
        inputMicrounitsPerMillionTokens: 3_000_000,
        outputMicrounitsPerMillionTokens: 12_000_000,
        maximumConcurrentRuns: 5,
      }).success,
    ).toBe(true);
    expect(
      CloudAiTeamBudgetUpdateRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "aud",
        monthlyLimitMicrounits: Number.MAX_SAFE_INTEGER + 1,
        priceVersion: "studio-aud-2026-07",
        inputMicrounitsPerMillionTokens: 0,
        outputMicrounitsPerMillionTokens: 0,
        maximumConcurrentRuns: 5,
      }).success,
    ).toBe(false);
    expect(
      CloudAiProjectBudgetUpdateRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        monthlyLimitMicrounits: null,
        maximumConcurrentRuns: 2,
      }).success,
    ).toBe(true);
    expect(
      CloudAiUsageReservationRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        reservationId: RESERVATION_ID,
        modelIdentifier: "openai/gpt-5",
        purpose: "content_generation",
        priceVersion: "studio-aud-2026-07",
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 500,
        leaseTtlSeconds: 300,
        prompt: "must never cross the budget API",
      }).success,
    ).toBe(false);
  });

  it("keeps refined summaries reusable without Zod omit/extend runtime failures", () => {
    const summary = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      periodStart: "2026-07-01",
      currency: "AUD",
      priceVersion: "studio-aud-2026-07",
      teamBudget: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        tenantId: TENANT_ID,
        teamId: TEAM_ID,
        currency: "AUD",
        monthlyLimitMicrounits: 50_000_000,
        warningThresholdBasisPoints: 8_000,
        hardCap: true,
        priceVersion: "studio-aud-2026-07",
        inputMicrounitsPerMillionTokens: 3_000_000,
        outputMicrounitsPerMillionTokens: 12_000_000,
        maximumConcurrentRuns: 5,
        revision: 1,
        updatedByMembershipId: MEMBERSHIP_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
      projectBudget: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        tenantId: TENANT_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        monthlyLimitMicrounits: 20_000_000,
        maximumConcurrentRuns: 2,
        revision: 1,
        updatedByMembershipId: MEMBERSHIP_ID,
        createdAt: NOW,
        updatedAt: NOW,
      },
      team: bucket("team", null),
      project: bucket("project", PROJECT_ID),
      leaseExpiredCount: 0,
      activeLeaseCount: 1,
      maximumConcurrentRuns: 5,
      activeProjectLeaseCount: 1,
      projectMaximumConcurrentRuns: 2,
      effectiveMaximumConcurrentRuns: 2,
      concurrencyHardCapReached: false,
      capabilities: {
        manageTeamBudget: true,
        manageProjectBudget: true,
        consume: true,
      },
      serverTime: NOW,
    };
    expect(CloudAiUsageSummaryResponseSchema.safeParse(summary).success).toBe(true);
    expect(
      CloudAiUsageReservationResponseSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        reservation: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          reservationId: RESERVATION_ID,
          tenantId: TENANT_ID,
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          membershipId: MEMBERSHIP_ID,
          modelIdentifier: "openai/gpt-5",
          purpose: "content_generation",
          priceVersion: "studio-aud-2026-07",
          currency: "AUD",
          state: "active",
          reservedInputTokens: 1_000,
          reservedOutputTokens: 500,
          reservedMicrounits: 9_000,
          settledInputTokens: 0,
          settledOutputTokens: 0,
          settledMicrounits: 0,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          expiresAt: EXPIRES,
          settledAt: null,
          cancelledAt: null,
          expiredAt: null,
        },
        summary: (({ requestId, ...value }) => {
          void requestId;
          return value;
        })(summary),
      }).success,
    ).toBe(true);
  });
});

function bucket(scope: "team" | "project", projectId: string | null) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scope,
    projectId,
    monthlyLimitMicrounits: 50_000_000,
    settledMicrounits: 2_000_000,
    reservedMicrounits: 1_000_000,
    remainingMicrounits: 47_000_000,
    settledInputTokens: 100_000,
    settledOutputTokens: 50_000,
    reservedInputTokens: 20_000,
    reservedOutputTokens: 10_000,
    status: "ok",
    updatedAt: NOW,
  };
}
