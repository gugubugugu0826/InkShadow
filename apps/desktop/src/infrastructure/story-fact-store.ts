import {
  STORY_FACT_REVISION_CHANGE_KINDS,
  STORY_FACT_STATUSES,
  StoryCoreError,
  StoryFact,
  err,
  ok,
  parseSafeIdentifier,
  parseUuidV7,
  type Result,
  type StoryFactListFilter,
  type StoryFactRevision,
  type StoryFactRevisionChangeKind,
  type StoryFactSnapshot,
  type StoryFactStore,
  type UuidV7,
} from "@inkshadow/story-core";

export const DEVELOPMENT_STORY_FACT_STORE_KEY = "inkshadow.development.story-facts.v1";

interface StoredRevision {
  readonly changeKind: StoryFactRevisionChangeKind;
  readonly recordedAt: string;
  readonly snapshot: StoryFactSnapshot;
}

interface BrowserStoryFactDatabase {
  readonly schemaVersion: 1;
  facts: Record<string, StoryFactSnapshot>;
  revisions: Record<string, readonly StoredRevision[]>;
}

/** Browser-development parity adapter for the Tauri/SQLite story-fact store. */
export class BrowserDevelopmentStoryFactStore implements StoryFactStore {
  public constructor(private readonly storage: Storage) {}

  public create(fact: StoryFact): Promise<Result<void, StoryCoreError>> {
    return this.mutate((database) => {
      const snapshot = fact.toSnapshot();
      if (
        database.facts[snapshot.id] !== undefined ||
        snapshot.revision !== 1 ||
        (snapshot.status === "formal" && snapshot.origin !== "user")
      ) {
        return err(storeFailure("Story fact already exists or has an invalid initial revision."));
      }
      database.facts[snapshot.id] = snapshot;
      database.revisions[snapshot.id] = Object.freeze([
        Object.freeze({
          changeKind: "created",
          recordedAt: snapshot.updatedAt,
          snapshot,
        }),
      ]);
      return ok(undefined);
    });
  }

  public findById(id: UuidV7): Promise<Result<StoryFact | null, StoryCoreError>> {
    return this.readResult((database) => {
      const snapshot = database.facts[id];
      return snapshot === undefined ? null : requireFact(snapshot);
    });
  }

  public listByProjectId(
    projectId: UuidV7,
    filter: StoryFactListFilter = {},
  ): Promise<Result<readonly StoryFact[], StoryCoreError>> {
    return this.readResult((database) => {
      const normalized = validateFilter(filter);
      return Object.freeze(
        Object.values(database.facts)
          .map(requireFact)
          .filter((fact) => {
            const snapshot = fact.toSnapshot();
            return (
              snapshot.projectId === projectId &&
              (normalized.status === undefined || snapshot.status === normalized.status) &&
              (normalized.factType === undefined || snapshot.factType === normalized.factType) &&
              (normalized.branchId === undefined || snapshot.branchId === normalized.branchId) &&
              (normalized.needsReview === undefined ||
                snapshot.needsReview === normalized.needsReview)
            );
          })
          .sort((left, right) => {
            const leftSnapshot = left.toSnapshot();
            const rightSnapshot = right.toSnapshot();
            return (
              rightSnapshot.updatedAt.localeCompare(leftSnapshot.updatedAt) ||
              leftSnapshot.factType.localeCompare(rightSnapshot.factType) ||
              leftSnapshot.id.localeCompare(rightSnapshot.id)
            );
          }),
      );
    });
  }

