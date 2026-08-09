import type { ContentHasher } from "@inkshadow/application";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import {
  preflightStorySettings,
  serializeStorySettings,
  type InkShadowStorySettingsV1,
  type StorySettingsCharacter,
  type StorySettingsWorldRule,
} from "@inkshadow/import-export";
import {
  FormalStoryRecord,
  MemoryRecord,
  StoryFact,
  hydrateFormalRecord,
  insertFormalRecord,
  insertMemoryRecord,
  insertNewStoryFact,
  updateFormalRecord,
  type Clock,
  type FormalRecordRow,
  type UuidV7Generator,
} from "@inkshadow/story-core";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO_UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type StorySettingsConflictAction = "merge" | "new_copy" | "use_import" | "keep_current";

export interface StorySettingsConflictResolution {
  readonly action: StorySettingsConflictAction;
  readonly existingRecordId?: string;
  readonly expectedRevision?: number;
  readonly expectedCurrentVersion?: number;
  readonly copyName?: string;
}

export interface StorySettingsImportResolutions {
  readonly characters?: Readonly<Record<string, StorySettingsConflictResolution>>;
  readonly worldRules?: Readonly<Record<string, StorySettingsConflictResolution>>;
}

export interface StorySettingsImportCommand {
  readonly operationId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly bundle: InkShadowStorySettingsV1;
  readonly resolutions?: StorySettingsImportResolutions;
  readonly legacyRepairSource?: StorySettingsLegacyRepairSource;
  readonly humanConfirmed: boolean;
}

export interface StorySettingsLegacyRepairSource {
  readonly kind: "fact" | "record";
  readonly sourceId: string;
  readonly expectedRevision: number;
}

export interface StorySettingsLegacyRepairRelationship {
  readonly relationshipFactId: string;
  /** The source revision the already-committed relationship was originally confirmed against. */
  readonly expectedSourceRevision: number;
}

export interface StorySettingsImportReceipt {
  readonly id: string;
  readonly projectId: string;
  readonly sourceSha256: string;
  readonly status: "committed" | "undone";
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly createdRecordIds: readonly string[];
  readonly updatedRecordFences: readonly StorySettingsUpdatedRecordFence[];
  readonly createdFactIds: readonly string[];
  readonly createdMemoryIds: readonly string[];
  readonly createdAt: string;
  readonly undoneAt: string | null;
  readonly idempotentReplay: boolean;
}

export interface StorySettingsUpdatedRecordFence {
  readonly id: string;
  readonly revisionAfterImport: number;
  readonly versionBeforeImport: number;
}

interface StorySettingsImportReceiptRow {
  id: string;
  project_id: string;
  source_sha256: string;
  request_sha256: string;
  status: string;
  created_record_ids_json: string;
  updated_record_fences_json: string;
  created_fact_ids_json: string;
  created_memory_ids_json: string;
  imported_count: number;
  skipped_count: number;
  created_at: string;
  undone_at: string | null;
}

export class StorySettingsImportError extends Error {
  public readonly retryable: boolean;

