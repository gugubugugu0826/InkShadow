import { StoryCoreError } from "../errors.js";
import { FormalStoryRecord, type FormalStoryRecordSnapshot } from "../formal-record.js";
import { MemoryRecord, type MemoryRecordSnapshot } from "../memory.js";
import type { Result } from "../result.js";
import {
  StoryFact,
  CONTINUOUS_STORY_STATE_ROUTE_TASKS,
  isRebuildableStoryFactType,
  MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES,
  type ContinuousStoryStateRouteCommit,
  type ContinuousStoryStateRouteCommitReceipt,
  type ContinuousStoryStateRouteIdentity,
  type ContinuousStoryStateRouteReceipt,
  STORY_FACT_REVISION_CHANGE_KINDS,
  type StoryFactListFilter,
  type StoryFactAuthorityFence,
  type StoryFactConditionalCreateReceipt,
  type StoryFactConditionalDeprecateReceipt,
  type StoryFactConditionalReplacementReceipt,
  type StoryFactSupplementalResolutionUndoFence,
  type StoryFactRevision,
  type StoryFactRevisionChangeKind,
  type StoryFactSnapshot,
  type StoryFactStatus,
  type StoryFactStore,
} from "../story-fact.js";
import {
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
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
import type { StorySqlPrimitive, StorySqlExecutor, StorySqlTransaction } from "./executor.js";

export const LEGACY_STORY_FACT_KINDS = ["formal_record", "memory_record"] as const;
export type LegacyStoryFactKind = (typeof LEGACY_STORY_FACT_KINDS)[number];
const CHAPTER_SUPPLEMENTAL_FINDING_RESOLUTION_SCHEMA =
  "inkshadow.chapter-supplemental-finding-resolution.v1";

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

/**
 * Compatibility boundary for legacy records. Implementations keep the legacy
 * row immutable and use StoryFact as the only fact authority.
 */
export interface LegacyStoryFactCompatibilityStore {
  stageLegacyRecord(
    input: StageLegacyStoryFactInput,
  ): Promise<Result<StageLegacyStoryFactReceipt, StoryCoreError>>;
  listLegacyLinks(
    projectId: UuidV7,
  ): Promise<Result<readonly StoryFactLegacyLink[], StoryCoreError>>;
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

interface ContinuousStoryStateRouteReceiptRow {
  readonly project_id: string;
  readonly chapter_id: string;
  readonly version_id: string;
  readonly task: string;
  readonly source_content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly invocation_id: string;
  readonly candidate_count: number;
  readonly created_fact_count: number;
  readonly retired_fact_count: number;
  readonly completed_at: string;
}

function storyRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sameSubmission(left: StoryFactSnapshot, right: StoryFactSnapshot): boolean {
  return (
    left.projectId === right.projectId &&
    left.factType === right.factType &&
    left.contentText === right.contentText &&
    JSON.stringify(left.structuredValue) === JSON.stringify(right.structuredValue) &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    left.effectiveAt === right.effectiveAt &&
    left.invalidatedAt === right.invalidatedAt &&
    left.branchId === right.branchId &&
    left.status === right.status &&
    left.origin === right.origin &&
    left.userConfirmed === right.userConfirmed
  );
}

function supplementalResolutionIdentity(snapshot: StoryFactSnapshot): Readonly<{
  readonly key: string;
  readonly action: "ignore" | "allow";
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly findingId: string;
  readonly evidenceSignature: string;
}> | null {
  if (
    snapshot.factType !== "validation_resolution" ||
    snapshot.status !== "formal" ||
    !snapshot.userConfirmed ||
    snapshot.needsReview ||
    snapshot.deprecated ||
    snapshot.invalidatedAt !== null ||
    snapshot.branchId !== null
  ) {
    return null;
  }
  return supplementalResolutionMetadata(snapshot);
}

function supplementalResolutionMetadata(snapshot: StoryFactSnapshot): Readonly<{
  readonly key: string;
  readonly action: "ignore" | "allow";
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly findingId: string;
  readonly evidenceSignature: string;
}> | null {
  if (
    snapshot.factType !== "validation_resolution" ||
    !snapshot.userConfirmed ||
    snapshot.needsReview ||
    snapshot.invalidatedAt !== null ||
    snapshot.branchId !== null
  ) {
    return null;
  }
  const value = storyRecord(snapshot.structuredValue);
  const action = value?.resolutionAction;
  const findingId = boundedResolutionIdentityPart(value?.resolvedFindingId, 1_000);
  const chapterId = safeAuthorityReference(value?.resolvedChapterId);
  const chapterVersionId = safeAuthorityReference(value?.resolvedChapterVersionId);
  const evidenceSignature = boundedResolutionIdentityPart(value?.evidenceSignature, 5_000);
  if (
    value?.resolutionSchema !== CHAPTER_SUPPLEMENTAL_FINDING_RESOLUTION_SCHEMA ||
    (action !== "ignore" && action !== "allow") ||
    findingId === null ||
    chapterId === null ||
    chapterVersionId === null ||
    evidenceSignature === null
  ) {
    return null;
  }
  return Object.freeze({
    key: JSON.stringify([
      snapshot.projectId,
      chapterId,
      chapterVersionId,
      findingId,
      evidenceSignature,
    ]),
    action,
    chapterId,
    chapterVersionId,
    findingId,
    evidenceSignature,
  });
}

function boundedResolutionIdentityPart(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

/**
 * Unified story-state authority backed by the shared SQLite executor contract.
 * `TauriSqliteExecutor` satisfies this interface structurally; tests use the
 * in-memory Node adapter. Fact identity/content/evidence never mutate in place;
 * a forward migration permits only the domain-validated ambiguous-alias
 * resolution inside structuredValue and captures it as the next revision.
 */
export class SqliteStoryFactStore implements StoryFactStore, LegacyStoryFactCompatibilityStore {
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

  public createWithAuthorityFence(
    fact: StoryFact,
    fence: StoryFactAuthorityFence,
  ): Promise<Result<StoryFactConditionalCreateReceipt, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = fact.toSnapshot();
        assertAuthorityFencedCreateGovernance(snapshot);
        assertAuthorityFenceMatchesFact(snapshot, fence);
        const chapters = await transaction.select<{
          readonly project_id: string;
          readonly current_version_id: string;
        }>(
          `SELECT project_id, current_version_id
           FROM chapters
           WHERE id = ? AND project_id = ? AND status = 'active'
           LIMIT 2`,
          [fence.chapterId, snapshot.projectId],
        );
        if (
          chapters.length !== 1 ||
          chapters[0]?.current_version_id !== fence.expectedCurrentVersionId
        ) {
          abortPersistence(
            new StoryCoreError({
              code: "STORY_FACT_SOURCE_FENCE_FAILED",
              message: "The chapter current version changed before the story fact was committed.",
            }),
          );
        }
        if ((fence.requiredCausalEventIds?.length ?? 0) > 0) {
          const eventRows = await transaction.select<StoryFactRow>(
            `${STORY_FACT_SELECT}
             WHERE fact.project_id = ?
               AND fact.fact_type = 'causal_event'
               AND fact.status = 'formal'
               AND fact.user_confirmed = 1
               AND fact.needs_review = 0
               AND fact.deprecated = 0
               AND fact.invalidated_at IS NULL
               AND fact.branch_id IS NULL`,
            [snapshot.projectId],
          );
          const eventIdCounts = new Map<string, number>();
          for (const row of eventRows) {
            const eventSnapshot = hydrateFact(row).toSnapshot();
            const structured = storyRecord(eventSnapshot.structuredValue);
            if (
              structured?.schemaVersion !== "inkshadow.causal-event-fact.v1" &&
              structured?.schemaVersion !== "inkshadow.causal-event-fact.v2"
            ) {
              continue;
            }
            const eventId =
              typeof structured.eventId === "string" ? structured.eventId : eventSnapshot.id;
            eventIdCounts.set(eventId, (eventIdCounts.get(eventId) ?? 0) + 1);
          }
          if (fence.requiredCausalEventIds?.some((eventId) => eventIdCounts.get(eventId) !== 1)) {
            abortPersistence(
              new StoryCoreError({
                code: "STORY_FACT_RELATION_ENDPOINT_INVALID",
                message: "A causal relation endpoint is missing, duplicated, or no longer active.",
              }),
            );
          }
        }
        if ((fence.requiredCharacterIds?.length ?? 0) > 0) {
          const characterRows = await transaction.select<StoryFactRow>(
            `${STORY_FACT_SELECT}
             WHERE fact.project_id = ?
               AND fact.fact_type = 'character_identity'
               AND fact.status = 'formal'
               AND fact.user_confirmed = 1
               AND fact.needs_review = 0
               AND fact.deprecated = 0
               AND fact.invalidated_at IS NULL
               AND fact.branch_id IS NULL`,
            [snapshot.projectId],
          );
          const characterIdCounts = new Map<string, number>();
          for (const row of characterRows) {
            const structured = storyRecord(hydrateFact(row).toSnapshot().structuredValue);
            const subject = storyRecord(structured?.subject);
            if (subject?.kind === "character" && typeof subject.entityKey === "string") {
              characterIdCounts.set(
                subject.entityKey,
                (characterIdCounts.get(subject.entityKey) ?? 0) + 1,
              );
            }
          }
          if (
            fence.requiredCharacterIds?.some(
              (characterId) => characterIdCounts.get(characterId) !== 1,
            )
          ) {
            abortPersistence(
              new StoryCoreError({
                code: "STORY_FACT_CHARACTER_AUTHORITY_INVALID",
                message:
                  "A referenced character is missing, duplicated, or no longer an active confirmed formal fact.",
              }),
            );
          }
        }
        await assertChapterEvidence(transaction, snapshot);
        const matchingRows = await transaction.select<StoryFactRow>(
          `${STORY_FACT_SELECT}
           WHERE fact.project_id = ?
             AND fact.fact_type = ?
             AND fact.status = 'formal'
             AND fact.user_confirmed = 1
             AND fact.needs_review = 0
             AND fact.deprecated = 0
             AND fact.invalidated_at IS NULL
             AND fact.branch_id IS NULL`,
          [snapshot.projectId, snapshot.factType],
        );
        const supplementalIdentity = supplementalResolutionIdentity(snapshot);
        if (supplementalIdentity !== null) {
          const existingResolution = matchingRows.map(hydrateFact).find((candidate) => {
            const identity = supplementalResolutionIdentity(candidate.toSnapshot());
            return identity !== null && identity.key === supplementalIdentity.key;
          });
          if (existingResolution !== undefined) {
            const existingIdentity = supplementalResolutionIdentity(
              existingResolution.toSnapshot(),
            );
            if (existingIdentity?.action === supplementalIdentity.action) {
              return Object.freeze({ fact: existingResolution, created: false });
            }
            abortPersistence(
              new StoryCoreError({
                code: "STORY_FACT_IDEMPOTENCY_CONFLICT",
                message: "A supplemental finding already has a different active disposition.",
              }),
            );
          }
        }
        const existing = matchingRows
          .map(hydrateFact)
          .find((candidate) => sameSubmission(candidate.toSnapshot(), snapshot));
        if (existing !== undefined) {
          return Object.freeze({ fact: existing, created: false });
        }
        await insertFact(transaction, snapshot);
        await insertInitialRevision(transaction, snapshot, "created");
        return Object.freeze({ fact, created: true });
      }),
    );
  }

  public replaceRebuildableSystemFactWithAuthorityFence(
    fact: StoryFact,
    replacementKey: string,
    fence: StoryFactAuthorityFence,
  ): Promise<Result<StoryFactConditionalReplacementReceipt, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const snapshot = fact.toSnapshot();
        assertAuthorityFencedRebuildableReplacement(snapshot, replacementKey, fence);
        await assertCurrentChapterVersion(transaction, snapshot.projectId, fence);
        await assertChapterEvidence(transaction, snapshot);

        const rows = await transaction.select<StoryFactRow>(
          `${STORY_FACT_SELECT}
           WHERE fact.project_id = ? AND fact.fact_type = ?`,
          [snapshot.projectId, snapshot.factType],
        );
        const matching = rows
          .map(hydrateFact)
          .filter((candidate) =>
            matchesStoredRebuildableReplacement(candidate, snapshot.factType, replacementKey),
          );
        const replacedFactIds: string[] = [];
        for (const current of matching) {
          const currentSnapshot = current.toSnapshot();
          const retired = current.deprecateRebuildableSystemFact({
            expectedRevision: currentSnapshot.revision,
            now: snapshot.updatedAt,
          });
          if (!retired.ok) abortPersistence(retired.error);
          const retiredSnapshot = retired.value.toSnapshot();
          const updated = await transaction.execute(
            `UPDATE story_facts
             SET status = ?, user_confirmed = ?, locked = ?, deprecated = ?,
                 needs_review = ?, confirmed_by_actor_id = ?, confirmed_at = ?,
                 revision = ?, updated_at = ?
             WHERE id = ? AND project_id = ? AND revision = ?`,
            [
              retiredSnapshot.status,
              retiredSnapshot.userConfirmed ? 1 : 0,
              retiredSnapshot.locked ? 1 : 0,
              retiredSnapshot.deprecated ? 1 : 0,
              retiredSnapshot.needsReview ? 1 : 0,
              retiredSnapshot.confirmedByActorId,
              retiredSnapshot.confirmedAt,
              retiredSnapshot.revision,
              retiredSnapshot.updatedAt,
              retiredSnapshot.id,
              retiredSnapshot.projectId,
              currentSnapshot.revision,
            ],
          );
          if (updated.rowsAffected !== 1) {
            abortPersistence(
              new StoryCoreError({
                code: "STORY_REVISION_CONFLICT",
                message: "A rebuildable story fact changed before atomic replacement.",
                retryable: true,
              }),
            );
          }
          replacedFactIds.push(current.id);
        }

        await insertFact(transaction, snapshot);
        await insertInitialRevision(transaction, snapshot, "created");
        return Object.freeze({
          fact,
          replacedFactIds: Object.freeze(replacedFactIds),
        });
      }),
    );
  }
  public deprecateSupplementalResolutionWithAuthorityFence(
    factId: UuidV7,
    fence: StoryFactSupplementalResolutionUndoFence,
  ): Promise<Result<StoryFactConditionalDeprecateReceipt, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<StoryFactRow>(
          `${STORY_FACT_SELECT} WHERE fact.id = ? LIMIT 2`,
          [factId],
        );
        if (rows.length > 1) abortCorruptSnapshot("STORY_FACT_ID_NOT_UNIQUE");
        const current = rows[0] === undefined ? null : hydrateFact(rows[0]);
        if (current === null) {
          abortPersistence(
            new StoryCoreError({
              code: "STORY_FACT_NOT_FOUND",
              message: "The supplemental finding disposition was not found.",
            }),
          );
        }
        const snapshot = current.toSnapshot();
        const identity = supplementalResolutionMetadata(snapshot);
        if (
          snapshot.projectId !== fence.expectedProjectId ||
          identity?.chapterId !== fence.chapterId ||
          identity.chapterVersionId !== fence.expectedCurrentVersionId ||
          identity.findingId !== fence.findingId ||
          identity.evidenceSignature !== fence.evidenceSignature
        ) {
          abortPersistence(
            validationFailure("The supplemental finding undo identity does not match the fact."),
          );
        }
        const chapters = await transaction.select<{
          readonly project_id: string;
          readonly current_version_id: string;
        }>(
          `SELECT project_id, current_version_id
           FROM chapters
           WHERE id = ? AND project_id = ? AND status = 'active'
           LIMIT 2`,
          [fence.chapterId, fence.expectedProjectId],
        );
        if (
          chapters.length !== 1 ||
          chapters[0]?.current_version_id !== fence.expectedCurrentVersionId
        ) {
          abortPersistence(
            new StoryCoreError({
              code: "STORY_FACT_SOURCE_FENCE_FAILED",
              message: "The chapter current version changed before the disposition was undone.",
              retryable: true,
            }),
          );
        }
        if (
          snapshot.status === "deprecated" &&
          snapshot.deprecated &&
          snapshot.revision === fence.expectedRevision + 1
        ) {
          return Object.freeze({ fact: current, deprecated: false });
        }
        if (
          snapshot.status !== "formal" ||
          snapshot.deprecated ||
          snapshot.revision !== fence.expectedRevision
        ) {
          abortPersistence(
            new StoryCoreError({
              code: "STORY_REVISION_CONFLICT",
              message: "The supplemental finding disposition changed before it was undone.",
              retryable: true,
            }),
          );
        }
        const deprecated = current.deprecate({
          humanConfirmed: true,
          expectedRevision: fence.expectedRevision,
          now: fence.now,
        });
        if (!deprecated.ok) abortPersistence(deprecated.error);
        const next = deprecated.value.toSnapshot();
        const updated = await transaction.execute(
          `UPDATE story_facts
           SET status = ?, user_confirmed = ?, locked = ?, deprecated = ?,
               needs_review = ?, confirmed_by_actor_id = ?, confirmed_at = ?,
               revision = ?, updated_at = ?
           WHERE id = ? AND project_id = ? AND revision = ?`,
          [
            next.status,
            next.userConfirmed ? 1 : 0,
            next.locked ? 1 : 0,
            next.deprecated ? 1 : 0,
            next.needsReview ? 1 : 0,
            next.confirmedByActorId,
            next.confirmedAt,
            next.revision,
            next.updatedAt,
            next.id,
            next.projectId,
            fence.expectedRevision,
          ],
        );
        if (updated.rowsAffected !== 1) {
          abortPersistence(
            new StoryCoreError({
              code: "STORY_REVISION_CONFLICT",
              message: "The supplemental finding disposition changed before it was undone.",
              retryable: true,
            }),
          );
        }
        return Object.freeze({ fact: deprecated.value, deprecated: true });
      }),
    );
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
         SET content_text = ?, value_json = ?, confidence = ?, origin = ?, status = ?,
              user_confirmed = ?, locked = ?, deprecated = ?, needs_review = ?,
              confirmed_by_actor_id = ?, confirmed_at = ?, revision = ?, updated_at = ?
         WHERE id = ? AND project_id = ? AND revision = ?`,
        [
          snapshot.contentText,
          snapshot.structuredValue === null ? null : JSON.stringify(snapshot.structuredValue),
          snapshot.confidence,
          snapshot.origin,
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

  public mergeUserFactRevisions(
    survivor: StoryFact,
    survivorExpectedRevision: number,
    duplicate: StoryFact,
    duplicateExpectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        assertNextRevision("Story fact", survivor.revision, survivorExpectedRevision);
        assertNextRevision("Story fact", duplicate.revision, duplicateExpectedRevision);
        const survivorNext = survivor.toSnapshot();
        const duplicateNext = duplicate.toSnapshot();
        if (
          survivorNext.id === duplicateNext.id ||
          survivorNext.projectId !== duplicateNext.projectId ||
          survivorNext.factType !== duplicateNext.factType
        ) {
          abortPersistence(
            validationFailure("A duplicate merge must keep two distinct facts in one project."),
          );
        }
        const rows = await transaction.select<StoryFactRow>(
          `${STORY_FACT_SELECT} WHERE fact.id IN (?, ?)`,
          [survivorNext.id, duplicateNext.id],
        );
        const currentById = new Map(rows.map((row) => [row.id, hydrateFact(row)] as const));
        const survivorCurrent = currentById.get(survivorNext.id);
        const duplicateCurrent = currentById.get(duplicateNext.id);
        if (survivorCurrent === undefined || duplicateCurrent === undefined || rows.length !== 2) {
          abortPersistence(
            new StoryCoreError({
              code: "STORY_FACT_NOT_FOUND",
              message: "One of the duplicate story facts was not found.",
            }),
          );
        }
        if (survivorCurrent.revision !== survivorExpectedRevision) {
          abortPersistence(
            storyFactRevisionConflict(survivorExpectedRevision, survivorCurrent.revision),
          );
        }
        if (duplicateCurrent.revision !== duplicateExpectedRevision) {
          abortPersistence(
            storyFactRevisionConflict(duplicateExpectedRevision, duplicateCurrent.revision),
          );
        }
        if (
          survivorCurrent.toSnapshot().structuredValue !== null ||
          duplicateCurrent.toSnapshot().structuredValue !== null
        ) {
          abortPersistence(
            validationFailure(
              "Structured story facts cannot be merged until a structured merge transaction is available.",
            ),
          );
        }
        const actorId = survivorNext.confirmedByActorId;
        if (actorId === null) {
          abortPersistence(validationFailure("A duplicate merge requires a user actor."));
        }
        const expectedSurvivor = survivorCurrent.recordDuplicateMergeAsUser({
          duplicate: duplicateCurrent,
          actorId,
          humanConfirmed: true,
          expectedRevision: survivorExpectedRevision,
          now: survivorNext.updatedAt,
        });
        const expectedDuplicate = duplicateCurrent.deprecate({
          humanConfirmed: true,
          expectedRevision: duplicateExpectedRevision,
          now: duplicateNext.updatedAt,
        });
        if (
          !expectedSurvivor.ok ||
          !expectedDuplicate.ok ||
          JSON.stringify(expectedSurvivor.value.toSnapshot()) !== JSON.stringify(survivorNext) ||
          JSON.stringify(expectedDuplicate.value.toSnapshot()) !== JSON.stringify(duplicateNext)
        ) {
          abortPersistence(validationFailure("The duplicate merge revisions are not authorized."));
        }

        for (const [snapshot, expectedRevision] of [
          [survivorNext, survivorExpectedRevision],
          [duplicateNext, duplicateExpectedRevision],
        ] as const) {
          const updated = await transaction.execute(
            `UPDATE story_facts
             SET content_text = ?, value_json = ?, confidence = ?, origin = ?, status = ?,
                 user_confirmed = ?, locked = ?, deprecated = ?, needs_review = ?,
                 confirmed_by_actor_id = ?, confirmed_at = ?, revision = ?, updated_at = ?
             WHERE id = ? AND project_id = ? AND revision = ?`,
            [
              snapshot.contentText,
              snapshot.structuredValue === null ? null : JSON.stringify(snapshot.structuredValue),
              snapshot.confidence,
              snapshot.origin,
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
            abortPersistence(storyFactRevisionConflict(expectedRevision, expectedRevision + 1));
          }
        }
      }),
    );
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

  public findContinuousStoryStateRouteReceipt(
    identity: ContinuousStoryStateRouteIdentity,
  ): Promise<Result<ContinuousStoryStateRouteReceipt | null, StoryCoreError>> {
    return runPersistence(async () => {
      validateContinuousRouteIdentity(identity);
      const rows = await selectContinuousRouteReceipts(this.executor, identity);
      if (rows.length > 1) {
        abortCorruptSnapshot("CONTINUOUS_STORY_STATE_ROUTE_RECEIPT_NOT_UNIQUE");
      }
      return rows[0] === undefined ? null : hydrateContinuousRouteReceipt(rows[0]);
    });
  }

  public commitContinuousStoryStateRoute(
    command: ContinuousStoryStateRouteCommit,
  ): Promise<Result<ContinuousStoryStateRouteCommitReceipt, StoryCoreError>> {
    return runPersistence(() =>
      this.executor.transaction(async (transaction) => {
        validateContinuousRouteCommit(command);
        const existingRows = await selectContinuousRouteReceipts(transaction, command);
        if (existingRows.length > 1) {
          abortCorruptSnapshot("CONTINUOUS_STORY_STATE_ROUTE_RECEIPT_NOT_UNIQUE");
        }
        if (existingRows[0] !== undefined) {
          return Object.freeze({
            receipt: hydrateContinuousRouteReceipt(existingRows[0]),
            facts: Object.freeze([]),
            retiredFactIds: Object.freeze([]),
            alreadyCommitted: true,
          });
        }

        const authorityRows = await transaction.select<{
          readonly current_version_id: string;
          readonly status: string;
          readonly content_checksum: string;
        }>(
          `SELECT chapter.current_version_id, chapter.status, version.content_checksum
           FROM chapters AS chapter
           INNER JOIN chapter_versions AS version
             ON version.id = ?
            AND version.chapter_id = chapter.id
            AND version.project_id = chapter.project_id
           WHERE chapter.id = ? AND chapter.project_id = ?
           LIMIT 2`,
          [command.versionId, command.chapterId, command.projectId],
        );
        if (
          authorityRows.length !== 1 ||
          authorityRows[0]?.status !== "active" ||
          authorityRows[0].current_version_id !== command.versionId ||
          authorityRows[0].content_checksum !== command.sourceContentHash
        ) {
          abortPersistence(continuousRouteSourceChanged());
        }

        for (const { fact } of command.facts) {
          await assertChapterEvidence(transaction, fact.toSnapshot());
        }

        const replacementKeys = new Set(
          command.facts
            .filter(
              (candidate): candidate is typeof candidate & { readonly replacementKey: string } =>
                candidate.replacementKey !== null,
            )
            .map(({ fact, replacementKey }) =>
              continuousReplacementIdentity(fact.toSnapshot().factType, replacementKey),
            ),
        );
        const retiredFactIds: UuidV7[] = [];
        if (replacementKeys.size > 0) {
          const rows = await transaction.select<StoryFactRow>(
            `${STORY_FACT_SELECT}
             WHERE fact.project_id = ?
               AND fact.status = 'temporary'
               AND fact.origin = 'system'
               AND fact.user_confirmed = 0
               AND fact.locked = 0
               AND fact.deprecated = 0
               AND fact.needs_review = 0
               AND fact.branch_id IS NULL`,
            [command.projectId],
          );
          for (const row of rows) {
            const current = hydrateFact(row);
            const snapshot = current.toSnapshot();
            const replacementKey = readContinuousReplacementKey(snapshot);
            if (
              replacementKey === null ||
              !replacementKeys.has(continuousReplacementIdentity(snapshot.factType, replacementKey))
            ) {
              continue;
            }
            const retired = current.deprecateAutomaticSystemProjection({
              expectedRevision: snapshot.revision,
              now: command.completedAt,
            });
            if (!retired.ok) {
              abortPersistence(retired.error);
            }
            const retiredSnapshot = retired.value.toSnapshot();
            const updated = await transaction.execute(
              `UPDATE story_facts
               SET status = ?, user_confirmed = ?, locked = ?, deprecated = ?,
                   needs_review = ?, confirmed_by_actor_id = ?, confirmed_at = ?,
                   revision = ?, updated_at = ?
               WHERE id = ? AND project_id = ? AND revision = ?`,
              [
                retiredSnapshot.status,
                retiredSnapshot.userConfirmed ? 1 : 0,
                retiredSnapshot.locked ? 1 : 0,
                retiredSnapshot.deprecated ? 1 : 0,
                retiredSnapshot.needsReview ? 1 : 0,
                retiredSnapshot.confirmedByActorId,
                retiredSnapshot.confirmedAt,
                retiredSnapshot.revision,
                retiredSnapshot.updatedAt,
                retiredSnapshot.id,
                retiredSnapshot.projectId,
                snapshot.revision,
              ],
            );
            if (updated.rowsAffected !== 1) {
              abortPersistence(
                new StoryCoreError({
                  code: "STORY_REVISION_CONFLICT",
                  message: "A replaced story projection changed before the route was committed.",
                  retryable: true,
                }),
              );
            }
            retiredFactIds.push(retiredSnapshot.id);
          }
        }

        const committedFacts: StoryFact[] = [];
        for (const { fact } of command.facts) {
          const snapshot = fact.toSnapshot();
          await insertFact(transaction, snapshot);
          await insertInitialRevision(transaction, snapshot, "created");
          committedFacts.push(fact);
        }
        const receipt: ContinuousStoryStateRouteReceipt = Object.freeze({
          projectId: command.projectId,
          chapterId: command.chapterId,
          versionId: command.versionId,
          task: command.task,
          sourceContentHash: command.sourceContentHash,
          providerKind: command.providerKind,
          modelId: command.modelId,
          invocationId: command.invocationId,
          candidateCount: command.candidateCount,
          createdFactCount: committedFacts.length,
          retiredFactCount: retiredFactIds.length,
          completedAt: command.completedAt,
        });
        await transaction.execute(
          `INSERT INTO continuous_story_state_route_receipts (
             project_id, chapter_id, version_id, task, source_content_hash,
             provider_kind, model_id, invocation_id, candidate_count,
             created_fact_count, retired_fact_count, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          continuousRouteReceiptValues(receipt),
        );
        return Object.freeze({
          receipt,
          facts: Object.freeze(committedFacts),
          retiredFactIds: Object.freeze(retiredFactIds),
          alreadyCommitted: false,
        });
      }),
    );
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

