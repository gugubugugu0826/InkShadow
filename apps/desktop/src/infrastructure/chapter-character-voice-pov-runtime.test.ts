import {
  buildCharacterVoiceProfile,
  type CharacterDialogueSample,
  type CharacterVoiceFeatureCatalog,
  type NovelCurrentClaim,
  type NovelEvidenceReference,
  type NovelReferenceFact,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  CharacterVoicePovEvidenceAdapterError,
  type CharacterVoicePovEvidenceDiagnostic,
  type CharacterVoicePovEvidencePreparation,
  type PrepareCharacterVoicePovEvidenceRequest,
} from "./character-voice-pov-evidence-adapter";
import {
  ChapterCharacterVoicePovRuntime,
  type CharacterVoicePovEvidencePreparationPort,
} from "./chapter-character-voice-pov-runtime";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const CURRENT_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const HISTORY_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const CHARACTER_ID = "character.aria";
const ADDRESSEE_ID = "character.captain";
const HASH = "a".repeat(64);
const CURRENT_DIALOGUE =
  "Hey Captain, stop waiting! Open the gate now, and do exactly what I told you.";
const CURRENT_KNOWLEDGE = "Aria knew the observatory key was beneath the northern stair.";
const HISTORICAL_KNOWLEDGE = "Aria had never learned where the observatory key was hidden.";
const HISTORICAL_LINES = [
  "Captain, please wait. Perhaps we should take the quiet road before dawn.",
  "Captain, please listen. Perhaps the northern road will be safer for everyone.",
  "Captain, please consider this. Maybe we can leave by the quiet eastern road.",
  "Captain, thank you for waiting. Perhaps we should avoid the crowded road.",
  "Captain, please give me a moment. Maybe the quiet road is still our safest choice.",
  "Captain, thank you for hearing me. Perhaps we can choose another quiet road.",
] as const;