  public constructor(
    public readonly code:
      | "STORY_SETTINGS_CONFIRMATION_REQUIRED"
      | "STORY_SETTINGS_INVALID"
      | "STORY_SETTINGS_CONFLICT_UNRESOLVED"
      | "STORY_SETTINGS_CONFLICT_CHANGED"
      | "STORY_SETTINGS_PROJECT_NOT_ACTIVE"
      | "STORY_SETTINGS_IMPORT_NOT_FOUND"
      | "STORY_SETTINGS_UNDO_CONFLICT"
      | "STORY_SETTINGS_IMPORT_FAILED",
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StorySettingsImportError";
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Applies a strict Story Settings bundle as one SQLite transaction. The user
 * must have confirmed the dry-run and every name conflict before this service
 * is called. A durable receipt makes the commit idempotent and recoverable.
 */
export class StorySettingsImportService {
  public constructor(
    private readonly options: Readonly<{
      executor: SqlExecutor;
      ids: UuidV7Generator;
      clock: Clock;
      hasher: ContentHasher;
    }>,
  ) {}

  public async findLegacyRepairRelationship(input: {
    readonly projectId: string;
    readonly source: StorySettingsLegacyRepairSource;
  }): Promise<StorySettingsLegacyRepairRelationship | null> {
    const source = validateLegacyRepairSource(input.source, 1);
    if (source === null) return null;
    return findSupersedingRelationshipFact(this.options.executor, input.projectId, source);
  }

  public async listRecentReceipts(
    projectId: string,
    limit: number,
  ): Promise<readonly StorySettingsImportReceipt[]> {
    if (
      !UUID_V7_PATTERN.test(projectId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new StorySettingsImportError("STORY_SETTINGS_INVALID", "最近导入记录的查询范围无效。");
    }
    const rows = await this.options.executor.select<StorySettingsImportReceiptRow>(
      `${RECEIPT_SELECT}
       WHERE project_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [projectId, limit],
    );
    return Object.freeze(rows.map((row) => hydrateReceipt(row, false)));
  }

  public async import(command: StorySettingsImportCommand): Promise<StorySettingsImportReceipt> {
    if (!command.humanConfirmed) {
      throw new StorySettingsImportError(
        "STORY_SETTINGS_CONFIRMATION_REQUIRED",
        "导入故事设定前需要明确确认预检结果。",
      );
    }
    const validated = preflightStorySettings(command.bundle);
    if (validated.status === "blocked" || validated.candidate === undefined) {
      throw new StorySettingsImportError(
        "STORY_SETTINGS_INVALID",
        "故事设定包没有通过结构、引用或数据量校验。",
      );
    }
    const candidate = validated.candidate;
    const legacyRepairSource = validateLegacyRepairSource(
      command.legacyRepairSource,
      candidate.relationships.length,
    );
    const canonicalBundle = serializeStorySettings(candidate);
    const sourceHash = await this.options.hasher.sha256(canonicalBundle);
    if (!sourceHash.ok || !SHA256_PATTERN.test(String(sourceHash.value))) {
      throw new StorySettingsImportError(
        "STORY_SETTINGS_INVALID",
        "无法为经过预检的设定包生成可信校验值。",
      );
    }
    const sourceSha256 = String(sourceHash.value);
    const requestHash = await this.options.hasher.sha256(
      JSON.stringify({
        schemaVersion: 1,
        sourceSha256,
        resolutions: canonicalResolutions(command.resolutions),
        legacyRepairSource,
      }),
    );
    if (!requestHash.ok || !SHA256_PATTERN.test(String(requestHash.value))) {
      throw new StorySettingsImportError(
        "STORY_SETTINGS_INVALID",
        "无法为本次冲突决议生成可信校验值。",
      );
    }
    const requestSha256 = String(requestHash.value);

    return this.options.executor
      .transaction(async (transaction) => {
        await assertActiveProject(transaction, command.projectId);
        const replay = await selectReceiptById(transaction, command.operationId);
        if (replay !== null) {
          if (
            replay.project_id !== command.projectId ||
            replay.source_sha256 !== sourceSha256 ||
            replay.request_sha256 !== requestSha256
          ) {
            throw new StorySettingsImportError(
              "STORY_SETTINGS_CONFLICT_CHANGED",
              "同一导入操作编号已用于不同内容或决议，请重新开始导入。",
            );
          }
          return hydrateReceipt(replay, true);
        }

        const now = this.options.clock.now();
        const existingRecords = await selectFormalRecords(transaction, command.projectId);
        if (legacyRepairSource !== null) {
          const supersedingFactId = await findSupersedingRelationshipFact(
            transaction,
            command.projectId,
            legacyRepairSource,
          );
          if (supersedingFactId !== null) {
            throw new StorySettingsImportError(
              "STORY_SETTINGS_CONFLICT_CHANGED",
              "这条旧关系已有可追溯的新版本；请返回待整理列表继续收尾，避免重复创建。",
            );
          }
        }
        const createdRecordIds: string[] = [];
        const updatedRecordFences: StorySettingsUpdatedRecordFence[] = [];
        const createdFactIds: string[] = [];
        const createdMemoryIds: string[] = [];
        const characterReferences = new Map<string, string>();
        const reservedCharacterNames = collectReservedNames(existingRecords, "character");
        const reservedWorldRuleNames = collectReservedNames(existingRecords, "world_rule");
        let importedCount = 0;
        let skippedCount = 0;

        for (const character of candidate.characters) {
          const matches = findCharacterRecordMatches(existingRecords, character);
          if (matches.length > 1) {
            throw new StorySettingsImportError(
              "STORY_SETTINGS_CONFLICT_CHANGED",
              `人物“${character.name}”的名称或别名对应多条现有记录，无法无歧义地应用导入决议。`,
            );
          }
          const existing = matches[0] ?? null;
          const resolution = command.resolutions?.characters?.[character.id];
          const applied = await applyPortableRecord({
            transaction,
            projectId: command.projectId,
            actorId: command.actorId,
            now,
            kind: "character",
            portableId: character.id,
            displayName: character.name,
            value: characterValue(character),
            existing,
            resolution,
            ids: this.options.ids,
            reservedNames: reservedCharacterNames,
          });
          reservePortableNames(reservedCharacterNames, applied.displayName, applied.aliases);
          characterReferences.set(character.id, applied.recordId);
          if (applied.kind === "created") createdRecordIds.push(applied.recordId);
          if (applied.kind === "updated") updatedRecordFences.push(applied.fence);
          if (applied.kind === "skipped") {
            skippedCount += 1;
          } else {
            importedCount += 1;
          }
        }

        for (const rule of candidate.worldRules) {
          const existing = findRecordByDisplayName(existingRecords, "world_rule", rule.title);
          const applied = await applyPortableRecord({
            transaction,
            projectId: command.projectId,
            actorId: command.actorId,
            now,
            kind: "world_rule",
            portableId: rule.id,
            displayName: rule.title,
            value: worldRuleValue(rule),
            existing,
            resolution: command.resolutions?.worldRules?.[rule.id],
            ids: this.options.ids,
            reservedNames: reservedWorldRuleNames,
          });
          reservePortableNames(reservedWorldRuleNames, applied.displayName, applied.aliases);
          if (applied.kind === "created") createdRecordIds.push(applied.recordId);
          if (applied.kind === "updated") updatedRecordFences.push(applied.fence);
          if (applied.kind === "skipped") {
            skippedCount += 1;
          } else {
            importedCount += 1;
          }
        }

        for (const relationship of candidate.relationships) {
          const from = characterReferences.get(relationship.fromCharacterRef);
          const to = characterReferences.get(relationship.toCharacterRef);
          if (from === undefined || to === undefined || from === to) {
            throw new StorySettingsImportError(
              "STORY_SETTINGS_INVALID",
              `关系“${relationship.relationshipType}”的两端人物无法安全关联。`,
            );
          }
          const fact = requireResult(
            StoryFact.create({
              id: this.options.ids.next(),
              projectId: command.projectId,
              factType: "core_relationship",
              contentText: `${relationship.relationshipType}：${relationship.fromCharacterRef} ↔ ${relationship.toCharacterRef}`,
              structuredValue: {
                schemaVersion: "inkshadow.character-relationship.v1",
                fromCharacterId: from,
                toCharacterId: to,
                relationshipType: relationship.relationshipType,
                since: relationship.since ?? null,
                publicStatus: relationship.publicStatus ?? null,
                privateStatus: relationship.privateStatus ?? null,
                currentChange: relationship.currentChange ?? null,
                evidence: relationship.evidence ?? null,
                ...(legacyRepairSource === null
                  ? {}
                  : {
                      legacyRepair: {
                        schemaVersion: "inkshadow.legacy-relationship-repair.v1",
                        supersedesKind: legacyRepairSource.kind,
                        supersedesSourceId: legacyRepairSource.sourceId,
                        expectedSourceRevision: legacyRepairSource.expectedRevision,
                      },
                    }),
              },
              source: {
                kind: "import_source",
                reference: importReference(sourceSha256, "relationships", relationship.id),
              },
              confidence: 1,
              status: "formal",
              origin: "user",
              needsReview: false,
              locked: false,
              humanConfirmed: true,
              confirmationActorId: command.actorId,
              now,
            }),
          );
          await insertNewStoryFact(transaction, fact);
          createdFactIds.push(fact.id);
          importedCount += 1;
        }

        for (const preference of candidate.writingPreferences) {
          const fact = requireResult(
            StoryFact.create({
              id: this.options.ids.next(),
              projectId: command.projectId,
              factType: "writing_rule",
              contentText: preference.content,
              structuredValue: {
                schemaVersion: "inkshadow.writing-preference.v1",
                content: preference.content,
                source: preference.source ?? null,
              },
              source: {
                kind: "import_source",
                reference: importReference(sourceSha256, "writingPreferences", preference.id),
              },
              confidence: 1,
              status: "formal",
              origin: "user",
              needsReview: false,
              locked: false,
              humanConfirmed: true,
              confirmationActorId: command.actorId,
              now,
            }),
          );
          await insertNewStoryFact(transaction, fact);
          createdFactIds.push(fact.id);
          importedCount += 1;
        }

        for (const memory of candidate.memories) {
          const record = requireResult(
            MemoryRecord.create({
              id: this.options.ids.next(),
              projectId: command.projectId,
              level: memory.level,
              content: memory.content,
              source: {
                kind: "import",
                sourceId: command.operationId,
                sourceVersionId: null,
              },
              origin: "user",
              now,
            }),
          );
          await insertMemoryRecord(transaction, record.toSnapshot());
          createdMemoryIds.push(record.id);
          importedCount += 1;
        }

        await transaction.execute(
          `INSERT INTO story_settings_import_receipts (
             id, project_id, source_sha256, request_sha256, status,
             created_record_ids_json, updated_record_fences_json,
             created_fact_ids_json, created_memory_ids_json,
             imported_count, skipped_count, created_at, undone_at
           ) VALUES (?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            command.operationId,
            command.projectId,
            sourceSha256,
            requestSha256,
            JSON.stringify(createdRecordIds),
            JSON.stringify(updatedRecordFences),
            JSON.stringify(createdFactIds),
            JSON.stringify(createdMemoryIds),
            importedCount,
            skippedCount,
            now,
          ],
        );
        const committed = await selectReceiptById(transaction, command.operationId);
        if (committed === null) {
          throw new StorySettingsImportError(
            "STORY_SETTINGS_IMPORT_FAILED",
            "导入事务已提交但无法读取导入收据。",
            { retryable: true },
          );
        }
        return hydrateReceipt(committed, false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof StorySettingsImportError) throw cause;
        throw new StorySettingsImportError(
          "STORY_SETTINGS_IMPORT_FAILED",
          "故事设定未写入；本次事务已回滚，可以修复后重试。",
          { retryable: true, cause },
        );
      });
  }

  public undo(
    input: Readonly<{
      receiptId: string;
      projectId: string;
      actorId: string;
      humanConfirmed: boolean;
    }>,
  ): Promise<StorySettingsImportReceipt> {
    if (!input.humanConfirmed) {
      return Promise.reject(
        new StorySettingsImportError(
          "STORY_SETTINGS_CONFIRMATION_REQUIRED",
          "撤销导入前需要明确确认。",
        ),
      );
    }
    return this.options.executor
      .transaction(async (transaction) => {
        await assertActiveProject(transaction, input.projectId);
        const row = await selectReceiptById(transaction, input.receiptId);
        if (row?.project_id !== input.projectId) {
          throw new StorySettingsImportError(
            "STORY_SETTINGS_IMPORT_NOT_FOUND",
            "找不到这次故事设定导入。",
          );
        }
        if (row.status === "undone") return hydrateReceipt(row, true);
        const receipt = hydrateReceipt(row, false);
        const now = this.options.clock.now();
        await assertUndoFences(transaction, receipt);

        for (const factId of receipt.createdFactIds) {
          await deleteExactlyOnce(
            transaction,
            `DELETE FROM story_facts WHERE id = ? AND project_id = ? AND revision = 1`,
            [factId, input.projectId],
          );
        }
        for (const memoryId of receipt.createdMemoryIds) {
          await deleteExactlyOnce(
            transaction,
            `DELETE FROM story_memory_records WHERE id = ? AND project_id = ? AND revision = 1`,
            [memoryId, input.projectId],
          );
        }
        for (const recordId of receipt.createdRecordIds) {
          await deleteExactlyOnce(
            transaction,
            `DELETE FROM story_formal_records WHERE id = ? AND project_id = ? AND revision = 1`,
            [recordId, input.projectId],
          );
        }
        for (const fence of receipt.updatedRecordFences) {
          const current = await selectFormalRecordById(transaction, input.projectId, fence.id);
          if (current?.revision !== fence.revisionAfterImport) {
            throw undoConflict();
          }
          const undone = requireResult(
            current.undo({
              targetVersion: fence.versionBeforeImport,
              actorId: input.actorId,
              humanConfirmed: true,
              expectedRevision: current.revision,
              now,
            }),
          );
          await updateFormalRecord(transaction, undone, current.revision);
        }
        const updated = await transaction.execute(
          `UPDATE story_settings_import_receipts
           SET status = 'undone', undone_at = ?
           WHERE id = ? AND project_id = ? AND status = 'committed'`,
          [now, input.receiptId, input.projectId],
        );
        if (updated.rowsAffected !== 1) throw undoConflict();
        const undoneRow = await selectReceiptById(transaction, input.receiptId);
        if (undoneRow === null) throw undoConflict();
        return hydrateReceipt(undoneRow, false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof StorySettingsImportError) throw cause;
        throw new StorySettingsImportError(
          "STORY_SETTINGS_IMPORT_FAILED",
          "撤销未完成；原有设定保持不变。",
          { retryable: true, cause },
        );
      });
  }
}

async function assertActiveProject(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<void> {
  const rows = await transaction.select<{ status: string }>(
    "SELECT status FROM projects WHERE id = ? LIMIT 1",
    [projectId],
  );
  if (rows[0]?.status !== "active") {
    throw new StorySettingsImportError(
      "STORY_SETTINGS_PROJECT_NOT_ACTIVE",
      "当前项目不存在、已归档或位于回收站，故事设定保持只读。",
    );
  }
}

async function applyPortableRecord(
  input: Readonly<{
    transaction: TransactionExecutor;
    projectId: string;
    actorId: string;
    now: string;
    kind: "character" | "world_rule";
    portableId: string;
    displayName: string;
    value: Readonly<Record<string, unknown>>;
    existing: FormalStoryRecord | null;
    resolution: StorySettingsConflictResolution | undefined;
    ids: UuidV7Generator;
    reservedNames: Set<string>;
  }>,
): Promise<
  | Readonly<{
      kind: "created";
      recordId: string;
      displayName: string;
      aliases: readonly string[];
    }>
  | Readonly<{
      kind: "updated";
      recordId: string;
      displayName: string;
      aliases: readonly string[];
      fence: StorySettingsUpdatedRecordFence;
    }>
  | Readonly<{
      kind: "skipped";
      recordId: string;
      displayName: string;
      aliases: readonly string[];
    }>
> {
  if (input.existing === null) {
    const created = createPortableRecord(input, input.displayName);
    await insertFormalRecord(input.transaction, created);
    return Object.freeze({
      kind: "created",
      recordId: created.id,
      displayName: input.displayName,
      aliases: input.kind === "character" ? stringList(input.value.aliases) : [],
    });
  }
  const resolution = input.resolution;
  if (resolution === undefined) {
    throw new StorySettingsImportError(
      "STORY_SETTINGS_CONFLICT_UNRESOLVED",
      `“${input.displayName}”已存在，请先选择合并、新建副本、使用导入内容或保留当前内容。`,
    );
  }
  if (
    resolution.existingRecordId !== undefined &&
    resolution.existingRecordId !== input.existing.id
  ) {
    throw new StorySettingsImportError(
      "STORY_SETTINGS_CONFLICT_CHANGED",
      `“${input.displayName}”的现有记录已变化，请重新预检。`,
      { retryable: true },
    );
  }
  if (
    resolution.action !== "new_copy" &&
    (resolution.existingRecordId !== input.existing.id ||
      resolution.expectedRevision !== input.existing.revision ||
      resolution.expectedCurrentVersion !== input.existing.toSnapshot().currentVersion)
  ) {
    throw new StorySettingsImportError(
      "STORY_SETTINGS_CONFLICT_CHANGED",
      `“${input.displayName}”在预检后已变化，请重新预检再确认。`,
      { retryable: true },
    );
  }
  if (resolution.action === "keep_current") {
    return Object.freeze({
      kind: "skipped",
      recordId: input.existing.id,
      displayName: recordDisplayName(input.existing),
      aliases: recordAliases(input.existing),
    });
  }
  if (resolution.action === "new_copy") {
    const requestedCopyName = resolution.copyName?.trim();
    const baseCopyName =
      requestedCopyName === undefined || requestedCopyName.length === 0
        ? `${input.displayName}（导入副本）`
        : requestedCopyName;
    const copyName = allocateUniqueName(baseCopyName, input.reservedNames);
    const copyValue =
      input.kind === "character"
        ? {
            ...input.value,
            aliases: stringList(input.value.aliases).filter(
              (alias) => !input.reservedNames.has(normalizeDisplayName(alias)),
            ),
          }
        : input.value;
    const created = createPortableRecord({ ...input, value: copyValue }, copyName);
    await insertFormalRecord(input.transaction, created);
    return Object.freeze({
      kind: "created",
      recordId: created.id,
      displayName: copyName,
      aliases: input.kind === "character" ? stringList(copyValue.aliases) : [],
    });
  }
  const snapshot = input.existing.toSnapshot();
  const currentValue = storyObject(input.existing.currentValue);
  const nextValue =
    resolution.action === "merge" ? mergeStoryObjects(currentValue, input.value) : input.value;
  if (JSON.stringify(currentValue) === JSON.stringify(nextValue)) {
    return Object.freeze({
      kind: "skipped",
      recordId: input.existing.id,
      displayName: recordDisplayName(input.existing),
      aliases: recordAliases(input.existing),
    });
  }
  const changed = requireResult(
    input.existing.editManually({
      value: nextValue,
      actorId: input.actorId,
      humanConfirmed: true,
      expectedRevision: input.existing.revision,
      now: input.now,
    }),
  );
  await updateFormalRecord(input.transaction, changed, input.existing.revision);
  return Object.freeze({
    kind: "updated",
    recordId: changed.id,
    displayName: recordDisplayName(changed),
    aliases: recordAliases(changed),
    fence: Object.freeze({
      id: changed.id,
      revisionAfterImport: changed.revision,
      versionBeforeImport: snapshot.currentVersion,
    }),
  });
}

function createPortableRecord(
  input: Readonly<{
    projectId: string;
    actorId: string;
    now: string;
    kind: "character" | "world_rule";
    value: Readonly<Record<string, unknown>>;
    ids: UuidV7Generator;
  }>,
  displayName: string,
): FormalStoryRecord {
  const id = input.ids.next();
  return requireResult(
    FormalStoryRecord.create({
      id,
      projectId: input.projectId,
      kind: input.kind,
      recordKey: `${input.kind}.import.${id.replaceAll("-", "")}`,
      value: {
        ...input.value,
        name: displayName,
        ...(input.kind === "world_rule" ? { title: displayName } : {}),
      },
      actorId: input.actorId,
      humanConfirmed: true,
      now: input.now,
    }),
  );
}

function characterValue(character: StorySettingsCharacter): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "inkshadow.character-setting.v1",
    name: character.name,
    role: character.role ?? null,
    aliases: character.aliases,
    shortDescription: character.shortDescription ?? null,
    traits: character.traits,
    currentGoal: character.currentGoal ?? null,
    knownInformation: character.knownInformation,
    currentState: character.currentState ?? null,
    locked: character.locked,
    source: "story_settings_import",
  });
}

