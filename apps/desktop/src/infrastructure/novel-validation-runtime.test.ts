import { createHash } from "node:crypto";

import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import {
  Chapter,
  ChapterVersion,
  ok as domainOk,
  parseContentChecksum,
  parseIsoUtcTimestamp as parseDomainTimestamp,
  parseUuidV7 as parseDomainUuid,
  type AppError,
  type Result as DomainResult,
  type UuidV7 as DomainUuidV7,
} from "@inkshadow/domain";
import {
  StoryFact,
  StoryFactApplicationService,
  ok as storyOk,
  type CreateStoryFactInput,
  type Result as StoryResult,
  type StoryCoreError,
  type StoryFactStore,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";
import { beforeEach, describe, expect, it } from "vitest";

import { BrowserDevelopmentStoryFactStore } from "./story-fact-store";
import { DEVELOPMENT_DATABASE_KEY } from "./development-storage";
import {
  CHAPTER_VALIDATION_UI_ACTIONS,
  ChapterNovelValidationRuntime,
  type ChapterSupplementalFindingCategory,
  type ChapterSupplementalFindingVerificationPort,
  type ChapterSupplementalFindingVerificationRequest,
} from "./novel-validation-runtime";

const PROJECT_ID = uuid(1);
const OTHER_PROJECT_ID = uuid(2);
const CHAPTER_ID = uuid(3);
const OTHER_CHAPTER_ID = uuid(4);
const PREVIOUS_VERSION_ID = uuid(5);
const CURRENT_VERSION_ID = uuid(6);
const ACTOR_ID = uuid(7);
const OTHER_BRANCH_ID = uuid(8);
const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:01:00.000Z";
const PREVIOUS_CONTENT = "林遥仍然活着。";
const CURRENT_CONTENT = "林遥已经死去。";
const PREVIOUS_EXCERPT = "林遥仍然活着";
const CURRENT_EXCERPT = "林遥已经死去";
const SUPPLEMENTAL_EVIDENCE_SIGNATURE = `v2:${CURRENT_VERSION_ID}:${sha256(CURRENT_CONTENT)}:0-${String(CURRENT_EXCERPT.length)}`;

describe("ChapterNovelValidationRuntime", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns an evidence-backed UI issue without mutating the chapter or facts", async () => {
    const fixture = chapterFixture();
    const currentClaim = storyFact(20, {
      factType: "character_life_status",
      structuredValue: currentClaimValue("dead"),
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, CURRENT_EXCERPT),
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    });
    const reference = storyFact(21, {
      factType: "character_life_status",
      contentText: "林遥在这一时间段仍然存活。",
      structuredValue: referenceFactValue("alive"),
      source: chapterSource(PREVIOUS_VERSION_ID, PREVIOUS_CONTENT, PREVIOUS_EXCERPT),
    });
    const facts = new ReadOnlyFactStore([currentClaim, reference]);
    const runtime = runtimeFor(fixture, facts);
    const before = fixture.chapter.toSnapshot();

    const result = await runtime.checkChapter(request());

    expect(result).toMatchObject({
      status: "checked",
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      chapterVersionId: CURRENT_VERSION_ID,
      chapterRevision: 2,
      checked: { currentClaims: 1, referenceFacts: 1, hardRules: 0 },
      missingRequirements: [],
      capabilities: {
        deterministicValidation: "ready",
        naturalLanguageInference: "disabled",
        ambiguousModelReview: "separate_read_only_service",
        mutatesChapter: false,
      },
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      type: "character_life_status_conflict",
      currentTextExcerpt: CURRENT_EXCERPT,
      conflictingFact: {
        source: "confirmed_fact",
        statement: "林遥在这一时间段仍然存活。",
        value: "alive",
        operator: "equals",
      },
      currentEvidence: [
        {
          sourceId: CHAPTER_ID,
          sourceVersionId: CURRENT_VERSION_ID,
          contentHash: sha256(CURRENT_CONTENT),
          excerpt: CURRENT_EXCERPT,
          startOffset: 0,
          endOffset: CURRENT_EXCERPT.length,
          sourceLength: CURRENT_CONTENT.length,
        },
      ],
      conflictingEvidence: [
        {
          sourceId: CHAPTER_ID,
          sourceVersionId: PREVIOUS_VERSION_ID,
          contentHash: sha256(PREVIOUS_CONTENT),
          excerpt: PREVIOUS_EXCERPT,
        },
      ],
      severity: "error",
      availableActions: CHAPTER_VALIDATION_UI_ACTIONS,
    });
    expect(result.issues[0]?.modificationSuggestion.length).toBeGreaterThan(0);
    expect(result.coverage?.filter(({ status }) => status === "checked")).toEqual([
      expect.objectContaining({
        category: "character_life_status",
        reason: "explicit_claim_compared",
        currentClaimCount: 1,
        comparableReferenceCount: 1,
      }),
    ]);
    expect(result.coverage).toHaveLength(10);
    expect(fixture.chapter.toSnapshot()).toEqual(before);
    expect(facts.listCalls).toEqual([PROJECT_ID]);
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(Object.isFrozen(result.issues[0]?.availableActions)).toBe(true);
  });

  it("maps a locked formal rule to a hard-rule conflict with both evidence sources", async () => {
    const fixture = chapterFixture();
    const currentClaim = storyFact(30, {
      factType: "world_property",
      structuredValue: currentClaimValue(false, "world.magic", "allows_resurrection"),
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, CURRENT_EXCERPT),
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    });
    const hardRule = storyFact(31, {
      factType: "world_property",
      contentText: "这个世界允许复活。",
      structuredValue: hardRuleValue(true, "world.magic", "allows_resurrection"),
      source: chapterSource(PREVIOUS_VERSION_ID, PREVIOUS_CONTENT, PREVIOUS_EXCERPT),
      locked: true,
    });
    const result = await runtimeFor(
      fixture,
      new ReadOnlyFactStore([currentClaim, hardRule]),
    ).checkChapter(request());

    expect(result.status).toBe("checked");
    expect(result.checked).toEqual({ currentClaims: 1, referenceFacts: 0, hardRules: 1 });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      type: "world_hard_rule_conflict",
      conflictingFact: {
        source: "locked_hard_rule",
        statement: "这个世界允许复活。",
        value: true,
        operator: "equals",
      },
      currentEvidence: [{ sourceVersionId: CURRENT_VERSION_ID }],
      conflictingEvidence: [{ sourceVersionId: PREVIOUS_VERSION_ID }],
      availableActions: ["ignore", "allow", "update_setting"],
    });
  });

  it("does not infer claims from prose and explains every excluded input", async () => {
    const fixture = chapterFixture();
    const proseOnly = storyFact(40, {
      factType: "character_life_status",
      contentText: "林遥已经死去。",
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, CURRENT_EXCERPT),
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    });
    const inferred = storyFact(41, {
      factType: "character_life_status",
      structuredValue: { ...currentClaimValue("dead"), basis: "inferred" },
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, CURRENT_EXCERPT),
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    });
    const otherBranch = storyFact(42, {
      factType: "character_life_status",
      structuredValue: currentClaimValue("dead"),
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, CURRENT_EXCERPT),
      status: "branch",
      branchId: OTHER_BRANCH_ID,
    });
    const reference = storyFact(43, {
      factType: "character_life_status",
      structuredValue: referenceFactValue("alive"),
      source: chapterSource(PREVIOUS_VERSION_ID, PREVIOUS_CONTENT, PREVIOUS_EXCERPT),
    });

    const result = await runtimeFor(
      fixture,
      new ReadOnlyFactStore([proseOnly, inferred, otherBranch, reference]),
    ).checkChapter(request());

    expect(result).toMatchObject({
      status: "skipped",
      issues: [],
      missingRequirements: [
        "current_claim_with_explicit_structured_fields_and_current_version_evidence",
        "comparable_current_claim_and_confirmed_source",
      ],
      checked: { currentClaims: 0, referenceFacts: 1, hardRules: 0 },
    });
    expect(result.skippedFacts.map(({ reason }) => reason)).toEqual([
      "structured_fields_missing",
      "current_claim_not_explicit",
      "other_branch",
    ]);
    expect(result.explanation).toContain("current_claim_with_explicit_structured_fields");
  });

  it("does not claim a category ran when current and confirmed facts belong to different types", async () => {
    const fixture = chapterFixture();
    const currentClaim = storyFact(44, {
      factType: "character_life_status",
      structuredValue: currentClaimValue("dead"),
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, CURRENT_EXCERPT),
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    });
    const unrelatedAgeReference = storyFact(45, {
      factType: "character_age",
      structuredValue: referenceFactValue(18, "character.lin-yao", "age"),
      source: chapterSource(PREVIOUS_VERSION_ID, PREVIOUS_CONTENT, PREVIOUS_EXCERPT),
    });

    const result = await runtimeFor(
      fixture,
      new ReadOnlyFactStore([currentClaim, unrelatedAgeReference]),
    ).checkChapter(request());

    expect(result).toMatchObject({
      status: "skipped",
      issues: [],
      missingRequirements: ["comparable_current_claim_and_confirmed_source"],
    });
    expect(result.coverage?.some(({ status }) => status === "checked")).toBe(false);
    expect(
      result.coverage?.find(({ category }) => category === "character_life_status"),
    ).toMatchObject({
      status: "not_checked",
      reason: "confirmed_reference_or_rule_missing",
      currentClaimCount: 1,
    });
    expect(result.coverage?.find(({ category }) => category === "character_age")).toMatchObject({
      status: "not_checked",
      reason: "current_claim_missing",
      currentClaimCount: 0,
    });
  });

  it("rejects a structured claim when its exact versioned excerpt does not match", async () => {
    const fixture = chapterFixture();
    const mismatchedClaim = storyFact(50, {
      factType: "character_life_status",
      structuredValue: currentClaimValue("dead"),
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, "林遥并未死去"),
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    });
    const reference = storyFact(51, {
      factType: "character_life_status",
      structuredValue: referenceFactValue("alive"),
      source: chapterSource(PREVIOUS_VERSION_ID, PREVIOUS_CONTENT, PREVIOUS_EXCERPT),
    });

    const result = await runtimeFor(
      fixture,
      new ReadOnlyFactStore([mismatchedClaim, reference]),
    ).checkChapter(request());

    expect(result.status).toBe("skipped");
    expect(result.issues).toEqual([]);
    expect(result.skippedFacts).toEqual([
      expect.objectContaining({
        factId: uuid(50),
        role: "current_claim",
        reason: "evidence_span_mismatch",
        missingRequirements: ["exact_excerpt_offsets_in_immutable_source_version"],
      }),
    ]);
  });

  it("stops at the chapter boundary when project ownership does not match", async () => {
    const fixture = chapterFixture();
    const chapters = new ChapterReader(fixture.chapter);
    const versions = new VersionReader([fixture.previousVersion, fixture.currentVersion]);
    const facts = new ReadOnlyFactStore([]);
    const runtime = new ChapterNovelValidationRuntime({
      chapters,
      chapterVersions: versions,
      storyFacts: facts,
      hasher: new CryptoHasher(),
    });

    const result = await runtime.checkChapter({
      projectId: asDomainUuid(OTHER_PROJECT_ID),
      chapterId: asDomainUuid(CHAPTER_ID),
    });

    expect(result).toMatchObject({
      status: "skipped",
      chapterVersionId: null,
      skippedFacts: [{ factId: null, reason: "chapter_project_mismatch" }],
    });
    expect(versions.findCalls).toEqual([]);
    expect(facts.listCalls).toEqual([]);
  });

  it("never validates facts through a mismatched or unverified current version", async () => {
    const fixture = chapterFixture();
    const foreignVersion = makeVersion({
      id: CURRENT_VERSION_ID,
      projectId: OTHER_PROJECT_ID,
      chapterId: OTHER_CHAPTER_ID,
      content: CURRENT_CONTENT,
      sequence: 1,
      parentVersionId: null,
    });
    const foreignFacts = new ReadOnlyFactStore([]);
    const foreignRuntime = new ChapterNovelValidationRuntime({
      chapters: new ChapterReader(fixture.chapter),
      chapterVersions: new VersionReader([foreignVersion]),
      storyFacts: foreignFacts,
      hasher: new CryptoHasher(),
    });

    await expect(foreignRuntime.checkChapter(request())).resolves.toMatchObject({
      status: "skipped",
      skippedFacts: [{ reason: "current_version_mismatch" }],
    });
    expect(foreignFacts.listCalls).toEqual([]);

    const corruptVersion = makeVersion({
      id: CURRENT_VERSION_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      content: CURRENT_CONTENT,
      sequence: 2,
      parentVersionId: PREVIOUS_VERSION_ID,
      checksum: "0".repeat(64),
    });
    const corruptFacts = new ReadOnlyFactStore([]);
    const corruptRuntime = new ChapterNovelValidationRuntime({
      chapters: new ChapterReader(fixture.chapter),
      chapterVersions: new VersionReader([corruptVersion]),
      storyFacts: corruptFacts,
      hasher: new CryptoHasher(),
    });

    await expect(corruptRuntime.checkChapter(request())).resolves.toMatchObject({
      status: "skipped",
      skippedFacts: [{ reason: "current_version_hash_mismatch" }],
    });
    expect(corruptFacts.listCalls).toEqual([]);
  });

  it("persists an ignored issue as a StoryFact and can undo it after recreating the runtime", async () => {
    const fixture = chapterFixture();
    const { currentClaim, reference } = conflictFacts(60);
    const persistence = new BrowserDevelopmentStoryFactStore(window.localStorage);
    unwrap(await persistence.create(currentClaim));
    unwrap(await persistence.create(reference));
    const firstRuntime = mutableRuntime(fixture, persistence, 600);
    const initial = await firstRuntime.checkChapter(request());
    const issue = initial.issues[0];
    if (issue === undefined || initial.chapterVersionId === null) {
      throw new Error("Expected one evidence-backed issue.");
    }

    const ignored = await firstRuntime.resolveIssue({
      ...request(),
      issueId: issue.id,
      expectedChapterVersionId: initial.chapterVersionId,
      action: "ignore",
      humanConfirmed: true,
    });

    expect(ignored).toMatchObject({
      issueId: issue.id,
      action: "ignore",
      outcome: "ignored",
      idempotent: false,
      audit: {
        storage: "story_fact",
        sourceKind: "review_decision",
        humanConfirmed: true,
      },
    });
    const storedIgnore = unwrap(
      await persistence.findById(ignored.resolutionFactId as StoryUuidV7),
    );
    expect(storedIgnore?.toSnapshot()).toMatchObject({
      factType: "validation_resolution",
      status: "formal",
      userConfirmed: true,
      locked: false,
      deprecated: false,
      source: { kind: "review_decision" },
      structuredValue: {
        resolutionSchema: "inkshadow.chapter-validation-resolution.v1",
        resolutionAction: "ignore",
        resolvedIssueId: issue.id,
      },
    });

    const recreatedRuntime = mutableRuntime(fixture, persistence, 700);
    const persisted = await recreatedRuntime.checkChapter(request());
    expect(persisted.issues[0]).toMatchObject({
      id: issue.id,
      availableActions: [],
      canUndoIgnore: true,
      resolution: { status: "ignored", factId: ignored.resolutionFactId },
    });
    expect(persisted.resolutions).toEqual([
      expect.objectContaining({
        issueId: issue.id,
        action: "ignore",
        state: "active",
        factId: ignored.resolutionFactId,
      }),
    ]);

    const undone = await recreatedRuntime.undoIgnoredIssue({
      ...request(),
      issueId: issue.id,
      expectedChapterVersionId: initial.chapterVersionId,
      humanConfirmed: true,
    });
    expect(undone).toMatchObject({ outcome: "ignore_undone", idempotent: false });
    const afterUndo = await recreatedRuntime.checkChapter(request());
    expect(afterUndo.issues[0]).toMatchObject({
      id: issue.id,
      canUndoIgnore: false,
      resolution: { status: "unresolved" },
      availableActions: ["ignore", "allow", "update_setting"],
    });
    expect(afterUndo.resolutions).toEqual([
      expect.objectContaining({ action: "ignore", state: "undone", factRevision: 2 }),
    ]);
    await expect(
      recreatedRuntime.undoIgnoredIssue({
        ...request(),
        issueId: issue.id,
        expectedChapterVersionId: initial.chapterVersionId,
        humanConfirmed: true,
      }),
    ).resolves.toMatchObject({ outcome: "ignore_undone", idempotent: true });
  });

  it("records an allowed exception as a locked formal rule and resolves idempotently", async () => {
    const fixture = chapterFixture();
    const { currentClaim, reference } = conflictFacts(70);
    const persistence = new BrowserDevelopmentStoryFactStore(window.localStorage);
    unwrap(await persistence.create(currentClaim));
    unwrap(await persistence.create(reference));
    const runtime = mutableRuntime(fixture, persistence, 800);
    const initial = await runtime.checkChapter(request());
    const issue = initial.issues[0];
    if (issue === undefined || initial.chapterVersionId === null) {
      throw new Error("Expected one evidence-backed issue.");
    }
    const command = {
      ...request(),
      issueId: issue.id,
      expectedChapterVersionId: initial.chapterVersionId,
      action: "allow" as const,
      humanConfirmed: true,
    };

    const allowed = await runtime.resolveIssue(command);
    const stored = unwrap(await persistence.findById(allowed.resolutionFactId as StoryUuidV7));
    expect(stored?.toSnapshot()).toMatchObject({
      factType: "character_life_status",
      status: "formal",
      userConfirmed: true,
      locked: true,
      source: {
        kind: "chapter_span",
        versionId: CURRENT_VERSION_ID,
        excerpt: CURRENT_EXCERPT,
      },
      structuredValue: {
        resolutionAction: "allow",
        validationRole: "hard_rule",
        subjectId: "character.lin-yao",
        attributeKey: "life_status",
        operator: "equals",
        expectedValue: "dead",
      },
    });
    const checked = await runtime.checkChapter(request());
    expect(checked.issues[0]).toMatchObject({
      id: issue.id,
      resolution: { status: "allowed", factId: allowed.resolutionFactId },
      availableActions: [],
      canUndoIgnore: false,
    });
    await expect(runtime.resolveIssue(command)).resolves.toMatchObject({
      resolutionFactId: allowed.resolutionFactId,
      outcome: "allowed",
      idempotent: true,
    });
  });

  it("persists and restores supplemental finding dispositions against exact evidence", async () => {
    const fixture = chapterFixture();
    seedDevelopmentChapterAuthority(fixture);
    const persistence = new BrowserDevelopmentStoryFactStore(window.localStorage);
    const runtime = mutableRuntime(fixture, persistence, 850);
    const command = {
      ...request(),
      expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      findingId: "voice:character-linxia:sentence-length",
      category: "character_voice" as const,
      evidenceSignature: SUPPLEMENTAL_EVIDENCE_SIGNATURE,
      action: "ignore" as const,
      humanConfirmed: true,
    };

    const ignored = await runtime.resolveSupplementalFinding(command);
    expect(ignored).toMatchObject({
      findingId: command.findingId,
      category: "character_voice",
      action: "ignore",
      chapterVersionId: CURRENT_VERSION_ID,
    });
    const stored = unwrap(await persistence.findById(ignored.factId as StoryUuidV7));
    expect(stored?.toSnapshot()).toMatchObject({
      factType: "validation_resolution",
      status: "formal",
      deprecated: false,
      structuredValue: {
        resolutionSchema: "inkshadow.chapter-supplemental-finding-resolution.v1",
        resolvedFindingId: command.findingId,
        evidenceSignature: command.evidenceSignature,
      },
    });
    await expect(runtime.resolveSupplementalFinding(command)).resolves.toEqual(ignored);
    await expect(
      runtime.resolveSupplementalFinding({ ...command, action: "allow" }),
    ).rejects.toMatchObject({ code: "NOVEL_VALIDATION_ALREADY_RESOLVED" });

    const recreated = mutableRuntime(fixture, persistence, 860);
    await expect(
      recreated.listSupplementalFindingResolutions({
        ...request(),
        expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      }),
    ).resolves.toEqual([ignored]);
    const undone = await recreated.undoSupplementalFinding({
      ...request(),
      expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      findingId: command.findingId,
      evidenceSignature: command.evidenceSignature,
      resolutionFactId: ignored.factId,
      expectedResolutionFactRevision: ignored.factRevision,
      humanConfirmed: true,
    });
    expect(undone).toMatchObject({ idempotent: false, resolutionFactRevision: 2 });
    await expect(
      recreated.undoSupplementalFinding({
        ...request(),
        expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
        findingId: command.findingId,
        evidenceSignature: command.evidenceSignature,
        resolutionFactId: ignored.factId,
        expectedResolutionFactRevision: ignored.factRevision,
        humanConfirmed: true,
      }),
    ).resolves.toMatchObject({ idempotent: true, resolutionFactRevision: 2 });
    await expect(
      recreated.listSupplementalFindingResolutions({
        ...request(),
        expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      }),
    ).resolves.toEqual([]);
  });

  it("keeps same-identity supplemental dispositions independent across chapter versions", async () => {
    const fixture = chapterFixture();
    seedDevelopmentChapterAuthority(fixture);
    const persistence = new BrowserDevelopmentStoryFactStore(window.localStorage);
    const findingId = "voice:stable-cross-version-finding";
    const sharedSignature = `v2:shared:${"a".repeat(64)}:0-${String(CURRENT_EXCERPT.length)}`;
    const historical = supplementalResolutionFact(
      840,
      PREVIOUS_VERSION_ID,
      findingId,
      sharedSignature,
      "ignore",
    );
    unwrap(await persistence.create(historical));
    const verifier = new StaticSupplementalFindingVerifier([
      { findingId, category: "character_voice", evidenceSignature: sharedSignature },
    ]);
    const runtime = mutableRuntime(fixture, persistence, 850, verifier);
    const currentRequest = {
      ...request(),
      expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
    };

    await expect(runtime.listSupplementalFindingResolutions(currentRequest)).resolves.toEqual([]);
    const current = await runtime.resolveSupplementalFinding({
      ...currentRequest,
      findingId,
      category: "character_voice",
      evidenceSignature: sharedSignature,
      action: "allow",
      humanConfirmed: true,
    });
    expect(current).toMatchObject({
      action: "allow",
      chapterVersionId: CURRENT_VERSION_ID,
      evidenceSignature: sharedSignature,
    });
    expect(current.factId).not.toBe(historical.id);

    const reopened = mutableRuntime(fixture, persistence, 860, verifier);
    await expect(reopened.listSupplementalFindingResolutions(currentRequest)).resolves.toEqual([
      current,
    ]);
    await expect(
      reopened.undoSupplementalFinding({
        ...currentRequest,
        findingId,
        evidenceSignature: sharedSignature,
        resolutionFactId: historical.id,
        expectedResolutionFactRevision: 1,
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_VALIDATION_ISSUE_NOT_FOUND" });
    expect(unwrap(await persistence.findById(historical.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      deprecated: false,
      revision: 1,
    });

    await expect(
      reopened.undoSupplementalFinding({
        ...currentRequest,
        projectId: asDomainUuid(OTHER_PROJECT_ID),
        findingId,
        evidenceSignature: sharedSignature,
        resolutionFactId: current.factId,
        expectedResolutionFactRevision: current.factRevision,
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_VALIDATION_ISSUE_NOT_FOUND" });
    expect(
      unwrap(await persistence.findById(current.factId as StoryUuidV7))?.toSnapshot(),
    ).toMatchObject({ status: "formal", deprecated: false, revision: 1 });
    expect(unwrap(await persistence.listRevisions(current.factId as StoryUuidV7))).toHaveLength(1);

    await expect(
      reopened.undoSupplementalFinding({
        ...currentRequest,
        findingId,
        evidenceSignature: sharedSignature,
        resolutionFactId: current.factId,
        expectedResolutionFactRevision: current.factRevision,
        humanConfirmed: true,
      }),
    ).resolves.toMatchObject({ idempotent: false, resolutionFactRevision: 2 });
    await expect(reopened.listSupplementalFindingResolutions(currentRequest)).resolves.toEqual([]);
    expect(unwrap(await persistence.findById(historical.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      deprecated: false,
      revision: 1,
    });
  });

  it("rejects forged or no-longer-produced supplemental findings with zero writes", async () => {
    const fixture = chapterFixture();
    seedDevelopmentChapterAuthority(fixture);
    const persistence = new BrowserDevelopmentStoryFactStore(window.localStorage);
    const verifier = new StaticSupplementalFindingVerifier([
      {
        findingId: "voice:character-linxia:sentence-length",
        category: "character_voice",
        evidenceSignature: SUPPLEMENTAL_EVIDENCE_SIGNATURE,
      },
    ]);
    const runtime = mutableRuntime(fixture, persistence, 865, verifier);
    const base = {
      ...request(),
      expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      category: "character_voice" as const,
      evidenceSignature: SUPPLEMENTAL_EVIDENCE_SIGNATURE,
      action: "allow" as const,
      humanConfirmed: true,
    };

    await expect(
      runtime.resolveSupplementalFinding({ ...base, findingId: "voice:forged-finding" }),
    ).rejects.toMatchObject({ code: "NOVEL_VALIDATION_ISSUE_NOT_FOUND" });
    await expect(
      runtime.resolveSupplementalFinding({
        ...base,
        findingId: "voice:character-linxia:sentence-length",
        evidenceSignature: `v2:${CURRENT_VERSION_ID}:${"f".repeat(64)}:0-${String(CURRENT_EXCERPT.length)}`,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_VALIDATION_ISSUE_NOT_FOUND" });
    verifier.invalidateSources();
    await expect(
      runtime.resolveSupplementalFinding({
        ...base,
        findingId: "voice:character-linxia:sentence-length",
      }),
    ).rejects.toMatchObject({ code: "NOVEL_VALIDATION_ISSUE_NOT_FOUND" });

    expect(
      unwrap(await persistence.listByProjectId(PROJECT_ID as StoryUuidV7)).filter(
        (fact) => fact.toSnapshot().factType === "validation_resolution",
      ),
    ).toEqual([]);
  });

  it("fails closed with zero supplemental writes when the chapter version changes at commit", async () => {
    const fixture = chapterFixture();
    seedDevelopmentChapterAuthority(fixture);
    const persistence = new BrowserDevelopmentStoryFactStore(window.localStorage);
    const runtime = mutableRuntime(fixture, persistence, 866);
    const serialized = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
    if (serialized === null) throw new Error("Expected development chapter authority.");
    const database = JSON.parse(serialized) as {
      chapters: { id: string; currentVersionId: string }[];
    };
    const chapter = database.chapters.find(({ id }) => id === CHAPTER_ID);
    if (chapter === undefined) throw new Error("Expected the seeded chapter.");
    chapter.currentVersionId = uuid(867);
    window.localStorage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));

    await expect(
      runtime.resolveSupplementalFinding({
        ...request(),
        expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
        findingId: "voice:character-linxia:sentence-length",
        category: "character_voice",
        evidenceSignature: SUPPLEMENTAL_EVIDENCE_SIGNATURE,
        action: "ignore",
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_VALIDATION_STALE_RESULT" });
    expect(
      unwrap(await persistence.listByProjectId(PROJECT_ID as StoryUuidV7)).filter(
        (fact) => fact.toSnapshot().factType === "validation_resolution",
      ),
    ).toEqual([]);
  });

  it("atomically deduplicates same-action retries and rejects opposite concurrent dispositions", async () => {
    const fixture = chapterFixture();
    seedDevelopmentChapterAuthority(fixture);
    const sameActionStore = new BrowserDevelopmentStoryFactStore(window.localStorage);
    const sameLeft = mutableRuntime(fixture, sameActionStore, 870);
    const sameRight = mutableRuntime(fixture, sameActionStore, 880);
    const base = {
      ...request(),
      expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      findingId: "pacing:chapter-run",
      category: "pacing_quality" as const,
      evidenceSignature: SUPPLEMENTAL_EVIDENCE_SIGNATURE,
      humanConfirmed: true,
    };

    const sameResults = await Promise.all([
      sameLeft.resolveSupplementalFinding({ ...base, action: "ignore" }),
      sameRight.resolveSupplementalFinding({ ...base, action: "ignore" }),
    ]);
    expect(sameResults[0].factId).toBe(sameResults[1].factId);
    await expect(
      sameLeft.listSupplementalFindingResolutions({
        ...request(),
        expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      }),
    ).resolves.toHaveLength(1);

    window.localStorage.clear();
    seedDevelopmentChapterAuthority(fixture);
    const oppositeStore = new BrowserDevelopmentStoryFactStore(window.localStorage);
    const oppositeLeft = mutableRuntime(fixture, oppositeStore, 890);
    const oppositeRight = mutableRuntime(fixture, oppositeStore, 900);
    const oppositeResults = await Promise.allSettled([
      oppositeLeft.resolveSupplementalFinding({ ...base, action: "ignore" }),
      oppositeRight.resolveSupplementalFinding({ ...base, action: "allow" }),
    ]);
    expect(oppositeResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = oppositeResults.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "NOVEL_VALIDATION_ALREADY_RESOLVED" },
    });
    await expect(
      oppositeLeft.listSupplementalFindingResolutions({
        ...request(),
        expectedChapterVersionId: asDomainUuid(CURRENT_VERSION_ID),
      }),
    ).resolves.toHaveLength(1);
  });

  it("updates a setting with a confirmed fact and deprecates the superseded fact with revisions", async () => {
    const fixture = chapterFixture();
    const { currentClaim, reference } = conflictFacts(80);
    const persistence = new BrowserDevelopmentStoryFactStore(window.localStorage);
    unwrap(await persistence.create(currentClaim));
    unwrap(await persistence.create(reference));
    const runtime = mutableRuntime(fixture, persistence, 900);
    const initial = await runtime.checkChapter(request());
    const issue = initial.issues[0];
    if (issue === undefined || initial.chapterVersionId === null) {
      throw new Error("Expected one evidence-backed issue.");
    }

    const updated = await runtime.resolveIssue({
      ...request(),
      issueId: issue.id,
      expectedChapterVersionId: initial.chapterVersionId,
      action: "update_setting",
      humanConfirmed: true,
    });

    expect(updated).toMatchObject({
      outcome: "setting_updated",
      audit: { storage: "story_fact", sourceKind: "chapter_span", humanConfirmed: true },
    });
    const replacement = unwrap(await persistence.findById(updated.resolutionFactId as StoryUuidV7));
    expect(replacement?.toSnapshot()).toMatchObject({
      factType: "character_life_status",
      status: "formal",
      userConfirmed: true,
      locked: false,
      structuredValue: {
        resolutionAction: "update_setting",
        validationRole: "reference_fact",
        value: "dead",
      },
    });
    const superseded = unwrap(await persistence.findById(reference.id));
    expect(superseded?.toSnapshot()).toMatchObject({
      status: "deprecated",
      deprecated: true,
      revision: 2,
    });
    expect(unwrap(await persistence.listRevisions(reference.id))).toHaveLength(2);

    const after = await runtime.checkChapter(request());
    expect(after).toMatchObject({ status: "checked", issues: [] });
    expect(after.resolutions).toEqual([
      expect.objectContaining({
        issueId: issue.id,
        action: "update_setting",
        state: "active",
        factId: updated.resolutionFactId,
      }),
    ]);
    await expect(
      runtime.resolveIssue({
        ...request(),
        issueId: issue.id,
        expectedChapterVersionId: initial.chapterVersionId,
        action: "update_setting",
        humanConfirmed: true,
      }),
    ).resolves.toMatchObject({
      resolutionFactId: updated.resolutionFactId,
      idempotent: true,
    });
  });
});

interface ChapterFixture {
  readonly chapter: Chapter;
  readonly previousVersion: ChapterVersion;
  readonly currentVersion: ChapterVersion;
}

function chapterFixture(): ChapterFixture {
  const previousVersion = makeVersion({
    id: PREVIOUS_VERSION_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    content: PREVIOUS_CONTENT,
    sequence: 1,
    parentVersionId: null,
  });
  const currentVersion = makeVersion({
    id: CURRENT_VERSION_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    content: CURRENT_CONTENT,
    sequence: 2,
    parentVersionId: PREVIOUS_VERSION_ID,
  });
  const initial = unwrap(
    Chapter.create({
      id: asDomainUuid(CHAPTER_ID),
      projectId: asDomainUuid(PROJECT_ID),
      title: "第一章",
      content: PREVIOUS_CONTENT,
      initialVersionId: asDomainUuid(PREVIOUS_VERSION_ID),
      now: asDomainTimestamp(NOW),
    }),
  );
  const chapter = unwrap(
    initial.saveContent({
      content: CURRENT_CONTENT,
      expectedRevision: 1,
      newVersionId: asDomainUuid(CURRENT_VERSION_ID),
      now: asDomainTimestamp(LATER),
    }),
  );
  return { chapter, previousVersion, currentVersion };
}

function seedDevelopmentChapterAuthority(fixture: ChapterFixture): void {
  window.localStorage.setItem(
    DEVELOPMENT_DATABASE_KEY,
    JSON.stringify({
      chapters: [fixture.chapter.toSnapshot()],
      versions: [fixture.currentVersion.toSnapshot()],
    }),
  );
}

function supplementalResolutionFact(
  sequence: number,
  chapterVersionId: string,
  findingId: string,
  evidenceSignature: string,
  action: "ignore" | "allow",
): StoryFact {
  return storyFact(sequence, {
    factType: "validation_resolution",
    contentText: "用户处理了检查提醒。",
    structuredValue: {
      resolutionSchema: "inkshadow.chapter-supplemental-finding-resolution.v1",
      resolutionAction: action,
      resolvedFindingId: findingId,
      resolvedFindingCategory: "character_voice",
      resolvedChapterId: CHAPTER_ID,
      resolvedChapterVersionId: chapterVersionId,
      evidenceSignature,
    },
    source: {
      kind: "review_decision",
      reference: `chapter-supplemental-finding:${CHAPTER_ID}:${chapterVersionId}:${findingId}`,
    },
    locked: action === "allow",
  });
}

function conflictFacts(sequence: number): Readonly<{
  currentClaim: StoryFact;
  reference: StoryFact;
}> {
  return Object.freeze({
    currentClaim: storyFact(sequence, {
      factType: "character_life_status",
      structuredValue: currentClaimValue("dead"),
      source: chapterSource(CURRENT_VERSION_ID, CURRENT_CONTENT, CURRENT_EXCERPT),
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    }),
    reference: storyFact(sequence + 1, {
      factType: "character_life_status",
      contentText: "林遥在这一时间段仍然存活。",
      structuredValue: referenceFactValue("alive"),
      source: chapterSource(PREVIOUS_VERSION_ID, PREVIOUS_CONTENT, PREVIOUS_EXCERPT),
    }),
  });
}

function mutableRuntime(
  fixture: ChapterFixture,
  storyFacts: StoryFactStore,
  nextId: number,
  supplementalFindingVerifier: ChapterSupplementalFindingVerificationPort = new StaticSupplementalFindingVerifier(
    [
      {
        findingId: "voice:character-linxia:sentence-length",
        category: "character_voice",
        evidenceSignature: SUPPLEMENTAL_EVIDENCE_SIGNATURE,
      },
      {
        findingId: "pacing:chapter-run",
        category: "pacing_quality",
        evidenceSignature: SUPPLEMENTAL_EVIDENCE_SIGNATURE,
      },
    ],
  ),
): ChapterNovelValidationRuntime {
  const factService = new StoryFactApplicationService({
    facts: storyFacts,
    clock: { now: () => "2026-08-01T00:02:00.000Z" },
    ids: new SequenceStoryIds(nextId),
  });
  return new ChapterNovelValidationRuntime({
    chapters: new ChapterReader(fixture.chapter),
    chapterVersions: new VersionReader([fixture.previousVersion, fixture.currentVersion]),
    storyFacts,
    hasher: new CryptoHasher(),
    supplementalFindingVerifier,
    mutations: { factService, actorId: ACTOR_ID },
  });
}

interface StaticSupplementalFinding {
  readonly findingId: string;
  readonly category: ChapterSupplementalFindingCategory;
  readonly evidenceSignature: string;
}

class StaticSupplementalFindingVerifier implements ChapterSupplementalFindingVerificationPort {
  private active = true;

  public constructor(private readonly findings: readonly StaticSupplementalFinding[]) {}

  public invalidateSources(): void {
    this.active = false;
  }

  public isCurrentFinding(
    request: ChapterSupplementalFindingVerificationRequest,
  ): Promise<boolean> {
    return Promise.resolve(
      this.active &&
        request.expectedChapterVersionId === CURRENT_VERSION_ID &&
        this.findings.some(
          (finding) =>
            finding.findingId === request.findingId &&
            finding.category === request.category &&
            finding.evidenceSignature === request.evidenceSignature,
        ),
    );
  }
}

function makeVersion(input: {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly content: string;
  readonly sequence: number;
  readonly parentVersionId: string | null;
  readonly checksum?: string;
}): ChapterVersion {
  return unwrap(
    ChapterVersion.create({
      id: asDomainUuid(input.id),
      projectId: asDomainUuid(input.projectId),
      chapterId: asDomainUuid(input.chapterId),
      parentVersionId: input.parentVersionId === null ? null : asDomainUuid(input.parentVersionId),
      sequence: input.sequence,
      content: input.content,
      contentChecksum: asChecksum(input.checksum ?? sha256(input.content)),
      reason: input.sequence === 1 ? "created" : "manual",
      sourceCandidateId: null,
      createdAt: asDomainTimestamp(input.sequence === 1 ? NOW : LATER),
    }),
  );
}

interface StoryFactOptions {
  readonly projectId?: string;
  readonly factType: string;
  readonly contentText?: string;
  readonly structuredValue?: unknown;
  readonly source: CreateStoryFactInput["source"];
  readonly status?: CreateStoryFactInput["status"];
  readonly origin?: CreateStoryFactInput["origin"];
  readonly needsReview?: boolean;
  readonly locked?: boolean;
  readonly branchId?: string;
}

function storyFact(sequence: number, options: StoryFactOptions): StoryFact {
  const status = options.status ?? "formal";
  const origin = options.origin ?? "user";
  return unwrap(
    StoryFact.create({
      id: uuid(sequence),
      projectId: options.projectId ?? PROJECT_ID,
      factType: options.factType,
      ...(options.contentText === undefined ? {} : { contentText: options.contentText }),
      ...(options.structuredValue === undefined
        ? {}
        : { structuredValue: options.structuredValue }),
      source: options.source,
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      confidence: 0.95,
      status,
      origin,
      needsReview:
        options.needsReview ??
        (origin === "ai_extraction" || origin === "import" || origin === "legacy"),
      ...(options.locked === undefined ? {} : { locked: options.locked }),
      humanConfirmed: status === "formal",
      ...(status === "formal" ? { confirmationActorId: ACTOR_ID } : {}),
      now: NOW,
    }),
  );
}

function chapterSource(
  versionId: string,
  content: string,
  excerpt: string,
): CreateStoryFactInput["source"] {
  return {
    kind: "chapter_span",
    reference: `chapter:${CHAPTER_ID}:version:${versionId}:0-${String(excerpt.length)}`,
    chapterId: CHAPTER_ID,
    versionId,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: content.length,
    excerpt,
  };
}

function currentClaimValue(
  value: string | boolean,
  subjectId = "character.lin-yao",
  attributeKey = "life_status",
) {
  return {
    validationRole: "current_claim",
    subjectId,
    attributeKey,
    value,
    basis: "explicit_text",
    effectiveRange: { startOrder: 10, endOrder: null },
  };
}

function referenceFactValue(
  value: string | number | boolean,
  subjectId = "character.lin-yao",
  attributeKey = "life_status",
) {
  return {
    validationRole: "reference_fact",
    subjectId,
    attributeKey,
    value,
    effectiveRange: { startOrder: 1, endOrder: null },
  };
}

function hardRuleValue(expectedValue: string | boolean, subjectId: string, attributeKey: string) {
  return {
    validationRole: "hard_rule",
    subjectId,
    attributeKey,
    operator: "equals",
    expectedValue,
    effectiveRange: { startOrder: 1, endOrder: null },
  };
}

function runtimeFor(
  fixture: ChapterFixture,
  storyFacts: Pick<StoryFactStore, "findById" | "listByProjectId">,
): ChapterNovelValidationRuntime {
  return new ChapterNovelValidationRuntime({
    chapters: new ChapterReader(fixture.chapter),
    chapterVersions: new VersionReader([fixture.previousVersion, fixture.currentVersion]),
    storyFacts,
    hasher: new CryptoHasher(),
  });
}

class ChapterReader implements Pick<ChapterRepository, "findById"> {
  public readonly findCalls: DomainUuidV7[] = [];

  public constructor(private readonly chapter: Chapter | null) {}

  public findById(id: DomainUuidV7): Promise<DomainResult<Chapter | null, AppError>> {
    this.findCalls.push(id);
    return Promise.resolve(domainOk(this.chapter));
  }
}

class VersionReader implements Pick<ChapterVersionRepository, "findVersionById"> {
  public readonly findCalls: DomainUuidV7[] = [];
  private readonly versions: ReadonlyMap<string, ChapterVersion>;

  public constructor(versions: readonly ChapterVersion[]) {
    this.versions = new Map(versions.map((version) => [version.toSnapshot().id, version]));
  }

  public findVersionById(id: DomainUuidV7): Promise<DomainResult<ChapterVersion | null, AppError>> {
    this.findCalls.push(id);
    return Promise.resolve(domainOk(this.versions.get(id) ?? null));
  }
}

class ReadOnlyFactStore implements Pick<StoryFactStore, "findById" | "listByProjectId"> {
  public readonly listCalls: StoryUuidV7[] = [];
  private readonly factsById: ReadonlyMap<string, StoryFact>;

  public constructor(private readonly facts: readonly StoryFact[]) {
    this.factsById = new Map(facts.map((fact) => [fact.id, fact]));
  }

  public findById(id: StoryUuidV7): Promise<StoryResult<StoryFact | null, StoryCoreError>> {
    return Promise.resolve(storyOk(this.factsById.get(id) ?? null));
  }

  public listByProjectId(
    projectId: StoryUuidV7,
  ): Promise<StoryResult<readonly StoryFact[], StoryCoreError>> {
    this.listCalls.push(projectId);
    return Promise.resolve(storyOk(this.facts));
  }
}

class CryptoHasher implements ContentHasher {
  public sha256(content: string) {
    return Promise.resolve(parseContentChecksum(sha256(content)));
  }
}

class SequenceStoryIds {
  public constructor(private nextSequence: number) {}

  public next(): string {
    const value = uuid(this.nextSequence);
    this.nextSequence += 1;
    return value;
  }
}

function request() {
  return {
    projectId: asDomainUuid(PROJECT_ID),
    chapterId: asDomainUuid(CHAPTER_ID),
  };
}

function asDomainUuid(value: string): DomainUuidV7 {
  return unwrap(parseDomainUuid(value));
}

function asDomainTimestamp(value: string) {
  return unwrap(parseDomainTimestamp(value));
}

function asChecksum(value: string) {
  return unwrap(parseContentChecksum(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function unwrap<Value>(
  result:
    | Readonly<{ readonly ok: true; readonly value: Value }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}
