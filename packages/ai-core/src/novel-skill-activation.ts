import { NovelSkillError } from "./novel-skill.js";

export const NOVEL_SKILL_RECOMMENDABLE_GENRES = [
  "campus_romance",
  "light_novel",
  "mystery",
  "fantasy",
  "web_serial",
] as const;

export type NovelSkillRecommendableGenre = (typeof NOVEL_SKILL_RECOMMENDABLE_GENRES)[number];
export type NovelSkillGenreDefinitionId = `genre.${NovelSkillRecommendableGenre}`;
export type NovelSkillSeedEvidenceField =
  "premise" | "genre" | "tone" | "style" | "currentDirection";

export interface NovelSkillProjectSeedFieldView {
  readonly values: readonly string[];
  readonly source:
    | "user_input"
    | "imported_text"
    | "import_analysis"
    | "professional_setup"
    | "ai_inference"
    | null;
  readonly confirmation: "confirmed" | "unconfirmed" | "skipped";
}

/** Structural view deliberately accepts ProjectSeed without importing Domain into AI Core. */
export interface NovelSkillProjectSeedView {
  readonly premise: NovelSkillProjectSeedFieldView;
  readonly genre: NovelSkillProjectSeedFieldView;
  readonly tone: NovelSkillProjectSeedFieldView;
  readonly style: NovelSkillProjectSeedFieldView;
  readonly currentDirection: NovelSkillProjectSeedFieldView;
}

export interface NovelSkillRecommendationEvidence {
  readonly field: NovelSkillSeedEvidenceField;
  readonly value: string;
  readonly source: NonNullable<NovelSkillProjectSeedFieldView["source"]>;
  readonly confirmation: Exclude<NovelSkillProjectSeedFieldView["confirmation"], "skipped">;
  readonly matchedSignal: string;
}

export interface NovelSkillActivationRecommendation {
  readonly skillId: NovelSkillGenreDefinitionId;
  readonly genreTag: NovelSkillRecommendableGenre;
  readonly displayName: string;
  readonly effect: "recommendation_only";
  readonly confidence: "confirmed_signal" | "tentative_signal";
  readonly requiresAuthorConfirmation: true;
  readonly reason: string;
  readonly evidence: readonly NovelSkillRecommendationEvidence[];
}

export interface NovelSkillActivationProjection {
  readonly schemaVersion: 1;
  readonly source: "project_seed";
  readonly automaticBindingAllowed: false;
  readonly recommendations: readonly NovelSkillActivationRecommendation[];
}

interface SeedEntry {
  readonly field: NovelSkillSeedEvidenceField;
  readonly value: string;
  readonly normalized: string;
  readonly source: NonNullable<NovelSkillProjectSeedFieldView["source"]>;
  readonly confirmation: Exclude<NovelSkillProjectSeedFieldView["confirmation"], "skipped">;
}

interface GenreRecommendationRule {
  readonly genreTag: NovelSkillRecommendableGenre;
  readonly displayName: string;
  readonly anySignals: readonly string[];
  readonly allSignalGroups: readonly (readonly string[])[];
}

const SEED_FIELDS: readonly NovelSkillSeedEvidenceField[] = [
  "genre",
  "premise",
  "tone",
  "style",
  "currentDirection",
];

const FIELD_LABELS: Readonly<Record<NovelSkillSeedEvidenceField, string>> = {
  premise: "故事想法",
  genre: "题材",
  tone: "基调",
  style: "风格",
  currentDirection: "当前方向",
};

const RECOMMENDATION_RULES: readonly GenreRecommendationRule[] = [
  {
    genreTag: "campus_romance",
    displayName: "校园青春恋爱",
    anySignals: ["校园恋爱", "青春恋爱", "campus romance", "school romance"],
    allSignalGroups: [
      ["校园", "恋"],
      ["学校", "恋"],
      ["campus", "romance"],
      ["school", "romance"],
    ],
  },
  {
    genreTag: "light_novel",
    displayName: "轻小说节奏",
    anySignals: ["轻小说", "輕小說", "light novel", "日系轻文"],
    allSignalGroups: [],
  },
  {
    genreTag: "mystery",
    displayName: "悬疑与推理",
    anySignals: ["悬疑", "懸疑", "推理", "侦探", "偵探", "mystery", "detective"],
    allSignalGroups: [],
  },
  {
    genreTag: "fantasy",
    displayName: "奇幻规则与代价",
    anySignals: ["奇幻", "玄幻", "仙侠", "魔法", "fantasy", "xianxia"],
    allSignalGroups: [],
  },
  {
    genreTag: "web_serial",
    displayName: "网络连载推进",
    anySignals: ["网文", "網文", "网络小说", "網絡小說", "连载", "連載", "web novel", "web serial"],
    allSignalGroups: [],
  },
] as const;

/**
 * Produces an explainable suggestion projection only. It never creates a
 * ProjectNovelSkillBinding, changes defaults, or marks a method as enabled.
 */
