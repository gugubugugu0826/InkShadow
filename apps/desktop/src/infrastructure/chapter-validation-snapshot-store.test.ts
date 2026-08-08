import { parseIsoUtcTimestamp, parseUuidV7, type UuidV7 } from "@inkshadow/domain";
import { CryptoContentHasher } from "@inkshadow/platform";
import { describe, expect, it } from "vitest";

import type { ChapterNovelValidationResult } from "./novel-validation-runtime";
import {
  BrowserDevelopmentChapterValidationSnapshotStore,
  ChapterValidationSnapshotService,
  DEVELOPMENT_CHAPTER_VALIDATION_SNAPSHOT_KEY,
  type ChapterValidationSnapshotError,
} from "./chapter-validation-snapshot-store";

const PROJECT_ID = uuid("019f9f4a-b3c7-7350-9226-000000000001");
const CHAPTER_ID = uuid("019f9f4a-b3c7-7350-9226-000000000002");
const VERSION_ID = uuid("019f9f4a-b3c7-7350-9226-000000000003");
const PREVIOUS_VERSION_ID = uuid("019f9f4a-b3c7-7350-9226-000000000004");
const SNAPSHOT_IDS = [
  uuid("019f9f4a-b3c7-7350-9226-000000000101"),
  uuid("019f9f4a-b3c7-7350-9226-000000000102"),
  uuid("019f9f4a-b3c7-7350-9226-000000000103"),
] as const;
const COVERAGE_CATEGORIES = [
  "character_life_status",
  "character_age",
  "character_identity",
  "relationship",
  "event_time",
  "entity_location",
  "item_ownership",
  "ability_state",
  "world_property",
  "character_knowledge",
] as const;

describe("chapter validation snapshots", () => {
  it("persists exact evidence and reuses an identical current result idempotently", async () => {
    const storage = new MemoryStorage();
    const result = validationResult();
    const firstService = service(storage, result);

    const first = await firstService.run(
      { projectId: PROJECT_ID, chapterId: CHAPTER_ID },
      { mode: "reuse_current" },
    );
    const reused = await firstService.run(
      { projectId: PROJECT_ID, chapterId: CHAPTER_ID },
      { mode: "reuse_current" },
    );

    expect(reused.id).toBe(first.id);
    expect(reused.runSequence).toBe(1);
    const reopened = await service(storage, result).findLatest(PROJECT_ID, CHAPTER_ID);
    expect(reopened).toMatchObject({
      id: first.id,
      chapterVersionId: VERSION_ID,
      chapterRevision: 3,
      resultStatus: "checked",
      issueCount: 1,
      runKind: "initial",
    });
    expect(reopened?.result.issues[0]).toMatchObject({
      severity: "error",
      currentEvidence: [
        {
          sourceVersionId: VERSION_ID,
          excerpt: "林遥已经死去。",
          startOffset: 0,
          endOffset: 7,
        },
      ],
      conflictingEvidence: [
        {
          sourceVersionId: PREVIOUS_VERSION_ID,
          excerpt: "林遥仍然活着。",
        },
      ],
    });
    expect(reopened?.ruleSetVersion).toBe("deterministic-novel-validator.v2");
    expect(reopened?.result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "character_life_status",
          status: "checked",
          comparableReferenceCount: 1,
        }),
      ]),
    );
  });

  it("keeps a legacy result readable but leaves its missing coverage explicit", async () => {
    const storage = new MemoryStorage();
    const legacy = validationResult(false);
    await service(storage, legacy).run(
      { projectId: PROJECT_ID, chapterId: CHAPTER_ID },
      { mode: "rerun" },
    );

    const reopened = await service(storage, legacy).findLatest(PROJECT_ID, CHAPTER_ID);

    expect(reopened?.result.coverage).toBeUndefined();
    expect(reopened?.ruleSetVersion).toBe("deterministic-novel-validator.v2");
  });

  it("appends an explicit rerun and links it to the previous immutable snapshot", async () => {
    const storage = new MemoryStorage();
    const snapshotService = service(storage, validationResult());
    const first = await snapshotService.run(
      { projectId: PROJECT_ID, chapterId: CHAPTER_ID },
      { mode: "rerun" },
    );
    const second = await snapshotService.run(
      { projectId: PROJECT_ID, chapterId: CHAPTER_ID },
      { mode: "rerun" },
    );

    expect(second).toMatchObject({
      runSequence: 2,
      runKind: "rerun",
      supersedesSnapshotId: first.id,
      chapterVersionId: VERSION_ID,
    });
    expect(second.id).not.toBe(first.id);
  });

  it("fails closed when a persisted result changes after its checksum was recorded", async () => {
    const storage = new MemoryStorage();
    const snapshotService = service(storage, validationResult());
    await snapshotService.run({ projectId: PROJECT_ID, chapterId: CHAPTER_ID }, { mode: "rerun" });
    const serialized = storage.getItem(DEVELOPMENT_CHAPTER_VALIDATION_SNAPSHOT_KEY);
    expect(serialized).not.toBeNull();
    const database = JSON.parse(serialized ?? "") as {
      snapshots: Record<string, { result: { explanation: string } }>;
    };
    const stored = Object.values(database.snapshots)[0];
    if (stored === undefined) throw new Error("missing test snapshot");
    stored.result.explanation = "tampered but still structurally valid";
    storage.setItem(DEVELOPMENT_CHAPTER_VALIDATION_SNAPSHOT_KEY, JSON.stringify(database));

    await expect(snapshotService.findLatest(PROJECT_ID, CHAPTER_ID)).rejects.toMatchObject({
      code: "CHAPTER_VALIDATION_SNAPSHOT_CORRUPT",
    } satisfies Partial<ChapterValidationSnapshotError>);
    await expect(
      snapshotService.run(
        { projectId: PROJECT_ID, chapterId: CHAPTER_ID },
        { mode: "reuse_current" },
      ),
    ).rejects.toMatchObject({
      code: "CHAPTER_VALIDATION_SNAPSHOT_CORRUPT",
    } satisfies Partial<ChapterValidationSnapshotError>);
  });
});

