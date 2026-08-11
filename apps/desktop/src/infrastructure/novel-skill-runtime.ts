import {
  compileNovelSkills,
  createCoreNovelSkillDefinitions,
  createGenreNovelSkillDefinitions,
  renderNovelSkillPromptSection,
  type CompiledNovelSkills,
  type NovelSkillContextLayer,
  type NovelSkillDefinition,
  type NovelSkillInvocationMode,
  type NovelSkillSelectionReason,
  type NovelSkillTask,
  type ProjectNovelSkillBinding,
} from "@inkshadow/ai-core";
import type { Clock } from "@inkshadow/domain";

import type {
  CommitNovelSkillInvocationInput,
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
  readonly status: NovelSkillDefinition["status"];
  readonly enabled: boolean;
  readonly appliesToContinuation: boolean;
}

export interface NovelSkillProjectState {
  readonly availability: NovelSkillRuntimeAvailability;
  readonly evaluationStatus: "not_evaluated";
  readonly methods: readonly NovelSkillProjectMethodView[];
}

export interface NovelSkillSelectionView {
  readonly displayName: string;
  readonly summary: string;
  readonly version: string;
  readonly kind: NovelSkillDefinition["kind"];
  readonly included: boolean;
  readonly selectionReason: NovelSkillSelectionReason;
  readonly estimatedTokens: number;
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
  getReservedTokens(input: {
    readonly projectId: string;
    readonly taskType: NovelSkillTask;
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
  listDefinitions(): Promise<readonly NovelSkillDefinition[]>;
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
  reason: "实验性写作方法尚未完成本次启动初始化。",
});
const BROWSER_UNAVAILABLE: NovelSkillRuntimeAvailability = Object.freeze({
  status: "unavailable",
  reason: "浏览器演示不会应用写作方法，也不会生成写作方法收据。请在桌面版中使用。",
});

export class TauriNovelSkillRuntime implements NovelSkillRuntimePort {
  private availability: NovelSkillRuntimeAvailability = INITIALIZING;

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
        reason: "实验性写作方法初始化失败；基础写作仍可使用，本次不会应用写作方法。",
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
      this.store.listDefinitions(),
      this.store.listBindings(projectId),
    ]);
    return projectState(READY, definitions, bindings);
  }

  public async setMethodEnabled(
    projectId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<NovelSkillProjectState> {
    this.assertReady();
    try {
      const [definitions, bindings] = await Promise.all([
        this.store.listDefinitions(),
        this.store.listBindings(projectId),
      ]);
      const currentDefinitions = resolveCurrentDefinitions(definitions, bindings);
      const definition = currentDefinitions.find((candidate) => candidate.skillId === skillId);
      if (definition === undefined) {
        throw new NovelSkillRuntimeError(
          "NOVEL_SKILL_METHOD_NOT_FOUND",
          "这项写作方法已不可用，请刷新后重试。",
        );
      }
      const existing = bindings.find((binding) => binding.skillId === skillId);
      if (existing?.enabled === enabled && existing.activationMode === "manual") {
        return projectState(READY, definitions, bindings);
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
        "写作方法设置没有保存。正文和已有版本均未改变，请刷新后重试。",
        { cause },
      );
    }
  }

  public async getReservedTokens(input: {
    readonly projectId: string;
    readonly taskType: NovelSkillTask;
  }): Promise<number> {
    if (this.availability.status !== "ready") return 0;
    const [definitions, bindings] = await Promise.all([
      this.store.listDefinitions(),
      this.store.listBindings(input.projectId),
    ]);
    const currentDefinitions = resolveCurrentDefinitions(definitions, bindings);
    const hasExplicitApplicableMethod = bindings.some(
      (binding) =>
        binding.enabled &&
        currentDefinitions.some(
          (definition) =>
            definition.skillId === binding.skillId && definition.taskTypes.includes(input.taskType),
        ),
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
        this.store.listDefinitions(),
        this.store.listBindings(input.projectId),
      ]);
      const currentDefinitions = resolveCurrentDefinitions(definitions, bindings);
      const enabledBindings = bindings.filter(({ enabled }) => enabled);
      const explicitSkillIds = enabledBindings.map(({ skillId }) => skillId);
      const selectedGenreTags = currentDefinitions
        .filter(({ skillId }) => explicitSkillIds.includes(skillId))
        .flatMap(({ activation }) => activation.genreTags);
      const compiled = await compileNovelSkills({
        projectId: input.projectId,
        taskType: input.taskType,
        invocationMode: input.invocationMode,
        maximumSkillTokens: input.maximumSkillTokens ?? DEFAULT_NOVEL_SKILL_TOKEN_BUDGET,
        genreTags: Object.freeze([...new Set([...(input.genreTags ?? []), ...selectedGenreTags])]),
        explicitSkillIds: Object.freeze(explicitSkillIds),
        availableContextLayers: input.availableContextLayers,
        allowExperimental: explicitSkillIds.length > 0,
        definitions,
        bindings,
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
        "实验性写作方法无法安全编译，因此本次没有调用 AI。请关闭相关方法或刷新后重试。",
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
        "写作方法设置在发送前发生变化，或无法建立完整收据；本次没有向 AI 发送正文。请重新检查后重试。",
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
        this.availability.reason ?? "实验性写作方法当前不可用。",
      );
    }
  }

  private async toInvocationView(
    snapshot: NovelSkillInvocationSnapshotRecord,
  ): Promise<NovelSkillInvocationView> {
    const definitions = await this.store.listDefinitions();
    const byKey = new Map(
      definitions.map((definition) => [`${definition.skillId}@${definition.version}`, definition]),
    );
    const methods = snapshot.items.map((item) => {
      const definition = byKey.get(`${item.skillId}@${item.skillVersion}`);
      if (definition === undefined) {
        throw new NovelSkillRuntimeError(
          "NOVEL_SKILL_RECEIPT_FAILED",
          "写作方法历史记录引用的版本已不可用。",
        );
      }
      return selectionView(definition, item);
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
        BROWSER_UNAVAILABLE.reason ?? "浏览器演示不支持写作方法。",
      ),
    );
  }

  public getReservedTokens(input: {
    readonly projectId: string;
    readonly taskType: NovelSkillTask;
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
): NovelSkillProjectState {
  const currentDefinitions = resolveCurrentDefinitions(definitions, bindings);
  const bindingBySkill = new Map(bindings.map((binding) => [binding.skillId, binding]));
  return Object.freeze({
    availability,
    evaluationStatus: "not_evaluated",
    methods: Object.freeze(
      currentDefinitions.map((definition) => ({
        skillId: definition.skillId,
        displayName: definition.displayName,
        summary: definition.summary,
        version: definition.version,
        kind: definition.kind,
        status: definition.status,
        enabled: bindingBySkill.get(definition.skillId)?.enabled ?? false,
        appliesToContinuation: definition.taskTypes.includes("continuation"),
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
          "写作方法编译结果缺少对应的不可变版本。",
        );
      }
      return selectionView(definition, item);
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
): NovelSkillSelectionView {
  return Object.freeze({
    displayName: definition.displayName,
    summary: definition.summary,
    version: definition.version,
    kind: definition.kind,
    included: item.included,
    selectionReason: item.selectionReason,
    estimatedTokens: item.estimatedTokens,
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
