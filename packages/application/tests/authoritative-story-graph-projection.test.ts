import {
  AppError,
  Chapter,
  ChapterVersion,
  err,
  ok,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7 as parseDomainUuidV7,
  type Clock,
  type ContentChecksum,
  type Result,
  type UuidV7 as DomainUuidV7,
} from "@inkshadow/domain";
import {
  ConsistencyIssue,
  ExtractionSuggestion,
  FormalStoryRecord,
  StructuredReviewItem,
  ok as storyOk,
  parseUuidV7 as parseStoryUuidV7,
  type FormalStoryRecordListReader,
  type Result as StoryResult,
  type ReviewItemListReader,
  type ReviewItemType,
  type StoryCoreError,
  type StructuredReviewItem as StoryReviewItem,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";
import type { GraphRagProjectSnapshot } from "@inkshadow/search-core";
import { describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS,
  AUTHORITATIVE_STORY_GRAPH_RELATION_KIND,
  BuildAuthoritativeStoryGraphProjection,
  QueryGraphRagContext,
  RebuildAuthoritativeStoryGraphProjection,
  type AuthoritativeStoryGraphReadSources,
  type ChapterRepository,
  type ChapterVersionRepository,
  type ContentHasher,
  type GraphRagMutationReceipt,
  type GraphRagProjectionRepository,
  type PersistedGraphRagProject,
  type ReplaceGraphRagProjectCommand,
} from "../src/index.js";

const PROJECT_ID = id("000000000001");
const FOREIGN_PROJECT_ID = id("000000000002");
const CHAPTER_ID = id("000000000010");
const VERSION_ID = id("000000000011");
const NEXT_VERSION_ID = id("000000000012");
const FOREIGN_CHAPTER_ID = id("000000000013");
const FOREIGN_VERSION_ID = id("000000000014");
const RECORD_ID = id("000000000020");
const SECOND_RECORD_ID = id("000000000021");
const REVIEW_ID = id("000000000030");
const SECOND_REVIEW_ID = id("000000000031");
const DECISION_ID = id("000000000040");
const SECOND_DECISION_ID = id("000000000041");
const ACTOR_ID = id("000000000050");
const SECOND_ACTOR_ID = id("000000000051");
const NOW = iso("2026-07-28T00:00:00.000Z");
const LATER = iso("2026-07-28T00:01:00.000Z");
const LATEST = iso("2026-07-28T00:02:00.000Z");
const CHAPTER_CONTENT = "序😀角色在雨中出现，并留下银色钥匙。";
const EVIDENCE_QUOTE = "😀角色";
const EVIDENCE_START = CHAPTER_CONTENT.indexOf(EVIDENCE_QUOTE);
const EVIDENCE_END = EVIDENCE_START + EVIDENCE_QUOTE.length;

describe("BuildAuthoritativeStoryGraphProjection", () => {
  it("deterministically derives only exact accepted/modified extraction support edges", async () => {
    const hasher = new WebCryptoHasher();
    const accepted = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const modified = governedRecord({
      recordId: SECOND_RECORD_ID,
      reviewId: SECOND_REVIEW_ID,
      decisionId: SECOND_DECISION_ID,
      recordKey: "borin",
      mode: "modified",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(hasher);
    const firstSources = sources({
      records: [accepted.record, modified.record],
      reviews: [accepted.review, modified.review],
      chapters: [chapterState.chapter],
      versions: [chapterState.version],
    });
    const secondSources = sources({
      records: [modified.record, accepted.record],
      reviews: [modified.review, accepted.review],
      chapters: [chapterState.chapter],
      versions: [chapterState.version],
    });

    const first = await new BuildAuthoritativeStoryGraphProjection(firstSources, hasher).execute(
      PROJECT_ID,
    );
    const second = await new BuildAuthoritativeStoryGraphProjection(secondSources, hasher).execute(
      PROJECT_ID,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.value.snapshot).toEqual(second.value.snapshot);
    expect(first.value.diagnostics).toEqual({
      formalRecordCount: 2,
      reviewItemCount: 2,
      chapterCount: 1,
      formalEntityCount: 2,
      chapterEntityCount: 1,
      relationCount: 2,
      sourceVersionCount: 3,
      skippedRelationCount: 0,
      invalidatedSupportCount: 0,
      projectionOmissionCount: 0,
      nonReviewDerivedFormalCount: 0,
      nonExtractionReviewFormalCount: 0,
      skipped: [],
      partial: false,
      stale: false,
    });
    expect(first.value.snapshot.entities.map(({ id: entityId }) => entityId)).toEqual([
      `chapter:${CHAPTER_ID}`,
      `formal:${RECORD_ID}`,
      `formal:${SECOND_RECORD_ID}`,
    ]);
    expect(first.value.snapshot.relations).toEqual([
      expect.objectContaining({
        id: `extraction-review:${REVIEW_ID}`,
        fromEntityId: `chapter:${CHAPTER_ID}`,
        toEntityId: `formal:${RECORD_ID}`,
        kind: AUTHORITATIVE_STORY_GRAPH_RELATION_KIND,
        confidence: 1,
        evidence: [
          expect.objectContaining({
            sourceVersionId: VERSION_ID,
            quote: EVIDENCE_QUOTE,
            span: {
              startOffset: EVIDENCE_START,
              endOffset: EVIDENCE_END,
              encoding: "utf16",
            },
            citation: {
              label: "第一章",
              locator: `utf16:${String(EVIDENCE_START)}-${String(EVIDENCE_END)}`,
            },
          }),
        ],
      }),
      expect.objectContaining({
        id: `extraction-review:${SECOND_REVIEW_ID}`,
        toEntityId: `formal:${SECOND_RECORD_ID}`,
      }),
    ]);
    expect(EVIDENCE_QUOTE.length).toBe(4);
    expect(EVIDENCE_END - EVIDENCE_START).toBe(4);

    const formalSource = first.value.snapshot.sourceVersions.find(
      ({ source }) => source.sourceId === `formal-source:${RECORD_ID}`,
    )?.source;
    expect(formalSource?.content).toBe(
      `{"currentValue":{"name":"aria-suggested"},"currentVersion":2,"kind":"character","projectId":"${PROJECT_ID}","recordId":"${RECORD_ID}","recordKey":"aria","schema":"inkshadow.authoritative-formal-graph-source/v1"}`,
    );
    expect(formalSource?.contentHash).toBe(await expectHash(hasher, formalSource?.content ?? ""));
  });

  it("removes derived support after manual edits, chapter changes, or chapter trash", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const manuallyEdited = requireStory(
      governed.record.editManually({
        value: { name: "Aria Prime" },
        actorId: SECOND_ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: governed.record.revision,
        now: LATEST,
      }),
    );
    const chapterState = await activeChapter(hasher);
    const changedChapterState = await changedChapter(hasher);
    const trashed = requireDomain(
      Chapter.rehydrate({
        ...chapterState.chapter.toSnapshot(),
        status: "trashed",
        trashedAt: LATEST,
        updatedAt: LATEST,
      }),
    );

    const cases = [
      {
        record: manuallyEdited,
        chapter: chapterState.chapter,
        versions: [chapterState.version],
        skipped: [],
        skippedRelationCount: 0,
        invalidatedSupportCount: 0,
        nonReviewDerivedFormalCount: 1,
        stale: false,
      },
      {
        record: governed.record,
        chapter: changedChapterState.chapter,
        versions: [chapterState.version, changedChapterState.version],
        skipped: [{ reason: "current_chapter_version_changed", count: 1 }],
        skippedRelationCount: 1,
        invalidatedSupportCount: 1,
        nonReviewDerivedFormalCount: 0,
        stale: true,
      },
      {
        record: governed.record,
        chapter: trashed,
        versions: [chapterState.version],
        skipped: [{ reason: "current_chapter_trashed", count: 1 }],
        skippedRelationCount: 1,
        invalidatedSupportCount: 1,
        nonReviewDerivedFormalCount: 0,
        stale: true,
      },
    ] as const;

    for (const testCase of cases) {
      const result = await new BuildAuthoritativeStoryGraphProjection(
        sources({
          records: [testCase.record],
          reviews: [governed.review],
          chapters: [testCase.chapter],
          versions: testCase.versions,
        }),
        hasher,
      ).execute(PROJECT_ID);

      expect(result).toMatchObject({
        ok: true,
        value: {
          diagnostics: {
            formalEntityCount: 1,
            chapterEntityCount: 0,
            relationCount: 0,
            skippedRelationCount: testCase.skippedRelationCount,
            invalidatedSupportCount: testCase.invalidatedSupportCount,
            projectionOmissionCount: 0,
            nonReviewDerivedFormalCount: testCase.nonReviewDerivedFormalCount,
            skipped: testCase.skipped,
            partial: false,
            stale: testCase.stale,
          },
          snapshot: {
            relations: [],
          },
        },
      });
    }
  });

  it("does not reinterpret consistency decisions or model confidence as graph authority", async () => {
    const hasher = new WebCryptoHasher();
    const consistency = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "consistency",
    });
    const zeroConfidence = governedRecord({
      recordId: SECOND_RECORD_ID,
      reviewId: SECOND_REVIEW_ID,
      decisionId: SECOND_DECISION_ID,
      recordKey: "borin",
      mode: "accepted",
      itemType: "extraction",
      confidence: 0,
    });
    const chapterState = await activeChapter(hasher);

    const result = await new BuildAuthoritativeStoryGraphProjection(
      sources({
        records: [consistency.record, zeroConfidence.record],
        reviews: [consistency.review, zeroConfidence.review],
        chapters: [chapterState.chapter],
        versions: [chapterState.version],
      }),
      hasher,
    ).execute(PROJECT_ID);

    expect(result).toMatchObject({
      ok: true,
      value: {
        diagnostics: {
          formalEntityCount: 2,
          chapterEntityCount: 1,
          relationCount: 1,
          skippedRelationCount: 0,
          invalidatedSupportCount: 0,
          projectionOmissionCount: 0,
          nonReviewDerivedFormalCount: 0,
          nonExtractionReviewFormalCount: 1,
          skipped: [],
          partial: false,
          stale: false,
        },
        snapshot: {
          relations: [expect.objectContaining({ confidence: 1 })],
        },
      },
    });
  });

  it("reports unsupported chapter source content as a partial omission, not stale authority", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(hasher);
    const unsupportedContent = `${CHAPTER_CONTENT}\u0001`;
    const unsupportedChapter = requireDomain(
      Chapter.rehydrate({
        ...chapterState.chapter.toSnapshot(),
        content: unsupportedContent,
      }),
    );
    const unsupportedVersion = requireDomain(
      ChapterVersion.create({
        ...chapterState.version.toSnapshot(),
        content: unsupportedContent,
        contentChecksum: await expectHashValue(hasher, unsupportedContent),
      }),
    );

    const result = await new BuildAuthoritativeStoryGraphProjection(
      sources({
        records: [governed.record],
        reviews: [governed.review],
        chapters: [unsupportedChapter],
        versions: [unsupportedVersion],
      }),
      hasher,
    ).execute(PROJECT_ID);

    expect(result).toMatchObject({
      ok: true,
      value: {
        diagnostics: {
          relationCount: 0,
          invalidatedSupportCount: 0,
          projectionOmissionCount: 1,
          skipped: [{ reason: "chapter_source_unsafe_control", count: 1 }],
          partial: true,
          stale: false,
        },
      },
    });
  });

  it("validates chapter-version authority before classifying unsupported graph content", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(hasher);
    const mismatchedChapter = requireDomain(
      Chapter.rehydrate({
        ...chapterState.chapter.toSnapshot(),
        content: `${CHAPTER_CONTENT}\u0001`,
      }),
    );

    const result = await new BuildAuthoritativeStoryGraphProjection(
      sources({
        records: [governed.record],
        reviews: [governed.review],
        chapters: [mismatchedChapter],
        versions: [chapterState.version],
      }),
      hasher,
    ).execute(PROJECT_ID);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "CURRENT_CHAPTER_PROJECTION_MISMATCH" },
      },
    });
  });

  it("hashes each formal source and shared chapter source exactly once", async () => {
    const baseHasher = new WebCryptoHasher();
    const hasher = new CountingHasher(baseHasher);
    const first = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const second = governedRecord({
      recordId: SECOND_RECORD_ID,
      reviewId: SECOND_REVIEW_ID,
      decisionId: SECOND_DECISION_ID,
      recordKey: "borin",
      mode: "modified",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(baseHasher);

    const result = await new BuildAuthoritativeStoryGraphProjection(
      sources({
        records: [first.record, second.record],
        reviews: [first.review, second.review],
        chapters: [chapterState.chapter],
        versions: [chapterState.version],
      }),
      hasher,
    ).execute(PROJECT_ID);

    expect(result.ok).toBe(true);
    expect(hasher.calls).toBe(3);
  });

  it("canonicalizes nested Story values independently of object insertion order", async () => {
    const hasher = new WebCryptoHasher();
    const left = requireStory(
      FormalStoryRecord.create({
        id: RECORD_ID,
        projectId: PROJECT_ID,
        kind: "character",
        recordKey: "aria",
        value: {
          profile: { name: "Aria", role: "keeper" },
          active: true,
        },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        now: NOW,
      }),
    );
    const right = requireStory(
      FormalStoryRecord.create({
        id: RECORD_ID,
        projectId: PROJECT_ID,
        kind: "character",
        recordKey: "aria",
        value: {
          active: true,
          profile: { role: "keeper", name: "Aria" },
        },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        now: NOW,
      }),
    );

    const leftBuild = await new BuildAuthoritativeStoryGraphProjection(
      sources({ records: [left], reviews: [], chapters: [], versions: [] }),
      hasher,
    ).execute(PROJECT_ID);
    const rightBuild = await new BuildAuthoritativeStoryGraphProjection(
      sources({ records: [right], reviews: [], chapters: [], versions: [] }),
      hasher,
    ).execute(PROJECT_ID);

    expect(leftBuild.ok).toBe(true);
    expect(rightBuild.ok).toBe(true);
    if (leftBuild.ok && rightBuild.ok) {
      expect(leftBuild.value.snapshot.sourceVersions).toEqual(
        rightBuild.value.snapshot.sourceVersions,
      );
    }
  });

  it("fails closed for cross-project rows, duplicate identities, and forged UTF-16 evidence", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const foreignRecord = requireStory(
      FormalStoryRecord.create({
        id: SECOND_RECORD_ID,
        projectId: FOREIGN_PROJECT_ID,
        kind: "character",
        recordKey: "foreign",
        value: { name: "Foreign" },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        now: NOW,
      }),
    );
    const chapterState = await activeChapter(hasher);
    const validSources = {
      records: [governed.record],
      reviews: [governed.review],
      chapters: [chapterState.chapter],
      versions: [chapterState.version],
    };
    const forgedSnapshot = governed.review.toSnapshot();
    const forgedReview = requireStory(
      StructuredReviewItem.rehydrate({
        ...forgedSnapshot,
        evidence: {
          excerpt: "角色在雨",
          range: { ...forgedSnapshot.evidence.range },
        },
      }),
    );
    const foreignChapter = requireDomain(
      Chapter.rehydrate({
        ...chapterState.chapter.toSnapshot(),
        id: domainId(FOREIGN_CHAPTER_ID),
        projectId: domainId(FOREIGN_PROJECT_ID),
        currentVersionId: domainId(FOREIGN_VERSION_ID),
      }),
    );
    const foreignReview = requireStory(
      StructuredReviewItem.rehydrate({
        ...forgedSnapshot,
        sourceChapterId: storyUuid(FOREIGN_CHAPTER_ID),
        sourceVersionId: storyUuid(FOREIGN_VERSION_ID),
      }),
    );

    const crossProject = await new BuildAuthoritativeStoryGraphProjection(
      sources({ ...validSources, records: [foreignRecord] }),
      hasher,
    ).execute(PROJECT_ID);
    const duplicate = await new BuildAuthoritativeStoryGraphProjection(
      sources({ ...validSources, records: [governed.record, governed.record] }),
      hasher,
    ).execute(PROJECT_ID);
    const forged = await new BuildAuthoritativeStoryGraphProjection(
      sources({ ...validSources, reviews: [forgedReview] }),
      hasher,
    ).execute(PROJECT_ID);
    const foreignChapterReference = await new BuildAuthoritativeStoryGraphProjection(
      sources({
        ...validSources,
        reviews: [foreignReview],
        lookupChapters: [chapterState.chapter, foreignChapter],
      }),
      hasher,
    ).execute(PROJECT_ID);

    expect(crossProject).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: {
          operation: "AUTHORITATIVE_STORY_GRAPH_SOURCE_CORRUPT",
          reason: "FORMAL_RECORD_PROJECT_SCOPE_MISMATCH",
        },
      },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "FORMAL_RECORD_ID_DUPLICATED" },
      },
    });
    expect(forged).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "REVIEW_EVIDENCE_FORGED_OR_CORRUPT" },
      },
    });
    expect(foreignChapterReference).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "REVIEW_CHAPTER_PROJECT_SCOPE_MISMATCH" },
      },
    });
  });

  it("fails closed when review baseline, actor, or decision time does not bind the formal version", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(hasher);
    const reviewSnapshot = governed.review.toSnapshot();
    const recordSnapshot = governed.record.toSnapshot();
    const baselineForged = requireStory(
      StructuredReviewItem.rehydrate({
        ...reviewSnapshot,
        originalValue: { name: "forged-baseline" },
      }),
    );
    const actorForged = requireStory(
      StructuredReviewItem.rehydrate({
        ...reviewSnapshot,
        decisions: reviewSnapshot.decisions.map((decision, index) =>
          index === reviewSnapshot.decisions.length - 1
            ? { ...decision, actorId: storyUuid(ACTOR_ID) }
            : decision,
        ),
      }),
    );
    const timeForgedRecord = requireStory(
      FormalStoryRecord.rehydrate({
        ...recordSnapshot,
        updatedAt: NOW,
        versions: recordSnapshot.versions.map((version) =>
          version.version === recordSnapshot.currentVersion
            ? { ...version, createdAt: NOW }
            : version,
        ),
      }),
    );

    for (const testCase of [
      { record: governed.record, review: baselineForged },
      { record: governed.record, review: actorForged },
      { record: timeForgedRecord, review: governed.review },
    ]) {
      const result = await new BuildAuthoritativeStoryGraphProjection(
        sources({
          records: [testCase.record],
          reviews: [testCase.review],
          chapters: [chapterState.chapter],
          versions: [chapterState.version],
        }),
        hasher,
      ).execute(PROJECT_ID);

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "REPOSITORY_ERROR",
          details: { reason: "FORMAL_REVIEW_BINDING_MISMATCH" },
        },
      });
    }
  });

  it("keeps GraphRAG query output at the auditable candidate-only boundary", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(hasher);
    const built = await new BuildAuthoritativeStoryGraphProjection(
      sources({
        records: [governed.record],
        reviews: [governed.review],
        chapters: [chapterState.chapter],
        versions: [chapterState.version],
      }),
      hasher,
    ).execute(PROJECT_ID);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const repository = new CasProjectionRepository(built.value.snapshot, 0);
    const rebuilt = await repository.replaceProject({
      snapshot: built.value.snapshot,
      expectedRevision: 0,
      mutatedAt: NOW,
    });
    expect(rebuilt.ok).toBe(true);

    const query = await new QueryGraphRagContext(repository).execute({
      projectId: PROJECT_ID,
      seedEntityIds: [`chapter:${CHAPTER_ID}`],
      direction: "outgoing",
    });

    expect(query).toMatchObject({
      ok: true,
      value: {
        publicationBoundary: "candidate_only",
        formalContentWriteAllowed: false,
        requiresExplicitAcceptance: true,
        result: {
          relationCandidates: [
            {
              kind: AUTHORITATIVE_STORY_GRAPH_RELATION_KIND,
            },
          ],
        },
      },
    });
    if (query.ok) {
      expect(query.value.result.relationCandidates[0]?.explanation.reachedEntityId).toBe(
        `formal:${RECORD_ID}`,
      );
    }
  });
});

