import {
  NOVEL_SKILL_INVOCATION_MODES,
  compileNovelSkills,
  createCoreNovelSkillDefinitions,
  createGenreNovelSkillDefinitions,
  renderNovelSkillPromptSection,
  sealNovelSkillDefinition,
  type CompiledNovelSkills,
  type NovelSkillContextLayer,
  type NovelSkillDefinition,
  type NovelSkillDefinitionDraft,
  type NovelSkillInvocationMode,
  type NovelSkillSelectionReason,
  type NovelSkillTask,
  type ProjectNovelSkillBinding,
} from "@inkshadow/ai-core";
import type { Clock } from "@inkshadow/domain";

import type {
  CommitNovelSkillInvocationInput,
  IsolatedNovelSkillDefinitionRecord,
  NovelSkillDefinitionBindingCommitResult,
  NovelSkillDefinitionReadResult,
  NovelSkillInvocationSnapshotRecord,
  NovelSkillSqliteStore,
} from "./novel-skill-sqlite-store";

export const DEFAULT_NOVEL_SKILL_TOKEN_BUDGET = 1_200;

export type NovelSkillRuntimeAvailability = Readonly<{
  status: "ready" | "degraded" | "unavailable";
  reason: string | null;
}>;

export type NovelSkillNotAppliedReason =
  "browser_demo" | "legacy_route_untraceable" | "runtime_unavailable";

export interface NovelSkillProjectMethodView {
  /** Internal command key. Ordinary UI must never render this value. */
  readonly skillId: string;
  readonly displayName: string;
  readonly summary: string;
  readonly version: string;
  readonly kind: NovelSkillDefinition["kind"];
  readonly ownerScope: NovelSkillDefinition["ownerScope"];
  readonly status: NovelSkillDefinition["status"];
  readonly enabled: boolean;
  readonly archived: boolean;
  readonly appliesToContinuation: boolean;
  readonly taskTypes: readonly NovelSkillTask[];
}

export interface NovelSkillProjectState {
  readonly availability: NovelSkillRuntimeAvailability;
  readonly evaluationStatus: "not_evaluated";
  readonly methods: readonly NovelSkillProjectMethodView[];
  readonly isolatedRecords?: readonly IsolatedNovelSkillDefinitionRecord[];
}

export interface NovelSkillSelectionView {
  /** Rules from the exact selected definition version, never inferred from output. */
  readonly writingRequirements?: readonly string[];
  readonly displayName: string;
  readonly summary: string;
  readonly version: string;
  readonly kind: NovelSkillDefinition["kind"];
  readonly ownerScope: NovelSkillDefinition["ownerScope"];
  readonly included: boolean;
  readonly selectionReason: NovelSkillSelectionReason;
  readonly estimatedTokens: number;
}

export interface CustomNovelSkillDraft {
  readonly displayName: string;
  readonly summary: string;
  readonly taskTypes: readonly NovelSkillTask[];
  readonly rules: readonly string[];
  readonly prohibitions: readonly string[];
  readonly precedence: number;
  readonly projectScope: "current_project";
}

export interface CustomNovelSkillDocument {
  readonly schema: "inkshadow-writing-skill";
  readonly schemaVersion: 1;
  readonly skill: CustomNovelSkillDraft & Readonly<{ sourceSkillId: string }>;
}

export interface CustomNovelSkillImportPreview {
  readonly document: CustomNovelSkillDocument;
  readonly conflict: boolean;
  readonly conflictSkillId: string | null;
}

export interface PreparedNovelSkillInvocation {
  readonly status: "prepared_applied" | "prepared_none_selected" | "not_applied";
  readonly notAppliedReason: NovelSkillNotAppliedReason | null;
  readonly availability: NovelSkillRuntimeAvailability;
  readonly maximumSkillTokens: number;
  readonly usedSkillTokens: number;
  readonly promptSection: string | null;
  readonly methods: readonly NovelSkillSelectionView[];
  /** In-memory only. It is replayed transactionally immediately before dispatch. */
  readonly compiled: CompiledNovelSkills | null;
}

export interface NovelSkillInvocationView {
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly maximumSkillTokens: number;
  readonly usedSkillTokens: number;
  readonly methods: readonly NovelSkillSelectionView[];
  readonly createdAt: string;
}

export type NovelSkillInvocationLookup =
  | Readonly<{
      status: "found";
      availability: NovelSkillRuntimeAvailability;
      invocation: NovelSkillInvocationView;
    }>
  | Readonly<{
      status: "not_found" | "unavailable";
      availability: NovelSkillRuntimeAvailability;
      invocation: null;
    }>;

export interface PrepareNovelSkillInvocationInput {
  readonly projectId: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly maximumSkillTokens?: number;
  readonly availableContextLayers: readonly NovelSkillContextLayer[];
  readonly genreTags?: readonly string[];
  /** Author-selected methods for this invocation only; never persisted as project bindings. */
  readonly explicitSkillIds?: readonly string[];
}

export interface CommitPreparedNovelSkillInvocationInput {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly contextTraceId: string;
  readonly modelInvocationId: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly preparation: PreparedNovelSkillInvocation;
  readonly createdAt: string;
}

