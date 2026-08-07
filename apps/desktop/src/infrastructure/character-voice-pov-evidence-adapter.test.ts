import { createHash } from "node:crypto";

import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import {
  Chapter,
  ChapterVersion,
  parseContentChecksum,
  parseIsoUtcTimestamp as parseDomainTimestamp,
  parseUuidV7 as parseDomainUuid,
  ok as domainOk,
  type AppError,
  type Result as DomainResult,
  type UuidV7 as DomainUuidV7,
} from "@inkshadow/domain";
import {
  StoryFact,
  detectCharacterVoiceDeviation,
  ok as storyOk,
  validateNovelConsistency,
  type CharacterVoiceFeatureCatalog,
  type CreateStoryFactInput,
  type Result as StoryResult,
  type StoryCoreError,
  type StoryFactStore,
  type StoryValue,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  CHARACTER_VOICE_EVIDENCE_SCHEMA,
  CharacterVoicePovEvidenceAdapter,
} from "./character-voice-pov-evidence-adapter";

const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = uuid(1);
const CURRENT_CHAPTER_ID = uuid(2);
const CURRENT_VERSION_ID = uuid(3);
const HISTORY_CHAPTER_ID = uuid(4);
const HISTORY_VERSION_ID = uuid(5);
const ACTOR_ID = uuid(6);
const CHARACTER_ID = "character.aria";
const OTHER_CHARACTER_ID = "character.captain";
const CURRENT_DIALOGUE =
  "Hey, Captain, act now! Stop waiting and open the iron gate before anyone follows us.";
const CURRENT_KNOWLEDGE = "Aria knew the observatory key was hidden under the northern stair.";
const CONFIRMED_KNOWLEDGE = "Aria had never learned where the observatory key was hidden.";
const HISTORICAL_DIALOGUE = [
  "Captain, please wait. Perhaps we should take the quiet road before dawn.",
  "Captain, please listen. Perhaps the northern road will be safer for everyone.",
  "Captain, please consider this. Maybe we can leave by the quiet eastern road.",
  "Captain, thank you for waiting. Perhaps we should avoid the crowded road.",
  "Captain, please give me a moment. Maybe the quiet road is still our safest choice.",
  "Captain, thank you for hearing me. Perhaps we can choose another quiet road.",
] as const;

