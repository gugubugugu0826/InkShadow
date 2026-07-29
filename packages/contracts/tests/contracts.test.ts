import { describe, expect, it } from "vitest";

import {
  AiCandidateContractSchema,
  CONTRACT_SCHEMA_VERSION,
  GenerationEventSchema,
  GenerationStateContractSchema,
  LicenseStateContractSchema,
  NotificationContractSchema,
  PageStateContractSchema,
} from "../src/index.js";

const ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const CHAPTER_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const VERSION_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const NOW = "2026-07-27T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);

describe("stable state contracts", () => {
  it("accepts the frozen 14-state page contract", () => {
    const result = PageStateContractSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      state: "recoverable",
      visibleContent: ["last stable chapter", "recovery draft"],
      allowedActions: ["retry", "export"],
      prohibitedActions: ["overwrite stable chapter"],
      persistence: "mixed",
      recoveryActions: ["RETRY", "EXPORT_DRAFT"],
      error: {
        code: "SAVE_FAILED",
        message: "The stable chapter is unchanged.",
        retryable: true,
        actions: ["RETRY", "EXPORT_DRAFT"],
        details: {},
        requestId: null,
        supportId: null,
      },
      blocksNavigation: false,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an uncontracted page state", () => {
    const result = PageStateContractSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      state: "maintenance",
      visibleContent: [],
      allowedActions: [],
      prohibitedActions: [],
      persistence: "not_applicable",
      recoveryActions: [],
      error: null,
      blocksNavigation: true,
    });

    expect(result.success).toBe(false);
  });

  it("guarantees local data access in every license snapshot", () => {
    const result = LicenseStateContractSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      state: "offline_expired",
      entitlements: [],
      validUntil: NOW,
      localDataAccess: {
        read: true,
        edit: false,
        backup: true,
        export: true,
      },
      updatedAt: NOW,
    });

    expect(result.success).toBe(false);
  });

  it("does not allow blocking notifications to disappear on a timer", () => {
    const result = NotificationContractSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: ID,
      level: "blocking",
      state: "visible",
      dedupeKey: "save-failed",
      title: "Save failed",
      message: "The stable chapter is unchanged.",
      objectRoute: `/chapters/${CHAPTER_ID}`,
      createdAt: NOW,
      readAt: null,
      expiresAt: "2026-07-28T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("requires chapter candidates to retain their base version", () => {
    const result = AiCandidateContractSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: ID,
      projectId: ID,
      chapterId: CHAPTER_ID,
      source: "generate",
      baseVersionId: null,
      content: "candidate",
      contentChecksum: CHECKSUM,
      status: "ready",
      incomplete: false,
      createdAt: NOW,
      updatedAt: NOW,
      decidedAt: null,
    });

    expect(result.success).toBe(false);

    const valid = AiCandidateContractSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      id: ID,
      projectId: ID,
      chapterId: CHAPTER_ID,
      source: "generate",
      baseVersionId: VERSION_ID,
      content: "candidate",
      contentChecksum: CHECKSUM,
      status: "ready",
      incomplete: false,
      createdAt: NOW,
      updatedAt: NOW,
      decidedAt: null,
    });

    expect(valid.success).toBe(true);
  });

  it("keeps generation stream sequences inside the portable integer range", () => {
    const generation = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      generationId: ID,
      projectId: ID,
      chapterId: CHAPTER_ID,
      state: "queued",
      sequence: Number.MAX_SAFE_INTEGER,
      attempt: 1,
      idempotencyKey: "generation-request",
      candidateId: null,
      error: null,
      updatedAt: NOW,
    };
    const event = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      generationId: ID,
      type: "heartbeat",
      sequence: Number.MAX_SAFE_INTEGER,
      createdAt: NOW,
      payload: {},
    };

    expect(GenerationStateContractSchema.safeParse(generation).success).toBe(true);
    expect(GenerationEventSchema.safeParse(event).success).toBe(true);
    expect(
      GenerationStateContractSchema.safeParse({
        ...generation,
        sequence: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      GenerationEventSchema.safeParse({
        ...event,
        sequence: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });
});
