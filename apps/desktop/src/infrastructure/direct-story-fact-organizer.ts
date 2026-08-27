import { createEvidenceRef } from "@inkshadow/ai-core";
import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import type { UuidV7 as DomainUuidV7 } from "@inkshadow/domain";
import {
  REBUILDABLE_SYSTEM_FACT_SCHEMA_VERSION,
  type StoryFact,
  type StoryFactApplicationService,
  type StoryFactStore,
  type UuidV7,
} from "@inkshadow/story-core";

import {
  CHAPTER_SUMMARY_MAXIMUM_SEGMENTS,
  CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS,
  CHAPTER_SUMMARY_PAYLOAD_SCHEMA_VERSION,
  CHAPTER_SUMMARY_SEGMENT_CHARACTERS,
  CHAPTER_SUMMARY_TASK,
} from "./chapter-summary-service";

const ORGANIZER_SCHEMA = "inkshadow.direct-local-story-fact.v1";
const MAXIMUM_FACTS_PER_VERSION = 128;
const ORGANIZER_REFERENCE_PREFIX = `direct-local:${ORGANIZER_SCHEMA}:`;
const LOCAL_SUMMARY_PROVIDER = "本地确定性整理";
const LOCAL_SUMMARY_MODEL = "首尾句抽取摘要第一版";
const SOURCE_CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface DirectStoryFactOrganizerInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly versionCreatedAt: string;
  /** Exact text introduced by the accepted application, never the whole chapter. */
  readonly acceptedText: string;
  /** UTF-16 start of acceptedText in the immutable version. */
  readonly acceptedStartOffset: number;
  /** Full immutable-version UTF-16 length used to validate evidence locators. */
  readonly sourceLength: number;
  /** SHA-256 of the complete immutable version, even when acceptedText is only a changed span. */
  readonly sourceContentHash?: string;
  readonly currentVersionId: string;
  readonly localOnly: boolean;
}

export interface DirectStoryFactOrganizerReceipt {
  readonly organizedCount: number;
  readonly importantReviewCount: number;
  readonly alreadyOrganizedCount: number;
  readonly sourceWasCurrent: boolean;
}

export interface DirectStoryFactOrganizerDependencies {
  readonly facts: Pick<StoryFactStore, "listByProjectId">;
  readonly factService: Pick<
    StoryFactApplicationService,
    "replaceRebuildableSystemFactWithAuthorityFence" | "stageAutomaticFactWithAuthorityFence"
  >;
  readonly hasher: ContentHasher;
  readonly now: () => string;
  /** Re-reads mutable chapter authority immediately before a derived write. */
  readonly sourceIsCurrent?: () => Promise<boolean>;
}

export interface CurrentSavedVersionOrganizerDependencies extends DirectStoryFactOrganizerDependencies {
  readonly chapters: Pick<ChapterRepository, "findById">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
}

interface ExtractedFact {
  readonly factType: string;
  readonly contentText: string;
  readonly kind: "ordinary" | "important";
  readonly startOffset: number;
  readonly endOffset: number;
  readonly excerpt: string;
  readonly payload: Readonly<Record<string, string>>;
}

interface NaturalNarrativeFact {
  readonly factType: string;
  readonly contentText: string;
  readonly kind: "ordinary" | "important";
  readonly payload: Readonly<Record<string, string>>;
}

export interface DirectStoryFactOrganizationSpan {
  readonly text: string;
  readonly startOffset: number;
  readonly sourceLength: number;
}

/** Expands the changed UTF-16 range to complete正文 sentence boundaries. */
export function changedStoryFactOrganizationSpan(
  before: string,
  after: string,
): DirectStoryFactOrganizationSpan | null {
  let changedStart = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (changedStart < sharedLength && before[changedStart] === after[changedStart]) {
    changedStart += 1;
  }
  let sharedSuffixLength = 0;
  while (
    sharedSuffixLength < before.length - changedStart &&
    sharedSuffixLength < after.length - changedStart &&
    before[before.length - 1 - sharedSuffixLength] === after[after.length - 1 - sharedSuffixLength]
  ) {
    sharedSuffixLength += 1;
  }
  const changedEnd = after.length - sharedSuffixLength;
  if (changedEnd <= changedStart) return null;

  let startOffset = changedStart;
  while (startOffset > 0 && !isSentenceBoundary(after[startOffset - 1] ?? "")) {
    startOffset -= 1;
  }
  let endOffset = changedEnd;
  while (endOffset < after.length && !isSentenceBoundary(after[endOffset] ?? "")) {
    endOffset += 1;
  }
  if (endOffset < after.length && after[endOffset] !== "\n") endOffset += 1;
  return Object.freeze({
    text: after.slice(startOffset, endOffset),
    startOffset,
    sourceLength: after.length,
  });
}

/**
 * Rebuilds conservative local facts from the complete current immutable
 * version. A stale durable task is intentionally a no-op: historical text
 * must never be promoted back into the current story state.
 */