describe("CharacterVoicePovEvidenceAdapter", () => {
  it("prepares evidence-backed voice and POV inputs with exact historical locations", async () => {
    const fixture = fixtureWithFacts(validFacts());

    const prepared = await fixture.adapter.prepare(request());

    expect(prepared.status).toBe("ready");
    expect(prepared.chapterVersionId).toBe(CURRENT_VERSION_ID);
    expect(prepared.currentContentHash).toBe(sha256(fixture.currentVersion.toSnapshot().content));
    expect(prepared.capabilities).toEqual({
      evidenceVerification: "immutable_chapter_version_sha256",
      authorityGate: "user_confirmed_formal_only",
      speakerInference: "disabled",
      freeTextFactInference: "disabled",
      modelInvocation: "not_used",
    });

    const voice = prepared.voiceChecks[0];
    expect(voice?.status).toBe("ready");
    if (voice?.status !== "ready") {
      throw new Error("Expected a prepared voice check.");
    }
    expect(voice.profile.evidenceReadiness.status).toBe("ready");
    expect(voice.profile.typicalQuotes.length).toBeGreaterThan(0);
    for (const quote of voice.profile.typicalQuotes) {
      const version = fixture.historyVersion.toSnapshot();
      expect(version.content.slice(quote.evidence.startOffset, quote.evidence.endOffset)).toBe(
        quote.text,
      );
      expect(quote.evidence.chapterVersionId).toBe(HISTORY_VERSION_ID);
      expect(quote.evidence.locator).toContain(`chapter:${HISTORY_CHAPTER_ID}:version:`);
    }
    const voiceResult = detectCharacterVoiceDeviation(voice.input);
    expect(voiceResult.skippedChecks).not.toContainEqual(
      expect.objectContaining({ reason: "insufficient_historical_evidence" }),
    );
    expect(voiceResult.skippedChecks).not.toContainEqual(
      expect.objectContaining({ reason: "insufficient_current_evidence" }),
    );

    expect(prepared.povCheck.status).toBe("ready");
    if (prepared.povCheck.status !== "ready") {
      throw new Error("Expected a prepared POV check.");
    }
    const povResult = validateNovelConsistency(prepared.povCheck.input);
    expect(povResult.issues).toHaveLength(1);
    const issue = povResult.issues[0];
    if (issue === undefined) {
      throw new Error("Expected an evidence-backed POV issue.");
    }
    expect(issue.issueType).toBe("pov_boundary_violation");
    expect(issue.currentClaim.text).toBe(CURRENT_KNOWLEDGE);
    expect(issue.currentClaim.evidence[0]?.excerpt).toBe(CURRENT_KNOWLEDGE);
    expect(issue.conflictingFact.evidence[0]?.excerpt).toBe(CONFIRMED_KNOWLEDGE);
  });

  it("excludes every relevant fact that is not user-confirmed and formal", async () => {
    const facts = validFacts().map((fact, index) => unconfirmedCopy(fact, 500 + index));
    const fixture = fixtureWithFacts(facts);

    const prepared = await fixture.adapter.prepare(request());

    expect(prepared.status).toBe("skipped");
    expect(prepared.voiceChecks).toEqual([]);
    expect(prepared.povCheck).toEqual(
      expect.objectContaining({ status: "skipped", reason: "pov_current_claim_missing" }),
    );
    expect(
      prepared.diagnostics.filter(({ reason }) => reason === "not_user_confirmed_formal"),
    ).toHaveLength(facts.length);
  });

  it("does not infer voice, speakers, or knowledge roles from names and free text", async () => {
    const contents = fixtureContents();
    const facts = [
      formalFact(600, {
        factType: "character_voice",
        contentText: `${CHARACTER_ID} always says Captain and speaks politely.`,
        source: { kind: "user_statement", reference: "voice described in free text" },
      }),
      formalFact(601, {
        factType: "character_knowledge",
        contentText: `${CHARACTER_ID} knows where the observatory key is hidden.`,
        source: exactSource(
          CURRENT_CHAPTER_ID,
          CURRENT_VERSION_ID,
          contents.current,
          CURRENT_KNOWLEDGE,
        ),
      }),
    ];
    const fixture = fixtureWithFacts(facts);

    const prepared = await fixture.adapter.prepare(request());

    expect(prepared.status).toBe("skipped");
    expect(prepared.voiceChecks).toEqual([]);
    expect(prepared.povCheck.status).toBe("skipped");
    expect(prepared.ignoredUnrelatedFactCount).toBe(1);
    expect(prepared.diagnostics).toContainEqual(
      expect.objectContaining({ factId: uuid(601), reason: "structured_fields_missing" }),
    );
    expect(prepared.capabilities.speakerInference).toBe("disabled");
    expect(prepared.capabilities.freeTextFactInference).toBe("disabled");
  });

  it("rejects altered historical quotations and reports insufficient evidence", async () => {
    const facts = validFacts();
    const tamperedIndexes = facts
      .map((fact, index) => ({ fact, index }))
      .filter(({ fact }) => {
        const structured = fact.toSnapshot().structuredValue;
        return (
          isStoryObject(structured) &&
          structured.characterEvidenceRole === "voice_historical_dialogue"
        );
      })
      .slice(0, 2);
    if (tamperedIndexes.length !== 2) {
      throw new Error("Historical fixtures are missing.");
    }
    for (const [offset, entry] of tamperedIndexes.entries()) {
      const snapshot = entry.fact.toSnapshot();
      const alteredExcerpt = "X".repeat(snapshot.source.excerpt?.length ?? 1);
      facts[entry.index] = formalFact(700 + offset, {
        factType: snapshot.factType,
        structuredValue: snapshot.structuredValue,
        source: {
          kind: "chapter_span",
          reference: snapshot.source.reference,
          chapterId: snapshot.source.chapterId,
          versionId: snapshot.source.versionId,
          startOffset: snapshot.source.startOffset,
          endOffset: snapshot.source.endOffset,
          sourceLength: snapshot.source.sourceLength,
          excerpt: alteredExcerpt,
        },
      });
    }
    const fixture = fixtureWithFacts(facts);

    const prepared = await fixture.adapter.prepare(request());

    expect(prepared.voiceChecks).toContainEqual(
      expect.objectContaining({
        status: "skipped",
        characterId: CHARACTER_ID,
        reason: "historical_dialogue_insufficient",
      }),
    );
    expect(
      prepared.diagnostics
        .filter(({ reason }) => reason === "evidence_span_mismatch")
        .map(({ factId, role }) => ({ factId, role })),
    ).toEqual([
      { factId: uuid(700), role: "voice_historical_dialogue" },
      { factId: uuid(701), role: "voice_historical_dialogue" },
    ]);
  });

  it("skips ambiguous profile configuration and rejects mismatched POV identity", async () => {
    const facts = validFacts();
    facts.push(voiceCatalogFact(800));
    const contents = fixtureContents();
    facts.push(
      formalFact(801, {
        factType: "character_knowledge",
        structuredValue: {
          validationRole: "current_claim",
          subjectId: CHARACTER_ID,
          attributeKey: "observatory-key-location",
          value: "known",
          basis: "explicit_text",
          effectiveRange: { startOrder: 20, endOrder: null },
          povContext: {
            mode: "third_person_limited",
            characterId: OTHER_CHARACTER_ID,
          },
        },
        source: exactSource(
          CURRENT_CHAPTER_ID,
          CURRENT_VERSION_ID,
          contents.current,
          CURRENT_KNOWLEDGE,
        ),
      }),
    );
    const fixture = fixtureWithFacts(facts.filter((fact) => fact.toSnapshot().id !== uuid(300)));

    const prepared = await fixture.adapter.prepare(request());

    expect(prepared.voiceChecks).toContainEqual(
      expect.objectContaining({ status: "skipped", reason: "voice_catalog_ambiguous" }),
    );
    expect(prepared.povCheck).toEqual(
      expect.objectContaining({ status: "skipped", reason: "pov_current_claim_missing" }),
    );
    expect(prepared.diagnostics).toContainEqual(
      expect.objectContaining({
        factId: uuid(801),
        role: "pov_current_knowledge_claim",
        reason: "detector_input_rejected",
      }),
    );
  });

  it("skips the entire preparation when the current immutable version hash is invalid", async () => {
    const fixture = fixtureWithFacts(validFacts(), "0".repeat(64));

    const prepared = await fixture.adapter.prepare(request());

    expect(prepared.status).toBe("skipped");
    expect(prepared.chapterVersionId).toBeNull();
    expect(prepared.diagnostics).toContainEqual(
      expect.objectContaining({ source: "chapter", reason: "current_version_hash_mismatch" }),
    );
  });
});

