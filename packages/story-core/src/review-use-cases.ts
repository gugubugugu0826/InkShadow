import { StoryCoreError } from "./errors.js";
import type { FormalStoryRecord } from "./formal-record.js";
import type {
  ChapterVersionReader,
  FormalStoryRecordRepository,
  ReviewDecisionUnitOfWork,
  ReviewItemRepository,
} from "./ports.js";
import { err, ok, type Result } from "./result.js";
import {
  StructuredReviewItem,
  type CreateStructuredReviewItemInput,
  type ReviewItemType,
} from "./review-item.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";

export type CreateReviewItemCommand = Omit<CreateStructuredReviewItemInput, "id" | "now">;

export interface ReviewIntakeOptions<ItemType extends ReviewItemType> {
  readonly itemType: ItemType;
  readonly items: ReviewItemRepository<ItemType>;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export class ReviewIntakeService<ItemType extends ReviewItemType> {
  public constructor(private readonly options: ReviewIntakeOptions<ItemType>) {}

  public async create(
    command: CreateReviewItemCommand,
  ): Promise<Result<StructuredReviewItem<ItemType>, StoryCoreError>> {
    const item = StructuredReviewItem.create(this.options.itemType, {
      ...command,
      id: this.options.ids.next(),
      now: this.options.clock.now(),
    });
    if (!item.ok) {
      return item;
    }
    const saved = await this.options.items.create(item.value);
    return saved.ok ? ok(item.value) : saved;
  }
}

interface ReviewDecisionCommandBase {
  readonly itemId: string;
  readonly actorId: string;
  readonly humanConfirmed: boolean;
  readonly expectedItemRevision: number;
  /**
   * Stable caller-owned decision identity used by crash-safe workflows.
   * Ordinary callers omit it and retain the existing generated-ID behavior.
   */
  readonly decisionId?: string;
}

export type DecideReviewItemCommand =
  | (ReviewDecisionCommandBase &
      Readonly<{
        kind: "accept";
        expectedRecordRevision: number;
      }>)
  | (ReviewDecisionCommandBase &
      Readonly<{
        kind: "modify";
        expectedRecordRevision: number;
        modifiedValue: unknown;
      }>)
  | (ReviewDecisionCommandBase &
      Readonly<{
        kind: "reject";
      }>)
  | (ReviewDecisionCommandBase &
      Readonly<{
        kind: "defer";
        remindAt: string;
      }>)
  | (ReviewDecisionCommandBase &
      Readonly<{
        kind: "resume";
      }>);

export interface ReviewDecisionResult<ItemType extends ReviewItemType> {
  readonly item: StructuredReviewItem<ItemType>;
  readonly formalRecord: FormalStoryRecord | null;
}

export interface ReviewDecisionOptions<ItemType extends ReviewItemType> {
  readonly items: ReviewItemRepository<ItemType>;
  readonly records: FormalStoryRecordRepository;
  readonly sourceVersions: ChapterVersionReader;
  readonly transaction: ReviewDecisionUnitOfWork<ItemType>;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export class ReviewDecisionService<ItemType extends ReviewItemType> {
  public constructor(private readonly options: ReviewDecisionOptions<ItemType>) {}

  public async decide(
    command: DecideReviewItemCommand,
  ): Promise<Result<ReviewDecisionResult<ItemType>, StoryCoreError>> {
    const itemId = parseUuidV7(command.itemId);
    if (!itemId.ok) {
      return itemId;
    }
    const loaded = await this.options.items.findById(itemId.value);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        new StoryCoreError({
          code: "REVIEW_ITEM_NOT_FOUND",
          message: "Structured review item was not found.",
        }),
      );
    }

    const item = loaded.value;
    const expectedItemRevision = item.revision;
    const decisionId = command.decisionId ?? this.options.ids.next();
    const now = this.options.clock.now();
    if (command.kind === "accept" || command.kind === "modify") {
      return this.applyFormalDecision(item, command, decisionId, now, expectedItemRevision);
    }