export async function organizeCurrentSavedVersionStoryFacts(
  dependencies: CurrentSavedVersionOrganizerDependencies,
  input: Pick<DirectStoryFactOrganizerInput, "projectId" | "chapterId" | "versionId">,
): Promise<DirectStoryFactOrganizerReceipt> {
  const chapterResult = await dependencies.chapters.findById(input.chapterId as DomainUuidV7);
  if (!chapterResult.ok) throw chapterResult.error;
  const chapter = chapterResult.value;
  if (chapter?.projectId !== input.projectId) {
    throw new Error("Current chapter for direct story-fact organization was not found.");
  }
  if (chapter.currentVersionId !== input.versionId) {
    return Object.freeze({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 0,
      sourceWasCurrent: false,
    });
  }
  const versionResult = await dependencies.chapterVersions.findVersionById(
    input.versionId as DomainUuidV7,
  );
  if (!versionResult.ok) throw versionResult.error;
  const versionEntity = versionResult.value;
  if (versionEntity === null) {
    throw new Error("Current immutable version for direct story-fact organization was not found.");
  }
  const version = versionEntity.toSnapshot();
  if (version.projectId !== input.projectId || version.chapterId !== input.chapterId) {
    throw new Error("Current immutable version does not belong to the accepted chapter.");
  }
  return organizeDirectStoryFacts(
    {
      ...dependencies,
      sourceIsCurrent: async () => {
        const latestResult = await dependencies.chapters.findById(input.chapterId as DomainUuidV7);
        if (!latestResult.ok) throw latestResult.error;
        return (
          latestResult.value?.projectId === input.projectId &&
          latestResult.value.currentVersionId === input.versionId
        );
      },
    },
    {
      projectId: input.projectId,
      chapterId: input.chapterId,
      versionId: input.versionId,
      versionCreatedAt: version.createdAt,
      acceptedText: version.content,
      acceptedStartOffset: 0,
      sourceLength: version.content.length,
      sourceContentHash: version.contentChecksum,
      currentVersionId: chapter.currentVersionId,
      localOnly: chapter.isLocalOnly,
    },
  );
}

/**
 * Conservative, deterministic extraction from an already accepted immutable
 * version. No model, gateway, route, credential, invocation or retry exists in
 * this service. Unknown prose is intentionally ignored.
 */
export async function organizeDirectStoryFacts(
  dependencies: DirectStoryFactOrganizerDependencies,
  input: DirectStoryFactOrganizerInput,
): Promise<DirectStoryFactOrganizerReceipt> {
  if (!(await directStoryFactSourceIsCurrent(dependencies, input))) {
    return Object.freeze({
      organizedCount: 0,
      importantReviewCount: 0,
      alreadyOrganizedCount: 0,
      sourceWasCurrent: false,
    });
  }
  const listed = await dependencies.facts.listByProjectId(input.projectId as UuidV7);
  if (!listed.ok) throw listed.error;
  const existingEvidence = new Set<string>();
  const activeDirectEvidence = new Set<string>();
  const deletedEvidence = new Set<string>();
  const confirmedFactTexts: string[] = [];
  const userAuthoredFacts = new Set<string>();
  for (const fact of listed.value) {
    const snapshot = fact.toSnapshot();
    existingEvidence.add(evidenceIdentity(fact));
    if (snapshot.origin === "user" && snapshot.contentText !== null) {
      userAuthoredFacts.add(authoredFactIdentity(snapshot.factType, snapshot.contentText));
    }
    const directIdentity = directOrganizerEvidenceIdentity(snapshot);
    if (snapshot.status === "deprecated") {
      if (directIdentity !== null) deletedEvidence.add(directIdentity);
      continue;
    }
    if (directIdentity !== null && snapshot.source.versionId !== null) {
      activeDirectEvidence.add(
        currentDirectEvidenceIdentity(snapshot.source.versionId, directIdentity),
      );
    }
    if (snapshot.userConfirmed && snapshot.contentText !== null) {
      confirmedFactTexts.push(snapshot.contentText);
    }
  }
  if (
    !Number.isSafeInteger(input.acceptedStartOffset) ||
    input.acceptedStartOffset < 0 ||
    !Number.isSafeInteger(input.sourceLength) ||
    input.sourceLength < input.acceptedStartOffset + input.acceptedText.length
  ) {
    throw new Error("Direct story-fact evidence span is invalid.");
  }
  const sourceContentHash = await resolveSourceContentHash(dependencies.hasher, input);
  const extracted = extractExplicitFacts(
    input.acceptedText,
    input.acceptedStartOffset,
    confirmedFactTexts,
  ).slice(0, MAXIMUM_FACTS_PER_VERSION);
  if (!(await directStoryFactSourceIsCurrent(dependencies, input))) {
    return staleDirectStoryFactReceipt();
  }
  let organizedCount = 0;
  let importantReviewCount = 0;
  let alreadyOrganizedCount = 0;

  for (const candidate of extracted) {
    if (userAuthoredFacts.has(authoredFactIdentity(candidate.factType, candidate.contentText))) {
      alreadyOrganizedCount += 1;
      continue;
    }
    const hashed = await dependencies.hasher.sha256(candidate.excerpt);
    if (!hashed.ok) throw hashed.error;
    const deletedIdentity = directEvidenceIdentity(
      input.chapterId,
      candidate.factType,
      hashed.value,
    );
    const currentEvidenceIdentity = currentDirectEvidenceIdentity(input.versionId, deletedIdentity);
    const replacementKey = organizerReplacementKey(
      input.chapterId,
      candidate.factType,
      hashed.value,
    );
    const reference = organizerReference(
      input.chapterId,
      input.versionId,
      sourceContentHash,
      candidate,
      hashed.value,
    );
    const referenceIdentity = `${candidate.factType}\u0000${reference}`;
    if (
      existingEvidence.has(referenceIdentity) ||
      activeDirectEvidence.has(currentEvidenceIdentity) ||
      deletedEvidence.has(deletedIdentity)
    ) {
      alreadyOrganizedCount += 1;
      continue;
    }
    if (!(await directStoryFactSourceIsCurrent(dependencies, input))) {
      return staleDirectStoryFactReceipt(
        organizedCount,
        importantReviewCount,
        alreadyOrganizedCount,
      );
    }
    const observedAt = dependencies.now();
    const evidence = createEvidenceRef({
      projectId: input.projectId,
      chapterId: input.chapterId,
      immutableVersionId: input.versionId,
      sourceKind: "chapter",
      locator: {
        kind: "utf16",
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        sourceLength: input.sourceLength,
      },
      excerptDigest: hashed.value,
      sourceCreatedAt: input.versionCreatedAt,
      observedAt,
      currentness: "current",
      branchId: null,
      privacy: input.localOnly ? "local_only" : "standard",
    });
    const staged = await dependencies.factService.stageAutomaticFactWithAuthorityFence(
      {
        projectId: input.projectId,
        factType: candidate.factType,
        contentText: candidate.contentText,
        structuredValue: {
          schemaVersion: REBUILDABLE_SYSTEM_FACT_SCHEMA_VERSION,
          replacementKey,
          payload: {
            schemaVersion: ORGANIZER_SCHEMA,
            classification: candidate.kind,
            ...candidate.payload,
            evidence,
          },
        },
        source: {
          kind: "chapter_span",
          reference,
          chapterId: input.chapterId,
          versionId: input.versionId,
          startOffset: candidate.startOffset,
          endOffset: candidate.endOffset,
          sourceLength: input.sourceLength,
          excerpt: candidate.excerpt,
        },
        confidence: candidate.kind === "ordinary" ? 0.98 : 0.9,
        origin: "system",
        requireHumanReview: true,
      },
      {
        chapterId: input.chapterId,
        expectedCurrentVersionId: input.versionId,
      },
    );
    if (!staged.ok) {
      if (staged.error.code === "STORY_FACT_SOURCE_FENCE_FAILED") {
        return staleDirectStoryFactReceipt(
          organizedCount,
          importantReviewCount,
          alreadyOrganizedCount,
        );
      }
      throw staged.error;
    }
    if (staged.value.fact.toSnapshot().source.reference !== reference) {
      existingEvidence.add(referenceIdentity);
      activeDirectEvidence.add(currentEvidenceIdentity);
      alreadyOrganizedCount += 1;
      continue;
    }
    existingEvidence.add(referenceIdentity);
    activeDirectEvidence.add(currentEvidenceIdentity);
    if (candidate.kind === "ordinary") organizedCount += 1;
    else importantReviewCount += 1;
  }

  if (!(await directStoryFactSourceIsCurrent(dependencies, input))) {
    return staleDirectStoryFactReceipt(organizedCount, importantReviewCount, alreadyOrganizedCount);
  }

  const summarySourceWasCurrent = await organizeExtractiveChapterSummary(dependencies, input, {
    existingEvidence,
    activeDirectEvidence,
    deletedEvidence,
  });
  if (!summarySourceWasCurrent) {
    return staleDirectStoryFactReceipt(organizedCount, importantReviewCount, alreadyOrganizedCount);
  }

  return Object.freeze({
    organizedCount,
    importantReviewCount,
    alreadyOrganizedCount,
    sourceWasCurrent: true,
  });
}

