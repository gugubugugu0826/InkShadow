import { StoryCoreError } from "./errors.js";
import type { FormalTimelineReader, WhatIfPromotionUnitOfWork, WhatIfRepository } from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";
import { WhatIfBranch, type OutlineDraftCandidate, type WhatIfComparison } from "./what-if.js";

export interface WhatIfApplicationOptions {
  readonly branches: WhatIfRepository;
  readonly timeline: FormalTimelineReader;
  readonly promotions: WhatIfPromotionUnitOfWork;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export interface CreateWhatIfCommand {
  readonly projectId: string;
  readonly sourceEventId: string;
  readonly baseTimelineRevision: number;
  readonly hypothesis: string;
}

export interface WhatIfSimulationEffectInput {
  readonly id?: string;
  readonly effectType: string;
  readonly summary: string;
  readonly impactedRecordIds: readonly string[];
  readonly confidence: number;
}

export class WhatIfApplicationService {
  public constructor(private readonly options: WhatIfApplicationOptions) {}

  public async create(command: CreateWhatIfCommand): Promise<Result<WhatIfBranch, StoryCoreError>> {
    const projectId = parseUuidV7(command.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const sourceEventId = parseUuidV7(command.sourceEventId);
    if (!sourceEventId.ok) {
      return sourceEventId;
    }
    const timeline = await this.options.timeline.load(projectId.value);
    if (!timeline.ok) {
      return timeline;
    }
    if (timeline.value.revision !== command.baseTimelineRevision) {
      return err(
        new StoryCoreError({
          code: "STORY_REVISION_CONFLICT",
          message: "Formal timeline changed before the What-if branch was created.",
          retryable: true,
          actions: ["RECOMPARE"],
          details: {
            expectedRevision: command.baseTimelineRevision,
            actualRevision: timeline.value.revision,
          },
        }),
      );
    }
    if (!timeline.value.events.some((event) => event.id === sourceEventId.value)) {
      return err(
        new StoryCoreError({
          code: "FORMAL_RECORD_NOT_FOUND",
          message: "What-if source timeline event was not found.",
        }),
      );
    }

    const branch = WhatIfBranch.create({
      id: this.options.ids.next(),
      projectId: projectId.value,
      sourceEventId: sourceEventId.value,
      baseTimelineRevision: command.baseTimelineRevision,
      hypothesis: command.hypothesis,
      now: this.options.clock.now(),
    });
    if (!branch.ok) {
      return branch;
    }
    const saved = await this.options.branches.create(branch.value);
    return saved.ok ? ok(branch.value) : saved;
  }

  public async recordSimulation(command: {
    readonly branchId: string;
    readonly effects: readonly WhatIfSimulationEffectInput[];
    readonly expectedRevision: number;
  }): Promise<Result<WhatIfBranch, StoryCoreError>> {
    return this.mutate(command.branchId, (branch) =>
      branch.recordSimulation({
        effects: command.effects.map((effect) => ({
          id: effect.id ?? this.options.ids.next(),
          effectType: effect.effectType,
          summary: effect.summary,
          impactedRecordIds: effect.impactedRecordIds,
          confidence: effect.confidence,
        })),
        expectedRevision: command.expectedRevision,
        now: this.options.clock.now(),
      }),
    );
  }

  public async compare(branchIdValue: string): Promise<Result<WhatIfComparison, StoryCoreError>> {
    const branch = await this.loadBranch(branchIdValue);
    if (!branch.ok) {
      return branch;
    }
    const timeline = await this.options.timeline.load(branch.value.projectId);
    if (!timeline.ok) {
      return timeline;
    }
    return branch.value.compareToFormalTimeline(timeline.value.revision, timeline.value.events);
  }

  public async promoteToOutlineDraft(command: {
    readonly branchId: string;
    readonly title: string;
    readonly synopsis: string;
    readonly actorId: string;
    readonly humanConfirmed: boolean;
    readonly expectedRevision: number;
  }): Promise<
    Result<
      Readonly<{
        branch: WhatIfBranch;
        draft: OutlineDraftCandidate;
      }>,
      StoryCoreError
    >
  > {
    const loaded = await this.loadBranch(command.branchId);
    if (!loaded.ok) {
      return loaded;
    }
    const branch = loaded.value;
    const promoted = branch.promoteToOutlineDraft({
      draftId: this.options.ids.next(),
      title: command.title,
      synopsis: command.synopsis,
      actorId: command.actorId,
      humanConfirmed: command.humanConfirmed,
      expectedRevision: command.expectedRevision,
      now: this.options.clock.now(),
    });
    if (!promoted.ok) {
      return promoted;
    }
    const committed = await this.options.promotions.commit({
      branch: promoted.value.branch,
      expectedBranchRevision: branch.revision,
      draft: promoted.value.draft,
    });
    return committed.ok ? promoted : committed;
  }

  public async discard(command: {
    readonly branchId: string;
    readonly expectedRevision: number;
  }): Promise<Result<WhatIfBranch, StoryCoreError>> {
    return this.mutate(command.branchId, (branch) =>
      branch.discard(command.expectedRevision, this.options.clock.now()),
    );
  }

  public async requestFormalTimelineCommit(
    branchIdValue: string,
  ): Promise<Result<never, StoryCoreError>> {
    const branch = await this.loadBranch(branchIdValue);
    return branch.ok ? branch.value.requestFormalTimelineCommit() : branch;
  }

  private async mutate(
    branchIdValue: string,
    mutation: (branch: WhatIfBranch) => Result<WhatIfBranch, StoryCoreError>,
  ): Promise<Result<WhatIfBranch, StoryCoreError>> {
    const loaded = await this.loadBranch(branchIdValue);
    if (!loaded.ok) {
      return loaded;
    }
    const branch = loaded.value;
    const changed = mutation(branch);
    if (!changed.ok) {
      return changed;
    }
    if (changed.value.revision === branch.revision) {
      return changed;
    }
    const saved = await this.options.branches.save(changed.value, branch.revision);
    return saved.ok ? changed : saved;
  }

  private async loadBranch(branchIdValue: string): Promise<Result<WhatIfBranch, StoryCoreError>> {
    const branchId = parseUuidV7(branchIdValue);
    if (!branchId.ok) {
      return branchId;
    }
    const loaded = await this.options.branches.findById(branchId.value);
    if (!loaded.ok) {
      return loaded;
    }
    return loaded.value === null
      ? err(
          new StoryCoreError({
            code: "WHAT_IF_NOT_FOUND",
            message: "What-if branch was not found.",
          }),
        )
      : ok(loaded.value);
  }
}