describe("ChapterCharacterVoicePovRuntime", () => {
  it("normalizes deterministic voice and POV findings with readable evidence and suggestions", async () => {
    const port = new StaticPreparationPort(readyPreparation());
    const runtime = new ChapterCharacterVoicePovRuntime(port);

    const result = await runtime.check(request());

    expect(port.requests).toEqual([request()]);
    expect(result.status).toBe("ready");
    expect(result.error).toBeNull();
    expect(result.summary.detectorRunCount).toBe(2);
    expect(result.summary.checkedCharacterCount).toBe(1);
    expect(result.summary.voiceIssueCount).toBeGreaterThan(0);
    expect(result.summary.povIssueCount).toBe(1);
    expect(result.capabilities).toEqual({
      voiceReview: "deterministic_statistics",
      povReview: "deterministic_fact_comparison",
      immutableEvidenceRequired: true,
      modelInference: "disabled",
      mutatesChapter: false,
      mutatesStoryFacts: false,
    });

    const voiceIssue = result.issues.find(({ kind }) => kind === "character_voice_deviation");
    if (voiceIssue === undefined) {
      throw new Error("Expected a deterministic voice finding.");
    }
    expect(voiceIssue.title).toMatch(/人物/u);
    expect(voiceIssue.summary).toContain(CHARACTER_ID);
    expect(voiceIssue.suggestion.summary.length).toBeGreaterThan(0);
    expect(voiceIssue.currentEvidence[0]).toEqual(
      expect.objectContaining({
        role: "current_text",
        chapterId: CHAPTER_ID,
        chapterVersionId: CURRENT_VERSION_ID,
        excerpt: CURRENT_DIALOGUE,
      }),
    );
    expect(voiceIssue.referenceEvidence.length).toBeGreaterThan(0);
    expect(voiceIssue.referenceEvidence[0]?.role).toBe("historical_dialogue");
    expect(voiceIssue.sourceFactIds.current).toEqual(["fact.voice.current"]);
    expect(voiceIssue.sourceFactIds.reference).toEqual(
      HISTORICAL_LINES.map((_, index) => `fact.voice.history.${String(index + 1)}`),
    );

    const povIssue = result.issues.find(({ kind }) => kind === "pov_boundary_violation");
    if (povIssue === undefined) {
      throw new Error("Expected a deterministic POV finding.");
    }
    expect(povIssue.severity).toBe("error");
    expect(povIssue.title).toBe("视角人物知道了尚未获得的信息");
    expect(povIssue.currentEvidence[0]?.excerpt).toBe(CURRENT_KNOWLEDGE);
    expect(povIssue.referenceEvidence[0]?.excerpt).toBe(HISTORICAL_KNOWLEDGE);
    expect(povIssue.suggestion.actions).toContain("补充有证据的信息获得事件");
    expect(povIssue.requiresHumanReview).toBe(true);
  });

  it("returns skipped with actionable explanations when no detector has enough evidence", async () => {
    const preparation = skippedPreparation();
    const runtime = new ChapterCharacterVoicePovRuntime(new StaticPreparationPort(preparation));

    const result = await runtime.check(request());

    expect(result.status).toBe("skipped");
    expect(result.issues).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.summary.detectorRunCount).toBe(0);
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({
        scope: "pov",
        reason: "pov_current_claim_missing",
        title: "人物知识边界证据不足",
      }),
      expect.objectContaining({
        scope: "voice",
        reason: "voice_catalog_missing",
        title: "人物声纹设置不完整",
      }),
    ]);
    expect(result.skippedChecks.every(({ explanation }) => explanation.length > 0)).toBe(true);
  });

  it("keeps a partial preparation ready while exposing skipped POV work", async () => {
    const preparation = readyPreparation();
    const partial: CharacterVoicePovEvidencePreparation = Object.freeze({
      ...preparation,
      status: "partial",
      povCheck: Object.freeze({
        status: "skipped",
        reason: "pov_confirmed_knowledge_missing",
        missingRequirements: Object.freeze(["confirmed_character_knowledge"]),
      }),
      diagnostics: Object.freeze([
        adapterDiagnostic("pov_check", "pov_confirmed_knowledge_missing", null, null, [
          "confirmed_character_knowledge",
        ]),
      ]),
    });
    const runtime = new ChapterCharacterVoicePovRuntime(new StaticPreparationPort(partial));

    const result = await runtime.check(request());

    expect(result.status).toBe("ready");
    expect(result.summary.detectorRunCount).toBe(1);
    expect(result.summary.povIssueCount).toBe(0);
    expect(result.skippedChecks).toContainEqual(
      expect.objectContaining({ reason: "pov_confirmed_knowledge_missing", scope: "pov" }),
    );
  });

  it("returns a localized retryable error when evidence storage is unavailable", async () => {
    const runtime = new ChapterCharacterVoicePovRuntime(
      new ThrowingPreparationPort(
        new CharacterVoicePovEvidenceAdapterError(
          "CHARACTER_EVIDENCE_STORAGE_UNAVAILABLE",
          "database path and internal details",
          true,
        ),
      ),
    );

    const result = await runtime.check(request());

    expect(result.status).toBe("error");
    expect(result.issues).toEqual([]);
    expect(result.error).toEqual({
      code: "CHARACTER_EVIDENCE_STORAGE_UNAVAILABLE",
      title: "暂时无法读取检查资料",
      description: "系统无法读取章节版本或故事事实。正文没有改变，请稍后重试。",
      retryable: true,
      actions: ["重试检查", "确认本地数据库可用"],
    });
    expect(JSON.stringify(result)).not.toContain("database path");
  });

  it("sanitizes unexpected detector failures and preserves the read-only contract", async () => {
    const runtime = new ChapterCharacterVoicePovRuntime(
      new ThrowingPreparationPort(new Error("secret internal detector detail")),
    );

    const result = await runtime.check(request());

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("CHARACTER_VOICE_POV_RUNTIME_FAILED");
    expect(result.error?.retryable).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret internal detector detail");
    expect(result.capabilities.modelInference).toBe("disabled");
    expect(result.capabilities.mutatesChapter).toBe(false);
    expect(result.capabilities.mutatesStoryFacts).toBe(false);
  });
});

