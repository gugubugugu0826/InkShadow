import { StoryCoreError } from "./errors.js";
import type { MemoryRecord, MemoryRecordSnapshot } from "./memory.js";
import type { MemoryRecordListReader, MemoryRecordRepository } from "./ports.js";
import type {
  LegacyStoryFactCompatibilityStore,
  StoryFactLegacyLink,
} from "./persistence/story-fact-repository.js";
import { err, ok, type Result } from "./result.js";
import type { StoryFact, StoryFactStore } from "./story-fact.js";
import type { StoryFactApplicationService } from "./story-fact-use-cases.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";

export const LEGACY_MEMORY_PROMOTION_STATUSES = [
  "available",
  "converted",
  "duplicate",
  "conflict",
] as const;

export type LegacyMemoryPromotionStatus = (typeof LEGACY_MEMORY_PROMOTION_STATUSES)[number];

export interface LegacyMemoryPromotionPreview {
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly content: string;
  readonly targetFactType: "memory";
  readonly status: LegacyMemoryPromotionStatus;
  readonly linkedLegacyRevision: number | null;
  readonly canConfirm: boolean;
  readonly requiresConflictConfirmation: boolean;
}

export interface LegacyMemoryPromotionReceipt {
  readonly status: Exclude<LegacyMemoryPromotionStatus, "available">;
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly fact: StoryFact | null;
  readonly link: StoryFactLegacyLink | null;
}

export interface LegacyMemoryPromotionOptions {
  readonly facts: StoryFactStore & LegacyStoryFactCompatibilityStore;
  readonly factService: Pick<StoryFactApplicationService, "confirm">;
  readonly memories: Pick<MemoryRecordRepository, "findById"> &
    Pick<MemoryRecordListReader, "listByProjectId">;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
}

interface InspectedMemoryPromotion {
  readonly preview: LegacyMemoryPromotionPreview;
  readonly memory: MemoryRecord;
  readonly fact: StoryFact | null;
  readonly link: StoryFactLegacyLink | null;
  readonly exactRevisionLinked: boolean;
}

/**
 * Explicit MemoryRecord -> StoryFact compatibility workflow. It performs no
 * model work, never mutates/deletes the MemoryRecord, and never treats a
 * legacy row as Canon before the separate human-confirmed StoryFact transition.
 */
export class LegacyMemoryStoryFactPromotionService {
  public constructor(private readonly options: LegacyMemoryPromotionOptions) {}

  public async preview(command: {
    readonly projectId: string;
    readonly memoryId: string;
  }): Promise<Result<LegacyMemoryPromotionPreview, StoryCoreError>> {
    const inspected = await this.inspect(command);
    return inspected.ok ? ok(inspected.value.preview) : inspected;
  }