describe("RebuildAuthoritativeStoryGraphProjection", () => {
  it("rereads authority and succeeds after a bounded CAS retry", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(hasher);
    const events: string[] = [];
    const readSources = sources({
      records: [governed.record],
      reviews: [governed.review],
      chapters: [chapterState.chapter],
      versions: [chapterState.version],
      events,
    });
    const repository = new CasProjectionRepository(null, 1, { events });
    const service = new RebuildAuthoritativeStoryGraphProjection(
      new BuildAuthoritativeStoryGraphProjection(readSources, hasher),
      repository,
      new FixedClock(),
    );

    const result = await service.execute(PROJECT_ID);

    expect(result).toMatchObject({
      ok: true,
      value: {
        previousRevision: 1,
        revision: 2,
        casAttempts: 2,
        relationCount: 1,
        rebuiltAt: LATER,
      },
    });
    expect(readSources.formalListCalls()).toBe(2);
    expect(repository.replaceCalls).toBe(2);
    expect(events).toEqual(["load", "build", "replace", "load", "build", "replace"]);
  });

  it("stops after the fixed CAS bound without force-writing", async () => {
    const hasher = new WebCryptoHasher();
    const governed = governedRecord({
      recordId: RECORD_ID,
      reviewId: REVIEW_ID,
      decisionId: DECISION_ID,
      recordKey: "aria",
      mode: "accepted",
      itemType: "extraction",
    });
    const chapterState = await activeChapter(hasher);
    const readSources = sources({
      records: [governed.record],
      reviews: [governed.review],
      chapters: [chapterState.chapter],
      versions: [chapterState.version],
    });
    const repository = new CasProjectionRepository(
      null,
      AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS,
    );
    const service = new RebuildAuthoritativeStoryGraphProjection(
      new BuildAuthoritativeStoryGraphProjection(readSources, hasher),
      repository,
      new FixedClock(),
    );

    const result = await service.execute(PROJECT_ID);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        retryable: true,
        details: { attempts: AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS },
      },
    });
    expect(repository.replaceCalls).toBe(AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS);
    expect(readSources.formalListCalls()).toBe(AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS);
  });

  it("refuses to replace a project that contains graph data owned by another producer", async () => {
    const repository = new CasProjectionRepository(
      {
        ...persisted(
          {
            projectId: PROJECT_ID,
            sourceVersions: [],
            entities: [],
            relations: [],
          },
          1,
          NOW,
        ),
        sourceVersions: [
          {
            source: {
              projectId: PROJECT_ID,
              sourceId: "external-source:1",
              sourceVersionId: "external-source:1:v1",
              contentHash: "a".repeat(64),
              content: "External producer content",
              createdAt: NOW,
            },
            state: "current",
          },
        ],
      },
      0,
    );
    const service = new RebuildAuthoritativeStoryGraphProjection(
      new BuildAuthoritativeStoryGraphProjection(
        sources({ records: [], reviews: [], chapters: [], versions: [] }),
        new WebCryptoHasher(),
      ),
      repository,
      new FixedClock(),
    );

    const result = await service.execute(PROJECT_ID);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "NON_STORY_GRAPH_OWNERSHIP_DETECTED" },
      },
    });
    expect(repository.replaceCalls).toBe(0);
  });

  it("does not retry unrelated VERSION_CONFLICT errors", async () => {
    const conflict = new AppError({
      code: "VERSION_CONFLICT",
      message: "Relation identity was rebound.",
      details: {
        projectId: PROJECT_ID,
        expectedRevision: 999,
        actualRevision: 1,
      },
    });
    const repository = new CasProjectionRepository(null, 1, {
      conflictError: () => conflict,
    });
    const service = new RebuildAuthoritativeStoryGraphProjection(
      new BuildAuthoritativeStoryGraphProjection(
        sources({ records: [], reviews: [], chapters: [], versions: [] }),
        new WebCryptoHasher(),
      ),
      repository,
      new FixedClock(),
    );

    const result = await service.execute(PROJECT_ID);

    expect(result).toEqual(err(conflict));
    expect(repository.replaceCalls).toBe(1);
  });

  it("fails closed when the repository forges a successful mutation receipt", async () => {
    const repository = new CasProjectionRepository(null, 0, {
      mutateReceipt: (receipt) => ({ ...receipt, updatedAt: LATEST }),
    });
    const service = new RebuildAuthoritativeStoryGraphProjection(
      new BuildAuthoritativeStoryGraphProjection(
        sources({ records: [], reviews: [], chapters: [], versions: [] }),
        new WebCryptoHasher(),
      ),
      repository,
      new FixedClock(),
    );

    const result = await service.execute(PROJECT_ID);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "MUTATION_RECEIPT_MISMATCH" },
      },
    });
    expect(repository.replaceCalls).toBe(1);
  });
});

