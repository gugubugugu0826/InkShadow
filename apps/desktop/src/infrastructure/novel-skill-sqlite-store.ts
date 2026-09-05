import {
  canonicalNovelSkillDefinition,
  compileFixedNovelSkillEvaluationArm,
  compileNovelSkills,
  hashNovelSkillConfiguration,
  isFixedNovelSkillEvaluationConfiguration,
  renderNovelSkillPromptSection,
  validateNovelSkillConfigurationSnapshot,
  validateNovelSkillDefinition,
  validateNovelSkillInvocationItem,
  validateProjectNovelSkillBinding,
  verifyNovelSkillDefinition,
  type CompiledNovelSkills,
  type NovelSkillConfigurationSnapshot,
  type NovelSkillDefinition,
  type NovelSkillInvocationItem,
  type NovelSkillInvocationMode,
  type NovelSkillTask,
  type ProjectNovelSkillBinding,
} from "@inkshadow/ai-core";

import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

export interface NovelSkillInvocationSnapshotRecord {
  /** Derived by verified replay, not a new database field or an output-quality claim. */
  readonly writingRequirements?: CompiledNovelSkills["instructionRules"];
  readonly id: string;
  readonly projectId: string;
  readonly contextTraceId: string;
  readonly modelInvocationId: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly compilerVersion: string;
  readonly maximumSkillTokens: number;
  readonly usedSkillTokens: number;
  readonly discardedSkillTokens: number;
  readonly selectionHash: string;
  readonly configuration: NovelSkillConfigurationSnapshot;
  readonly items: readonly NovelSkillInvocationItem[];
  readonly createdAt: string;
}

export interface IsolatedNovelSkillDefinitionRecord {
  readonly recordNumber: number;
  readonly reason: "用户技能记录已损坏";
}

export interface NovelSkillDefinitionReadResult {
  readonly definitions: readonly NovelSkillDefinition[];
  readonly isolatedRecords: readonly IsolatedNovelSkillDefinitionRecord[];
}

export interface CommitNovelSkillInvocationInput {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly contextTraceId: string;
  readonly modelInvocationId: string;
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly compiled: CompiledNovelSkills;
  readonly createdAt: string;
}

export interface NovelSkillDefinitionBindingCommitResult {
  readonly definition: NovelSkillDefinition;
  readonly binding: ProjectNovelSkillBinding;
}

export type NovelSkillStoreErrorCode =
  | "NOVEL_SKILL_STORE_INVALID"
  | "NOVEL_SKILL_STORE_CORRUPT"
  | "NOVEL_SKILL_DEFINITION_CONFLICT"
  | "NOVEL_SKILL_BINDING_CONFLICT"
  | "NOVEL_SKILL_TRACE_LINK_MISSING"
  | "NOVEL_SKILL_SNAPSHOT_CONFLICT";

export class NovelSkillStoreError extends Error {
  public constructor(
    readonly code: NovelSkillStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NovelSkillStoreError";
  }
}

interface DefinitionRow {
  readonly skill_id: string;
  readonly version: string;
  readonly display_name: string;
  readonly summary: string;
  readonly kind: NovelSkillDefinition["kind"];
  readonly owner_scope: NovelSkillDefinition["ownerScope"];
  readonly status: NovelSkillDefinition["status"];
  readonly default_enabled: number;
  readonly precedence: number;
  readonly task_types_json: string;
  readonly activation_json: string;
  readonly context_requirements_json: string;
  readonly instructions_json: string;
  readonly output_contract_json: string;
  readonly validation_json: string;
  readonly definition_hash: string;
  readonly provenance_url: string | null;
  readonly provenance_commit: string | null;
  readonly provenance_license: string | null;
  readonly created_at: string;
}

interface BindingRow {
  readonly project_id: string;
  readonly skill_id: string;
  readonly pinned_version: string;
  readonly enabled: number;
  readonly activation_mode: ProjectNovelSkillBinding["activationMode"];
  readonly task_overrides_json: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SnapshotRow {
  readonly id: string;
  readonly project_id: string;
  readonly context_trace_id: string;
  readonly model_invocation_id: string;
  readonly task_type: NovelSkillTask;
  readonly invocation_mode: NovelSkillInvocationMode;
  readonly compiler_version: string;
  readonly maximum_skill_tokens: number;
  readonly used_skill_tokens: number;
  readonly discarded_skill_tokens: number;
  readonly candidate_count: number;
  readonly included_count: number;
  readonly discarded_count: number;
  readonly selection_hash: string;
  readonly configuration_snapshot_json: string;
  readonly created_at: string;
}

interface ItemRow {
  readonly snapshot_id: string;
  readonly item_order: number;
  readonly skill_id: string;
  readonly skill_version: string;
  readonly definition_hash: string;
  readonly activation_source: NovelSkillInvocationItem["activationSource"];
  readonly selection_reason: NovelSkillInvocationItem["selectionReason"];
  readonly precedence: number;
  readonly included: number;
  readonly discarded_reason: NovelSkillInvocationItem["discardedReason"];
  readonly estimated_tokens: number;
}

/** SQLite authority for immutable methods, project bindings and pre-dispatch receipts. */
export class NovelSkillSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async insertDefinition(value: NovelSkillDefinition): Promise<NovelSkillDefinition> {
    try {
      const definition = await verifyNovelSkillDefinition(value);
      return await insertDefinitionRecord(this.executor, definition);
    } catch (error: unknown) {
      throw normalizeStoreError(
        error,
        "NOVEL_SKILL_STORE_INVALID",
        "Novel skill definition input was rejected.",
      );
    }
  }

