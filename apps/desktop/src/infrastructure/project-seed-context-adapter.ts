import {
  PROJECT_SEED_FIELD_KEYS,
  type ProjectSeedFieldKey,
  type ProjectSeedRecord,
} from "@inkshadow/domain";
import type { ContextCandidate, ContextEvidenceSourceType, ContextLayer } from "@inkshadow/ai-core";

const FIELD_LAYERS: Readonly<Record<ProjectSeedFieldKey, ContextLayer>> = {
  premise: "world_setting",
  genre: "current_task",
  tone: "current_task",
  characters: "character_current_state",
  relationships: "character_current_state",
  world: "world_setting",
  conflict: "scene_goal",
  style: "current_task",
  pov: "current_task",
  boundaries: "locked_hard_rules",
  currentDirection: "scene_goal",
  initialOutline: "scene_goal",
  rewriteRules: "current_task",
};

const FIELD_LABELS: Readonly<Record<ProjectSeedFieldKey, string>> = {
  premise: "创作起点",
  genre: "小说类型",
  tone: "故事基调",
  characters: "人物",
  relationships: "人物关系",
  world: "世界背景",
  conflict: "核心冲突",
  style: "写作风格",
  pov: "叙事视角",
  boundaries: "作者明确禁止项",
  currentDirection: "当前剧情方向",
  initialOutline: "初步大纲",
  rewriteRules: "改写规则",
};

/**
 * Converts only author-confirmed creation inputs into generation context.
 * Imported analysis and AI inference remain excluded until the author confirms
 * them; ProjectSeed never silently promotes them into formal story truth.
 */
export function selectProjectSeedContextCandidates(
  record: ProjectSeedRecord | null,
): readonly ContextCandidate[] {
  if (record === null) {
    return Object.freeze([]);
  }
  const candidates: ContextCandidate[] = [];
  for (const key of PROJECT_SEED_FIELD_KEYS) {
    const field = record.seed[key];
    if (field.confirmation !== "confirmed" || field.values.length === 0) {
      continue;
    }
    // Professional creation persists POV/style in ProjectSeed for recovery and
    // separately exposes them through the editable writing-preference system.
    // The dedicated preference is the generation source, so do not send the
    // same instruction twice from this recovery record.
    if ((key === "pov" || key === "style") && field.source === "professional_setup") {
      continue;
    }
    const layer = FIELD_LAYERS[key];
    const sourceType: ContextEvidenceSourceType =
      key === "boundaries"
        ? "story_rule"
        : field.source === "imported_text" || field.source === "import_analysis"
          ? "import"
          : "user_input";
    candidates.push(
      Object.freeze({
        id: `project-seed:${record.projectId}:${key}:r${String(record.revision)}`,
        layer,
        content: renderField(key, field.values),
        selectionReason:
          key === "boundaries"
            ? "The author explicitly confirmed these prohibitions, so they are required constraints."
            : `The author confirmed this ${key} creation input; it remains traceable to the project seed.`,
        evidence: Object.freeze([
          Object.freeze({
            sourceType,
            sourceId: record.projectId,
            sourceVersionId: `seed-r${String(record.revision)}`,
            locator: `project-seed:${key}`,
            contentHash: null,
            excerpt: null,
          }),
        ]),
        priority: key === "boundaries" ? 1_000 : key === "currentDirection" ? 900 : 700,
        relevanceScore: 1,
      }),
    );
  }
  return Object.freeze(candidates);
}

function renderField(key: ProjectSeedFieldKey, values: readonly string[]): string {
  return [`[用户已确认的${FIELD_LABELS[key]}]`, ...values.map((value) => `- ${value}`)].join("\n");
}
