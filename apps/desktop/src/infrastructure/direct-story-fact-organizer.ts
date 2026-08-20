import { createEvidenceRef } from "@inkshadow/ai-core";
import type { ContentHasher } from "@inkshadow/application";
import type {
  StoryFact,
  StoryFactApplicationService,
  StoryFactStore,
  UuidV7,
} from "@inkshadow/story-core";

const ORGANIZER_SCHEMA = "inkshadow.direct-local-story-fact.v1";
const MAXIMUM_FACTS_PER_VERSION = 128;

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
  readonly currentVersionId: string;
  readonly localOnly: boolean;
}

export interface DirectStoryFactOrganizerReceipt {
  readonly organizedCount: number;
  readonly importantReviewCount: number;
  readonly alreadyOrganizedCount: number;
  readonly sourceWasCurrent: boolean;
}

interface OrganizerDependencies {
  readonly facts: Pick<StoryFactStore, "listByProjectId">;
  readonly factService: Pick<StoryFactApplicationService, "stageAutomaticFact">;
  readonly hasher: ContentHasher;
  readonly now: () => string;
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

/**
 * Conservative, deterministic extraction from an already accepted immutable
 * version. No model, gateway, route, credential, invocation or retry exists in
 * this service. Unknown prose is intentionally ignored.
 */
export async function organizeDirectStoryFacts(
  dependencies: OrganizerDependencies,
  input: DirectStoryFactOrganizerInput,
): Promise<DirectStoryFactOrganizerReceipt> {
  if (input.versionId !== input.currentVersionId) {
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
  const confirmedFactTexts: string[] = [];
  for (const fact of listed.value) {
    const snapshot = fact.toSnapshot();
    if (snapshot.status === "deprecated") continue;
    existingEvidence.add(evidenceIdentity(fact));
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
  const extracted = extractExplicitFacts(
    input.acceptedText,
    input.acceptedStartOffset,
    confirmedFactTexts,
  ).slice(0, MAXIMUM_FACTS_PER_VERSION);
  let organizedCount = 0;
  let importantReviewCount = 0;
  let alreadyOrganizedCount = 0;

  for (const candidate of extracted) {
    const hashed = await dependencies.hasher.sha256(candidate.excerpt);
    if (!hashed.ok) throw hashed.error;
    const reference = organizerReference(input.chapterId, candidate, hashed.value);
    const referenceIdentity = `${candidate.factType}\u0000${reference}`;
    if (existingEvidence.has(referenceIdentity)) {
      alreadyOrganizedCount += 1;
      continue;
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
    const staged = await dependencies.factService.stageAutomaticFact({
      projectId: input.projectId,
      factType: candidate.factType,
      contentText: candidate.contentText,
      structuredValue: {
        schemaVersion: ORGANIZER_SCHEMA,
        classification: candidate.kind,
        ...candidate.payload,
        evidence,
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
    });
    if (!staged.ok) throw staged.error;
    existingEvidence.add(referenceIdentity);
    if (candidate.kind === "ordinary") organizedCount += 1;
    else importantReviewCount += 1;
  }

  return Object.freeze({
    organizedCount,
    importantReviewCount,
    alreadyOrganizedCount,
    sourceWasCurrent: true,
  });
}

function evidenceIdentity(fact: StoryFact): string {
  const snapshot = fact.toSnapshot();
  return `${snapshot.factType}\u0000${snapshot.source.reference}`;
}

function organizerReference(
  chapterId: string,
  candidate: ExtractedFact,
  excerptDigest: string,
): string {
  return `direct-local:${ORGANIZER_SCHEMA}:${chapterId}:utf16:${String(candidate.startOffset)}-${String(candidate.endOffset)}:${excerptDigest}:${candidate.factType}`;
}

function extractExplicitFacts(
  content: string,
  baseOffset: number,
  confirmedFactTexts: readonly string[],
): readonly ExtractedFact[] {
  const results: ExtractedFact[] = [];
  for (const sentence of sentenceRanges(content)) {
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
      continue;
    }
    const occurrence = explicitCharacterLocationOccurrence(sentence.excerpt);
    if (occurrence !== null) {
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

function sentenceRanges(content: string): readonly Readonly<{
  startOffset: number;
  endOffset: number;
  excerpt: string;
}>[] {
  const ranges: { startOffset: number; endOffset: number; excerpt: string }[] = [];
  const pattern = /[^。！？\n]+[。！？]?/gu;
  for (const match of content.matchAll(pattern)) {
    const leading = /^\s*/u.exec(match[0])?.[0].length ?? 0;
    const trailing = /\s*$/u.exec(match[0])?.[0].length ?? 0;
    const excerpt = match[0].slice(leading, match[0].length - trailing);
    if (excerpt.length === 0 || excerpt.length > 500) continue;
    ranges.push({
      startOffset: match.index + leading,
      endOffset: match.index + match[0].length - trailing,
      excerpt,
    });
  }
  return Object.freeze(ranges);
}

function classifyImportantSetting(
  sentence: string,
  confirmedFactTexts: readonly string[],
): string | null {
  if (/(?:死了|死亡|牺牲|身亡|确认死亡)/u.test(sentence)) return "character_death";
  if (/(?:真实身份|真正身份|真名(?:是|叫)|改名为)/u.test(sentence)) {
    return "character_identity";
  }
  if (/(?:父亲|母亲|亲生父母|兄弟|姐妹|丈夫|妻子|恋人|夫妻)/u.test(sentence)) {
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
  if (receipt.importantReviewCount > 0) {
    return `已整理 ${String(receipt.organizedCount)} 条；有 ${String(receipt.importantReviewCount)} 条重要设定需要你确认。`;
  }
  return `已整理 ${String(receipt.organizedCount)} 条`;
}