function readyPreparation(): CharacterVoicePovEvidencePreparation {
  const historicalDialogue = HISTORICAL_LINES.map((text, index) =>
    dialogueSample(
      `historical-${String(index + 1)}`,
      text,
      HISTORY_VERSION_ID,
      index === 0,
      `history:${String(index + 1)}`,
    ),
  );
  const profile = buildCharacterVoiceProfile({
    id: "profile.aria",
    projectId: PROJECT_ID,
    branchId: "main",
    characterId: CHARACTER_ID,
    historicalDialogue,
    featureCatalog: featureCatalog(),
  });
  const currentDialogue = [
    dialogueSample("current-1", CURRENT_DIALOGUE, CURRENT_VERSION_ID, false, "current:1"),
  ];
  const povCurrentEvidence = novelEvidence(
    "current-knowledge",
    CURRENT_KNOWLEDGE,
    CURRENT_VERSION_ID,
  );
  const povHistoricalEvidence = novelEvidence(
    "historical-knowledge",
    HISTORICAL_KNOWLEDGE,
    HISTORY_VERSION_ID,
  );
  const currentClaim: NovelCurrentClaim = {
    id: "pov-current:fact.pov.current:r1",
    factType: "character_knowledge",
    subjectId: CHARACTER_ID,
    attributeKey: "observatory-key-location",
    branchId: null,
    effectiveRange: { startOrder: 20, endOrder: null },
    value: "known",
    evidence: [povCurrentEvidence],
    basis: "explicit_text",
    claimText: CURRENT_KNOWLEDGE,
    povContext: { mode: "third_person_limited", characterId: CHARACTER_ID },
  };
  const referenceFact: NovelReferenceFact = {
    id: "pov-reference:fact.pov.history:r1",
    factType: "character_knowledge",
    subjectId: CHARACTER_ID,
    attributeKey: "observatory-key-location",
    branchId: null,
    effectiveRange: { startOrder: 1, endOrder: null },
    value: "unknown",
    evidence: [povHistoricalEvidence],
    status: "confirmed",
    factText: HISTORICAL_KNOWLEDGE,
  };
  return Object.freeze({
    status: "ready",
    projectId: PROJECT_ID as CharacterVoicePovEvidencePreparation["projectId"],
    chapterId: CHAPTER_ID as CharacterVoicePovEvidencePreparation["chapterId"],
    chapterVersionId: CURRENT_VERSION_ID as NonNullable<
      CharacterVoicePovEvidencePreparation["chapterVersionId"]
    >,
    chapterRevision: 1,
    currentContentHash: HASH,
    voiceChecks: Object.freeze([
      Object.freeze({
        status: "ready",
        characterId: CHARACTER_ID,
        profile,
        input: Object.freeze({ profile, currentDialogue: Object.freeze(currentDialogue) }),
        sourceFactIds: Object.freeze({
          featureCatalog: "fact.voice.catalog",
          historicalDialogue: Object.freeze(
            HISTORICAL_LINES.map((_, index) => `fact.voice.history.${String(index + 1)}`),
          ),
          currentDialogue: Object.freeze(["fact.voice.current"]),
        }),
      }),
    ]),
    povCheck: Object.freeze({
      status: "ready",
      input: Object.freeze({
        currentClaims: Object.freeze([currentClaim]),
        referenceFacts: Object.freeze([referenceFact]),
        hardRules: Object.freeze([]),
      }),
      sourceFactIds: Object.freeze({
        currentClaims: Object.freeze(["fact.pov.current"]),
        confirmedKnowledge: Object.freeze(["fact.pov.history"]),
      }),
    }),
    diagnostics: Object.freeze([]),
    missingRequirements: Object.freeze([]),
    ignoredUnrelatedFactCount: 0,
    capabilities: adapterCapabilities(),
  });
}

function skippedPreparation(): CharacterVoicePovEvidencePreparation {
  return Object.freeze({
    status: "skipped",
    projectId: PROJECT_ID as CharacterVoicePovEvidencePreparation["projectId"],
    chapterId: CHAPTER_ID as CharacterVoicePovEvidencePreparation["chapterId"],
    chapterVersionId: CURRENT_VERSION_ID as NonNullable<
      CharacterVoicePovEvidencePreparation["chapterVersionId"]
    >,
    chapterRevision: 1,
    currentContentHash: HASH,
    voiceChecks: Object.freeze([
      Object.freeze({
        status: "skipped",
        characterId: CHARACTER_ID,
        reason: "voice_catalog_missing",
        missingRequirements: Object.freeze(["voice_catalog"]),
      }),
    ]),
    povCheck: Object.freeze({
      status: "skipped",
      reason: "pov_current_claim_missing",
      missingRequirements: Object.freeze(["current_pov_claim"]),
    }),
    diagnostics: Object.freeze([
      adapterDiagnostic("voice_check", "voice_catalog_missing", null, CHARACTER_ID, [
        "voice_catalog",
      ]),
      adapterDiagnostic("pov_check", "pov_current_claim_missing", null, null, [
        "current_pov_claim",
      ]),
    ]),
    missingRequirements: Object.freeze(["voice_catalog", "current_pov_claim"]),
    ignoredUnrelatedFactCount: 0,
    capabilities: adapterCapabilities(),
  });
}

