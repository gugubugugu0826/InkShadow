import { describe, expect, it } from "vitest";
import {
  MEMORY_LEVELS,
  MemoryApplicationService,
  MemoryPolicy,
  MemoryRecord,
  StoryCoreError,
  err,
  ok,
  type MemoryPolicyRepository,
  type MemoryRecordCreationUnitOfWork,
  type MemoryRecordRepository,
} from "../src/index.js";
import { ManualClock, SequenceUuidV7Generator, unwrap, uuid } from "./helpers.js";

describe("L1-L4 memory records", () => {
  it("retains level, source, source version, and defaults", () => {
    for (const [index, level] of MEMORY_LEVELS.entries()) {
      const record = unwrap(
        MemoryRecord.create({
          id: uuid(10 + index),
          projectId: uuid(1),
          level,
          content: `Memory ${level}`,
          source: {
            kind: "chapter",
            sourceId: uuid(2),
            sourceVersionId: uuid(3),
          },
          origin: "user",
          now: "2026-07-27T00:00:00.000Z",
        }),
      );
      expect(record.toSnapshot()).toMatchObject({
        level,
        source: {
          kind: "chapter",
          sourceId: uuid(2),
          sourceVersionId: uuid(3),
        },
        status: "enabled",
        pinned: false,
        excluded: false,
        weight: 1,
      });
    }
  });

  it("keeps automatic learning disabled until explicitly enabled", () => {
    const projectId = uuid(20);
    const policy = unwrap(MemoryPolicy.create(projectId, "2026-07-27T00:00:00.000Z"));
    expect(policy.automaticLearningEnabled).toBe(false);

    const blocked = MemoryRecord.create({
      id: uuid(21),
      projectId,
      level: "L4",
      content: "Automatically inferred preference",
      source: {
        kind: "session",
        sourceId: uuid(22),
        sourceVersionId: null,
      },
      origin: "automatic",
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe("MEMORY_AUTO_LEARNING_DISABLED");
    }

    const enabled = unwrap(
      policy.setAutomaticLearning({
        enabled: true,
        humanConfirmed: true,
        expectedRevision: 1,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );
    const automatic = MemoryRecord.create({
      id: uuid(23),
      projectId,
      level: "L4",
      content: "Automatically inferred preference",
      source: {
        kind: "session",
        sourceId: uuid(22),
        sourceVersionId: null,
      },
      origin: "automatic",
      automaticLearningAuthorization: unwrap(enabled.authorizeAutomaticLearning()),
      now: "2026-07-27T00:03:00.000Z",
    });
    expect(automatic.ok).toBe(true);
    if (automatic.ok) {
      expect(automatic.value.toSnapshot().automaticLearningPolicyRevision).toBe(2);
    }
  });

  it("supports explicit pin, exclude, downweight, and disable governance", () => {
    const original = createMemory(30);
    const refused = original.pin({
      humanConfirmed: false,
      expectedRevision: 1,
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("HUMAN_DECISION_REQUIRED");
    }

    const pinned = unwrap(
      original.pin({
        humanConfirmed: true,
        expectedRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    expect(pinned.toSnapshot()).toMatchObject({
      pinned: true,
      excluded: false,
      weight: 1,
    });

    const excluded = unwrap(
      pinned.exclude({
        humanConfirmed: true,
        expectedRevision: 2,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );
    expect(excluded.toSnapshot()).toMatchObject({
      pinned: false,
      excluded: true,
      weight: 0,
    });

    const downweighted = unwrap(
      excluded.downweight({
        weight: 0.25,
        humanConfirmed: true,
        expectedRevision: 3,
        now: "2026-07-27T00:03:00.000Z",
      }),
    );
    expect(downweighted.toSnapshot()).toMatchObject({
      pinned: false,
      excluded: false,
      weight: 0.25,
    });

    const disabled = unwrap(
      downweighted.setEnabled({
        enabled: false,
        humanConfirmed: true,
        expectedRevision: 4,
        now: "2026-07-27T00:04:00.000Z",
      }),
    );
    const use = disabled.recordUse(5, "2026-07-27T00:05:00.000Z");
    expect(use.ok).toBe(false);
    if (!use.ok) {
      expect(use.error.code).toBe("MEMORY_INVALID_GOVERNANCE");
    }
  });

  it("rejects chapter memory without a source version", () => {
    const result = MemoryRecord.create({
      id: uuid(50),
      projectId: uuid(51),
      level: "L2",
      content: "Missing source version",
      source: {
        kind: "chapter",
        sourceId: uuid(52),
        sourceVersionId: null,
      },
      origin: "user",
      now: "2026-07-27T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_VALIDATION_FAILED");
    }
  });

  it("atomically rejects automatic memory when its policy is disabled during creation", async () => {
    const projectId = uuid(60);
    let currentPolicy = unwrap(MemoryPolicy.create(projectId, "2026-07-27T00:00:00.000Z"));
    currentPolicy = unwrap(
      currentPolicy.setAutomaticLearning({
        enabled: true,
        humanConfirmed: true,
        expectedRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    const persistedRecords = new Map<string, MemoryRecord>();
    let attemptedPolicyRevision: number | null = null;

    const policies: MemoryPolicyRepository = {
      createIfAbsent: (policy) => Promise.resolve(ok({ policy, created: true })),
      findByProjectId: (requestedProjectId) =>
        Promise.resolve(ok(requestedProjectId === currentPolicy.projectId ? currentPolicy : null)),
      save: (policy, expectedRevision) => {
        if (currentPolicy.revision !== expectedRevision) {
          return Promise.resolve(
            err(
              new StoryCoreError({
                code: "STORY_REVISION_CONFLICT",
                message: "Memory policy changed.",
              }),
            ),
          );
        }
        currentPolicy = policy;
        return Promise.resolve(ok(undefined));
      },
    };
    const records: MemoryRecordRepository = {
      findById: (id) => Promise.resolve(ok(persistedRecords.get(id) ?? null)),
      save: (record, expectedRevision) => {
        const current = persistedRecords.get(record.id);
        if (current?.revision !== expectedRevision) {
          return Promise.resolve(
            err(
              new StoryCoreError({
                code: "STORY_REVISION_CONFLICT",
                message: "Memory record changed.",
              }),
            ),
          );
        }
        persistedRecords.set(record.id, record);
        return Promise.resolve(ok(undefined));
      },
    };
    const creation: MemoryRecordCreationUnitOfWork = {
      create: (input) => {
        attemptedPolicyRevision = input.record.toSnapshot().automaticLearningPolicyRevision;
        currentPolicy = unwrap(
          currentPolicy.setAutomaticLearning({
            enabled: false,
            humanConfirmed: true,
            expectedRevision: 2,
            now: "2026-07-27T00:02:00.000Z",
          }),
        );
        if (
          !currentPolicy.automaticLearningEnabled ||
          currentPolicy.revision !== input.expectedAutomaticLearningPolicyRevision
        ) {
          return Promise.resolve(
            err(
              new StoryCoreError({
                code: "STORY_REVISION_CONFLICT",
                message: "Automatic-learning policy changed before memory creation.",
                actions: ["RETRY", "ENABLE_MEMORY"],
              }),
            ),
          );
        }
        persistedRecords.set(input.record.id, input.record);
        return Promise.resolve(ok(undefined));
      },
    };
    const service = new MemoryApplicationService({
      policies,
      records,
      creation,
      clock: new ManualClock("2026-07-27T00:03:00.000Z"),
      ids: new SequenceUuidV7Generator(2_000),
    });

    const result = await service.createRecord({
      projectId,
      level: "L4",
      content: "Automatically learned preference",
      source: {
        kind: "session",
        sourceId: uuid(61),
        sourceVersionId: null,
      },
      origin: "automatic",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_REVISION_CONFLICT");
    }
    expect(attemptedPolicyRevision).toBe(2);
    expect(persistedRecords.size).toBe(0);
  });
});

function createMemory(base: number): MemoryRecord {
  return unwrap(
    MemoryRecord.create({
      id: uuid(base),
      projectId: uuid(base + 1),
      level: "L3",
      content: "User-governed memory",
      source: {
        kind: "user_rule",
        sourceId: uuid(base + 2),
        sourceVersionId: null,
      },
      origin: "user",
      now: "2026-07-27T00:00:00.000Z",
    }),
  );
}