interface GovernedRecord {
  readonly record: FormalStoryRecord;
  readonly review: StoryReviewItem<ReviewItemType>;
}

function governedRecord(input: {
  readonly recordId: string;
  readonly reviewId: string;
  readonly decisionId: string;
  readonly recordKey: string;
  readonly mode: "accepted" | "modified";
  readonly itemType: ReviewItemType;
  readonly confidence?: number;
}): GovernedRecord {
  const originalValue = { name: `${input.recordKey}-old` };
  const suggestedValue = { name: `${input.recordKey}-suggested` };
  const finalValue = input.mode === "accepted" ? suggestedValue : { name: input.recordKey };
  const original = requireStory(
    FormalStoryRecord.create({
      id: input.recordId,
      projectId: PROJECT_ID,
      kind: "character",
      recordKey: input.recordKey,
      value: originalValue,
      actorId: ACTOR_ID,
      humanConfirmed: true,
      now: NOW,
    }),
  );
  const factory = input.itemType === "extraction" ? ExtractionSuggestion : ConsistencyIssue;
  const pending = requireStory(
    factory.create({
      id: input.reviewId,
      projectId: PROJECT_ID,
      category: "character_update",
      targetRecordId: input.recordId,
      targetRecordKind: "character",
      sourceChapterId: CHAPTER_ID,
      sourceVersionId: VERSION_ID,
      evidence: {
        excerpt: EVIDENCE_QUOTE,
        start: EVIDENCE_START,
        end: EVIDENCE_END,
        sourceLength: CHAPTER_CONTENT.length,
      },
      confidence: input.confidence ?? 0.9,
      originalValue,
      suggestedValue,
      now: NOW,
    }),
  );
  const outcome = requireStory(
    pending.decide({
      kind: input.mode === "accepted" ? "accept" : "modify",
      decisionId: input.decisionId,
      actorId: SECOND_ACTOR_ID,
      humanConfirmed: true,
      expectedRevision: pending.revision,
      expectedRecordRevision: original.revision,
      ...(input.mode === "modified" ? { modifiedValue: finalValue } : {}),
      now: LATER,
    }),
  );
  if (outcome.plan === null) {
    throw new Error("Governed fixture did not produce a formal change plan.");
  }
  const record = requireStory(original.applyChangePlan(outcome.plan, original.revision, LATER));
  return { record, review: outcome.item };
}

