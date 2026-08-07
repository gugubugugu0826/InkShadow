import { StoryCoreError } from "../errors.js";
import { FormalStoryRecord, type FormalStoryRecordSnapshot } from "../formal-record.js";
import { MemoryRecord, type MemoryRecordSnapshot } from "../memory.js";
import type { Result } from "../result.js";
import {
  StoryFact,
  STORY_FACT_REVISION_CHANGE_KINDS,
  type StoryFactListFilter,
  type StoryFactRevision,
  type StoryFactRevisionChangeKind,
  type StoryFactSnapshot,
  type StoryFactStatus,
  type StoryFactStore,
} from "../story-fact.js";
import { parseSafeIdentifier, parseUuidV7, type UuidV7 } from "../value-objects.js";
import {
  abortCorruptSnapshot,
  abortPersistence,
  abortRevisionConflict,
  assertNextRevision,
  parseSnapshot,
  runPersistence,
  serializeSnapshot,
} from "./common.js";
import type { StorySqlPrimitive, StorySqlExecutor, StorySqlTransaction } from "./executor.js";

export const LEGACY_STORY_FACT_KINDS = ["formal_record", "memory_record"] as const;
export type LegacyStoryFactKind = (typeof LEGACY_STORY_FACT_KINDS)[number];

export interface StageLegacyStoryFactInput {
  readonly factId: string;
  readonly projectId: string;
  readonly legacyKind: LegacyStoryFactKind;
  readonly legacyId: string;
  readonly now: string;
}

export interface StoryFactLegacyLink {
  readonly factId: UuidV7;
  readonly projectId: UuidV7;
  readonly legacyKind: LegacyStoryFactKind;
  readonly legacyId: UuidV7;
  readonly legacyRevision: number;
  readonly linkMode: "reference" | "backfill";
  readonly createdAt: string;
}

export interface StageLegacyStoryFactReceipt {
  readonly fact: StoryFact;
  readonly link: StoryFactLegacyLink;
  readonly created: boolean;
}

interface StoryFactRow {
  readonly id: string;
  readonly project_id: string;
  readonly fact_type: string;
  readonly content_text: string | null;
  readonly value_json: string | null;
  readonly source_kind: string;
  readonly evidence_reference: string;
  readonly source_chapter_id: string | null;
  readonly source_version_id: string | null;
  readonly source_start_offset: number | null;
  readonly source_end_offset: number | null;
  readonly source_length: number | null;
  readonly source_excerpt: string | null;
  readonly effective_at: string | null;
  readonly invalidated_at: string | null;
  readonly branch_id: string | null;
  readonly confidence: number;
  readonly status: string;
  readonly origin: string;
  readonly user_confirmed: number;
  readonly locked: number;
  readonly deprecated: number;
  readonly needs_review: number;
  readonly confirmed_by_actor_id: string | null;
  readonly confirmed_at: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionRow {
  readonly fact_id: string;
  readonly project_id: string;
  readonly revision: number;
  readonly change_kind: string;
  readonly recorded_at: string;
  readonly snapshot_json: string;
}

interface LegacyLinkRow {
  readonly fact_id: string;
  readonly project_id: string;
  readonly legacy_kind: string;
  readonly legacy_id: string;
  readonly legacy_revision: number;
  readonly link_mode: string;
  readonly created_at: string;
}

interface LegacyFormalRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly revision: number;
  readonly current_version: number;
  readonly snapshot_json: string;
}

interface LegacyMemoryRow {
  readonly id: string;
  readonly project_id: string;
  readonly revision: number;
  readonly snapshot_json: string;
}

interface ChapterVersionRow {
  readonly project_id: string;
  readonly chapter_id: string;
  readonly content: string;
}

/**
 * Unified story-state authority backed by the shared SQLite executor contract.
 * `TauriSqliteExecutor` satisfies this interface structurally; tests use the
 * in-memory Node adapter. Fact identity/content/evidence never mutate in place.
 */
