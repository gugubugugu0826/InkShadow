import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { validateBoundedText } from "./safety.js";
import {
  compareTimestamps,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "./value-objects.js";

export const IDEATION_STEP_KEYS = [
  "genre",
  "target_audience",
  "premise",
  "protagonist_drive",
  "world_skeleton",
  "key_characters",
  "plot_route",
  "opening_hook",
  "output_spec",
] as const;

export type IdeationStepKey = (typeof IDEATION_STEP_KEYS)[number];
export type IdeationMode = "quick" | "guided";
export type IdeationDraftStatus = "active" | "finalized";
export type IdeationStepState = "pending" | "completed" | "skipped";
export type IdeationStepOrigin = "empty" | "manual" | "suggested" | "quick_seed";

export interface IdeationSuggestionSnapshot {
  readonly id: UuidV7;
  readonly content: string;
  readonly generatedAt: IsoUtcTimestamp;
}

export interface IdeationStepSnapshot {
  readonly key: IdeationStepKey;
  readonly state: IdeationStepState;
  readonly value: string;
  readonly locked: boolean;
  readonly origin: IdeationStepOrigin;
  readonly revision: number;
  readonly suggestion: IdeationSuggestionSnapshot | null;
}

export interface IdeationDraftSnapshot {
  readonly id: UuidV7;
  readonly mode: IdeationMode;
  readonly projectName: string;
  readonly status: IdeationDraftStatus;
  readonly projectId: UuidV7 | null;
  readonly currentStep: IdeationStepKey;
  readonly revision: number;
  readonly steps: readonly IdeationStepSnapshot[];
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface QuickIdeationSeed {
  readonly idea: string;
  readonly genre: string;
  readonly targetWords: number;
  readonly protagonistType: string;
  readonly style?: string;
}

export interface ProjectSeed {
  readonly sourceDraftId: UuidV7;
  readonly projectName: string;
  readonly synopsis: string;
  readonly genre: string;
  readonly targetAudience: string;
  readonly premise: string;
  readonly protagonistDrive: string;
  readonly worldSkeleton: string;
  readonly keyCharacters: string;
  readonly plotRoute: string;
  readonly openingHook: string;
  readonly outputSpec: string;
  readonly firstChapterGoal: string;
}

export interface CreateIdeationDraftInput {
  readonly id: string;
  readonly mode: IdeationMode;
  readonly projectName: string;
  readonly now: string;
  readonly quickSeed?: QuickIdeationSeed;
}

export interface ChangeIdeationStepInput {
  readonly step: IdeationStepKey;
  readonly expectedRevision: number;
  readonly now: string;
}

const MAX_PROJECT_NAME_LENGTH = 120;
const MAX_IDEATION_VALUE_LENGTH = 4_000;
const MIN_TARGET_WORDS = 1_000;
const MAX_TARGET_WORDS = 20_000_000;

export class IdeationDraft {
  private constructor(private readonly snapshot: IdeationDraftSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: CreateIdeationDraftInput): Result<IdeationDraft, StoryCoreError> {
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    if (!isIdeationMode(input.mode)) {
      return validationError("Ideation mode is invalid.");
    }
    const projectName = validateBoundedText(
      input.projectName,
      MAX_PROJECT_NAME_LENGTH,
      "Project name",
    );
    if (!projectName.ok) {
      return projectName;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    if ((input.mode === "quick") !== (input.quickSeed !== undefined)) {
      return validationError("Quick ideation requires exactly one quick seed.");
    }

    const seeded = createSteps(input.quickSeed);
    if (!seeded.ok) {
      return seeded;
    }
    return ok(
      new IdeationDraft({
        id: id.value,
        mode: input.mode,
        projectName: projectName.value,
        status: "active",
        projectId: null,
        currentStep: firstPendingStep(seeded.value),
        revision: 1,
        steps: seeded.value,
        createdAt: now.value,
        updatedAt: now.value,
      }),
    );
  }

  public static rehydrate(snapshot: IdeationDraftSnapshot): Result<IdeationDraft, StoryCoreError> {
    const validated = validateSnapshot(snapshot);
    return validated.ok ? ok(new IdeationDraft(validated.value)) : validated;
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public get status(): IdeationDraftStatus {
    return this.snapshot.status;
  }

  public get projectId(): UuidV7 | null {
    return this.snapshot.projectId;
  }

  public toSnapshot(): IdeationDraftSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  public goToStep(input: ChangeIdeationStepInput): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutationContext(input.expectedRevision, input.now);
    if (!context.ok) {
      return context;
    }
    if (!IDEATION_STEP_KEYS.includes(input.step)) {
      return validationError("Ideation step is invalid.");
    }
    if (this.snapshot.currentStep === input.step) {
      return ok(this);
    }
    return ok(
      this.withSnapshot({
        ...this.snapshot,
        currentStep: input.step,
        revision: this.snapshot.revision + 1,
        updatedAt: context.value,
      }),
    );
  }

  public updateStep(
    input: ChangeIdeationStepInput & Readonly<{ value: string }>,
  ): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutableStep(input);
    if (!context.ok) {
      return context;
    }
    const value = validateBoundedText(input.value, MAX_IDEATION_VALUE_LENGTH, "Ideation value");
    if (!value.ok) {
      return value;
    }
    return this.replaceStep(
      context.value.step,
      {
        ...context.value.step,
        state: "completed",
        value: value.value,
        origin: "manual",
        revision: context.value.step.revision + 1,
        suggestion: null,
      },
      context.value.now,
    );
  }

  public skipStep(input: ChangeIdeationStepInput): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutableStep(input);
    if (!context.ok) {
      return context;
    }
    return this.replaceStep(
      context.value.step,
      {
        ...context.value.step,
        state: "skipped",
        value: "",
        origin: "empty",
        revision: context.value.step.revision + 1,
        suggestion: null,
      },
      context.value.now,
    );
  }

  public lockStep(input: ChangeIdeationStepInput): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutableStep(input);
    if (!context.ok) {
      return context;
    }
    if (context.value.step.state !== "completed") {
      return invalidTransition("Only a completed ideation step can be locked.");
    }
    return this.replaceStep(
      context.value.step,
      {
        ...context.value.step,
        locked: true,
        revision: context.value.step.revision + 1,
      },
      context.value.now,
    );
  }

  public unlockStep(input: ChangeIdeationStepInput): Result<IdeationDraft, StoryCoreError> {
    const context = this.stepContext(input.expectedRevision, input.now, input.step);
    if (!context.ok) {
      return context;
    }
    if (!context.value.step.locked) {
      return ok(this);
    }
    return this.replaceStep(
      context.value.step,
      {
        ...context.value.step,
        locked: false,
        revision: context.value.step.revision + 1,
      },
      context.value.now,
    );
  }

  public offerSuggestion(
    input: ChangeIdeationStepInput & Readonly<{ suggestionId: string; content: string }>,
  ): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutableStep(input);
    if (!context.ok) {
      return context;
    }
    const suggestionId = parseUuidV7(input.suggestionId);
    if (!suggestionId.ok) {
      return suggestionId;
    }
    const content = validateBoundedText(
      input.content,
      MAX_IDEATION_VALUE_LENGTH,
      "Ideation suggestion",
    );
    if (!content.ok) {
      return content;
    }
    return this.replaceStep(
      context.value.step,
      {
        ...context.value.step,
        revision: context.value.step.revision + 1,
        suggestion: Object.freeze({
          id: suggestionId.value,
          content: content.value,
          generatedAt: context.value.now,
        }),
      },
      context.value.now,
    );
  }

  public acceptSuggestion(
    input: ChangeIdeationStepInput & Readonly<{ suggestionId: string }>,
  ): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutableStep(input);
    if (!context.ok) {
      return context;
    }
    const suggestionId = parseUuidV7(input.suggestionId);
    if (!suggestionId.ok) {
      return suggestionId;
    }
    const suggestion = context.value.step.suggestion;
    if (suggestion?.id !== suggestionId.value) {
      return suggestionNotFound();
    }
    return this.replaceStep(
      context.value.step,
      {
        ...context.value.step,
        state: "completed",
        value: suggestion.content,
        origin: "suggested",
        revision: context.value.step.revision + 1,
        suggestion: null,
      },
      context.value.now,
    );
  }

  public rejectSuggestion(
    input: ChangeIdeationStepInput & Readonly<{ suggestionId: string }>,
  ): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutableStep(input);
    if (!context.ok) {
      return context;
    }
    const suggestionId = parseUuidV7(input.suggestionId);
    if (!suggestionId.ok) {
      return suggestionId;
    }
    if (context.value.step.suggestion?.id !== suggestionId.value) {
      return suggestionNotFound();
    }
    return this.replaceStep(
      context.value.step,
      {
        ...context.value.step,
        revision: context.value.step.revision + 1,
        suggestion: null,
      },
      context.value.now,
    );
  }

  public buildProjectSeed(): Result<ProjectSeed, StoryCoreError> {
    if (this.snapshot.status !== "active") {
      return invalidTransition("Only an active ideation draft can create a project.");
    }
    const pending = this.snapshot.steps.filter((step) => step.state === "pending");
    if (pending.length > 0) {
      return err(
        new StoryCoreError({
          code: "HUMAN_DECISION_REQUIRED",
          message: "Every ideation step must be completed or explicitly skipped.",
          actions: ["RESUME_IDEATION"],
          details: { pendingSteps: pending.map(({ key }) => key).join(",") },
        }),
      );
    }
    const values = Object.fromEntries(
      this.snapshot.steps.map((step) => [step.key, step.value]),
    ) as Record<IdeationStepKey, string>;
    const firstChapterGoal =
      values.opening_hook || values.plot_route || "建立主角处境、核心冲突与推动下一章的问题。";
    return ok(
      Object.freeze({
        sourceDraftId: this.snapshot.id,
        projectName: this.snapshot.projectName,
        synopsis: values.premise,
        genre: values.genre,
        targetAudience: values.target_audience,
        premise: values.premise,
        protagonistDrive: values.protagonist_drive,
        worldSkeleton: values.world_skeleton,
        keyCharacters: values.key_characters,
        plotRoute: values.plot_route,
        openingHook: values.opening_hook,
        outputSpec: values.output_spec,
        firstChapterGoal,
      }),
    );
  }

  public finalize(
    projectIdValue: string,
    expectedRevision: number,
    nowValue: string,
  ): Result<IdeationDraft, StoryCoreError> {
    const context = this.mutationContext(expectedRevision, nowValue);
    if (!context.ok) {
      return context;
    }
    const seed = this.buildProjectSeed();
    if (!seed.ok) {
      return seed;
    }
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) {
      return projectId;
    }
    return ok(
      this.withSnapshot({
        ...this.snapshot,
        status: "finalized",
        projectId: projectId.value,
        revision: this.snapshot.revision + 1,
        updatedAt: context.value,
      }),
    );
  }

  private mutationContext(
    expectedRevision: number,
    nowValue: string,
  ): Result<IsoUtcTimestamp, StoryCoreError> {
    if (this.snapshot.status !== "active") {
      return invalidTransition("Finalized ideation drafts are immutable.");
    }
    if (expectedRevision !== this.snapshot.revision) {
      return revisionConflict(expectedRevision, this.snapshot.revision);
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(now.value, this.snapshot.updatedAt) < 0) {
      return validationError("Ideation mutation time cannot move backwards.");
    }
    return now;
  }

  private stepContext(
    expectedRevision: number,
    nowValue: string,
    key: IdeationStepKey,
  ): Result<Readonly<{ step: IdeationStepSnapshot; now: IsoUtcTimestamp }>, StoryCoreError> {
    const now = this.mutationContext(expectedRevision, nowValue);
    if (!now.ok) {
      return now;
    }
    const step = this.snapshot.steps.find((candidate) => candidate.key === key);
    return step === undefined
      ? validationError("Ideation step is invalid.")
      : ok({ step, now: now.value });
  }

  private mutableStep(
    input: ChangeIdeationStepInput,
  ): Result<Readonly<{ step: IdeationStepSnapshot; now: IsoUtcTimestamp }>, StoryCoreError> {
    const context = this.stepContext(input.expectedRevision, input.now, input.step);
    if (!context.ok) {
      return context;
    }
    return context.value.step.locked ? stepLocked(input.step) : context;
  }

  private replaceStep(
    previous: IdeationStepSnapshot,
    replacement: IdeationStepSnapshot,
    now: IsoUtcTimestamp,
  ): Result<IdeationDraft, StoryCoreError> {
    const steps = this.snapshot.steps.map((step) =>
      step.key === previous.key ? Object.freeze(replacement) : step,
    );
    return ok(
      this.withSnapshot({
        ...this.snapshot,
        currentStep: previous.key,
        revision: this.snapshot.revision + 1,
        steps: Object.freeze(steps),
        updatedAt: now,
      }),
    );
  }

  private withSnapshot(snapshot: IdeationDraftSnapshot): IdeationDraft {
    return new IdeationDraft(cloneSnapshot(snapshot));
  }
}