async function directStoryFactSourceIsCurrent(
  dependencies: DirectStoryFactOrganizerDependencies,
  input: DirectStoryFactOrganizerInput,
): Promise<boolean> {
  if (input.versionId !== input.currentVersionId) return false;
  return dependencies.sourceIsCurrent === undefined || (await dependencies.sourceIsCurrent());
}

function staleDirectStoryFactReceipt(
  organizedCount = 0,
  importantReviewCount = 0,
  alreadyOrganizedCount = 0,
): DirectStoryFactOrganizerReceipt {
  return Object.freeze({
    organizedCount,
    importantReviewCount,
    alreadyOrganizedCount,
    sourceWasCurrent: false,
  });
}
function evidenceIdentity(fact: StoryFact): string {
  const snapshot = fact.toSnapshot();
  return `${snapshot.factType}\u0000${snapshot.source.reference}`;
}

function organizerReference(
  chapterId: string,
  versionId: string,
  sourceContentHash: string,
  candidate: ExtractedFact,
  excerptDigest: string,
): string {
  return `${ORGANIZER_REFERENCE_PREFIX}${chapterId}:utf16:${String(candidate.startOffset)}-${String(candidate.endOffset)}:${excerptDigest}:${candidate.factType}:${versionId}:sha256:${sourceContentHash}`;
}

function organizerReplacementKey(
  chapterId: string,
  factType: string,
  excerptDigest: string,
): string {
  return `${ORGANIZER_REFERENCE_PREFIX}${chapterId}:${factType}:sha256:${excerptDigest}`;
}

function currentDirectEvidenceIdentity(versionId: string, evidenceIdentity: string): string {
  return `${versionId}\u0000${evidenceIdentity}`;
}

function directOrganizerEvidenceIdentity(
  snapshot: ReturnType<StoryFact["toSnapshot"]>,
): string | null {
  if (snapshot.source.kind !== "chapter_span" || snapshot.source.chapterId === null) {
    return null;
  }
  const isDirectOrganizer =
    snapshot.source.reference.startsWith(ORGANIZER_REFERENCE_PREFIX) &&
    (snapshot.origin === "system" || snapshot.origin === "user");
  const structured = storyValueRecord(snapshot.structuredValue);
  const rebuildablePayload = storyValueRecord(structured?.payload);
  const generation = storyValueRecord(rebuildablePayload?.generation);
  const isLocalSummary =
    snapshot.factType === "chapter_summary" &&
    rebuildablePayload?.schemaVersion === CHAPTER_SUMMARY_PAYLOAD_SCHEMA_VERSION &&
    generation?.providerKind === LOCAL_SUMMARY_PROVIDER &&
    generation.modelId === LOCAL_SUMMARY_MODEL &&
    snapshot.origin === "system" &&
    snapshot.source.reference.startsWith("chapter-summary:");
  if (!isDirectOrganizer && !isLocalSummary) {
    return null;
  }
  const evidence = storyValueRecord(rebuildablePayload?.evidence ?? structured?.evidence);
  const excerptDigest = isLocalSummary
    ? rebuildablePayload.sourceContentHash
    : (evidence?.excerptDigest ?? directOrganizerReferenceDigest(snapshot.source.reference));
  return typeof excerptDigest === "string" && /^[a-f0-9]{64}$/u.test(excerptDigest)
    ? directEvidenceIdentity(snapshot.source.chapterId, snapshot.factType, excerptDigest)
    : null;
}

