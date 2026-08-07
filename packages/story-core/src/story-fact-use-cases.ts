import { StoryCoreError } from "./errors.js";
import {
  isRebuildableStoryFactType,
  StoryFact,
  type CreateStoryFactInput,
  type StoryFactOrigin,
  type StoryFactStore,
} from "./story-fact.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";

export const STORY_FACT_UPDATE_POLICIES = [
  "rebuildable_automatic",
  "automatic_reversible",
  "human_confirmation_required",
] as const;

export type StoryFactUpdatePolicy = (typeof STORY_FACT_UPDATE_POLICIES)[number];

const REVERSIBLE_FACT_TYPES = new Set([
  "character_state",
  "scene_tag",
  "relationship_change",
  "event_category",
  "weak_inference",
]);

const CRITICAL_FACT_TYPES = new Set([
  "character_death",
  "character_identity",
  "core_relationship",
  "world_rule",
  "major_ability_change",
  "key_item_ownership",
  "major_timeline_change",
  "foreshadow_status",
]);

/** Unknown and extensible fact types default to explicit confirmation. */
export function storyFactUpdatePolicy(factType: string): StoryFactUpdatePolicy {
  if (isRebuildableStoryFactType(factType)) {
    return "rebuildable_automatic";
  }
  if (REVERSIBLE_FACT_TYPES.has(factType)) {
    return "automatic_reversible";
  }
  if (CRITICAL_FACT_TYPES.has(factType)) {
    return "human_confirmation_required";
  }
  return "human_confirmation_required";
}

export interface StoryFactApplicationOptions {
  readonly facts: StoryFactStore;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export interface CreateFormalUserFactCommand {
  readonly projectId: string;
  readonly factType: string;
  readonly contentText?: string | null;
  readonly structuredValue?: unknown;
  readonly source?: CreateStoryFactInput["source"];
  readonly effectiveAt?: string | null;
  readonly invalidatedAt?: string | null;
  readonly actorId: string;
  readonly lock?: boolean;
  readonly humanConfirmed: boolean;
}

export interface StageAutomaticFactCommand {
  readonly projectId: string;
  readonly factType: string;
  readonly contentText?: string | null;
  readonly structuredValue?: unknown;
  readonly source: CreateStoryFactInput["source"];
  readonly effectiveAt?: string | null;
  readonly invalidatedAt?: string | null;
  readonly confidence: number;
  readonly origin: Exclude<StoryFactOrigin, "user" | "legacy">;
}

export interface StagedStoryFact {
  readonly fact: StoryFact;
  readonly updatePolicy: StoryFactUpdatePolicy;
}

export const REBUILDABLE_SYSTEM_FACT_SCHEMA_VERSION =
  "inkshadow.rebuildable-system-fact.v1" as const;

export interface ReplaceRebuildableSystemFactCommand {
  readonly projectId: string;
  readonly factType: string;
  readonly replacementKey: string;
  readonly contentText?: string | null;
  readonly payload: unknown;
  readonly source: CreateStoryFactInput["source"];
  readonly effectiveAt?: string | null;
  readonly invalidatedAt?: string | null;
  readonly confidence: number;
}

export interface ReplacedRebuildableSystemFact {
  readonly fact: StoryFact;
  readonly replacedFactIds: readonly string[];
}

export class StoryFactApplicationService {
  private readonly replacementQueues = new Map<string, Promise<void>>();

  public constructor(private readonly options: StoryFactApplicationOptions) {}

  public async createFormalUserFact(
    command: CreateFormalUserFactCommand,
  ): Promise<Result<StoryFact, StoryCoreError>> {
    if (!command.humanConfirmed) {
      return err(
        new StoryCoreError({
          code: "HUMAN_DECISION_REQUIRED",
          message: "A formal story fact requires an explicit user confirmation.",
        }),
      );
    }
    const id = this.options.ids.next();
    const created = StoryFact.create({
      id,
      projectId: command.projectId,
      factType: command.factType,
      ...(command.contentText === undefined ? {} : { contentText: command.contentText }),
      ...(command.structuredValue === undefined
        ? {}
        : { structuredValue: command.structuredValue }),
      source: command.source ?? {
        kind: "user_statement",
        reference: `user-statement:${command.actorId}:${id}`,
      },
      ...(command.effectiveAt === undefined ? {} : { effectiveAt: command.effectiveAt }),
      ...(command.invalidatedAt === undefined ? {} : { invalidatedAt: command.invalidatedAt }),
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      locked: command.lock ?? false,
      humanConfirmed: true,
      confirmationActorId: command.actorId,
      now: this.options.clock.now(),
    });
    if (!created.ok) {
      return created;
    }
    const saved = await this.options.facts.create(created.value);
    return saved.ok ? ok(created.value) : saved;
  }

