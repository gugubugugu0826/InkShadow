import { StoryCoreError } from "../errors.js";
import type {
  ChapterVersionReader,
  CommitReviewDecisionInput,
  CurrentChapterVersion,
  DeferredReviewReader,
  DueDeferredReviewItem,
  ReviewDecisionUnitOfWork,
  ReviewItemListReader,
  ReviewItemRepository,
} from "../ports.js";
import type { Result } from "../result.js";
import {
  StructuredReviewItem,
  type ReviewItemType,
  type StructuredReviewItemSnapshot,
} from "../review-item.js";
import {
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "../value-objects.js";
import {
  abortCorruptSnapshot,
  abortPersistence,
  abortRevisionConflict,
  assertNextRevision,
  parseSnapshot,
  runPersistence,
  serializeSnapshot,
} from "./common.js";
import type { StorySqlExecutor, StorySqlTransaction } from "./executor.js";
import { updateFormalRecord } from "./formal-repository.js";

interface ReviewItemRow {
  id: string;
  project_id: string;
  item_type: string;
  status: string;
  revision: number;
  target_record_id: string;
  source_chapter_id: string;
  source_version_id: string;
  deferred_until: string | null;
  snapshot_json: string;
}

interface ChapterHeadRow {
  id: string;
  project_id: string;
  current_version_id: string;
}

interface RevisionRow {
  revision: number;
}

interface DueReviewRow {
  id: string;
  item_type: string;
  deferred_until: string;
}

export class SqliteReviewItemRepository<ItemType extends ReviewItemType>
  implements ReviewItemRepository<ItemType>, ReviewItemListReader<ItemType>
{
  public constructor(
    private readonly executor: StorySqlExecutor,
    private readonly itemType: ItemType,
  ) {}

  public create(item: StructuredReviewItem<ItemType>): Promise<Result<void, StoryCoreError>> {
    return runPersistence(async () => {
      const snapshot = item.toSnapshot();
      if (snapshot.itemType !== this.itemType) {
        abortCorruptSnapshot("REVIEW_REPOSITORY_TYPE_MISMATCH");
      }
      await insertReviewItem(this.executor, snapshot);
    });
  }

  public findById(
    id: UuidV7,
  ): Promise<Result<StructuredReviewItem<ItemType> | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<ReviewItemRow>(
        `${REVIEW_ITEM_SELECT}
         WHERE id = ? AND item_type = ?`,
        [id, this.itemType],
      );
      const row = rows[0];
      return row === undefined ? null : hydrateReviewItem(row, this.itemType);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly StructuredReviewItem<ItemType>[], StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<ReviewItemRow>(
        `${REVIEW_ITEM_SELECT}
         WHERE project_id = ? AND item_type = ?
         ORDER BY updated_at DESC, id ASC`,
        [projectId, this.itemType],
      );
      return Object.freeze(rows.map((row) => hydrateReviewItem(row, this.itemType)));
    });
  }
}

export class SqliteChapterVersionReader implements ChapterVersionReader {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public findCurrent(
    chapterId: UuidV7,
  ): Promise<Result<CurrentChapterVersion | null, StoryCoreError>> {
    return runPersistence(async () => {
      const rows = await this.executor.select<ChapterHeadRow>(
        `SELECT id, project_id, current_version_id
         FROM chapters
         WHERE id = ?`,
        [chapterId],
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return hydrateChapterHead(row);
    });
  }
}

export class SqliteReviewDecisionUnitOfWork<
  ItemType extends ReviewItemType,
> implements ReviewDecisionUnitOfWork<ItemType> {
  public constructor(
    private readonly executor: StorySqlExecutor,
    private readonly itemType: ItemType,
  ) {}

  public commit(input: CommitReviewDecisionInput<ItemType>): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = input.item.toSnapshot();
        if (snapshot.itemType !== this.itemType) {
          abortCorruptSnapshot("REVIEW_TRANSACTION_TYPE_MISMATCH");
        }
        assertNextRevision("Review item", snapshot.revision, input.expectedItemRevision);
        await requireReviewRevision(
          transaction,
          snapshot.id,
          this.itemType,
          input.expectedItemRevision,
        );

        const formalRecord = input.formalRecord;
        if (formalRecord === null) {
          if (
            input.expectedFormalRecordRevision !== null ||
            input.expectedSourceChapterId !== null ||
            input.expectedSourceProjectId !== null ||
            input.expectedSourceVersionId !== null
          ) {
            abortCorruptSnapshot("REVIEW_NON_FORMAL_INPUT_MISMATCH");
          }
        } else {
          await persistFormalDecision(transaction, { ...input, formalRecord }, snapshot);
        }

        await updateReviewItem(transaction, snapshot, input.expectedItemRevision);
      }),
    );
  }
}