function directOrganizerReferenceDigest(reference: string): string | null {
  return (
    /^direct-local:inkshadow\.direct-local-story-fact\.v1:[^:]+:utf16:\d+-\d+:(?<digest>[a-f0-9]{64}):/u.exec(
      reference,
    )?.groups?.digest ?? null
  );
}

async function resolveSourceContentHash(
  hasher: ContentHasher,
  input: DirectStoryFactOrganizerInput,
): Promise<string> {
  const supplied = input.sourceContentHash;
  if (supplied !== undefined && !SOURCE_CONTENT_HASH_PATTERN.test(supplied)) {
    throw new Error("Direct story-fact source content hash is invalid.");
  }
  const coversCompleteVersion =
    input.acceptedStartOffset === 0 && input.acceptedText.length === input.sourceLength;
  if (!coversCompleteVersion) {
    if (supplied === undefined) {
      throw new Error("A changed-span story-fact organization requires the full version hash.");
    }
    return supplied;
  }
  const hashed = await hasher.sha256(input.acceptedText);
  if (!hashed.ok) throw hashed.error;
  if (supplied !== undefined && supplied !== hashed.value) {
    throw new Error("Direct story-fact source content hash does not match the immutable version.");
  }
  return hashed.value;
}
async function organizeExtractiveChapterSummary(
  dependencies: DirectStoryFactOrganizerDependencies,
  input: DirectStoryFactOrganizerInput,
  evidenceState: Readonly<{
    existingEvidence: Set<string>;
    activeDirectEvidence: Set<string>;
    deletedEvidence: Set<string>;
  }>,
): Promise<boolean> {
  if (
    input.acceptedStartOffset !== 0 ||
    input.acceptedText.length !== input.sourceLength ||
    input.sourceLength === 0 ||
    input.sourceLength > CHAPTER_SUMMARY_MAXIMUM_SOURCE_CHARACTERS
  ) {
    return true;
  }
  const selected = extractiveSummarySentenceRanges(input.acceptedText);
  const primary = selected[0];
  if (primary === undefined) return true;

  const sourceHashResult = await dependencies.hasher.sha256(input.acceptedText);
  if (!sourceHashResult.ok) throw sourceHashResult.error;
  if (!(await directStoryFactSourceIsCurrent(dependencies, input))) return false;
  const sourceHash = sourceHashResult.value;
  const directIdentity = directEvidenceIdentity(input.chapterId, "chapter_summary", sourceHash);
  const currentEvidenceIdentity = currentDirectEvidenceIdentity(input.versionId, directIdentity);
  const reference = `chapter-summary:${input.chapterId}:${input.versionId}:sha256:${sourceHash}`;
  const referenceIdentity = `chapter_summary\u0000${reference}`;
  if (
    evidenceState.existingEvidence.has(referenceIdentity) ||
    evidenceState.activeDirectEvidence.has(currentEvidenceIdentity) ||
    evidenceState.deletedEvidence.has(directIdentity)
  ) {
    return true;
  }

  const citations = Object.freeze(
    selected.map((sentence) =>
      Object.freeze({
        evidenceId: `chapter:${input.chapterId}:version:${input.versionId}:sha256:${sourceHash}:utf16:${String(sentence.startOffset)}-${String(sentence.endOffset)}`,
        startOffset: sentence.startOffset,
        endOffset: sentence.endOffset,
        sourceLength: input.sourceLength,
      }),
    ),
  );
  const replaced = await dependencies.factService.replaceRebuildableSystemFactWithAuthorityFence(
    {
      projectId: input.projectId,
      factType: "chapter_summary",
      replacementKey: `chapter:${input.chapterId}`,
      contentText: selected.map(({ excerpt }) => excerpt).join(" "),
      payload: {
        schemaVersion: CHAPTER_SUMMARY_PAYLOAD_SCHEMA_VERSION,
        sourceProjectId: input.projectId,
        sourceChapterId: input.chapterId,
        sourceVersionId: input.versionId,
        sourceContentHash: sourceHash,
        authorityMode: "plain_non_authoritative",
        citations,
        keyEvents: [],
        continuityNotes: [],
        generation: {
          task: CHAPTER_SUMMARY_TASK,
          providerKind: LOCAL_SUMMARY_PROVIDER,
          modelId: LOCAL_SUMMARY_MODEL,
          invocationId: input.versionId,
        },
        budget: {
          strategy: "bounded_utf16_segments",
          segmentCharacters: CHAPTER_SUMMARY_SEGMENT_CHARACTERS,
          maximumSegments: CHAPTER_SUMMARY_MAXIMUM_SEGMENTS,
          sourceCharacters: input.sourceLength,
          estimatedInputTokens: Math.max(1, Math.ceil(input.sourceLength / 4)),
          tokenEstimate: "model_hub_estimate_not_provider_tokenizer",
        },
      },
      source: {
        kind: "chapter_span",
        reference,
        chapterId: input.chapterId,
        versionId: input.versionId,
        startOffset: primary.startOffset,
        endOffset: primary.endOffset,
        sourceLength: input.sourceLength,
        excerpt: primary.excerpt,
      },
      confidence: 1,
    },
    {
      chapterId: input.chapterId,
      expectedCurrentVersionId: input.versionId,
    },
  );
  if (!replaced.ok) {
    if (replaced.error.code === "STORY_FACT_SOURCE_FENCE_FAILED") return false;
    throw replaced.error;
  }
  evidenceState.existingEvidence.add(referenceIdentity);
  evidenceState.activeDirectEvidence.add(currentEvidenceIdentity);
  return true;
}

