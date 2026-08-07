import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

export const WRITING_FEEDBACK_ACTIONS = [
  "accepted",
  "rejected",
  "regenerated",
  "partially_accepted",
  "deleted",
  "restored_original",
  "explicit_feedback",
] as const;
export type WritingFeedbackAction = (typeof WRITING_FEEDBACK_ACTIONS)[number];

export const WRITING_FEEDBACK_CODES = [
  "shorter_sentences",
  "more_dialogue",
  "less_environment_description",
  "avoid_summary_ending",
  "less_introspection",
  "faster_pacing",
  "avoid_term",
  "preserve_style",
  "smaller_changes",
  "larger_changes",
  "natural_dialogue",
] as const;
export type WritingFeedbackCode = (typeof WRITING_FEEDBACK_CODES)[number];

export const CANDIDATE_APPLICATION_STRATEGIES = [
  "accept_all",
  "apply_changes",
  "insert_at_cursor",
  "replace_selection",
  "overwrite_document",
] as const;
export type RecordedCandidateApplicationStrategy =
  (typeof CANDIDATE_APPLICATION_STRATEGIES)[number];

export const WRITING_FEEDBACK_CODE_LABELS: Readonly<Record<WritingFeedbackCode, string>> = {
  shorter_sentences: "句子更短一些",
  more_dialogue: "增加人物对话",
  less_environment_description: "减少环境描写",
  avoid_summary_ending: "避免总结式结尾",
  less_introspection: "减少大段心理独白",
  faster_pacing: "加快情节节奏",
  avoid_term: "避免指定词语",
  preserve_style: "保留当前风格",
  smaller_changes: "改动幅度更小",
  larger_changes: "改动幅度更大",
  natural_dialogue: "让对话更自然",
};

export const WRITING_FEEDBACK_PREFERENCE_TEXT: Readonly<Record<WritingFeedbackCode, string>> = {
  shorter_sentences: "偏好较短、清晰的句子，避免连续使用过长复句。",
  more_dialogue: "适当增加人物对话，让关系和冲突通过交流推进。",
  less_environment_description: "减少与当前情节无关的环境描写。",
  avoid_summary_ending: "避免使用总结式、说教式的章节结尾。",
  less_introspection: "减少大段心理独白，优先用行动和对话表现情绪。",
  faster_pacing: "加快关键情节节奏，减少不推进剧情的停顿。",
  avoid_term: "避免使用用户标记为不喜欢的词语。",
  preserve_style: "修改时保留现有叙述风格和人物表达习惯。",
  smaller_changes: "改写时尽量缩小改动范围，保留原句结构和剧情信息。",
  larger_changes: "允许为提升效果进行更明显的结构和表达调整。",
  natural_dialogue: "人物对话应自然、有差异，避免说明书式表达。",
};