/**
 * Persists one already-validated story fact and its initial immutable revision
 * inside a caller-owned transaction. Mixed story-setting imports use this
 * boundary so characters, relationships, rules and memories cannot be left
 * half-written when any one insert fails.
 */
export async function insertNewStoryFact(
  transaction: StorySqlTransaction,
  fact: StoryFact,
  changeKind: "created" | "legacy_backfill" = "created",
): Promise<void> {
  const snapshot = fact.toSnapshot();
  await assertChapterEvidence(transaction, snapshot);
  await insertFact(transaction, snapshot);
  await insertInitialRevision(transaction, snapshot, changeKind);
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

const CAUSAL_EVENT_FACT_SCHEMAS = new Set([
  "inkshadow.causal-event-fact.v1",
  "inkshadow.causal-event-fact.v2",
]);
const CAUSAL_RELATION_FACT_SCHEMA = "inkshadow.causal-relation-fact.v1";

/**
 * A caller-provided fence is useful only when it describes the references in
 * the fact being inserted. Keep this check inside the write transaction so a
 * future adapter cannot validate one chapter/entity set while committing a
 * fact that cites another.
 */

function assertAuthorityFencedCreateGovernance(snapshot: StoryFactSnapshot): void {
  const isFormalUserFact =
    snapshot.status === "formal" && snapshot.origin === "user" && snapshot.userConfirmed;
  const isAutomaticChapterFact =
    snapshot.source.kind === "chapter_span" &&
    (snapshot.status === "temporary" || snapshot.status === "unconfirmed") &&
    (snapshot.origin === "system" || snapshot.origin === "ai_extraction") &&
    !snapshot.userConfirmed &&
    !snapshot.locked &&
    !snapshot.deprecated &&
    snapshot.branchId === null;
  if (snapshot.revision !== 1 || (!isFormalUserFact && !isAutomaticChapterFact)) {
    abortPersistence(
      validationFailure(
        "An authority-fenced story fact must be a new formal user fact or governed chapter projection.",
      ),
    );
  }
}

function assertAuthorityFencedRebuildableReplacement(
  snapshot: StoryFactSnapshot,
  replacementKey: string,
  fence: StoryFactAuthorityFence,
): void {
  const structured = storyRecord(snapshot.structuredValue);
  if (
    snapshot.revision !== 1 ||
    !isRebuildableStoryFactType(snapshot.factType) ||
    snapshot.status !== "temporary" ||
    snapshot.origin !== "system" ||
    snapshot.userConfirmed ||
    snapshot.locked ||
    snapshot.deprecated ||
    snapshot.needsReview ||
    snapshot.branchId !== null ||
    structured === null ||
    Object.keys(structured).length !== 3 ||
    structured.schemaVersion !== "inkshadow.rebuildable-system-fact.v1" ||
    structured.replacementKey !== replacementKey ||
    !Object.prototype.hasOwnProperty.call(structured, "payload")
  ) {
    abortPersistence(validationFailure("The authority-fenced rebuildable replacement is invalid."));
  }
  assertAuthorityFenceMatchesFact(snapshot, fence);
}

async function assertCurrentChapterVersion(
  transaction: StorySqlTransaction,
  projectId: string,
  fence: StoryFactAuthorityFence,
): Promise<void> {
  const chapters = await transaction.select<{
    readonly project_id: string;
    readonly current_version_id: string;
  }>(
    `SELECT project_id, current_version_id
     FROM chapters
     WHERE id = ? AND project_id = ? AND status = 'active'
     LIMIT 2`,
    [fence.chapterId, projectId],
  );
  if (chapters.length !== 1 || chapters[0]?.current_version_id !== fence.expectedCurrentVersionId) {
    abortPersistence(
      new StoryCoreError({
        code: "STORY_FACT_SOURCE_FENCE_FAILED",
        message: "The chapter current version changed before the story fact was committed.",
        retryable: true,
      }),
    );
  }
}

function matchesStoredRebuildableReplacement(
  fact: StoryFact,
  factType: string,
  replacementKey: string,
): boolean {
  const snapshot = fact.toSnapshot();
  const structured = storyRecord(snapshot.structuredValue);
  return (
    snapshot.factType === factType &&
    snapshot.status === "temporary" &&
    snapshot.origin === "system" &&
    !snapshot.userConfirmed &&
    !snapshot.locked &&
    !snapshot.deprecated &&
    !snapshot.needsReview &&
    snapshot.branchId === null &&
    structured !== null &&
    Object.keys(structured).length === 3 &&
    structured.schemaVersion === "inkshadow.rebuildable-system-fact.v1" &&
    structured.replacementKey === replacementKey &&
    Object.prototype.hasOwnProperty.call(structured, "payload")
  );
}
function assertAuthorityFenceMatchesFact(
  snapshot: StoryFactSnapshot,
  fence: StoryFactAuthorityFence,
): void {
  const source = snapshot.source;
  const structured = storyRecord(snapshot.structuredValue);
  const supplementalIdentity = supplementalResolutionIdentity(snapshot);
  if (supplementalIdentity !== null) {
    if (
      source.kind !== "review_decision" ||
      supplementalIdentity.chapterId !== fence.chapterId ||
      supplementalIdentity.chapterVersionId !== fence.expectedCurrentVersionId ||
      !sameAuthorityReferences(fence.requiredCausalEventIds, []) ||
      !sameAuthorityReferences(fence.requiredCharacterIds, [])
    ) {
      abortPersistence(validationFailure("The supplemental finding authority fence is invalid."));
    }
    return;
  }
  if (
    source.kind !== "chapter_span" ||
    source.chapterId !== fence.chapterId ||
    source.versionId !== fence.expectedCurrentVersionId
  ) {
    abortPersistence(
      new StoryCoreError({
        code: "STORY_FACT_SOURCE_FENCE_FAILED",
        message: "The authority fence does not match the fact's exact chapter version.",
      }),
    );
  }

  const schemaVersion = structured?.schemaVersion;
  const hasCausalEventSchema =
    typeof schemaVersion === "string" && CAUSAL_EVENT_FACT_SCHEMAS.has(schemaVersion);
  if (snapshot.factType === "causal_relation" || schemaVersion === CAUSAL_RELATION_FACT_SCHEMA) {
    const fromEventId = safeAuthorityReference(structured?.fromEventId);
    const toEventId = safeAuthorityReference(structured?.toEventId);
    if (
      snapshot.factType !== "causal_relation" ||
      schemaVersion !== CAUSAL_RELATION_FACT_SCHEMA ||
      fromEventId === null ||
      toEventId === null ||
      fromEventId === toEventId ||
      !sameAuthorityReferences(fence.requiredCausalEventIds, [fromEventId, toEventId]) ||
      !sameAuthorityReferences(fence.requiredCharacterIds, [])
    ) {
      abortPersistence(
        new StoryCoreError({
          code: "STORY_FACT_RELATION_ENDPOINT_INVALID",
          message: "The causal relation fence does not match the relation endpoints.",
        }),
      );
    }
    return;
  }

  if (snapshot.factType === "causal_event" || hasCausalEventSchema) {
    if (
      snapshot.factType !== "causal_event" ||
      typeof schemaVersion !== "string" ||
      !CAUSAL_EVENT_FACT_SCHEMAS.has(schemaVersion)
    ) {
      abortPersistence(validationFailure("The causal event authority fence is invalid."));
    }
    const prerequisiteEventIds = causalEventPrerequisiteEventReferences(structured);
    const characterIds = causalEventCharacterReferences(structured);
    if (
      prerequisiteEventIds === null ||
      !sameAuthorityReferences(fence.requiredCausalEventIds, prerequisiteEventIds)
    ) {
      abortPersistence(
        new StoryCoreError({
          code: "STORY_FACT_RELATION_ENDPOINT_INVALID",
          message: "The causal event prerequisite fence does not match its event references.",
        }),
      );
    }
    if (
      characterIds === null ||
      !sameAuthorityReferences(fence.requiredCharacterIds, characterIds)
    ) {
      abortPersistence(
        new StoryCoreError({
          code: "STORY_FACT_CHARACTER_AUTHORITY_INVALID",
          message: "The character authority fence does not match the causal event references.",
        }),
      );
    }
    return;
  }

  if (
    !sameAuthorityReferences(fence.requiredCausalEventIds, []) ||
    !sameAuthorityReferences(fence.requiredCharacterIds, [])
  ) {
    abortPersistence(
      validationFailure("This story fact cannot carry causal authority references."),
    );
  }
}

function causalEventPrerequisiteEventReferences(
  structured: Readonly<Record<string, unknown>> | null,
): readonly string[] | null {
  if (structured === null || !Array.isArray(structured.prerequisites)) return null;
  if (structured.prerequisites.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES) return null;
  const references: string[] = [];
  for (const value of structured.prerequisites as readonly unknown[]) {
    const prerequisite = storyRecord(value);
    if (prerequisite === null) return null;
    if (prerequisite.kind !== "event") continue;
    const referenceId = safeAuthorityReference(prerequisite.referenceId);
    if (referenceId === null) return null;
    references.push(referenceId);
  }
  return Object.freeze(references);
}

function causalEventCharacterReferences(
  structured: Readonly<Record<string, unknown>> | null,
): readonly string[] | null {
  if (structured === null) return null;
  const references: string[] = [];
  if (
    !appendAuthorityReferenceArray(references, structured.participantCharacterIds) ||
    !appendAuthorityReferenceArray(references, structured.informedCharacterIds) ||
    !appendAuthorityRecordReferences(references, structured.knowledgeGains, ["characterId"]) ||
    !appendAuthorityRecordReferences(references, structured.characterStateChanges, [
      "characterId",
    ]) ||
    !appendAuthorityRecordReferences(references, structured.relationshipChanges, [
      "fromCharacterId",
      "toCharacterId",
    ]) ||
    !appendAuthorityRecordReferences(
      references,
      structured.itemChanges,
      ["fromCharacterId", "toCharacterId"],
      true,
    )
  ) {
    return null;
  }
  return Object.freeze([...new Set(references)]);
}

function appendAuthorityReferenceArray(target: string[], value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES) {
    return false;
  }
  for (const item of value as readonly unknown[]) {
    const reference = safeAuthorityReference(item);
    if (reference === null) return false;
    target.push(reference);
  }
  return true;
}