export class SqliteStoryFactStore implements StoryFactStore {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public create(fact: StoryFact): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() => {
      const snapshot = fact.toSnapshot();
      if (snapshot.revision !== 1 || (snapshot.status === "formal" && snapshot.origin !== "user")) {
        abortPersistence(
          validationFailure("A new non-user story fact cannot arrive already formal."),
        );
      }
      return this.executor.transaction(async (transaction) => {
        await assertChapterEvidence(transaction, snapshot);
        await insertFact(transaction, snapshot);
        await insertInitialRevision(transaction, snapshot, "created");
      });
    });
  }

  public findById(id: UuidV7): Promise<Result<StoryFact | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<StoryFactRow>(
        `${STORY_FACT_SELECT} WHERE fact.id = ? LIMIT 2`,
        [id],
      );
      if (rows.length > 1) {
        abortCorruptSnapshot("STORY_FACT_ID_NOT_UNIQUE");
      }
      return rows[0] === undefined ? null : hydrateFact(rows[0]);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
    filter: StoryFactListFilter = {},
  ): Promise<Result<readonly StoryFact[], StoryCoreError>> {
    return runPersistence(async () => {
      const clauses = ["fact.project_id = ?"];
      const values: StorySqlPrimitive[] = [projectId];
      if (filter.status !== undefined) {
        requireStatus(filter.status);
        clauses.push("fact.status = ?");
        values.push(filter.status);
      }
      if (filter.factType !== undefined) {
        const factType = parseSafeIdentifier(filter.factType);
        if (!factType.ok) {
          abortPersistence(factType.error);
        }
        clauses.push("fact.fact_type = ?");
        values.push(factType.value);
      }
      if (filter.branchId !== undefined) {
        if (filter.branchId === null) {
          clauses.push("fact.branch_id IS NULL");
        } else {
          const branchId = parseUuidV7(filter.branchId);
          if (!branchId.ok) {
            abortPersistence(branchId.error);
          }
          clauses.push("fact.branch_id = ?");
          values.push(branchId.value);
        }
      }
      if (filter.needsReview !== undefined) {
        if (typeof filter.needsReview !== "boolean") {
          abortPersistence(validationFailure("Story fact review filter must be a boolean."));
        }
        clauses.push("fact.needs_review = ?");
        values.push(filter.needsReview ? 1 : 0);
      }
      const rows = await this.executor.select<StoryFactRow>(
        `${STORY_FACT_SELECT}
         WHERE ${clauses.join(" AND ")}
         ORDER BY fact.updated_at DESC, fact.fact_type ASC, fact.id ASC`,
        values,
      );
      return Object.freeze(rows.map(hydrateFact));
    });
  }

  public save(fact: StoryFact, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      assertNextRevision("Story fact", fact.revision, expectedRevision);
      const snapshot = fact.toSnapshot();
      const updated = await this.executor.execute(
        `UPDATE story_facts
         SET status = ?, user_confirmed = ?, locked = ?, deprecated = ?,
             needs_review = ?, confirmed_by_actor_id = ?, confirmed_at = ?,
             revision = ?, updated_at = ?
         WHERE id = ? AND project_id = ? AND revision = ?`,
        [
          snapshot.status,
          snapshot.userConfirmed ? 1 : 0,
          snapshot.locked ? 1 : 0,
          snapshot.deprecated ? 1 : 0,
          snapshot.needsReview ? 1 : 0,
          snapshot.confirmedByActorId,
          snapshot.confirmedAt,
          snapshot.revision,
          snapshot.updatedAt,
          snapshot.id,
          snapshot.projectId,
          expectedRevision,
        ],
      );
      if (updated.rowsAffected !== 1) {
        await abortRevisionConflict(this.executor, {
          table: "story_facts",
          idColumn: "id",
          id: snapshot.id,
          entity: "Story fact",
          expectedRevision,
        });
      }
    });
  }

  public listRevisions(
    factId: UuidV7,
  ): Promise<Result<readonly StoryFactRevision[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<RevisionRow>(
        `SELECT fact_id, project_id, revision, change_kind, recorded_at, snapshot_json
         FROM story_fact_revisions
         WHERE fact_id = ?
         ORDER BY revision ASC`,
        [factId],
      );
      return Object.freeze(rows.map(hydrateRevision));
    });
  }

  /**
   * Copies one legacy formal/memory snapshot into the unified store without
   * changing or deleting the source. The staged fact is always unconfirmed,
   * unlocked, and needs review—even when the legacy row was called “formal”.
   */
  public async stageLegacyRecord(
    input: StageLegacyStoryFactInput,
  ): Promise<Result<StageLegacyStoryFactReceipt, StoryCoreError>> {
    const identifiers = validateLegacyInput(input);
    if (!identifiers.ok) {
      return identifiers;
    }
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const legacyRevision = await selectLegacyRevision(
          transaction,
          identifiers.value.legacyKind,
          identifiers.value.legacyId,
          identifiers.value.projectId,
        );
        const existing = await selectLegacyLink(
          transaction,
          identifiers.value.legacyKind,
          identifiers.value.legacyId,
          legacyRevision,
        );
        if (existing !== null) {
          if (existing.project_id !== identifiers.value.projectId) {
            abortCorruptSnapshot("LEGACY_STORY_FACT_PROJECT_MISMATCH");
          }
          const fact = await selectFactRequired(transaction, existing.fact_id);
          return {
            fact,
            link: hydrateLegacyLink(existing),
            created: false,
          };
        }

        const fact =
          identifiers.value.legacyKind === "formal_record"
            ? await buildLegacyFormalFact(transaction, identifiers.value, input.now)
            : await buildLegacyMemoryFact(transaction, identifiers.value, input.now);
        const snapshot = fact.toSnapshot();
        await insertFact(transaction, snapshot);
        await insertInitialRevision(transaction, snapshot, "legacy_backfill");

        await transaction.execute(
          `INSERT INTO story_fact_legacy_links (
             fact_id, project_id, legacy_kind, legacy_id, legacy_revision,
             link_mode, created_at
           ) VALUES (?, ?, ?, ?, ?, 'backfill', ?)`,
          [
            snapshot.id,
            snapshot.projectId,
            identifiers.value.legacyKind,
            identifiers.value.legacyId,
            legacyRevision,
            snapshot.createdAt,
          ],
        );
        return {
          fact,
          link: Object.freeze({
            factId: snapshot.id,
            projectId: snapshot.projectId,
            legacyKind: identifiers.value.legacyKind,
            legacyId: identifiers.value.legacyId,
            legacyRevision,
            linkMode: "backfill" as const,
            createdAt: snapshot.createdAt,
          }),
          created: true,
        };
      }),
    );
  }

  public listLegacyLinks(
    projectId: UuidV7,
  ): Promise<Result<readonly StoryFactLegacyLink[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<LegacyLinkRow>(
        `SELECT fact_id, project_id, legacy_kind, legacy_id, legacy_revision,
                link_mode, created_at
         FROM story_fact_legacy_links
         WHERE project_id = ?
         ORDER BY legacy_kind ASC, legacy_id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(hydrateLegacyLink));
    });
  }
}

async function insertFact(
  transaction: StorySqlTransaction,
  snapshot: StoryFactSnapshot,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json,
       source_kind, evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    factValues(snapshot),
  );
}

async function insertInitialRevision(
  transaction: StorySqlTransaction,
  snapshot: StoryFactSnapshot,
  changeKind: "created" | "legacy_backfill",
): Promise<void> {
  await transaction.execute(
    `INSERT INTO story_fact_revisions (
       fact_id, project_id, revision, change_kind, recorded_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.revision,
      changeKind,
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
    ],
  );
}