export interface WritingFeedbackPolicy {
  readonly projectId: string;
  readonly learningEnabled: boolean;
  readonly revision: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface WritingFeedbackEvent {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string | null;
  readonly candidateId: string | null;
  readonly action: WritingFeedbackAction;
  readonly feedbackCode: WritingFeedbackCode | null;
  readonly customFeedback: string | null;
  readonly applicationStrategy: RecordedCandidateApplicationStrategy | null;
  readonly acceptedChangeCount: number | null;
  readonly rejectedChangeCount: number | null;
  readonly createdAt: string;
}

export interface WritingPreference {
  readonly id: string;
  readonly projectId: string;
  readonly preferenceText: string;
  readonly source: "manual" | "feedback_pattern";
  readonly sourceFeedbackCode: WritingFeedbackCode | null;
  readonly evidenceCount: number;
  readonly enabled: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface SaveWritingPreferenceInput {
  readonly id: string;
  readonly projectId: string;
  readonly preferenceText: string;
  readonly source: WritingPreference["source"];
  readonly sourceFeedbackCode?: WritingFeedbackCode | null;
  readonly evidenceCount?: number;
  readonly enabled?: boolean;
  readonly now: string;
}

export interface UpdateWritingPreferenceInput {
  readonly preferenceId: string;
  readonly expectedRevision: number;
  readonly preferenceText?: string;
  readonly enabled?: boolean;
  readonly evidenceCount?: number;
  readonly delete?: boolean;
  readonly now: string;
}

export interface WritingFeedbackStore {
  getPolicy(projectId: string): Promise<WritingFeedbackPolicy>;
  setLearningEnabled(
    projectId: string,
    enabled: boolean,
    expectedRevision: number,
    now: string,
  ): Promise<WritingFeedbackPolicy>;
  recordEvent(event: WritingFeedbackEvent): Promise<void>;
  listEvents(projectId: string, limit?: number): Promise<readonly WritingFeedbackEvent[]>;
  listPreferences(
    projectId: string,
    includeDeleted?: boolean,
  ): Promise<readonly WritingPreference[]>;
  createPreference(input: SaveWritingPreferenceInput): Promise<WritingPreference>;
  updatePreference(input: UpdateWritingPreferenceInput): Promise<WritingPreference>;
  clearPreferences(projectId: string, now: string): Promise<number>;
}

export type WritingFeedbackStoreErrorCode =
  | "WRITING_FEEDBACK_INVALID"
  | "WRITING_FEEDBACK_CONFLICT"
  | "WRITING_FEEDBACK_NOT_FOUND"
  | "WRITING_FEEDBACK_CORRUPT"
  | "WRITING_FEEDBACK_UNAVAILABLE";

export class WritingFeedbackStoreError extends Error {
  public constructor(
    readonly code: WritingFeedbackStoreErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WritingFeedbackStoreError";
  }
}

const DEVELOPMENT_KEY = "inkshadow.development.writing-feedback.v1";
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_EVENT_LIMIT = 500;

interface PolicyRow {
  readonly projectId: string;
  readonly learningEnabled: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EventRow {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string | null;
  readonly candidateId: string | null;
  readonly action: string;
  readonly feedbackCode: string | null;
  readonly customFeedback: string | null;
  readonly applicationStrategy: string | null;
  readonly acceptedChangeCount: number | null;
  readonly rejectedChangeCount: number | null;
  readonly createdAt: string;
}

interface PreferenceRow {
  readonly id: string;
  readonly projectId: string;
  readonly preferenceText: string;
  readonly source: string;
  readonly sourceFeedbackCode: string | null;
  readonly evidenceCount: number;
  readonly enabled: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface BrowserWritingFeedbackDatabase {
  readonly schemaVersion: 1;
  policies: Record<string, WritingFeedbackPolicy>;
  events: Record<string, WritingFeedbackEvent>;
  preferences: Record<string, WritingPreference>;
}

export class SqliteWritingFeedbackStore implements WritingFeedbackStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async getPolicy(projectIdValue: string): Promise<WritingFeedbackPolicy> {
    const projectId = validateUuid(projectIdValue, "project id");
    try {
      const rows = await this.executor.select<PolicyRow>(
        `SELECT project_id AS projectId, learning_enabled AS learningEnabled,
                revision, created_at AS createdAt, updated_at AS updatedAt
         FROM writing_feedback_policies WHERE project_id = ? LIMIT 1`,
        [projectId],
      );
      const row = rows[0];
      return row === undefined
        ? defaultPolicy(projectId)
        : normalizePolicy({
            projectId: row.projectId,
            learningEnabled: row.learningEnabled === 1,
            revision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法读取写作偏好学习设置。");
    }
  }

  public async setLearningEnabled(
    projectIdValue: string,
    enabled: boolean,
    expectedRevision: number,
    nowValue: string,
  ): Promise<WritingFeedbackPolicy> {
    const projectId = validateUuid(projectIdValue, "project id");
    const now = validateTimestamp(nowValue);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw invalid("偏好学习设置版本无效。");
    }
    try {
      if (expectedRevision === 0) {
        await this.executor.execute(
          `INSERT INTO writing_feedback_policies (
             project_id, learning_enabled, revision, created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?)`,
          [projectId, enabled ? 1 : 0, now, now],
        );
      } else {
        const updated = await this.executor.execute(
          `UPDATE writing_feedback_policies
           SET learning_enabled = ?, revision = revision + 1, updated_at = ?
           WHERE project_id = ? AND revision = ?`,
          [enabled ? 1 : 0, now, projectId, expectedRevision],
        );
        if (updated.rowsAffected !== 1) {
          throw conflict("偏好学习设置已在其他位置发生变化，请刷新后重试。");
        }
      }
      return {
        projectId,
        learningEnabled: enabled,
        revision: expectedRevision + 1,
        createdAt: expectedRevision === 0 ? now : (await this.getPolicy(projectId)).createdAt,
        updatedAt: now,
      };
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法保存写作偏好学习设置。");
    }
  }

