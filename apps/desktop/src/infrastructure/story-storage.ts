import {
  FormalStoryRecord,
  IdeationDraft,
  MemoryPolicy,
  MemoryRecord,
  Outline,
  StoryCoreError,
  StructuredReviewItem,
  WhatIfBranch,
  err,
  ok,
  parseIsoUtcTimestamp,
  parseUuidV7,
  validateBoundedText,
  type CreateMemoryPolicyResult,
  type CreateMemoryRecordPersistenceInput,
  type CommitMemoryGovernanceInput,
  type ChapterVersionReader,
  type CommitReviewDecisionInput,
  type FormalStoryRecordListReader,
  type FormalStoryRecordRepository,
  type FormalStoryRecordSnapshot,
  type FormalTimelineReader,
  type FormalTimelineSnapshot,
  type IdeationDraftRepository,
  type IdeationDraftSnapshot,
  type MemoryPolicyRepository,
  type MemoryPolicySnapshot,
  type MemoryGovernanceReceipt,
  type MemoryGovernanceUnitOfWork,
  type MemoryRecordCreationUnitOfWork,
  type MemoryRecordListReader,
  type MemoryRecordRepository,
  type MemoryRecordSnapshot,
  type OutlineDraftCandidate,
  type OutlineDraftReader,
  type OutlineRepository,
  type OutlineSnapshot,
  type PromoteWhatIfInput,
  type Result,
  type ReviewDecisionUnitOfWork,
  type ReviewItemListReader,
  type ReviewItemRepository,
  type ReviewItemType,
  type StructuredReviewItemSnapshot,
  type UuidV7,
  type WhatIfBranchListReader,
  type WhatIfBranchSnapshot,
  type WhatIfPromotionUnitOfWork,
  type WhatIfRepository,
} from "@inkshadow/story-core";

import {
  DEVELOPMENT_STORY_STORE_KEY,
  recoverPreparedIdeationCommit,
} from "./development-atomic-journal";

export { DEVELOPMENT_STORY_STORE_KEY };

interface StoredStoryDatabaseV1 {
  readonly schemaVersion: 1;
  readonly outlines: Record<string, OutlineSnapshot>;
}

interface StoredStoryDatabaseV2 {
  readonly schemaVersion: 2;
  readonly outlines: Record<string, OutlineSnapshot>;
  readonly formalRecords: Record<string, FormalStoryRecordSnapshot>;
  readonly timelineRevisions: Record<string, number>;
  readonly memoryPolicies: Record<string, MemoryPolicySnapshot>;
  readonly memoryRecords: Record<string, MemoryRecordSnapshot>;
}

interface StoredStoryDatabaseV3 {
  readonly schemaVersion: 3;
  readonly outlines: Record<string, OutlineSnapshot>;
  readonly formalRecords: Record<string, FormalStoryRecordSnapshot>;
  readonly timelineRevisions: Record<string, number>;
  readonly memoryPolicies: Record<string, MemoryPolicySnapshot>;
  readonly memoryRecords: Record<string, MemoryRecordSnapshot>;
  readonly whatIfBranches: Record<string, WhatIfBranchSnapshot>;
  readonly outlineDrafts: Record<string, OutlineDraftCandidate>;
}

interface StoredStoryDatabaseV4 {
  readonly schemaVersion: 4;
  readonly outlines: Record<string, OutlineSnapshot>;
  readonly formalRecords: Record<string, FormalStoryRecordSnapshot>;
  readonly timelineRevisions: Record<string, number>;
  readonly memoryPolicies: Record<string, MemoryPolicySnapshot>;
  readonly memoryRecords: Record<string, MemoryRecordSnapshot>;
  readonly whatIfBranches: Record<string, WhatIfBranchSnapshot>;
  readonly outlineDrafts: Record<string, OutlineDraftCandidate>;
  readonly reviewItems: Record<string, StructuredReviewItemSnapshot>;
}

interface StoredStoryDatabaseV5 {
  readonly schemaVersion: 5;
  readonly outlines: Record<string, OutlineSnapshot>;
  readonly formalRecords: Record<string, FormalStoryRecordSnapshot>;
  readonly timelineRevisions: Record<string, number>;
  readonly memoryPolicies: Record<string, MemoryPolicySnapshot>;
  readonly memoryRecords: Record<string, MemoryRecordSnapshot>;
  readonly whatIfBranches: Record<string, WhatIfBranchSnapshot>;
  readonly outlineDrafts: Record<string, OutlineDraftCandidate>;
  readonly reviewItems: Record<string, StructuredReviewItemSnapshot>;
  readonly ideationDrafts: Record<string, IdeationDraftSnapshot>;
}

interface StoredMemoryGovernanceEvent {
  readonly id: string;
  readonly projectId: string;
  readonly operation: "forget_project" | "merge";
  readonly targetRecordId: string | null;
  readonly affectedRecordCount: number;
  readonly resultingPolicyRevision: number | null;
  readonly requestJson: string;
  readonly beforeSnapshotJson: string;
  readonly afterSnapshotJson: string;
  readonly createdAt: string;
}

export interface DevelopmentStoredStoryDatabase {
  readonly schemaVersion: 6;
  readonly outlines: Record<string, OutlineSnapshot>;
  readonly formalRecords: Record<string, FormalStoryRecordSnapshot>;
  readonly timelineRevisions: Record<string, number>;
  readonly memoryPolicies: Record<string, MemoryPolicySnapshot>;
  readonly memoryRecords: Record<string, MemoryRecordSnapshot>;
  readonly whatIfBranches: Record<string, WhatIfBranchSnapshot>;
  readonly outlineDrafts: Record<string, OutlineDraftCandidate>;
  readonly reviewItems: Record<string, StructuredReviewItemSnapshot>;
  readonly ideationDrafts: Record<string, IdeationDraftSnapshot>;
  readonly memoryGovernanceEvents: Record<string, StoredMemoryGovernanceEvent>;
}

type StoredStoryDatabase = DevelopmentStoredStoryDatabase;

export class BrowserDevelopmentOutlineRepository implements OutlineRepository {
  public constructor(private readonly storage: Storage) {}