function authoredFactIdentity(factType: string, contentText: string): string {
  return `${factType}\u0000${contentText
    .normalize("NFC")
    .trim()
    .replaceAll(/[\s。！？；，、]+/gu, "")}`;
}

function directEvidenceIdentity(
  chapterId: string,
  factType: string,
  excerptDigest: string,
): string {
  // A user's deletion is a durable tombstone for the same exact source
  // evidence, even if a later immutable version moves that sentence to another
  // UTF-16 offset. Different prose has a different digest and remains eligible.
  return `${chapterId}\u0000${factType}\u0000${excerptDigest}`;
}

function storyValueRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function extractExplicitFacts(
  content: string,
  baseOffset: number,
  confirmedFactTexts: readonly string[],
): readonly ExtractedFact[] {
  const results: ExtractedFact[] = [];
  for (const sentence of sentenceRanges(content)) {
    if (results.length >= MAXIMUM_FACTS_PER_VERSION) break;
    if (!sentence.closed) continue;
    const sentenceFactTypes = new Set<string>();
    const labeledSetting = explicitLabeledSetting(sentence.excerpt);
    if (labeledSetting !== null) {
      results.push({
        factType: labeledSetting.factType,
        contentText: labeledSetting.value,
        kind: labeledSetting.kind,
        startOffset: baseOffset + sentence.startOffset,
        endOffset: baseOffset + sentence.endOffset,
        excerpt: sentence.excerpt,
        payload: {
          kind: "explicit_labeled_setting",
          category: labeledSetting.category,
          value: labeledSetting.value,
        },
      });
      sentenceFactTypes.add(labeledSetting.factType);
      continue;
    }
    const importantType = classifyImportantSetting(sentence.excerpt, confirmedFactTexts);
    if (importantType !== null) {
      results.push({
        factType: importantType,
        contentText: sentence.excerpt,
        kind: "important",
        startOffset: baseOffset + sentence.startOffset,
        endOffset: baseOffset + sentence.endOffset,
        excerpt: sentence.excerpt,
        payload: { kind: "explicit_important_setting" },
      });
      sentenceFactTypes.add(importantType);
    }
    for (const natural of extractHighConfidenceNarrativeFacts(sentence.excerpt)) {
      if (results.length >= MAXIMUM_FACTS_PER_VERSION || sentenceFactTypes.has(natural.factType)) {
        continue;
      }
      results.push({
        ...natural,
        startOffset: baseOffset + sentence.startOffset,
        endOffset: baseOffset + sentence.endOffset,
        excerpt: sentence.excerpt,
      });
      sentenceFactTypes.add(natural.factType);
    }
    const occurrence = explicitCharacterLocationOccurrence(sentence.excerpt);
    if (
      occurrence !== null &&
      results.length < MAXIMUM_FACTS_PER_VERSION &&
      !sentenceFactTypes.has("scene_tag")
    ) {
      results.push({
        factType: "scene_tag",
        contentText: `${occurrence.character}出现在${occurrence.location}`,
        kind: "ordinary",
        startOffset: baseOffset + sentence.startOffset,
        endOffset: baseOffset + sentence.endOffset,
        excerpt: sentence.excerpt,
        payload: {
          kind: "character_location_occurrence",
          character: occurrence.character,
          location: occurrence.location,
        },
      });
    }
  }
  return Object.freeze(results);
}