async function activeChapter(hasher: ContentHasher): Promise<{
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
}> {
  const checksum = await expectHashValue(hasher, CHAPTER_CONTENT);
  const chapter = requireDomain(
    Chapter.rehydrate({
      id: domainId(CHAPTER_ID),
      projectId: domainId(PROJECT_ID),
      title: "第一章",
      content: CHAPTER_CONTENT,
      status: "active",
      revision: 1,
      currentVersionId: domainId(VERSION_ID),
      createdAt: NOW,
      updatedAt: NOW,
      trashedAt: null,
    }),
  );
  const version = requireDomain(
    ChapterVersion.create({
      id: domainId(VERSION_ID),
      projectId: domainId(PROJECT_ID),
      chapterId: domainId(CHAPTER_ID),
      parentVersionId: null,
      sequence: 1,
      content: CHAPTER_CONTENT,
      contentChecksum: checksum,
      reason: "created",
      sourceCandidateId: null,
      createdAt: NOW,
    }),
  );
  return { chapter, version };
}

async function changedChapter(hasher: ContentHasher): Promise<{
  readonly chapter: Chapter;
  readonly version: ChapterVersion;
}> {
  const content = `${CHAPTER_CONTENT}\n章节已更新。`;
  const checksum = await expectHashValue(hasher, content);
  const chapter = requireDomain(
    Chapter.rehydrate({
      id: domainId(CHAPTER_ID),
      projectId: domainId(PROJECT_ID),
      title: "第一章",
      content,
      status: "active",
      revision: 2,
      currentVersionId: domainId(NEXT_VERSION_ID),
      createdAt: NOW,
      updatedAt: LATEST,
      trashedAt: null,
    }),
  );
  const version = requireDomain(
    ChapterVersion.create({
      id: domainId(NEXT_VERSION_ID),
      projectId: domainId(PROJECT_ID),
      chapterId: domainId(CHAPTER_ID),
      parentVersionId: domainId(VERSION_ID),
      sequence: 2,
      content,
      contentChecksum: checksum,
      reason: "manual",
      sourceCandidateId: null,
      createdAt: LATEST,
    }),
  );
  return { chapter, version };
}