export interface NovelSkillRuntimePort {
  initialize(): Promise<NovelSkillRuntimeAvailability>;
  getAvailability(): NovelSkillRuntimeAvailability;
  listProjectState(projectId: string): Promise<NovelSkillProjectState>;
  setMethodEnabled(
    projectId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<NovelSkillProjectState>;
  createCustomSkill(
    projectId: string,
    draft: CustomNovelSkillDraft,
  ): Promise<NovelSkillProjectState>;
  updateCustomSkill(
    projectId: string,
    skillId: string,
    draft: CustomNovelSkillDraft,
  ): Promise<NovelSkillProjectState>;
  duplicateCustomSkill(
    projectId: string,
    skillId: string,
    displayName?: string,
  ): Promise<NovelSkillProjectState>;
  archiveCustomSkill(projectId: string, skillId: string): Promise<NovelSkillProjectState>;
  organizeCustomSkillDraft(description: string): CustomNovelSkillDraft;
  previewCustomSkillImport(
    projectId: string,
    serialized: string,
  ): Promise<CustomNovelSkillImportPreview>;
  importCustomSkill(
    projectId: string,
    preview: CustomNovelSkillImportPreview,
    resolution: "copy" | "replace",
  ): Promise<NovelSkillProjectState>;
  exportCustomSkill(projectId: string, skillId: string): Promise<string>;
  getReservedTokens(input: {
    readonly projectId: string;
    readonly taskType: NovelSkillTask;
    readonly explicitSkillIds?: readonly string[];
  }): Promise<number>;
  prepareInvocation(input: PrepareNovelSkillInvocationInput): Promise<PreparedNovelSkillInvocation>;
  commitBeforeDispatch(
    input: CommitPreparedNovelSkillInvocationInput,
  ): Promise<NovelSkillInvocationView | null>;
  findInvocationByContextTrace(contextTraceId: string): Promise<NovelSkillInvocationLookup>;
  describeNotApplied(reason: NovelSkillNotAppliedReason): PreparedNovelSkillInvocation;
}

export type NovelSkillRuntimeErrorCode =
  | "NOVEL_SKILL_RUNTIME_UNAVAILABLE"
  | "NOVEL_SKILL_METHOD_NOT_FOUND"
  | "NOVEL_SKILL_BINDING_FAILED"
  | "NOVEL_SKILL_COMPILE_FAILED"
  | "NOVEL_SKILL_RECEIPT_FAILED";

export class NovelSkillRuntimeError extends Error {
  public constructor(
    readonly code: NovelSkillRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NovelSkillRuntimeError";
  }
}

export interface NovelSkillRuntimePersistence {
  insertDefinition(value: NovelSkillDefinition): Promise<NovelSkillDefinition>;
  createDefinitionWithBinding(
    definition: NovelSkillDefinition,
    binding: ProjectNovelSkillBinding,
  ): Promise<NovelSkillDefinitionBindingCommitResult>;
  createVersionAndRepinBinding(
    definition: NovelSkillDefinition,
    binding: ProjectNovelSkillBinding,
    expectedRevision: number,
  ): Promise<NovelSkillDefinitionBindingCommitResult>;
  listDefinitions(): Promise<readonly NovelSkillDefinition[]>;
  listDefinitionsWithIsolation?(): Promise<NovelSkillDefinitionReadResult>;
  listBindings(projectId: string): Promise<readonly ProjectNovelSkillBinding[]>;
  saveBinding(
    value: ProjectNovelSkillBinding,
    expectedRevision: number,
  ): Promise<ProjectNovelSkillBinding>;
  commitInvocationBeforeDispatch(
    input: CommitNovelSkillInvocationInput,
  ): Promise<NovelSkillInvocationSnapshotRecord>;
  findInvocationSnapshotByContextTrace(
    contextTraceId: string,
  ): Promise<NovelSkillInvocationSnapshotRecord | null>;
}

const READY: NovelSkillRuntimeAvailability = Object.freeze({ status: "ready", reason: null });
const INITIALIZING: NovelSkillRuntimeAvailability = Object.freeze({
  status: "degraded",
  reason: "写作技能尚未完成本次启动准备。",
});
const BROWSER_UNAVAILABLE: NovelSkillRuntimeAvailability = Object.freeze({
  status: "unavailable",
  reason: "浏览器演示不会应用或保存写作技能采用记录。请在桌面版中使用。",
});

export class TauriNovelSkillRuntime implements NovelSkillRuntimePort {
  private availability: NovelSkillRuntimeAvailability = INITIALIZING;
  private isolatedRecords: readonly IsolatedNovelSkillDefinitionRecord[] = Object.freeze([]);

  public constructor(
    private readonly store: NovelSkillRuntimePersistence,
    private readonly clock: Pick<Clock, "now">,
  ) {}

  public async initialize(): Promise<NovelSkillRuntimeAvailability> {
    try {
      const definitions = [
        ...(await createCoreNovelSkillDefinitions()),
        ...(await createGenreNovelSkillDefinitions()),
      ];
      for (const definition of definitions) {
        await this.store.insertDefinition(definition);
      }
      this.availability = READY;
    } catch (cause: unknown) {
      this.availability = Object.freeze({
        status: "degraded",
        reason: "写作技能准备失败；基础写作仍可使用，本次不会应用写作技能。",
      });
      globalThis.console.error(
        "[NOVEL_SKILL_BOOTSTRAP_FAILED] Experimental writing methods remain disabled.",
        cause,
      );
    }
    return this.availability;
  }

  public getAvailability(): NovelSkillRuntimeAvailability {
    return this.availability;
  }

  public async listProjectState(projectId: string): Promise<NovelSkillProjectState> {
    if (this.availability.status !== "ready") {
      return emptyProjectState(this.availability);
    }
    const [definitions, bindings] = await Promise.all([
      this.readDefinitions(),
      this.store.listBindings(projectId),
    ]);
    return projectState(READY, definitions, bindings, this.isolatedRecords);
  }