function validFacts(): StoryFact[] {
  const contents = fixtureContents();
  return [
    voiceCatalogFact(100),
    ...HISTORICAL_DIALOGUE.map((dialogue, index) =>
      formalFact(110 + index, {
        factType: "character_voice_sample",
        structuredValue: {
          characterEvidenceSchema: CHARACTER_VOICE_EVIDENCE_SCHEMA,
          characterEvidenceRole: "voice_historical_dialogue",
          characterId: CHARACTER_ID,
          addresseeCharacterId: OTHER_CHARACTER_ID,
          typical: index === 0,
        },
        source: exactSource(HISTORY_CHAPTER_ID, HISTORY_VERSION_ID, contents.history, dialogue),
      }),
    ),
    formalFact(200, {
      factType: "character_voice_sample",
      structuredValue: {
        characterEvidenceSchema: CHARACTER_VOICE_EVIDENCE_SCHEMA,
        characterEvidenceRole: "voice_current_dialogue",
        characterId: CHARACTER_ID,
        addresseeCharacterId: OTHER_CHARACTER_ID,
        typical: false,
      },
      source: exactSource(
        CURRENT_CHAPTER_ID,
        CURRENT_VERSION_ID,
        contents.current,
        CURRENT_DIALOGUE,
      ),
    }),
    formalFact(300, {
      factType: "character_knowledge",
      structuredValue: {
        validationRole: "current_claim",
        subjectId: CHARACTER_ID,
        attributeKey: "observatory-key-location",
        value: "known",
        basis: "explicit_text",
        effectiveRange: { startOrder: 20, endOrder: null },
        povContext: { mode: "third_person_limited", characterId: CHARACTER_ID },
      },
      source: exactSource(
        CURRENT_CHAPTER_ID,
        CURRENT_VERSION_ID,
        contents.current,
        CURRENT_KNOWLEDGE,
      ),
    }),
    formalFact(301, {
      factType: "character_knowledge",
      structuredValue: {
        validationRole: "reference_fact",
        subjectId: CHARACTER_ID,
        attributeKey: "observatory-key-location",
        value: "unknown",
        effectiveRange: { startOrder: 1, endOrder: null },
      },
      source: exactSource(
        HISTORY_CHAPTER_ID,
        HISTORY_VERSION_ID,
        contents.history,
        CONFIRMED_KNOWLEDGE,
      ),
    }),
  ];
}