function appendAuthorityRecordReferences(
  target: string[],
  value: unknown,
  keys: readonly string[],
  nullable = false,
): boolean {
  if (!Array.isArray(value) || value.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES) {
    return false;
  }
  for (const item of value as readonly unknown[]) {
    const record = storyRecord(item);
    if (record === null) return false;
    for (const key of keys) {
      if (nullable && (record[key] === null || record[key] === undefined)) continue;
      const reference = safeAuthorityReference(record[key]);
      if (reference === null) return false;
      target.push(reference);
    }
  }
  return true;
}

function sameAuthorityReferences(
  actualValue: readonly string[] | undefined,
  expectedValue: readonly string[],
): boolean {
  const actual = actualValue ?? [];
  if (
    actual.length > MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES ||
    new Set(actual).size !== actual.length ||
    new Set(expectedValue).size !== expectedValue.length ||
    actual.some((value) => safeAuthorityReference(value) === null)
  ) {
    return false;
  }
  const expected = new Set(expectedValue);
  return actual.length === expected.size && actual.every((value) => expected.has(value));
}

function safeAuthorityReference(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
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

function validateContinuousRouteIdentity(identity: ContinuousStoryStateRouteIdentity): void {
  const projectId = parseUuidV7(identity.projectId);
  const chapterId = parseUuidV7(identity.chapterId);
  const versionId = parseUuidV7(identity.versionId);
  if (!projectId.ok || !chapterId.ok || !versionId.ok) {
    abortPersistence(validationFailure("Continuous story-state route scope is invalid."));
  }
  if (!CONTINUOUS_STORY_STATE_ROUTE_TASKS.includes(identity.task)) {
    abortPersistence(validationFailure("Continuous story-state route task is invalid."));
  }
}

function validateContinuousRouteCommit(command: ContinuousStoryStateRouteCommit): void {
  validateContinuousRouteIdentity(command);
  if (!/^[a-f0-9]{64}$/u.test(command.sourceContentHash)) {
    abortPersistence(validationFailure("Continuous story-state source hash is invalid."));
  }
  validateContinuousRouteText(command.providerKind, 100, "provider");
  validateContinuousRouteText(command.modelId, 500, "model");
  validateContinuousRouteText(command.invocationId, 500, "invocation");
  const completedAt = parseIsoUtcTimestamp(command.completedAt);
  if (!completedAt.ok) {
    abortPersistence(completedAt.error);
  }
  if (
    !Number.isSafeInteger(command.candidateCount) ||
    command.candidateCount < 0 ||
    command.candidateCount > 128 ||
    command.facts.length > command.candidateCount
  ) {
    abortPersistence(validationFailure("Continuous story-state candidate count is invalid."));
  }
  const expectedReference = `continuous-story-state:${command.task}:${command.versionId}:sha256:${command.sourceContentHash}`;
  const factIds = new Set<string>();
  const replacementKeys = new Set<string>();
  for (const candidate of command.facts) {
    const snapshot = candidate.fact.toSnapshot();
    if (
      factIds.has(snapshot.id) ||
      snapshot.revision !== 1 ||
      snapshot.projectId !== command.projectId ||
      snapshot.source.kind !== "chapter_span" ||
      snapshot.source.chapterId !== command.chapterId ||
      snapshot.source.versionId !== command.versionId ||
      snapshot.source.reference !== expectedReference
    ) {
      abortPersistence(
        validationFailure("A continuous story-state fact does not match its route authority."),
      );
    }
    factIds.add(snapshot.id);
    if (candidate.replacementKey === null) {
      if (
        snapshot.status !== "unconfirmed" ||
        snapshot.origin !== "ai_extraction" ||
        !snapshot.needsReview ||
        snapshot.userConfirmed ||
        snapshot.locked ||
        snapshot.deprecated ||
        snapshot.branchId !== null ||
        readContinuousReplacementKey(snapshot) !== null
      ) {
        abortPersistence(
          validationFailure("A review-required story-state fact has invalid governance."),
        );
      }
      continue;
    }
    validateContinuousRouteText(candidate.replacementKey, 500, "replacement key");
    const identity = continuousReplacementIdentity(snapshot.factType, candidate.replacementKey);
    if (
      replacementKeys.has(identity) ||
      snapshot.status !== "temporary" ||
      snapshot.origin !== "system" ||
      snapshot.needsReview ||
      snapshot.userConfirmed ||
      snapshot.locked ||
      snapshot.deprecated ||
      snapshot.branchId !== null ||
      readContinuousReplacementKey(snapshot) !== candidate.replacementKey
    ) {
      abortPersistence(
        validationFailure("A disposable story-state projection has invalid replacement authority."),
      );
    }
    replacementKeys.add(identity);
  }
}

function validateContinuousRouteText(value: string, maximum: number, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    abortPersistence(validationFailure(`Continuous story-state ${label} is invalid.`));
  }
}