  public async recordEvent(eventValue: WritingFeedbackEvent): Promise<void> {
    const event = normalizeEvent(eventValue);
    try {
      await this.executor.execute(
        `INSERT INTO writing_feedback_events (
           id, project_id, chapter_id, candidate_id, action, feedback_code,
           custom_feedback, application_strategy, accepted_change_count,
           rejected_change_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          event.projectId,
          event.chapterId,
          event.candidateId,
          event.action,
          event.feedbackCode,
          event.customFeedback,
          event.applicationStrategy,
          event.acceptedChangeCount,
          event.rejectedChangeCount,
          event.createdAt,
        ],
      );
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法记录这次写作反馈。");
    }
  }

  public async listEvents(
    projectIdValue: string,
    limitValue = 100,
  ): Promise<readonly WritingFeedbackEvent[]> {
    const projectId = validateUuid(projectIdValue, "project id");
    const limit = validateLimit(limitValue);
    try {
      const rows = await this.executor.select<EventRow>(
        `SELECT id, project_id AS projectId, chapter_id AS chapterId,
                candidate_id AS candidateId, action, feedback_code AS feedbackCode,
                custom_feedback AS customFeedback, application_strategy AS applicationStrategy,
                accepted_change_count AS acceptedChangeCount,
                rejected_change_count AS rejectedChangeCount, created_at AS createdAt
         FROM writing_feedback_events
         WHERE project_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [projectId, limit],
      );
      return Object.freeze(rows.map((row) => normalizeEvent(row)));
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法读取写作反馈记录。");
    }
  }

  public async listPreferences(
    projectIdValue: string,
    includeDeleted = false,
  ): Promise<readonly WritingPreference[]> {
    const projectId = validateUuid(projectIdValue, "project id");
    try {
      const rows = await this.executor.select<PreferenceRow>(
        `SELECT id, project_id AS projectId, preference_text AS preferenceText,
                source, source_feedback_code AS sourceFeedbackCode,
                evidence_count AS evidenceCount, enabled, revision,
                created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
         FROM writing_preferences
         WHERE project_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
         ORDER BY updated_at DESC, id DESC`,
        [projectId],
      );
      return Object.freeze(rows.map((row) => preferenceFromRow(row)));
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法读取写作偏好。");
    }
  }