  public save(fact: StoryFact, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    return this.mutate((database) => {
      const next = fact.toSnapshot();
      const currentSnapshot = database.facts[next.id];
      if (currentSnapshot === undefined) {
        return err(
          new StoryCoreError({
            code: "STORY_FACT_NOT_FOUND",
            message: "Story fact was not found.",
          }),
        );
      }
      const current = requireFact(currentSnapshot).toSnapshot();
      if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
        return err(revisionConflict(expectedRevision, current.revision));
      }
      if (!sameImmutableFact(current, next)) {
        return err(
          storeFailure("Story fact identity, content, and evidence cannot change in place."),
        );
      }
      const revisions = database.revisions[next.id] ?? [];
      if (revisions.length !== expectedRevision) {
        return err(storeFailure("Story fact revision history is incomplete."));
      }
      const changeKind = classifyChange(current, next);
      database.facts[next.id] = next;
      database.revisions[next.id] = Object.freeze([
        ...revisions,
        Object.freeze({ changeKind, recordedAt: next.updatedAt, snapshot: next }),
      ]);
      return ok(undefined);
    });
  }

  public listRevisions(
    factId: UuidV7,
  ): Promise<Result<readonly StoryFactRevision[], StoryCoreError>> {
    return this.readResult((database) =>
      Object.freeze(
        (database.revisions[factId] ?? []).map((revision, index) => {
          const fact = requireFact(revision.snapshot);
          if (
            fact.id !== factId ||
            fact.revision !== index + 1 ||
            fact.toSnapshot().updatedAt !== revision.recordedAt ||
            !STORY_FACT_REVISION_CHANGE_KINDS.includes(revision.changeKind)
          ) {
            throw corruptStore();
          }
          return Object.freeze({
            fact,
            changeKind: revision.changeKind,
            recordedAt: fact.toSnapshot().updatedAt,
          });
        }),
      ),
    );
  }

  private readResult<Value>(
    operation: (database: BrowserStoryFactDatabase) => Value,
  ): Promise<Result<Value, StoryCoreError>> {
    try {
      return Promise.resolve(ok(operation(this.read())));
    } catch (cause: unknown) {
      return Promise.resolve(err(normalizeFailure(cause)));
    }
  }

  private mutate<Value>(
    operation: (database: BrowserStoryFactDatabase) => Result<Value, StoryCoreError>,
  ): Promise<Result<Value, StoryCoreError>> {
    try {
      const database = this.read();
      const result = operation(database);
      if (result.ok) {
        this.storage.setItem(DEVELOPMENT_STORY_FACT_STORE_KEY, JSON.stringify(database));
      }
      return Promise.resolve(result);
    } catch (cause: unknown) {
      return Promise.resolve(err(normalizeFailure(cause)));
    }
  }

  private read(): BrowserStoryFactDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_STORY_FACT_STORE_KEY);
    if (serialized === null) {
      return { schemaVersion: 1, facts: {}, revisions: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isPlainObject(parsed) ||
        parsed.schemaVersion !== 1 ||
        !isPlainObject(parsed.facts) ||
        !isPlainObject(parsed.revisions) ||
        hasProhibitedKey(parsed)
      ) {
        throw corruptStore();
      }
      const database = structuredClone(parsed) as unknown as BrowserStoryFactDatabase;
      for (const [factId, snapshot] of Object.entries(database.facts)) {
        const fact = requireFact(snapshot);
        const revisions = database.revisions[factId];
        if (fact.id !== factId || !Array.isArray(revisions) || revisions.length !== fact.revision) {
          throw corruptStore();
        }
        revisions.forEach((revision, index) => validateStoredRevision(revision, factId, index + 1));
        const latestRevision: unknown = revisions.at(-1);
        if (
          !isPlainObject(latestRevision) ||
          JSON.stringify(latestRevision.snapshot) !== JSON.stringify(snapshot)
        ) {
          throw corruptStore();
        }
      }
      for (const [factId, revisions] of Object.entries(database.revisions)) {
        if (!Array.isArray(revisions) || database.facts[factId] === undefined) {
          throw corruptStore();
        }
      }
      return database;
    } catch (cause: unknown) {
      throw cause instanceof StoryCoreError ? cause : corruptStore();
    }
  }
}

function validateStoredRevision(value: unknown, factId: string, revision: number): void {
  if (
    !isPlainObject(value) ||
    typeof value.changeKind !== "string" ||
    !STORY_FACT_REVISION_CHANGE_KINDS.includes(value.changeKind as StoryFactRevisionChangeKind) ||
    typeof value.recordedAt !== "string"
  ) {
    throw corruptStore();
  }
  const fact = requireFact(value.snapshot as StoryFactSnapshot);
  if (
    fact.id !== factId ||
    fact.revision !== revision ||
    fact.toSnapshot().updatedAt !== value.recordedAt
  ) {
    throw corruptStore();
  }
}

function requireFact(snapshot: StoryFactSnapshot): StoryFact {
  const result = StoryFact.rehydrate(snapshot);
  if (!result.ok) {
    throw corruptStore();
  }
  return result.value;
}

function validateFilter(filter: StoryFactListFilter): StoryFactListFilter {
  if (filter.status !== undefined && !STORY_FACT_STATUSES.includes(filter.status)) {
    throw validationFailure("Story fact status filter is invalid.");
  }
  const factType = filter.factType === undefined ? null : parseSafeIdentifier(filter.factType);
  if (factType !== null && !factType.ok) {
    throw factType.error;
  }
  const branchId =
    filter.branchId === undefined || filter.branchId === null ? null : parseUuidV7(filter.branchId);
  if (branchId !== null && !branchId.ok) {
    throw branchId.error;
  }
  if (filter.needsReview !== undefined && typeof filter.needsReview !== "boolean") {
    throw validationFailure("Story fact review filter must be a boolean.");
  }
  return Object.freeze({
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(factType === null ? {} : { factType: factType.value }),
    ...(filter.branchId === undefined
      ? {}
      : { branchId: branchId === null ? null : branchId.value }),
    ...(filter.needsReview === undefined ? {} : { needsReview: filter.needsReview }),
  });
}

function sameImmutableFact(left: StoryFactSnapshot, right: StoryFactSnapshot): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.factType === right.factType &&
    left.contentText === right.contentText &&
    JSON.stringify(left.structuredValue) === JSON.stringify(right.structuredValue) &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    left.effectiveAt === right.effectiveAt &&
    left.invalidatedAt === right.invalidatedAt &&
    left.branchId === right.branchId &&
    left.confidence === right.confidence &&
    left.origin === right.origin &&
    left.createdAt === right.createdAt
  );
}

function classifyChange(
  current: StoryFactSnapshot,
  next: StoryFactSnapshot,
): StoryFactRevisionChangeKind {
  if (next.status === "formal" && current.status !== "formal") {
    return "confirmed";
  }
  if (next.status === "deprecated" && current.status !== "deprecated") {
    return "deprecated";
  }
  return "governance_updated";
}

function revisionConflict(expectedRevision: number, actualRevision: number): StoryCoreError {
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

function storeFailure(message: string): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}

function corruptStore(): StoryCoreError {
  return new StoryCoreError({
    code: "STORY_REPOSITORY_ERROR",
    message: "Stored unified story facts failed integrity validation.",
    actions: ["CONTACT_SUPPORT"],
  });
}

function normalizeFailure(cause: unknown): StoryCoreError {
  return cause instanceof StoryCoreError ? cause : storeFailure("Unable to access story facts.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProhibitedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasProhibitedKey);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      hasProhibitedKey(nested),
  );
}