  public async findDefinition(
    skillId: string,
    version: string,
  ): Promise<NovelSkillDefinition | null> {
    requireSkillReference(skillId, version);
    try {
      const rows = await this.executor.select<DefinitionRow>(
        `${DEFINITION_SELECT} WHERE skill_id = ? AND version = ?`,
        [skillId, version],
      );
      return rows[0] === undefined ? null : await hydrateDefinition(rows[0]);
    } catch (error: unknown) {
      throw normalizeStoreError(
        error,
        "NOVEL_SKILL_STORE_CORRUPT",
        "Novel skill definition lookup failed.",
      );
    }
  }

  public async listDefinitions(): Promise<readonly NovelSkillDefinition[]> {
    try {
      const rows = await this.executor.select<DefinitionRow>(
        `${DEFINITION_SELECT} ORDER BY skill_id, version`,
      );
      return await Promise.all(rows.map(hydrateDefinition));
    } catch (error: unknown) {
      throw normalizeStoreError(
        error,
        "NOVEL_SKILL_STORE_CORRUPT",
        "Stored novel skill definitions could not be read.",
      );
    }
  }

  public async listDefinitionsWithIsolation(): Promise<NovelSkillDefinitionReadResult> {
    try {
      const rows = await this.executor.select<DefinitionRow>(
        `${DEFINITION_SELECT} ORDER BY skill_id, version`,
      );
      const definitions: NovelSkillDefinition[] = [];
      const isolatedRecords: IsolatedNovelSkillDefinitionRecord[] = [];
      for (const [index, row] of rows.entries()) {
        try {
          definitions.push(await hydrateDefinition(row));
        } catch (error: unknown) {
          if (row.owner_scope !== "user" || row.kind !== "custom") throw error;
          isolatedRecords.push(
            Object.freeze({
              recordNumber: index + 1,
              reason: "用户技能记录已损坏" as const,
            }),
          );
          globalThis.console.error(
            "[NOVEL_SKILL_CUSTOM_RECORD_ISOLATED] One user skill record was excluded from compilation.",
            { recordNumber: index + 1 },
          );
        }
      }
      return Object.freeze({
        definitions: Object.freeze(definitions),
        isolatedRecords: Object.freeze(isolatedRecords),
      });
    } catch (error: unknown) {
      throw normalizeStoreError(
        error,
        "NOVEL_SKILL_STORE_CORRUPT",
        "Stored novel skill definitions could not be read safely.",
      );
    }
  }

  public async saveBinding(
    value: ProjectNovelSkillBinding,
    expectedRevision: number,
  ): Promise<ProjectNovelSkillBinding> {
    try {
      const binding = validateProjectNovelSkillBinding(value);
      validateBindingWrite(binding, expectedRevision);
      return await this.executor.transaction(async (transaction) =>
        saveBindingRecord(transaction, binding, expectedRevision),
      );
    } catch (error: unknown) {
      throw normalizeStoreError(
        error,
        "NOVEL_SKILL_STORE_INVALID",
        "Novel skill binding input was rejected.",
      );
    }
  }

  public async createDefinitionWithBinding(
    definitionValue: NovelSkillDefinition,
    bindingValue: ProjectNovelSkillBinding,
  ): Promise<NovelSkillDefinitionBindingCommitResult> {
    return await this.commitCustomDefinitionAndBinding(definitionValue, bindingValue, 0, true);
  }

  public async createVersionAndRepinBinding(
    definitionValue: NovelSkillDefinition,
    bindingValue: ProjectNovelSkillBinding,
    expectedRevision: number,
  ): Promise<NovelSkillDefinitionBindingCommitResult> {
    if (expectedRevision < 1) {
      throw storeError(
        "NOVEL_SKILL_BINDING_CONFLICT",
        "An existing project binding is required before creating a new custom version.",
      );
    }
    return await this.commitCustomDefinitionAndBinding(
      definitionValue,
      bindingValue,
      expectedRevision,
      false,
    );
  }

  public async listBindings(projectId: string): Promise<readonly ProjectNovelSkillBinding[]> {
    requireUuidV7(projectId, "projectId");
    try {
      const rows = await this.executor.select<BindingRow>(
        `${BINDING_SELECT} WHERE project_id = ? ORDER BY skill_id`,
        [projectId],
      );
      return rows.map(hydrateBinding);
    } catch (error: unknown) {
      throw normalizeStoreError(
        error,
        "NOVEL_SKILL_STORE_CORRUPT",
        "Stored novel skill bindings could not be read.",
      );
    }
  }