  public create(outline: Outline): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      if (database.outlines[outline.projectId] !== undefined) {
        return repositoryFailure("Project outline already exists.");
      }
      database.outlines[outline.projectId] = outline.toSnapshot();
      return ok(undefined);
    });
  }

  public findByProjectId(projectId: UuidV7): Promise<Result<Outline | null, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => {
      const snapshot = database.outlines[projectId];
      if (snapshot === undefined) {
        return null;
      }
      const outline = Outline.rehydrate(snapshot);
      if (!outline.ok || outline.value.projectId !== projectId) {
        throw corruptStoryStore();
      }
      return outline.value;
    });
  }

  public save(outline: Outline, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const currentSnapshot = database.outlines[outline.projectId];
      if (currentSnapshot === undefined) {
        return repositoryFailure("Project outline was not found.", "OUTLINE_NOT_FOUND");
      }
      const current = requireOutline(currentSnapshot);
      if (current.revision !== expectedRevision || outline.revision !== expectedRevision + 1) {
        return revisionConflict("Outline", expectedRevision, current.revision);
      }
      database.outlines[outline.projectId] = outline.toSnapshot();
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentIdeationDraftRepository implements IdeationDraftRepository {
  public constructor(private readonly storage: Storage) {}

  public create(draft: IdeationDraft): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      if (database.ideationDrafts[draft.id] !== undefined) {
        return repositoryFailure("Ideation draft already exists.");
      }
      database.ideationDrafts[draft.id] = draft.toSnapshot();
      return ok(undefined);
    });
  }

  public findById(id: UuidV7): Promise<Result<IdeationDraft | null, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => {
      const snapshot = database.ideationDrafts[id];
      return snapshot === undefined ? null : requireIdeationDraft(snapshot);
    });
  }

  public listActive(): Promise<Result<readonly IdeationDraft[], StoryCoreError>> {
    return readStoryResult(this.storage, (database) =>
      Object.values(database.ideationDrafts)
        .filter(({ status }) => status === "active")
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
        )
        .map(requireIdeationDraft),
    );
  }

  public save(
    draft: IdeationDraft,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const currentSnapshot = database.ideationDrafts[draft.id];
      if (currentSnapshot === undefined) {
        return repositoryFailure("Ideation draft was not found.", "IDEATION_DRAFT_NOT_FOUND");
      }
      const current = requireIdeationDraft(currentSnapshot);
      if (current.revision !== expectedRevision || draft.revision !== expectedRevision + 1) {
        return revisionConflict("Ideation draft", expectedRevision, current.revision);
      }
      database.ideationDrafts[draft.id] = draft.toSnapshot();
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentFormalStoryRecordRepository
  implements FormalStoryRecordRepository, FormalStoryRecordListReader, FormalTimelineReader
{
  public constructor(private readonly storage: Storage) {}

  public create(record: FormalStoryRecord): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = record.toSnapshot();
      if (database.formalRecords[snapshot.id] !== undefined) {
        return repositoryFailure("Formal story record already exists.");
      }
      const duplicateKey = Object.values(database.formalRecords).some(
        (candidate) =>
          candidate.projectId === snapshot.projectId &&
          candidate.kind === snapshot.kind &&
          candidate.recordKey === snapshot.recordKey,
      );
      if (duplicateKey) {
        return repositoryFailure("Formal story record key already exists.");
      }
      database.formalRecords[snapshot.id] = snapshot;
      if (snapshot.kind === "timeline_event") {
        bumpTimelineRevision(database, snapshot.projectId);
      }
      return ok(undefined);
    });
  }

  public findById(id: UuidV7): Promise<Result<FormalStoryRecord | null, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => {
      const snapshot = database.formalRecords[id];
      return snapshot === undefined ? null : requireFormalRecord(snapshot);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly FormalStoryRecord[], StoryCoreError>> {
    return readStoryResult(this.storage, (database) =>
      Object.values(database.formalRecords)
        .filter((snapshot) => snapshot.projectId === projectId)
        .sort(compareFormalSnapshots)
        .map(requireFormalRecord),
    );
  }

  public load(projectId: UuidV7): Promise<Result<FormalTimelineSnapshot, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => ({
      projectId,
      revision: database.timelineRevisions[projectId] ?? 1,
      events: Object.freeze(
        Object.values(database.formalRecords)
          .filter(
            (snapshot) => snapshot.projectId === projectId && snapshot.kind === "timeline_event",
          )
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .map(requireFormalRecord),
      ),
    }));
  }

  public save(
    record: FormalStoryRecord,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = record.toSnapshot();
      const currentSnapshot = database.formalRecords[snapshot.id];
      if (currentSnapshot === undefined) {
        return repositoryFailure("Formal story record was not found.", "FORMAL_RECORD_NOT_FOUND");
      }
      const current = requireFormalRecord(currentSnapshot);
      if (current.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
        return revisionConflict("Formal story record", expectedRevision, current.revision);
      }
      const currentProjection = current.toSnapshot();
      if (
        currentProjection.projectId !== snapshot.projectId ||
        currentProjection.kind !== snapshot.kind ||
        currentProjection.recordKey !== snapshot.recordKey
      ) {
        return repositoryFailure("Formal story record identity cannot change.");
      }
      database.formalRecords[snapshot.id] = snapshot;
      if (snapshot.kind === "timeline_event") {
        bumpTimelineRevision(database, snapshot.projectId);
      }
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentMemoryPolicyRepository implements MemoryPolicyRepository {
  public constructor(private readonly storage: Storage) {}

  public createIfAbsent(
    policy: MemoryPolicy,
  ): Promise<Result<CreateMemoryPolicyResult, StoryCoreError>> {
    return mutateStoryDatabase<CreateMemoryPolicyResult>(this.storage, (database) => {
      const snapshot = policy.toSnapshot();
      const existingSnapshot = database.memoryPolicies[snapshot.projectId];
      if (existingSnapshot !== undefined) {
        return ok({
          policy: requireMemoryPolicy(existingSnapshot),
          created: false,
        });
      }
      database.memoryPolicies[snapshot.projectId] = snapshot;
      return ok({ policy, created: true });
    });
  }

  public findByProjectId(projectId: UuidV7): Promise<Result<MemoryPolicy | null, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => {
      const snapshot = database.memoryPolicies[projectId];
      return snapshot === undefined ? null : requireMemoryPolicy(snapshot);
    });
  }

  public save(
    policy: MemoryPolicy,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = policy.toSnapshot();
      const currentSnapshot = database.memoryPolicies[snapshot.projectId];
      if (currentSnapshot === undefined) {
        return repositoryFailure("Memory policy was not found.");
      }
      const current = requireMemoryPolicy(currentSnapshot);
      if (current.revision !== expectedRevision || policy.revision !== expectedRevision + 1) {
        return revisionConflict("Memory policy", expectedRevision, current.revision);
      }
      database.memoryPolicies[snapshot.projectId] = snapshot;
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentMemoryRecordRepository
  implements MemoryRecordRepository, MemoryRecordListReader
{
  public constructor(private readonly storage: Storage) {}

  public findById(id: UuidV7): Promise<Result<MemoryRecord | null, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => {
      const snapshot = database.memoryRecords[id];
      return snapshot === undefined ? null : requireMemoryRecord(snapshot);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly MemoryRecord[], StoryCoreError>> {
    return readStoryResult(this.storage, (database) =>
      Object.values(database.memoryRecords)
        .filter((snapshot) => snapshot.projectId === projectId)
        .sort(compareMemorySnapshots)
        .map(requireMemoryRecord),
    );
  }

  public save(
    record: MemoryRecord,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = record.toSnapshot();
      const currentSnapshot = database.memoryRecords[snapshot.id];
      if (currentSnapshot === undefined) {
        return repositoryFailure("Memory record was not found.", "MEMORY_RECORD_NOT_FOUND");
      }
      const current = requireMemoryRecord(currentSnapshot);
      if (current.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
        return revisionConflict("Memory record", expectedRevision, current.revision);
      }
      if (current.projectId !== snapshot.projectId) {
        return repositoryFailure("Memory record project cannot change.");
      }
      database.memoryRecords[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentMemoryRecordCreationUnitOfWork implements MemoryRecordCreationUnitOfWork {
  public constructor(private readonly storage: Storage) {}

  public create(input: CreateMemoryRecordPersistenceInput): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = input.record.toSnapshot();
      if (database.memoryRecords[snapshot.id] !== undefined) {
        return repositoryFailure("Memory record already exists.");
      }
      if (snapshot.origin === "automatic") {
        const policySnapshot = database.memoryPolicies[snapshot.projectId];
        const expectedRevision = input.expectedAutomaticLearningPolicyRevision;
        if (
          expectedRevision === null ||
          snapshot.automaticLearningPolicyRevision !== expectedRevision ||
          policySnapshot === undefined
        ) {
          return automaticMemoryAuthorizationError();
        }
        const policy = requireMemoryPolicy(policySnapshot);
        if (!policy.automaticLearningEnabled || policy.revision !== expectedRevision) {
          return automaticMemoryAuthorizationError();
        }
      } else if (
        input.expectedAutomaticLearningPolicyRevision !== null ||
        snapshot.automaticLearningPolicyRevision !== null
      ) {
        return repositoryFailure("User memory cannot carry automatic-learning authorization.");
      }
      database.memoryRecords[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentMemoryGovernanceUnitOfWork implements MemoryGovernanceUnitOfWork {
  public constructor(private readonly storage: Storage) {}

  public commit(
    input: CommitMemoryGovernanceInput,
  ): Promise<Result<MemoryGovernanceReceipt, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const inputError = validateBrowserMemoryGovernanceInput(input);
      if (inputError !== null) {
        return inputError;
      }
      const existing = database.memoryGovernanceEvents[input.operationId];
      if (existing !== undefined) {
        if (
          existing.projectId !== input.projectId ||
          existing.operation !== input.operation ||
          existing.targetRecordId !== input.targetRecordId ||
          existing.requestJson !== input.requestJson
        ) {
          return memoryIdempotencyConflict();
        }
        return ok(memoryGovernanceReceipt(existing, true));
      }

      if (input.operation === "forget_project") {
        const previousPolicy = input.previousPolicy;
        if (previousPolicy === null) {
          return repositoryFailure("Project memory forgetting requires a policy snapshot.");
        }
        const policySnapshot = database.memoryPolicies[input.projectId];
        if (policySnapshot === undefined) {
          return repositoryFailure("Memory policy was not found.");
        }
        const currentPolicy = requireMemoryPolicy(policySnapshot);
        if (currentPolicy.revision !== previousPolicy.revision) {
          return revisionConflict("Memory policy", previousPolicy.revision, currentPolicy.revision);
        }
        const current = Object.values(database.memoryRecords)
          .filter(({ projectId }) => projectId === input.projectId)
          .sort((left, right) => left.id.localeCompare(right.id));
        const expected = [...input.records]
          .map(({ previous }) => previous.toSnapshot())
          .sort((left, right) => left.id.localeCompare(right.id));
        const currentFingerprint = current
          .map(({ id, revision }) => `${id}:${String(revision)}`)
          .join("|");
        const expectedFingerprint = expected
          .map(({ id, revision }) => `${id}:${String(revision)}`)
          .join("|");
        const scopeMatches =
          current.length === expected.length && currentFingerprint === expectedFingerprint;
        if (!scopeMatches) {
          return revisionConflict("Project memory scope", expected.length, current.length);
        }
      } else {
        for (const { previous } of input.records) {
          const currentSnapshot = database.memoryRecords[previous.id];
          if (currentSnapshot === undefined) {
            return repositoryFailure("Memory record was not found.", "MEMORY_RECORD_NOT_FOUND");
          }
          const current = requireMemoryRecord(currentSnapshot);
          if (current.projectId !== input.projectId || current.revision !== previous.revision) {
            return revisionConflict("Memory record", previous.revision, current.revision);
          }
        }
      }

      if (
        input.previousPolicy !== null &&
        input.nextPolicy !== null &&
        input.nextPolicy.revision !== input.previousPolicy.revision
      ) {
        database.memoryPolicies[input.projectId] = input.nextPolicy.toSnapshot();
      }
      for (const { previous, next } of input.records) {
        if (next.revision !== previous.revision) {
          database.memoryRecords[next.id] = next.toSnapshot();
        }
      }

      const event: StoredMemoryGovernanceEvent = {
        id: input.operationId,
        projectId: input.projectId,
        operation: input.operation,
        targetRecordId: input.targetRecordId,
        affectedRecordCount: input.records.length,
        resultingPolicyRevision: input.nextPolicy?.revision ?? null,
        requestJson: input.requestJson,
        beforeSnapshotJson: JSON.stringify({
          policy: input.previousPolicy?.toSnapshot() ?? null,
          records: input.records.map(({ role, previous }) => ({
            role,
            snapshot: previous.toSnapshot(),
          })),
        }),
        afterSnapshotJson: JSON.stringify({
          policy: input.nextPolicy?.toSnapshot() ?? null,
          records: input.records.map(({ role, next }) => ({
            role,
            snapshot: next.toSnapshot(),
          })),
        }),
        createdAt: input.now,
      };
      database.memoryGovernanceEvents[input.operationId] = event;
      return ok(memoryGovernanceReceipt(event, false));
    });
  }
}

export class BrowserDevelopmentWhatIfRepository
  implements WhatIfRepository, WhatIfBranchListReader
{
  public constructor(private readonly storage: Storage) {}

  public create(branch: WhatIfBranch): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = branch.toSnapshot();
      if (database.whatIfBranches[snapshot.id] !== undefined) {
        return repositoryFailure("What-if branch already exists.");
      }
      database.whatIfBranches[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }

  public findById(id: UuidV7): Promise<Result<WhatIfBranch | null, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => {
      const snapshot = database.whatIfBranches[id];
      return snapshot === undefined ? null : requireWhatIfBranch(snapshot);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly WhatIfBranch[], StoryCoreError>> {
    return readStoryResult(this.storage, (database) =>
      Object.values(database.whatIfBranches)
        .filter((snapshot) => snapshot.projectId === projectId)
        .sort(compareWhatIfSnapshots)
        .map(requireWhatIfBranch),
    );
  }

  public save(
    branch: WhatIfBranch,
    expectedRevision: number,
  ): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = branch.toSnapshot();
      const currentSnapshot = database.whatIfBranches[snapshot.id];
      if (currentSnapshot === undefined) {
        return repositoryFailure("What-if branch was not found.", "WHAT_IF_NOT_FOUND");
      }
      const current = requireWhatIfBranch(currentSnapshot);
      if (current.revision !== expectedRevision || branch.revision !== expectedRevision + 1) {
        return revisionConflict("What-if branch", expectedRevision, current.revision);
      }
      const currentProjection = current.toSnapshot();
      if (
        currentProjection.projectId !== snapshot.projectId ||
        currentProjection.sourceEventId !== snapshot.sourceEventId ||
        currentProjection.baseTimelineRevision !== snapshot.baseTimelineRevision
      ) {
        return repositoryFailure("What-if branch identity cannot change.");
      }
      database.whatIfBranches[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentWhatIfPromotionUnitOfWork implements WhatIfPromotionUnitOfWork {
  public constructor(private readonly storage: Storage) {}

  public commit(input: PromoteWhatIfInput): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const branch = input.branch.toSnapshot();
      const currentSnapshot = database.whatIfBranches[branch.id];
      if (currentSnapshot === undefined) {
        return repositoryFailure("What-if branch was not found.", "WHAT_IF_NOT_FOUND");
      }
      const current = requireWhatIfBranch(currentSnapshot);
      if (
        current.revision !== input.expectedBranchRevision ||
        branch.revision !== input.expectedBranchRevision + 1
      ) {
        return revisionConflict("What-if branch", input.expectedBranchRevision, current.revision);
      }
      if (
        branch.status !== "promoted_to_outline_draft" ||
        input.draft.sourceBranchId !== branch.id ||
        input.draft.projectId !== branch.projectId ||
        input.draft.createdAt !== branch.updatedAt ||
        Object.values(database.outlineDrafts).some(
          (draft) =>
            draft.id === input.draft.id || draft.sourceBranchId === input.draft.sourceBranchId,
        )
      ) {
        return repositoryFailure("What-if promotion does not match a unique outline draft.");
      }
      database.whatIfBranches[branch.id] = branch;
      database.outlineDrafts[input.draft.id] = structuredClone(input.draft);
      return ok(undefined);
    });
  }
}

export class BrowserDevelopmentOutlineDraftReader implements OutlineDraftReader {
  public constructor(private readonly storage: Storage) {}

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly OutlineDraftCandidate[], StoryCoreError>> {
    return readStoryResult(this.storage, (database) =>
      Object.values(database.outlineDrafts)
        .filter((draft) => draft.projectId === projectId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
        )
        .map(requireOutlineDraft),
    );
  }
}

export class BrowserDevelopmentReviewItemRepository<ItemType extends ReviewItemType>
  implements ReviewItemRepository<ItemType>, ReviewItemListReader<ItemType>
{
  public constructor(
    private readonly storage: Storage,
    private readonly itemType: ItemType,
  ) {}

  public create(item: StructuredReviewItem<ItemType>): Promise<Result<void, StoryCoreError>> {
    return mutateStoryDatabase(this.storage, (database) => {
      const snapshot = item.toSnapshot();
      if (snapshot.itemType !== this.itemType || database.reviewItems[snapshot.id] !== undefined) {
        return repositoryFailure("Structured review item already exists or has the wrong type.");
      }
      database.reviewItems[snapshot.id] = snapshot;
      return ok(undefined);
    });
  }

  public findById(
    id: UuidV7,
  ): Promise<Result<StructuredReviewItem<ItemType> | null, StoryCoreError>> {
    return readStoryResult(this.storage, (database) => {
      const snapshot = database.reviewItems[id];
      return snapshot === undefined ? null : requireReviewItem(snapshot, this.itemType);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly StructuredReviewItem<ItemType>[], StoryCoreError>> {
    return readStoryResult(this.storage, (database) =>
      Object.values(database.reviewItems)
        .filter(
          (snapshot) => snapshot.projectId === projectId && snapshot.itemType === this.itemType,
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
        )
        .map((snapshot) => requireReviewItem(snapshot, this.itemType)),
    );
  }
}

export class BrowserDevelopmentReviewDecisionUnitOfWork<
  ItemType extends ReviewItemType,
> implements ReviewDecisionUnitOfWork<ItemType> {
  public constructor(
    private readonly storage: Storage,
    private readonly itemType: ItemType,
    private readonly sourceVersions: ChapterVersionReader,
  ) {}

  public async commit(
    input: CommitReviewDecisionInput<ItemType>,
  ): Promise<Result<void, StoryCoreError>> {
    if (input.formalRecord !== null) {
      const chapterId = input.expectedSourceChapterId;
      const projectId = input.expectedSourceProjectId;
      const versionId = input.expectedSourceVersionId;
      if (chapterId === null || projectId === null || versionId === null) {
        return repositoryFailure("Formal review source expectations are incomplete.");
      }
      const source = await this.sourceVersions.findCurrent(chapterId);
      if (!source.ok) {
        return source;
      }
      if (source.value?.projectId !== projectId || source.value.versionId !== versionId) {
        return reviewSourceChangedError(chapterId, versionId, source.value?.versionId ?? null);
      }
    }

    return mutateStoryDatabase(this.storage, (database) => {
      const changedSnapshot = input.item.toSnapshot();
      const currentSnapshot = database.reviewItems[changedSnapshot.id];
      if (currentSnapshot === undefined) {
        return repositoryFailure("Structured review item was not found.", "REVIEW_ITEM_NOT_FOUND");
      }
      const current = requireReviewItem(currentSnapshot, this.itemType);
      const currentProjection = current.toSnapshot();
      if (
        current.revision !== input.expectedItemRevision ||
        input.item.revision !== input.expectedItemRevision + 1
      ) {
        return revisionConflict(
          "Structured review item",
          input.expectedItemRevision,
          current.revision,
        );
      }
      if (
        changedSnapshot.itemType !== this.itemType ||
        currentProjection.projectId !== changedSnapshot.projectId ||
        currentProjection.targetRecordId !== changedSnapshot.targetRecordId ||
        currentProjection.sourceChapterId !== changedSnapshot.sourceChapterId ||
        currentProjection.sourceVersionId !== changedSnapshot.sourceVersionId
      ) {
        return repositoryFailure("Structured review item identity cannot change.");
      }

      if (input.formalRecord === null) {
        if (
          input.expectedFormalRecordRevision !== null ||
          input.expectedSourceChapterId !== null ||
          input.expectedSourceProjectId !== null ||
          input.expectedSourceVersionId !== null
        ) {
          return repositoryFailure("Non-formal review decision has formal expectations.");
        }
      } else {
        const formalSnapshot = input.formalRecord.toSnapshot();
        const expectedFormalRevision = input.expectedFormalRecordRevision;
        if (
          expectedFormalRevision === null ||
          input.expectedSourceChapterId !== changedSnapshot.sourceChapterId ||
          input.expectedSourceProjectId !== changedSnapshot.projectId ||
          input.expectedSourceVersionId !== changedSnapshot.sourceVersionId ||
          formalSnapshot.id !== changedSnapshot.targetRecordId ||
          formalSnapshot.projectId !== changedSnapshot.projectId
        ) {
          return repositoryFailure("Formal review decision does not match its source.");
        }
        const storedFormalSnapshot = database.formalRecords[formalSnapshot.id];
        if (storedFormalSnapshot === undefined) {
          return repositoryFailure("Formal story record was not found.", "FORMAL_RECORD_NOT_FOUND");
        }
        const storedFormal = requireFormalRecord(storedFormalSnapshot);
        if (
          storedFormal.revision !== expectedFormalRevision ||
          input.formalRecord.revision !== expectedFormalRevision + 1
        ) {
          return revisionConflict(
            "Formal story record",
            expectedFormalRevision,
            storedFormal.revision,
          );
        }
        database.formalRecords[formalSnapshot.id] = formalSnapshot;
        if (formalSnapshot.kind === "timeline_event") {
          bumpTimelineRevision(database, formalSnapshot.projectId);
        }
      }

      database.reviewItems[changedSnapshot.id] = changedSnapshot;
      return ok(undefined);
    });
  }
}

function readStoryResult<Value>(
  storage: Storage,
  operation: (database: StoredStoryDatabase) => Value,
): Promise<Result<Value, StoryCoreError>> {
  try {
    return Promise.resolve(ok(operation(readDevelopmentStoryDatabase(storage))));
  } catch (cause: unknown) {
    return Promise.resolve(err(normalizeStoryStorageError(cause, "read")));
  }
}

function mutateStoryDatabase<Value>(
  storage: Storage,
  operation: (database: StoredStoryDatabase) => Result<Value, StoryCoreError>,
): Promise<Result<Value, StoryCoreError>> {
  try {
    const database = readDevelopmentStoryDatabase(storage);
    const result = operation(database);
    if (result.ok) {
      storage.setItem(DEVELOPMENT_STORY_STORE_KEY, JSON.stringify(database));
    }
    return Promise.resolve(result);
  } catch (cause: unknown) {
    return Promise.resolve(err(normalizeStoryStorageError(cause, "write")));
  }
}

export function readDevelopmentStoryDatabase(storage: Storage): DevelopmentStoredStoryDatabase {
  recoverPreparedIdeationCommit(storage);
  const serialized = storage.getItem(DEVELOPMENT_STORY_STORE_KEY);
  if (serialized === null) {
    return emptyStoryDatabase();
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    const database = isStoredStoryDatabaseV1(parsed)
      ? migrateStoryDatabaseV1(parsed)
      : isStoredStoryDatabaseV2(parsed)
        ? migrateStoryDatabaseV2(parsed)
        : isStoredStoryDatabaseV3(parsed)
          ? migrateStoryDatabaseV3(parsed)
          : isStoredStoryDatabaseV4(parsed)
            ? migrateStoryDatabaseV4(parsed)
            : isStoredStoryDatabaseV5(parsed)
              ? migrateStoryDatabaseV5(parsed)
              : requireStoredStoryDatabase(parsed);
    validateStoryDatabase(database);
    return structuredClone(database);
  } catch (cause: unknown) {
    throw normalizeStoryStorageError(cause, "read");
  }
}

function emptyStoryDatabase(): StoredStoryDatabase {
  return {
    schemaVersion: 6,
    outlines: {},
    formalRecords: {},
    timelineRevisions: {},
    memoryPolicies: {},
    memoryRecords: {},
    whatIfBranches: {},
    outlineDrafts: {},
    reviewItems: {},
    ideationDrafts: {},
    memoryGovernanceEvents: {},
  };
}

function migrateStoryDatabaseV1(database: StoredStoryDatabaseV1): StoredStoryDatabase {
  return {
    ...emptyStoryDatabase(),
    outlines: structuredClone(database.outlines),
  };
}

function migrateStoryDatabaseV2(database: StoredStoryDatabaseV2): StoredStoryDatabase {
  return {
    ...structuredClone(database),
    schemaVersion: 6,
    whatIfBranches: {},
    outlineDrafts: {},
    reviewItems: {},
    ideationDrafts: {},
    memoryGovernanceEvents: {},
  };
}

function migrateStoryDatabaseV3(database: StoredStoryDatabaseV3): StoredStoryDatabase {
  return {
    ...structuredClone(database),
    schemaVersion: 6,
    reviewItems: {},
    ideationDrafts: {},
    memoryGovernanceEvents: {},
  };
}

function migrateStoryDatabaseV4(database: StoredStoryDatabaseV4): StoredStoryDatabase {
  return {
    ...structuredClone(database),
    schemaVersion: 6,
    ideationDrafts: {},
    memoryGovernanceEvents: {},
  };
}

function migrateStoryDatabaseV5(database: StoredStoryDatabaseV5): StoredStoryDatabase {
  return {
    ...structuredClone(database),
    schemaVersion: 6,
    memoryGovernanceEvents: {},
  };
}

function requireStoredStoryDatabase(value: unknown): StoredStoryDatabase {
  if (
    !isObject(value) ||
    value.schemaVersion !== 6 ||
    !isRecordMap(value.outlines) ||
    !isRecordMap(value.formalRecords) ||
    !isRecordMap(value.timelineRevisions) ||
    !isRecordMap(value.memoryPolicies) ||
    !isRecordMap(value.memoryRecords) ||
    !isRecordMap(value.whatIfBranches) ||
    !isRecordMap(value.outlineDrafts) ||
    !isRecordMap(value.reviewItems) ||
    !isRecordMap(value.ideationDrafts) ||
    !isRecordMap(value.memoryGovernanceEvents)
  ) {
    throw corruptStoryStore();
  }
  return value as unknown as StoredStoryDatabase;
}

function isStoredStoryDatabaseV1(value: unknown): value is StoredStoryDatabaseV1 {
  return isObject(value) && value.schemaVersion === 1 && isRecordMap(value.outlines);
}

function isStoredStoryDatabaseV2(value: unknown): value is StoredStoryDatabaseV2 {
  return (
    isObject(value) &&
    value.schemaVersion === 2 &&
    isRecordMap(value.outlines) &&
    isRecordMap(value.formalRecords) &&
    isRecordMap(value.timelineRevisions) &&
    isRecordMap(value.memoryPolicies) &&
    isRecordMap(value.memoryRecords)
  );
}

function isStoredStoryDatabaseV3(value: unknown): value is StoredStoryDatabaseV3 {
  return (
    isObject(value) &&
    value.schemaVersion === 3 &&
    isRecordMap(value.outlines) &&
    isRecordMap(value.formalRecords) &&
    isRecordMap(value.timelineRevisions) &&
    isRecordMap(value.memoryPolicies) &&
    isRecordMap(value.memoryRecords) &&
    isRecordMap(value.whatIfBranches) &&
    isRecordMap(value.outlineDrafts)
  );
}

function isStoredStoryDatabaseV4(value: unknown): value is StoredStoryDatabaseV4 {
  return (
    isObject(value) &&
    value.schemaVersion === 4 &&
    isRecordMap(value.outlines) &&
    isRecordMap(value.formalRecords) &&
    isRecordMap(value.timelineRevisions) &&
    isRecordMap(value.memoryPolicies) &&
    isRecordMap(value.memoryRecords) &&
    isRecordMap(value.whatIfBranches) &&
    isRecordMap(value.outlineDrafts) &&
    isRecordMap(value.reviewItems)
  );
}

function isStoredStoryDatabaseV5(value: unknown): value is StoredStoryDatabaseV5 {
  return (
    isObject(value) &&
    value.schemaVersion === 5 &&
    isRecordMap(value.outlines) &&
    isRecordMap(value.formalRecords) &&
    isRecordMap(value.timelineRevisions) &&
    isRecordMap(value.memoryPolicies) &&
    isRecordMap(value.memoryRecords) &&
    isRecordMap(value.whatIfBranches) &&
    isRecordMap(value.outlineDrafts) &&
    isRecordMap(value.reviewItems) &&
    isRecordMap(value.ideationDrafts)
  );
}

function validateStoryDatabase(database: StoredStoryDatabase): void {
  for (const [projectId, snapshot] of Object.entries(database.outlines)) {
    const outline = Outline.rehydrate(snapshot);
    if (!outline.ok || outline.value.projectId !== projectId) {
      throw corruptStoryStore();
    }
  }
  for (const [id, snapshot] of Object.entries(database.formalRecords)) {
    const record = FormalStoryRecord.rehydrate(snapshot);
    if (!record.ok || record.value.id !== id) {
      throw corruptStoryStore();
    }
  }
  for (const [projectId, revision] of Object.entries(database.timelineRevisions)) {
    if (!parseUuidV7(projectId).ok || !Number.isSafeInteger(revision) || revision < 2) {
      throw corruptStoryStore();
    }
  }
  for (const [projectId, snapshot] of Object.entries(database.memoryPolicies)) {
    const policy = MemoryPolicy.rehydrate(snapshot);
    if (!policy.ok || policy.value.projectId !== projectId) {
      throw corruptStoryStore();
    }
  }
  for (const [id, snapshot] of Object.entries(database.memoryRecords)) {
    const record = MemoryRecord.rehydrate(snapshot);
    if (!record.ok || record.value.id !== id) {
      throw corruptStoryStore();
    }
  }
  for (const [id, snapshot] of Object.entries(database.whatIfBranches)) {
    const branch = WhatIfBranch.rehydrate(snapshot);
    if (!branch.ok || branch.value.id !== id) {
      throw corruptStoryStore();
    }
  }
  for (const [id, snapshot] of Object.entries(database.outlineDrafts)) {
    const draft = requireOutlineDraft(snapshot);
    if (draft.id !== id) {
      throw corruptStoryStore();
    }
  }
  for (const [id, snapshot] of Object.entries(database.reviewItems)) {
    const item = StructuredReviewItem.rehydrate(snapshot);
    if (!item.ok || item.value.id !== id) {
      throw corruptStoryStore();
    }
  }
  for (const [id, snapshot] of Object.entries(database.ideationDrafts)) {
    const draft = IdeationDraft.rehydrate(snapshot);
    if (!draft.ok || draft.value.id !== id) {
      throw corruptStoryStore();
    }
  }
  for (const [id, event] of Object.entries(database.memoryGovernanceEvents)) {
    if (!isStoredMemoryGovernanceEvent(event) || event.id !== id) {
      throw corruptStoryStore();
    }
  }
}

function requireOutline(snapshot: OutlineSnapshot): Outline {
  const outline = Outline.rehydrate(snapshot);
  if (!outline.ok) {
    throw corruptStoryStore();
  }
  return outline.value;
}

function requireIdeationDraft(snapshot: IdeationDraftSnapshot): IdeationDraft {
  const draft = IdeationDraft.rehydrate(snapshot);
  if (!draft.ok) {
    throw corruptStoryStore();
  }
  return draft.value;
}

function requireFormalRecord(snapshot: FormalStoryRecordSnapshot): FormalStoryRecord {
  const record = FormalStoryRecord.rehydrate(snapshot);
  if (!record.ok) {
    throw corruptStoryStore();
  }
  return record.value;
}

function requireMemoryPolicy(snapshot: MemoryPolicySnapshot): MemoryPolicy {
  const policy = MemoryPolicy.rehydrate(snapshot);
  if (!policy.ok) {
    throw corruptStoryStore();
  }
  return policy.value;
}

function requireMemoryRecord(snapshot: MemoryRecordSnapshot): MemoryRecord {
  const record = MemoryRecord.rehydrate(snapshot);
  if (!record.ok) {
    throw corruptStoryStore();
  }
  return record.value;
}

function requireWhatIfBranch(snapshot: WhatIfBranchSnapshot): WhatIfBranch {
  const branch = WhatIfBranch.rehydrate(snapshot);
  if (!branch.ok) {
    throw corruptStoryStore();
  }
  return branch.value;
}

function requireOutlineDraft(snapshot: OutlineDraftCandidate): OutlineDraftCandidate {
  const id = parseUuidV7(snapshot.id);
  const sourceBranchId = parseUuidV7(snapshot.sourceBranchId);
  const projectId = parseUuidV7(snapshot.projectId);
  const createdBy = parseUuidV7(snapshot.createdBy);
  const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
  const title = validateBoundedText(snapshot.title, 200, "Outline draft title");
  const synopsis = validateBoundedText(snapshot.synopsis, 1_000, "Outline draft synopsis");
  if (
    !id.ok ||
    !sourceBranchId.ok ||
    !projectId.ok ||
    !createdBy.ok ||
    !createdAt.ok ||
    !title.ok ||
    !synopsis.ok ||
    !isOutlineDraftTarget(snapshot.target)
  ) {
    throw corruptStoryStore();
  }
  return Object.freeze({
    id: id.value,
    sourceBranchId: sourceBranchId.value,
    projectId: projectId.value,
    title: title.value,
    synopsis: synopsis.value,
    createdBy: createdBy.value,
    createdAt: createdAt.value,
    target: "outline_draft",
  });
}

function isOutlineDraftTarget(value: unknown): value is "outline_draft" {
  return value === "outline_draft";
}

function requireReviewItem<ItemType extends ReviewItemType>(
  snapshot: StructuredReviewItemSnapshot,
  itemType: ItemType,
): StructuredReviewItem<ItemType> {
  if (snapshot.itemType !== itemType) {
    throw corruptStoryStore();
  }
  const item = StructuredReviewItem.rehydrate(snapshot as StructuredReviewItemSnapshot<ItemType>);
  if (!item.ok) {
    throw corruptStoryStore();
  }
  return item.value;
}

function bumpTimelineRevision(database: StoredStoryDatabase, projectId: string): void {
  database.timelineRevisions[projectId] = (database.timelineRevisions[projectId] ?? 1) + 1;
}

function compareFormalSnapshots(
  left: FormalStoryRecordSnapshot,
  right: FormalStoryRecordSnapshot,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareMemorySnapshots(left: MemoryRecordSnapshot, right: MemoryRecordSnapshot): number {
  return (
    left.level.localeCompare(right.level) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function validateBrowserMemoryGovernanceInput(
  input: CommitMemoryGovernanceInput,
): Result<never, StoryCoreError> | null {
  const seen = new Set<string>();
  let mergeTargetCount = 0;
  let mergeSourceCount = 0;
  for (const transition of input.records) {
    const previous = transition.previous.toSnapshot();
    const next = transition.next.toSnapshot();
    if (
      seen.has(previous.id) ||
      previous.id !== next.id ||
      previous.projectId !== input.projectId ||
      next.projectId !== input.projectId ||
      next.revision !== previous.revision + 1
    ) {
      return repositoryFailure("Memory governance transition is invalid.");
    }
    seen.add(previous.id);
    mergeTargetCount += transition.role === "merge_target" ? 1 : 0;
    mergeSourceCount += transition.role === "merge_source" ? 1 : 0;
  }
  if (!isJsonObject(input.requestJson)) {
    return repositoryFailure("Memory governance request is invalid.");
  }
  const forgetValid =
    input.operation === "forget_project" &&
    input.targetRecordId === null &&
    input.previousPolicy !== null &&
    input.nextPolicy !== null &&
    input.previousPolicy.projectId === input.projectId &&
    input.nextPolicy.projectId === input.projectId &&
    input.nextPolicy.revision === input.previousPolicy.revision + 1 &&
    !input.nextPolicy.automaticLearningEnabled &&
    input.records.every(({ role, next }) => role === "forgotten" && next.toSnapshot().excluded);
  const mergeValid =
    input.operation === "merge" &&
    input.targetRecordId !== null &&
    input.previousPolicy === null &&
    input.nextPolicy === null &&
    input.records.length === 2 &&
    mergeTargetCount === 1 &&
    mergeSourceCount === 1 &&
    input.records.some(
      ({ role, previous }) => role === "merge_target" && previous.id === input.targetRecordId,
    ) &&
    input.records.every(({ role, next }) =>
      role === "merge_source" ? next.toSnapshot().excluded : !next.toSnapshot().excluded,
    );
  return forgetValid || mergeValid
    ? null
    : repositoryFailure("Memory governance operation is invalid.");
}

function memoryGovernanceReceipt(
  event: StoredMemoryGovernanceEvent,
  idempotentReplay: boolean,
): MemoryGovernanceReceipt {
  const operationId = parseUuidV7(event.id);
  const projectId = parseUuidV7(event.projectId);
  if (!operationId.ok || !projectId.ok) {
    throw corruptStoryStore();
  }
  return {
    operationId: operationId.value,
    projectId: projectId.value,
    operation: event.operation,
    affectedRecordCount: event.affectedRecordCount,
    resultingPolicyRevision: event.resultingPolicyRevision,
    idempotentReplay,
  };
}

function isStoredMemoryGovernanceEvent(value: unknown): value is StoredMemoryGovernanceEvent {
  if (!isObject(value)) {
    return false;
  }
  const operationId = typeof value.id === "string" ? parseUuidV7(value.id) : null;
  const projectId = typeof value.projectId === "string" ? parseUuidV7(value.projectId) : null;
  const targetId =
    value.targetRecordId === null
      ? null
      : typeof value.targetRecordId === "string"
        ? parseUuidV7(value.targetRecordId)
        : undefined;
  const createdAt =
    typeof value.createdAt === "string" ? parseIsoUtcTimestamp(value.createdAt) : null;
  const commonValid =
    operationId?.ok === true &&
    projectId?.ok === true &&
    createdAt?.ok === true &&
    (value.operation === "forget_project" || value.operation === "merge") &&
    Number.isSafeInteger(value.affectedRecordCount) &&
    Number(value.affectedRecordCount) >= 0 &&
    (value.resultingPolicyRevision === null ||
      (Number.isSafeInteger(value.resultingPolicyRevision) &&
        Number(value.resultingPolicyRevision) >= 1)) &&
    typeof value.requestJson === "string" &&
    isJsonObject(value.requestJson) &&
    typeof value.beforeSnapshotJson === "string" &&
    isJsonObject(value.beforeSnapshotJson) &&
    typeof value.afterSnapshotJson === "string" &&
    isJsonObject(value.afterSnapshotJson);
  if (!commonValid) {
    return false;
  }
  return value.operation === "forget_project"
    ? value.targetRecordId === null
    : targetId !== undefined && targetId !== null && targetId.ok && value.affectedRecordCount === 2;
}

function isJsonObject(serialized: string): boolean {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isObject(parsed);
  } catch {
    return false;
  }
}

function memoryIdempotencyConflict(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "MEMORY_IDEMPOTENCY_CONFLICT",
      message: "The memory operation id was already used for a different confirmed request.",
      actions: ["RECOMPARE"],
    }),
  );
}

function compareWhatIfSnapshots(left: WhatIfBranchSnapshot, right: WhatIfBranchSnapshot): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function automaticMemoryAuthorizationError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "MEMORY_AUTO_LEARNING_DISABLED",
      message: "Automatic memory policy changed before the record could be persisted.",
      retryable: true,
      actions: ["ENABLE_MEMORY", "RETRY"],
    }),
  );
}

function reviewSourceChangedError(
  chapterId: UuidV7,
  expectedVersionId: UuidV7,
  actualVersionId: UuidV7 | null,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "REVIEW_SOURCE_CHANGED",
      message: "The source chapter changed before the review decision was committed.",
      actions: ["OPEN_SOURCE", "RECOMPARE", "REVIEW_EVIDENCE"],
      details: {
        sourceChapterId: chapterId,
        expectedSourceVersionId: expectedVersionId,
        actualSourceVersionId: actualVersionId,
      },
    }),
  );
}