function createSteps(
  seed: QuickIdeationSeed | undefined,
): Result<readonly IdeationStepSnapshot[], StoryCoreError> {
  const values = new Map<IdeationStepKey, string>();
  if (seed !== undefined) {
    const idea = validateBoundedText(seed.idea, MAX_IDEATION_VALUE_LENGTH, "Quick idea");
    if (!idea.ok) {
      return idea;
    }
    const genre = validateBoundedText(seed.genre, MAX_IDEATION_VALUE_LENGTH, "Genre");
    if (!genre.ok) {
      return genre;
    }
    const protagonist = validateBoundedText(
      seed.protagonistType,
      MAX_IDEATION_VALUE_LENGTH,
      "Protagonist type",
    );
    if (!protagonist.ok) {
      return protagonist;
    }
    if (
      !Number.isSafeInteger(seed.targetWords) ||
      seed.targetWords < MIN_TARGET_WORDS ||
      seed.targetWords > MAX_TARGET_WORDS
    ) {
      return validationError("Target word count is outside the supported range.");
    }
    let style = "";
    if (seed.style !== undefined && seed.style.trim().length > 0) {
      const validatedStyle = validateBoundedText(
        seed.style,
        MAX_IDEATION_VALUE_LENGTH,
        "Writing style",
      );
      if (!validatedStyle.ok) {
        return validatedStyle;
      }
      style = validatedStyle.value;
    }
    values.set("genre", genre.value);
    values.set("premise", idea.value);
    values.set("protagonist_drive", protagonist.value);
    values.set(
      "output_spec",
      style.length === 0
        ? `目标字数：${seed.targetWords.toLocaleString("en-US")}`
        : `目标字数：${seed.targetWords.toLocaleString("en-US")}；风格：${style}`,
    );
  }

  return ok(
    Object.freeze(
      IDEATION_STEP_KEYS.map((key) => {
        const value = values.get(key) ?? "";
        return Object.freeze({
          key,
          state: value.length === 0 ? ("pending" as const) : ("completed" as const),
          value,
          locked: false,
          origin: value.length === 0 ? ("empty" as const) : ("quick_seed" as const),
          revision: 1,
          suggestion: null,
        });
      }),
    ),
  );
}