  public async stageAutomaticFact(
    command: StageAutomaticFactCommand,
  ): Promise<Result<StagedStoryFact, StoryCoreError>> {
    const updatePolicy = storyFactUpdatePolicy(command.factType);
    const canBeTemporary =
      command.origin === "system" && updatePolicy !== "human_confirmation_required";
    const created = StoryFact.create({
      id: this.options.ids.next(),
      projectId: command.projectId,
      factType: command.factType,
      ...(command.contentText === undefined ? {} : { contentText: command.contentText }),
      ...(command.structuredValue === undefined
        ? {}
        : { structuredValue: command.structuredValue }),
      source: command.source,
      ...(command.effectiveAt === undefined ? {} : { effectiveAt: command.effectiveAt }),
      ...(command.invalidatedAt === undefined ? {} : { invalidatedAt: command.invalidatedAt }),
      confidence: command.confidence,
      status: canBeTemporary ? "temporary" : "unconfirmed",
      origin: command.origin,
      needsReview: !canBeTemporary,
      humanConfirmed: false,
      now: this.options.clock.now(),
    });
    if (!created.ok) {
      return created;
    }
    const saved = await this.options.facts.create(created.value);
    return saved.ok ? ok(Object.freeze({ fact: created.value, updatePolicy })) : saved;
  }

  public confirm(command: {
    readonly factId: string;
    readonly actorId: string;
    readonly lock?: boolean;
    readonly humanConfirmed: boolean;
    readonly expectedRevision: number;
  }): Promise<Result<StoryFact, StoryCoreError>> {
    return this.mutate(command.factId, (fact) =>
      fact.confirm({
        actorId: command.actorId,
        ...(command.lock === undefined ? {} : { lock: command.lock }),
        humanConfirmed: command.humanConfirmed,
        expectedRevision: command.expectedRevision,
        now: this.options.clock.now(),
      }),
    );
  }

  public setLocked(command: {
    readonly factId: string;
    readonly locked: boolean;
    readonly humanConfirmed: boolean;
    readonly expectedRevision: number;
  }): Promise<Result<StoryFact, StoryCoreError>> {
    return this.mutate(command.factId, (fact) =>
      fact.setLocked({
        locked: command.locked,
        humanConfirmed: command.humanConfirmed,
        expectedRevision: command.expectedRevision,
        now: this.options.clock.now(),
      }),
    );
  }

  public deprecate(command: {
    readonly factId: string;
    readonly humanConfirmed: boolean;
    readonly expectedRevision: number;
  }): Promise<Result<StoryFact, StoryCoreError>> {
    return this.mutate(command.factId, (fact) =>
      fact.deprecate({
        humanConfirmed: command.humanConfirmed,
        expectedRevision: command.expectedRevision,
        now: this.options.clock.now(),
      }),
    );
  }

  /**
   * Replaces a disposable system projection without pretending that a human
   * approved the retirement. Matching old projections are retired before the
   * new one is created, so a partial failure is fail-closed (no active result)
   * rather than allowing two competing active summaries.
   */
  public replaceRebuildableSystemFact(
    command: ReplaceRebuildableSystemFactCommand,
  ): Promise<Result<ReplacedRebuildableSystemFact, StoryCoreError>> {
    const validation = validateRebuildableReplacement(command.factType, command.replacementKey);
    if (!validation.ok) {
      return Promise.resolve(validation);
    }
    return this.withReplacementLock(
      `${command.projectId}:${command.factType}:${command.replacementKey}`,
      async () => {
        const retired = await this.retireMatchingRebuildableSystemFacts(command);
        if (!retired.ok) {
          return retired;
        }
        const staged = await this.stageAutomaticFact({
          projectId: command.projectId,
          factType: command.factType,
          ...(command.contentText === undefined ? {} : { contentText: command.contentText }),
          structuredValue: {
            schemaVersion: REBUILDABLE_SYSTEM_FACT_SCHEMA_VERSION,
            replacementKey: command.replacementKey,
            payload: command.payload,
          },
          source: command.source,
          ...(command.effectiveAt === undefined ? {} : { effectiveAt: command.effectiveAt }),
          ...(command.invalidatedAt === undefined ? {} : { invalidatedAt: command.invalidatedAt }),
          confidence: command.confidence,
          origin: "system",
        });
        if (!staged.ok) {
          return staged;
        }
        return ok(
          Object.freeze({
            fact: staged.value.fact,
            replacedFactIds: Object.freeze([...retired.value]),
          }),
        );
      },
    );
  }