function voiceCatalogFact(sequence: number): StoryFact {
  return formalFact(sequence, {
    factType: "character_voice_profile",
    structuredValue: {
      characterEvidenceSchema: CHARACTER_VOICE_EVIDENCE_SCHEMA,
      characterEvidenceRole: "voice_feature_catalog",
      characterId: CHARACTER_ID,
      featureCatalog: featureCatalog(),
    },
    source: { kind: "user_statement", reference: "user-confirmed voice marker catalog" },
  });
}

function featureCatalog(): CharacterVoiceFeatureCatalog {
  return {
    commonTermCandidates: ["Captain", "please", "Perhaps", "quiet", "road"],
    emotionMarkers: ["furious"],
    politeMarkers: ["please", "thank you"],
    casualMarkers: ["Hey", "Stop"],
    directMarkers: ["act now", "open"],
    indirectMarkers: ["Perhaps", "Maybe"],
    metaphorMarkers: ["like", "as if"],
    dialectMarkers: ["y'all", "ain't"],
    addressTerms: [{ addresseeCharacterId: OTHER_CHARACTER_ID, terms: ["Captain"] }],
  };
}

function fixtureContents(): Readonly<{ current: string; history: string }> {
  return Object.freeze({
    current: `${CURRENT_DIALOGUE}\n\n${CURRENT_KNOWLEDGE}`,
    history: `${HISTORICAL_DIALOGUE.join("\n")}\n${CONFIRMED_KNOWLEDGE}`,
  });
}

function fixtureWithFacts(facts: readonly StoryFact[], currentChecksum?: string) {
  const contents = fixtureContents();
  const currentVersion = makeVersion({
    id: CURRENT_VERSION_ID,
    projectId: PROJECT_ID,
    chapterId: CURRENT_CHAPTER_ID,
    content: contents.current,
    ...(currentChecksum === undefined ? {} : { checksum: currentChecksum }),
  });
  const historyVersion = makeVersion({
    id: HISTORY_VERSION_ID,
    projectId: PROJECT_ID,
    chapterId: HISTORY_CHAPTER_ID,
    content: contents.history,
  });
  const chapter = unwrap(
    Chapter.create({
      id: asDomainUuid(CURRENT_CHAPTER_ID),
      projectId: asDomainUuid(PROJECT_ID),
      title: "Current chapter",
      content: contents.current,
      initialVersionId: asDomainUuid(CURRENT_VERSION_ID),
      now: asDomainTimestamp(NOW),
    }),
  );
  return {
    currentVersion,
    historyVersion,
    adapter: new CharacterVoicePovEvidenceAdapter({
      chapters: new ChapterReader(chapter),
      chapterVersions: new VersionReader([currentVersion, historyVersion]),
      storyFacts: new FactReader(facts),
      hasher: new CryptoHasher(),
    }),
  };
}