const EXPLICIT_SETTING_LABELS = Object.freeze([
  {
    category: "character",
    pattern: /^(?:角色|人物)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "character_profile",
    kind: "ordinary",
  },
  {
    category: "location",
    pattern: /^(?:场景地点|地点)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "location_setting",
    kind: "ordinary",
  },
  {
    category: "relationship",
    pattern: /^(?:人物关系|关系)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "core_relationship",
    kind: "important",
  },
  {
    category: "key_item",
    pattern: /^(?:关键物品|重要物品)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "key_item",
    kind: "important",
  },
  {
    category: "organization",
    pattern: /^(?:组织势力|组织|势力)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "organization_faction",
    kind: "ordinary",
  },
  {
    category: "timeline",
    pattern: /^(?:故事时间|时间线)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "timeline_marker",
    kind: "ordinary",
  },
  {
    category: "rule",
    pattern: /^(?:世界规则|规则)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "world_rule",
    kind: "important",
  },
  {
    category: "foreshadow",
    pattern: /^(?:伏笔|暗线)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "foreshadow",
    kind: "important",
  },
  {
    category: "unresolved_question",
    pattern: /^(?:未解问题|待解问题)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "unresolved_question",
    kind: "ordinary",
  },
  {
    category: "style",
    pattern: /^(?:写作风格|风格)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "writing_style",
    kind: "ordinary",
  },
  {
    category: "goal",
    pattern: /^(?:故事目标|目标)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "story_goal",
    kind: "ordinary",
  },
  {
    category: "conflict",
    pattern: /^(?:核心冲突|冲突)(?:设定)?[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "story_conflict",
    kind: "ordinary",
  },
  {
    category: "event",
    pattern: /^(?:已发生事件|事件)[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "event_category",
    kind: "ordinary",
  },
  {
    category: "confirmed_fact",
    pattern: /^(?:已确认事实|确认事实|既定事实)[：:]\s*(?<value>[^。！？\n]{1,160})[。！？]?$/u,
    factType: "confirmed_fact",
    kind: "important",
  },
] as const);

function explicitLabeledSetting(sentence: string): Readonly<{
  category: (typeof EXPLICIT_SETTING_LABELS)[number]["category"];
  factType: string;
  kind: "ordinary" | "important";
  value: string;
}> | null {
  for (const definition of EXPLICIT_SETTING_LABELS) {
    const value = definition.pattern.exec(sentence)?.groups?.value?.trim();
    if (value !== undefined && value.length > 0) {
      return Object.freeze({
        category: definition.category,
        factType: definition.factType,
        kind: definition.kind,
        value,
      });
    }
  }
  return null;
}

function extractHighConfidenceNarrativeFacts(sentence: string): readonly NaturalNarrativeFact[] {
  const facts: NaturalNarrativeFact[] = [];
  const factTypes = new Set<string>();
  const add = (fact: NaturalNarrativeFact): void => {
    if (factTypes.has(fact.factType)) return;
    factTypes.add(fact.factType);
    facts.push(Object.freeze(fact));
  };

  const timeline =
    /^(?<marker>(?:第[一二三四五六七八九十百千万0-9]+(?:日|天|夜|年|月)(?:清晨|上午|中午|下午|傍晚|黄昏|深夜)?|[一二三四五六七八九十百千万0-9]+(?:天|年|月)前|当天|当晚|当夜|次日|翌日|清晨|正午|黄昏|深夜))[，,](?<body>[^。！？]{2,300}[。！？]?)$/u.exec(
      sentence,
    );
  const marker = timeline?.groups?.marker;
  const narrativeBody = timeline?.groups?.body?.trim() ?? sentence;
  if (marker !== undefined) {
    add({
      factType: "timeline_marker",
      contentText: sentence,
      kind: "ordinary",
      payload: {
        kind: "explicit_narrative_timeline",
        marker,
      },
    });
  }

  const confirmed =
    /^(?:事实是|可以确定|已经确认|经查明|众人确认)[：:，,\s]*(?<value>[^。！？]{2,200})[。！？]?$/u.exec(
      narrativeBody,
    )?.groups?.value;
  if (confirmed !== undefined) {
    add({
      factType: "confirmed_fact",
      contentText: confirmed,
      kind: "important",
      payload: {
        kind: "explicit_confirmed_narrative_fact",
        value: confirmed,
      },
    });
  }

  const character =
    /^(?<character>[\p{Script=Han}A-Za-z·]{2,12})(?:(?:今年(?<age>[一二三四五六七八九十百0-9]{1,3})岁)|(?:担任(?<role>[^，。！？]{2,24}))|(?:是一名(?<occupation>[^，。！？]{2,24})))[，。！？]?/u.exec(
      narrativeBody,
    );
  const expandedCharacter =
    /^(?<character>[\p{Script=Han}A-Za-z·]{2,12}?)(?:(?:今年)?(?<age>[一二三四五六七八九十百0-9]{1,3}岁)|担任(?<role>[^，。！？]{2,24})|是(?:一名)?(?<identity>[^，。！？]{2,24}))[。！？]?$/u.exec(
      narrativeBody,
    );
  const resolvedCharacter = expandedCharacter ?? character;
  const characterName = resolvedCharacter?.groups?.character;
  const characterDetail =
    resolvedCharacter?.groups?.age ??
    resolvedCharacter?.groups?.role ??
    resolvedCharacter?.groups?.occupation ??
    resolvedCharacter?.groups?.identity;
  if (
    characterName !== undefined &&
    isExplicitCharacterName(characterName) &&
    characterDetail !== undefined &&
    !isRelationshipDescription(characterDetail)
  ) {
    add({
      factType: "character_profile",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: "explicit_narrative_character_profile",
        character: characterName,
        detail: characterDetail,
      },
    });
  }

  const location =
    /^(?<location>[\p{Script=Han}A-Za-z0-9·的]{1,24}(?:城|楼|塔|村|镇|宫|港|站|岛|山|河|谷|院|厅|室|巷|街|屋|府|寺))(?<relation>位于|坐落于|坐落在|建在)(?<position>[^。！？]{1,60})[。！？]?$/u.exec(
      narrativeBody,
    );
  const locationName = location?.groups?.location;
  const position = location?.groups?.position;
  if (locationName !== undefined && position !== undefined) {
    add({
      factType: "location_setting",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: "explicit_narrative_location",
        location: locationName,
        relation: location?.groups?.relation ?? "位于",
        position,
      },
    });
  }

  const tenure =
    /^(?<character>[\p{Script=Han}A-Za-z·]{2,12})在(?<location>[\p{Script=Han}A-Za-z0-9·的这座]{1,24}?)(?<activity>守了|生活了|居住了|工作了|任职了)(?<duration>[一二三四五六七八九十百千万0-9]{1,6}(?:年|个月|月|天))[。！？]?$/u.exec(
      narrativeBody,
    );
  const tenureCharacter = tenure?.groups?.character;
  const tenureLocation = tenure?.groups?.location;
  const tenureActivity = tenure?.groups?.activity;
  const tenureDuration = tenure?.groups?.duration;
  if (
    tenureCharacter !== undefined &&
    tenureLocation !== undefined &&
    tenureActivity !== undefined &&
    tenureDuration !== undefined
  ) {
    add({
      factType: "character_profile",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: "explicit_narrative_character_tenure",
        character: tenureCharacter,
        detail: "在" + tenureLocation + tenureActivity + tenureDuration,
      },
    });
    add({
      factType: "location_setting",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: "explicit_narrative_tenure_location",
        location: tenureLocation,
        detail: tenureCharacter + tenureActivity + tenureDuration,
      },
    });
  }

  const organization =
    /^(?<member>[\p{Script=Han}A-Za-z·]{2,12})(?:已经|正式|现已)?(?<relation>加入了?|隶属于|效力于|归属于)(?<organization>[^，。！？]{2,32})[，。！？]?$/u.exec(
      narrativeBody,
    );
  const organizationName = organization?.groups?.organization;
  const member = organization?.groups?.member;
  if (organizationName !== undefined && member !== undefined) {
    add({
      factType: "organization_faction",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: "explicit_narrative_organization",
        member,
        organization: organizationName,
        relation: organization?.groups?.relation ?? "隶属于",
      },
    });
  }

  const relationship =
    /^(?<from>[\p{Script=Han}A-Za-z·]{2,12})(?:和|与)(?<to>[\p{Script=Han}A-Za-z·]{2,12})是(?<relationship>(?:多年的?)?(?:老邻居|邻居|老朋友|朋友|同事|战友|搭档|师徒|同学|恋人|夫妻))[。！？]?$/u.exec(
      narrativeBody,
    );
  const relationshipFrom = relationship?.groups?.from;
  const relationshipTo = relationship?.groups?.to;
  const relationshipType = relationship?.groups?.relationship;
  if (
    relationshipFrom !== undefined &&
    relationshipTo !== undefined &&
    relationshipType !== undefined
  ) {
    add({
      factType: "core_relationship",
      contentText: narrativeBody,
      kind: "important",
      payload: {
        kind: "explicit_narrative_relationship",
        from: relationshipFrom,
        to: relationshipTo,
        relationship: relationshipType,
      },
    });
  }

  const heldItem =
    /^(?<item>[^，。！？]{1,24}(?:钥匙|剑|刀|戒指|信件|卷轴|徽章|宝石|药剂|地图|手稿|项链|匕首|权杖|法器|令牌|印章))(?:现)?由(?<holder>[\p{Script=Han}A-Za-z·]{2,12})(?:保管|持有|看守)[，。！？]?$/u.exec(
      narrativeBody,
    ) ??
    /^(?<holder>[\p{Script=Han}A-Za-z·]{2,12})(?:持有|保管着?|拿到了|获得了)(?<item>[^，。！？]{1,24}(?:钥匙|剑|刀|戒指|信件|卷轴|徽章|宝石|药剂|地图|手稿|项链|匕首|权杖|法器|令牌|印章))[，。！？]?$/u.exec(
      narrativeBody,
    );
  const item = heldItem?.groups?.item;
  const holder = heldItem?.groups?.holder;
  if (item !== undefined && holder !== undefined) {
    add({
      factType: "key_item_ownership",
      contentText: narrativeBody,
      kind: "important",
      payload: {
        kind: "explicit_narrative_item_ownership",
        item,
        holder,
      },
    });
  }

  const motivation =
    /^(?<character>[\p{Script=Han}A-Za-z·]{2,12})为了(?<motive>[^，,。！？]{2,60})[，,](?:决定|发誓要?|计划|打算|决心|希望|想要)?(?<goal>[^。！？]{2,100})[。！？]?$/u.exec(
      narrativeBody,
    );
  const directGoal =
    /^(?<character>[\p{Script=Han}A-Za-z·]{2,12})(?:决定|发誓要?|计划|打算|决心|希望|想要)(?<goal>[^。！？]{2,120})[。！？]?$/u.exec(
      narrativeBody,
    );
  const goal = motivation?.groups?.goal ?? directGoal?.groups?.goal;
  const goalCharacter = motivation?.groups?.character ?? directGoal?.groups?.character;
  if (goal !== undefined && goalCharacter !== undefined) {
    add({
      factType: "story_goal",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: motivation === null ? "explicit_narrative_goal" : "explicit_narrative_motivation",
        character: goalCharacter,
        goal,
        ...(motivation?.groups?.motive === undefined ? {} : { motive: motivation.groups.motive }),
      },
    });
  }

  const event =
    /^(?<actor>[\p{Script=Han}A-Za-z·]{2,12})(?:终于|已经|随后|当场|亲手)?(?<action>打开了|关闭了|发现了|摧毁了|救出了|交出了|夺走了|点燃了|抵达了|离开了|签署了|宣布了|完成了|推开了|封住了|击败了|找到了)(?<object>[^。！？]{1,100})[。！？]?$/u.exec(
      narrativeBody,
    );
  const action = event?.groups?.action;
  const actor = event?.groups?.actor;
  if (action !== undefined && actor !== undefined) {
    add({
      factType: "event_category",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: "explicit_completed_narrative_event",
        actor,
        action,
        object: event?.groups?.object ?? "",
      },
    });
  }

  const stateEvent =
    /^(?<subject>[\p{Script=Han}A-Za-z0-9·的]{1,24}?)(?<action>倒转|逆转|停摆|停止|碎裂|坍塌|崩塌|熄灭|亮起|苏醒|消失|出现)(?:了)?[。！？]?$/u.exec(
      narrativeBody,
    );
  const stateSubject = stateEvent?.groups?.subject;
  const stateAction = stateEvent?.groups?.action;
  if (stateSubject !== undefined && stateAction !== undefined) {
    add({
      factType: "event_category",
      contentText: narrativeBody,
      kind: "ordinary",
      payload: {
        kind: "explicit_narrative_state_event",
        actor: stateSubject,
        action: stateAction,
        object: "",
      },
    });
  }

  return Object.freeze(facts);
}