  public clearRebuildableSystemFacts(command: {
    readonly projectId: string;
    readonly factType: string;
    readonly replacementKey: string;
  }): Promise<Result<readonly string[], StoryCoreError>> {
    const validation = validateRebuildableReplacement(command.factType, command.replacementKey);
    if (!validation.ok) {
      return Promise.resolve(validation);
    }
    return this.withReplacementLock(
      `${command.projectId}:${command.factType}:${command.replacementKey}`,
      () => this.retireMatchingRebuildableSystemFacts(command),
    );
  }

  private async retireMatchingRebuildableSystemFacts(command: {
    readonly projectId: string;
    readonly factType: string;
    readonly replacementKey: string;
  }): Promise<Result<readonly string[], StoryCoreError>> {
    const projectId = parseUuidV7(command.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const loaded = await this.options.facts.listByProjectId(projectId.value, {
      factType: command.factType,
    });
    if (!loaded.ok) {
      return loaded;
    }
    const matching = loaded.value.filter((fact) =>
      matchesRebuildableReplacement(fact, command.factType, command.replacementKey),
    );
    const retiredIds: string[] = [];
    for (const fact of matching) {
      const changed = fact.deprecateRebuildableSystemFact({
        expectedRevision: fact.revision,
        now: this.options.clock.now(),
      });
      if (!changed.ok) {
        return changed;
      }
      const saved = await this.options.facts.save(changed.value, fact.revision);
      if (!saved.ok) {
        return saved;
      }
      retiredIds.push(fact.id);
    }
    return ok(Object.freeze(retiredIds));
  }

  private async withReplacementLock<Value>(
    key: string,
    operation: () => Promise<Result<Value, StoryCoreError>>,
  ): Promise<Result<Value, StoryCoreError>> {
    const predecessor = this.replacementQueues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = predecessor.catch(() => undefined).then(() => gate);
    this.replacementQueues.set(key, queued);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.replacementQueues.get(key) === queued) {
        this.replacementQueues.delete(key);
      }
    }
  }

  private async mutate(
    factIdValue: string,
    mutation: (fact: StoryFact) => Result<StoryFact, StoryCoreError>,
  ): Promise<Result<StoryFact, StoryCoreError>> {
    const factId = parseUuidV7(factIdValue);
    if (!factId.ok) {
      return factId;
    }
    const loaded = await this.options.facts.findById(factId.value);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        new StoryCoreError({
          code: "STORY_FACT_NOT_FOUND",
          message: "Story fact was not found.",
        }),
      );
    }
    const current = loaded.value;
    const changed = mutation(current);
    if (!changed.ok) {
      return changed;
    }
    if (changed.value.revision === current.revision) {
      return changed;
    }
    const saved = await this.options.facts.save(changed.value, current.revision);
    return saved.ok ? changed : saved;
  }
}

function validateRebuildableReplacement(
  factType: string,
  replacementKey: string,
): Result<void, StoryCoreError> {
  if (!isRebuildableStoryFactType(factType)) {
    return err(
      new StoryCoreError({
        code: "STORY_FACT_INVALID_TRANSITION",
        message: "Only allow-listed rebuildable fact types can be replaced automatically.",
      }),
    );
  }
  if (
    typeof replacementKey !== "string" ||
    replacementKey.trim().length === 0 ||
    replacementKey.length > 500 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(replacementKey)
  ) {
    return err(
      new StoryCoreError({
        code: "STORY_VALIDATION_FAILED",
        message: "A rebuildable fact replacement key is required and must be bounded text.",
      }),
    );
  }
  return ok(undefined);
}

function matchesRebuildableReplacement(
  fact: StoryFact,
  factType: string,
  replacementKey: string,
): boolean {
  const snapshot = fact.toSnapshot();
  if (
    snapshot.factType !== factType ||
    snapshot.status !== "temporary" ||
    snapshot.origin !== "system" ||
    snapshot.userConfirmed ||
    snapshot.locked ||
    snapshot.deprecated ||
    snapshot.needsReview ||
    snapshot.branchId !== null
  ) {
    return false;
  }
  const value = snapshot.structuredValue;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(record).length === 3 &&
    record.schemaVersion === REBUILDABLE_SYSTEM_FACT_SCHEMA_VERSION &&
    record.replacementKey === replacementKey &&
    Object.prototype.hasOwnProperty.call(record, "payload")
  );
}