  private async commitCustomDefinitionAndBinding(
    definitionValue: NovelSkillDefinition,
    bindingValue: ProjectNovelSkillBinding,
    expectedRevision: number,
    creatingBinding: boolean,
  ): Promise<NovelSkillDefinitionBindingCommitResult> {
    try {
      const definition = await verifyNovelSkillDefinition(definitionValue);
      const binding = validateProjectNovelSkillBinding(bindingValue);
      validateBindingWrite(binding, expectedRevision);
      requireCustomDefinitionBinding(definition, binding);
      if (creatingBinding !== (expectedRevision === 0 && binding.revision === 1)) {
        throw storeError(
          "NOVEL_SKILL_BINDING_CONFLICT",
          "Custom definition and project binding revisions do not describe one mutation.",
        );
      }
      return await this.executor.transaction(async (transaction) => {
        const savedDefinition = await insertDefinitionRecord(transaction, definition);
        const savedBinding = await saveBindingRecord(transaction, binding, expectedRevision);
        return Object.freeze({ definition: savedDefinition, binding: savedBinding });
      });
    } catch (error: unknown) {
      throw normalizeStoreError(
        error,
        "NOVEL_SKILL_STORE_INVALID",
        "Custom novel skill definition and project binding were not saved.",
      );
    }
  }

  public async commitInvocationBeforeDispatch(
    input: CommitNovelSkillInvocationInput,
  ): Promise<NovelSkillInvocationSnapshotRecord> {
    await validateInvocationCommit(input);
    try {
      return await this.executor.transaction(async (transaction) => {
        await requireExactInvocationChain(transaction, input);
        const replayed = await replayCompiledConfiguration(
          transaction,
          input.projectId,
          input.compiled.configuration,
          input.createdAt,
          "persisted_bindings",
        );
        assertCompiledReplayMatches(input.compiled, replayed);
        const existing = await transaction.select<{ readonly id: string }>(
          `SELECT id FROM novel_skill_invocation_snapshots
           WHERE id = ? OR context_trace_id = ? OR model_invocation_id = ?`,
          [input.snapshotId, input.contextTraceId, input.modelInvocationId],
        );
        if (existing.length > 0) {
          throw storeError(
            "NOVEL_SKILL_SNAPSHOT_CONFLICT",
            "This context trace or model invocation already has a novel skill snapshot.",
          );
        }
        const items = replayed.items;
        const includedCount = items.filter(({ included }) => included).length;
        await transaction.execute(
          `INSERT INTO novel_skill_invocation_snapshots (
             id, project_id, context_trace_id, model_invocation_id, task_type,
             invocation_mode, compiler_version, maximum_skill_tokens,
             used_skill_tokens, discarded_skill_tokens, candidate_count,
             included_count, discarded_count, selection_hash,
             configuration_snapshot_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.snapshotId,
            input.projectId,
            input.contextTraceId,
            input.modelInvocationId,
            input.taskType,
            input.invocationMode,
            replayed.compilerVersion,
            replayed.configuration.maximumSkillTokens,
            replayed.usedSkillTokens,
            replayed.discardedSkillTokens,
            items.length,
            includedCount,
            items.length - includedCount,
            replayed.selectionHash,
            JSON.stringify(replayed.configuration),
            input.createdAt,
          ],
        );
        for (const [index, item] of items.entries()) {
          await transaction.execute(
            `INSERT INTO novel_skill_invocation_items (
               snapshot_id, item_order, skill_id, skill_version, definition_hash,
               activation_source, selection_reason, precedence, included,
               discarded_reason, estimated_tokens
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              input.snapshotId,
              index + 1,
              item.skillId,
              item.skillVersion,
              item.definitionHash,
              item.activationSource,
              item.selectionReason,
              item.precedence,
              item.included ? 1 : 0,
              item.discardedReason,
              item.estimatedTokens,
            ],
          );
        }
        const saved = await readSnapshot(transaction, input.snapshotId);
        if (saved?.items.length !== items.length) {
          throw storeError(
            "NOVEL_SKILL_STORE_CORRUPT",
            "Novel skill invocation snapshot did not settle atomically.",
          );
        }
        return saved;
      });
    } catch (error: unknown) {
      if (error instanceof NovelSkillStoreError) {
        throw error;
      }
      if (isExactChainConstraint(error)) {
        throw storeError(
          "NOVEL_SKILL_TRACE_LINK_MISSING",
          "Novel skill invocation lost its exact context chain before provider dispatch.",
          error,
        );
      }
      throw storeError(
        "NOVEL_SKILL_STORE_INVALID",
        "Novel skill invocation snapshot was rejected before provider dispatch.",
        error,
      );
    }
  }

  public async snapshotThenDispatch<Value>(
    input: CommitNovelSkillInvocationInput,
    dispatch: (snapshot: NovelSkillInvocationSnapshotRecord) => Promise<Value>,
  ): Promise<Value> {
    const snapshot = await this.commitInvocationBeforeDispatch(input);
    return dispatch(snapshot);
  }

  public async findInvocationSnapshot(
    snapshotId: string,
  ): Promise<NovelSkillInvocationSnapshotRecord | null> {
    requireUuidV7(snapshotId, "snapshotId");
    return readSnapshot(this.executor, snapshotId);
  }

  public async findInvocationSnapshotByContextTrace(
    contextTraceId: string,
  ): Promise<NovelSkillInvocationSnapshotRecord | null> {
    requireBoundedReference(contextTraceId, "contextTraceId");
    try {
      const rows = await this.executor.select<{ readonly id: string }>(
        "SELECT id FROM novel_skill_invocation_snapshots WHERE context_trace_id = ?",
        [contextTraceId],
      );
      const snapshotId = rows[0]?.id;
      if (snapshotId === undefined) {
        return null;
      }
      if (rows.length !== 1) {
        throw storeError(
          "NOVEL_SKILL_STORE_CORRUPT",
          "A context trace resolves to more than one novel skill snapshot.",
        );
      }
      return await readSnapshot(this.executor, snapshotId);
    } catch (error: unknown) {
      if (error instanceof NovelSkillStoreError) {
        throw error;
      }
      throw storeError(
        "NOVEL_SKILL_STORE_CORRUPT",
        "Novel skill snapshot lookup by context trace failed.",
        error,
      );
    }
  }
}