function isRelationshipDescription(value: string): boolean {
  return /(?:的)?(?:父亲|母亲|亲生父母|兄弟|姐妹|哥哥|姐姐|弟弟|妹妹|兄长|长姐|丈夫|妻子|恋人|夫妻|邻居|老邻居|朋友|老朋友|同事|战友|搭档|师徒|同学)$/u.test(
    value,
  );
}

function isExplicitCharacterName(value: string): boolean {
  return !/(?:的|是|为|在|已|不|事实|秘密|身份|众人|所有人)/u.test(value);
}

interface SentenceRange {
  startOffset: number;
  endOffset: number;
  excerpt: string;
  closed: boolean;
}

function* sentenceRanges(content: string): Generator<Readonly<SentenceRange>, void> {
  const pattern = /[^。！？\n]+[。！？]?/gu;
  for (const match of content.matchAll(pattern)) {
    const leading = /^\s*/u.exec(match[0])?.[0].length ?? 0;
    const trailing = /\s*$/u.exec(match[0])?.[0].length ?? 0;
    const excerpt = match[0].slice(leading, match[0].length - trailing);
    if (excerpt.length === 0 || excerpt.length > 500) continue;
    yield Object.freeze({
      startOffset: match.index + leading,
      endOffset: match.index + match[0].length - trailing,
      excerpt,
      closed: /[。！？]$/u.test(excerpt) || content[match.index + match[0].length] === "\n",
    });
  }
}