function factValues(snapshot: StoryFactSnapshot): readonly StorySqlPrimitive[] {
  return [
    snapshot.id,
    snapshot.projectId,
    snapshot.factType,
    snapshot.contentText,
    snapshot.structuredValue === null ? null : JSON.stringify(snapshot.structuredValue),
    snapshot.source.kind,
    snapshot.source.reference,
    snapshot.source.chapterId,
    snapshot.source.versionId,
    snapshot.source.startOffset,
    snapshot.source.endOffset,
    snapshot.source.sourceLength,
    snapshot.source.excerpt,
    snapshot.effectiveAt,
    snapshot.invalidatedAt,
    snapshot.branchId,
    snapshot.confidence,
    snapshot.status,
    snapshot.origin,
    snapshot.userConfirmed ? 1 : 0,
    snapshot.locked ? 1 : 0,
    snapshot.deprecated ? 1 : 0,
    snapshot.needsReview ? 1 : 0,
    snapshot.confirmedByActorId,
    snapshot.confirmedAt,
    snapshot.revision,
    snapshot.createdAt,
    snapshot.updatedAt,
  ];
}

async function assertChapterEvidence(
  executor: StorySqlTransaction,
  snapshot: StoryFactSnapshot,
): Promise<void> {
  if (snapshot.source.kind !== "chapter_span") {
    return;
  }
  const rows = await executor.select<ChapterVersionRow>(
    `SELECT project_id, chapter_id, content
     FROM chapter_versions
     WHERE id = ?
     LIMIT 2`,
    [snapshot.source.versionId],
  );
  const source = rows[0];
  if (rows.length !== 1 || source === undefined) {
    abortPersistence(sourceChanged("The cited chapter version is unavailable."));
  }
  const start = snapshot.source.startOffset;
  const end = snapshot.source.endOffset;
  if (start === null || end === null) {
    abortCorruptSnapshot("STORY_FACT_CHAPTER_OFFSETS_MISSING");
  }
  if (
    source.project_id !== snapshot.projectId ||
    source.chapter_id !== snapshot.source.chapterId ||
    source.content.length !== snapshot.source.sourceLength ||
    source.content.slice(start, end) !== snapshot.source.excerpt
  ) {
    abortPersistence(sourceChanged("The cited chapter evidence no longer matches its version."));
  }
}