async function validateInvocationCommit(input: CommitNovelSkillInvocationInput): Promise<void> {
  try {
    requireUuidV7(input.snapshotId, "snapshotId");
    requireUuidV7(input.projectId, "projectId");
    requireIsoUtc(input.createdAt, "createdAt");
    const configuration = validateNovelSkillConfigurationSnapshot(input.compiled.configuration);
    if (
      configuration.taskType !== input.taskType ||
      configuration.invocationMode !== input.invocationMode ||
      configuration.compilerVersion !== input.compiled.compilerVersion ||
      input.compiled.selectionHash !== (await hashNovelSkillConfiguration(configuration))
    ) {
      throw storeError(
        "NOVEL_SKILL_STORE_INVALID",
        "Compiled novel skill selection does not match its replayable configuration.",
      );
    }
    if (input.compiled.items.length > 64) {
      throw storeError("NOVEL_SKILL_STORE_INVALID", "Novel skill invocation has too many items.");
    }
    const itemKeys = new Set<string>();
    let discarded = 0;
    for (const itemValue of input.compiled.items) {
      const item = validateNovelSkillInvocationItem(itemValue);
      if (itemKeys.has(item.skillId)) {
        throw storeError(
          "NOVEL_SKILL_STORE_INVALID",
          "Novel skill invocation items must be unique.",
        );
      }
      itemKeys.add(item.skillId);
      if (!item.included) {
        discarded += item.estimatedTokens;
      }
    }
    const used = estimateCompiledPromptTokens(input.compiled);
    if (
      used !== input.compiled.usedSkillTokens ||
      discarded !== input.compiled.discardedSkillTokens ||
      used > configuration.maximumSkillTokens
    ) {
      throw storeError(
        "NOVEL_SKILL_STORE_INVALID",
        `Novel skill invocation token accounting is invalid (rendered=${String(used)}, supplied=${String(input.compiled.usedSkillTokens)}, discarded=${String(discarded)}, suppliedDiscarded=${String(input.compiled.discardedSkillTokens)}).`,
      );
    }
    const considered = new Set(
      configuration.consideredDefinitions.map(
        ({ skillId, version, definitionHash }) => `${skillId}@${version}#${definitionHash}`,
      ),
    );
    if (
      input.compiled.items.some(
        ({ skillId, skillVersion, definitionHash }) =>
          !considered.has(`${skillId}@${skillVersion}#${definitionHash}`),
      )
    ) {
      throw storeError(
        "NOVEL_SKILL_STORE_INVALID",
        "Invocation item is absent from the replayable definition references.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof NovelSkillStoreError) {
      throw error;
    }
    throw storeError(
      "NOVEL_SKILL_STORE_INVALID",
      "Novel skill invocation input failed validation.",
      error,
    );
  }
}

async function requireExactInvocationChain(
  transaction: TransactionExecutor,
  input: CommitNovelSkillInvocationInput,
): Promise<void> {
  const rows = await transaction.select<{ readonly valid: number }>(
    `SELECT 1 AS valid
     FROM context_compilation_runs AS trace
     INNER JOIN context_compilation_execution_links AS execution
       ON execution.trace_id = trace.id
     INNER JOIN context_compilation_model_invocation_links AS model_link
       ON model_link.trace_id = trace.id
     INNER JOIN model_invocation_facts AS invocation
       ON invocation.id = model_link.model_invocation_id
     WHERE trace.id = ?
       AND trace.project_id = ?
       AND trace.task_type = ?
       AND invocation.id = ?
       AND invocation.task = ?`,
    [
      input.contextTraceId,
      input.projectId,
      input.taskType,
      input.modelInvocationId,
      input.taskType,
    ],
  );
  if (rows.length !== 1) {
    throw storeError(
      "NOVEL_SKILL_TRACE_LINK_MISSING",
      "Novel skill dispatch requires the exact context trace and model invocation linkage.",
    );
  }
}

type ReplayBindingSource = "persisted_bindings" | "snapshot_bindings";

async function replayCompiledConfiguration(
  executor: TransactionExecutor,
  projectId: string,
  configuration: NovelSkillConfigurationSnapshot,
  createdAt: string,
  bindingSource: ReplayBindingSource,
): Promise<CompiledNovelSkills> {
  const definitions = await loadReplayDefinitions(executor, configuration, bindingSource);
  const bindings =
    bindingSource === "persisted_bindings"
      ? await loadPersistedReplayBindings(executor, projectId, configuration)
      : buildSnapshotReplayBindings(projectId, configuration, createdAt);
  const replayInput = {
    projectId,
    taskType: configuration.taskType,
    invocationMode: configuration.invocationMode,
    maximumSkillTokens: configuration.maximumSkillTokens,
    genreTags: configuration.genreTags,
    explicitSkillIds: configuration.explicitSkillIds,
    availableContextLayers: configuration.availableContextLayers,
    allowExperimental: configuration.experimentalAllowed,
    definitions,
    bindings,
  };
  return isFixedNovelSkillEvaluationConfiguration(configuration)
    ? compileFixedNovelSkillEvaluationArm(replayInput)
    : compileNovelSkills(replayInput);
}

async function loadReplayDefinitions(
  executor: TransactionExecutor,
  configuration: NovelSkillConfigurationSnapshot,
  source: ReplayBindingSource,
): Promise<readonly NovelSkillDefinition[]> {
  const mismatchCode: NovelSkillStoreErrorCode =
    source === "persisted_bindings" ? "NOVEL_SKILL_STORE_INVALID" : "NOVEL_SKILL_STORE_CORRUPT";
  const definitions: NovelSkillDefinition[] = [];
  for (const reference of configuration.consideredDefinitions) {
    const rows = await executor.select<DefinitionRow>(
      `${DEFINITION_SELECT} WHERE skill_id = ? AND version = ?`,
      [reference.skillId, reference.version],
    );
    const row = rows[0];
    if (row === undefined || rows.length !== 1) {
      throw storeError(mismatchCode, "A replayable novel skill definition is missing.");
    }
    const definition = await hydrateDefinition(row);
    if (
      definition.definitionHash !== reference.definitionHash ||
      definition.kind !== reference.kind ||
      definition.status !== reference.status
    ) {
      throw storeError(
        mismatchCode,
        "A replayable novel skill definition no longer matches its immutable reference.",
      );
    }
    definitions.push(definition);
  }
  return definitions;
}

async function loadPersistedReplayBindings(
  executor: TransactionExecutor,
  projectId: string,
  configuration: NovelSkillConfigurationSnapshot,
): Promise<readonly ProjectNovelSkillBinding[]> {
  const rows = await executor.select<BindingRow>(
    `${BINDING_SELECT} WHERE project_id = ? ORDER BY skill_id`,
    [projectId],
  );
  const bindings = rows.map(hydrateBinding);
  const expected = configuration.bindings.map((binding) => replayBindingProjection(binding));
  const actual = bindings.map((binding) =>
    replayBindingProjection({
      skillId: binding.skillId,
      version: binding.pinnedVersion,
      enabled: binding.enabled,
      activationMode: binding.activationMode,
      taskEnabled: binding.taskOverrides[configuration.taskType]?.enabled ?? null,
      taskInvocationMode: binding.taskOverrides[configuration.taskType]?.invocationMode ?? null,
      revision: binding.revision,
    }),
  );
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw storeError(
      "NOVEL_SKILL_STORE_INVALID",
      "Novel skill receipt bindings changed before the pre-dispatch snapshot settled.",
    );
  }
  return bindings;
}