function readContinuousReplacementKey(snapshot: StoryFactSnapshot): string | null {
  const root = storyRecord(snapshot.structuredValue);
  if (
    root === null ||
    (root.schemaVersion !== "inkshadow.rebuildable-system-fact.v1" &&
      root.schemaVersion !== "inkshadow.continuous-story-state.v2")
  ) {
    return null;
  }
  return typeof root.replacementKey === "string" ? root.replacementKey : null;
}

function continuousReplacementIdentity(factType: string, replacementKey: string): string {
  return `${factType}\u0000${replacementKey}`;
}

async function selectContinuousRouteReceipts(
  executor: Pick<StorySqlExecutor, "select">,
  identity: ContinuousStoryStateRouteIdentity,
): Promise<readonly ContinuousStoryStateRouteReceiptRow[]> {
  return executor.select<ContinuousStoryStateRouteReceiptRow>(
    `SELECT project_id, chapter_id, version_id, task, source_content_hash,
            provider_kind, model_id, invocation_id, candidate_count,
            created_fact_count, retired_fact_count, completed_at
     FROM continuous_story_state_route_receipts
     WHERE project_id = ? AND chapter_id = ? AND version_id = ? AND task = ?
     LIMIT 2`,
    [identity.projectId, identity.chapterId, identity.versionId, identity.task],
  );
}

