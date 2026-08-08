import type { SqlExecutor } from "@inkshadow/data";

import { MODEL_PROVIDER_KINDS, type ModelProviderKind } from "./model-hub-provider-registry";

export const STORY_PLANNING_TASKS = ["outline_planning", "scene_breakdown"] as const;
export type StoryPlanningTask = (typeof STORY_PLANNING_TASKS)[number];

export type StoryPlanningCandidateStatus = "review" | "accepted" | "rejected";

export interface OutlinePlanningBeat {
  readonly title: string;
  readonly purpose: string;
  readonly outcome: string;
}

export interface OutlinePlanningPayload {
  readonly schemaVersion: 1;
  readonly task: "outline_planning";
  readonly title: string;
  readonly direction: string;
  readonly beats: readonly OutlinePlanningBeat[];
  readonly constraintsApplied: readonly string[];
  readonly openQuestions: readonly string[];
}

export interface ScenePlanningItem {
  readonly title: string;
  readonly goal: string;
  readonly conflict: string;
  readonly outcome: string;
}

export interface SceneBreakdownPayload {
  readonly schemaVersion: 1;
  readonly task: "scene_breakdown";
  readonly chapterTitle: string;
  readonly chapterGoal: string;
  readonly scenes: readonly ScenePlanningItem[];
  readonly continuityChecks: readonly string[];
}

export type StoryPlanningPayload = OutlinePlanningPayload | SceneBreakdownPayload;

export interface StoryPlanningContextReceipt {
  readonly formalFactIds: readonly string[];
  readonly lockedFactIds: readonly string[];
  readonly causalEventIds: readonly string[];
  readonly causalGraphStatus: "available" | "empty" | "unavailable";
}

export interface StoryPlanningSelectiveAcceptanceIntent {
  /** Also selects the permanently retained synopsis renderer v1. */
  readonly schemaVersion: 1;
  readonly selectedItemIds: readonly string[];
  readonly selectionSha256: string;
  readonly baselineOutlineRevision: number;
  readonly baselineSynopsisSha256: string;
  readonly proposedSynopsisSha256: string;
  readonly startedAt: string;
}

export interface StoryPlanningCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly task: StoryPlanningTask;
  readonly targetNodeId: string;
  readonly targetNodeTitle: string;
  readonly baselineOutlineRevision: number;
  /** Exact target synopsis used for a safe diff. Legacy candidates omit it. */
  readonly baselineTargetSynopsis?: string | null;
  readonly status: StoryPlanningCandidateStatus;
  readonly payload: StoryPlanningPayload;
  readonly editableSynopsis: string;
  readonly context: StoryPlanningContextReceipt;
  readonly invocationId: string;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderKind;
  readonly modelId: string;
  readonly usedFallback: boolean;
  readonly acceptedOutlineRevision: number | null;
  /** Stable immutable payload rows chosen by selective acceptance; whole acceptance is null. */
  readonly acceptedItemIds?: readonly string[] | null;
  /** Durable reservation written before selective acceptance mutates the outline. */
  readonly selectiveAcceptanceIntent?: StoryPlanningSelectiveAcceptanceIntent | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

