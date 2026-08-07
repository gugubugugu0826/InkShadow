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

export interface StoryPlanningCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly task: StoryPlanningTask;
  readonly targetNodeId: string;
  readonly targetNodeTitle: string;
  readonly baselineOutlineRevision: number;
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
           baseline_outline_revision, status, payload_json, editable_synopsis,
           context_json, invocation_id, connection_id, catalog_entry_id,
           provider_kind, model_id, used_fallback, accepted_outline_revision,
           revision, created_at, updated_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
         WHERE id = ? AND status = 'review' AND revision = ?`,
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
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    const candidateId = validateIdentifier(input.candidateId, "规划建议编号", 128, true);
    const expectedRevision = validateRevision(input.expectedRevision);
    const now = validateTimestamp(input.now);
    if (
      (input.decision === "accepted" &&
        (!Number.isSafeInteger(input.acceptedOutlineRevision) ||
          (input.acceptedOutlineRevision ?? 0) < 1)) ||
      (input.decision === "rejected" && input.acceptedOutlineRevision !== null)
    ) {
      throw invalid("规划建议的处理结果无效。");
    }
    try {
      const updated = await this.executor.execute(
        `UPDATE story_planning_candidates
         SET status = ?, accepted_outline_revision = ?, revision = revision + 1,
             updated_at = ?, decided_at = ?
         WHERE id = ? AND status = 'review' AND revision = ?`,
        [input.decision, input.acceptedOutlineRevision, now, now, candidateId, expectedRevision],
      );
      if (updated.rowsAffected !== 1) {
        throw conflict("规划建议已在其他位置修改、处理或删除，请刷新后重试。");
      }
      return await this.requireById(candidateId);
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法记录规划建议的处理结果。");
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
      now: string;
    }>,
  ): Promise<StoryPlanningCandidate> {
    await Promise.resolve();
    const candidate = this.requireReviewCandidate(input.candidateId, input.expectedRevision);
    if (
      (input.decision === "accepted" &&
        (!Number.isSafeInteger(input.acceptedOutlineRevision) ||
          (input.acceptedOutlineRevision ?? 0) < 1)) ||
      (input.decision === "rejected" && input.acceptedOutlineRevision !== null)
    ) {
      throw invalid("规划建议的处理结果无效。");
    }
    const now = validateTimestamp(input.now);
    const next = normalizeCandidate({
      ...candidate,
      status: input.decision,
      acceptedOutlineRevision: input.acceptedOutlineRevision,
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
    if (normalized.status !== "review" || normalized.revision !== expectedRevision) {
      throw conflict("规划建议已在其他位置修改、处理或删除，请刷新后重试。");
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
      throw cause instanceof StoryPlanningCandidateStoreError ? cause : corrupt();
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
  requireExactKeys(value, [
    "id",
    "projectId",
    "task",
    "targetNodeId",
    "targetNodeTitle",
    "baselineOutlineRevision",
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
    "revision",
    "createdAt",
    "updatedAt",
    "decidedAt",
  ]);
  const task = isPlanningTask(value.task) ? value.task : null;
  const status = isCandidateStatus(value.status) ? value.status : null;
  const providerKind = MODEL_PROVIDER_KINDS.includes(value.providerKind as ModelProviderKind)
    ? (value.providerKind as ModelProviderKind)
    : null;
  const payload = normalizeStoryPlanningPayload(value.payload);
  const context = normalizeContext(value.context);
  const baselineOutlineRevision = validateRevision(value.baselineOutlineRevision);
  const revision = validateRevision(value.revision);
  const acceptedOutlineRevision =
    value.acceptedOutlineRevision === null ? null : validateRevision(value.acceptedOutlineRevision);
  const createdAt = validateTimestamp(value.createdAt);
  const updatedAt = validateTimestamp(value.updatedAt);
  const decidedAt = value.decidedAt === null ? null : validateTimestamp(value.decidedAt);
  if (
    task === null ||
    status === null ||
    providerKind === null ||
    payload.task !== task ||
    typeof value.usedFallback !== "boolean" ||
    updatedAt < createdAt ||
    (status === "review") !== (decidedAt === null) ||
    (status === "accepted") !== (acceptedOutlineRevision !== null)
  ) {
    throw invalid("规划建议版本的状态或来源无效。");
  }
  return Object.freeze({
    id: validateIdentifier(value.id, "规划建议编号", 128, true),
    projectId: validateIdentifier(value.projectId, "项目编号", 128, true),
    task,
    targetNodeId: validateIdentifier(value.targetNodeId, "大纲节点编号", 128, true),
    targetNodeTitle: validateText(value.targetNodeTitle, 1, 200, "目标节点标题"),
    baselineOutlineRevision,
    status,
    payload,
    editableSynopsis: validateText(value.editableSynopsis, 1, 20_000, "可采纳内容"),
    context,
    invocationId: validateIdentifier(value.invocationId, "调用记录编号", 128),
    connectionId: validateIdentifier(value.connectionId, "供应商连接编号", 128),
    catalogEntryId: validateIdentifier(value.catalogEntryId, "模型目录编号", 128),
    providerKind,
    modelId: validateIdentifier(value.modelId, "模型编号", 512),
    usedFallback: value.usedFallback,
    acceptedOutlineRevision,
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