function worldRuleValue(rule: StorySettingsWorldRule): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "inkshadow.world-rule-setting.v1",
    title: rule.title,
    rule: rule.rule,
    scope: rule.scope ?? null,
    exceptions: rule.exceptions,
    consequence: rule.consequence ?? null,
    effectiveAt: rule.effectiveAt ?? null,
    evidence: rule.evidence ?? null,
    locked: rule.locked,
    source: "story_settings_import",
  });
}

function findRecordByDisplayName(
  records: readonly FormalStoryRecord[],
  kind: "character" | "world_rule",
  displayName: string,
): FormalStoryRecord | null {
  const normalized = normalizeDisplayName(displayName);
  return (
    records.find((record) => {
      if (record.kind !== kind) return false;
      const value = storyObject(record.currentValue);
      const candidate = stringValue(value[kind === "character" ? "name" : "title"]);
      return candidate !== null && normalizeDisplayName(candidate) === normalized;
    }) ?? null
  );
}

function findCharacterRecordMatches(
  records: readonly FormalStoryRecord[],
  character: StorySettingsCharacter,
): readonly FormalStoryRecord[] {
  const importedNames = new Set([character.name, ...character.aliases].map(normalizeDisplayName));
  return records.filter((record) => {
    if (record.kind !== "character") return false;
    const value = storyObject(record.currentValue);
    const currentNames = [stringValue(value.name), ...stringList(value.aliases)].filter(
      (entry): entry is string => entry !== null,
    );
    return currentNames.some((name) => importedNames.has(normalizeDisplayName(name)));
  });
}