function buildSnapshotReplayBindings(
  projectId: string,
  configuration: NovelSkillConfigurationSnapshot,
  createdAt: string,
): readonly ProjectNovelSkillBinding[] {
  return configuration.bindings.map((binding) => {
    const hasTaskOverride = binding.taskEnabled !== null || binding.taskInvocationMode !== null;
    const taskOverrides: ProjectNovelSkillBinding["taskOverrides"] = hasTaskOverride
      ? {
          [configuration.taskType]: {
            enabled: binding.taskEnabled,
            invocationMode: binding.taskInvocationMode,
          },
        }
      : {};
    return validateProjectNovelSkillBinding({
      projectId,
      skillId: binding.skillId,
      pinnedVersion: binding.version,
      enabled: binding.enabled,
      activationMode: binding.activationMode,
      taskOverrides,
      revision: binding.revision,
      createdAt,
      updatedAt: createdAt,
    });
  });
}

function replayBindingProjection(binding: {
  readonly skillId: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly activationMode: ProjectNovelSkillBinding["activationMode"];
  readonly taskEnabled: boolean | null;
  readonly taskInvocationMode: NovelSkillInvocationMode | null;
  readonly revision: number;
}): object {
  return {
    skillId: binding.skillId,
    version: binding.version,
    enabled: binding.enabled,
    activationMode: binding.activationMode,
    taskEnabled: binding.taskEnabled,
    taskInvocationMode: binding.taskInvocationMode,
    revision: binding.revision,
  };
}

function assertCompiledReplayMatches(
  supplied: CompiledNovelSkills,
  replayed: CompiledNovelSkills,
): void {
  if (
    canonicalJson(compiledReplayProjection(supplied)) !==
    canonicalJson(compiledReplayProjection(replayed))
  ) {
    throw storeError(
      "NOVEL_SKILL_STORE_INVALID",
      "Supplied novel skill compiler output does not match the transaction-local replay.",
    );
  }
}

