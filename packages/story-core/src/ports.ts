import type { StoryCoreError } from "./errors.js";
import type { FormalStoryRecord } from "./formal-record.js";
import type { IdeationDraft, ProjectSeed } from "./ideation.js";
import type { MemoryPolicy, MemoryRecord } from "./memory.js";
import type { Material, MaterialReference } from "./material.js";
import type { Outline } from "./outline.js";
import type { Result } from "./result.js";
import type { ReviewItemType, StructuredReviewItem } from "./review-item.js";
import type { IsoUtcTimestamp, UuidV7 } from "./value-objects.js";
import type { OutlineDraftCandidate, WhatIfBranch } from "./what-if.js";

export interface OutlineRepository {
  create(outline: Outline): Promise<Result<void, StoryCoreError>>;

  findByProjectId(projectId: UuidV7): Promise<Result<Outline | null, StoryCoreError>>;

  /**
   * Compare-and-swap persistence. The stored aggregate must still have
   * expectedRevision or the adapter returns STORY_REVISION_CONFLICT.
   */
  save(outline: Outline, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
}

export interface IdeationDraftRepository {
  create(draft: IdeationDraft): Promise<Result<void, StoryCoreError>>;

  findById(id: UuidV7): Promise<Result<IdeationDraft | null, StoryCoreError>>;

  listActive(): Promise<Result<readonly IdeationDraft[], StoryCoreError>>;

  save(draft: IdeationDraft, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
}

export interface CommitIdeationProjectInput {
  readonly draft: IdeationDraft;
  readonly expectedDraftRevision: number;
  readonly projectId: UuidV7;
  readonly seed: ProjectSeed;
}

/**
 * Creates every project artifact described by the seed and finalizes its draft
 * in one transaction. Implementations must leave neither a partial project nor
 * a finalized draft behind when any write fails.
 */
export interface IdeationProjectCommitUnitOfWork {
  commit(input: CommitIdeationProjectInput): Promise<Result<void, StoryCoreError>>;
}

export interface FormalStoryRecordRepository {
  create(record: FormalStoryRecord): Promise<Result<void, StoryCoreError>>;

  findById(id: UuidV7): Promise<Result<FormalStoryRecord | null, StoryCoreError>>;

  save(record: FormalStoryRecord, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
}

export interface FormalStoryRecordListReader {
  listByProjectId(projectId: UuidV7): Promise<Result<readonly FormalStoryRecord[], StoryCoreError>>;
}

export interface FormalTimelineSnapshot {
  readonly projectId: UuidV7;
  readonly revision: number;
  readonly events: readonly FormalStoryRecord[];
}

export interface FormalTimelineReader {
  load(projectId: UuidV7): Promise<Result<FormalTimelineSnapshot, StoryCoreError>>;
}

export interface CurrentChapterVersion {
  readonly chapterId: UuidV7;
  readonly projectId: UuidV7;
  readonly versionId: UuidV7;
}

export interface ChapterVersionReader {
  findCurrent(chapterId: UuidV7): Promise<Result<CurrentChapterVersion | null, StoryCoreError>>;
}

export interface ReviewItemRepository<ItemType extends ReviewItemType> {
  create(item: StructuredReviewItem<ItemType>): Promise<Result<void, StoryCoreError>>;

  findById(id: UuidV7): Promise<Result<StructuredReviewItem<ItemType> | null, StoryCoreError>>;
}

export interface ReviewItemListReader<ItemType extends ReviewItemType> {
  listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly StructuredReviewItem<ItemType>[], StoryCoreError>>;
}

export interface CommitReviewDecisionInput<ItemType extends ReviewItemType> {
  readonly item: StructuredReviewItem<ItemType>;
  readonly expectedItemRevision: number;
  readonly formalRecord: FormalStoryRecord | null;
  readonly expectedFormalRecordRevision: number | null;
  readonly expectedSourceChapterId: UuidV7 | null;
  readonly expectedSourceProjectId: UuidV7 | null;
  readonly expectedSourceVersionId: UuidV7 | null;
}

/**
 * Persists the review decision and its optional formal-record version in one
 * transaction. A decision that carries a formal record also compares the cited
 * chapter version inside that transaction and must never persist only one side
 * of the pair.
 */
export interface ReviewDecisionUnitOfWork<ItemType extends ReviewItemType> {
  commit(input: CommitReviewDecisionInput<ItemType>): Promise<Result<void, StoryCoreError>>;
}

export type ExtractionSuggestionRepository = ReviewItemRepository<"extraction">;

export type ConsistencyIssueRepository = ReviewItemRepository<"consistency">;

export type ExtractionDecisionUnitOfWork = ReviewDecisionUnitOfWork<"extraction">;

export type ConsistencyDecisionUnitOfWork = ReviewDecisionUnitOfWork<"consistency">;

export interface CreateMemoryPolicyResult {
  readonly policy: MemoryPolicy;
  readonly created: boolean;
}

export interface MemoryPolicyRepository {
  createIfAbsent(policy: MemoryPolicy): Promise<Result<CreateMemoryPolicyResult, StoryCoreError>>;

  findByProjectId(projectId: UuidV7): Promise<Result<MemoryPolicy | null, StoryCoreError>>;

  save(policy: MemoryPolicy, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
}

export interface MemoryRecordRepository {
  findById(id: UuidV7): Promise<Result<MemoryRecord | null, StoryCoreError>>;