function hydrateFact(row: StoryFactRow): StoryFact {
  requireBooleanProjection(row.user_confirmed, "user_confirmed");
  requireBooleanProjection(row.locked, "locked");
  requireBooleanProjection(row.deprecated, "deprecated");
  requireBooleanProjection(row.needs_review, "needs_review");
  const structuredValue = row.value_json === null ? null : parseSnapshot(row.value_json);
  const result = StoryFact.rehydrate({
    id: row.id as StoryFactSnapshot["id"],
    projectId: row.project_id as StoryFactSnapshot["projectId"],
    factType: row.fact_type as StoryFactSnapshot["factType"],
    contentText: row.content_text,
    structuredValue: structuredValue as StoryFactSnapshot["structuredValue"],
    source: {
      kind: row.source_kind as StoryFactSnapshot["source"]["kind"],
      reference: row.evidence_reference,
      chapterId: row.source_chapter_id as StoryFactSnapshot["source"]["chapterId"],
      versionId: row.source_version_id as StoryFactSnapshot["source"]["versionId"],
      startOffset: row.source_start_offset,
      endOffset: row.source_end_offset,
      sourceLength: row.source_length,
      excerpt: row.source_excerpt,
    },
    effectiveAt: row.effective_at,
    invalidatedAt: row.invalidated_at,
    branchId: row.branch_id as StoryFactSnapshot["branchId"],
    confidence: row.confidence,
    status: row.status as StoryFactSnapshot["status"],
    origin: row.origin as StoryFactSnapshot["origin"],
    userConfirmed: row.user_confirmed === 1,
    locked: row.locked === 1,
    deprecated: row.deprecated === 1,
    needsReview: row.needs_review === 1,
    confirmedByActorId: row.confirmed_by_actor_id as StoryFactSnapshot["confirmedByActorId"],
    confirmedAt: row.confirmed_at as StoryFactSnapshot["confirmedAt"],
    revision: row.revision,
    createdAt: row.created_at as StoryFactSnapshot["createdAt"],
    updatedAt: row.updated_at as StoryFactSnapshot["updatedAt"],
  });
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  return result.value;
}

function hydrateRevision(row: RevisionRow): StoryFactRevision {
  if (!STORY_FACT_REVISION_CHANGE_KINDS.includes(row.change_kind as StoryFactRevisionChangeKind)) {
    abortCorruptSnapshot("STORY_FACT_REVISION_CHANGE_KIND_INVALID");
  }
  const result = StoryFact.rehydrate(parseSnapshot(row.snapshot_json) as StoryFactSnapshot);
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  const fact = result.value;
  if (
    fact.id !== row.fact_id ||
    fact.projectId !== row.project_id ||
    fact.revision !== row.revision ||
    fact.toSnapshot().updatedAt !== row.recorded_at
  ) {
    abortCorruptSnapshot("STORY_FACT_REVISION_PROJECTION_MISMATCH");
  }
  return Object.freeze({
    fact,
    changeKind: row.change_kind as StoryFactRevisionChangeKind,
    recordedAt: fact.toSnapshot().updatedAt,
  });
}