interface FactOptions {
  readonly factType: string;
  readonly contentText?: string;
  readonly structuredValue?: unknown;
  readonly source: CreateStoryFactInput["source"];
}

function formalFact(sequence: number, options: FactOptions): StoryFact {
  return unwrap(
    StoryFact.create({
      id: uuid(sequence),
      projectId: PROJECT_ID,
      factType: options.factType,
      ...(options.contentText === undefined ? {} : { contentText: options.contentText }),
      ...(options.structuredValue === undefined
        ? {}
        : { structuredValue: options.structuredValue }),
      source: options.source,
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: NOW,
    }),
  );
}

function unconfirmedCopy(fact: StoryFact, sequence: number): StoryFact {
  const snapshot = fact.toSnapshot();
  return unwrap(
    StoryFact.create({
      id: uuid(sequence),
      projectId: snapshot.projectId,
      factType: snapshot.factType,
      ...(snapshot.contentText === null ? {} : { contentText: snapshot.contentText }),
      ...(snapshot.structuredValue === null ? {} : { structuredValue: snapshot.structuredValue }),
      source: snapshot.source,
      confidence: snapshot.confidence,
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
      humanConfirmed: false,
      now: NOW,
    }),
  );
}

function exactSource(
  chapterId: string,
  versionId: string,
  content: string,
  excerpt: string,
): CreateStoryFactInput["source"] {
  const startOffset = content.indexOf(excerpt);
  if (startOffset < 0) {
    throw new Error("Fixture excerpt is not present in its chapter version.");
  }
  return {
    kind: "chapter_span",
    reference: `chapter:${chapterId}:version:${versionId}:${String(startOffset)}-${String(startOffset + excerpt.length)}`,
    chapterId,
    versionId,
    startOffset,
    endOffset: startOffset + excerpt.length,
    sourceLength: content.length,
    excerpt,
  };
}

function makeVersion(input: {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly content: string;
  readonly checksum?: string;
}): ChapterVersion {
  return unwrap(
    ChapterVersion.create({
      id: asDomainUuid(input.id),
      projectId: asDomainUuid(input.projectId),
      chapterId: asDomainUuid(input.chapterId),
      parentVersionId: null,
      sequence: 1,
      content: input.content,
      contentChecksum: asChecksum(input.checksum ?? sha256(input.content)),
      reason: "created",
      sourceCandidateId: null,
      createdAt: asDomainTimestamp(NOW),
    }),
  );
}

class ChapterReader implements Pick<ChapterRepository, "findById"> {
  public constructor(private readonly chapter: Chapter | null) {}

  public findById(): Promise<DomainResult<Chapter | null, AppError>> {
    return Promise.resolve(domainOk(this.chapter));
  }
}

class VersionReader implements Pick<ChapterVersionRepository, "findVersionById"> {
  private readonly versions: ReadonlyMap<string, ChapterVersion>;

  public constructor(versions: readonly ChapterVersion[]) {
    this.versions = new Map(versions.map((version) => [version.toSnapshot().id, version]));
  }

  public findVersionById(id: DomainUuidV7): Promise<DomainResult<ChapterVersion | null, AppError>> {
    return Promise.resolve(domainOk(this.versions.get(id) ?? null));
  }
}

class FactReader implements Pick<StoryFactStore, "listByProjectId"> {
  public constructor(private readonly facts: readonly StoryFact[]) {}

  public listByProjectId(): Promise<StoryResult<readonly StoryFact[], StoryCoreError>> {
    return Promise.resolve(storyOk(this.facts));
  }
}

class CryptoHasher implements ContentHasher {
  public sha256(content: string) {
    return Promise.resolve(parseContentChecksum(sha256(content)));
  }
}

function request() {
  return {
    projectId: asDomainUuid(PROJECT_ID),
    chapterId: asDomainUuid(CURRENT_CHAPTER_ID),
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

function isStoryObject(value: StoryValue | null): value is Readonly<Record<string, StoryValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
