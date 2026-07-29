import {
  ExtractionSuggestion,
  FormalStoryRecord,
  StoryCoreError,
  err,
  ok,
  type ChapterVersionReader,
  type CommitReviewDecisionInput,
  type ExtractionDecisionUnitOfWork,
  type ExtractionSuggestionRepository,
  type FormalStoryRecordRepository,
  type Result,
  type UuidV7,
} from "../src/index.js";

export class InMemoryReviewDecisionStore {
  private readonly formalRecords = new Map<string, FormalStoryRecord>();

  private readonly extractionItems = new Map<string, ExtractionSuggestion>();

  private readonly currentSources = new Map<
    string,
    Readonly<{ projectId: UuidV7; versionId: UuidV7 }>
  >();

  public beforeCommit: (() => void | Promise<void>) | null = null;

  public readonly records: FormalStoryRecordRepository = {
    create: (record) => {
      if (this.formalRecords.has(record.id)) {
        return Promise.resolve(repositoryError("Formal record already exists."));
      }
      this.formalRecords.set(record.id, cloneFormalRecord(record));
      return Promise.resolve(ok(undefined));
    },
    findById: (id) => {
      const record = this.formalRecords.get(id);
      return Promise.resolve(ok(record === undefined ? null : cloneFormalRecord(record)));
    },
    save: (record, expectedRevision) => {
      const current = this.formalRecords.get(record.id);
      if (current === undefined) {
        return Promise.resolve(repositoryError("Formal record is missing."));
      }
      if (current.revision !== expectedRevision) {
        return Promise.resolve(revisionConflict(expectedRevision, current.revision));
      }
      this.formalRecords.set(record.id, cloneFormalRecord(record));
      return Promise.resolve(ok(undefined));
    },
  };

  public readonly items: ExtractionSuggestionRepository = {
    create: (item) => {
      if (this.extractionItems.has(item.id)) {
        return Promise.resolve(repositoryError("Review item already exists."));
      }
      this.extractionItems.set(item.id, cloneExtraction(item));
      return Promise.resolve(ok(undefined));
    },
    findById: (id) => {
      const item = this.extractionItems.get(id);
      return Promise.resolve(ok(item === undefined ? null : cloneExtraction(item)));
    },
  };

  public readonly sourceVersions: ChapterVersionReader = {
    findCurrent: (chapterId) => {
      const current = this.currentSources.get(chapterId);
      return Promise.resolve(
        ok(
          current === undefined
            ? null
            : {
                chapterId,
                projectId: current.projectId,
                versionId: current.versionId,
              },
        ),
      );
    },
  };

  public readonly transaction: ExtractionDecisionUnitOfWork = {
    commit: (input) => this.commit(input),
  };

  public seedRecord(record: FormalStoryRecord): void {
    this.formalRecords.set(record.id, cloneFormalRecord(record));
  }

  public seedItem(item: ExtractionSuggestion): void {
    this.extractionItems.set(item.id, cloneExtraction(item));
  }

  public setSourceVersion(chapterId: UuidV7, projectId: UuidV7, versionId: UuidV7): void {
    this.currentSources.set(chapterId, { projectId, versionId });
  }

  public getRecord(id: string): FormalStoryRecord | null {
    const record = this.formalRecords.get(id);
    return record === undefined ? null : cloneFormalRecord(record);
  }

  public getItem(id: string): ExtractionSuggestion | null {
    const item = this.extractionItems.get(id);
    return item === undefined ? null : cloneExtraction(item);
  }

  private async commit(
    input: CommitReviewDecisionInput<"extraction">,
  ): Promise<Result<void, StoryCoreError>> {
    const beforeCommit = this.beforeCommit;
    this.beforeCommit = null;
    if (beforeCommit !== null) {
      await beforeCommit();
    }

    const storedItem = this.extractionItems.get(input.item.id);
    if (storedItem === undefined) {
      return repositoryError("Review item is missing.");
    }
    if (storedItem.revision !== input.expectedItemRevision) {
      return revisionConflict(input.expectedItemRevision, storedItem.revision);
    }

    if (input.formalRecord !== null) {
      if (
        input.expectedFormalRecordRevision === null ||
        input.expectedSourceChapterId === null ||
        input.expectedSourceProjectId === null ||
        input.expectedSourceVersionId === null
      ) {
        return repositoryError(
          "Formal record and source revisions are required for atomic commit.",
        );
      }
      const currentSource = this.currentSources.get(input.expectedSourceChapterId);
      if (
        currentSource?.projectId !== input.expectedSourceProjectId ||
        currentSource.versionId !== input.expectedSourceVersionId
      ) {
        return err(
          new StoryCoreError({
            code: "REVIEW_SOURCE_CHANGED",
            message: "Source chapter changed before atomic decision commit.",
            actions: ["OPEN_SOURCE", "RECOMPARE", "REVIEW_EVIDENCE"],
          }),
        );
      }
      const storedRecord = this.formalRecords.get(input.formalRecord.id);
      if (storedRecord === undefined) {
        return repositoryError("Formal record is missing.");
      }
      if (storedRecord.revision !== input.expectedFormalRecordRevision) {
        return revisionConflict(input.expectedFormalRecordRevision, storedRecord.revision);
      }
    } else if (
      input.expectedFormalRecordRevision !== null ||
      input.expectedSourceChapterId !== null ||
      input.expectedSourceProjectId !== null ||
      input.expectedSourceVersionId !== null
    ) {
      return repositoryError("Review-only decision cannot carry formal source revisions.");
    }

    this.extractionItems.set(input.item.id, cloneExtraction(input.item));
    if (input.formalRecord !== null) {
      this.formalRecords.set(input.formalRecord.id, cloneFormalRecord(input.formalRecord));
    }
    return ok(undefined);
  }
}

function cloneFormalRecord(record: FormalStoryRecord): FormalStoryRecord {
  const cloned = FormalStoryRecord.rehydrate(record.toSnapshot());
  if (!cloned.ok) {
    throw cloned.error;
  }
  return cloned.value;
}

function cloneExtraction(item: ExtractionSuggestion): ExtractionSuggestion {
  const cloned = ExtractionSuggestion.rehydrate(item.toSnapshot());
  if (!cloned.ok) {
    throw cloned.error;
  }
  return cloned.value;
}

function revisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Stored aggregate changed before atomic commit.",
      retryable: true,
      actions: ["RETRY", "RECOMPARE"],
      details: { expectedRevision, actualRevision },
    }),
  );
}

function repositoryError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message,
      retryable: true,
      actions: ["RETRY"],
    }),
  );
}