  public async setMethodEnabled(
    projectId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<NovelSkillProjectState> {
    this.assertReady();
    try {
      const [definitions, bindings] = await Promise.all([
        this.readDefinitions(),
        this.store.listBindings(projectId),
      ]);
      const currentDefinitions = resolveCurrentDefinitions(
        definitionsForProject(definitions, bindings),
        bindings,
      );
      const definition = currentDefinitions.find((candidate) => candidate.skillId === skillId);
      if (definition === undefined) {
        throw new NovelSkillRuntimeError(
          "NOVEL_SKILL_METHOD_NOT_FOUND",
          "这项写作技能已不可用，请刷新后重试。",
        );
      }
      const existing = bindings.find((binding) => binding.skillId === skillId);
      if (existing?.enabled === enabled && existing.activationMode === "manual") {
        return projectState(READY, definitions, bindings, this.isolatedRecords);
      }
      const now = this.clock.now();
      const binding: ProjectNovelSkillBinding = Object.freeze({
        projectId,
        skillId,
        pinnedVersion: existing?.pinnedVersion ?? definition.version,
        enabled,
        activationMode: "manual",
        taskOverrides: existing?.taskOverrides ?? Object.freeze({}),
        revision: existing === undefined ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      await this.store.saveBinding(binding, existing?.revision ?? 0);
      return await this.listProjectState(projectId);
    } catch (cause: unknown) {
      if (cause instanceof NovelSkillRuntimeError) throw cause;
      throw new NovelSkillRuntimeError(
        "NOVEL_SKILL_BINDING_FAILED",
        "写作技能设置没有保存。正文和已有版本均未改变，请刷新后重试。",
        { cause },
      );
    }
  }

  public async createCustomSkill(
    projectId: string,
    draft: CustomNovelSkillDraft,
  ): Promise<NovelSkillProjectState> {
    this.assertReady();
    const definitions = await this.readDefinitions();
    const validated = validateCustomDraft(draft);
    const skillId = nextCustomSkillId(validated.displayName, this.clock.now(), definitions);
    const definition = await sealNovelSkillDefinition(
      customDefinitionDraft(skillId, "1.0.0", validated, "active", this.clock.now()),
    );
    const now = this.clock.now();
    await this.store.createDefinitionWithBinding(
      definition,
      Object.freeze({
        projectId,
        skillId,
        pinnedVersion: definition.version,
        enabled: false,
        activationMode: "manual",
        taskOverrides: Object.freeze({}),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return await this.listProjectState(projectId);
  }

  public async updateCustomSkill(
    projectId: string,
    skillId: string,
    draft: CustomNovelSkillDraft,
  ): Promise<NovelSkillProjectState> {
    this.assertReady();
    const [definitions, bindings] = await Promise.all([
      this.readDefinitions(),
      this.store.listBindings(projectId),
    ]);
    const current = requireCustomDefinition(skillId, definitions, bindings);
    const definition = await sealNovelSkillDefinition(
      customDefinitionDraft(
        skillId,
        nextCustomVersion(skillId, current.version, definitions),
        validateCustomDraft(draft),
        "active",
        this.clock.now(),
      ),
    );
    await this.pinCustomVersion(definition, bindings, undefined);
    return await this.listProjectState(projectId);
  }

  public async duplicateCustomSkill(
    projectId: string,
    skillId: string,
    displayName?: string,
  ): Promise<NovelSkillProjectState> {
    this.assertReady();
    const [definitions, bindings] = await Promise.all([
      this.readDefinitions(),
      this.store.listBindings(projectId),
    ]);
    const current = requireCustomDefinition(skillId, definitions, bindings);
    const draft = customDraftFromDefinition(current);
    return await this.createCustomSkill(projectId, {
      ...draft,
      displayName: boundedText(displayName ?? `${draft.displayName}副本`, 120, "技能名称"),
    });
  }

  public async archiveCustomSkill(
    projectId: string,
    skillId: string,
  ): Promise<NovelSkillProjectState> {
    this.assertReady();
    const [definitions, bindings] = await Promise.all([
      this.readDefinitions(),
      this.store.listBindings(projectId),
    ]);
    const current = requireCustomDefinition(skillId, definitions, bindings);
    if (current.status === "disabled") return await this.listProjectState(projectId);
    const definition = await sealNovelSkillDefinition(
      customDefinitionDraft(
        current.skillId,
        nextCustomVersion(current.skillId, current.version, definitions),
        customDraftFromDefinition(current),
        "disabled",
        this.clock.now(),
      ),
    );
    await this.pinCustomVersion(definition, bindings, false);
    return await this.listProjectState(projectId);
  }

  public organizeCustomSkillDraft(description: string): CustomNovelSkillDraft {
    return organizeCustomSkillDraft(description);
  }

  public async previewCustomSkillImport(
    projectId: string,
    serialized: string,
  ): Promise<CustomNovelSkillImportPreview> {
    this.assertReady();
    const document = parseCustomSkillDocument(serialized);
    const definitions = await this.readDefinitions();
    const bindings = await this.store.listBindings(projectId);
    const conflict = resolveCurrentDefinitions(
      definitionsForProject(definitions, bindings),
      bindings,
    ).find(({ skillId }) => skillId === document.skill.sourceSkillId);
    return Object.freeze({
      document,
      conflict: conflict !== undefined,
      conflictSkillId: conflict?.skillId ?? null,
    });
  }

  public async importCustomSkill(
    projectId: string,
    preview: CustomNovelSkillImportPreview,
    resolution: "copy" | "replace",
  ): Promise<NovelSkillProjectState> {
    this.assertReady();
    const document = validateImportPreview(preview);
    const draft = customDraftFromDocument(document);
    const [definitions, bindings] = await Promise.all([
      this.readDefinitions(),
      this.store.listBindings(projectId),
    ]);
    const currentConflict = resolveCurrentDefinitions(
      definitionsForProject(definitions, bindings),
      bindings,
    ).find(({ skillId }) => skillId === document.skill.sourceSkillId);
    if (
      preview.conflict !== (currentConflict !== undefined) ||
      preview.conflictSkillId !== (currentConflict?.skillId ?? null)
    ) {
      throw customSkillError("导入预览已经变化，请重新预览后再确认。");
    }
    if (resolution === "replace") {
      if (currentConflict?.ownerScope !== "user" || currentConflict.kind !== "custom") {
        throw customSkillError("这项来源不能替换内置技能，请保存为副本。");
      }
      return await this.updateCustomSkill(projectId, currentConflict.skillId, draft);
    }
    return await this.createCustomSkill(projectId, draft);
  }

  public async exportCustomSkill(projectId: string, skillId: string): Promise<string> {
    this.assertReady();
    const [definitions, bindings] = await Promise.all([
      this.readDefinitions(),
      this.store.listBindings(projectId),
    ]);
    const definition = requireCustomDefinition(skillId, definitions, bindings);
    const document: CustomNovelSkillDocument = Object.freeze({
      schema: "inkshadow-writing-skill",
      schemaVersion: 1,
      skill: Object.freeze({
        sourceSkillId: definition.skillId,
        ...customDraftFromDefinition(definition),
      }),
    });
    return JSON.stringify(document, null, 2);
  }

  public async getReservedTokens(input: {
    readonly projectId: string;
    readonly taskType: NovelSkillTask;
    readonly explicitSkillIds?: readonly string[];
  }): Promise<number> {
    if (this.availability.status !== "ready") return 0;
    const [definitions, bindings] = await Promise.all([
      this.readDefinitions(),
      this.store.listBindings(input.projectId),
    ]);
    const currentDefinitions = resolveCurrentDefinitions(
      definitionsForProject(definitions, bindings),
      bindings,
    );
    const oneTimeSkillIds = normalizeOneTimeExplicitSkillIds(input.explicitSkillIds);
    const hasExplicitApplicableMethod = currentDefinitions.some(
      (definition) =>
        definition.taskTypes.includes(input.taskType) &&
        (oneTimeSkillIds.has(definition.skillId) ||
          bindings.some((binding) => binding.skillId === definition.skillId && binding.enabled)),
    );
    return hasExplicitApplicableMethod ? DEFAULT_NOVEL_SKILL_TOKEN_BUDGET : 0;
  }

  public async prepareInvocation(
    input: PrepareNovelSkillInvocationInput,
  ): Promise<PreparedNovelSkillInvocation> {
    if (this.availability.status !== "ready") {
      return notApplied(this.availability, "runtime_unavailable");
    }
    try {
      const [definitions, bindings] = await Promise.all([
        this.readDefinitions(),
        this.store.listBindings(input.projectId),
      ]);
      const scopedDefinitions = definitionsForProject(definitions, bindings);
      const currentDefinitions = resolveCurrentDefinitions(scopedDefinitions, bindings);
      const availableSkillIds = new Set(currentDefinitions.map(({ skillId }) => skillId));
      const availableBindings = bindings.filter(({ skillId }) => availableSkillIds.has(skillId));
      const enabledBindings = availableBindings.filter(({ enabled }) => enabled);
      const oneTimeSkillIds = normalizeOneTimeExplicitSkillIds(input.explicitSkillIds);
      const explicitSkillIds = Object.freeze([
        ...new Set([...enabledBindings.map(({ skillId }) => skillId), ...oneTimeSkillIds]),
      ]);
      const explicitlySelectedDefinitions = currentDefinitions.filter(({ skillId }) =>
        explicitSkillIds.includes(skillId),
      );
      const selectedGenreTags = explicitlySelectedDefinitions.flatMap(
        ({ activation }) => activation.genreTags,
      );
      const compiled = await compileNovelSkills({
        projectId: input.projectId,
        taskType: input.taskType,
        invocationMode: input.invocationMode,
        maximumSkillTokens: input.maximumSkillTokens ?? DEFAULT_NOVEL_SKILL_TOKEN_BUDGET,
        genreTags: Object.freeze([...new Set([...(input.genreTags ?? []), ...selectedGenreTags])]),
        explicitSkillIds: Object.freeze(explicitSkillIds),
        availableContextLayers: input.availableContextLayers,
        allowExperimental: explicitlySelectedDefinitions.some(
          ({ status }) => status === "experimental",
        ),
        definitions: scopedDefinitions,
        bindings: availableBindings,
      });
      const methods = selectionViews(compiled, currentDefinitions);
      const promptSection = renderNovelSkillPromptSection(compiled);
      return Object.freeze({
        status: promptSection === null ? "prepared_none_selected" : "prepared_applied",
        notAppliedReason: null,
        availability: READY,
        maximumSkillTokens: compiled.configuration.maximumSkillTokens,
        usedSkillTokens: compiled.usedSkillTokens,
        promptSection,
        methods,
        compiled,
      });
    } catch (cause: unknown) {
      throw new NovelSkillRuntimeError(
        "NOVEL_SKILL_COMPILE_FAILED",
        "写作技能无法安全整理，因此本次没有调用 AI。请停用相关技能或刷新后重试。",
        { cause },
      );
    }
  }

  public async commitBeforeDispatch(
    input: CommitPreparedNovelSkillInvocationInput,
  ): Promise<NovelSkillInvocationView | null> {
    const compiled = input.preparation.compiled;
    if (compiled === null) {
      return null;
    }
    this.assertReady();
    try {
      const snapshot = await this.store.commitInvocationBeforeDispatch({
        snapshotId: input.snapshotId,
        projectId: input.projectId,
        contextTraceId: input.contextTraceId,
        modelInvocationId: input.modelInvocationId,
        taskType: input.taskType,
        invocationMode: input.invocationMode,
        compiled,
        createdAt: input.createdAt,
      });
      return await this.toInvocationView(snapshot);
    } catch (cause: unknown) {
      throw new NovelSkillRuntimeError(
        "NOVEL_SKILL_RECEIPT_FAILED",
        "写作技能设置在发送前发生变化，或无法保存完整采用记录；本次没有向 AI 发送正文。请重新检查后重试。",
        { cause },
      );
    }
  }

  public async findInvocationByContextTrace(
    contextTraceId: string,
  ): Promise<NovelSkillInvocationLookup> {
    if (this.availability.status !== "ready") {
      return Object.freeze({
        status: "unavailable",
        availability: this.availability,
        invocation: null,
      });
    }
    const snapshot = await this.store.findInvocationSnapshotByContextTrace(contextTraceId);
    if (snapshot === null) {
      return Object.freeze({ status: "not_found", availability: READY, invocation: null });
    }
    return Object.freeze({
      status: "found",
      availability: READY,
      invocation: await this.toInvocationView(snapshot),
    });
  }

  public describeNotApplied(reason: NovelSkillNotAppliedReason): PreparedNovelSkillInvocation {
    return notApplied(this.availability, reason);
  }

  private assertReady(): void {
    if (this.availability.status !== "ready") {
      throw new NovelSkillRuntimeError(
        "NOVEL_SKILL_RUNTIME_UNAVAILABLE",
        this.availability.reason ?? "写作技能当前不可用。",
      );
    }
  }

  private async readDefinitions(): Promise<readonly NovelSkillDefinition[]> {
    if (this.store.listDefinitionsWithIsolation === undefined) {
      this.isolatedRecords = Object.freeze([]);
      return await this.store.listDefinitions();
    }
    const result = await this.store.listDefinitionsWithIsolation();
    this.isolatedRecords = result.isolatedRecords;
    return result.definitions;
  }

  private async pinCustomVersion(
    definition: NovelSkillDefinition,
    bindings: readonly ProjectNovelSkillBinding[],
    forceEnabled: boolean | undefined,
  ): Promise<void> {
    const existing = bindings.find(({ skillId }) => skillId === definition.skillId);
    if (existing === undefined) {
      throw customSkillError("这项自定义写作技能没有当前项目绑定，请刷新后重试。");
    }
    const now = this.clock.now();
    await this.store.createVersionAndRepinBinding(
      definition,
      Object.freeze({
        ...existing,
        pinnedVersion: definition.version,
        enabled: forceEnabled ?? existing.enabled,
        revision: existing.revision + 1,
        updatedAt: now,
      }),
      existing.revision,
    );
  }

  private async toInvocationView(
    snapshot: NovelSkillInvocationSnapshotRecord,
  ): Promise<NovelSkillInvocationView> {
    const definitions = await this.readDefinitions();
    const byKey = new Map(
      definitions.map((definition) => [`${definition.skillId}@${definition.version}`, definition]),
    );
    const methods = snapshot.items.map((item) => {
      const definition = byKey.get(`${item.skillId}@${item.skillVersion}`);
      if (definition === undefined) {
        throw new NovelSkillRuntimeError(
          "NOVEL_SKILL_RECEIPT_FAILED",
          "写作技能历史记录引用的版本已不可用。",
        );
      }
      return selectionView(definition, item, snapshot.writingRequirements);
    });
    return Object.freeze({
      taskType: snapshot.taskType,
      invocationMode: snapshot.invocationMode,
      maximumSkillTokens: snapshot.maximumSkillTokens,
      usedSkillTokens: snapshot.usedSkillTokens,
      methods: Object.freeze(methods),
      createdAt: snapshot.createdAt,
    });
  }
}

export class BrowserUnavailableNovelSkillRuntime implements NovelSkillRuntimePort {
  public initialize(): Promise<NovelSkillRuntimeAvailability> {
    return Promise.resolve(BROWSER_UNAVAILABLE);
  }

  public getAvailability(): NovelSkillRuntimeAvailability {
    return BROWSER_UNAVAILABLE;
  }

  public listProjectState(projectId: string): Promise<NovelSkillProjectState> {
    void projectId;
    return Promise.resolve(emptyProjectState(BROWSER_UNAVAILABLE));
  }

  public setMethodEnabled(
    projectId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<NovelSkillProjectState> {
    void projectId;
    void skillId;
    void enabled;
    return Promise.reject(
      new NovelSkillRuntimeError(
        "NOVEL_SKILL_RUNTIME_UNAVAILABLE",
        BROWSER_UNAVAILABLE.reason ?? "浏览器演示不支持写作技能。",
      ),
    );
  }

  public createCustomSkill(
    projectId: string,
    draft: CustomNovelSkillDraft,
  ): Promise<NovelSkillProjectState> {
    void projectId;
    void draft;
    return this.rejectCustomMutation();
  }

  public updateCustomSkill(
    projectId: string,
    skillId: string,
    draft: CustomNovelSkillDraft,
  ): Promise<NovelSkillProjectState> {
    void projectId;
    void skillId;
    void draft;
    return this.rejectCustomMutation();
  }

  public duplicateCustomSkill(
    projectId: string,
    skillId: string,
    displayName?: string,
  ): Promise<NovelSkillProjectState> {
    void projectId;
    void skillId;
    void displayName;
    return this.rejectCustomMutation();
  }

  public archiveCustomSkill(projectId: string, skillId: string): Promise<NovelSkillProjectState> {
    void projectId;
    void skillId;
    return this.rejectCustomMutation();
  }

  public organizeCustomSkillDraft(description: string): CustomNovelSkillDraft {
    return organizeCustomSkillDraft(description);
  }

  public previewCustomSkillImport(
    projectId: string,
    serialized: string,
  ): Promise<CustomNovelSkillImportPreview> {
    void projectId;
    void serialized;
    return Promise.reject(this.unavailableError());
  }

  public importCustomSkill(
    projectId: string,
    preview: CustomNovelSkillImportPreview,
    resolution: "copy" | "replace",
  ): Promise<NovelSkillProjectState> {
    void projectId;
    void preview;
    void resolution;
    return this.rejectCustomMutation();
  }

  public exportCustomSkill(projectId: string, skillId: string): Promise<string> {
    void projectId;
    void skillId;
    return Promise.reject(this.unavailableError());
  }

  public getReservedTokens(input: {
    readonly projectId: string;
    readonly taskType: NovelSkillTask;
    readonly explicitSkillIds?: readonly string[];
  }): Promise<number> {
    void input;
    return Promise.resolve(0);
  }

  public prepareInvocation(
    input: PrepareNovelSkillInvocationInput,
  ): Promise<PreparedNovelSkillInvocation> {
    void input;
    return Promise.resolve(notApplied(BROWSER_UNAVAILABLE, "browser_demo"));
  }

  public commitBeforeDispatch(input: CommitPreparedNovelSkillInvocationInput): Promise<null> {
    void input;
    return Promise.resolve(null);
  }

  public findInvocationByContextTrace(contextTraceId: string): Promise<NovelSkillInvocationLookup> {
    void contextTraceId;
    return Promise.resolve(
      Object.freeze({
        status: "unavailable",
        availability: BROWSER_UNAVAILABLE,
        invocation: null,
      }),
    );
  }

  public describeNotApplied(reason: NovelSkillNotAppliedReason): PreparedNovelSkillInvocation {
    return notApplied(BROWSER_UNAVAILABLE, reason);
  }

  private rejectCustomMutation(): Promise<NovelSkillProjectState> {
    return Promise.reject(this.unavailableError());
  }

  private unavailableError(): NovelSkillRuntimeError {
    return new NovelSkillRuntimeError(
      "NOVEL_SKILL_RUNTIME_UNAVAILABLE",
      BROWSER_UNAVAILABLE.reason ?? "浏览器演示不支持写作技能。",
    );
  }
}

export function createNovelSkillRuntime(
  input:
    | Readonly<{
        mode: "tauri";
        store: NovelSkillSqliteStore;
        clock: Pick<Clock, "now">;
      }>
    | Readonly<{ mode: "browser-development" }>,
): NovelSkillRuntimePort {
  return input.mode === "tauri"
    ? new TauriNovelSkillRuntime(input.store, input.clock)
    : new BrowserUnavailableNovelSkillRuntime();
}

function emptyProjectState(availability: NovelSkillRuntimeAvailability): NovelSkillProjectState {
  return Object.freeze({
    availability,
    evaluationStatus: "not_evaluated",
    methods: Object.freeze([]),
  });
}

function projectState(
  availability: NovelSkillRuntimeAvailability,
  definitions: readonly NovelSkillDefinition[],
  bindings: readonly ProjectNovelSkillBinding[],
  isolatedRecords: readonly IsolatedNovelSkillDefinitionRecord[] = Object.freeze([]),
): NovelSkillProjectState {
  const currentDefinitions = resolveCurrentDefinitions(
    definitionsForProject(definitions, bindings),
    bindings,
  );
  const bindingBySkill = new Map(bindings.map((binding) => [binding.skillId, binding]));
  return Object.freeze({
    availability,
    evaluationStatus: "not_evaluated",
    isolatedRecords,
    methods: Object.freeze(
      currentDefinitions.map((definition) => ({
        skillId: definition.skillId,
        displayName: definition.displayName,
        summary: definition.summary,
        version: definition.version,
        kind: definition.kind,
        ownerScope: definition.ownerScope,
        status: definition.status,
        enabled: bindingBySkill.get(definition.skillId)?.enabled ?? false,
        archived: definition.status === "disabled" || definition.status === "deprecated",
        appliesToContinuation: definition.taskTypes.includes("continuation"),
        taskTypes: definition.taskTypes,
      })),
    ),
  });
}

function resolveCurrentDefinitions(
  definitions: readonly NovelSkillDefinition[],
  bindings: readonly ProjectNovelSkillBinding[],
): readonly NovelSkillDefinition[] {
  const bindingBySkill = new Map(bindings.map((binding) => [binding.skillId, binding]));
  const grouped = new Map<string, NovelSkillDefinition[]>();
  for (const definition of definitions) {
    const versions = grouped.get(definition.skillId) ?? [];
    versions.push(definition);
    grouped.set(definition.skillId, versions);
  }
  return Object.freeze(
    [...grouped.entries()]
      .map(([skillId, versions]) => {
        const pinnedVersion = bindingBySkill.get(skillId)?.pinnedVersion;
        return pinnedVersion === undefined
          ? [...versions].sort((left, right) => compareVersions(right.version, left.version))[0]
          : versions.find(({ version }) => version === pinnedVersion);
      })
      .filter((definition): definition is NovelSkillDefinition => definition !== undefined)
      .sort((left, right) =>
        left.kind === right.kind
          ? left.displayName.localeCompare(right.displayName, "zh-CN")
          : left.kind.localeCompare(right.kind, "en"),
      ),
  );
}

function definitionsForProject(
  definitions: readonly NovelSkillDefinition[],
  bindings: readonly ProjectNovelSkillBinding[],
): readonly NovelSkillDefinition[] {
  const boundSkillIds = new Set(bindings.map(({ skillId }) => skillId));
  return Object.freeze(
    definitions.filter(
      ({ ownerScope, skillId }) => ownerScope === "builtin" || boundSkillIds.has(skillId),
    ),
  );
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

const CUSTOM_NOVEL_SKILL_TASKS: readonly NovelSkillTask[] = Object.freeze([
  "idea_discussion",
  "book_start_guidance",
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "outline_planning",
  "scene_breakdown",
  "chapter_summary",
  "translation",
]);
const UNSAFE_CUSTOM_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const UNSAFE_CUSTOM_DIRECTIVE =
  /(?:(?:忽略|覆盖|绕过|更改|修改|关闭|取消|禁用).{0,16}(?:系统(?:指令|提示)|隐私(?:规则|设置|边界)|发送(?:规则|确认|边界)|安全(?:规则|边界)|私密章节)|(?:ignore|override|bypass|disable).{0,32}(?:system|privacy|dispatch|consent|safety))/iu;
const CUSTOM_SKILL_ID = /^(?=.{3,96}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/u;

function normalizeOneTimeExplicitSkillIds(
  value: readonly string[] | undefined,
): ReadonlySet<string> {
  const skillIds = value ?? [];
  if (
    !Array.isArray(skillIds) ||
    skillIds.length > 32 ||
    new Set(skillIds).size !== skillIds.length ||
    skillIds.some((skillId) => typeof skillId !== "string" || !CUSTOM_SKILL_ID.test(skillId))
  ) {
    throw new NovelSkillRuntimeError(
      "NOVEL_SKILL_COMPILE_FAILED",
      "本次选择的写作技能无效或数量过多，因此没有调用 AI。请重新选择后重试。",
    );
  }
  return new Set(skillIds);
}

function customDefinitionDraft(
  skillId: string,
  version: string,
  input: CustomNovelSkillDraft,
  status: NovelSkillDefinition["status"],
  createdAt: string,
): NovelSkillDefinitionDraft {
  const draft = validateCustomDraft(input);
  const instructionRules = [
    ...draft.rules.map((text, index) => ({
      ruleId: `${skillId}.rule.${String(index + 1).padStart(2, "0")}`,
      text,
    })),
    ...draft.prohibitions.map((text, index) => ({
      ruleId: `${skillId}.prohibition.${String(index + 1).padStart(2, "0")}`,
      text: text.startsWith("不得") ? text : `不得${text}`,
    })),
  ];
  const validationRules =
    draft.prohibitions.length > 0
      ? draft.prohibitions.map((text, index) => ({
          ruleId: `${skillId}.prohibition.${String(index + 1).padStart(2, "0")}`,
          text: text.startsWith("不得") ? text : `不得${text}`,
          evidenceRequired: false,
        }))
      : [
          {
            ruleId: `${skillId}.author.intent`,
            text: "不得覆盖作者当前任务、正式设定、私密范围或已保存正文。",
            evidenceRequired: false,
          },
        ];
  return Object.freeze({
    skillId,
    version,
    displayName: draft.displayName,
    summary: draft.summary,
    kind: "custom",
    ownerScope: "user",
    status,
    defaultEnabled: false,
    precedence: draft.precedence,
    taskTypes: draft.taskTypes,
    activation: Object.freeze({
      allowedModes: Object.freeze([...NOVEL_SKILL_INVOCATION_MODES]),
      genreTags: Object.freeze([]),
      exclusiveGroup: null,
    }),
    contextRequirements: Object.freeze({
      requiredLayers: Object.freeze(["current_task"] as const),
      optionalLayers: Object.freeze(["scene_goal", "recent_events", "world_setting"] as const),
    }),
    instructions: Object.freeze({ rules: Object.freeze(instructionRules) }),
    outputContract: Object.freeze({ kind: "prose", rules: Object.freeze([]) }),
    validation: Object.freeze({ rules: Object.freeze(validationRules) }),
    provenance: Object.freeze({ url: null, commit: null, license: null }),
    createdAt,
  });
}

function validateCustomDraft(value: unknown): CustomNovelSkillDraft {
  assertPlainRecord(value, "写作技能草稿");
  assertExactKeys(value, [
    "displayName",
    "summary",
    "taskTypes",
    "rules",
    "prohibitions",
    "precedence",
    "projectScope",
  ]);
  const displayName = boundedText(value.displayName, 120, "技能名称");
  const summary = boundedText(value.summary, 500, "用途说明");
  const taskTypes = value.taskTypes;
  if (
    !Array.isArray(taskTypes) ||
    taskTypes.length < 1 ||
    taskTypes.length > CUSTOM_NOVEL_SKILL_TASKS.length
  ) {
    throw customSkillError("适用任务必须从安全的写作任务中选择，且不能重复。");
  }
  const safeTaskTypes = taskTypes.filter(isCustomNovelSkillTask);
  if (
    safeTaskTypes.length !== taskTypes.length ||
    new Set(safeTaskTypes).size !== safeTaskTypes.length
  ) {
    throw customSkillError("适用任务必须从安全的写作任务中选择，且不能重复。");
  }
  const rules = boundedTextList(value.rules, 1, 16, 1_000, "写作规则");
  const prohibitions = boundedTextList(value.prohibitions, 0, 16, 1_000, "不允许做的事");
  const precedence = value.precedence;
  if (
    typeof precedence !== "number" ||
    !Number.isSafeInteger(precedence) ||
    precedence < 300 ||
    precedence > 599
  ) {
    throw customSkillError("技能优先级必须是 300 到 599 之间的整数。");
  }
  if (value.projectScope !== "current_project") {
    throw customSkillError("当前版本只允许把自定义技能明确绑定到当前项目。");
  }
  return Object.freeze({
    displayName,
    summary,
    taskTypes: Object.freeze([...safeTaskTypes]),
    rules,
    prohibitions,
    precedence,
    projectScope: "current_project",
  });
}

function organizeCustomSkillDraft(description: string): CustomNovelSkillDraft {
  const source = boundedText(description, 8_000, "自然语言说明");
  const displayName =
    /(?:名称|技能名)[：:]\s*([^。；;!！?？\n]{1,120})/u.exec(source)?.[1]?.trim() ?? "我的写作技能";
  const taskLabels: Readonly<Partial<Record<NovelSkillTask, readonly string[]>>> = {
    idea_discussion: ["讨论灵感", "灵感讨论"],
    book_start_guidance: ["设计开头", "开头设计", "开书"],
    prose_generation: ["生成正文", "正文"],
    continuation: ["续写"],
    rewrite: ["改写"],
    polish: ["润色"],
    outline_planning: ["故事规划", "规划故事", "大纲"],
    scene_breakdown: ["场景规划", "场景拆解"],
    chapter_summary: ["章节总结", "章节摘要", "总结", "摘要"],
    translation: ["翻译"],
  };
  const knownTaskLabels = Object.values(taskLabels).flat();
  const taskScopeClauses = source
    .split(/[，,。；;!！?？\n]+|(?:但是|不过|然而|但)(?=(?:只)?(?:适用于|用于|用在))/gu)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  const negativeTaskScope = taskScopeClauses
    .filter(
      (clause) =>
        /(?:不适用于|不用于|不要用于|不得用于|禁止用于|不支持)/u.test(clause) &&
        knownTaskLabels.some((label) => clause.includes(label)),
    )
    .join(" ");
  const explicitTaskScope = taskScopeClauses
    .filter(
      (clause) =>
        !/(?:不适用于|不用于|不要用于|不得用于|禁止用于|不支持)/u.test(clause) &&
        /(?:适用任务|支持任务|适用于|用于|用在)/u.test(clause),
    )
    .join(" ");
  const taskTypes = CUSTOM_NOVEL_SKILL_TASKS.filter((task) => {
    const labels = taskLabels[task] ?? [];
    return (
      labels.some((label) => explicitTaskScope.includes(label)) &&
      !labels.some((label) => negativeTaskScope.includes(label))
    );
  });
  if (taskTypes.length === 0 && negativeTaskScope.length > 0) {
    throw customSkillError(
      "说明里只有不适用任务，还没有说明这项技能要用于哪种写作。请补充“适用于续写”或其他明确任务；原说明仍会保留。",
    );
  }
  const ruleSection = /(?:规则|写作规则)[：:]\s*([^。!！?？\n]+)/u.exec(source)?.[1] ?? "";
  const rules = ruleSection
    .split(/[；;]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const unlabelledRules = source
    .split(/[。；;!！?？\n]+/u)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.length > 0 &&
        !/^(?:名称|技能名|适用任务|支持任务)[：:]/u.test(entry) &&
        !/^(?:用于|适用于|用在|不适用于|不用于|不要用于|不得用于|禁止用于)/u.test(entry) &&
        !/^(?:不要|不得)/u.test(entry),
    );
  const prohibitions = [...source.matchAll(/(?:不要|不得)\s*([^。；;!！?？\n]+)/gu)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return validateCustomDraft({
    displayName,
    summary: source.length <= 500 ? source : `${source.slice(0, 499)}…`,
    taskTypes: taskTypes.length > 0 ? taskTypes : ["continuation"],
    rules: rules.length > 0 ? rules : unlabelledRules,
    prohibitions: prohibitions.filter((entry) => entry.length > 0),
    precedence: 500,
    projectScope: "current_project",
  });
}

function customDraftFromDefinition(definition: NovelSkillDefinition): CustomNovelSkillDraft {
  const rules = definition.instructions.rules
    .filter(({ ruleId }) => ruleId.includes(".rule."))
    .map(({ text }) => text);
  const prohibitions = definition.instructions.rules
    .filter(({ ruleId }) => ruleId.includes(".prohibition."))
    .map(({ text }) => text.replace(/^不得/u, ""));
  return validateCustomDraft({
    displayName: definition.displayName,
    summary: definition.summary,
    taskTypes: definition.taskTypes,
    rules,
    prohibitions,
    precedence: definition.precedence,
    projectScope: "current_project",
  });
}

function customDraftFromDocument(document: CustomNovelSkillDocument): CustomNovelSkillDraft {
  const { skill } = document;
  return Object.freeze({
    displayName: skill.displayName,
    summary: skill.summary,
    taskTypes: skill.taskTypes,
    rules: skill.rules,
    prohibitions: skill.prohibitions,
    precedence: skill.precedence,
    projectScope: skill.projectScope,
  });
}

function isCustomNovelSkillTask(value: unknown): value is NovelSkillTask {
  return typeof value === "string" && CUSTOM_NOVEL_SKILL_TASKS.some((task) => task === value);
}

function parseCustomSkillDocument(serialized: string): CustomNovelSkillDocument {
  const source = boundedText(serialized, 64_000, "导入内容");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw customSkillError("导入内容不是有效的写作技能文件。");
  }
  assertPlainRecord(parsed, "写作技能文件");
  assertExactKeys(parsed, ["schema", "schemaVersion", "skill"]);
  if (parsed.schema !== "inkshadow-writing-skill" || parsed.schemaVersion !== 1) {
    throw customSkillError("写作技能文件的格式或版本不受支持。");
  }
  assertPlainRecord(parsed.skill, "写作技能内容");
  assertExactKeys(parsed.skill, [
    "sourceSkillId",
    "displayName",
    "summary",
    "taskTypes",
    "rules",
    "prohibitions",
    "precedence",
    "projectScope",
  ]);
  if (
    typeof parsed.skill.sourceSkillId !== "string" ||
    !CUSTOM_SKILL_ID.test(parsed.skill.sourceSkillId)
  ) {
    throw customSkillError("写作技能文件缺少安全的来源信息。");
  }
  const { sourceSkillId, ...draftFields } = parsed.skill;
  const skill = validateCustomDraft(draftFields);
  return Object.freeze({
    schema: "inkshadow-writing-skill",
    schemaVersion: 1,
    skill: Object.freeze({ sourceSkillId, ...skill }),
  });
}

function validateImportPreview(preview: CustomNovelSkillImportPreview): CustomNovelSkillDocument {
  assertPlainRecord(preview, "导入预览");
  assertExactKeys(preview, ["document", "conflict", "conflictSkillId"]);
  if (typeof preview.conflict !== "boolean") throw customSkillError("导入预览状态无效。");
  if (
    preview.conflictSkillId !== null &&
    (typeof preview.conflictSkillId !== "string" || !CUSTOM_SKILL_ID.test(preview.conflictSkillId))
  ) {
    throw customSkillError("导入预览中的冲突信息无效。");
  }
  return parseCustomSkillDocument(JSON.stringify(preview.document));
}

function requireCustomDefinition(
  skillId: string,
  definitions: readonly NovelSkillDefinition[],
  bindings: readonly ProjectNovelSkillBinding[],
): NovelSkillDefinition {
  const definition = resolveCurrentDefinitions(
    definitionsForProject(definitions, bindings),
    bindings,
  ).find((candidate) => candidate.skillId === skillId);
  if (definition?.ownerScope !== "user" || definition.kind !== "custom") {
    throw new NovelSkillRuntimeError(
      "NOVEL_SKILL_METHOD_NOT_FOUND",
      "没有找到这项自定义写作技能；内置技能不能通过用户技能入口修改。",
    );
  }
  return definition;
}

function nextCustomSkillId(
  displayName: string,
  now: string,
  definitions: readonly NovelSkillDefinition[],
): string {
  let hash = 2_166_136_261;
  for (const character of `${displayName}|${now}|${String(definitions.length)}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const base = `custom.user.${hash.toString(16).padStart(8, "0")}`;
  const occupied = new Set(definitions.map(({ skillId }) => skillId));
  if (!occupied.has(base)) return base;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${base}.${String(index)}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw customSkillError("自定义写作技能标识空间已满，请稍后重试。");
}

function incrementPatchVersion(version: string): string {
  const parts = version.split(".");
  const major = BigInt(parts[0] ?? "0");
  const minor = BigInt(parts[1] ?? "0");
  const patch = BigInt(parts[2] ?? "0") + 1n;
  return `${major.toString()}.${minor.toString()}.${patch.toString()}`;
}

function nextCustomVersion(
  skillId: string,
  pinnedVersion: string,
  definitions: readonly NovelSkillDefinition[],
): string {
  const latestVersion = definitions
    .filter((definition) => definition.skillId === skillId)
    .map(({ version }) => version)
    .reduce(
      (latest, version) => (compareVersions(version, latest) > 0 ? version : latest),
      pinnedVersion,
    );
  return incrementPatchVersion(latestVersion);
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string") throw customSkillError(`${field}必须是文字。`);
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    UNSAFE_CUSTOM_TEXT.test(normalized) ||
    UNSAFE_CUSTOM_DIRECTIVE.test(normalized)
  ) {
    throw customSkillError(`${field}为空、过长或包含不安全字符。`);
  }
  return normalized;
}

function boundedTextList(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumText: number,
  field: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw customSkillError(`${field}的数量不符合要求。`);
  }
  const entries = value.map((entry) => boundedText(entry, maximumText, field));
  if (new Set(entries).size !== entries.length) throw customSkillError(`${field}不能重复。`);
  return Object.freeze(entries);
}

function assertPlainRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  ) {
    throw customSkillError(`${field}的结构无效。`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw customSkillError("写作技能内容包含缺失或不允许的字段。");
  }
}

function customSkillError(message: string): NovelSkillRuntimeError {
  return new NovelSkillRuntimeError("NOVEL_SKILL_COMPILE_FAILED", message);
}

function selectionViews(
  compiled: CompiledNovelSkills,
  definitions: readonly NovelSkillDefinition[],
): readonly NovelSkillSelectionView[] {
  const byKey = new Map(
    definitions.map((definition) => [`${definition.skillId}@${definition.version}`, definition]),
  );
  return Object.freeze(
    compiled.items.map((item) => {
      const definition = byKey.get(`${item.skillId}@${item.skillVersion}`);
      if (definition === undefined) {
        throw new NovelSkillRuntimeError(
          "NOVEL_SKILL_COMPILE_FAILED",
          "写作技能整理结果缺少对应的历史版本。",
        );
      }
      return selectionView(definition, item, compiled.instructionRules);
    }),
  );
}

function selectionView(
  definition: NovelSkillDefinition,
  item: Readonly<{
    included: boolean;
    selectionReason: NovelSkillSelectionReason;
    estimatedTokens: number;
  }>,
  writingRequirements?: CompiledNovelSkills["instructionRules"],
): NovelSkillSelectionView {
  return Object.freeze({
    displayName: definition.displayName,
    summary: definition.summary,
    version: definition.version,
    kind: definition.kind,
    ownerScope: definition.ownerScope,
    included: item.included,
    selectionReason: item.selectionReason,
    estimatedTokens: item.estimatedTokens,
    ...(writingRequirements === undefined
      ? {}
      : {
          writingRequirements: Object.freeze(
            writingRequirements
              .filter(
                ({ sourceSkillId, sourceSkillVersion }) =>
                  item.included &&
                  sourceSkillId === definition.skillId &&
                  sourceSkillVersion === definition.version,
              )
              .map(({ text }) => text),
          ),
        }),
  });
}

function notApplied(
  availability: NovelSkillRuntimeAvailability,
  reason: NovelSkillNotAppliedReason,
): PreparedNovelSkillInvocation {
  return Object.freeze({
    status: "not_applied",
    notAppliedReason: reason,
    availability,
    maximumSkillTokens: 0,
    usedSkillTokens: 0,
    promptSection: null,
    methods: Object.freeze([]),
    compiled: null,
  });
}
