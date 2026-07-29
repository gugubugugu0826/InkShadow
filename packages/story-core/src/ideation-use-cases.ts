import { StoryCoreError } from "./errors.js";
import {
  IdeationDraft,
  type IdeationStepKey,
  type ProjectSeed,
  type QuickIdeationSeed,
} from "./ideation.js";
import type { IdeationDraftRepository, IdeationProjectCommitUnitOfWork } from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type Clock, type UuidV7, type UuidV7Generator } from "./value-objects.js";

export interface IdeationApplicationOptions {
  readonly drafts: IdeationDraftRepository;
  readonly projects: IdeationProjectCommitUnitOfWork;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export interface CreateGuidedIdeationCommand {
  readonly projectName: string;
}

export interface CreateQuickIdeationCommand {
  readonly projectName: string;
  readonly seed: QuickIdeationSeed;
}

export type ApplyIdeationChange =
  | Readonly<{ kind: "go_to_step"; step: IdeationStepKey }>
  | Readonly<{ kind: "update"; step: IdeationStepKey; value: string }>
  | Readonly<{ kind: "skip"; step: IdeationStepKey }>
  | Readonly<{ kind: "lock"; step: IdeationStepKey }>
  | Readonly<{ kind: "unlock"; step: IdeationStepKey }>
  | Readonly<{ kind: "offer_suggestion"; step: IdeationStepKey; content: string }>
  | Readonly<{
      kind: "accept_suggestion";
      step: IdeationStepKey;
      suggestionId: string;
    }>
  | Readonly<{
      kind: "reject_suggestion";
      step: IdeationStepKey;
      suggestionId: string;
    }>;

export interface ApplyIdeationChangeCommand {
  readonly draftId: string;
  readonly expectedRevision: number;
  readonly change: ApplyIdeationChange;
}

export interface FinalizeIdeationCommand {
  readonly draftId: string;
  readonly expectedRevision: number;
}

export interface FinalizeIdeationResult {
  readonly draft: IdeationDraft;
  readonly projectId: UuidV7;
  readonly seed: ProjectSeed;
}

export class IdeationApplicationService {
  public constructor(private readonly options: IdeationApplicationOptions) {}

  public createGuided(
    command: CreateGuidedIdeationCommand,
  ): Promise<Result<IdeationDraft, StoryCoreError>> {
    return this.create(command.projectName, "guided");
  }

  public createQuick(
    command: CreateQuickIdeationCommand,
  ): Promise<Result<IdeationDraft, StoryCoreError>> {
    return this.create(command.projectName, "quick", command.seed);
  }

  public async findById(
    draftIdValue: string,
  ): Promise<Result<IdeationDraft | null, StoryCoreError>> {
    const draftId = parseUuidV7(draftIdValue);
    return draftId.ok ? this.options.drafts.findById(draftId.value) : draftId;
  }

  public listActive(): Promise<Result<readonly IdeationDraft[], StoryCoreError>> {
    return this.options.drafts.listActive();
  }

  public async apply(
    command: ApplyIdeationChangeCommand,
  ): Promise<Result<IdeationDraft, StoryCoreError>> {
    const loaded = await this.loadActive(command.draftId);
    if (!loaded.ok) {
      return loaded;
    }
    const now = this.options.clock.now();
    const common = {
      step: command.change.step,
      expectedRevision: command.expectedRevision,
      now,
    };
    let changed: Result<IdeationDraft, StoryCoreError>;
    switch (command.change.kind) {
      case "go_to_step":
        changed = loaded.value.goToStep(common);
        break;
      case "update":
        changed = loaded.value.updateStep({ ...common, value: command.change.value });
        break;
      case "skip":
        changed = loaded.value.skipStep(common);
        break;
      case "lock":
        changed = loaded.value.lockStep(common);
        break;
      case "unlock":
        changed = loaded.value.unlockStep(common);
        break;
      case "offer_suggestion":
        changed = loaded.value.offerSuggestion({
          ...common,
          suggestionId: this.options.ids.next(),
          content: command.change.content,
        });
        break;
      case "accept_suggestion":
        changed = loaded.value.acceptSuggestion({
          ...common,
          suggestionId: command.change.suggestionId,
        });
        break;
      case "reject_suggestion":
        changed = loaded.value.rejectSuggestion({
          ...common,
          suggestionId: command.change.suggestionId,
        });
        break;
    }
    if (!changed.ok || changed.value.revision === loaded.value.revision) {
      return changed;
    }
    const saved = await this.options.drafts.save(changed.value, loaded.value.revision);
    return saved.ok ? changed : saved;
  }

  public async finalize(
    command: FinalizeIdeationCommand,
  ): Promise<Result<FinalizeIdeationResult, StoryCoreError>> {
    const loaded = await this.loadActive(command.draftId);
    if (!loaded.ok) {
      return loaded;
    }
    const seed = loaded.value.buildProjectSeed();
    if (!seed.ok) {
      return seed;
    }
    const projectId = parseUuidV7(this.options.ids.next());
    if (!projectId.ok) {
      return projectId;
    }
    const finalized = loaded.value.finalize(
      projectId.value,
      command.expectedRevision,
      this.options.clock.now(),
    );
    if (!finalized.ok) {
      return finalized;
    }
    const committed = await this.options.projects.commit({
      draft: finalized.value,
      expectedDraftRevision: loaded.value.revision,
      projectId: projectId.value,
      seed: seed.value,
    });
    return committed.ok
      ? ok(
          Object.freeze({
            draft: finalized.value,
            projectId: projectId.value,
            seed: seed.value,
          }),
        )
      : committed;
  }

  private async create(
    projectName: string,
    mode: "guided" | "quick",
    quickSeed?: QuickIdeationSeed,
  ): Promise<Result<IdeationDraft, StoryCoreError>> {
    const draft = IdeationDraft.create({
      id: this.options.ids.next(),
      mode,
      projectName,
      now: this.options.clock.now(),
      ...(quickSeed === undefined ? {} : { quickSeed }),
    });
    if (!draft.ok) {
      return draft;
    }
    const saved = await this.options.drafts.create(draft.value);
    return saved.ok ? ok(draft.value) : saved;
  }

  private async loadActive(draftIdValue: string): Promise<Result<IdeationDraft, StoryCoreError>> {
    const draftId = parseUuidV7(draftIdValue);
    if (!draftId.ok) {
      return draftId;
    }
    const loaded = await this.options.drafts.findById(draftId.value);
    if (!loaded.ok) {
      return loaded;
    }
    return loaded.value === null
      ? err(
          new StoryCoreError({
            code: "IDEATION_DRAFT_NOT_FOUND",
            message: "Ideation draft was not found.",
            actions: ["RESUME_IDEATION"],
          }),
        )
      : ok(loaded.value);
  }
}