interface TestReadSources extends AuthoritativeStoryGraphReadSources {
  formalListCalls(): number;
}

function sources(input: {
  readonly records: readonly FormalStoryRecord[];
  readonly reviews: readonly StoryReviewItem<ReviewItemType>[];
  readonly chapters: readonly Chapter[];
  readonly lookupChapters?: readonly Chapter[];
  readonly versions: readonly ChapterVersion[];
  readonly events?: string[];
}): TestReadSources {
  let formalCalls = 0;
  const formalRecords: FormalStoryRecordListReader = {
    listByProjectId: () => {
      formalCalls += 1;
      input.events?.push("build");
      return Promise.resolve(storyOk(input.records));
    },
  };
  const extractionReviews: ReviewItemListReader<"extraction"> = {
    listByProjectId: () =>
      Promise.resolve(
        storyOk(
          input.reviews.filter(
            (review): review is StoryReviewItem<"extraction"> => review.itemType === "extraction",
          ),
        ),
      ),
  };
  const consistencyReviews: ReviewItemListReader<"consistency"> = {
    listByProjectId: () =>
      Promise.resolve(
        storyOk(
          input.reviews.filter(
            (review): review is StoryReviewItem<"consistency"> => review.itemType === "consistency",
          ),
        ),
      ),
  };
  const chapters: ChapterRepository = {
    findById: (chapterId) =>
      Promise.resolve(
        ok(
          (input.lookupChapters ?? input.chapters).find((chapter) => chapter.id === chapterId) ??
            null,
        ),
      ),
    listByProjectId: () => Promise.resolve(ok(input.chapters)),
  };
  const chapterVersions: ChapterVersionRepository = {
    findVersionById: (versionId) =>
      Promise.resolve(
        ok(input.versions.find((version) => version.toSnapshot().id === versionId) ?? null),
      ),
    listByChapterId: (chapterId) =>
      Promise.resolve(
        ok(input.versions.filter((version) => version.toSnapshot().chapterId === chapterId)),
      ),
  };
  return {
    formalRecords,
    extractionReviews,
    consistencyReviews,
    chapters,
    chapterVersions,
    formalListCalls: () => formalCalls,
  };
}