async function buildLegacyFormalFact(
  executor: StorySqlTransaction,
  input: ValidLegacyInput,
  now: string,
): Promise<StoryFact> {
  const rows = await executor.select<LegacyFormalRow>(
    `SELECT id, project_id, kind, revision, current_version, snapshot_json
     FROM story_formal_records
     WHERE id = ? AND project_id = ?
     LIMIT 2`,
    [input.legacyId, input.projectId],
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    abortPersistence(notFound("The legacy formal story record was not found."));
  }
  const hydrated = FormalStoryRecord.rehydrate(
    parseSnapshot(row.snapshot_json) as FormalStoryRecordSnapshot,
  );
  if (!hydrated.ok) {
    abortCorruptSnapshot(hydrated.error.code);
  }
  const snapshot = hydrated.value.toSnapshot();
  if (
    snapshot.id !== row.id ||
    snapshot.projectId !== row.project_id ||
    snapshot.kind !== row.kind ||
    snapshot.revision !== row.revision ||
    snapshot.currentVersion !== row.current_version
  ) {
    abortCorruptSnapshot("LEGACY_FORMAL_RECORD_PROJECTION_MISMATCH");
  }
  const current = snapshot.versions.find(({ version }) => version === snapshot.currentVersion);
  if (current === undefined) {
    abortCorruptSnapshot("LEGACY_FORMAL_RECORD_CURRENT_VERSION_MISSING");
  }
  const created = StoryFact.create({
    id: input.factId,
    projectId: input.projectId,
    factType: snapshot.kind,
    contentText: typeof current.value === "string" ? current.value : null,
    structuredValue: current.value,
    source: {
      kind: "legacy_record",
      reference: `legacy:story_formal_records:${snapshot.id}:r${String(snapshot.revision)}`,
    },
    confidence: 0.5,
    status: "unconfirmed",
    origin: "legacy",
    needsReview: true,
    humanConfirmed: false,
    now,
  });
  if (!created.ok) {
    abortPersistence(created.error);
  }
  return created.value;
}

async function buildLegacyMemoryFact(
  executor: StorySqlTransaction,
  input: ValidLegacyInput,
  now: string,
): Promise<StoryFact> {
  const rows = await executor.select<LegacyMemoryRow>(
    `SELECT id, project_id, revision, snapshot_json
     FROM story_memory_records
     WHERE id = ? AND project_id = ?
     LIMIT 2`,
    [input.legacyId, input.projectId],
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    abortPersistence(notFound("The legacy story memory record was not found."));
  }
  const hydrated = MemoryRecord.rehydrate(parseSnapshot(row.snapshot_json) as MemoryRecordSnapshot);
  if (!hydrated.ok) {
    abortCorruptSnapshot(hydrated.error.code);
  }
  const snapshot = hydrated.value.toSnapshot();
  if (
    snapshot.id !== row.id ||
    snapshot.projectId !== row.project_id ||
    snapshot.revision !== row.revision
  ) {
    abortCorruptSnapshot("LEGACY_MEMORY_RECORD_PROJECTION_MISMATCH");
  }
  const created = StoryFact.create({
    id: input.factId,
    projectId: input.projectId,
    factType: "memory",
    contentText: snapshot.content,
    structuredValue: {
      level: snapshot.level,
      content: snapshot.content,
      sourceKind: snapshot.source.kind,
      sourceId: snapshot.source.sourceId,
      sourceVersionId: snapshot.source.sourceVersionId,
      legacyOrigin: snapshot.origin,
    },
    source: {
      kind: "legacy_record",
      reference: `legacy:story_memory_records:${snapshot.id}:r${String(snapshot.revision)}`,
    },
    confidence: 0.5,
    status: "unconfirmed",
    origin: "legacy",
    needsReview: true,
    humanConfirmed: false,
    now,
  });
  if (!created.ok) {
    abortPersistence(created.error);
  }
  return created.value;
}

async function selectLegacyRevision(
  executor: StorySqlTransaction,
  kind: LegacyStoryFactKind,
  id: UuidV7,
  projectId: UuidV7,
): Promise<number> {
  const table = kind === "formal_record" ? "story_formal_records" : "story_memory_records";
  const rows = await executor.select<{ readonly revision: number }>(
    `SELECT revision FROM ${table} WHERE id = ? AND project_id = ? LIMIT 2`,
    [id, projectId],
  );
  const revision = rows[0]?.revision;
  if (
    rows.length !== 1 ||
    revision === undefined ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    abortCorruptSnapshot("LEGACY_STORY_FACT_REVISION_INVALID");
  }
  return revision;
}

async function selectLegacyLink(
  executor: StorySqlTransaction,
  kind: LegacyStoryFactKind,
  legacyId: UuidV7,
  legacyRevision: number,
): Promise<LegacyLinkRow | null> {
  const rows = await executor.select<LegacyLinkRow>(
    `SELECT fact_id, project_id, legacy_kind, legacy_id, legacy_revision,
            link_mode, created_at
     FROM story_fact_legacy_links
     WHERE legacy_kind = ? AND legacy_id = ? AND legacy_revision = ?
     LIMIT 2`,
    [kind, legacyId, legacyRevision],
  );
  if (rows.length > 1) {
    abortCorruptSnapshot("LEGACY_STORY_FACT_LINK_NOT_UNIQUE");
  }
  return rows[0] ?? null;
}