function extractiveSummarySentenceRanges(content: string): readonly Readonly<SentenceRange>[] {
  let first: Readonly<SentenceRange> | null = null;
  let last: Readonly<SentenceRange> | null = null;
  for (const sentence of sentenceRanges(content)) {
    if (!sentence.closed) continue;
    first ??= sentence;
    last = sentence;
  }
  if (first === null) return Object.freeze([]);
  return Object.freeze(
    last === null || last.startOffset === first.startOffset ? [first] : [first, last],
  );
}

function isSentenceBoundary(value: string): boolean {
  return value === "。" || value === "！" || value === "？" || value === "\n";
}
function classifyImportantSetting(
  sentence: string,
  confirmedFactTexts: readonly string[],
): string | null {
  if (
    /^(?:事实是|可以确定|已经确认|经查明|众人确认)[：:，,\s]*[^。！？]{2,200}[。！？]?$/u.test(
      sentence,
    )
  ) {
    return "confirmed_fact";
  }
  if (/(?:死了|死亡|牺牲|身亡|确认死亡)/u.test(sentence)) return "character_death";
  if (/(?:真实身份|真正身份|真名(?:是|叫)|改名为)/u.test(sentence)) {
    return "character_identity";
  }
  if (
    /(?:父亲|母亲|亲生父母|兄弟|姐妹|哥哥|姐姐|弟弟|妹妹|兄长|长姐|丈夫|妻子|恋人|夫妻)/u.test(
      sentence,
    )
  ) {
    return "core_relationship";
  }
  if (/(?:世界规则|在这个世界|所有人).{0,80}(?:必须|不能|无法)/u.test(sentence)) {
    return "world_rule";
  }
  if (/(?:时间线|历史).{0,80}(?:改变|改写|重置|分裂)/u.test(sentence)) {
    return "major_timeline_change";
  }
  if (/(?:不可逆|无法挽回|永远失去|再也不能|彻底毁灭|永久封印)/u.test(sentence)) {
    return "irreversible_event";
  }
  if (/(?:秘密|真实身份|真相).{0,80}(?:得知|知晓|知道|泄露|隐瞒|忘记)/u.test(sentence)) {
    return "knowledge_boundary";
  }
  if (/(?:伏笔|暗线|预言).{0,80}(?:取消|失效|揭晓|推翻|改写|删除)/u.test(sentence)) {
    return "foreshadow_status";
  }
  if (
    /(?:推翻|否定|废除|覆盖|改写).{0,40}(?:已确认|既定|原有|此前)(?:设定|事实|规则)/u.test(sentence)
  ) {
    return "confirmed_setting_override";
  }
  if (conflictsWithConfirmedFact(sentence, confirmedFactTexts)) {
    return "confirmed_setting_conflict";
  }
  if (/(?:叙述视角|故事视角|视角).{0,40}(?:切换|改为|变为)/u.test(sentence)) {
    return "point_of_view_change";
  }
  if (/(?:设定|事实|世界规则|身份|核心关系|时间线|秘密|伏笔|暗线)/u.test(sentence)) {
    return "uncertain_major_setting";
  }
  return null;
}

function conflictsWithConfirmedFact(
  sentence: string,
  confirmedFactTexts: readonly string[],
): boolean {
  if (!/(?:并非|不是|不再|从未|已非|改为|变成|推翻|否定)/u.test(sentence)) return false;
  const normalizedSentence = normalizeConflictText(sentence);
  return confirmedFactTexts.some((factText) => {
    const normalizedFact = normalizeConflictText(factText);
    if (normalizedFact.length < 2) return false;
    if (
      normalizedSentence.includes(normalizedFact) ||
      normalizedFact.includes(normalizedSentence)
    ) {
      return true;
    }
    return sentence.includes(normalizedFact.slice(0, 2));
  });
}

function normalizeConflictText(value: string): string {
  return value
    .normalize("NFC")
    .replaceAll(/(?:并非|不是|不再|从未|已非|改为|变成|推翻|否定)/gu, "")
    .replaceAll(/[\s，。！？、；：“”‘’（）()《》]/gu, "");
}

function explicitCharacterLocationOccurrence(
  sentence: string,
): Readonly<{ character: string; location: string }> | null {
  const matched =
    /^(?<character>[\p{Script=Han}A-Za-z·]{2,12})(?:悄悄|终于|再次|独自|已经|正)?(?:来到|走进|抵达|回到|站在|坐在|停在)(?<location>[\p{Script=Han}A-Za-z0-9·的]{1,24})[，。！？]?$/u.exec(
      sentence,
    );
  const character = matched?.groups?.character;
  const location = matched?.groups?.location;
  return character === undefined || location === undefined
    ? null
    : Object.freeze({ character, location });
}

export function directStoryFactOrganizerNotice(receipt: DirectStoryFactOrganizerReceipt): string {
  if (!receipt.sourceWasCurrent) return "正文已保存；本地整理已跳过过期版本。";
  const total = receipt.organizedCount + receipt.importantReviewCount;
  if (total === 0) {
    return "正文已保存；未发现有明确原文证据的新设定。你可以用一句话添加设定。";
  }
  return `已整理 ${String(total)} 条设定`;
}
