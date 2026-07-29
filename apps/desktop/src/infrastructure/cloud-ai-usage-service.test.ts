import { describe, expect, it, vi } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { UuidV7Generator } from "@inkshadow/domain";

import { CloudAiUsageService, type CloudAiUsageApi } from "./cloud-ai-usage-service";
import type { CloudSessionCoordinator } from "./cloud-session-coordinator";

const FIRST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const SECOND_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";

describe("CloudAiUsageService", () => {
  it("wraps budget writes in the native session and generates an idempotency key", async () => {
    const updateTeamAiBudget = vi.fn().mockResolvedValue({ marker: "budget" });
    const { service, runWithSession } = createService({ updateTeamAiBudget });

    await expect(
      service.updateTeamBudget(TEAM_ID, {
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-07",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 4,
      }),
    ).resolves.toEqual({ marker: "budget" });

    expect(runWithSession).toHaveBeenCalledOnce();
    expect(updateTeamAiBudget).toHaveBeenCalledWith(
      TEAM_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        currency: "AUD",
        monthlyLimitMicrounits: 10_000,
        priceVersion: "aud-2026-07",
        inputMicrounitsPerMillionTokens: 1_000_000,
        outputMicrounitsPerMillionTokens: 2_000_000,
        maximumConcurrentRuns: 4,
      },
      { idempotencyKey: FIRST_ID },
    );
  });

  it("creates a reservation id separately from its idempotency key and sends metadata only", async () => {
    const reserveTeamProjectAiUsage = vi.fn().mockResolvedValue({ marker: "reserved" });
    const { service } = createService({ reserveTeamProjectAiUsage });

    await service.reserve(TEAM_ID, PROJECT_ID, {
      modelIdentifier: "openai/gpt-5",
      purpose: "content_generation",
      priceVersion: "aud-2026-07",
      estimatedInputTokens: 500,
      estimatedOutputTokens: 100,
      leaseTtlSeconds: 300,
    });

    expect(reserveTeamProjectAiUsage).toHaveBeenCalledWith(
      TEAM_ID,
      PROJECT_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        reservationId: FIRST_ID,
        modelIdentifier: "openai/gpt-5",
        purpose: "content_generation",
        priceVersion: "aud-2026-07",
        estimatedInputTokens: 500,
        estimatedOutputTokens: 100,
        leaseTtlSeconds: 300,
      },
      { idempotencyKey: SECOND_ID },
    );
    const serialized = JSON.stringify(reserveTeamProjectAiUsage.mock.calls);
    expect(serialized).not.toMatch(/"prompt"|"ciphertext"|"keyMaterial"|"projectDataKey"/u);
  });

  it("reuses reservation and idempotency identities when the session retries an expired request", async () => {
    const reserveTeamProjectAiUsage = vi.fn().mockResolvedValue({ marker: "reserved" });
    const { service } = createService({ reserveTeamProjectAiUsage }, true);

    await service.reserve(TEAM_ID, PROJECT_ID, {
      modelIdentifier: "openai/gpt-5",
      purpose: "read_only_review",
      priceVersion: "aud-2026-07",
      estimatedInputTokens: 500,
      estimatedOutputTokens: 100,
      leaseTtlSeconds: 300,
    });

    expect(reserveTeamProjectAiUsage).toHaveBeenCalledTimes(2);
    expect(reserveTeamProjectAiUsage.mock.calls[0]?.[2]).toEqual(
      reserveTeamProjectAiUsage.mock.calls[1]?.[2],
    );
    expect(reserveTeamProjectAiUsage.mock.calls[0]?.[3]).toEqual(
      reserveTeamProjectAiUsage.mock.calls[1]?.[3],
    );
  });
});

function createService(overrides: Partial<CloudAiUsageApi>, retryOperation = false) {
  const api = {
    updateTeamAiBudget: vi.fn(),
    updateProjectAiBudget: vi.fn(),
    getTeamAiUsageSummary: vi.fn(),
    listTeamAiUsageEvents: vi.fn(),
    reserveTeamProjectAiUsage: vi.fn(),
    settleTeamProjectAiUsage: vi.fn(),
    cancelTeamProjectAiUsage: vi.fn(),
    ...overrides,
  } satisfies CloudAiUsageApi;
  const runWithSession = vi.fn(async (operation: (status: never) => Promise<unknown>) => {
    if (retryOperation) {
      await operation({} as never);
    }
    return operation({} as never);
  });
  const session = { runWithSession } as unknown as Pick<CloudSessionCoordinator, "runWithSession">;
  const values = [FIRST_ID, SECOND_ID];
  const ids = {
    next: () => values.shift() ?? SECOND_ID,
  } as unknown as UuidV7Generator;
  return {
    service: new CloudAiUsageService(api, session, ids),
    runWithSession,
  };
}