  public async previewProject(
    projectIdValue: string,
  ): Promise<Result<readonly LegacyMemoryPromotionPreview[], StoryCoreError>> {
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) return projectId;
    const [loadedMemories, loadedLinks, loadedFacts] = await Promise.all([
      this.options.memories.listByProjectId(projectId.value),
      this.options.facts.listLegacyLinks(projectId.value),
      this.options.facts.listByProjectId(projectId.value),
    ]);
    if (!loadedMemories.ok) return loadedMemories;
    if (!loadedLinks.ok) return loadedLinks;
    if (!loadedFacts.ok) return loadedFacts;
    const previews: LegacyMemoryPromotionPreview[] = [];
    for (const memory of loadedMemories.value) {
      const inspected = this.inspectLoaded(memory, loadedLinks.value, loadedFacts.value);
      if (!inspected.ok) return inspected;
      previews.push(inspected.value.preview);
    }
    return ok(Object.freeze(previews));
  }

  public async confirm(command: {
    readonly projectId: string;
    readonly memoryId: string;
    readonly expectedMemoryRevision: number;
    readonly actorId: string;
    readonly humanConfirmed: boolean;
    readonly acceptConflict?: boolean;
  }): Promise<Result<LegacyMemoryPromotionReceipt, StoryCoreError>> {
    if (!command.humanConfirmed) {
      return err(
        new StoryCoreError({
          code: "HUMAN_DECISION_REQUIRED",
          message: "Keeping a legacy memory as a formal setting requires explicit confirmation.",
        }),
      );
    }
    const inspected = await this.inspect(command);
    if (!inspected.ok) return inspected;
    const { memory, preview, fact, link, exactRevisionLinked } = inspected.value;
    if (memory.revision !== command.expectedMemoryRevision) {
      return err(
        new StoryCoreError({
          code: "STORY_REVISION_CONFLICT",
          message: "The memory changed before it could be kept as a formal setting.",
          retryable: true,
          details: {
            expectedRevision: command.expectedMemoryRevision,
            actualRevision: memory.revision,
          },
        }),
      );
    }
    if (preview.status === "converted" || preview.status === "duplicate") {
      return ok(
        Object.freeze({
          status: "duplicate" as const,
          memoryId: memory.id,
          memoryRevision: memory.revision,
          fact,
          link,
        }),
      );
    }
    if (preview.status === "conflict" && (command.acceptConflict !== true || exactRevisionLinked)) {
      return ok(
        Object.freeze({
          status: "conflict" as const,
          memoryId: memory.id,
          memoryRevision: memory.revision,
          fact,
          link,
        }),
      );
    }

    const staged =
      preview.status === "available" && fact !== null && link !== null
        ? ok(Object.freeze({ fact, link, created: false }))
        : await this.options.facts.stageLegacyRecord({
            factId: this.options.ids.next(),
            projectId: memory.projectId,
            legacyKind: "memory_record",
            legacyId: memory.id,
            now: this.options.clock.now(),
          });
    if (!staged.ok) return staged;
    const stagedSnapshot = staged.value.fact.toSnapshot();
    if (stagedSnapshot.status === "formal" && stagedSnapshot.userConfirmed) {
      return ok(
        Object.freeze({
          status: "duplicate" as const,
          memoryId: memory.id,
          memoryRevision: memory.revision,
          fact: staged.value.fact,
          link: staged.value.link,
        }),
      );
    }
    if (
      stagedSnapshot.status !== "unconfirmed" ||
      stagedSnapshot.origin !== "legacy" ||
      stagedSnapshot.source.kind !== "legacy_record" ||
      stagedSnapshot.contentText !== memory.toSnapshot().content
    ) {
      return ok(
        Object.freeze({
          status: "conflict" as const,
          memoryId: memory.id,
          memoryRevision: memory.revision,
          fact: staged.value.fact,
          link: staged.value.link,
        }),
      );
    }
    const recheckedMemory = await this.options.memories.findById(memory.id);
    if (!recheckedMemory.ok) return recheckedMemory;
    const recheckedSnapshot = recheckedMemory.value?.toSnapshot() ?? null;
    if (
      recheckedSnapshot?.projectId !== memory.projectId ||
      recheckedSnapshot.revision !== command.expectedMemoryRevision ||
      recheckedSnapshot.content !== stagedSnapshot.contentText
    ) {
      return err(
        new StoryCoreError({
          code: "STORY_REVISION_CONFLICT",
          message: "The memory changed before the staged StoryFact could be confirmed.",
          retryable: true,
        }),
      );
    }
    const confirmed = await this.options.factService.confirm({
      factId: staged.value.fact.id,
      actorId: command.actorId,
      lock: memory.toSnapshot().level === "L4",
      humanConfirmed: true,
      expectedRevision: staged.value.fact.revision,
    });
    if (!confirmed.ok) return confirmed;
    return ok(
      Object.freeze({
        status: "converted" as const,
        memoryId: memory.id,
        memoryRevision: memory.revision,
        fact: confirmed.value,
        link: staged.value.link,
      }),
    );
  }

  private async inspect(command: {
    readonly projectId: string;
    readonly memoryId: string;
  }): Promise<Result<InspectedMemoryPromotion, StoryCoreError>> {
    const projectId = parseUuidV7(command.projectId);
    if (!projectId.ok) return projectId;
    const memoryId = parseUuidV7(command.memoryId);
    if (!memoryId.ok) return memoryId;
    const [loadedMemory, loadedLinks, loadedFacts] = await Promise.all([
      this.options.memories.findById(memoryId.value),
      this.options.facts.listLegacyLinks(projectId.value),
      this.options.facts.listByProjectId(projectId.value),
    ]);
    if (!loadedMemory.ok) return loadedMemory;
    if (!loadedLinks.ok) return loadedLinks;
    if (!loadedFacts.ok) return loadedFacts;
    const memory = loadedMemory.value;
    if (memory === null) {
      return err(
        new StoryCoreError({
          code: "MEMORY_RECORD_NOT_FOUND",
          message: "The legacy memory record was not found.",
        }),
      );
    }
    if (memory.projectId !== projectId.value) {
      return err(
        new StoryCoreError({
          code: "STORY_VALIDATION_FAILED",
          message: "The legacy memory does not belong to this project.",
        }),
      );
    }
    return this.inspectLoaded(memory, loadedLinks.value, loadedFacts.value);
  }

  private inspectLoaded(
    memory: MemoryRecord,
    allLinks: readonly StoryFactLegacyLink[],
    facts: readonly StoryFact[],
  ): Result<InspectedMemoryPromotion, StoryCoreError> {
    const snapshot = memory.toSnapshot();
    const factById = new Map(facts.map((fact) => [String(fact.id), fact] as const));
    const links = allLinks
      .filter(
        (link) =>
          link.legacyKind === "memory_record" && String(link.legacyId) === String(memory.id),
      )
      .sort((left, right) => right.legacyRevision - left.legacyRevision);
    for (const candidateLink of links) {
      if (!factById.has(String(candidateLink.factId))) {
        return err(
          new StoryCoreError({
            code: "STORY_REPOSITORY_ERROR",
            message: "A legacy memory link points to a missing StoryFact.",
          }),
        );
      }
    }
    const exactLink =
      links.find(({ legacyRevision }) => legacyRevision === memory.revision) ?? null;
    const sameContentLink =
      links.find((candidateLink) => {
        const candidate = factById.get(String(candidateLink.factId));
        return candidate?.toSnapshot().contentText === snapshot.content;
      }) ?? null;
    const selectedLink = exactLink ?? sameContentLink ?? links[0] ?? null;
    const selectedFact =
      selectedLink === null ? null : (factById.get(String(selectedLink.factId)) ?? null);
    const factSnapshot = selectedFact?.toSnapshot() ?? null;
    const exactRevisionLinked = exactLink !== null;
    let status: LegacyMemoryPromotionStatus = "available";
    let canConfirm = true;
    let requiresConflictConfirmation = false;
    if (
      factSnapshot !== null &&
      factSnapshot.status === "formal" &&
      factSnapshot.userConfirmed &&
      !factSnapshot.deprecated &&
      factSnapshot.contentText === snapshot.content
    ) {
      status = exactRevisionLinked ? "converted" : "duplicate";
      canConfirm = false;
    } else if (
      factSnapshot !== null &&
      factSnapshot.status === "unconfirmed" &&
      !factSnapshot.userConfirmed &&
      !factSnapshot.deprecated &&
      factSnapshot.origin === "legacy" &&
      factSnapshot.source.kind === "legacy_record" &&
      factSnapshot.contentText === snapshot.content
    ) {
      status = "available";
    } else if (links.length > 0) {
      status = "conflict";
      canConfirm = !exactRevisionLinked;
      requiresConflictConfirmation = !exactRevisionLinked;
    }
    return ok(
      Object.freeze({
        memory,
        fact: selectedFact,
        link: selectedLink,
        exactRevisionLinked,
        preview: Object.freeze({
          memoryId: memory.id,
          memoryRevision: memory.revision,
          content: snapshot.content,
          targetFactType: "memory" as const,
          status,
          linkedLegacyRevision: selectedLink?.legacyRevision ?? null,
          canConfirm,
          requiresConflictConfirmation,
        }),
      }),
    );
  }
}

export function legacyMemoryPromotionStatusForSnapshot(
  memory: MemoryRecordSnapshot,
  previews: readonly LegacyMemoryPromotionPreview[],
): LegacyMemoryPromotionPreview | null {
  return previews.find(({ memoryId }) => memoryId === memory.id) ?? null;
}