function compiledReplayProjection(compiled: CompiledNovelSkills): object {
  return {
    compilerVersion: compiled.compilerVersion,
    configuration: compiled.configuration,
    selectionHash: compiled.selectionHash,
    items: compiled.items,
    selectedDefinitions: compiled.selectedDefinitions.map(
      ({ skillId, version, definitionHash }) => ({ skillId, version, definitionHash }),
    ),
    usedSkillTokens: compiled.usedSkillTokens,
    discardedSkillTokens: compiled.discardedSkillTokens,
    instructionRules: compiled.instructionRules,
    outputKinds: compiled.outputKinds,
    outputRules: compiled.outputRules,
    validationRules: compiled.validationRules,
    renderedSection: renderNovelSkillPromptSection(compiled),
  };
}

function estimateCompiledPromptTokens(compiled: CompiledNovelSkills): number {
  const rendered = renderNovelSkillPromptSection(compiled);
  return rendered === null ? 0 : new TextEncoder().encode(rendered).length;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readSnapshot(
  executor: TransactionExecutor,
  snapshotId: string,
): Promise<NovelSkillInvocationSnapshotRecord | null> {
  try {
    const rows = await executor.select<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE id = ?`, [
      snapshotId,
    ]);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const itemRows = await executor.select<ItemRow>(
      `${ITEM_SELECT} WHERE snapshot_id = ? ORDER BY item_order`,
      [snapshotId],
    );
    const configuration = parseJson(
      row.configuration_snapshot_json,
      "invocation configuration",
    ) as NovelSkillConfigurationSnapshot;
    validateNovelSkillConfigurationSnapshot(configuration);
    const items = itemRows.map(hydrateItem);
    const includedCount = items.filter(({ included }) => included).length;
    const expectedSelectionHash = await hashNovelSkillConfiguration(configuration);
    const replayed = await replayCompiledConfiguration(
      executor,
      row.project_id,
      configuration,
      row.created_at,
      "snapshot_bindings",
    );
    if (
      row.candidate_count !== items.length ||
      row.included_count !== includedCount ||
      row.discarded_count !== items.length - includedCount ||
      row.selection_hash !== expectedSelectionHash ||
      row.selection_hash !== replayed.selectionHash ||
      row.compiler_version !== configuration.compilerVersion ||
      row.task_type !== configuration.taskType ||
      row.invocation_mode !== configuration.invocationMode ||
      row.maximum_skill_tokens !== configuration.maximumSkillTokens ||
      row.used_skill_tokens !== replayed.usedSkillTokens ||
      row.discarded_skill_tokens !== replayed.discardedSkillTokens ||
      canonicalJson(items) !== canonicalJson(replayed.items)
    ) {
      throw storeError(
        "NOVEL_SKILL_STORE_CORRUPT",
        "Novel skill snapshot aggregate is inconsistent.",
      );
    }
    return Object.freeze({
      id: row.id,
      projectId: row.project_id,
      contextTraceId: row.context_trace_id,
      modelInvocationId: row.model_invocation_id,
      taskType: row.task_type,
      invocationMode: row.invocation_mode,
      compilerVersion: row.compiler_version,
      maximumSkillTokens: row.maximum_skill_tokens,
      usedSkillTokens: row.used_skill_tokens,
      discardedSkillTokens: row.discarded_skill_tokens,
      selectionHash: row.selection_hash,
      configuration,
      items: Object.freeze(items),
      writingRequirements: replayed.instructionRules,
      createdAt: row.created_at,
    });
  } catch (error: unknown) {
    if (error instanceof NovelSkillStoreError && error.code === "NOVEL_SKILL_STORE_CORRUPT") {
      throw error;
    }
    throw storeError(
      "NOVEL_SKILL_STORE_CORRUPT",
      "Stored novel skill invocation snapshot is invalid.",
      error,
    );
  }
}

async function hydrateDefinition(row: DefinitionRow): Promise<NovelSkillDefinition> {
  try {
    const definition: NovelSkillDefinition = {
      skillId: row.skill_id,
      version: row.version,
      displayName: row.display_name,
      summary: row.summary,
      kind: row.kind,
      ownerScope: row.owner_scope,
      status: row.status,
      defaultEnabled: row.default_enabled === 1,
      precedence: row.precedence,
      taskTypes: parseJson(row.task_types_json, "task types") as NovelSkillDefinition["taskTypes"],
      activation: parseJson(
        row.activation_json,
        "activation",
      ) as NovelSkillDefinition["activation"],
      contextRequirements: parseJson(
        row.context_requirements_json,
        "context requirements",
      ) as NovelSkillDefinition["contextRequirements"],
      instructions: parseJson(
        row.instructions_json,
        "instructions",
      ) as NovelSkillDefinition["instructions"],
      outputContract: parseJson(
        row.output_contract_json,
        "output contract",
      ) as NovelSkillDefinition["outputContract"],
      validation: parseJson(
        row.validation_json,
        "validation",
      ) as NovelSkillDefinition["validation"],
      definitionHash: row.definition_hash,
      provenance: {
        url: row.provenance_url,
        commit: row.provenance_commit,
        license: row.provenance_license,
      },
      createdAt: row.created_at,
    };
    validateNovelSkillDefinition(definition);
    if (canonicalNovelSkillDefinition(definition).length > 200_000) {
      throw new Error("definition exceeds canonical bound");
    }
    return await verifyNovelSkillDefinition(definition);
  } catch (error: unknown) {
    throw storeError(
      "NOVEL_SKILL_STORE_CORRUPT",
      "Stored novel skill definition is invalid.",
      error,
    );
  }
}

function hydrateBinding(row: BindingRow): ProjectNovelSkillBinding {
  try {
    return validateProjectNovelSkillBinding({
      projectId: row.project_id,
      skillId: row.skill_id,
      pinnedVersion: row.pinned_version,
      enabled: row.enabled === 1,
      activationMode: row.activation_mode,
      taskOverrides: parseJson(
        row.task_overrides_json,
        "task overrides",
      ) as ProjectNovelSkillBinding["taskOverrides"],
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (error: unknown) {
    throw storeError("NOVEL_SKILL_STORE_CORRUPT", "Stored novel skill binding is invalid.", error);
  }
}

function hydrateItem(row: ItemRow): NovelSkillInvocationItem {
  try {
    return validateNovelSkillInvocationItem({
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      definitionHash: row.definition_hash,
      activationSource: row.activation_source,
      selectionReason: row.selection_reason,
      precedence: row.precedence,
      included: row.included === 1,
      discardedReason: row.discarded_reason,
      estimatedTokens: row.estimated_tokens,
    });
  } catch (error: unknown) {
    throw storeError(
      "NOVEL_SKILL_STORE_CORRUPT",
      "Stored novel skill invocation item is invalid.",
      error,
    );
  }
}

async function insertDefinitionRecord(
  executor: TransactionExecutor,
  definition: NovelSkillDefinition,
): Promise<NovelSkillDefinition> {
  await executor.execute(
    `INSERT OR IGNORE INTO novel_skill_definitions (
       skill_id, version, display_name, summary, kind, owner_scope, status,
       default_enabled, precedence, task_types_json, activation_json,
       context_requirements_json, instructions_json, output_contract_json,
       validation_json, definition_hash, provenance_url, provenance_commit,
       provenance_license, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    definitionBindings(definition),
  );
  const rows = await executor.select<DefinitionRow>(
    `${DEFINITION_SELECT} WHERE skill_id = ? AND version = ?`,
    [definition.skillId, definition.version],
  );
  const stored = rows[0] === undefined ? null : await hydrateDefinition(rows[0]);
  if (stored?.definitionHash !== definition.definitionHash) {
    throw storeError(
      "NOVEL_SKILL_DEFINITION_CONFLICT",
      "An immutable novel skill version already exists with different content.",
    );
  }
  return stored;
}

function validateBindingWrite(binding: ProjectNovelSkillBinding, expectedRevision: number): void {
  requireUuidV7(binding.projectId, "projectId");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw storeError("NOVEL_SKILL_STORE_INVALID", "Expected binding revision is invalid.");
  }
}

function requireCustomDefinitionBinding(
  definition: NovelSkillDefinition,
  binding: ProjectNovelSkillBinding,
): void {
  if (definition.ownerScope !== "user" || definition.kind !== "custom") {
    throw storeError(
      "NOVEL_SKILL_STORE_INVALID",
      "Only a user-owned custom definition can use the custom atomic mutation path.",
    );
  }
  if (binding.skillId !== definition.skillId || binding.pinnedVersion !== definition.version) {
    throw storeError(
      "NOVEL_SKILL_STORE_INVALID",
      "The project binding must pin the exact custom definition being committed.",
    );
  }
}

async function saveBindingRecord(
  executor: TransactionExecutor,
  binding: ProjectNovelSkillBinding,
  expectedRevision: number,
): Promise<ProjectNovelSkillBinding> {
  const projectRows = await executor.select<{ readonly status: string }>(
    "SELECT status FROM projects WHERE id = ?",
    [binding.projectId],
  );
  if (projectRows[0]?.status !== "active") {
    throw storeError(
      "NOVEL_SKILL_STORE_INVALID",
      "Novel skill bindings can only be saved for an active project.",
    );
  }
  const existingRows = await executor.select<BindingRow>(
    `${BINDING_SELECT} WHERE project_id = ? AND skill_id = ?`,
    [binding.projectId, binding.skillId],
  );
  const existing = existingRows[0];
  if (existing === undefined) {
    if (expectedRevision !== 0 || binding.revision !== 1) {
      throw storeError(
        "NOVEL_SKILL_BINDING_CONFLICT",
        "Novel skill binding creation revision does not match.",
      );
    }
    await executor.execute(
      `INSERT INTO project_novel_skill_bindings (
         project_id, skill_id, pinned_version, enabled, activation_mode,
         task_overrides_json, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bindingBindings(binding),
    );
  } else {
    const stored = hydrateBinding(existing);
    if (
      stored.revision !== expectedRevision ||
      binding.revision !== expectedRevision + 1 ||
      binding.createdAt !== stored.createdAt
    ) {
      throw storeError(
        "NOVEL_SKILL_BINDING_CONFLICT",
        "Novel skill binding was changed by another revision.",
      );
    }
    const result = await executor.execute(
      `UPDATE project_novel_skill_bindings
       SET pinned_version = ?, enabled = ?, activation_mode = ?,
           task_overrides_json = ?, revision = ?, updated_at = ?
       WHERE project_id = ? AND skill_id = ? AND revision = ?`,
      [
        binding.pinnedVersion,
        binding.enabled ? 1 : 0,
        binding.activationMode,
        JSON.stringify(binding.taskOverrides),
        binding.revision,
        binding.updatedAt,
        binding.projectId,
        binding.skillId,
        expectedRevision,
      ],
    );
    if (result.rowsAffected !== 1) {
      throw storeError(
        "NOVEL_SKILL_BINDING_CONFLICT",
        "Novel skill binding update lost its revision race.",
      );
    }
  }
  const saved = await executor.select<BindingRow>(
    `${BINDING_SELECT} WHERE project_id = ? AND skill_id = ?`,
    [binding.projectId, binding.skillId],
  );
  if (saved[0] === undefined) {
    throw storeError("NOVEL_SKILL_STORE_CORRUPT", "Saved novel skill binding is missing.");
  }
  return hydrateBinding(saved[0]);
}

function definitionBindings(definition: NovelSkillDefinition): readonly (string | number | null)[] {
  return [
    definition.skillId,
    definition.version,
    definition.displayName,
    definition.summary,
    definition.kind,
    definition.ownerScope,
    definition.status,
    definition.defaultEnabled ? 1 : 0,
    definition.precedence,
    JSON.stringify(definition.taskTypes),
    JSON.stringify(definition.activation),
    JSON.stringify(definition.contextRequirements),
    JSON.stringify(definition.instructions),
    JSON.stringify(definition.outputContract),
    JSON.stringify(definition.validation),
    definition.definitionHash,
    definition.provenance.url,
    definition.provenance.commit,
    definition.provenance.license,
    definition.createdAt,
  ];
}

function bindingBindings(binding: ProjectNovelSkillBinding): readonly (string | number)[] {
  return [
    binding.projectId,
    binding.skillId,
    binding.pinnedVersion,
    binding.enabled ? 1 : 0,
    binding.activationMode,
    JSON.stringify(binding.taskOverrides),
    binding.revision,
    binding.createdAt,
    binding.updatedAt,
  ];
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw storeError("NOVEL_SKILL_STORE_CORRUPT", `Stored ${field} JSON is invalid.`, error);
  }
}

function requireUuidV7(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw storeError("NOVEL_SKILL_STORE_INVALID", `${field} must be a lowercase UUIDv7.`);
  }
}

function requireBoundedReference(value: string, field: string): void {
  if (
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw storeError("NOVEL_SKILL_STORE_INVALID", `${field} is not a bounded reference.`);
  }
}

function requireIsoUtc(value: string, field: string): void {
  if (
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw storeError("NOVEL_SKILL_STORE_INVALID", `${field} must be an ISO UTC timestamp.`);
  }
}

function requireSkillReference(skillId: unknown, version: unknown): void {
  if (
    typeof skillId !== "string" ||
    !/^(?=.{3,96}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/u.test(skillId) ||
    typeof version !== "string" ||
    version.length > 32 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)
  ) {
    throw storeError(
      "NOVEL_SKILL_STORE_INVALID",
      "Novel skill lookup requires the canonical skill identifier and semantic version.",
    );
  }
}

function isExactChainConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /exact context and model invocation chain|exact context chain|context compilation invocation has no exact generation/iu.test(
      error.message,
    )
  );
}

function storeError(
  code: NovelSkillStoreErrorCode,
  message: string,
  cause?: unknown,
): NovelSkillStoreError {
  return new NovelSkillStoreError(code, message, cause === undefined ? undefined : { cause });
}

function normalizeStoreError(
  error: unknown,
  fallbackCode: NovelSkillStoreErrorCode,
  message: string,
): NovelSkillStoreError {
  return error instanceof NovelSkillStoreError ? error : storeError(fallbackCode, message, error);
}

const DEFINITION_SELECT = `SELECT
  skill_id, version, display_name, summary, kind, owner_scope, status,
  default_enabled, precedence, task_types_json, activation_json,
  context_requirements_json, instructions_json, output_contract_json,
  validation_json, definition_hash, provenance_url, provenance_commit,
  provenance_license, created_at
FROM novel_skill_definitions`;

const BINDING_SELECT = `SELECT
  project_id, skill_id, pinned_version, enabled, activation_mode,
  task_overrides_json, revision, created_at, updated_at
FROM project_novel_skill_bindings`;

const SNAPSHOT_SELECT = `SELECT
  id, project_id, context_trace_id, model_invocation_id, task_type,
  invocation_mode, compiler_version, maximum_skill_tokens, used_skill_tokens,
  discarded_skill_tokens, candidate_count, included_count, discarded_count,
  selection_hash, configuration_snapshot_json, created_at
FROM novel_skill_invocation_snapshots`;

const ITEM_SELECT = `SELECT
  snapshot_id, item_order, skill_id, skill_version, definition_hash,
  activation_source, selection_reason, precedence, included,
  discarded_reason, estimated_tokens
FROM novel_skill_invocation_items`;