export interface StoryPlanningCandidateStore {
  create(candidate: StoryPlanningCandidate): Promise<void>;
  findById(candidateId: string): Promise<StoryPlanningCandidate | null>;
  listByProjectId(projectId: string, limit?: number): Promise<readonly StoryPlanningCandidate[]>;
  updateEditableSynopsis(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      editableSynopsis: string;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate>;
  decide(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      decision: "accepted" | "rejected";
      acceptedOutlineRevision: number | null;
      acceptedItemIds?: readonly string[] | null;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate>;
  beginSelectiveAcceptance(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      intent: StoryPlanningSelectiveAcceptanceIntent;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate>;
  finalizeSelectiveAcceptance(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      intent: StoryPlanningSelectiveAcceptanceIntent;
      acceptedOutlineRevision: number;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate>;
}

export type StoryPlanningCandidateStoreErrorCode =
  | "STORY_PLANNING_CANDIDATE_INVALID"
  | "STORY_PLANNING_CANDIDATE_CONFLICT"
  | "STORY_PLANNING_CANDIDATE_NOT_FOUND"
  | "STORY_PLANNING_CANDIDATE_CORRUPT"
  | "STORY_PLANNING_CANDIDATE_UNAVAILABLE";

export class StoryPlanningCandidateStoreError extends Error {
  public constructor(
    readonly code: StoryPlanningCandidateStoreErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "StoryPlanningCandidateStoreError";
  }
}

interface CandidateRow {
  readonly id: string;
  readonly projectId: string;
  readonly task: string;
  readonly targetNodeId: string;
  readonly targetNodeTitle: string;
  readonly baselineOutlineRevision: number;
  readonly baselineTargetSynopsis: string | null;
  readonly status: string;
  readonly payloadJson: string;
  readonly editableSynopsis: string;
  readonly contextJson: string;
  readonly invocationId: string;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: string;
  readonly modelId: string;
  readonly usedFallback: number;
  readonly acceptedOutlineRevision: number | null;
  readonly acceptedSelectionJson: string | null;
  readonly selectiveAcceptanceIntentJson: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

interface BrowserCandidateDatabase {
  readonly schemaVersion: 1;
  readonly candidates: Record<string, StoryPlanningCandidate>;
}

const DEVELOPMENT_KEY = "inkshadow.development.story-planning-candidates.v1";
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MAXIMUM_CANDIDATE_LIMIT = 100;

export class SqliteStoryPlanningCandidateStore implements StoryPlanningCandidateStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async create(candidateValue: StoryPlanningCandidate): Promise<void> {
    const candidate = normalizeCandidate(candidateValue);
    try {
      await this.executor.execute(
        `INSERT INTO story_planning_candidates (
           id, project_id, task, target_node_id, target_node_title,
           baseline_outline_revision, baseline_target_synopsis, status, payload_json, editable_synopsis,
           context_json, invocation_id, connection_id, catalog_entry_id,
           provider_kind, model_id, used_fallback, accepted_outline_revision,
           accepted_selection_json, selective_acceptance_intent_json,
           revision, created_at, updated_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidateBindings(candidate),
      );
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法保存 AI 规划建议版本。");
    }
  }

  public async findById(candidateIdValue: string): Promise<StoryPlanningCandidate | null> {
    const candidateId = validateIdentifier(candidateIdValue, "规划建议编号", 128, true);
    try {
      const rows = await this.executor.select<CandidateRow>(
        `${CANDIDATE_SELECT} WHERE id = ? LIMIT 1`,
        [candidateId],
      );
      return rows[0] === undefined ? null : candidateFromRow(rows[0]);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法读取 AI 规划建议版本。");
    }
  }

  public async listByProjectId(
    projectIdValue: string,
    limitValue = 20,
  ): Promise<readonly StoryPlanningCandidate[]> {
    const projectId = validateIdentifier(projectIdValue, "项目编号", 128, true);
    const limit = validateLimit(limitValue);
    try {
      const rows = await this.executor.select<CandidateRow>(
        `${CANDIDATE_SELECT}
         WHERE project_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [projectId, limit],
      );
      return Object.freeze(rows.map(candidateFromRow));
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法读取项目的 AI 规划建议版本。");
    }
  }

  public async updateEditableSynopsis(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      editableSynopsis: string;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    const candidateId = validateIdentifier(input.candidateId, "规划建议编号", 128, true);
    const expectedRevision = validateRevision(input.expectedRevision);
    const editableSynopsis = validateText(input.editableSynopsis, 1, 20_000, "可采纳内容");
    const now = validateTimestamp(input.now);
    try {
      const updated = await this.executor.execute(
        `UPDATE story_planning_candidates
         SET editable_synopsis = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'review'
           AND selective_acceptance_intent_json IS NULL
           AND revision = ?`,
        [editableSynopsis, now, candidateId, expectedRevision],
      );
      if (updated.rowsAffected !== 1) {
        throw conflict("规划建议已在其他位置修改、处理或删除，请刷新后重试。");
      }
      return await this.requireById(candidateId);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法保存规划建议的编辑内容。");
    }
  }

  public async decide(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      decision: "accepted" | "rejected";
      acceptedOutlineRevision: number | null;
      acceptedItemIds?: readonly string[] | null;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    const candidateId = validateIdentifier(input.candidateId, "规划建议编号", 128, true);
    const expectedRevision = validateRevision(input.expectedRevision);
    const now = validateTimestamp(input.now);
    const acceptedItemIds = normalizeAcceptedItemIds(input.acceptedItemIds ?? null);
    if (
      (input.decision === "accepted" &&
        (!Number.isSafeInteger(input.acceptedOutlineRevision) ||
          (input.acceptedOutlineRevision ?? 0) < 1)) ||
      (input.decision === "rejected" &&
        (input.acceptedOutlineRevision !== null || acceptedItemIds !== null))
    ) {
      throw invalid("规划建议的处理结果无效。");
    }
    try {
      if (acceptedItemIds !== null) {
        const current = await this.requireById(candidateId);
        if (!itemIdsMatchImmutablePayload(current.payload, acceptedItemIds)) {
          throw invalid("部分采纳条目与不可变候选内容不一致。");
        }
      }
      const updated = await this.executor.execute(
        `UPDATE story_planning_candidates
         SET status = ?, accepted_outline_revision = ?, accepted_selection_json = ?,
             revision = revision + 1,
             updated_at = ?, decided_at = ?
         WHERE id = ? AND status = 'review'
           AND selective_acceptance_intent_json IS NULL
           AND revision = ?`,
        [
          input.decision,
          input.acceptedOutlineRevision,
          acceptedItemIds === null ? null : JSON.stringify(acceptedItemIds),
          now,
          now,
          candidateId,
          expectedRevision,
        ],
      );
      if (updated.rowsAffected !== 1) {
        throw conflict("规划建议已在其他位置修改、处理或删除，请刷新后重试。");
      }
      return await this.requireById(candidateId);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法记录规划建议的处理结果。");
    }
  }

  public async beginSelectiveAcceptance(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      intent: StoryPlanningSelectiveAcceptanceIntent;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    const candidateId = validateIdentifier(input.candidateId, "规划建议编号", 128, true);
    const expectedRevision = validateRevision(input.expectedRevision);
    const now = validateTimestamp(input.now);
    try {
      const current = await this.requireById(candidateId);
      if (
        current.status !== "review" ||
        current.selectiveAcceptanceIntent !== null ||
        current.revision !== expectedRevision
      ) {
        throw conflict("规划建议已在其他位置修改或处理，请刷新后重试。");
      }
      const intent = normalizeSelectiveAcceptanceIntentForCandidate(input.intent, current);
      const updated = await this.executor.execute(
        `UPDATE story_planning_candidates
         SET selective_acceptance_intent_json = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'review'
           AND selective_acceptance_intent_json IS NULL
           AND revision = ?`,
        [JSON.stringify(intent), now, candidateId, expectedRevision],
      );
      if (updated.rowsAffected !== 1) {
        throw conflict("规划建议已在其他位置修改或处理，请刷新后重试。");
      }
      return await this.requireById(candidateId);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法锁定这次逐项采纳操作。");
    }
  }

  public async finalizeSelectiveAcceptance(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      intent: StoryPlanningSelectiveAcceptanceIntent;
      acceptedOutlineRevision: number;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    const candidateId = validateIdentifier(input.candidateId, "规划建议编号", 128, true);
    const expectedRevision = validateRevision(input.expectedRevision);
    const acceptedOutlineRevision = validateRevision(input.acceptedOutlineRevision);
    const intent = normalizeSelectiveAcceptanceIntent(input.intent);
    const serializedIntent = JSON.stringify(intent);
    const now = validateTimestamp(input.now);
    try {
      const updated = await this.executor.execute(
        `UPDATE story_planning_candidates
         SET status = 'accepted', accepted_outline_revision = ?,
             accepted_selection_json = json_extract(selective_acceptance_intent_json, '$.selectedItemIds'),
             selective_acceptance_intent_json = NULL,
             revision = revision + 1, updated_at = ?, decided_at = ?
         WHERE id = ? AND status = 'review' AND revision = ?
           AND selective_acceptance_intent_json = ?`,
        [acceptedOutlineRevision, now, now, candidateId, expectedRevision, serializedIntent],
      );
      if (updated.rowsAffected !== 1) {
        throw conflict("逐项采纳状态已发生变化，请刷新后重试。");
      }
      return await this.requireById(candidateId);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法完成逐项采纳记录。");
    }
  }

  private async requireById(candidateId: string): Promise<StoryPlanningCandidate> {
    const rows = await this.executor.select<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE id = ? LIMIT 1`,
      [candidateId],
    );
    if (rows[0] === undefined) {
      throw notFound();
    }
    return candidateFromRow(rows[0]);
  }
}

export class BrowserDevelopmentStoryPlanningCandidateStore implements StoryPlanningCandidateStore {
  public constructor(private readonly storage: Storage) {}

  public async create(candidateValue: StoryPlanningCandidate): Promise<void> {
    await Promise.resolve();
    const candidate = normalizeCandidate(candidateValue);
    const database = this.read();
    if (database.candidates[candidate.id] !== undefined) {
      throw conflict("这个规划建议版本已经存在。");
    }
    this.write({
      schemaVersion: 1,
      candidates: { ...database.candidates, [candidate.id]: candidate },
    });
  }

  public async findById(candidateIdValue: string): Promise<StoryPlanningCandidate | null> {
    await Promise.resolve();
    const candidateId = validateIdentifier(candidateIdValue, "规划建议编号", 128, true);
    const candidate = this.read().candidates[candidateId];
    return candidate === undefined ? null : normalizeCandidate(candidate);
  }

  public async listByProjectId(
    projectIdValue: string,
    limitValue = 20,
  ): Promise<readonly StoryPlanningCandidate[]> {
    await Promise.resolve();
    const projectId = validateIdentifier(projectIdValue, "项目编号", 128, true);
    const limit = validateLimit(limitValue);
    return Object.freeze(
      Object.values(this.read().candidates)
        .map(normalizeCandidate)
        .filter((candidate) => candidate.projectId === projectId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        )
        .slice(0, limit),
    );
  }

  public async updateEditableSynopsis(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      editableSynopsis: string;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    await Promise.resolve();
    const candidate = this.requireReviewCandidate(input.candidateId, input.expectedRevision);
    const next = normalizeCandidate({
      ...candidate,
      editableSynopsis: validateText(input.editableSynopsis, 1, 20_000, "可采纳内容"),
      revision: candidate.revision + 1,
      updatedAt: validateTimestamp(input.now),
    });
    this.replace(next);
    return next;
  }

  public async decide(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      decision: "accepted" | "rejected";
      acceptedOutlineRevision: number | null;
      acceptedItemIds?: readonly string[] | null;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    await Promise.resolve();
    const candidate = this.requireReviewCandidate(input.candidateId, input.expectedRevision);
    const acceptedItemIds = normalizeAcceptedItemIds(input.acceptedItemIds ?? null);
    if (
      (input.decision === "accepted" &&
        (!Number.isSafeInteger(input.acceptedOutlineRevision) ||
          (input.acceptedOutlineRevision ?? 0) < 1)) ||
      (input.decision === "rejected" &&
        (input.acceptedOutlineRevision !== null || acceptedItemIds !== null))
    ) {
      throw invalid("规划建议的处理结果无效。");
    }
    if (
      acceptedItemIds !== null &&
      !itemIdsMatchImmutablePayload(candidate.payload, acceptedItemIds)
    ) {
      throw invalid("部分采纳条目与不可变候选内容不一致。");
    }
    const now = validateTimestamp(input.now);
    const next = normalizeCandidate({
      ...candidate,
      status: input.decision,
      acceptedOutlineRevision: input.acceptedOutlineRevision,
      acceptedItemIds,
      revision: candidate.revision + 1,
      updatedAt: now,
      decidedAt: now,
    });
    this.replace(next);
    return next;
  }

  public async beginSelectiveAcceptance(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      intent: StoryPlanningSelectiveAcceptanceIntent;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    await Promise.resolve();
    const candidate = this.requireReviewCandidate(input.candidateId, input.expectedRevision);
    const intent = normalizeSelectiveAcceptanceIntentForCandidate(input.intent, candidate);
    const next = normalizeCandidate({
      ...candidate,
      selectiveAcceptanceIntent: intent,
      revision: candidate.revision + 1,
      updatedAt: validateTimestamp(input.now),
    });
    this.replace(next);
    return next;
  }

  public async finalizeSelectiveAcceptance(
    input: Readonly<{
      candidateId: string;
      expectedRevision: number;
      intent: StoryPlanningSelectiveAcceptanceIntent;
      acceptedOutlineRevision: number;
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    await Promise.resolve();
    const candidate = this.requireApplyingCandidate(
      input.candidateId,
      input.expectedRevision,
      input.intent,
    );
    const now = validateTimestamp(input.now);
    const next = normalizeCandidate({
      ...candidate,
      status: "accepted",
      acceptedOutlineRevision: validateRevision(input.acceptedOutlineRevision),
      acceptedItemIds: candidate.selectiveAcceptanceIntent?.selectedItemIds ?? null,
      selectiveAcceptanceIntent: null,
      revision: candidate.revision + 1,
      updatedAt: now,
      decidedAt: now,
    });
    this.replace(next);
    return next;
  }

  private requireReviewCandidate(candidateIdValue: string, expectedRevisionValue: number) {
    const candidateId = validateIdentifier(candidateIdValue, "规划建议编号", 128, true);
    const expectedRevision = validateRevision(expectedRevisionValue);
    const candidate = this.read().candidates[candidateId];
    if (candidate === undefined) {
      throw notFound();
    }
    const normalized = normalizeCandidate(candidate);
    if (
      normalized.status !== "review" ||
      normalized.selectiveAcceptanceIntent !== null ||
      normalized.revision !== expectedRevision
    ) {
      throw conflict("规划建议已在其他位置修改、处理或删除，请刷新后重试。");
    }
    return normalized;
  }

  private requireApplyingCandidate(
    candidateIdValue: string,
    expectedRevisionValue: number,
    intentValue: StoryPlanningSelectiveAcceptanceIntent,
  ): StoryPlanningCandidate {
    const candidateId = validateIdentifier(candidateIdValue, "规划建议编号", 128, true);
    const expectedRevision = validateRevision(expectedRevisionValue);
    const expectedIntent = normalizeSelectiveAcceptanceIntent(intentValue);
    const candidate = this.read().candidates[candidateId];
    if (candidate === undefined) {
      throw notFound();
    }
    const normalized = normalizeCandidate(candidate);
    if (
      normalized.status !== "review" ||
      normalized.revision !== expectedRevision ||
      normalized.selectiveAcceptanceIntent === null ||
      JSON.stringify(normalized.selectiveAcceptanceIntent) !== JSON.stringify(expectedIntent)
    ) {
      throw conflict("逐项采纳状态已发生变化，请刷新后重试。");
    }
    return normalized;
  }

  private replace(candidate: StoryPlanningCandidate): void {
    const database = this.read();
    this.write({
      schemaVersion: 1,
      candidates: { ...database.candidates, [candidate.id]: candidate },
    });
  }

  private read(): BrowserCandidateDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_KEY);
    if (serialized === null) {
      return { schemaVersion: 1, candidates: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.candidates)) {
        throw corrupt();
      }
      const candidates: Record<string, StoryPlanningCandidate> = {};
      for (const [id, value] of Object.entries(parsed.candidates)) {
        const candidate = normalizeCandidate(value);
        if (candidate.id !== id) {
          throw corrupt();
        }
        candidates[id] = candidate;
      }
      return { schemaVersion: 1, candidates };
    } catch (cause: unknown) {
      throw cause instanceof StoryPlanningCandidateStoreError &&
        cause.code === "STORY_PLANNING_CANDIDATE_CORRUPT"
        ? cause
        : corrupt();
    }
  }

  private write(database: BrowserCandidateDatabase): void {
    try {
      this.storage.setItem(DEVELOPMENT_KEY, JSON.stringify(database));
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法保存浏览器调试规划建议。");
    }
  }
}

const CANDIDATE_SELECT = `SELECT
  id,
  project_id AS projectId,
  task,
  target_node_id AS targetNodeId,
  target_node_title AS targetNodeTitle,
  baseline_outline_revision AS baselineOutlineRevision,
  baseline_target_synopsis AS baselineTargetSynopsis,
  status,
  payload_json AS payloadJson,
  editable_synopsis AS editableSynopsis,
  context_json AS contextJson,
  invocation_id AS invocationId,
  connection_id AS connectionId,
  catalog_entry_id AS catalogEntryId,
  provider_kind AS providerKind,
  model_id AS modelId,
  used_fallback AS usedFallback,
  accepted_outline_revision AS acceptedOutlineRevision,
  accepted_selection_json AS acceptedSelectionJson,
  selective_acceptance_intent_json AS selectiveAcceptanceIntentJson,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt,
  decided_at AS decidedAt
FROM story_planning_candidates`;

function candidateBindings(candidate: StoryPlanningCandidate) {
  return [
    candidate.id,
    candidate.projectId,
    candidate.task,
    candidate.targetNodeId,
    candidate.targetNodeTitle,
    candidate.baselineOutlineRevision,
    candidate.baselineTargetSynopsis ?? null,
    candidate.status,
    JSON.stringify(candidate.payload),
    candidate.editableSynopsis,
    JSON.stringify(candidate.context),
    candidate.invocationId,
    candidate.connectionId,
    candidate.catalogEntryId,
    candidate.providerKind,
    candidate.modelId,
    candidate.usedFallback ? 1 : 0,
    candidate.acceptedOutlineRevision,
    candidate.acceptedItemIds === null || candidate.acceptedItemIds === undefined
      ? null
      : JSON.stringify(candidate.acceptedItemIds),
    candidate.selectiveAcceptanceIntent === null ||
    candidate.selectiveAcceptanceIntent === undefined
      ? null
      : JSON.stringify(candidate.selectiveAcceptanceIntent),
    candidate.revision,
    candidate.createdAt,
    candidate.updatedAt,
    candidate.decidedAt,
  ] as const;
}

function candidateFromRow(row: CandidateRow): StoryPlanningCandidate {
  try {
    return normalizeCandidate({
      id: row.id,
      projectId: row.projectId,
      task: row.task,
      targetNodeId: row.targetNodeId,
      targetNodeTitle: row.targetNodeTitle,
      baselineOutlineRevision: row.baselineOutlineRevision,
      baselineTargetSynopsis: row.baselineTargetSynopsis,
      status: row.status,
      payload: JSON.parse(row.payloadJson) as unknown,
      editableSynopsis: row.editableSynopsis,
      context: JSON.parse(row.contextJson) as unknown,
      invocationId: row.invocationId,
      connectionId: row.connectionId,
      catalogEntryId: row.catalogEntryId,
      providerKind: row.providerKind,
      modelId: row.modelId,
      usedFallback: row.usedFallback === 1,
      acceptedOutlineRevision: row.acceptedOutlineRevision,
      acceptedItemIds:
        row.acceptedSelectionJson === null
          ? null
          : (JSON.parse(row.acceptedSelectionJson) as unknown),
      selectiveAcceptanceIntent:
        row.selectiveAcceptanceIntentJson === null
          ? null
          : (JSON.parse(row.selectiveAcceptanceIntentJson) as unknown),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      decidedAt: row.decidedAt,
    });
  } catch {
    throw corrupt();
  }
}

export function normalizeStoryPlanningPayload(value: unknown): StoryPlanningPayload {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isPlanningTask(value.task)) {
    throw invalid("AI 规划返回的数据结构无效。");
  }
  if (value.task === "outline_planning") {
    requireExactKeys(value, [
      "schemaVersion",
      "task",
      "title",
      "direction",
      "beats",
      "constraintsApplied",
      "openQuestions",
    ]);
    if (!Array.isArray(value.beats) || value.beats.length < 1 || value.beats.length > 16) {
      throw invalid("AI 规划必须包含 1 至 16 个剧情节点。");
    }
    return Object.freeze({
      schemaVersion: 1,
      task: "outline_planning",
      title: validateText(value.title, 1, 200, "规划标题"),
      direction: validateText(value.direction, 1, 4_000, "故事方向"),
      beats: Object.freeze(value.beats.map((beat) => normalizeBeat(beat, "剧情节点"))),
      constraintsApplied: normalizeTextArray(value.constraintsApplied, 16, 500, "采用的约束"),
      openQuestions: normalizeTextArray(value.openQuestions, 12, 500, "待确认问题"),
    });
  }
  requireExactKeys(value, [
    "schemaVersion",
    "task",
    "chapterTitle",
    "chapterGoal",
    "scenes",
    "continuityChecks",
  ]);
  if (!Array.isArray(value.scenes) || value.scenes.length < 1 || value.scenes.length > 16) {
    throw invalid("AI 场景拆解必须包含 1 至 16 个场景。");
  }
  return Object.freeze({
    schemaVersion: 1,
    task: "scene_breakdown",
    chapterTitle: validateText(value.chapterTitle, 1, 200, "章节标题"),
    chapterGoal: validateText(value.chapterGoal, 1, 2_000, "章节目标"),
    scenes: Object.freeze(value.scenes.map((scene) => normalizeScene(scene))),
    continuityChecks: normalizeTextArray(value.continuityChecks, 16, 500, "连续性检查"),
  });
}

function normalizeCandidate(value: unknown): StoryPlanningCandidate {
  if (!isRecord(value)) {
    throw invalid("规划建议版本无效。");
  }
  const compatibleValue: Record<string, unknown> = {
    ...value,
    baselineTargetSynopsis: value.baselineTargetSynopsis ?? null,
    acceptedItemIds: value.acceptedItemIds ?? null,
    selectiveAcceptanceIntent: value.selectiveAcceptanceIntent ?? null,
  };
  requireExactKeys(compatibleValue, [
    "id",
    "projectId",
    "task",
    "targetNodeId",
    "targetNodeTitle",
    "baselineOutlineRevision",
    "baselineTargetSynopsis",
    "status",
    "payload",
    "editableSynopsis",
    "context",
    "invocationId",
    "connectionId",
    "catalogEntryId",
    "providerKind",
    "modelId",
    "usedFallback",
    "acceptedOutlineRevision",
    "acceptedItemIds",
    "selectiveAcceptanceIntent",
    "revision",
    "createdAt",
    "updatedAt",
    "decidedAt",
  ]);
  const task = isPlanningTask(compatibleValue.task) ? compatibleValue.task : null;
  const status = isCandidateStatus(compatibleValue.status) ? compatibleValue.status : null;
  const providerKind = MODEL_PROVIDER_KINDS.includes(
    compatibleValue.providerKind as ModelProviderKind,
  )
    ? (compatibleValue.providerKind as ModelProviderKind)
    : null;
  const payload = normalizeStoryPlanningPayload(compatibleValue.payload);
  const context = normalizeContext(compatibleValue.context);
  const baselineOutlineRevision = validateRevision(compatibleValue.baselineOutlineRevision);
  const baselineTargetSynopsis = normalizeBaselineTargetSynopsis(
    compatibleValue.baselineTargetSynopsis,
  );
  const revision = validateRevision(compatibleValue.revision);
  const acceptedOutlineRevision =
    compatibleValue.acceptedOutlineRevision === null
      ? null
      : validateRevision(compatibleValue.acceptedOutlineRevision);
  const acceptedItemIds = normalizeAcceptedItemIds(compatibleValue.acceptedItemIds);
  const selectiveAcceptanceIntent =
    compatibleValue.selectiveAcceptanceIntent === null
      ? null
      : normalizeSelectiveAcceptanceIntent(compatibleValue.selectiveAcceptanceIntent);
  const createdAt = validateTimestamp(compatibleValue.createdAt);
  const updatedAt = validateTimestamp(compatibleValue.updatedAt);
  const decidedAt =
    compatibleValue.decidedAt === null ? null : validateTimestamp(compatibleValue.decidedAt);
  if (
    task === null ||
    status === null ||
    providerKind === null ||
    payload.task !== task ||
    typeof compatibleValue.usedFallback !== "boolean" ||
    updatedAt < createdAt ||
    (status === "review") !== (decidedAt === null) ||
    (status === "accepted") !== (acceptedOutlineRevision !== null) ||
    (status !== "accepted" && acceptedItemIds !== null) ||
    (acceptedItemIds !== null && baselineTargetSynopsis === null) ||
    (acceptedItemIds !== null && !itemIdsMatchImmutablePayload(payload, acceptedItemIds)) ||
    (selectiveAcceptanceIntent !== null &&
      (status !== "review" ||
        baselineTargetSynopsis === null ||
        acceptedItemIds !== null ||
        acceptedOutlineRevision !== null ||
        selectiveAcceptanceIntent.baselineOutlineRevision !== baselineOutlineRevision ||
        !itemIdsMatchImmutablePayload(payload, selectiveAcceptanceIntent.selectedItemIds)))
  ) {
    throw invalid("规划建议版本的状态或来源无效。");
  }
  return Object.freeze({
    id: validateIdentifier(compatibleValue.id, "规划建议编号", 128, true),
    projectId: validateIdentifier(compatibleValue.projectId, "项目编号", 128, true),
    task,
    targetNodeId: validateIdentifier(compatibleValue.targetNodeId, "大纲节点编号", 128, true),
    targetNodeTitle: validateText(compatibleValue.targetNodeTitle, 1, 200, "目标节点标题"),
    baselineOutlineRevision,
    baselineTargetSynopsis,
    status,
    payload,
    editableSynopsis: validateText(compatibleValue.editableSynopsis, 1, 20_000, "可采纳内容"),
    context,
    invocationId: validateIdentifier(compatibleValue.invocationId, "调用记录编号", 128),
    connectionId: validateIdentifier(compatibleValue.connectionId, "供应商连接编号", 128),
    catalogEntryId: validateIdentifier(compatibleValue.catalogEntryId, "模型目录编号", 128),
    providerKind,
    modelId: validateIdentifier(compatibleValue.modelId, "模型编号", 512),
    usedFallback: compatibleValue.usedFallback,
    acceptedOutlineRevision,
    acceptedItemIds,
    selectiveAcceptanceIntent,
    revision,
    createdAt,
    updatedAt,
    decidedAt,
  });
}

function normalizeContext(value: unknown): StoryPlanningContextReceipt {
  if (!isRecord(value)) {
    throw invalid("规划建议的上下文记录无效。");
  }
  requireExactKeys(value, [
    "formalFactIds",
    "lockedFactIds",
    "causalEventIds",
    "causalGraphStatus",
  ]);
  if (
    !(["available", "empty", "unavailable"] as const).includes(value.causalGraphStatus as never)
  ) {
    throw invalid("规划建议的故事关联状态无效。");
  }
  return Object.freeze({
    formalFactIds: normalizeIdentifierArray(value.formalFactIds, "正式事实"),
    lockedFactIds: normalizeIdentifierArray(value.lockedFactIds, "锁定事实"),
    causalEventIds: normalizeIdentifierArray(value.causalEventIds, "因果事件"),
    causalGraphStatus: value.causalGraphStatus as StoryPlanningContextReceipt["causalGraphStatus"],
  });
}

function normalizeBeat(value: unknown, label: string): OutlinePlanningBeat {
  if (!isRecord(value)) {
    throw invalid(`${label}无效。`);
  }
  requireExactKeys(value, ["title", "purpose", "outcome"]);
  return Object.freeze({
    title: validateText(value.title, 1, 200, `${label}标题`),
    purpose: validateText(value.purpose, 1, 1_000, `${label}目标`),
    outcome: validateText(value.outcome, 1, 1_000, `${label}结果`),
  });
}

function normalizeScene(value: unknown): ScenePlanningItem {
  if (!isRecord(value)) {
    throw invalid("场景无效。");
  }
  requireExactKeys(value, ["title", "goal", "conflict", "outcome"]);
  return Object.freeze({
    title: validateText(value.title, 1, 200, "场景标题"),
    goal: validateText(value.goal, 1, 1_000, "场景目标"),
    conflict: validateText(value.conflict, 1, 1_000, "场景冲突"),
    outcome: validateText(value.outcome, 1, 1_000, "场景结果"),
  });
}

function normalizeTextArray(
  value: unknown,
  maximumItems: number,
  maximumCharacters: number,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw invalid(`${label}列表无效。`);
  }
  return Object.freeze(
    value.map((item, index) =>
      validateText(item, 1, maximumCharacters, `${label}第 ${String(index + 1)} 项`),
    ),
  );
}

function normalizeIdentifierArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw invalid(`${label}引用列表无效。`);
  }
  const identifiers = value.map((item) => validateIdentifier(item, `${label}编号`, 128));
  if (new Set(identifiers).size !== identifiers.length) {
    throw invalid(`${label}引用不能重复。`);
  }
  return Object.freeze(identifiers);
}

function normalizeBaselineTargetSynopsis(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length > 4_000 || value.includes("\u0000")) {
    throw invalid("规划建议的目标简介基线无效。");
  }
  return value;
}

function normalizeAcceptedItemIds(value: unknown): readonly string[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw invalid("规划建议的部分采纳记录无效。");
  }
  const identifiers = value.map((item) => validateIdentifier(item, "规划条目编号", 128));
  if (new Set(identifiers).size !== identifiers.length) {
    throw invalid("规划建议的部分采纳记录不能重复。");
  }
  return Object.freeze(identifiers);
}

function normalizeSelectiveAcceptanceIntent(
  value: unknown,
): StoryPlanningSelectiveAcceptanceIntent {
  if (!isRecord(value)) {
    throw invalid("逐项采纳意图无效。");
  }
  requireExactKeys(value, [
    "schemaVersion",
    "selectedItemIds",
    "selectionSha256",
    "baselineOutlineRevision",
    "baselineSynopsisSha256",
    "proposedSynopsisSha256",
    "startedAt",
  ]);
  if (value.schemaVersion !== 1) {
    throw invalid("逐项采纳意图版本无效。");
  }
  const selectedItemIds = normalizeAcceptedItemIds(value.selectedItemIds);
  if (selectedItemIds === null) {
    throw invalid("逐项采纳意图必须包含至少一个条目。");
  }
  return Object.freeze({
    schemaVersion: 1,
    selectedItemIds,
    selectionSha256: validateSha256(value.selectionSha256, "选择内容"),
    baselineOutlineRevision: validateRevision(value.baselineOutlineRevision),
    baselineSynopsisSha256: validateSha256(value.baselineSynopsisSha256, "基线简介"),
    proposedSynopsisSha256: validateSha256(value.proposedSynopsisSha256, "拟写入简介"),
    startedAt: validateTimestamp(value.startedAt),
  });
}

function normalizeSelectiveAcceptanceIntentForCandidate(
  value: unknown,
  candidate: StoryPlanningCandidate,
): StoryPlanningSelectiveAcceptanceIntent {
  const intent = normalizeSelectiveAcceptanceIntent(value);
  if (
    candidate.status !== "review" ||
    candidate.baselineTargetSynopsis === null ||
    candidate.baselineTargetSynopsis === undefined ||
    intent.baselineOutlineRevision !== candidate.baselineOutlineRevision ||
    !itemIdsMatchImmutablePayload(candidate.payload, intent.selectedItemIds)
  ) {
    throw invalid("逐项采纳意图与不可变候选内容不一致。");
  }
  return intent;
}

function itemIdsMatchImmutablePayload(
  payload: StoryPlanningPayload,
  itemIds: readonly string[],
): boolean {
  const available =
    payload.task === "outline_planning"
      ? [
          "overview",
          ...payload.beats.map((_, index) => `beat:${String(index)}`),
          ...payload.constraintsApplied.map((_, index) => `constraint:${String(index)}`),
          ...payload.openQuestions.map((_, index) => `question:${String(index)}`),
        ]
      : [
          "overview",
          ...payload.scenes.map((_, index) => `scene:${String(index)}`),
          ...payload.continuityChecks.map((_, index) => `continuity:${String(index)}`),
        ];
  const selected = new Set(itemIds);
  const canonical = available.filter((id) => selected.has(id));
  return (
    canonical.length === itemIds.length && canonical.every((id, index) => id === itemIds[index])
  );
}

function validateSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`${label}校验值必须是小写 SHA-256。`);
  }
  return value;
}

function validateText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string") {
    throw invalid(`${label}无效。`);
  }
  const normalized = value.trim();
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw invalid(`${label}无效或过长。`);
  }
  return normalized;
}

function validateIdentifier(
  value: unknown,
  label: string,
  maximum: number,
  requireUuid = false,
): string {
  const identifier = validateText(value, 1, maximum, label);
  if (requireUuid && !UUID_V7_PATTERN.test(identifier)) {
    throw invalid(`${label}无效。`);
  }
  return identifier;
}

function validateTimestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw invalid("规划建议时间无效。");
  }
  return value;
}

function validateRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalid("规划建议修订号无效。");
  }
  return value;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_CANDIDATE_LIMIT) {
    throw invalid("规划建议读取数量无效。");
  }
  return value;
}

function requireExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid("AI 规划 JSON 包含缺失或未知字段。");
  }
}

function isPlanningTask(value: unknown): value is StoryPlanningTask {
  return STORY_PLANNING_TASKS.includes(value as StoryPlanningTask);
}

function isCandidateStatus(value: unknown): value is StoryPlanningCandidateStatus {
  return ["review", "accepted", "rejected"].includes(value as StoryPlanningCandidateStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): StoryPlanningCandidateStoreError {
  return new StoryPlanningCandidateStoreError("STORY_PLANNING_CANDIDATE_INVALID", message);
}

function conflict(message: string): StoryPlanningCandidateStoreError {
  return new StoryPlanningCandidateStoreError("STORY_PLANNING_CANDIDATE_CONFLICT", message);
}

function notFound(): StoryPlanningCandidateStoreError {
  return new StoryPlanningCandidateStoreError(
    "STORY_PLANNING_CANDIDATE_NOT_FOUND",
    "规划建议版本不存在。",
  );
}

function corrupt(): StoryPlanningCandidateStoreError {
  return new StoryPlanningCandidateStoreError(
    "STORY_PLANNING_CANDIDATE_CORRUPT",
    "规划建议存储损坏。为保护正式大纲，本次不会继续采纳。",
  );
}

function normalizeFailure(cause: unknown, message: string): StoryPlanningCandidateStoreError {
  if (cause instanceof StoryPlanningCandidateStoreError) {
    return cause;
  }
  return new StoryPlanningCandidateStoreError(
    "STORY_PLANNING_CANDIDATE_UNAVAILABLE",
    message,
    true,
  );
}