export function projectNovelSkillRecommendationsFromSeed(
  seed: NovelSkillProjectSeedView,
): NovelSkillActivationProjection {
  const entries = collectSeedEntries(seed);
  const recommendations = RECOMMENDATION_RULES.flatMap((rule) => {
    const evidence = matchRuleEvidence(entries, rule);
    if (evidence.length === 0) {
      return [];
    }
    const fieldLabels = [...new Set(evidence.map(({ field }) => FIELD_LABELS[field]))].join("、");
    const recommendation: NovelSkillActivationRecommendation = Object.freeze({
      skillId: `genre.${rule.genreTag}`,
      genreTag: rule.genreTag,
      displayName: rule.displayName,
      effect: "recommendation_only",
      confidence: evidence.some(({ confirmation }) => confirmation === "confirmed")
        ? "confirmed_signal"
        : "tentative_signal",
      requiresAuthorConfirmation: true,
      reason: `ProjectSeed 的${fieldLabels}出现了与“${rule.displayName}”相关的信号；这只是一项待作者确认的写作方法建议。`,
      evidence: Object.freeze(evidence),
    });
    return [recommendation];
  });

  return Object.freeze({
    schemaVersion: 1,
    source: "project_seed",
    automaticBindingAllowed: false,
    recommendations: Object.freeze(recommendations),
  });
}

function collectSeedEntries(seedValue: unknown): readonly SeedEntry[] {
  if (
    seedValue === null ||
    typeof seedValue !== "object" ||
    Array.isArray(seedValue) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(seedValue) as object | null)
  ) {
    throw invalidSeed("ProjectSeed recommendation input must be a plain object.");
  }
  const seed = seedValue as unknown as Record<string, unknown>;
  const entries: SeedEntry[] = [];
  for (const field of SEED_FIELDS) {
    const fieldValue = seed[field];
    if (
      fieldValue === null ||
      typeof fieldValue !== "object" ||
      Array.isArray(fieldValue) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(fieldValue) as object | null)
    ) {
      throw invalidSeed(`ProjectSeed ${field} must be a plain field object.`);
    }
    const candidate = fieldValue as Record<string, unknown>;
    const valuesValue = candidate.values;
    const confirmation = candidate.confirmation;
    const source = candidate.source;
    if (
      !Array.isArray(valuesValue) ||
      valuesValue.length > 32 ||
      !isSeedConfirmation(confirmation) ||
      !isSeedSourceOrNull(source) ||
      (confirmation === "skipped" && valuesValue.length !== 0) ||
      (confirmation !== "skipped" && valuesValue.length > 0 && source === null)
    ) {
      throw invalidSeed(`ProjectSeed ${field} is not valid recommendation evidence.`);
    }
    for (const value of valuesValue as readonly unknown[]) {
      if (
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 1_000 ||
        value !== value.trim() ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
      ) {
        throw invalidSeed(`ProjectSeed ${field} contains invalid text.`);
      }
      if (confirmation !== "skipped" && source !== null) {
        entries.push({
          field,
          value,
          normalized: normalizeSignalText(value),
          source,
          confirmation,
        });
      }
    }
  }
  return entries;
}

function matchRuleEvidence(
  entries: readonly SeedEntry[],
  rule: GenreRecommendationRule,
): NovelSkillRecommendationEvidence[] {
  const direct = entries.flatMap((entry) => {
    const signal = rule.anySignals.find((candidate) => entry.normalized.includes(candidate));
    return signal === undefined ? [] : [toEvidence(entry, signal)];
  });
  if (direct.length > 0) {
    return deduplicateEvidence(direct);
  }
  for (const signalGroup of rule.allSignalGroups) {
    if (
      !signalGroup.every((signal) => entries.some(({ normalized }) => normalized.includes(signal)))
    ) {
      continue;
    }
    const grouped = entries.flatMap((entry) => {
      const signal = signalGroup.find((candidate) => entry.normalized.includes(candidate));
      return signal === undefined ? [] : [toEvidence(entry, signal)];
    });
    return deduplicateEvidence(grouped);
  }
  return [];
}

function toEvidence(entry: SeedEntry, matchedSignal: string): NovelSkillRecommendationEvidence {
  return Object.freeze({
    field: entry.field,
    value: entry.value,
    source: entry.source,
    confirmation: entry.confirmation,
    matchedSignal,
  });
}

function deduplicateEvidence(
  values: readonly NovelSkillRecommendationEvidence[],
): NovelSkillRecommendationEvidence[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.field}\u0000${value.value}\u0000${value.matchedSignal}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeSignalText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function isSeedConfirmation(
  value: unknown,
): value is NovelSkillProjectSeedFieldView["confirmation"] {
  return value === "confirmed" || value === "unconfirmed" || value === "skipped";
}

function isSeedSourceOrNull(value: unknown): value is NovelSkillProjectSeedFieldView["source"] {
  return (
    value === null ||
    value === "user_input" ||
    value === "imported_text" ||
    value === "import_analysis" ||
    value === "professional_setup" ||
    value === "ai_inference"
  );
}

function invalidSeed(message: string): NovelSkillError {
  return new NovelSkillError("NOVEL_SKILL_INVALID", message);
}