function firstPendingStep(steps: readonly IdeationStepSnapshot[]): IdeationStepKey {
  return steps.find((step) => step.state === "pending")?.key ?? IDEATION_STEP_KEYS[0];
}

function validateSnapshot(
  snapshot: IdeationDraftSnapshot,
): Result<IdeationDraftSnapshot, StoryCoreError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  if (!isIdeationMode(snapshot.mode)) {
    return validationError("Ideation mode is invalid.");
  }
  const projectName = validateBoundedText(
    snapshot.projectName,
    MAX_PROJECT_NAME_LENGTH,
    "Project name",
  );
  if (!projectName.ok) {
    return projectName;
  }
  if (!isIdeationStatus(snapshot.status)) {
    return validationError("Ideation status is invalid.");
  }
  const projectId = snapshot.projectId === null ? ok(null) : parseUuidV7(snapshot.projectId);
  if (!projectId.ok) {
    return projectId;
  }
  if (
    (snapshot.status === "active" && projectId.value !== null) ||
    (snapshot.status === "finalized" && projectId.value === null)
  ) {
    return validationError("Ideation finalization projection is inconsistent.");
  }
  if (
    !IDEATION_STEP_KEYS.includes(snapshot.currentStep) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    snapshot.steps.length !== IDEATION_STEP_KEYS.length
  ) {
    return validationError("Ideation revision or step projection is invalid.");
  }
  const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const updatedAt = parseIsoUtcTimestamp(snapshot.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }
  if (compareTimestamps(updatedAt.value, createdAt.value) < 0) {
    return validationError("Ideation timestamps are invalid.");
  }

  const steps: IdeationStepSnapshot[] = [];
  for (const [index, key] of IDEATION_STEP_KEYS.entries()) {
    const step = snapshot.steps[index];
    if (step?.key !== key) {
      return validationError("Ideation steps must use the canonical nine-step order.");
    }
    const validated = validateStep(step, updatedAt.value);
    if (!validated.ok) {
      return validated;
    }
    steps.push(validated.value);
  }
  return ok(
    Object.freeze({
      id: id.value,
      mode: snapshot.mode,
      projectName: projectName.value,
      status: snapshot.status,
      projectId: projectId.value,
      currentStep: snapshot.currentStep,
      revision: snapshot.revision,
      steps: Object.freeze(steps),
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    }),
  );
}