    const outcome = item.decide({
      kind: command.kind,
      decisionId,
      actorId: command.actorId,
      humanConfirmed: command.humanConfirmed,
      expectedRevision: command.expectedItemRevision,
      now,
      ...(command.kind === "defer" ? { remindAt: command.remindAt } : {}),
    });
    if (!outcome.ok) {
      return outcome;
    }
    if (outcome.value.plan !== null) {
      return err(
        new StoryCoreError({
          code: "FORMAL_RECORD_PLAN_REQUIRED",
          message: "A non-formal review decision unexpectedly produced a change plan.",
        }),
      );
    }
    const committed = await this.options.transaction.commit({
      item: outcome.value.item,
      expectedItemRevision,
      formalRecord: null,
      expectedFormalRecordRevision: null,
      expectedSourceChapterId: null,
      expectedSourceProjectId: null,
      expectedSourceVersionId: null,
    });
    return committed.ok ? ok({ item: outcome.value.item, formalRecord: null }) : committed;
  }

  private async applyFormalDecision(
    item: StructuredReviewItem<ItemType>,
    command: Extract<DecideReviewItemCommand, { readonly kind: "accept" | "modify" }>,
    decisionId: string,
    now: string,
    expectedItemRevision: number,
  ): Promise<Result<ReviewDecisionResult<ItemType>, StoryCoreError>> {
    const snapshot = item.toSnapshot();
    const currentSource = await this.options.sourceVersions.findCurrent(snapshot.sourceChapterId);
    if (!currentSource.ok) {
      return currentSource;
    }
    if (
      currentSource.value?.projectId !== item.projectId ||
      currentSource.value.versionId !== snapshot.sourceVersionId
    ) {
      return err(
        new StoryCoreError({
          code: "REVIEW_SOURCE_CHANGED",
          message: "The source chapter changed after this evidence was captured.",
          actions: ["OPEN_SOURCE", "RECOMPARE", "REVIEW_EVIDENCE"],
          details: {
            sourceChapterId: snapshot.sourceChapterId,
            expectedSourceVersionId: snapshot.sourceVersionId,
            actualSourceVersionId: currentSource.value?.versionId ?? null,
            expectedProjectId: item.projectId,
            actualProjectId: currentSource.value?.projectId ?? null,
          },
        }),
      );
    }

    const loadedRecord = await this.options.records.findById(item.targetRecordId);
    if (!loadedRecord.ok) {
      return loadedRecord;
    }
    if (loadedRecord.value === null) {
      return err(
        new StoryCoreError({
          code: "FORMAL_RECORD_NOT_FOUND",
          message: "Target formal story record was not found.",
        }),
      );
    }
    const record = loadedRecord.value;
    if (record.projectId !== item.projectId) {
      return err(
        new StoryCoreError({
          code: "FORMAL_RECORD_PLAN_MISMATCH",
          message: "Review item and formal record belong to different projects.",
          actions: ["RECOMPARE", "REVIEW_EVIDENCE"],
        }),
      );
    }

    const outcome = item.decide({
      kind: command.kind,
      decisionId,
      actorId: command.actorId,
      humanConfirmed: command.humanConfirmed,
      expectedRevision: command.expectedItemRevision,
      expectedRecordRevision: command.expectedRecordRevision,
      now,
      ...(command.kind === "modify" ? { modifiedValue: command.modifiedValue } : {}),
    });
    if (!outcome.ok) {
      return outcome;
    }
    if (outcome.value.plan === null) {
      return err(
        new StoryCoreError({
          code: "FORMAL_RECORD_PLAN_REQUIRED",
          message: "Accepted review decision did not produce a formal change plan.",
        }),
      );
    }
    const changedRecord = record.applyChangePlan(
      outcome.value.plan,
      command.expectedRecordRevision,
      now,
    );
    if (!changedRecord.ok) {
      return changedRecord;
    }

    const committed = await this.options.transaction.commit({
      item: outcome.value.item,
      expectedItemRevision,
      formalRecord: changedRecord.value,
      expectedFormalRecordRevision: record.revision,
      expectedSourceChapterId: snapshot.sourceChapterId,
      expectedSourceProjectId: item.projectId,
      expectedSourceVersionId: snapshot.sourceVersionId,
    });
    return committed.ok
      ? ok({
          item: outcome.value.item,
          formalRecord: changedRecord.value,
        })
      : committed;
  }
}