function hydrateContinuousRouteReceipt(
  row: ContinuousStoryStateRouteReceiptRow,
): ContinuousStoryStateRouteReceipt {
  const projectId = parseUuidV7(row.project_id);
  const chapterId = parseUuidV7(row.chapter_id);
  const versionId = parseUuidV7(row.version_id);
  const completedAt = parseIsoUtcTimestamp(row.completed_at);
  if (
    !projectId.ok ||
    !chapterId.ok ||
    !versionId.ok ||
    !completedAt.ok ||
    !CONTINUOUS_STORY_STATE_ROUTE_TASKS.includes(
      row.task as (typeof CONTINUOUS_STORY_STATE_ROUTE_TASKS)[number],
    ) ||
    !/^[a-f0-9]{64}$/u.test(row.source_content_hash) ||
    !Number.isSafeInteger(row.candidate_count) ||
    !Number.isSafeInteger(row.created_fact_count) ||
    !Number.isSafeInteger(row.retired_fact_count) ||
    row.candidate_count < 0 ||
    row.candidate_count > 128 ||
    row.created_fact_count < 0 ||
    row.created_fact_count > row.candidate_count ||
    row.retired_fact_count < 0
  ) {
    abortCorruptSnapshot("CONTINUOUS_STORY_STATE_ROUTE_RECEIPT_INVALID");
  }
  validateContinuousRouteText(row.provider_kind, 100, "provider");
  validateContinuousRouteText(row.model_id, 500, "model");
  validateContinuousRouteText(row.invocation_id, 500, "invocation");
  return Object.freeze({
    projectId: projectId.value,
    chapterId: chapterId.value,
    versionId: versionId.value,
    task: row.task as ContinuousStoryStateRouteReceipt["task"],
    sourceContentHash: row.source_content_hash,
    providerKind: row.provider_kind,
    modelId: row.model_id,
    invocationId: row.invocation_id,
    candidateCount: row.candidate_count,
    createdFactCount: row.created_fact_count,
    retiredFactCount: row.retired_fact_count,
    completedAt: completedAt.value,
  });
}

function continuousRouteReceiptValues(
  receipt: ContinuousStoryStateRouteReceipt,
): readonly StorySqlPrimitive[] {
  return [
    receipt.projectId,
    receipt.chapterId,
    receipt.versionId,
    receipt.task,
    receipt.sourceContentHash,
    receipt.providerKind,
    receipt.modelId,
    receipt.invocationId,
    receipt.candidateCount,
    receipt.createdFactCount,
    receipt.retiredFactCount,
    receipt.completedAt,
  ];
}

function continuousRouteSourceChanged(): StoryCoreError {
  return new StoryCoreError({
    code: "CONTINUOUS_STORY_STATE_ROUTE_SOURCE_CHANGED",
    message: "The chapter version changed before the story-state route was committed.",
    retryable: true,
    actions: ["RETRY", "OPEN_SOURCE"],
  });
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

function storyFactRevisionConflict(
  expectedRevision: number,
  actualRevision: number,
): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REVISION_CONFLICT",
    message: "Story fact changed before it could be saved.",
    retryable: true,
    actions: ["RECOMPARE", "RETRY"],
    details: { expectedRevision, actualRevision },
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