function validateStep(
  step: IdeationStepSnapshot,
  draftUpdatedAt: IsoUtcTimestamp,
): Result<IdeationStepSnapshot, StoryCoreError> {
  if (
    !IDEATION_STEP_KEYS.includes(step.key) ||
    !["pending", "completed", "skipped"].includes(step.state) ||
    !["empty", "manual", "suggested", "quick_seed"].includes(step.origin) ||
    typeof step.locked !== "boolean" ||
    !Number.isSafeInteger(step.revision) ||
    step.revision < 1 ||
    typeof step.value !== "string" ||
    step.value.length > MAX_IDEATION_VALUE_LENGTH ||
    step.value.includes("\u0000")
  ) {
    return validationError("Ideation step projection is invalid.");
  }
  if (
    (step.state === "completed" && (step.value.trim().length === 0 || step.origin === "empty")) ||
    (step.state !== "completed" && (step.value.length > 0 || step.origin !== "empty")) ||
    (step.locked && step.state !== "completed")
  ) {
    return validationError("Ideation step state is inconsistent.");
  }
  if (step.state === "completed") {
    const value = validateBoundedText(step.value, MAX_IDEATION_VALUE_LENGTH, "Ideation value");
    if (!value.ok || value.value !== step.value) {
      return value.ok ? validationError("Ideation value is not canonical.") : value;
    }
  }
  let suggestion: IdeationSuggestionSnapshot | null = null;
  if (step.suggestion !== null) {
    if (step.locked) {
      return validationError("Locked ideation steps cannot retain suggestions.");
    }
    const id = parseUuidV7(step.suggestion.id);
    if (!id.ok) {
      return id;
    }
    const content = validateBoundedText(
      step.suggestion.content,
      MAX_IDEATION_VALUE_LENGTH,
      "Ideation suggestion",
    );
    if (!content.ok) {
      return content;
    }
    const generatedAt = parseIsoUtcTimestamp(step.suggestion.generatedAt);
    if (!generatedAt.ok) {
      return generatedAt;
    }
    if (compareTimestamps(generatedAt.value, draftUpdatedAt) > 0) {
      return validationError("Ideation suggestion timestamp exceeds the draft update time.");
    }
    suggestion = Object.freeze({
      id: id.value,
      content: content.value,
      generatedAt: generatedAt.value,
    });
  }
  return ok(
    Object.freeze({
      key: step.key,
      state: step.state,
      value: step.value,
      locked: step.locked,
      origin: step.origin,
      revision: step.revision,
      suggestion,
    }),
  );
}