function collectReservedNames(
  records: readonly FormalStoryRecord[],
  kind: "character" | "world_rule",
): Set<string> {
  const reserved = new Set<string>();
  for (const record of records) {
    if (record.kind !== kind) continue;
    const value = storyObject(record.currentValue);
    const names =
      kind === "character"
        ? [stringValue(value.name), ...stringList(value.aliases)]
        : [stringValue(value.title)];
    for (const name of names) {
      if (name !== null) reserved.add(normalizeDisplayName(name));
    }
  }
  return reserved;
}

function reservePortableNames(
  reserved: Set<string>,
  displayName: string,
  aliases: readonly string[],
): void {
  reserved.add(normalizeDisplayName(displayName));
  aliases.forEach((alias) => reserved.add(normalizeDisplayName(alias)));
}

function allocateUniqueName(baseName: string, reserved: ReadonlySet<string>): string {
  if (!reserved.has(normalizeDisplayName(baseName))) return baseName;
  let suffix = 2;
  while (reserved.has(normalizeDisplayName(`${baseName}（${String(suffix)}）`))) suffix += 1;
  return `${baseName}（${String(suffix)}）`;
}

function recordDisplayName(record: FormalStoryRecord): string {
  const value = storyObject(record.currentValue);
  return (
    stringValue(value[record.kind === "world_rule" ? "title" : "name"]) ??
    String(record.toSnapshot().recordKey)
  );
}