  save(record: MemoryRecord, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
}

export interface MemoryRecordListReader {
  listByProjectId(projectId: UuidV7): Promise<Result<readonly MemoryRecord[], StoryCoreError>>;
}

export interface CreateMemoryRecordPersistenceInput {
  readonly record: MemoryRecord;
  readonly expectedAutomaticLearningPolicyRevision: number | null;
}

/**
 * Creates user memory directly, or creates automatic memory only while the
 * same project policy is still enabled at the expected revision.
 */
export interface MemoryRecordCreationUnitOfWork {
  create(input: CreateMemoryRecordPersistenceInput): Promise<Result<void, StoryCoreError>>;
}

export type MemoryGovernanceOperation = "forget_project" | "merge";

export type MemoryGovernanceRecordRole = "forgotten" | "merge_target" | "merge_source";

export interface MemoryGovernanceRecordTransition {
  readonly role: MemoryGovernanceRecordRole;
  readonly previous: MemoryRecord;
  readonly next: MemoryRecord;
}

export interface CommitMemoryGovernanceInput {
  readonly operationId: UuidV7;
  readonly projectId: UuidV7;
  readonly operation: MemoryGovernanceOperation;
  readonly targetRecordId: UuidV7 | null;
  readonly previousPolicy: MemoryPolicy | null;
  readonly nextPolicy: MemoryPolicy | null;
  readonly records: readonly MemoryGovernanceRecordTransition[];
  /**
   * Canonical request payload used to make a repeated operation id safe. It
   * intentionally excludes the event timestamp so a lost response can be
   * retried with the same operation id.
   */
  readonly requestJson: string;
  readonly now: IsoUtcTimestamp;
}

export interface MemoryGovernanceReceipt {
  readonly operationId: UuidV7;
  readonly projectId: UuidV7;
  readonly operation: MemoryGovernanceOperation;
  readonly affectedRecordCount: number;
  readonly resultingPolicyRevision: number | null;
  readonly idempotentReplay: boolean;
}

/**
 * Commits project-wide forgetting or a two-record manual merge with its audit
 * event. Implementations must use one atomic commit boundary and exact CAS.
 */
export interface MemoryGovernanceUnitOfWork {
  commit(
    input: CommitMemoryGovernanceInput,
  ): Promise<Result<MemoryGovernanceReceipt, StoryCoreError>>;
}

export interface WhatIfRepository {
  create(branch: WhatIfBranch): Promise<Result<void, StoryCoreError>>;

  findById(id: UuidV7): Promise<Result<WhatIfBranch | null, StoryCoreError>>;

  save(branch: WhatIfBranch, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
}

export interface WhatIfBranchListReader {
  listByProjectId(projectId: UuidV7): Promise<Result<readonly WhatIfBranch[], StoryCoreError>>;
}

export interface OutlineDraftReader {
  listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly OutlineDraftCandidate[], StoryCoreError>>;
}

export interface PromoteWhatIfInput {
  readonly branch: WhatIfBranch;
  readonly expectedBranchRevision: number;
  readonly draft: OutlineDraftCandidate;
}

/**
 * Atomically marks a branch as promoted and inserts its outline-only draft.
 * The port intentionally exposes no operation that writes timeline events.
 */
export interface WhatIfPromotionUnitOfWork {
  commit(input: PromoteWhatIfInput): Promise<Result<void, StoryCoreError>>;
}

export interface MaterialRepository {
  create(material: Material): Promise<Result<void, StoryCoreError>>;

  findById(id: UuidV7): Promise<Result<Material | null, StoryCoreError>>;

  findActiveByFingerprint(
    projectId: UuidV7,
    contentFingerprint: string,
    excludeMaterialId?: UuidV7,
  ): Promise<Result<Material | null, StoryCoreError>>;

  listByProjectId(
    projectId: UuidV7,
    includeDisposed: boolean,
  ): Promise<Result<readonly Material[], StoryCoreError>>;

  save(material: Material, expectedRevision: number): Promise<Result<void, StoryCoreError>>;
}

export interface MaterialReferenceRepository {
  create(reference: MaterialReference): Promise<Result<void, StoryCoreError>>;

  countByMaterialId(materialId: UuidV7): Promise<Result<number, StoryCoreError>>;

  listByMaterialId(
    materialId: UuidV7,
  ): Promise<Result<readonly MaterialReference[], StoryCoreError>>;
}

export interface CommitMaterialDispositionInput {
  readonly material: Material;
  readonly expectedMaterialRevision: number;
  readonly expectedReferenceCount: number;
  readonly survivorId: UuidV7 | null;
  readonly expectedSurvivorRevision: number | null;
}

/**
 * Atomically rechecks reference impact and applies delete/merge disposition.
 * Merge validates that the survivor is still active in the same project;
 * references retain their immutable provenance snapshot and original material.
 */
export interface MaterialDispositionUnitOfWork {
  commit(input: CommitMaterialDispositionInput): Promise<Result<void, StoryCoreError>>;
}

export interface DueDeferredReviewItem {
  readonly itemId: UuidV7;
  readonly itemType: ReviewItemType;
  readonly deferredUntil: IsoUtcTimestamp;
}

export interface DeferredReviewReader {
  listDue(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly DueDeferredReviewItem[], StoryCoreError>>;
}