class WebCryptoHasher implements ContentHasher {
  public async sha256(content: string): Promise<Result<ContentChecksum, AppError>> {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(content),
    );
    const hexadecimal = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return parseContentChecksum(hexadecimal);
  }
}

class CountingHasher implements ContentHasher {
  public calls = 0;

  public constructor(private readonly delegate: ContentHasher) {}

  public sha256(content: string): Promise<Result<ContentChecksum, AppError>> {
    this.calls += 1;
    return this.delegate.sha256(content);
  }
}

class FixedClock implements Clock {
  private calls = 0;

  public now(): ReturnType<typeof iso> {
    this.calls += 1;
    return this.calls === 1 ? NOW : LATER;
  }
}

class CasProjectionRepository implements GraphRagProjectionRepository {
  public replaceCalls = 0;
  private project: PersistedGraphRagProject | null;
  private revision = 0;

  public constructor(
    initial: PersistedGraphRagProject | GraphRagProjectSnapshot | null,
    private readonly conflictsBeforeSuccess: number,
    private readonly options: Readonly<{
      events?: string[];
      conflictError?: (command: ReplaceGraphRagProjectCommand, actualRevision: number) => AppError;
      mutateReceipt?: (receipt: GraphRagMutationReceipt) => GraphRagMutationReceipt;
    }> = {},
  ) {
    this.project =
      initial === null || "revision" in initial ? initial : persisted(initial, this.revision, NOW);
    this.revision = this.project?.revision ?? 0;
  }