async function selectFactRequired(
  executor: StorySqlTransaction,
  factId: string,
): Promise<StoryFact> {
  const rows = await executor.select<StoryFactRow>(
    `${STORY_FACT_SELECT} WHERE fact.id = ? LIMIT 2`,
    [factId],
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    abortCorruptSnapshot("LEGACY_STORY_FACT_LINK_TARGET_MISSING");
  }
  return hydrateFact(row);
}

function hydrateLegacyLink(row: LegacyLinkRow): StoryFactLegacyLink {
  const factId = parseUuidV7(row.fact_id);
  const projectId = parseUuidV7(row.project_id);
  const legacyId = parseUuidV7(row.legacy_id);
  if (
    !factId.ok ||
    !projectId.ok ||
    !legacyId.ok ||
    !LEGACY_STORY_FACT_KINDS.includes(row.legacy_kind as LegacyStoryFactKind) ||
    !Number.isSafeInteger(row.legacy_revision) ||
    row.legacy_revision < 1 ||
    (row.link_mode !== "reference" && row.link_mode !== "backfill")
  ) {
    abortCorruptSnapshot("LEGACY_STORY_FACT_LINK_INVALID");
  }
  return Object.freeze({
    factId: factId.value,
    projectId: projectId.value,
    legacyKind: row.legacy_kind as LegacyStoryFactKind,
    legacyId: legacyId.value,
    legacyRevision: row.legacy_revision,
    linkMode: row.link_mode,
    createdAt: row.created_at,
  });
}

interface ValidLegacyInput {
  readonly factId: UuidV7;
  readonly projectId: UuidV7;
  readonly legacyKind: LegacyStoryFactKind;
  readonly legacyId: UuidV7;
}

function validateLegacyInput(
  input: StageLegacyStoryFactInput,
): Result<ValidLegacyInput, StoryCoreError> {
  const factId = parseUuidV7(input.factId);
  if (!factId.ok) {
    return factId;
  }
  const projectId = parseUuidV7(input.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  const legacyId = parseUuidV7(input.legacyId);
  if (!legacyId.ok) {
    return legacyId;
  }
  if (!LEGACY_STORY_FACT_KINDS.includes(input.legacyKind)) {
    return { ok: false, error: validationFailure("Legacy story fact kind is invalid.") };
  }
  return {
    ok: true,
    value: Object.freeze({
      factId: factId.value,
      projectId: projectId.value,
      legacyKind: input.legacyKind,
      legacyId: legacyId.value,
    }),
  };
}

function requireStatus(status: StoryFactStatus): void {
  if (!(["formal", "temporary", "unconfirmed", "deprecated", "branch"] as const).includes(status)) {
    abortPersistence(validationFailure("Story fact status filter is invalid."));
  }
}

function requireBooleanProjection(value: number, field: string): void {
  if (value !== 0 && value !== 1) {
    abortCorruptSnapshot(`STORY_FACT_${field.toUpperCase()}_INVALID`);
  }
}

function sourceChanged(message: string): StoryCoreError {
  return new StoryCoreError({
    code: "REVIEW_SOURCE_CHANGED",
    message,
    retryable: true,
    actions: ["OPEN_SOURCE", "RECOMPARE"],
  });
}

function notFound(message: string): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_FACT_NOT_FOUND",
    message,
    actions: ["REVIEW_EVIDENCE"],
  });
}

function validationFailure(message: string): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_VALIDATION_FAILED",
    message,
    actions: ["REVIEW_EVIDENCE"],
  });
}

const STORY_FACT_SELECT = `SELECT
  fact.id, fact.project_id, fact.fact_type, fact.content_text, fact.value_json,
  fact.source_kind, fact.evidence_reference, fact.source_chapter_id,
  fact.source_version_id, fact.source_start_offset, fact.source_end_offset,
  fact.source_length, fact.source_excerpt, fact.effective_at, fact.invalidated_at,
  fact.branch_id, fact.confidence, fact.status, fact.origin, fact.user_confirmed,
  fact.locked, fact.deprecated, fact.needs_review, fact.confirmed_by_actor_id,
  fact.confirmed_at, fact.revision, fact.created_at, fact.updated_at
FROM story_facts AS fact`;