export class SqliteDeferredReviewReader implements DeferredReviewReader {
  public constructor(private readonly executor: StorySqlExecutor) {}

  public listDue(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly DueDeferredReviewItem[], StoryCoreError>> {
    return runPersistence(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        abortPersistence(
          new StoryCoreError({
            code: "STORY_VALIDATION_FAILED",
            message: "Deferred review query limit must be between 1 and 1000.",
          }),
        );
      }
      const rows = await this.executor.select<DueReviewRow>(
        `SELECT id, item_type, deferred_until
         FROM story_review_items
         WHERE status = 'deferred' AND deferred_until <= ?
         ORDER BY deferred_until ASC, id ASC
         LIMIT ?`,
        [now, limit],
      );
      return Object.freeze(
        rows.map((row) => {
          const itemId = parseUuidV7(row.id);
          const deferredUntil = parseIsoUtcTimestamp(row.deferred_until);
          if (
            !itemId.ok ||
            !deferredUntil.ok ||
            (row.item_type !== "extraction" && row.item_type !== "consistency")
          ) {
            abortCorruptSnapshot(
              !itemId.ok
                ? itemId.error.code
                : !deferredUntil.ok
                  ? deferredUntil.error.code
                  : "REVIEW_TYPE_INVALID",
            );
          }
          return Object.freeze({
            itemId: itemId.value,
            itemType: row.item_type,
            deferredUntil: deferredUntil.value,
          });
        }),
      );
    });
  }
}

async function persistFormalDecision<ItemType extends ReviewItemType>(
  transaction: StorySqlTransaction,
  input: CommitReviewDecisionInput<ItemType> & {
    readonly formalRecord: NonNullable<CommitReviewDecisionInput<ItemType>["formalRecord"]>;
  },
  item: StructuredReviewItemSnapshot<ItemType>,
): Promise<void> {
  const expectedFormalRevision = input.expectedFormalRecordRevision;
  const expectedChapterId = input.expectedSourceChapterId;
  const expectedProjectId = input.expectedSourceProjectId;
  const expectedVersionId = input.expectedSourceVersionId;
  if (
    expectedFormalRevision === null ||
    expectedChapterId === null ||
    expectedProjectId === null ||
    expectedVersionId === null ||
    expectedChapterId !== item.sourceChapterId ||
    expectedProjectId !== item.projectId ||
    expectedVersionId !== item.sourceVersionId ||
    input.formalRecord.id !== item.targetRecordId ||
    input.formalRecord.projectId !== item.projectId
  ) {
    abortCorruptSnapshot("REVIEW_FORMAL_INPUT_MISMATCH");
  }

  const sourceRows = await transaction.select<ChapterHeadRow>(
    `SELECT id, project_id, current_version_id
     FROM chapters
     WHERE id = ?`,
    [expectedChapterId],
  );
  const actualSource = sourceRows[0];
  if (
    actualSource?.project_id !== expectedProjectId ||
    actualSource.current_version_id !== expectedVersionId
  ) {
    abortPersistence(
      new StoryCoreError({
        code: "REVIEW_SOURCE_CHANGED",
        message: "The source chapter changed before the review decision was committed.",
        actions: ["OPEN_SOURCE", "RECOMPARE", "REVIEW_EVIDENCE"],
        details: {
          sourceChapterId: expectedChapterId,
          expectedSourceVersionId: expectedVersionId,
          actualSourceVersionId: actualSource?.current_version_id ?? null,
          expectedProjectId,
          actualProjectId: actualSource?.project_id ?? null,
        },
      }),
    );
  }

  const formalRows = await transaction.select<RevisionRow>(
    `SELECT revision
     FROM story_formal_records
     WHERE id = ? AND project_id = ?`,
    [input.formalRecord.id, expectedProjectId],
  );
  if (formalRows[0]?.revision !== expectedFormalRevision) {
    await abortRevisionConflict(transaction, {
      table: "story_formal_records",
      idColumn: "id",
      id: input.formalRecord.id,
      entity: "Formal story record",
      expectedRevision: expectedFormalRevision,
    });
  }
  await updateFormalRecord(transaction, input.formalRecord, expectedFormalRevision);
}