  public loadProject(): Promise<Result<PersistedGraphRagProject | null, AppError>> {
    this.options.events?.push("load");
    return Promise.resolve(ok(this.project));
  }

  public replaceProject(
    command: ReplaceGraphRagProjectCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>> {
    this.replaceCalls += 1;
    this.options.events?.push("replace");
    if (this.replaceCalls <= this.conflictsBeforeSuccess) {
      this.revision += 1;
      this.project = persisted(command.snapshot, this.revision, command.mutatedAt);
      return Promise.resolve(
        err(
          this.options.conflictError?.(command, this.revision) ??
            new AppError({
              code: "VERSION_CONFLICT",
              message: "Concurrent graph rebuild.",
              retryable: true,
              details: {
                projectId: command.snapshot.projectId,
                expectedRevision: command.expectedRevision,
                actualRevision: this.revision,
              },
            }),
        ),
      );
    }
    if (command.expectedRevision !== this.revision) {
      return Promise.resolve(
        err(
          new AppError({
            code: "VERSION_CONFLICT",
            message: "Stale graph revision.",
            details: {
              projectId: command.snapshot.projectId,
              expectedRevision: command.expectedRevision,
              actualRevision: this.revision,
            },
          }),
        ),
      );
    }
    const previousRevision = this.revision;
    this.revision += 1;
    this.project = persisted(command.snapshot, this.revision, command.mutatedAt);
    const receipt: GraphRagMutationReceipt = {
      projectId: command.snapshot.projectId,
      previousRevision,
      revision: this.revision,
      updatedAt: command.mutatedAt,
    };
    return Promise.resolve(ok(this.options.mutateReceipt?.(receipt) ?? receipt));
  }

  public upsertSourceVersion(): Promise<never> {
    return Promise.reject(new Error("Not used."));
  }

  public invalidateSourceVersion(): Promise<never> {
    return Promise.reject(new Error("Not used."));
  }

  public upsertEntity(): Promise<never> {
    return Promise.reject(new Error("Not used."));
  }

  public softDeleteEntity(): Promise<never> {
    return Promise.reject(new Error("Not used."));
  }

  public upsertRelation(): Promise<never> {
    return Promise.reject(new Error("Not used."));
  }

  public softDeleteRelation(): Promise<never> {
    return Promise.reject(new Error("Not used."));
  }
}

function persisted(
  snapshot: GraphRagProjectSnapshot,
  revision: number,
  updatedAt: string,
): PersistedGraphRagProject {
  return {
    ...snapshot,
    revision,
    status: "ready",
    updatedAt,
    lastRebuiltAt: updatedAt,
  };
}

async function expectHash(hasher: ContentHasher, content: string): Promise<string> {
  return String(await expectHashValue(hasher, content));
}

async function expectHashValue(hasher: ContentHasher, content: string): Promise<ContentChecksum> {
  const result = await hasher.sha256(content);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function requireDomain<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function requireStory<Value>(result: StoryResult<Value, StoryCoreError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function id(suffix: string): string {
  return `018f0d7a-3b2c-7abc-8def-${suffix}`;
}

function domainId(value: string): DomainUuidV7 {
  return requireDomain(parseDomainUuidV7(value));
}

function storyUuid(value: string): StoryUuidV7 {
  return requireStory(parseStoryUuidV7(value));
}

function iso(
  value: string,
): ReturnType<typeof parseIsoUtcTimestamp> extends Result<infer Timestamp, AppError>
  ? Timestamp
  : never {
  return requireDomain(parseIsoUtcTimestamp(value));
}