function cloneSnapshot(snapshot: IdeationDraftSnapshot): IdeationDraftSnapshot {
  return Object.freeze({
    ...snapshot,
    steps: Object.freeze(
      snapshot.steps.map((step) =>
        Object.freeze({
          ...step,
          suggestion: step.suggestion === null ? null : Object.freeze({ ...step.suggestion }),
        }),
      ),
    ),
  });
}

function revisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Ideation draft changed before the requested operation.",
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
      details: { expectedRevision, actualRevision },
    }),
  );
}

function validationError(message: string): Result<never, StoryCoreError> {
  return err(new StoryCoreError({ code: "STORY_VALIDATION_FAILED", message }));
}

function invalidTransition(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "IDEATION_INVALID_TRANSITION",
      message,
      actions: ["RESUME_IDEATION"],
    }),
  );
}

function stepLocked(step: IdeationStepKey): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "IDEATION_STEP_LOCKED",
      message: "Locked ideation steps cannot be edited or regenerated.",
      actions: ["UNLOCK_IDEATION_STEP"],
      details: { step },
    }),
  );
}

function suggestionNotFound(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "IDEATION_SUGGESTION_NOT_FOUND",
      message: "The ideation suggestion is no longer current.",
      actions: ["RECOMPARE", "REGENERATE_IDEATION"],
    }),
  );
}

function isIdeationMode(value: string): value is IdeationMode {
  return (["quick", "guided"] as readonly string[]).includes(value);
}

function isIdeationStatus(value: string): value is IdeationDraftStatus {
  return (["active", "finalized"] as readonly string[]).includes(value);
}
