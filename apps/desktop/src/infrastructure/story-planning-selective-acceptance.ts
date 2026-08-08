import type {
  StoryPlanningPayload,
  StoryPlanningSelectiveAcceptanceIntent,
} from "./story-planning-candidate-store";

export interface StoryPlanningSelectableItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly renderedText: string;
}

const ACCEPTED_ITEMS_HEADING = "已采纳的 AI 规划条目：";
export const STORY_PLANNING_SELECTIVE_ACCEPTANCE_RENDERER_VERSION = 1 as const;

/**
 * Converts the immutable structured provider response into stable, selectable rows.
 * The IDs are positional within that immutable response; no model or free-text parser
 * is involved when a user later accepts a subset.
 */
export function listStoryPlanningSelectableItems(
  payload: StoryPlanningPayload,
): readonly StoryPlanningSelectableItem[] {
  if (payload.task === "outline_planning") {
    return Object.freeze([
      Object.freeze({
        id: "overview",
        label: "故事方向",
        detail: payload.direction,
        renderedText: `${payload.title}\n故事方向：${payload.direction}`,
      }),
      ...payload.beats.map((beat, index) =>
        Object.freeze({
          id: `beat:${String(index)}`,
          label: `剧情节点 ${String(index + 1)}：${beat.title}`,
          detail: `目标：${beat.purpose}\n结果：${beat.outcome}`,
          renderedText: `${String(index + 1)}. ${beat.title}\n目标：${beat.purpose}\n结果：${beat.outcome}`,
        }),
      ),
      ...payload.constraintsApplied.map((constraint, index) =>
        Object.freeze({
          id: `constraint:${String(index)}`,
          label: `已遵守的设定 ${String(index + 1)}`,
          detail: constraint,
          renderedText: `已遵守的设定：${constraint}`,
        }),
      ),
      ...payload.openQuestions.map((question, index) =>
        Object.freeze({
          id: `question:${String(index)}`,
          label: `待作者决定 ${String(index + 1)}`,
          detail: question,
          renderedText: `待作者决定：${question}`,
        }),
      ),
    ]);
  }

  return Object.freeze([
    Object.freeze({
      id: "overview",
      label: "章节目标",
      detail: payload.chapterGoal,
      renderedText: `${payload.chapterTitle}\n章节目标：${payload.chapterGoal}`,
    }),
    ...payload.scenes.map((scene, index) =>
      Object.freeze({
        id: `scene:${String(index)}`,
        label: `场景 ${String(index + 1)}：${scene.title}`,
        detail: `目标：${scene.goal}\n冲突：${scene.conflict}\n结果：${scene.outcome}`,
        renderedText: `${String(index + 1)}. ${scene.title}\n目标：${scene.goal}\n冲突：${scene.conflict}\n结果：${scene.outcome}`,
      }),
    ),
    ...payload.continuityChecks.map((check, index) =>
      Object.freeze({
        id: `continuity:${String(index)}`,
        label: `连续性提醒 ${String(index + 1)}`,
        detail: check,
        renderedText: `连续性提醒：${check}`,
      }),
    ),
  ]);
}

export function canonicalizeStoryPlanningSelection(
  payload: StoryPlanningPayload,
  selectedItemIds: readonly string[],
): readonly string[] | null {
  if (selectedItemIds.length === 0 || new Set(selectedItemIds).size !== selectedItemIds.length) {
    return null;
  }
  const selected = new Set(selectedItemIds);
  const items = listStoryPlanningSelectableItems(payload);
  if (selectedItemIds.some((id) => !items.some((item) => item.id === id))) {
    return null;
  }
  return Object.freeze(items.filter((item) => selected.has(item.id)).map((item) => item.id));
}

/**
 * Frozen renderer for durable intent schema v1. Do not change its punctuation,
 * spacing, ordering, or labels: an interrupted acceptance reconstructs the exact
 * proposed synopsis through this function without persisting chapter/outline text.
 */
export function buildSelectiveStoryPlanningSynopsisV1(
  baselineSynopsis: string,
  payload: StoryPlanningPayload,
  canonicalItemIds: readonly string[],
): string {
  const selected = new Set(canonicalItemIds);
  const rendered = listStoryPlanningSelectableItems(payload)
    .filter((item) => selected.has(item.id))
    .map((item) => item.renderedText);
  const prefix = baselineSynopsis.length === 0 ? "" : `${baselineSynopsis}\n\n`;
  return `${prefix}${ACCEPTED_ITEMS_HEADING}\n${rendered.join("\n\n")}`;
}

export function buildSelectiveStoryPlanningSynopsisForIntentVersion(
  rendererVersion: number,
  baselineSynopsis: string,
  payload: StoryPlanningPayload,
  canonicalItemIds: readonly string[],
): string {
  switch (rendererVersion) {
    case 1:
      return buildSelectiveStoryPlanningSynopsisV1(baselineSynopsis, payload, canonicalItemIds);
    default:
      throw new Error(`Unsupported story planning synopsis renderer v${String(rendererVersion)}.`);
  }
}

export async function createStoryPlanningSelectiveAcceptanceIntent(
  input: Readonly<{
    selectedItemIds: readonly string[];
    baselineOutlineRevision: number;
    baselineSynopsis: string;
    proposedSynopsis: string;
    startedAt: string;
  }>,
): Promise<StoryPlanningSelectiveAcceptanceIntent> {
  const [selectionSha256, baselineSynopsisSha256, proposedSynopsisSha256] = await Promise.all([
    sha256Hex(JSON.stringify(input.selectedItemIds)),
    sha256Hex(input.baselineSynopsis),
    sha256Hex(input.proposedSynopsis),
  ]);
  return Object.freeze({
    schemaVersion: STORY_PLANNING_SELECTIVE_ACCEPTANCE_RENDERER_VERSION,
    selectedItemIds: Object.freeze([...input.selectedItemIds]),
    selectionSha256,
    baselineOutlineRevision: input.baselineOutlineRevision,
    baselineSynopsisSha256,
    proposedSynopsisSha256,
    startedAt: input.startedAt,
  });
}

export function storyPlanningSelectiveAcceptanceIntentMatches(
  actual: StoryPlanningSelectiveAcceptanceIntent,
  expected: StoryPlanningSelectiveAcceptanceIntent,
): boolean {
  return (
    actual.selectionSha256 === expected.selectionSha256 &&
    actual.baselineOutlineRevision === expected.baselineOutlineRevision &&
    actual.baselineSynopsisSha256 === expected.baselineSynopsisSha256 &&
    actual.proposedSynopsisSha256 === expected.proposedSynopsisSha256 &&
    actual.selectedItemIds.length === expected.selectedItemIds.length &&
    actual.selectedItemIds.every((id, index) => id === expected.selectedItemIds[index])
  );
}

async function sha256Hex(value: string): Promise<string> {
  const source = new TextEncoder().encode(value);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