function recordAliases(record: FormalStoryRecord): readonly string[] {
  return record.kind === "character" ? stringList(storyObject(record.currentValue).aliases) : [];
}

function mergeStoryObjects(
  current: Readonly<Record<string, unknown>>,
  imported: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(imported)) {
    const previous = merged[key];
    merged[key] =
      isUnknownArray(previous) && isUnknownArray(value)
        ? [
            ...new Set(
              [...previous, ...value].filter((item): item is string => typeof item === "string"),
            ),
          ]
        : value === null || value === ""
          ? (previous ?? value)
          : value;
  }
  return Object.freeze(merged);
}

async function selectFormalRecords(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<readonly FormalStoryRecord[]> {
  const rows = await transaction.select<FormalRecordRow>(
    `SELECT id, project_id, kind, record_key, revision, current_version, snapshot_json
     FROM story_formal_records
     WHERE project_id = ?
     ORDER BY kind ASC, updated_at DESC, id ASC`,
    [projectId],
  );
  return Object.freeze(rows.map(hydrateFormalRecord));
}

async function selectFormalRecordById(
  transaction: TransactionExecutor,
  projectId: string,
  recordId: string,
): Promise<FormalStoryRecord | null> {
  const rows = await transaction.select<FormalRecordRow>(
    `SELECT id, project_id, kind, record_key, revision, current_version, snapshot_json
     FROM story_formal_records
     WHERE project_id = ? AND id = ?`,
    [projectId, recordId],
  );
  return rows[0] === undefined ? null : hydrateFormalRecord(rows[0]);
}

async function assertUndoFences(
  transaction: TransactionExecutor,
  receipt: StorySettingsImportReceipt,
): Promise<void> {
  for (const [table, ids] of [
    ["story_facts", receipt.createdFactIds],
    ["story_memory_records", receipt.createdMemoryIds],
    ["story_formal_records", receipt.createdRecordIds],
  ] as const) {
    for (const id of ids) {
      const rows = await transaction.select<{ revision: number }>(
        `SELECT revision FROM ${table} WHERE id = ? AND project_id = ?`,
        [id, receipt.projectId],
      );
      if (rows[0]?.revision !== 1) throw undoConflict();
    }
  }
  for (const fence of receipt.updatedRecordFences) {
    const current = await selectFormalRecordById(transaction, receipt.projectId, fence.id);
    if (current?.revision !== fence.revisionAfterImport) throw undoConflict();
  }

  if (receipt.createdFactIds.length > 0) {
    const importedFacts = await transaction.select<{ id: string; value_json: string | null }>(
      `SELECT id, value_json FROM story_facts WHERE project_id = ? AND id IN (${receipt.createdFactIds.map(() => "?").join(", ")})`,
      [receipt.projectId, ...receipt.createdFactIds],
    );
    const formalRows = await transaction.select<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM story_formal_records WHERE project_id = ?`,
      [receipt.projectId],
    );
    for (const imported of importedFacts) {
      if (
        formalRows.some(({ snapshot_json }) =>
          containsExactString(safeJson(snapshot_json), imported.id),
        )
      ) {
        throw new StorySettingsImportError(
          "STORY_SETTINGS_UNDO_CONFLICT",
          "旧版设定已经引用了导入后补全的关系；请使用版本历史或导入前备份整体回退。",
        );
      }
      if (imported.value_json === null) continue;
      const repair = storyObject(storyObject(safeJson(imported.value_json)).legacyRepair);
      if (stringValue(repair.supersedesKind) !== "fact") continue;
      const sourceId = stringValue(repair.supersedesSourceId);
      if (sourceId === null) continue;
      const sources = await transaction.select<{ deprecated: number }>(
        `SELECT deprecated FROM story_facts WHERE project_id = ? AND id = ?`,
        [receipt.projectId, sourceId],
      );
      if (sources[0]?.deprecated === 1) {
        throw new StorySettingsImportError(
          "STORY_SETTINGS_UNDO_CONFLICT",
          "旧关系事实已经完成停用；请使用导入前备份整体回退，避免留下不完整故事状态。",
        );
      }
    }
  }

  if (receipt.createdRecordIds.length > 0) {
    const facts = await transaction.select<{ id: string; value_json: string | null }>(
      `SELECT id, value_json FROM story_facts
       WHERE project_id = ? AND deprecated = 0`,
      [receipt.projectId],
    );
    const importedFacts = new Set(receipt.createdFactIds);
    for (const row of facts) {
      if (importedFacts.has(row.id) || row.value_json === null) continue;
      const value = safeJson(row.value_json);
      if (receipt.createdRecordIds.some((id) => containsExactString(value, id))) {
        throw new StorySettingsImportError(
          "STORY_SETTINGS_UNDO_CONFLICT",
          "导入后已有其他故事事实引用了新人物；请先处理引用或使用导入前备份恢复。",
        );
      }
    }
    const formalRows = await transaction.select<{ id: string; snapshot_json: string }>(
      `SELECT id, snapshot_json FROM story_formal_records WHERE project_id = ?`,
      [receipt.projectId],
    );
    const importedRecords = new Set(receipt.createdRecordIds);
    for (const row of formalRows) {
      if (importedRecords.has(row.id)) continue;
      const value = safeJson(row.snapshot_json);
      if (receipt.createdRecordIds.some((id) => containsExactString(value, id))) {
        throw new StorySettingsImportError(
          "STORY_SETTINGS_UNDO_CONFLICT",
          "导入后已有其他正式设定引用了新人物；请先处理引用或使用导入前快照恢复。",
        );
      }
    }
    await assertNoColumnReferences(transaction, {
      table: "story_review_items",
      column: "target_record_id",
      ids: receipt.createdRecordIds,
      message: "导入后已有待确认变化引用了新人物，无法直接撤销。",
    });
    await assertNoColumnReferences(transaction, {
      table: "authoritative_extraction_candidates",
      column: "target_record_id",
      ids: receipt.createdRecordIds,
      message: "导入后已有正文识别候选引用了新人物，无法直接撤销。",
    });
  }
  if (receipt.createdMemoryIds.length > 0) {
    await assertNoColumnReferences(transaction, {
      table: "story_memory_governance_events",
      column: "target_record_id",
      ids: receipt.createdMemoryIds,
      message: "导入后的记忆已参与合并或遗忘记录，无法直接撤销。",
    });
  }
}

async function deleteExactlyOnce(
  transaction: TransactionExecutor,
  query: string,
  values: readonly (string | number | null | Uint8Array)[],
): Promise<void> {
  try {
    const deleted = await transaction.execute(query, values);
    if (deleted.rowsAffected !== 1) throw undoConflict();
  } catch (cause: unknown) {
    if (cause instanceof StorySettingsImportError) throw cause;
    throw new StorySettingsImportError(
      "STORY_SETTINGS_UNDO_CONFLICT",
      "导入内容已被其他本地记录引用，无法直接撤销；当前数据保持不变。",
      { cause },
    );
  }
}

async function assertNoColumnReferences(
  transaction: TransactionExecutor,
  input: Readonly<{
    table: string;
    column: string;
    ids: readonly string[];
    message: string;
  }>,
): Promise<void> {
  if (input.ids.length === 0 || !(await tableExists(transaction, input.table))) return;
  for (const id of input.ids) {
    const rows = await transaction.select<{ present: number }>(
      `SELECT 1 AS present FROM ${input.table} WHERE ${input.column} = ? LIMIT 1`,
      [id],
    );
    if (rows.length > 0) {
      throw new StorySettingsImportError("STORY_SETTINGS_UNDO_CONFLICT", input.message);
    }
  }
}

async function tableExists(transaction: TransactionExecutor, table: string): Promise<boolean> {
  const rows = await transaction.select<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [table],
  );
  return rows.length > 0;
}

function undoConflict(): StorySettingsImportError {
  return new StorySettingsImportError(
    "STORY_SETTINGS_UNDO_CONFLICT",
    "导入后的设定已被继续修改，无法静默撤销；请保留当前内容或使用导入前快照恢复。",
  );
}

async function selectReceiptById(
  transaction: TransactionExecutor,
  id: string,
): Promise<StorySettingsImportReceiptRow | null> {
  const rows = await transaction.select<StorySettingsImportReceiptRow>(
    `${RECEIPT_SELECT} WHERE id = ?`,
    [id],
  );
  return rows[0] ?? null;
}

const RECEIPT_SELECT = `SELECT
  id, project_id, source_sha256, request_sha256, status,
  created_record_ids_json, updated_record_fences_json,
  created_fact_ids_json, created_memory_ids_json,
  imported_count, skipped_count, created_at, undone_at
FROM story_settings_import_receipts`;

function hydrateReceipt(
  row: StorySettingsImportReceiptRow,
  idempotentReplay: boolean,
): StorySettingsImportReceipt {
  const status = row.status === "committed" || row.status === "undone" ? row.status : null;
  if (
    status === null ||
    !UUID_V7_PATTERN.test(row.id) ||
    !UUID_V7_PATTERN.test(row.project_id) ||
    !SHA256_PATTERN.test(row.source_sha256) ||
    !SHA256_PATTERN.test(row.request_sha256) ||
    !Number.isSafeInteger(row.imported_count) ||
    row.imported_count < 0 ||
    row.imported_count > 5_000 ||
    !Number.isSafeInteger(row.skipped_count) ||
    row.skipped_count < 0 ||
    row.skipped_count > 5_000 ||
    !ISO_UTC_MILLISECONDS_PATTERN.test(row.created_at) ||
    (status === "committed" && row.undone_at !== null) ||
    (status === "undone" &&
      (row.undone_at === null || !ISO_UTC_MILLISECONDS_PATTERN.test(row.undone_at)))
  ) {
    throw new Error("Corrupt Story Settings import receipt.");
  }
  const createdRecordIds = parseStringArray(row.created_record_ids_json);
  const updatedRecordFences = parseFences(row.updated_record_fences_json);
  const createdFactIds = parseStringArray(row.created_fact_ids_json);
  const createdMemoryIds = parseStringArray(row.created_memory_ids_json);
  const allIds = [
    ...createdRecordIds,
    ...updatedRecordFences.map(({ id }) => id),
    ...createdFactIds,
    ...createdMemoryIds,
  ];
  if (new Set(allIds).size !== allIds.length) {
    throw new Error("Corrupt Story Settings import receipt identifier overlap.");
  }
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    sourceSha256: row.source_sha256,
    status,
    importedCount: row.imported_count,
    skippedCount: row.skipped_count,
    createdRecordIds,
    updatedRecordFences,
    createdFactIds,
    createdMemoryIds,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
    idempotentReplay,
  });
}

function parseStringArray(value: string): readonly string[] {
  const parsed = toUnknownArray(safeJson(value));
  if (parsed === null || parsed.length > 5_000) {
    throw new Error("Corrupt Story Settings receipt identifier list.");
  }
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed) {
    if (typeof candidate !== "string" || !UUID_V7_PATTERN.test(candidate) || seen.has(candidate)) {
      throw new Error("Corrupt Story Settings receipt identifier list.");
    }
    seen.add(candidate);
    identifiers.push(candidate);
  }
  return Object.freeze(identifiers);
}

function parseFences(value: string): readonly StorySettingsUpdatedRecordFence[] {
  const parsed = toUnknownArray(safeJson(value));
  if (parsed === null || parsed.length > 5_000) {
    throw new Error("Corrupt Story Settings receipt fence list.");
  }
  const seen = new Set<string>();
  return Object.freeze(
    parsed.map((candidate) => {
      const record = storyObject(candidate);
      const revisionAfterImport = record.revisionAfterImport;
      const versionBeforeImport = record.versionBeforeImport;
      if (
        typeof record.id !== "string" ||
        !UUID_V7_PATTERN.test(record.id) ||
        seen.has(record.id) ||
        typeof revisionAfterImport !== "number" ||
        !Number.isSafeInteger(revisionAfterImport) ||
        typeof versionBeforeImport !== "number" ||
        !Number.isSafeInteger(versionBeforeImport) ||
        revisionAfterImport !== versionBeforeImport + 1
      ) {
        throw new Error("Corrupt Story Settings receipt fence.");
      }
      seen.add(record.id);
      return Object.freeze({
        id: record.id,
        revisionAfterImport,
        versionBeforeImport,
      });
    }),
  );
}

function importReference(hash: string, section: string, id: string): string {
  return `story-settings:${hash}:${section}:${id}`;
}

function canonicalResolutions(
  resolutions: StorySettingsImportResolutions | undefined,
): Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> {
  const normalize = (
    values: Readonly<Record<string, StorySettingsConflictResolution>> | undefined,
  ) =>
    Object.entries(values ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, resolution]) =>
        Object.freeze({
          id,
          action: resolution.action,
          existingRecordId: resolution.existingRecordId ?? null,
          expectedRevision: resolution.expectedRevision ?? null,
          expectedCurrentVersion: resolution.expectedCurrentVersion ?? null,
          copyName: resolution.copyName?.trim() ?? null,
        }),
      );
  return Object.freeze({
    characters: Object.freeze(normalize(resolutions?.characters)),
    worldRules: Object.freeze(normalize(resolutions?.worldRules)),
  });
}

function validateLegacyRepairSource(
  source: StorySettingsLegacyRepairSource | undefined,
  relationshipCount: number,
): StorySettingsLegacyRepairSource | null {
  if (source === undefined) return null;
  const sourceKind: unknown = source.kind;
  if (
    (sourceKind !== "fact" && sourceKind !== "record") ||
    !UUID_V7_PATTERN.test(source.sourceId) ||
    !Number.isSafeInteger(source.expectedRevision) ||
    source.expectedRevision < 1 ||
    relationshipCount !== 1
  ) {
    throw new StorySettingsImportError(
      "STORY_SETTINGS_INVALID",
      "旧关系修复来源无效；一次修复必须绑定一个有效来源和一条完整关系。",
    );
  }
  return Object.freeze({ ...source });
}

async function findSupersedingRelationshipFact(
  transaction: Pick<SqlExecutor, "select">,
  projectId: string,
  source: StorySettingsLegacyRepairSource,
): Promise<StorySettingsLegacyRepairRelationship | null> {
  const rows = await transaction.select<{ id: string; value_json: string | null }>(
    `SELECT id, value_json FROM story_facts
     WHERE project_id = ? AND deprecated = 0 AND status = 'formal'
       AND fact_type IN ('relationship', 'core_relationship', 'relationship_change')`,
    [projectId],
  );
  for (const row of rows) {
    if (row.value_json === null) continue;
    const value = storyObject(safeJson(row.value_json));
    const repair = storyObject(value.legacyRepair);
    const from = stringValue(value.fromCharacterId) ?? stringValue(value.fromCharacterRef);
    const to = stringValue(value.toCharacterId) ?? stringValue(value.toCharacterRef);
    const expectedSourceRevision = repair.expectedSourceRevision;
    if (
      stringValue(repair.supersedesKind) === source.kind &&
      stringValue(repair.supersedesSourceId) === source.sourceId &&
      Number.isSafeInteger(expectedSourceRevision) &&
      Number(expectedSourceRevision) >= 1 &&
      from !== null &&
      to !== null &&
      from !== to &&
      stringValue(value.relationshipType) !== null
    ) {
      return Object.freeze({
        relationshipFactId: row.id,
        expectedSourceRevision: Number(expectedSourceRevision),
      });
    }
  }
  return null;
}

function requireResult<Value>(
  result: Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: Error }>,
): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function storyObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : Object.freeze({});
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function normalizeDisplayName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function safeJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function toUnknownArray(value: unknown): readonly unknown[] | null {
  return isUnknownArray(value) ? value : null;
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((item) => containsExactString(item, expected));
}