function service(storage: Storage, result: ChapterNovelValidationResult) {
  let idIndex = 0;
  return new ChapterValidationSnapshotService({
    validator: { checkChapter: () => Promise.resolve(result) },
    store: new BrowserDevelopmentChapterValidationSnapshotStore(storage),
    ids: {
      next: () => {
        const id = SNAPSHOT_IDS[idIndex];
        idIndex += 1;
        if (id === undefined) throw new Error("test id sequence exhausted");
        return id;
      },
    },
    clock: { now: () => timestamp("2026-08-08T00:00:00.000Z") },
    hasher: new CryptoContentHasher(),
  });
}

function validationResult(includeCoverage = true): ChapterNovelValidationResult {
  const currentHash = "a".repeat(64);
  const previousHash = "b".repeat(64);
  return {
    status: "checked",
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    chapterVersionId: VERSION_ID,
    chapterRevision: 3,
    issues: [
      {
        id: "character_life_status_conflict:lin-yao",
        type: "character_life_status_conflict",
        currentTextExcerpt: "林遥已经死去。",
        currentClaim: {
          factId: "fact-current",
          factRevision: 1,
          factType: "character_life_status",
          subjectId: "lin-yao",
          attributeKey: "life_status",
          value: "dead",
          effectiveRange: { startOrder: 3, endOrder: null },
        },
        conflictingFact: {
          id: "reference-fact:1",
          factId: "fact-reference",
          factRevision: 2,
          source: "confirmed_fact",
          statement: "林遥仍然活着。",
          value: "alive",
          operator: "equals",
        },
        currentEvidence: [
          {
            sourceKind: "chapter",
            sourceId: CHAPTER_ID,
            sourceVersionId: VERSION_ID,
            contentHash: currentHash,
            locator: "chapter:0-7",
            excerpt: "林遥已经死去。",
            startOffset: 0,
            endOffset: 7,
            sourceLength: 7,
          },
        ],
        conflictingEvidence: [
          {
            sourceKind: "chapter",
            sourceId: CHAPTER_ID,
            sourceVersionId: PREVIOUS_VERSION_ID,
            contentHash: previousHash,
            locator: "chapter:0-7",
            excerpt: "林遥仍然活着。",
            startOffset: 0,
            endOffset: 7,
            sourceLength: 7,
          },
        ],
        severity: "error",
        modificationSuggestion: "修改当前正文，或由用户确认更新正式设定。",
        availableActions: ["ignore", "allow", "update_setting"],
        resolution: { status: "unresolved" },
        canUndoIgnore: false,
      },
    ],
    resolutions: [],
    skippedFacts: [],
    missingRequirements: [],
    explanation: "完成一项有精确证据的确定性检查。",
    checked: { currentClaims: 1, referenceFacts: 1, hardRules: 0 },
    ...(includeCoverage
      ? {
          coverage: COVERAGE_CATEGORIES.map((category) =>
            category === "character_life_status"
              ? {
                  category,
                  status: "checked" as const,
                  reason: "explicit_claim_compared" as const,
                  currentClaimCount: 1,
                  comparableReferenceCount: 1,
                  applicableHardRuleCount: 0,
                }
              : {
                  category,
                  status: "not_checked" as const,
                  reason: "current_claim_missing" as const,
                  currentClaimCount: 0,
                  comparableReferenceCount: 0,
                  applicableHardRuleCount: 0,
                },
          ),
        }
      : {}),
    capabilities: {
      deterministicValidation: "ready",
      naturalLanguageInference: "disabled",
      ambiguousModelReview: "separate_read_only_service",
      mutatesChapter: false,
    },
  };
}

function uuid(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function timestamp(value: string) {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