  public async createPreference(input: SaveWritingPreferenceInput): Promise<WritingPreference> {
    const preference = normalizePreference({
      id: input.id,
      projectId: input.projectId,
      preferenceText: input.preferenceText,
      source: input.source,
      sourceFeedbackCode: input.sourceFeedbackCode ?? null,
      evidenceCount: input.evidenceCount ?? 0,
      enabled: input.enabled ?? true,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
    });
    try {
      await this.executor.execute(
        `INSERT INTO writing_preferences (
           id, project_id, preference_text, source, source_feedback_code,
           evidence_count, enabled, revision, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        [
          preference.id,
          preference.projectId,
          preference.preferenceText,
          preference.source,
          preference.sourceFeedbackCode,
          preference.evidenceCount,
          preference.enabled ? 1 : 0,
          preference.createdAt,
          preference.updatedAt,
        ],
      );
      return preference;
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法创建写作偏好。");
    }
  }

  public async updatePreference(input: UpdateWritingPreferenceInput): Promise<WritingPreference> {
    const preferenceId = validateUuid(input.preferenceId, "preference id");
    const now = validateTimestamp(input.now);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw invalid("写作偏好版本无效。");
    }
    try {
      return await this.executor.transaction(async (transaction) => {
        const current = await findSqlPreference(transaction, preferenceId);
        if (current === null) {
          throw notFound();
        }
        if (current.revision !== input.expectedRevision || current.deletedAt !== null) {
          throw conflict("写作偏好已发生变化，请刷新后重试。");
        }
        const next = normalizePreference({
          ...current,
          preferenceText: input.preferenceText ?? current.preferenceText,
          enabled: input.enabled ?? current.enabled,
          evidenceCount: input.evidenceCount ?? current.evidenceCount,
          revision: current.revision + 1,
          updatedAt: now,
          deletedAt: input.delete === true ? now : null,
        });
        const changeKind = classifyPreferenceChange(current, next);
        const updated = await transaction.execute(
          `UPDATE writing_preferences
           SET preference_text = ?, evidence_count = ?, enabled = ?, revision = ?,
               updated_at = ?, deleted_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
          [
            next.preferenceText,
            next.evidenceCount,
            next.enabled ? 1 : 0,
            next.revision,
            next.updatedAt,
            next.deletedAt,
            next.id,
            current.revision,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw conflict("写作偏好已发生变化，请刷新后重试。");
        }
        await insertPreferenceRevision(transaction, next, changeKind);
        return next;
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法更新写作偏好。");
    }
  }

  public async clearPreferences(projectIdValue: string, nowValue: string): Promise<number> {
    const projectId = validateUuid(projectIdValue, "project id");
    const now = validateTimestamp(nowValue);
    try {
      return await this.executor.transaction(async (transaction) => {
        const current = await listSqlPreferences(transaction, projectId);
        for (const preference of current) {
          const next = normalizePreference({
            ...preference,
            revision: preference.revision + 1,
            updatedAt: now,
            deletedAt: now,
          });
          await transaction.execute(
            `UPDATE writing_preferences
             SET revision = ?, updated_at = ?, deleted_at = ?
             WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
            [next.revision, now, now, next.id, preference.revision],
          );
          await insertPreferenceRevision(transaction, next, "deleted");
        }
        return current.length;
      });
    } catch (cause: unknown) {
      throw normalizeFailure(cause, "无法清空写作偏好。");
    }
  }
}

export class BrowserDevelopmentWritingFeedbackStore implements WritingFeedbackStore {
  public constructor(private readonly storage: Storage) {}

  public getPolicy(projectIdValue: string): Promise<WritingFeedbackPolicy> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, "project id");
      return this.read().policies[projectId] ?? defaultPolicy(projectId);
    });
  }

  public setLearningEnabled(
    projectIdValue: string,
    enabled: boolean,
    expectedRevision: number,
    nowValue: string,
  ): Promise<WritingFeedbackPolicy> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, "project id");
      const now = validateTimestamp(nowValue);
      const database = this.read();
      const current = database.policies[projectId] ?? defaultPolicy(projectId);
      if (current.revision !== expectedRevision) {
        throw conflict("偏好学习设置已在其他位置发生变化，请刷新后重试。");
      }
      const next: WritingFeedbackPolicy = normalizePolicy({
        projectId,
        learningEnabled: enabled,
        revision: expectedRevision + 1,
        createdAt: current.createdAt ?? now,
        updatedAt: now,
      });
      database.policies[projectId] = next;
      this.write(database);
      return next;
    });
  }

  public recordEvent(eventValue: WritingFeedbackEvent): Promise<void> {
    return Promise.resolve().then(() => {
      const event = normalizeEvent(eventValue);
      const database = this.read();
      if (database.events[event.id] !== undefined) {
        throw conflict("这次写作反馈已经记录。");
      }
      database.events[event.id] = event;
      this.write(database);
    });
  }

  public listEvents(
    projectIdValue: string,
    limitValue = 100,
  ): Promise<readonly WritingFeedbackEvent[]> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, "project id");
      const limit = validateLimit(limitValue);
      return Object.freeze(
        Object.values(this.read().events)
          .filter((event) => event.projectId === projectId)
          .sort(
            (left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
          )
          .slice(0, limit),
      );
    });
  }

  public listPreferences(
    projectIdValue: string,
    includeDeleted = false,
  ): Promise<readonly WritingPreference[]> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, "project id");
      return Object.freeze(
        Object.values(this.read().preferences)
          .filter(
            (preference) =>
              preference.projectId === projectId &&
              (includeDeleted || preference.deletedAt === null),
          )
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
          ),
      );
    });
  }

  public createPreference(input: SaveWritingPreferenceInput): Promise<WritingPreference> {
    return Promise.resolve().then(() => {
      const preference = normalizePreference({
        id: input.id,
        projectId: input.projectId,
        preferenceText: input.preferenceText,
        source: input.source,
        sourceFeedbackCode: input.sourceFeedbackCode ?? null,
        evidenceCount: input.evidenceCount ?? 0,
        enabled: input.enabled ?? true,
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
        deletedAt: null,
      });
      const database = this.read();
      if (
        database.preferences[preference.id] !== undefined ||
        Object.values(database.preferences).some(
          (existing) =>
            existing.projectId === preference.projectId &&
            existing.deletedAt === null &&
            preference.sourceFeedbackCode !== null &&
            existing.sourceFeedbackCode === preference.sourceFeedbackCode,
        )
      ) {
        throw conflict("这条写作偏好已经存在。");
      }
      database.preferences[preference.id] = preference;
      this.write(database);
      return preference;
    });
  }

  public updatePreference(input: UpdateWritingPreferenceInput): Promise<WritingPreference> {
    return Promise.resolve().then(() => {
      const preferenceId = validateUuid(input.preferenceId, "preference id");
      const now = validateTimestamp(input.now);
      const database = this.read();
      const current = database.preferences[preferenceId];
      if (current === undefined) {
        throw notFound();
      }
      if (current.revision !== input.expectedRevision || current.deletedAt !== null) {
        throw conflict("写作偏好已发生变化，请刷新后重试。");
      }
      const next = normalizePreference({
        ...current,
        preferenceText: input.preferenceText ?? current.preferenceText,
        enabled: input.enabled ?? current.enabled,
        evidenceCount: input.evidenceCount ?? current.evidenceCount,
        revision: current.revision + 1,
        updatedAt: now,
        deletedAt: input.delete === true ? now : null,
      });
      database.preferences[preferenceId] = next;
      this.write(database);
      return next;
    });
  }

  public clearPreferences(projectIdValue: string, nowValue: string): Promise<number> {
    return Promise.resolve().then(() => {
      const projectId = validateUuid(projectIdValue, "project id");
      const now = validateTimestamp(nowValue);
      const database = this.read();
      let count = 0;
      for (const [id, preference] of Object.entries(database.preferences)) {
        if (preference.projectId === projectId && preference.deletedAt === null) {
          database.preferences[id] = normalizePreference({
            ...preference,
            revision: preference.revision + 1,
            updatedAt: now,
            deletedAt: now,
          });
          count += 1;
        }
      }
      this.write(database);
      return count;
    });
  }

  private read(): BrowserWritingFeedbackDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_KEY);
    if (serialized === null) {
      return { schemaVersion: 1, policies: {}, events: {}, preferences: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
        throw corrupt();
      }
      const rawPolicies = requireRecord(parsed.policies);
      const rawEvents = requireRecord(parsed.events);
      const rawPreferences = requireRecord(parsed.preferences);
      const policies: Record<string, WritingFeedbackPolicy> = {};
      const events: Record<string, WritingFeedbackEvent> = {};
      const preferences: Record<string, WritingPreference> = {};
      for (const [id, value] of Object.entries(rawPolicies)) {
        const policy = normalizePolicy(value as WritingFeedbackPolicy);
        if (policy.projectId !== id) throw corrupt();
        policies[id] = policy;
      }
      for (const [id, value] of Object.entries(rawEvents)) {
        const event = normalizeEvent(value as WritingFeedbackEvent);
        if (event.id !== id) throw corrupt();
        events[id] = event;
      }
      for (const [id, value] of Object.entries(rawPreferences)) {
        const preference = normalizePreference(value as WritingPreference);
        if (preference.id !== id) throw corrupt();
        preferences[id] = preference;
      }
      return { schemaVersion: 1, policies, events, preferences };
    } catch (cause: unknown) {
      if (cause instanceof WritingFeedbackStoreError) throw cause;
      throw corrupt();
    }
  }

  private write(database: BrowserWritingFeedbackDatabase): void {
    try {
      this.storage.setItem(DEVELOPMENT_KEY, JSON.stringify(database));
    } catch {
      throw new WritingFeedbackStoreError(
        "WRITING_FEEDBACK_UNAVAILABLE",
        "浏览器调试存储无法保存写作反馈。",
        true,
      );
    }
  }
}

async function findSqlPreference(
  executor: Pick<TransactionExecutor, "select">,
  preferenceId: string,
): Promise<WritingPreference | null> {
  const rows = await executor.select<PreferenceRow>(
    `SELECT id, project_id AS projectId, preference_text AS preferenceText,
            source, source_feedback_code AS sourceFeedbackCode,
            evidence_count AS evidenceCount, enabled, revision,
            created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
     FROM writing_preferences WHERE id = ? LIMIT 1`,
    [preferenceId],
  );
  return rows[0] === undefined ? null : preferenceFromRow(rows[0]);
}

async function listSqlPreferences(
  executor: Pick<TransactionExecutor, "select">,
  projectId: string,
): Promise<readonly WritingPreference[]> {
  const rows = await executor.select<PreferenceRow>(
    `SELECT id, project_id AS projectId, preference_text AS preferenceText,
            source, source_feedback_code AS sourceFeedbackCode,
            evidence_count AS evidenceCount, enabled, revision,
            created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt
     FROM writing_preferences WHERE project_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC, id DESC`,
    [projectId],
  );
  return Object.freeze(rows.map(preferenceFromRow));
}

async function insertPreferenceRevision(
  transaction: TransactionExecutor,
  preference: WritingPreference,
  changeKind: "edited" | "enabled" | "disabled" | "deleted" | "evidence_updated",
): Promise<void> {
  await transaction.execute(
    `INSERT INTO writing_preference_revisions (
       preference_id, revision, preference_text, enabled, evidence_count,
       deleted_at, change_kind, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      preference.id,
      preference.revision,
      preference.preferenceText,
      preference.enabled ? 1 : 0,
      preference.evidenceCount,
      preference.deletedAt,
      changeKind,
      preference.updatedAt,
    ],
  );
}

function classifyPreferenceChange(
  current: WritingPreference,
  next: WritingPreference,
): "edited" | "enabled" | "disabled" | "deleted" | "evidence_updated" {
  if (next.deletedAt !== null) return "deleted";
  if (current.enabled !== next.enabled) return next.enabled ? "enabled" : "disabled";
  if (current.preferenceText !== next.preferenceText) return "edited";
  return "evidence_updated";
}

function preferenceFromRow(row: PreferenceRow): WritingPreference {
  return normalizePreference({
    ...row,
    enabled: row.enabled === 1,
    source: row.source as WritingPreference["source"],
    sourceFeedbackCode: row.sourceFeedbackCode as WritingFeedbackCode | null,
  });
}

function defaultPolicy(projectId: string): WritingFeedbackPolicy {
  return Object.freeze({
    projectId,
    learningEnabled: true,
    revision: 0,
    createdAt: null,
    updatedAt: null,
  });
}

function normalizePolicy(value: WritingFeedbackPolicy): WritingFeedbackPolicy {
  const projectId = validateUuid(value.projectId, "project id");
  if (
    typeof value.learningEnabled !== "boolean" ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    (value.revision === 0 && (value.createdAt !== null || value.updatedAt !== null)) ||
    (value.revision > 0 && (value.createdAt === null || value.updatedAt === null))
  ) {
    throw invalid("写作偏好学习设置无效。");
  }
  const createdAt = value.createdAt === null ? null : validateTimestamp(value.createdAt);
  const updatedAt = value.updatedAt === null ? null : validateTimestamp(value.updatedAt);
  if (createdAt !== null && updatedAt !== null && updatedAt < createdAt) {
    throw invalid("写作偏好学习设置时间顺序无效。");
  }
  return Object.freeze({ ...value, projectId, createdAt, updatedAt });
}

function normalizeEvent(value: WritingFeedbackEvent | EventRow): WritingFeedbackEvent {
  const id = validateUuid(value.id, "feedback id");
  const projectId = validateUuid(value.projectId, "project id");
  const chapterId = value.chapterId === null ? null : validateUuid(value.chapterId, "chapter id");
  const candidateId =
    value.candidateId === null ? null : validateUuid(value.candidateId, "candidate id");
  if (!WRITING_FEEDBACK_ACTIONS.includes(value.action as WritingFeedbackAction)) {
    throw invalid("写作反馈动作无效。");
  }
  const action = value.action as WritingFeedbackAction;
  const feedbackCode =
    value.feedbackCode === null
      ? null
      : WRITING_FEEDBACK_CODES.includes(value.feedbackCode as WritingFeedbackCode)
        ? (value.feedbackCode as WritingFeedbackCode)
        : (() => {
            throw invalid("写作反馈选项无效。");
          })();
  const customFeedback = normalizeOptionalText(value.customFeedback, 1_000);
  const applicationStrategy =
    value.applicationStrategy === null
      ? null
      : CANDIDATE_APPLICATION_STRATEGIES.includes(
            value.applicationStrategy as RecordedCandidateApplicationStrategy,
          )
        ? (value.applicationStrategy as RecordedCandidateApplicationStrategy)
        : (() => {
            throw invalid("候选应用方式无效。");
          })();
  const acceptedChangeCount = normalizeOptionalCount(value.acceptedChangeCount);
  const rejectedChangeCount = normalizeOptionalCount(value.rejectedChangeCount);
  if (action === "explicit_feedback" && feedbackCode === null && customFeedback === null) {
    throw invalid("明确反馈必须包含一个选项或自定义意见。");
  }
  return Object.freeze({
    id,
    projectId,
    chapterId,
    candidateId,
    action,
    feedbackCode,
    customFeedback,
    applicationStrategy,
    acceptedChangeCount,
    rejectedChangeCount,
    createdAt: validateTimestamp(value.createdAt),
  });
}

function normalizePreference(value: WritingPreference): WritingPreference {
  const source: unknown = value.source;
  if (source !== "manual" && source !== "feedback_pattern") {
    throw invalid("写作偏好来源无效。");
  }
  const sourceFeedbackCode =
    value.sourceFeedbackCode === null
      ? null
      : WRITING_FEEDBACK_CODES.includes(value.sourceFeedbackCode)
        ? value.sourceFeedbackCode
        : (() => {
            throw invalid("写作偏好来源选项无效。");
          })();
  if (
    (source === "manual" && sourceFeedbackCode !== null) ||
    (source === "feedback_pattern" && sourceFeedbackCode === null)
  ) {
    throw invalid("写作偏好来源与反馈选项不一致。");
  }
  const preferenceText = normalizeRequiredText(value.preferenceText, 500);
  const createdAt = validateTimestamp(value.createdAt);
  const updatedAt = validateTimestamp(value.updatedAt);
  const deletedAt = value.deletedAt === null ? null : validateTimestamp(value.deletedAt);
  if (
    !Number.isInteger(value.evidenceCount) ||
    value.evidenceCount < 0 ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.enabled !== "boolean" ||
    updatedAt < createdAt ||
    (deletedAt !== null && deletedAt < createdAt)
  ) {
    throw invalid("写作偏好记录无效。");
  }
  return Object.freeze({
    ...value,
    id: validateUuid(value.id, "preference id"),
    projectId: validateUuid(value.projectId, "project id"),
    preferenceText,
    source,
    sourceFeedbackCode,
    createdAt,
    updatedAt,
    deletedAt,
  });
}

function validateUuid(value: string, label: string): string {
  if (!UUID_V7_PATTERN.test(value)) throw invalid(`${label} 无效。`);
  return value.toLowerCase();
}

function validateTimestamp(value: string): string {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw invalid("时间格式无效。");
  }
  return value;
}

function validateLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAXIMUM_EVENT_LIMIT) {
    throw invalid("反馈记录数量范围无效。");
  }
  return value;
}

function normalizeOptionalCount(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw invalid("变更数量无效。");
  return value;
}

function normalizeRequiredText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || normalized.includes("\0")) {
    throw invalid("写作偏好内容无效。");
  }
  return normalized;
}

function normalizeOptionalText(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  return normalizeRequiredText(value, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw corrupt();
  return value;
}

function invalid(message: string): WritingFeedbackStoreError {
  return new WritingFeedbackStoreError("WRITING_FEEDBACK_INVALID", message);
}

function conflict(message: string): WritingFeedbackStoreError {
  return new WritingFeedbackStoreError("WRITING_FEEDBACK_CONFLICT", message, true);
}

function notFound(): WritingFeedbackStoreError {
  return new WritingFeedbackStoreError("WRITING_FEEDBACK_NOT_FOUND", "找不到这条写作偏好。");
}

function corrupt(): WritingFeedbackStoreError {
  return new WritingFeedbackStoreError(
    "WRITING_FEEDBACK_CORRUPT",
    "写作反馈存储无法通过完整性检查。",
  );
}

function normalizeFailure(cause: unknown, fallback: string): WritingFeedbackStoreError {
  if (cause instanceof WritingFeedbackStoreError) return cause;
  const message = cause instanceof Error ? cause.message : "";
  if (/UNIQUE|constraint|revision|already exists/iu.test(message)) {
    return conflict("写作反馈已发生变化，请刷新后重试。");
  }
  return new WritingFeedbackStoreError("WRITING_FEEDBACK_UNAVAILABLE", fallback, true);
}