async function requireReviewRevision(
  transaction: StorySqlTransaction,
  id: string,
  itemType: ReviewItemType,
  expectedRevision: number,
): Promise<void> {
  const rows = await transaction.select<{ revision: number; item_type: string }>(
    `SELECT revision, item_type
     FROM story_review_items
     WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  const revisionMatches = row?.revision === expectedRevision;
  const typeMatches = row?.item_type === itemType;
  if (!revisionMatches || !typeMatches) {
    await abortRevisionConflict(transaction, {
      table: "story_review_items",
      idColumn: "id",
      id,
      entity: "Review item",
      expectedRevision,
    });
  }
}

async function insertReviewItem(
  transaction: StorySqlTransaction,
  snapshot: StructuredReviewItemSnapshot,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO story_review_items (
       id, project_id, item_type, status, revision, target_record_id,
       source_chapter_id, source_version_id, deferred_until,
       created_at, updated_at, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    reviewBindValues(snapshot),
  );
}

async function updateReviewItem(
  transaction: StorySqlTransaction,
  snapshot: StructuredReviewItemSnapshot,
  expectedRevision: number,
): Promise<void> {
  const updated = await transaction.execute(
    `UPDATE story_review_items
     SET status = ?, revision = ?, deferred_until = ?, updated_at = ?, snapshot_json = ?
     WHERE id = ? AND item_type = ? AND revision = ?`,
    [
      snapshot.status,
      snapshot.revision,
      snapshot.deferredUntil,
      snapshot.updatedAt,
      serializeSnapshot(snapshot),
      snapshot.id,
      snapshot.itemType,
      expectedRevision,
    ],
  );
  if (updated.rowsAffected !== 1) {
    await abortRevisionConflict(transaction, {
      table: "story_review_items",
      idColumn: "id",
      id: snapshot.id,
      entity: "Review item",
      expectedRevision,
    });
  }
}

function reviewBindValues(
  snapshot: StructuredReviewItemSnapshot,
): readonly (string | number | null)[] {
  return [
    snapshot.id,
    snapshot.projectId,
    snapshot.itemType,
    snapshot.status,
    snapshot.revision,
    snapshot.targetRecordId,
    snapshot.sourceChapterId,
    snapshot.sourceVersionId,
    snapshot.deferredUntil,
    snapshot.createdAt,
    snapshot.updatedAt,
    serializeSnapshot(snapshot),
  ];
}

function hydrateReviewItem<ItemType extends ReviewItemType>(
  row: ReviewItemRow,
  itemType: ItemType,
): StructuredReviewItem<ItemType> {
  const result = StructuredReviewItem.rehydrate(
    parseSnapshot(row.snapshot_json) as StructuredReviewItemSnapshot<ItemType>,
  );
  if (!result.ok) {
    abortCorruptSnapshot(result.error.code);
  }
  const snapshot = result.value.toSnapshot();
  if (
    snapshot.id !== row.id ||
    snapshot.projectId !== row.project_id ||
    snapshot.itemType !== itemType ||
    snapshot.itemType !== row.item_type ||
    snapshot.status !== row.status ||
    snapshot.revision !== row.revision ||
    snapshot.targetRecordId !== row.target_record_id ||
    snapshot.sourceChapterId !== row.source_chapter_id ||
    snapshot.sourceVersionId !== row.source_version_id ||
    snapshot.deferredUntil !== row.deferred_until
  ) {
    abortCorruptSnapshot("REVIEW_PROJECTION_MISMATCH");
  }
  return result.value;
}

function hydrateChapterHead(row: ChapterHeadRow): CurrentChapterVersion {
  const chapterId = parseUuidV7(row.id);
  if (!chapterId.ok) {
    abortCorruptSnapshot(chapterId.error.code);
  }
  const projectId = parseUuidV7(row.project_id);
  if (!projectId.ok) {
    abortCorruptSnapshot(projectId.error.code);
  }
  const versionId = parseUuidV7(row.current_version_id);
  if (!versionId.ok) {
    abortCorruptSnapshot(versionId.error.code);
  }
  return {
    chapterId: chapterId.value,
    projectId: projectId.value,
    versionId: versionId.value,
  };
}

const REVIEW_ITEM_SELECT = `SELECT
  id, project_id, item_type, status, revision, target_record_id,
  source_chapter_id, source_version_id, deferred_until, snapshot_json
FROM story_review_items`;