function revisionConflict(
  entity: string,
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: `${entity} changed before it could be saved.`,
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
      details: {
        expectedRevision,
        actualRevision,
      },
    }),
  );
}

function repositoryFailure(
  message: string,
  code:
    | "STORY_REPOSITORY_ERROR"
    | "OUTLINE_NOT_FOUND"
    | "IDEATION_DRAFT_NOT_FOUND"
    | "FORMAL_RECORD_NOT_FOUND"
    | "MEMORY_RECORD_NOT_FOUND"
    | "WHAT_IF_NOT_FOUND"
    | "REVIEW_ITEM_NOT_FOUND" = "STORY_REPOSITORY_ERROR",
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code,
      message,
    }),
  );
}

function corruptStoryStore(): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message: "Stored story data failed integrity validation.",
    actions: ["CONTACT_SUPPORT"],
  });
}

function normalizeStoryStorageError(cause: unknown, operation: "read" | "write"): StoryCoreError {
  return cause instanceof StoryCoreError
    ? cause
    : new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: `Unable to ${operation} local story data.`,
        retryable: true,
        actions: ["RETRY", "CONTACT_SUPPORT"],
        details: {
          causeName: cause instanceof Error ? cause.name : "UnknownStoryStoreError",
        },
      });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordMap(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}