function adapterDiagnostic(
  source: CharacterVoicePovEvidenceDiagnostic["source"],
  reason: CharacterVoicePovEvidenceDiagnostic["reason"],
  factId: string | null,
  characterId: string | null,
  missingRequirements: readonly string[],
): CharacterVoicePovEvidenceDiagnostic {
  return Object.freeze({
    source,
    factId,
    factRevision: factId === null ? null : 1,
    role: null,
    characterId,
    reason,
    missingRequirements: Object.freeze([...missingRequirements]),
  });
}

function adapterCapabilities(): CharacterVoicePovEvidencePreparation["capabilities"] {
  return Object.freeze({
    evidenceVerification: "immutable_chapter_version_sha256",
    authorityGate: "user_confirmed_formal_only",
    speakerInference: "disabled",
    freeTextFactInference: "disabled",
    modelInvocation: "not_used",
  });
}

function dialogueSample(
  id: string,
  text: string,
  chapterVersionId: string,
  typical: boolean,
  locator: string,
): CharacterDialogueSample {
  return {
    id,
    projectId: PROJECT_ID,
    branchId: "main",
    characterId: CHARACTER_ID,
    addresseeCharacterId: ADDRESSEE_ID,
    text,
    typical,
    evidence: {
      id: `evidence:${id}`,
      chapterId: CHAPTER_ID,
      chapterVersionId,
      contentHash: HASH,
      locator,
      excerpt: text,
      startOffset: 0,
      endOffset: text.length,
      sourceLength: text.length,
    },
  };
}

function novelEvidence(
  id: string,
  excerpt: string,
  sourceVersionId: string,
): NovelEvidenceReference {
  return {
    sourceKind: "chapter",
    sourceId: CHAPTER_ID,
    sourceVersionId,
    contentHash: HASH,
    locator: id,
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: excerpt.length,
  };
}

function featureCatalog(): CharacterVoiceFeatureCatalog {
  return {
    commonTermCandidates: ["Captain", "please", "Perhaps", "quiet", "road"],
    emotionMarkers: ["furious"],
    politeMarkers: ["please", "thank you"],
    casualMarkers: ["Hey", "Stop"],
    directMarkers: ["Open", "now"],
    indirectMarkers: ["Perhaps", "Maybe"],
    metaphorMarkers: ["like", "as if"],
    dialectMarkers: ["y'all", "ain't"],
    addressTerms: [{ addresseeCharacterId: ADDRESSEE_ID, terms: ["Captain"] }],
  };
}

class StaticPreparationPort implements CharacterVoicePovEvidencePreparationPort {
  public readonly requests: PrepareCharacterVoicePovEvidenceRequest[] = [];

  public constructor(private readonly preparation: CharacterVoicePovEvidencePreparation) {}

  public prepare(
    requestValue: PrepareCharacterVoicePovEvidenceRequest,
  ): Promise<CharacterVoicePovEvidencePreparation> {
    this.requests.push(requestValue);
    return Promise.resolve(this.preparation);
  }
}

class ThrowingPreparationPort implements CharacterVoicePovEvidencePreparationPort {
  public constructor(private readonly cause: unknown) {}

  public prepare(): Promise<CharacterVoicePovEvidencePreparation> {
    return Promise.reject(this.cause instanceof Error ? this.cause : new Error(String(this.cause)));
  }
}

function request(): PrepareCharacterVoicePovEvidenceRequest {
  return {
    projectId: PROJECT_ID as PrepareCharacterVoicePovEvidenceRequest["projectId"],
    chapterId: CHAPTER_ID as PrepareCharacterVoicePovEvidenceRequest["chapterId"],
  };
}
