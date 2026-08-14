import {
  NOVEL_SKILL_EVALUATION_ARMS,
  NOVEL_SKILL_EVALUATION_METRICS,
  NOVEL_SKILL_COMPILER_VERSION,
  createNovelSkillEvaluationExecutionPlan,
  evaluateNovelSkillAbEvidence,
  listNovelSkillEvaluationFixtures,
  type NovelSkillEvaluationArm,
  type NovelSkillEvaluationExecutionPlan,
  type NovelSkillEvaluationModelSlot,
  type NovelSkillEvaluationObservation,
  type NovelSkillEvaluationResult,
  type NovelSkillEvaluationStatus,
} from "@inkshadow/ai-core";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import {
  NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY,
  NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
} from "@inkshadow/domain";

const EVALUATION_INVALID_CODE = "NOVEL_SKILL_EVALUATION_INVALID";
const EVALUATION_CONFLICT_CODE = "NOVEL_SKILL_EVALUATION_CONFLICT";
const EVALUATION_EVIDENCE_CODE = "NOVEL_SKILL_EVALUATION_EVIDENCE";

export interface NovelSkillEvaluationManifestItem {
  readonly skillId: string;
  readonly version: string;
  readonly definitionHash: string;
  readonly kind: "core" | "genre";
}

export interface CreateNovelSkillEvaluationSuiteInput {
  readonly suiteId: string;
  /** Dedicated archived project used only for isolated evaluation traces/Candidates. */
  readonly evaluationProjectId: string;
  readonly plan: NovelSkillEvaluationExecutionPlan;
  readonly manifests: Readonly<{
    core: readonly NovelSkillEvaluationManifestItem[];
    coreGenre: readonly NovelSkillEvaluationManifestItem[];
    coreGenrePreferences: readonly NovelSkillEvaluationManifestItem[];
  }>;
  readonly preferenceConfigurationHash: string;
  readonly createdAt: string;
}

export interface NovelSkillEvaluationModelAssignment {
  readonly slotId: NovelSkillEvaluationModelSlot["slotId"];
  readonly modelIdentityHash: string;
  readonly modelArtifactHash: string;
}

export interface NovelSkillEvaluationModelIdentity {
  readonly catalogEntryId: string | null;
  readonly connectionId: string;
  readonly modelId: string;
  readonly providerKind: string;
}

export type NovelSkillEvaluationModelArtifactIdentity = Readonly<
  Pick<NovelSkillEvaluationModelIdentity, "modelId" | "providerKind">
>;

export interface NovelSkillEvaluationPreferenceEvidence {
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly contentHash: string;
}

export async function hashNovelSkillEvaluationModelIdentity(
  identity: NovelSkillEvaluationModelIdentity,
): Promise<string> {
  assertExactObjectKeys(
    identity,
    ["catalogEntryId", "connectionId", "modelId", "providerKind"],
    "model identity",
  );
  if (
    (identity.catalogEntryId !== null && !isPortableLocator(identity.catalogEntryId, 512)) ||
    !isPortableLocator(identity.connectionId, 128) ||
    !isPortableLocator(identity.modelId, 512) ||
    !isPortableLocator(identity.providerKind, 128)
  ) {
    throw storeError(
      EVALUATION_INVALID_CODE,
      "Model identity contains an invalid content-free locator.",
    );
  }
  return sha256Hex(canonicalJson(identity));
}

export async function hashNovelSkillEvaluationModelArtifact(
  identity: NovelSkillEvaluationModelArtifactIdentity,
): Promise<string> {
  assertExactObjectKeys(identity, ["modelId", "providerKind"], "model artifact identity");
  if (!isPortableLocator(identity.modelId, 512) || !isPortableLocator(identity.providerKind, 128)) {
    throw storeError(
      EVALUATION_INVALID_CODE,
      "Model artifact identity contains an invalid content-free locator.",
    );
  }
  return sha256Hex(canonicalJson(identity));
}

export async function hashNovelSkillEvaluationPreferenceConfiguration(
  evidenceValue: unknown,
): Promise<string> {
  if (!Array.isArray(evidenceValue) || evidenceValue.length < 1 || evidenceValue.length > 64) {
    throw storeError(
      EVALUATION_INVALID_CODE,
      "Preference evidence must contain between one and 64 content-free sources.",
    );
  }
  const evidence = evidenceValue.map((item: unknown) => {
    assertExactObjectKeys(
      item,
      ["sourceId", "sourceVersionId", "contentHash"],
      "preference evidence",
    );
    const sourceId = item.sourceId;
    const sourceVersionId = item.sourceVersionId;
    const contentHash = item.contentHash;
    if (
      !isPortableLocator(sourceId, 512) ||
      (sourceVersionId !== null && !isPortableLocator(sourceVersionId, 512)) ||
      !isHash(contentHash)
    ) {
      throw storeError(
        EVALUATION_INVALID_CODE,
        "Preference evidence contains an invalid locator or content hash.",
      );
    }
    return {
      sourceId,
      sourceVersionId,
      contentHash,
    } satisfies NovelSkillEvaluationPreferenceEvidence;
  });
  const ordered = evidence.sort((left, right) =>
    `${left.sourceId}/${left.sourceVersionId ?? ""}`.localeCompare(
      `${right.sourceId}/${right.sourceVersionId ?? ""}`,
      "en",
    ),
  );
  if (new Set(ordered.map(({ sourceId }) => sourceId)).size !== ordered.length) {
    throw storeError(
      EVALUATION_INVALID_CODE,
      "Preference evidence source identifiers must be unique.",
    );
  }
  return sha256Hex(canonicalJson(ordered));
}

export interface CreateNovelSkillEvaluationRunInput {
  readonly runId: string;
  readonly suiteId: string;
  readonly modelAssignments: readonly NovelSkillEvaluationModelAssignment[];
  readonly createdAt: string;
}

export interface RecordNovelSkillEvaluationObservationInput {
  readonly observationId: string;
  readonly runId: string;
  readonly cellId: string;
  readonly attemptId: string;
  readonly contextTraceId: string;
  readonly modelInvocationId: string;
  readonly outputCandidateId: string;
  readonly novelSkillSnapshotId: string | null;
  readonly preferenceConfigurationHash: string | null;
  readonly resultHash: string;
  readonly observation: NovelSkillEvaluationObservation;
  readonly reviewerId: string;
  readonly rubricVersion: "novel-skill-human-rubric@1";
  readonly scoredAt: string;
  readonly createdAt: string;
}

export type RecordNovelSkillEvaluationEvidenceInput = Omit<
  RecordNovelSkillEvaluationObservationInput,
  "observation" | "reviewerId" | "rubricVersion" | "scoredAt"
> &
  Readonly<{
    readonly observation: Omit<NovelSkillEvaluationObservation, "scores">;
  }>;

export interface RecordNovelSkillEvaluationScoresInput {
  readonly runId: string;
  readonly cellId: string;
  readonly observationId: string;
  readonly scores: NovelSkillEvaluationObservation["scores"];
  readonly reviewerId: string;
  readonly rubricVersion: "novel-skill-human-rubric@1";
  readonly scoredAt: string;
}

export interface RepairSettledNovelSkillEvaluationObservationInput {
  readonly observationId: string;
  readonly runId: string;
  readonly cellId: string;
  readonly createdAt: string;
}

export interface RepairSettledNovelSkillEvaluationObservationResult {
  readonly observationId: string;
  readonly repaired: boolean;
}

export interface BeginNovelSkillEvaluationAttemptInput {
  readonly attemptId: string;
  readonly runId: string;
  readonly cellId: string;
  readonly startedAt: string;
}

export type FinishNovelSkillEvaluationAttemptInput = Readonly<{
  attemptId: string;
  status: "succeeded" | "failed" | "cancelled";
  contextTraceId: string | null;
  modelInvocationId: string | null;
  errorCode: string | null;
  completedAt: string;
}>;

export interface NovelSkillEvaluationCellRecord {
  readonly id: string;
  readonly fixtureId: string;
  readonly taskType: string;
  readonly invocationMode: string;
  readonly genreTags: readonly string[];
  readonly fixtureInputContentHash: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly modelSlotId: NovelSkillEvaluationModelSlot["slotId"];
  readonly modelTier: string;
  readonly repetition: number;
  readonly state: "planned" | "observed" | "invalidated";
  readonly evidenceCollected: boolean;
  readonly attemptCount: number;
  readonly latestAttemptId: string | null;
  readonly latestAttemptStatus: "started" | "succeeded" | "failed" | "cancelled" | null;
  readonly latestAttemptStartedAt: string | null;
  readonly latestAttemptContextTraceId: string | null;
  readonly latestAttemptModelInvocationId: string | null;
}

export interface NovelSkillEvaluationStartedAttemptRecord {
  readonly id: string;
  readonly runId: string;
  readonly cellId: string;
  readonly attemptNumber: number;
  readonly startedAt: string;
  readonly contextTraceId: string | null;
  readonly modelInvocationId: string | null;
}

export interface BindNovelSkillEvaluationAttemptDispatchInput {
  readonly attemptId: string;
  readonly contextTraceId: string;
  readonly modelInvocationId: string;
}

export interface NovelSkillEvaluationRunProgress extends NovelSkillEvaluationRunRecord {
  readonly evaluationProjectId: string;
  readonly totalCells: number;
  readonly evidenceCollectedCells: number;
  readonly scoredCells: number;
}

export interface NovelSkillEvaluationRunRecord {
  readonly id: string;
  readonly suiteId: string;
  readonly status: "planned" | "running" | "completed" | "invalidated";
  readonly evaluationStatus: NovelSkillEvaluationStatus;
  readonly evaluationResultHash: string | null;
  readonly revision: number;
}

export type NovelSkillEvaluationStoreErrorCode =
  | "NOVEL_SKILL_EVALUATION_INVALID"
  | "NOVEL_SKILL_EVALUATION_CONFLICT"
  | "NOVEL_SKILL_EVALUATION_PRIVACY"
  | "NOVEL_SKILL_EVALUATION_EVIDENCE";

export class NovelSkillEvaluationStoreError extends Error {
  public constructor(
    readonly code: NovelSkillEvaluationStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NovelSkillEvaluationStoreError";
  }
}

/** Content-free persistence boundary for the paid, explicitly-authorized A/B gate. */
export class NovelSkillEvaluationSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async createSuite(input: CreateNovelSkillEvaluationSuiteInput): Promise<void> {
    assertExactObjectKeys(
      input,
      [
        "suiteId",
        "evaluationProjectId",
        "plan",
        "manifests",
        "preferenceConfigurationHash",
        "createdAt",
      ],
      "suite input",
    );
    assertUuidV7(input.suiteId, "suiteId");
    assertUuidV7(input.evaluationProjectId, "evaluationProjectId");
    assertIsoUtc(input.createdAt, "createdAt");
    assertHash(input.preferenceConfigurationHash, "preferenceConfigurationHash");
    assertExactPlan(input.plan);
    assertManifestHierarchy(input.manifests);
    const fixtures = listNovelSkillEvaluationFixtures();
    const fixtureContracts = await Promise.all(
      fixtures.map(async (fixture) => ({
        fixture,
        hash: await sha256Hex(canonicalJson(fixture)),
        inputHash: await sha256Hex(fixture.input),
      })),
    );
    const fixtureSetHash = await sha256Hex(
      canonicalJson(fixtureContracts.map(({ fixture, hash }) => [fixture.fixtureId, hash])),
    );
    if (
      fixtureSetHash !== NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH ||
      fixtureContracts.length !== NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.length ||
      fixtureContracts.some(({ fixture, hash, inputHash }, index) => {
        const expected = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY[index];
        if (expected === undefined) return true;
        return (
          fixture.fixtureId !== expected.fixtureId ||
          fixture.taskType !== expected.taskType ||
          fixture.invocationMode !== expected.invocationMode ||
          canonicalJson(fixture.genreTags) !== canonicalJson(expected.genreTags) ||
          canonicalJson(fixture.coverageDimensions) !==
            canonicalJson(expected.coverageDimensions) ||
          hash !== expected.contractHash ||
          inputHash !== expected.inputContentHash
        );
      })
    ) {
      throw storeError(
        EVALUATION_INVALID_CODE,
        "The built-in evaluation fixture registry does not match its pinned contract.",
      );
    }
    const coreManifestHash = await manifestHash(input.manifests.core, "core");
    const coreGenreManifestHash = await manifestHash(input.manifests.coreGenre, "core_genre");
    const coreGenrePreferencesManifestHash = await manifestHash(
      input.manifests.coreGenrePreferences,
      "core_genre_preferences",
    );
    const manifestItems = [
      ["core", orderedManifest(input.manifests.core)] as const,
      ["core_genre", orderedManifest(input.manifests.coreGenre)] as const,
      ["core_genre_preferences", orderedManifest(input.manifests.coreGenrePreferences)] as const,
    ];
    const targetManifestHash = await sha256Hex(
      canonicalJson({
        coreManifestHash,
        coreGenreManifestHash,
        coreGenrePreferencesManifestHash,
        preferenceConfigurationHash: input.preferenceConfigurationHash,
      }),
    );
    const orderedSlots = orderedModelSlots(input.plan.modelSlots);
    const planHash = await sha256Hex(
      canonicalJson({
        compilerVersion: input.plan.compilerVersion,
        evaluatorVersion: input.plan.evaluatorVersion,
        fixtureSetHash,
        minimumRepetitions: 2,
        modelSlots: orderedSlots,
        targetManifestHash,
      }),
    );

    await this.executor.transaction(async (transaction) => {
      const replayed = await assertExactSuiteReplayOrMissing(transaction, {
        input,
        planHash,
        fixtureSetHash,
        targetManifestHash,
        coreManifestHash,
        coreGenreManifestHash,
        coreGenrePreferencesManifestHash,
        orderedSlots,
        manifestItems,
        fixtureContracts,
      });
      if (replayed) return;
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_suites (
           id, schema_version, evaluator_version, compiler_version,
           evaluation_project_id, plan_hash, fixture_set_hash,
           target_manifest_hash, core_manifest_hash, core_genre_manifest_hash,
           core_genre_preferences_manifest_hash, preference_configuration_hash,
           model_slots_json, minimum_repetitions, created_at
         ) VALUES (?, 1, 'novel-skill-ab@1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
        [
          input.suiteId,
          input.plan.compilerVersion,
          input.evaluationProjectId,
          planHash,
          fixtureSetHash,
          targetManifestHash,
          coreManifestHash,
          coreGenreManifestHash,
          coreGenrePreferencesManifestHash,
          input.preferenceConfigurationHash,
          JSON.stringify(orderedSlots),
          input.createdAt,
        ],
      );
      for (const [arm, items] of manifestItems) {
        for (const [index, item] of items.entries()) {
          await transaction.execute(
            `INSERT INTO novel_skill_evaluation_manifest_items (
               suite_id, arm, item_order, skill_id, skill_version, definition_hash, kind
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              input.suiteId,
              arm,
              index + 1,
              item.skillId,
              item.version,
              item.definitionHash,
              item.kind,
            ],
          );
        }
      }
      for (const { fixture, hash, inputHash } of fixtureContracts) {
        await transaction.execute(
          `INSERT INTO novel_skill_evaluation_fixtures (
             suite_id, fixture_id, language, origin, task_type, invocation_mode,
             genre_tags_json, coverage_dimensions_json, contract_hash, input_content_hash
           ) VALUES (?, ?, 'zh-CN', 'inkshadow_original_short_contract', ?, ?, ?, ?, ?, ?)`,
          [
            input.suiteId,
            fixture.fixtureId,
            fixture.taskType,
            fixture.invocationMode,
            JSON.stringify(fixture.genreTags),
            JSON.stringify(fixture.coverageDimensions),
            hash,
            inputHash,
          ],
        );
      }
    });
  }

  public async createRun(input: CreateNovelSkillEvaluationRunInput): Promise<void> {
    assertExactObjectKeys(
      input,
      ["runId", "suiteId", "modelAssignments", "createdAt"],
      "run input",
    );
    assertUuidV7(input.runId, "runId");
    assertUuidV7(input.suiteId, "suiteId");
    assertIsoUtc(input.createdAt, "createdAt");
    const assignments = orderedAssignments(input.modelAssignments);
    await this.executor.transaction(async (transaction) => {
      const suites = await transaction.select<SuiteRow>(
        `SELECT model_slots_json, core_manifest_hash, core_genre_manifest_hash,
                core_genre_preferences_manifest_hash
         FROM novel_skill_evaluation_suites WHERE id = ?`,
        [input.suiteId],
      );
      const suite = suites[0];
      if (suite === undefined) {
        throw storeError(EVALUATION_CONFLICT_CODE, "Evaluation suite does not exist.");
      }
      const slots = parseModelSlots(suite.model_slots_json);
      if (!sameSlotIds(slots, assignments)) {
        throw storeError(
          EVALUATION_INVALID_CODE,
          "Run model assignments do not match the suite's two slots.",
        );
      }
      const replayed = await assertExactRunReplayOrMissing(transaction, {
        input,
        assignments,
        slots,
        suite,
      });
      if (replayed) return;
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_runs (
            id, suite_id, status, evaluation_status, evaluation_result_hash, model_assignments_json,
            revision, started_at, completed_at, created_at
          ) VALUES (?, ?, 'planned', 'NOT_EVALUATED', NULL, ?, 1, NULL, NULL, ?)`,
        [input.runId, input.suiteId, JSON.stringify(assignments), input.createdAt],
      );
      const fixtures = await transaction.select<{ readonly fixture_id: string }>(
        `SELECT fixture_id FROM novel_skill_evaluation_fixtures
         WHERE suite_id = ? ORDER BY fixture_id`,
        [input.suiteId],
      );
      if (fixtures.length !== 12) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Evaluation suite must contain exactly 12 immutable fixture contracts.",
        );
      }
      for (const { fixture_id: fixtureId } of fixtures) {
        for (const arm of NOVEL_SKILL_EVALUATION_ARMS) {
          for (const slot of slots) {
            for (const repetition of [1, 2] as const) {
              await transaction.execute(
                `INSERT INTO novel_skill_evaluation_cells (
                   id, run_id, suite_id, fixture_id, arm, arm_configuration_hash,
                   model_slot_id, model_tier, repetition, state, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
                [
                  await deterministicCellId(input.runId, fixtureId, arm, slot.slotId, repetition),
                  input.runId,
                  input.suiteId,
                  fixtureId,
                  arm,
                  armHash(suite, arm),
                  slot.slotId,
                  slot.modelTier,
                  repetition,
                  input.createdAt,
                ],
              );
            }
          }
        }
      }
    });
  }

  public async startRun(runId: string, startedAt: string): Promise<void> {
    assertUuidV7(runId, "runId");
    assertIsoUtc(startedAt, "startedAt");
    const result = await this.executor.execute(
      `UPDATE novel_skill_evaluation_runs
       SET status = 'running', started_at = ?, revision = revision + 1
       WHERE id = ? AND status = 'planned' AND evaluation_status = 'NOT_EVALUATED'`,
      [startedAt, runId],
    );
    if (result.rowsAffected !== 1) {
      throw storeError(
        EVALUATION_CONFLICT_CODE,
        "Evaluation run was already started or cannot be resumed.",
      );
    }
  }

  public async invalidateRun(runId: string, invalidatedAt: string): Promise<void> {
    assertUuidV7(runId, "runId");
    assertIsoUtc(invalidatedAt, "invalidatedAt");
    await this.executor.transaction(async (transaction) => {
      await transaction.execute(
        `UPDATE novel_skill_evaluation_attempts
         SET status = 'cancelled', error_code = 'RUN_INVALIDATED', completed_at = ?
         WHERE run_id = ? AND status = 'started'`,
        [invalidatedAt, runId],
      );
      const result = await transaction.execute(
        `UPDATE novel_skill_evaluation_runs
         SET status = 'invalidated', evaluation_status = 'EVIDENCE_INCOMPLETE',
             completed_at = ?, revision = revision + 1
         WHERE id = ? AND status IN ('planned','running')`,
        [invalidatedAt, runId],
      );
      if (result.rowsAffected !== 1) {
        throw storeError(EVALUATION_CONFLICT_CODE, "Evaluation run is already terminal.");
      }
      await transaction.execute(
        `UPDATE novel_skill_evaluation_cells SET state = 'invalidated'
         WHERE run_id = ? AND state = 'planned'`,
        [runId],
      );
    });
  }

  public async getStartedAttempt(
    runId: string,
    cellId: string,
  ): Promise<NovelSkillEvaluationStartedAttemptRecord | null> {
    assertUuidV7(runId, "runId");
    assertUuidV7(cellId, "cellId");
    const rows = await this.executor.select<{
      readonly id: string;
      readonly run_id: string;
      readonly cell_id: string;
      readonly attempt_number: number;
      readonly started_at: string;
      readonly context_trace_id: string | null;
      readonly model_invocation_id: string | null;
    }>(
      `SELECT id, run_id, cell_id, attempt_number, started_at,
              context_trace_id, model_invocation_id
       FROM novel_skill_evaluation_attempts
       WHERE run_id = ? AND cell_id = ? AND status = 'started'`,
      [runId, cellId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : Object.freeze({
          id: row.id,
          runId: row.run_id,
          cellId: row.cell_id,
          attemptNumber: row.attempt_number,
          startedAt: row.started_at,
          contextTraceId: row.context_trace_id,
          modelInvocationId: row.model_invocation_id,
        });
  }

  /** Persists the exact pre-dispatch receipt before any provider network request. */
  public async bindAttemptDispatch(
    input: BindNovelSkillEvaluationAttemptDispatchInput,
  ): Promise<void> {
    assertExactObjectKeys(
      input,
      ["attemptId", "contextTraceId", "modelInvocationId"],
      "attempt dispatch input",
    );
    assertUuidV7(input.attemptId, "attemptId");
    assertUuidV7(input.contextTraceId, "contextTraceId");
    if (!isPortableLocator(input.modelInvocationId, 512)) {
      throw storeError(EVALUATION_INVALID_CODE, "Attempt model invocation identifier is invalid.");
    }
    await this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<{
        readonly run_id: string;
        readonly model_slot_id: NovelSkillEvaluationModelSlot["slotId"];
        readonly model_assignments_json: string;
        readonly connection_id: string;
        readonly catalog_entry_id: string | null;
        readonly provider_kind_snapshot: string;
        readonly model_id_snapshot: string;
      }>(
        `SELECT attempt.run_id, cell.model_slot_id, run.model_assignments_json,
                invocation.connection_id, invocation.catalog_entry_id,
                invocation.provider_kind_snapshot, invocation.model_id_snapshot
         FROM novel_skill_evaluation_attempts AS attempt
         INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = attempt.cell_id
         INNER JOIN novel_skill_evaluation_runs AS run ON run.id = attempt.run_id
         INNER JOIN model_invocation_facts AS invocation ON invocation.id = ?
         INNER JOIN context_compilation_model_invocation_links AS link
           ON link.model_invocation_id = invocation.id AND link.trace_id = ?
         WHERE attempt.id = ? AND attempt.status = 'started'
           AND attempt.context_trace_id IS NULL AND attempt.model_invocation_id IS NULL`,
        [input.modelInvocationId, input.contextTraceId, input.attemptId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Evaluation attempt dispatch receipt is missing or already bound.",
        );
      }
      await assertEvaluationProjectClean(transaction, row.run_id);
      const modelIdentityHash = await hashNovelSkillEvaluationModelIdentity({
        catalogEntryId: row.catalog_entry_id,
        connectionId: row.connection_id,
        modelId: row.model_id_snapshot,
        providerKind: row.provider_kind_snapshot,
      });
      const modelArtifactHash = await hashNovelSkillEvaluationModelArtifact({
        modelId: row.model_id_snapshot,
        providerKind: row.provider_kind_snapshot,
      });
      const assignment = parseAssignments(row.model_assignments_json).find(
        ({ slotId }) => slotId === row.model_slot_id,
      );
      if (
        assignment?.modelIdentityHash !== modelIdentityHash ||
        assignment.modelArtifactHash !== modelArtifactHash
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Pre-dispatch provider/model receipt does not match the immutable evaluation slot.",
        );
      }
      const changed = await transaction.execute(
        `UPDATE novel_skill_evaluation_attempts
         SET context_trace_id = ?, model_invocation_id = ?
         WHERE id = ? AND status = 'started'
           AND context_trace_id IS NULL AND model_invocation_id IS NULL`,
        [input.contextTraceId, input.modelInvocationId, input.attemptId],
      );
      if (changed.rowsAffected !== 1) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Evaluation attempt dispatch receipt is missing or already bound.",
        );
      }
    });
  }

  public async beginAttempt(input: BeginNovelSkillEvaluationAttemptInput): Promise<number> {
    assertExactObjectKeys(input, ["attemptId", "runId", "cellId", "startedAt"], "attempt input");
    assertUuidV7(input.attemptId, "attemptId");
    assertUuidV7(input.runId, "runId");
    assertUuidV7(input.cellId, "cellId");
    assertIsoUtc(input.startedAt, "startedAt");
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<{ readonly next_attempt_number: number }>(
        `SELECT 1 + COALESCE(max(attempt_number), 0) AS next_attempt_number
         FROM novel_skill_evaluation_attempts WHERE cell_id = ?`,
        [input.cellId],
      );
      const attemptNumber = rows[0]?.next_attempt_number;
      if (
        typeof attemptNumber !== "number" ||
        !Number.isSafeInteger(attemptNumber) ||
        attemptNumber < 1 ||
        attemptNumber > 8
      ) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Evaluation cell exhausted its bounded eight-attempt retry budget.",
        );
      }
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_attempts (
           id, run_id, cell_id, attempt_number, status, context_trace_id,
           model_invocation_id, error_code, started_at, completed_at
         ) VALUES (?, ?, ?, ?, 'started', NULL, NULL, NULL, ?, NULL)`,
        [input.attemptId, input.runId, input.cellId, attemptNumber, input.startedAt],
      );
      return attemptNumber;
    });
  }

  public async finishAttempt(input: FinishNovelSkillEvaluationAttemptInput): Promise<void> {
    assertExactObjectKeys(
      input,
      ["attemptId", "status", "contextTraceId", "modelInvocationId", "errorCode", "completedAt"],
      "attempt completion input",
    );
    assertUuidV7(input.attemptId, "attemptId");
    assertIsoUtc(input.completedAt, "completedAt");
    if ((input.contextTraceId === null) !== (input.modelInvocationId === null)) {
      throw storeError(
        EVALUATION_INVALID_CODE,
        "Attempt trace and invocation receipts must either both be present or both be absent.",
      );
    }
    if (input.contextTraceId !== null) assertUuidV7(input.contextTraceId, "contextTraceId");
    if (input.modelInvocationId !== null && !isPortableLocator(input.modelInvocationId, 512)) {
      throw storeError(EVALUATION_INVALID_CODE, "Attempt model invocation identifier is invalid.");
    }
    if (
      (input.status === "succeeded" &&
        (input.contextTraceId === null || input.errorCode !== null)) ||
      (input.status !== "succeeded" && !isErrorCode(input.errorCode))
    ) {
      throw storeError(
        EVALUATION_INVALID_CODE,
        "Attempt terminal metadata does not match its status.",
      );
    }
    const changed = await this.executor.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET status = ?, context_trace_id = ?, model_invocation_id = ?, error_code = ?, completed_at = ?
       WHERE id = ? AND status = 'started'`,
      [
        input.status,
        input.contextTraceId,
        input.modelInvocationId,
        input.errorCode,
        input.completedAt,
        input.attemptId,
      ],
    );
    if (changed.rowsAffected !== 1) {
      throw storeError(
        EVALUATION_CONFLICT_CODE,
        "Evaluation attempt is missing or already terminal.",
      );
    }
  }

  public async recordCollectedEvidence(
    input: RecordNovelSkillEvaluationEvidenceInput,
  ): Promise<void> {
    assertExactObjectKeys(
      input,
      [
        "observationId",
        "runId",
        "cellId",
        "attemptId",
        "contextTraceId",
        "modelInvocationId",
        "outputCandidateId",
        "novelSkillSnapshotId",
        "preferenceConfigurationHash",
        "resultHash",
        "observation",
        "createdAt",
      ],
      "observation input",
    );
    assertObservationInput(input);
    await this.executor.transaction(async (transaction) => {
      await assertEvaluationProjectClean(transaction, input.runId);
      const rows = await transaction.select<CellEvidenceRow>(
        `SELECT cell.fixture_id, cell.arm, cell.arm_configuration_hash, cell.model_slot_id,
                cell.model_tier, cell.repetition, cell.state, run.status AS run_status,
                run.model_assignments_json, suite.preference_configuration_hash
         FROM novel_skill_evaluation_cells AS cell
         INNER JOIN novel_skill_evaluation_runs AS run ON run.id = cell.run_id
         INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = cell.suite_id
         WHERE cell.id = ? AND run.id = ?`,
        [input.cellId, input.runId],
      );
      const cell = rows[0];
      if (cell?.state !== "planned" || cell.run_status !== "running") {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Evaluation cell is not pending in this active run.",
        );
      }
      assertObservationMatchesCell(input.observation, input.modelInvocationId, cell);
      const invocations = await transaction.select<InvocationEvidenceRow>(
        `SELECT invocation.task, invocation.status, invocation.connection_id,
                invocation.catalog_entry_id, invocation.provider_kind_snapshot,
                invocation.model_id_snapshot, invocation.started_at, invocation.completed_at,
                invocation.error_code, invocation.finish_reason, invocation.visible_content_length,
                invocation.input_tokens, invocation.output_tokens, invocation.estimated_cost_micros
         FROM model_invocation_facts AS invocation
         INNER JOIN context_compilation_model_invocation_links AS link
           ON link.model_invocation_id = invocation.id AND link.trace_id = ?
         WHERE invocation.id = ?`,
        [input.contextTraceId, input.modelInvocationId],
      );
      const invocation = invocations[0];
      if (!usableInvocation(invocation)) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Evaluation requires a succeeded, completed, visible and non-truncated invocation.",
        );
      }
      const modelIdentityHash = await hashNovelSkillEvaluationModelIdentity({
        catalogEntryId: invocation.catalog_entry_id,
        connectionId: invocation.connection_id,
        modelId: invocation.model_id_snapshot,
        providerKind: invocation.provider_kind_snapshot,
      });
      const modelArtifactHash = await hashNovelSkillEvaluationModelArtifact({
        modelId: invocation.model_id_snapshot,
        providerKind: invocation.provider_kind_snapshot,
      });
      const assignment = parseAssignments(cell.model_assignments_json).find(
        ({ slotId }) => slotId === cell.model_slot_id,
      );
      if (
        assignment?.modelIdentityHash !== modelIdentityHash ||
        assignment.modelArtifactHash !== modelArtifactHash
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Provider/model receipt does not match this run's immutable slot assignment.",
        );
      }
      const actualArmHash = await readActualArmHash(
        transaction,
        input.modelInvocationId,
        input.contextTraceId,
        input.novelSkillSnapshotId,
        cell.arm,
      );
      if (actualArmHash !== cell.arm_configuration_hash) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Invocation Skill membership does not match its planned A/B arm.",
        );
      }
      const methodApplicability = await readMethodApplicability(
        transaction,
        input.novelSkillSnapshotId,
        cell.arm,
      );
      if (
        input.observation.methodApplicability.core !== methodApplicability.core ||
        input.observation.methodApplicability.genre !== methodApplicability.genre
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Evaluation applicability does not match the exact compiler receipt.",
        );
      }
      const actualPreferenceConfigurationHash = await readPreferenceConfigurationHash(
        transaction,
        input.contextTraceId,
      );
      if (
        (cell.arm === "core_genre_preferences" &&
          (input.preferenceConfigurationHash !== cell.preference_configuration_hash ||
            actualPreferenceConfigurationHash !== cell.preference_configuration_hash)) ||
        (cell.arm !== "core_genre_preferences" &&
          (input.preferenceConfigurationHash !== null ||
            actualPreferenceConfigurationHash !== null))
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Preference evidence does not match the planned A/B arm.",
        );
      }
      if (
        input.observation.visibleContentLength !== invocation.visible_content_length ||
        input.observation.finishReason !== invocation.finish_reason
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Evaluation completion metadata does not match the exact provider receipt.",
        );
      }
      const latencyMilliseconds = invocationLatencyMilliseconds(invocation);
      if (input.observation.latencyMilliseconds !== latencyMilliseconds) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Evaluation latency must match the exact invocation timestamps.",
        );
      }

      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_observations (
           id, run_id, cell_id, attempt_id, context_trace_id, model_invocation_id, output_candidate_id,
           novel_skill_snapshot_id, model_identity_hash, model_artifact_hash,
           arm_configuration_hash,
           preference_configuration_hash, evaluator_version, result_hash,
           latency_milliseconds, input_tokens, output_tokens, estimated_cost_micros, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'novel-skill-ab@1', ?, ?, ?, ?, ?, ?)`,
        [
          input.observationId,
          input.runId,
          input.cellId,
          input.attemptId,
          input.contextTraceId,
          input.modelInvocationId,
          input.outputCandidateId,
          input.novelSkillSnapshotId,
          modelIdentityHash,
          modelArtifactHash,
          actualArmHash,
          input.preferenceConfigurationHash,
          input.resultHash,
          latencyMilliseconds,
          invocation.input_tokens,
          invocation.output_tokens,
          parseCost(invocation.estimated_cost_micros),
          input.createdAt,
        ],
      );
    });
  }

  /**
   * Rebuilds the 0061 observation from one immutable, successfully settled 0063 receipt.
   * No provider request is made and no caller-supplied model, output, Skill or timing evidence
   * is accepted. Repeating the same observation identifier is idempotent.
   */
  public async repairSettledObservation(
    input: RepairSettledNovelSkillEvaluationObservationInput,
  ): Promise<RepairSettledNovelSkillEvaluationObservationResult> {
    assertExactObjectKeys(
      input,
      ["observationId", "runId", "cellId", "createdAt"],
      "settled observation repair input",
    );
    assertUuidV7(input.observationId, "observationId");
    assertUuidV7(input.runId, "runId");
    assertUuidV7(input.cellId, "cellId");
    assertIsoUtc(input.createdAt, "createdAt");

    const evidence = await this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<SettledObservationRepairRow>(
        `SELECT reservation.attempt_id, reservation.planned_context_trace_id,
                reservation.planned_model_invocation_id, reservation.output_candidate_id,
                reservation.provider_visible_output_hash, reservation.terminal_at,
                cell.fixture_id, cell.arm, cell.model_slot_id, cell.model_tier, cell.repetition,
                invocation.finish_reason, invocation.visible_content_length,
                invocation.input_tokens, invocation.output_tokens,
                invocation.estimated_cost_micros, invocation.started_at, invocation.completed_at,
                candidate.content, candidate.content_checksum,
                observation.id AS existing_observation_id,
                observation.attempt_id AS observed_attempt_id,
                observation.context_trace_id AS observed_trace_id,
                observation.model_invocation_id AS observed_invocation_id,
                observation.output_candidate_id AS observed_candidate_id,
                observation.result_hash AS observed_result_hash
         FROM novel_skill_evaluation_dispatch_reservations AS reservation
         INNER JOIN novel_skill_evaluation_cells AS cell
           ON cell.id = reservation.cell_id AND cell.run_id = reservation.run_id
         INNER JOIN novel_skill_evaluation_attempts AS attempt
           ON attempt.id = reservation.attempt_id AND attempt.run_id = reservation.run_id
          AND attempt.cell_id = reservation.cell_id
         INNER JOIN model_invocation_facts AS invocation
           ON invocation.id = reservation.planned_model_invocation_id
         INNER JOIN ai_candidates AS candidate
           ON candidate.id = reservation.output_candidate_id
         LEFT JOIN novel_skill_evaluation_observations AS observation
           ON observation.run_id = reservation.run_id AND observation.cell_id = reservation.cell_id
         WHERE reservation.run_id = ? AND reservation.cell_id = ?
           AND reservation.state = 'settled'
           AND reservation.settlement_outcome = 'succeeded'
           AND attempt.status = 'succeeded'
           AND attempt.context_trace_id = reservation.planned_context_trace_id
           AND attempt.model_invocation_id = reservation.planned_model_invocation_id`,
        [input.runId, input.cellId],
      );
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Settled observation repair requires one exact successful reservation chain.",
        );
      }
      if (row.terminal_at === null || input.createdAt < row.terminal_at) {
        throw storeError(
          EVALUATION_INVALID_CODE,
          "Observation repair time must not precede the settled provider receipt.",
        );
      }
      const actualResultHash = await sha256Hex(row.content);
      if (
        row.output_candidate_id === null ||
        row.provider_visible_output_hash === null ||
        row.content.length === 0 ||
        actualResultHash !== row.content_checksum ||
        actualResultHash !== row.provider_visible_output_hash ||
        Array.from(row.content).length !== row.visible_content_length
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Settled observation repair found a mismatched provider output Candidate.",
        );
      }
      if (row.existing_observation_id !== null) {
        if (
          row.existing_observation_id !== input.observationId ||
          row.observed_attempt_id !== row.attempt_id ||
          row.observed_trace_id !== row.planned_context_trace_id ||
          row.observed_invocation_id !== row.planned_model_invocation_id ||
          row.observed_candidate_id !== row.output_candidate_id ||
          row.observed_result_hash !== actualResultHash
        ) {
          throw storeError(
            EVALUATION_CONFLICT_CODE,
            "The settled evaluation cell already has a different observation receipt.",
          );
        }
        return null;
      }

      const snapshotRows = await transaction.select<{ readonly id: string }>(
        `SELECT id FROM novel_skill_invocation_snapshots
         WHERE context_trace_id = ? AND model_invocation_id = ? ORDER BY id`,
        [row.planned_context_trace_id, row.planned_model_invocation_id],
      );
      const novelSkillSnapshotId = snapshotRows[0]?.id ?? null;
      if (
        (row.arm === "no_skill" && snapshotRows.length !== 0) ||
        (row.arm !== "no_skill" && snapshotRows.length !== 1)
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Settled observation repair found an invalid Novel Skill snapshot chain.",
        );
      }
      const methodApplicability = await readMethodApplicability(
        transaction,
        novelSkillSnapshotId,
        row.arm,
      );
      const actualPreferenceConfigurationHash = await readPreferenceConfigurationHash(
        transaction,
        row.planned_context_trace_id,
      );
      const preferenceConfigurationHash =
        row.arm === "core_genre_preferences" ? actualPreferenceConfigurationHash : null;
      if (
        (row.arm === "core_genre_preferences" && preferenceConfigurationHash === null) ||
        (row.arm !== "core_genre_preferences" && actualPreferenceConfigurationHash !== null)
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Settled observation repair found preference evidence in the wrong A/B arm.",
        );
      }
      const latencyMilliseconds = invocationLatencyMilliseconds({
        started_at: row.started_at,
        completed_at: row.completed_at,
      });
      return {
        observationId: input.observationId,
        runId: input.runId,
        cellId: input.cellId,
        attemptId: row.attempt_id,
        contextTraceId: row.planned_context_trace_id,
        modelInvocationId: row.planned_model_invocation_id,
        outputCandidateId: row.output_candidate_id,
        novelSkillSnapshotId,
        preferenceConfigurationHash,
        resultHash: actualResultHash,
        observation: {
          observationId: input.observationId,
          fixtureId: row.fixture_id,
          arm: row.arm,
          modelSlotId: row.model_slot_id,
          modelTier: row.model_tier,
          repetition: row.repetition,
          modelInvocationId: row.planned_model_invocation_id,
          evaluatorVersion: "novel-skill-ab@1" as const,
          completionStatus: "succeeded" as const,
          visibleContentLength: row.visible_content_length,
          finishReason: row.finish_reason,
          methodApplicability,
          latencyMilliseconds,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          estimatedCostMicros: parseCost(row.estimated_cost_micros),
        },
        createdAt: input.createdAt,
      } satisfies RecordNovelSkillEvaluationEvidenceInput;
    });

    if (evidence === null) {
      return { observationId: input.observationId, repaired: false };
    }
    try {
      await this.recordCollectedEvidence(evidence);
      return { observationId: input.observationId, repaired: true };
    } catch (cause) {
      const existing = await this.executor.select<{
        readonly id: string;
        readonly attempt_id: string;
        readonly context_trace_id: string;
        readonly model_invocation_id: string;
        readonly output_candidate_id: string;
        readonly result_hash: string;
      }>(
        `SELECT id, attempt_id, context_trace_id, model_invocation_id,
                output_candidate_id, result_hash
         FROM novel_skill_evaluation_observations WHERE run_id = ? AND cell_id = ?`,
        [input.runId, input.cellId],
      );
      const row = existing[0];
      if (
        existing.length === 1 &&
        row?.id === input.observationId &&
        row.attempt_id === evidence.attemptId &&
        row.context_trace_id === evidence.contextTraceId &&
        row.model_invocation_id === evidence.modelInvocationId &&
        row.output_candidate_id === evidence.outputCandidateId &&
        row.result_hash === evidence.resultHash
      ) {
        return { observationId: input.observationId, repaired: false };
      }
      throw cause;
    }
  }

  public async recordManualScores(input: RecordNovelSkillEvaluationScoresInput): Promise<void> {
    assertExactObjectKeys(
      input,
      ["runId", "cellId", "observationId", "scores", "reviewerId", "rubricVersion", "scoredAt"],
      "manual score input",
    );
    assertUuidV7(input.runId, "runId");
    assertUuidV7(input.cellId, "cellId");
    assertUuidV7(input.observationId, "observationId");
    if (
      !isPortableLocator(input.reviewerId, 128) ||
      !/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(input.reviewerId)
    ) {
      throw storeError(
        EVALUATION_INVALID_CODE,
        "Manual score reviewer identifier must be a portable pseudonymous locator.",
      );
    }
    if (
      (input as { readonly rubricVersion: unknown }).rubricVersion !== "novel-skill-human-rubric@1"
    ) {
      throw storeError(EVALUATION_INVALID_CODE, "Manual score rubric version is invalid.");
    }
    assertIsoUtc(input.scoredAt, "scoredAt");
    assertScores(input.scores);
    await this.executor.transaction(async (transaction) => {
      const observations = await transaction.select<{ readonly id: string }>(
        `SELECT observation.id
         FROM novel_skill_evaluation_observations AS observation
         INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = observation.cell_id
         INNER JOIN novel_skill_evaluation_runs AS run ON run.id = observation.run_id
         WHERE observation.id = ? AND observation.run_id = ? AND observation.cell_id = ?
           AND cell.state = 'planned' AND run.status = 'running'`,
        [input.observationId, input.runId, input.cellId],
      );
      if (observations.length !== 1) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Manual scores require one collected evidence record in an active run.",
        );
      }
      for (const metric of NOVEL_SKILL_EVALUATION_METRICS) {
        const score = input.scores[metric];
        await transaction.execute(
          `INSERT INTO novel_skill_evaluation_scores (
             observation_id, metric, score_basis_points, reviewer_id, rubric_version, scored_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.observationId,
            metric,
            score === null ? null : Math.round(score * 10_000),
            input.reviewerId,
            input.rubricVersion,
            input.scoredAt,
          ],
        );
      }
      const marked = await transaction.execute(
        `UPDATE novel_skill_evaluation_cells SET state = 'observed'
         WHERE id = ? AND run_id = ? AND state = 'planned'`,
        [input.cellId, input.runId],
      );
      if (marked.rowsAffected !== 1) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Evaluation cell changed before its receipt was committed.",
        );
      }
    });
  }

  /** Compatibility helper for tests/importers that already possess real human scores. */
  public async recordObservation(input: RecordNovelSkillEvaluationObservationInput): Promise<void> {
    const { reviewerId, rubricVersion, scoredAt, ...evidenceInput } = input;
    const { scores, ...observation } = evidenceInput.observation;
    await this.recordCollectedEvidence({ ...evidenceInput, observation });
    await this.recordManualScores({
      runId: input.runId,
      cellId: input.cellId,
      observationId: input.observationId,
      scores,
      reviewerId,
      rubricVersion,
      scoredAt,
    });
  }

  public async listRunCells(runId: string): Promise<readonly NovelSkillEvaluationCellRecord[]> {
    assertUuidV7(runId, "runId");
    const rows = await this.executor.select<RunCellRow>(
      `SELECT cell.id, cell.fixture_id, fixture.task_type, fixture.invocation_mode,
              fixture.genre_tags_json, fixture.input_content_hash, cell.arm,
              cell.model_slot_id, cell.model_tier, cell.repetition, cell.state,
              CASE WHEN observation.id IS NULL THEN 0 ELSE 1 END AS evidence_collected,
              count(attempt.id) AS attempt_count,
              (SELECT latest.id FROM novel_skill_evaluation_attempts AS latest
               WHERE latest.cell_id = cell.id ORDER BY latest.attempt_number DESC LIMIT 1)
                AS latest_attempt_id,
              (SELECT latest.status FROM novel_skill_evaluation_attempts AS latest
               WHERE latest.cell_id = cell.id ORDER BY latest.attempt_number DESC LIMIT 1)
                AS latest_attempt_status,
              (SELECT latest.started_at FROM novel_skill_evaluation_attempts AS latest
               WHERE latest.cell_id = cell.id ORDER BY latest.attempt_number DESC LIMIT 1)
                AS latest_attempt_started_at,
              (SELECT latest.context_trace_id FROM novel_skill_evaluation_attempts AS latest
               WHERE latest.cell_id = cell.id ORDER BY latest.attempt_number DESC LIMIT 1)
                AS latest_attempt_context_trace_id,
              (SELECT latest.model_invocation_id FROM novel_skill_evaluation_attempts AS latest
               WHERE latest.cell_id = cell.id ORDER BY latest.attempt_number DESC LIMIT 1)
                AS latest_attempt_model_invocation_id
       FROM novel_skill_evaluation_cells AS cell
       INNER JOIN novel_skill_evaluation_fixtures AS fixture
         ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
       LEFT JOIN novel_skill_evaluation_observations AS observation ON observation.cell_id = cell.id
       LEFT JOIN novel_skill_evaluation_attempts AS attempt ON attempt.cell_id = cell.id
       WHERE cell.run_id = ?
       GROUP BY cell.id, cell.fixture_id, fixture.task_type, fixture.invocation_mode,
                fixture.genre_tags_json, fixture.input_content_hash, cell.arm,
                cell.model_slot_id, cell.model_tier, cell.repetition, cell.state, observation.id
       ORDER BY cell.fixture_id, cell.arm, cell.model_slot_id, cell.repetition`,
      [runId],
    );
    return Object.freeze(rows.map(normalizeRunCell));
  }

  public async getRunProgress(runId: string): Promise<NovelSkillEvaluationRunProgress> {
    assertUuidV7(runId, "runId");
    await assertStoredSuitePlan(this.executor, runId);
    await assertEvaluationProjectClean(this.executor, runId);
    const rows = await this.executor.select<RunProgressRow>(
      `SELECT run.id, run.suite_id, run.status, run.evaluation_status,
              run.evaluation_result_hash, run.revision, suite.evaluation_project_id,
              suite.model_slots_json,
              count(cell.id) AS total_cells,
              count(observation.id) AS evidence_collected_cells,
              sum(CASE WHEN cell.state = 'observed' THEN 1 ELSE 0 END) AS scored_cells
       FROM novel_skill_evaluation_runs AS run
       INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
       INNER JOIN novel_skill_evaluation_cells AS cell ON cell.run_id = run.id
       LEFT JOIN novel_skill_evaluation_observations AS observation ON observation.cell_id = cell.id
       WHERE run.id = ? GROUP BY run.id, run.suite_id, run.status, run.evaluation_status,
                                  run.evaluation_result_hash, run.revision,
                                  suite.evaluation_project_id, suite.model_slots_json`,
      [runId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw storeError(EVALUATION_CONFLICT_CODE, "Evaluation run does not exist.");
    }
    const evidenceDigest = await readVerifiedEvidenceDigest(this.executor, runId);
    if (row.status === "completed") {
      const recomputed = evaluateNovelSkillAbEvidence(
        await readObservations(this.executor, runId),
        parseModelSlots(row.model_slots_json),
      );
      if (
        recomputed.status !== row.evaluation_status ||
        (await evaluationResultHash(recomputed, evidenceDigest)) !== row.evaluation_result_hash
      ) {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "Persisted evaluation result does not match its exact 192-cell evidence.",
        );
      }
    }
    return Object.freeze({
      id: row.id,
      suiteId: row.suite_id,
      status: row.status,
      evaluationStatus: row.evaluation_status,
      evaluationResultHash: row.evaluation_result_hash,
      revision: row.revision,
      evaluationProjectId: row.evaluation_project_id,
      totalCells: row.total_cells,
      evidenceCollectedCells: row.evidence_collected_cells,
      scoredCells: row.scored_cells,
    });
  }

  public async completeRun(
    runId: string,
    completedAt: string,
  ): Promise<NovelSkillEvaluationResult> {
    assertUuidV7(runId, "runId");
    assertIsoUtc(completedAt, "completedAt");
    return this.executor.transaction(async (transaction) => {
      await assertStoredSuitePlan(transaction, runId);
      await assertEvaluationProjectClean(transaction, runId);
      const rows = await transaction.select<{ readonly model_slots_json: string }>(
        `SELECT suite.model_slots_json FROM novel_skill_evaluation_runs AS run
         INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
         WHERE run.id = ? AND run.status = 'running'`,
        [runId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Evaluation run cannot be completed from its current state.",
        );
      }
      const modelSlots = parseModelSlots(row.model_slots_json);
      const evidenceDigest = await readVerifiedEvidenceDigest(transaction, runId);
      const observations = await readObservations(transaction, runId);
      const result = evaluateNovelSkillAbEvidence(observations, modelSlots);
      if (result.status === "NOT_EVALUATED" || result.status === "EVIDENCE_INCOMPLETE") {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          `Evaluation requires the exact 192-cell matrix; ${String(result.missingCells.length)} cells remain.`,
        );
      }
      const persistedResultHash = await evaluationResultHash(result, evidenceDigest);
      const changed = await transaction.execute(
        `UPDATE novel_skill_evaluation_runs
         SET status = 'completed', evaluation_status = ?, evaluation_result_hash = ?,
             completed_at = ?, revision = revision + 1
         WHERE id = ? AND status = 'running'`,
        [result.status, persistedResultHash, completedAt, runId],
      );
      if (changed.rowsAffected !== 1) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Evaluation run cannot be completed from its current state.",
        );
      }
      return result;
    });
  }

  public async recordManualDecision(
    decisionId: string,
    runId: string,
    decision: "KEEP_DISABLED" | "APPROVE_EXPERIMENTAL_BINDING" | "REJECT_ENABLEMENT",
    rationaleHash: string,
    createdAt: string,
  ): Promise<void> {
    assertUuidV7(decisionId, "decisionId");
    assertUuidV7(runId, "runId");
    assertIsoUtc(createdAt, "createdAt");
    assertHash(rationaleHash, "rationaleHash");
    await this.executor.transaction(async (transaction) => {
      await assertStoredSuitePlan(transaction, runId);
      await assertEvaluationProjectClean(transaction, runId);
      const rows = await transaction.select<DecisionRunRow>(
        `SELECT run.status, run.evaluation_status, run.evaluation_result_hash,
                suite.target_manifest_hash, suite.model_slots_json
         FROM novel_skill_evaluation_runs AS run
         INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
         INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
         WHERE run.id = ? AND run.status IN ('completed','invalidated')
           AND project.status = 'archived' AND project.archived_at IS NOT NULL
           AND project.trashed_at IS NULL`,
        [runId],
      );
      const run = rows[0];
      if (run === undefined) {
        throw storeError(
          EVALUATION_CONFLICT_CODE,
          "Manual decision requires a terminal run in its archived evaluation workspace.",
        );
      }
      if (run.status === "completed") {
        const evidenceDigest = await readVerifiedEvidenceDigest(transaction, runId);
        const result = evaluateNovelSkillAbEvidence(
          await readObservations(transaction, runId),
          parseModelSlots(run.model_slots_json),
        );
        const resultHash = await evaluationResultHash(result, evidenceDigest);
        if (
          result.status !== run.evaluation_status ||
          resultHash !== run.evaluation_result_hash ||
          (decision === "APPROVE_EXPERIMENTAL_BINDING" && result.status !== "ELIGIBLE_FOR_REVIEW")
        ) {
          throw storeError(
            EVALUATION_EVIDENCE_CODE,
            "Persisted evaluation status does not match the exact recomputed 192-cell result.",
          );
        }
      } else if (decision === "APPROVE_EXPERIMENTAL_BINDING") {
        throw storeError(
          EVALUATION_EVIDENCE_CODE,
          "An incomplete evaluation run cannot approve experimental bindings.",
        );
      }
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_manual_decisions (
           id, run_id, target_manifest_hash, decision, rationale_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [decisionId, runId, run.target_manifest_hash, decision, rationaleHash, createdAt],
      );
    });
  }
}

interface SuiteRow {
  readonly model_slots_json: string;
  readonly core_manifest_hash: string;
  readonly core_genre_manifest_hash: string;
  readonly core_genre_preferences_manifest_hash: string;
}

interface SuiteReplayRow extends SuiteRow {
  readonly schema_version: number;
  readonly evaluator_version: string;
  readonly compiler_version: string;
  readonly evaluation_project_id: string;
  readonly plan_hash: string;
  readonly fixture_set_hash: string;
  readonly target_manifest_hash: string;
  readonly preference_configuration_hash: string;
  readonly minimum_repetitions: number;
  readonly created_at: string;
}

interface ManifestReplayRow {
  readonly arm: string;
  readonly item_order: number;
  readonly skill_id: string;
  readonly skill_version: string;
  readonly definition_hash: string;
  readonly kind: string;
}

interface FixtureReplayRow {
  readonly fixture_id: string;
  readonly language: string;
  readonly origin: string;
  readonly task_type: string;
  readonly invocation_mode: string;
  readonly genre_tags_json: string;
  readonly coverage_dimensions_json: string;
  readonly contract_hash: string;
  readonly input_content_hash: string;
}

interface RunReplayRow {
  readonly suite_id: string;
  readonly status: string;
  readonly evaluation_status: string;
  readonly evaluation_result_hash: string | null;
  readonly model_assignments_json: string;
  readonly revision: number;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
}

interface CellReplayRow {
  readonly id: string;
  readonly suite_id: string;
  readonly fixture_id: string;
  readonly arm: string;
  readonly arm_configuration_hash: string | null;
  readonly model_slot_id: string;
  readonly model_tier: string;
  readonly repetition: number;
  readonly state: string;
  readonly created_at: string;
}

async function assertExactSuiteReplayOrMissing(
  transaction: TransactionExecutor,
  authority: Readonly<{
    input: CreateNovelSkillEvaluationSuiteInput;
    planHash: string;
    fixtureSetHash: string;
    targetManifestHash: string;
    coreManifestHash: string;
    coreGenreManifestHash: string;
    coreGenrePreferencesManifestHash: string;
    orderedSlots: readonly NovelSkillEvaluationModelSlot[];
    manifestItems: readonly (readonly [string, readonly NovelSkillEvaluationManifestItem[]])[];
    fixtureContracts: readonly Readonly<{
      fixture: ReturnType<typeof listNovelSkillEvaluationFixtures>[number];
      hash: string;
      inputHash: string;
    }>[];
  }>,
): Promise<boolean> {
  const [suite] = await transaction.select<SuiteReplayRow>(
    `SELECT schema_version, evaluator_version, compiler_version, evaluation_project_id,
            plan_hash, fixture_set_hash, target_manifest_hash, core_manifest_hash,
            core_genre_manifest_hash, core_genre_preferences_manifest_hash,
            preference_configuration_hash, model_slots_json, minimum_repetitions, created_at
     FROM novel_skill_evaluation_suites WHERE id = ?`,
    [authority.input.suiteId],
  );
  if (suite === undefined) return false;
  const [manifestRows, fixtureRows] = await Promise.all([
    transaction.select<ManifestReplayRow>(
      `SELECT arm, item_order, skill_id, skill_version, definition_hash, kind
       FROM novel_skill_evaluation_manifest_items
       WHERE suite_id = ? ORDER BY arm, item_order`,
      [authority.input.suiteId],
    ),
    transaction.select<FixtureReplayRow>(
      `SELECT fixture_id, language, origin, task_type, invocation_mode, genre_tags_json,
              coverage_dimensions_json, contract_hash, input_content_hash
       FROM novel_skill_evaluation_fixtures WHERE suite_id = ? ORDER BY fixture_id`,
      [authority.input.suiteId],
    ),
  ]);
  const expectedManifests = authority.manifestItems.flatMap(([arm, items]) =>
    items.map((item, index) => ({
      arm,
      item_order: index + 1,
      skill_id: item.skillId,
      skill_version: item.version,
      definition_hash: item.definitionHash,
      kind: item.kind,
    })),
  );
  const expectedFixtures = authority.fixtureContracts
    .map(({ fixture, hash, inputHash }) => ({
      fixture_id: fixture.fixtureId,
      language: "zh-CN",
      origin: "inkshadow_original_short_contract",
      task_type: fixture.taskType,
      invocation_mode: fixture.invocationMode,
      genre_tags_json: JSON.stringify(fixture.genreTags),
      coverage_dimensions_json: JSON.stringify(fixture.coverageDimensions),
      contract_hash: hash,
      input_content_hash: inputHash,
    }))
    .sort((left, right) => left.fixture_id.localeCompare(right.fixture_id, "en"));
  const exact =
    suite.schema_version === 1 &&
    suite.evaluator_version === "novel-skill-ab@1" &&
    suite.compiler_version === authority.input.plan.compilerVersion &&
    suite.evaluation_project_id === authority.input.evaluationProjectId &&
    suite.plan_hash === authority.planHash &&
    suite.fixture_set_hash === authority.fixtureSetHash &&
    suite.target_manifest_hash === authority.targetManifestHash &&
    suite.core_manifest_hash === authority.coreManifestHash &&
    suite.core_genre_manifest_hash === authority.coreGenreManifestHash &&
    suite.core_genre_preferences_manifest_hash === authority.coreGenrePreferencesManifestHash &&
    suite.preference_configuration_hash === authority.input.preferenceConfigurationHash &&
    suite.model_slots_json === JSON.stringify(authority.orderedSlots) &&
    suite.minimum_repetitions === 2 &&
    suite.created_at === authority.input.createdAt &&
    canonicalJson(manifestRows) === canonicalJson(expectedManifests) &&
    canonicalJson(fixtureRows) === canonicalJson(expectedFixtures);
  if (!exact) {
    throw storeError(
      EVALUATION_CONFLICT_CODE,
      "An evaluation suite with this id already exists under different canonical authority.",
    );
  }
  return true;
}

async function assertExactRunReplayOrMissing(
  transaction: TransactionExecutor,
  authority: Readonly<{
    input: CreateNovelSkillEvaluationRunInput;
    assignments: readonly NovelSkillEvaluationModelAssignment[];
    slots: readonly NovelSkillEvaluationModelSlot[];
    suite: SuiteRow;
  }>,
): Promise<boolean> {
  const [run] = await transaction.select<RunReplayRow>(
    `SELECT suite_id, status, evaluation_status, evaluation_result_hash,
            model_assignments_json, revision, started_at, completed_at, created_at
     FROM novel_skill_evaluation_runs WHERE id = ?`,
    [authority.input.runId],
  );
  if (run === undefined) return false;
  const fixtures = await transaction.select<{ readonly fixture_id: string }>(
    `SELECT fixture_id FROM novel_skill_evaluation_fixtures
     WHERE suite_id = ? ORDER BY fixture_id`,
    [authority.input.suiteId],
  );
  const cells = await transaction.select<CellReplayRow>(
    `SELECT id, suite_id, fixture_id, arm, arm_configuration_hash,
            model_slot_id, model_tier, repetition, state, created_at
     FROM novel_skill_evaluation_cells WHERE run_id = ?
     ORDER BY fixture_id, arm, model_slot_id, repetition`,
    [authority.input.runId],
  );
  const expectedCells: CellReplayRow[] = [];
  for (const { fixture_id: fixtureId } of fixtures) {
    for (const arm of NOVEL_SKILL_EVALUATION_ARMS) {
      for (const slot of authority.slots) {
        for (const repetition of [1, 2] as const) {
          expectedCells.push({
            id: await deterministicCellId(
              authority.input.runId,
              fixtureId,
              arm,
              slot.slotId,
              repetition,
            ),
            suite_id: authority.input.suiteId,
            fixture_id: fixtureId,
            arm,
            arm_configuration_hash: armHash(authority.suite, arm),
            model_slot_id: slot.slotId,
            model_tier: slot.modelTier,
            repetition,
            state: "planned",
            created_at: authority.input.createdAt,
          });
        }
      }
    }
  }
  expectedCells.sort((left, right) =>
    compareBinaryText(
      `${left.fixture_id}/${left.arm}/${left.model_slot_id}/${String(left.repetition)}`,
      `${right.fixture_id}/${right.arm}/${right.model_slot_id}/${String(right.repetition)}`,
    ),
  );
  const exact =
    run.suite_id === authority.input.suiteId &&
    run.status === "planned" &&
    run.evaluation_status === "NOT_EVALUATED" &&
    run.evaluation_result_hash === null &&
    run.model_assignments_json === JSON.stringify(authority.assignments) &&
    run.revision === 1 &&
    run.started_at === null &&
    run.completed_at === null &&
    run.created_at === authority.input.createdAt &&
    canonicalJson(cells) === canonicalJson(expectedCells);
  if (!exact) {
    throw storeError(
      EVALUATION_CONFLICT_CODE,
      "An evaluation run with this id already exists under different canonical authority.",
    );
  }
  return true;
}

interface CellEvidenceRow {
  readonly fixture_id: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly arm_configuration_hash: string | null;
  readonly model_slot_id: NovelSkillEvaluationModelSlot["slotId"];
  readonly model_tier: string;
  readonly repetition: number;
  readonly state: "planned" | "observed" | "invalidated";
  readonly run_status: "planned" | "running" | "completed" | "invalidated";
  readonly model_assignments_json: string;
  readonly preference_configuration_hash: string;
}

interface SettledObservationRepairRow {
  readonly attempt_id: string;
  readonly planned_context_trace_id: string;
  readonly planned_model_invocation_id: string;
  readonly output_candidate_id: string | null;
  readonly provider_visible_output_hash: string | null;
  readonly terminal_at: string | null;
  readonly fixture_id: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly model_slot_id: NovelSkillEvaluationObservation["modelSlotId"];
  readonly model_tier: string;
  readonly repetition: number;
  readonly finish_reason: string | null;
  readonly visible_content_length: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly estimated_cost_micros: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly content: string;
  readonly content_checksum: string;
  readonly existing_observation_id: string | null;
  readonly observed_attempt_id: string | null;
  readonly observed_trace_id: string | null;
  readonly observed_invocation_id: string | null;
  readonly observed_candidate_id: string | null;
  readonly observed_result_hash: string | null;
}

interface InvocationEvidenceRow {
  readonly task: string;
  readonly status: string;
  readonly connection_id: string;
  readonly catalog_entry_id: string | null;
  readonly provider_kind_snapshot: string;
  readonly model_id_snapshot: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly error_code: string | null;
  readonly finish_reason: string | null;
  readonly visible_content_length: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly estimated_cost_micros: string | null;
}

interface EvaluationObservationRow {
  readonly id: string;
  readonly fixture_id: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly model_slot_id: NovelSkillEvaluationModelSlot["slotId"];
  readonly model_tier: string;
  readonly repetition: number;
  readonly model_invocation_id: string;
  readonly novel_skill_snapshot_id: string | null;
  readonly evaluator_version: "novel-skill-ab@1";
  readonly latency_milliseconds: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly estimated_cost_micros: number | null;
  readonly visible_content_length: number;
  readonly finish_reason: string | null;
  readonly metric: (typeof NOVEL_SKILL_EVALUATION_METRICS)[number];
  readonly score_basis_points: number | null;
}

interface EvidenceChainRow {
  readonly observation_id: string;
  readonly cell_id: string;
  readonly attempt_id: string;
  readonly context_trace_id: string;
  readonly model_invocation_id: string;
  readonly output_candidate_id: string;
  readonly novel_skill_snapshot_id: string | null;
  readonly model_identity_hash: string;
  readonly model_artifact_hash: string;
  readonly observed_arm_hash: string | null;
  readonly preference_configuration_hash: string | null;
  readonly result_hash: string;
  readonly latency_milliseconds: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly estimated_cost_micros: number | null;
  readonly fixture_id: string;
  readonly fixture_task_type: string;
  readonly fixture_invocation_mode: string;
  readonly fixture_genre_tags_json: string;
  readonly fixture_input_hash: string;
  readonly fixture_contract_hash: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly cell_arm_hash: string | null;
  readonly model_slot_id: NovelSkillEvaluationModelSlot["slotId"];
  readonly repetition: number;
  readonly model_assignments_json: string;
  readonly suite_compiler_version: string;
  readonly evaluation_project_id: string;
  readonly attempt_status: string;
  readonly attempt_trace_id: string | null;
  readonly attempt_invocation_id: string | null;
  readonly invocation_task: string;
  readonly invocation_status: string;
  readonly connection_id: string;
  readonly catalog_entry_id: string | null;
  readonly provider_kind_snapshot: string;
  readonly model_id_snapshot: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly error_code: string | null;
  readonly finish_reason: string | null;
  readonly visible_content_length: number | null;
  readonly invocation_input_tokens: number | null;
  readonly invocation_output_tokens: number | null;
  readonly invocation_estimated_cost_micros: string | null;
  readonly trace_project_id: string;
  readonly trace_chapter_id: string | null;
  readonly trace_task_type: string;
  readonly trace_maximum_context_tokens: number;
  readonly trace_required_tokens: number;
  readonly trace_used_tokens: number;
  readonly trace_remaining_tokens: number;
  readonly trace_discarded_tokens: number;
  readonly trace_token_estimate_source: string;
  readonly trace_candidate_count: number;
  readonly trace_included_count: number;
  readonly trace_discarded_count: number;
  readonly generation_id: string;
  readonly generation_run_id: string | null;
  readonly execution_created_at: string;
  readonly candidate_project_id: string;
  readonly candidate_chapter_id: string | null;
  readonly candidate_base_version_id: string | null;
  readonly candidate_content: string;
  readonly candidate_checksum: string;
  readonly candidate_status: string;
  readonly candidate_incomplete: number;
  readonly snapshot_compiler_version: string | null;
  readonly snapshot_configuration_json: string | null;
}

interface RunCellRow {
  readonly id: string;
  readonly fixture_id: string;
  readonly task_type: string;
  readonly invocation_mode: string;
  readonly genre_tags_json: string;
  readonly input_content_hash: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly model_slot_id: NovelSkillEvaluationModelSlot["slotId"];
  readonly model_tier: string;
  readonly repetition: number;
  readonly state: "planned" | "observed" | "invalidated";
  readonly evidence_collected: number;
  readonly attempt_count: number;
  readonly latest_attempt_id: string | null;
  readonly latest_attempt_status: "started" | "succeeded" | "failed" | "cancelled" | null;
  readonly latest_attempt_started_at: string | null;
  readonly latest_attempt_context_trace_id: string | null;
  readonly latest_attempt_model_invocation_id: string | null;
}

interface RunProgressRow {
  readonly id: string;
  readonly suite_id: string;
  readonly status: "planned" | "running" | "completed" | "invalidated";
  readonly evaluation_status: NovelSkillEvaluationStatus;
  readonly evaluation_result_hash: string | null;
  readonly model_slots_json: string;
  readonly revision: number;
  readonly evaluation_project_id: string;
  readonly total_cells: number;
  readonly evidence_collected_cells: number;
  readonly scored_cells: number;
}

interface DecisionRunRow {
  readonly status: "completed" | "invalidated";
  readonly evaluation_status: NovelSkillEvaluationStatus;
  readonly evaluation_result_hash: string | null;
  readonly target_manifest_hash: string;
  readonly model_slots_json: string;
}

async function assertStoredSuitePlan(
  transaction: TransactionExecutor,
  runId: string,
): Promise<void> {
  const suites = await transaction.select<{
    readonly evaluator_version: string;
    readonly compiler_version: string;
    readonly plan_hash: string;
    readonly fixture_set_hash: string;
    readonly target_manifest_hash: string;
    readonly core_manifest_hash: string;
    readonly core_genre_manifest_hash: string;
    readonly core_genre_preferences_manifest_hash: string;
    readonly preference_configuration_hash: string;
    readonly model_slots_json: string;
    readonly minimum_repetitions: number;
  }>(
    `SELECT suite.evaluator_version, suite.compiler_version, suite.plan_hash,
            suite.fixture_set_hash, suite.target_manifest_hash, suite.core_manifest_hash,
            suite.core_genre_manifest_hash, suite.core_genre_preferences_manifest_hash,
            suite.preference_configuration_hash, suite.model_slots_json,
            suite.minimum_repetitions
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
     WHERE run.id = ?`,
    [runId],
  );
  const suite = suites[0];
  if (suite === undefined) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Evaluation suite is missing.");
  }
  const fixtures = await transaction.select<{
    readonly fixture_id: string;
    readonly language: string;
    readonly origin: string;
    readonly task_type: string;
    readonly invocation_mode: string;
    readonly genre_tags_json: string;
    readonly coverage_dimensions_json: string;
    readonly contract_hash: string;
    readonly input_content_hash: string;
  }>(
    `SELECT fixture.fixture_id, fixture.language, fixture.origin, fixture.task_type,
            fixture.invocation_mode, fixture.genre_tags_json,
            fixture.coverage_dimensions_json, fixture.contract_hash,
            fixture.input_content_hash
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_fixtures AS fixture ON fixture.suite_id = run.suite_id
     WHERE run.id = ?`,
    [runId],
  );
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.fixture_id, fixture] as const));
  const registryMatches = NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.every((expected) => {
    const actual = fixturesById.get(expected.fixtureId);
    return (
      actual?.language === expected.language &&
      actual.origin === expected.origin &&
      actual.task_type === expected.taskType &&
      actual.invocation_mode === expected.invocationMode &&
      actual.genre_tags_json === JSON.stringify(expected.genreTags) &&
      actual.coverage_dimensions_json === JSON.stringify(expected.coverageDimensions) &&
      actual.contract_hash === expected.contractHash &&
      actual.input_content_hash === expected.inputContentHash
    );
  });
  const manifests = await transaction.select<{
    readonly arm: Exclude<NovelSkillEvaluationArm, "no_skill">;
    readonly skill_id: string;
    readonly skill_version: string;
    readonly definition_hash: string;
    readonly kind: "core" | "genre";
  }>(
    `SELECT manifest.arm, manifest.skill_id, manifest.skill_version,
            manifest.definition_hash, manifest.kind
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_manifest_items AS manifest
       ON manifest.suite_id = run.suite_id
     WHERE run.id = ? ORDER BY manifest.arm, manifest.item_order`,
    [runId],
  );
  const hashArm = (arm: Exclude<NovelSkillEvaluationArm, "no_skill">) =>
    manifestHash(
      manifests
        .filter((manifest) => manifest.arm === arm)
        .map((manifest) => ({
          skillId: manifest.skill_id,
          version: manifest.skill_version,
          definitionHash: manifest.definition_hash,
          kind: manifest.kind,
        })),
      arm,
    );
  const [coreManifestHash, coreGenreManifestHash, coreGenrePreferencesManifestHash] =
    await Promise.all([hashArm("core"), hashArm("core_genre"), hashArm("core_genre_preferences")]);
  const targetManifestHash = await sha256Hex(
    canonicalJson({
      coreManifestHash,
      coreGenreManifestHash,
      coreGenrePreferencesManifestHash,
      preferenceConfigurationHash: suite.preference_configuration_hash,
    }),
  );
  const modelSlots = parseModelSlots(suite.model_slots_json);
  const planHash = await sha256Hex(
    canonicalJson({
      compilerVersion: suite.compiler_version,
      evaluatorVersion: suite.evaluator_version,
      fixtureSetHash: NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH,
      minimumRepetitions: 2,
      modelSlots,
      targetManifestHash,
    }),
  );
  if (
    fixtures.length !== NOVEL_SKILL_EVALUATION_FIXTURE_REGISTRY.length ||
    !registryMatches ||
    suite.fixture_set_hash !== NOVEL_SKILL_EVALUATION_FIXTURE_SET_HASH ||
    suite.minimum_repetitions !== 2 ||
    suite.core_manifest_hash !== coreManifestHash ||
    suite.core_genre_manifest_hash !== coreGenreManifestHash ||
    suite.core_genre_preferences_manifest_hash !== coreGenrePreferencesManifestHash ||
    suite.target_manifest_hash !== targetManifestHash ||
    suite.plan_hash !== planHash
  ) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Stored evaluation suite no longer matches the pinned fixture and plan contract.",
    );
  }
}

async function assertEvaluationProjectClean(
  transaction: TransactionExecutor,
  runId: string,
): Promise<void> {
  const rows = await transaction.select<{
    readonly status: string;
    readonly archived_at: string | null;
    readonly trashed_at: string | null;
    readonly chapters: number;
    readonly story_facts: number;
    readonly project_seeds: number;
    readonly planning_candidates: number;
    readonly writing_preferences: number;
    readonly settings_receipts: number;
    readonly skill_bindings: number;
  }>(
    `SELECT project.status, project.archived_at, project.trashed_at,
            (SELECT count(*) FROM chapters WHERE project_id = project.id) AS chapters,
            (SELECT count(*) FROM story_facts WHERE project_id = project.id) AS story_facts,
            (SELECT count(*) FROM project_seeds WHERE project_id = project.id) AS project_seeds,
            (SELECT count(*) FROM story_planning_candidates WHERE project_id = project.id)
              AS planning_candidates,
            (SELECT count(*) FROM writing_preferences WHERE project_id = project.id)
              AS writing_preferences,
            (SELECT count(*) FROM story_settings_import_receipts WHERE project_id = project.id)
              AS settings_receipts,
            (SELECT count(*) FROM project_novel_skill_bindings WHERE project_id = project.id)
              AS skill_bindings
     FROM novel_skill_evaluation_runs AS run
     INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
     INNER JOIN projects AS project ON project.id = suite.evaluation_project_id
     WHERE run.id = ?`,
    [runId],
  );
  const row = rows[0];
  if (
    row?.status !== "archived" ||
    row.archived_at === null ||
    row.trashed_at !== null ||
    row.chapters !== 0 ||
    row.story_facts !== 0 ||
    row.project_seeds !== 0 ||
    row.planning_candidates !== 0 ||
    row.writing_preferences !== 0 ||
    row.settings_receipts !== 0 ||
    row.skill_bindings !== 0
  ) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation workspace is no longer archived and content-free.",
    );
  }
}

function normalizeRunCell(row: RunCellRow): NovelSkillEvaluationCellRecord {
  let genreTags: unknown;
  try {
    genreTags = JSON.parse(row.genre_tags_json);
  } catch (cause) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Stored evaluation fixture genre tags are invalid.",
      cause,
    );
  }
  if (
    !isPortableLocatorArray(genreTags, 64) ||
    genreTags.length < 1 ||
    genreTags.some((tag) => !isPortableLocator(tag, 64))
  ) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Stored evaluation fixture genre tags are invalid.");
  }
  return Object.freeze({
    id: row.id,
    fixtureId: row.fixture_id,
    taskType: row.task_type,
    invocationMode: row.invocation_mode,
    genreTags: Object.freeze(genreTags.slice()),
    fixtureInputContentHash: row.input_content_hash,
    arm: row.arm,
    modelSlotId: row.model_slot_id,
    modelTier: row.model_tier,
    repetition: row.repetition,
    state: row.state,
    evidenceCollected: row.evidence_collected === 1,
    attemptCount: row.attempt_count,
    latestAttemptId: row.latest_attempt_id,
    latestAttemptStatus: row.latest_attempt_status,
    latestAttemptStartedAt: row.latest_attempt_started_at,
    latestAttemptContextTraceId: row.latest_attempt_context_trace_id,
    latestAttemptModelInvocationId: row.latest_attempt_model_invocation_id,
  });
}

async function readObservations(
  transaction: TransactionExecutor,
  runId: string,
): Promise<readonly NovelSkillEvaluationObservation[]> {
  const rows = await transaction.select<EvaluationObservationRow>(
    `SELECT observation.id, cell.fixture_id, cell.arm, cell.model_slot_id, cell.model_tier,
            cell.repetition, observation.model_invocation_id, observation.evaluator_version,
            observation.latency_milliseconds, observation.input_tokens, observation.output_tokens,
            observation.estimated_cost_micros, invocation.visible_content_length,
            invocation.finish_reason, observation.novel_skill_snapshot_id,
            score.metric, score.score_basis_points
     FROM novel_skill_evaluation_observations AS observation
     INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = observation.cell_id
     INNER JOIN model_invocation_facts AS invocation ON invocation.id = observation.model_invocation_id
     INNER JOIN novel_skill_evaluation_scores AS score ON score.observation_id = observation.id
     WHERE observation.run_id = ? ORDER BY observation.id, score.metric`,
    [runId],
  );
  const grouped = new Map<string, EvaluationObservationRow[]>();
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
  return Object.freeze(
    await Promise.all(
      [...grouped.values()].map(async (values) => {
        const first = values[0];
        if (first === undefined || values.length !== NOVEL_SKILL_EVALUATION_METRICS.length) {
          throw storeError(EVALUATION_EVIDENCE_CODE, "Stored evaluation scores are incomplete.");
        }
        const scores = Object.fromEntries(
          values.map(({ metric, score_basis_points }) => [
            metric,
            score_basis_points === null ? null : score_basis_points / 10_000,
          ]),
        ) as NovelSkillEvaluationObservation["scores"];
        const methodApplicability = await readMethodApplicability(
          transaction,
          first.novel_skill_snapshot_id,
          first.arm,
        );
        return {
          observationId: first.id,
          fixtureId: first.fixture_id,
          arm: first.arm,
          modelSlotId: first.model_slot_id,
          modelTier: first.model_tier,
          repetition: first.repetition,
          modelInvocationId: first.model_invocation_id,
          evaluatorVersion: first.evaluator_version,
          completionStatus: "succeeded",
          visibleContentLength: first.visible_content_length,
          finishReason: first.finish_reason,
          methodApplicability,
          scores,
          latencyMilliseconds: first.latency_milliseconds,
          inputTokens: first.input_tokens,
          outputTokens: first.output_tokens,
          estimatedCostMicros: first.estimated_cost_micros,
        } satisfies NovelSkillEvaluationObservation;
      }),
    ),
  );
}

async function readVerifiedEvidenceDigest(
  transaction: TransactionExecutor,
  runId: string,
): Promise<string> {
  const expectedRows = await transaction.select<{ readonly count: number }>(
    "SELECT count(*) AS count FROM novel_skill_evaluation_observations WHERE run_id = ?",
    [runId],
  );
  const rows = await transaction.select<EvidenceChainRow>(
    `SELECT
       observation.id AS observation_id, observation.cell_id, observation.attempt_id,
       observation.context_trace_id, observation.model_invocation_id,
       observation.output_candidate_id, observation.novel_skill_snapshot_id,
       observation.model_identity_hash, observation.model_artifact_hash,
       observation.arm_configuration_hash AS observed_arm_hash,
       observation.preference_configuration_hash, observation.result_hash,
       observation.latency_milliseconds, observation.input_tokens,
       observation.output_tokens, observation.estimated_cost_micros,
       cell.fixture_id, fixture.task_type AS fixture_task_type,
       fixture.invocation_mode AS fixture_invocation_mode,
       fixture.genre_tags_json AS fixture_genre_tags_json,
       fixture.input_content_hash AS fixture_input_hash,
       fixture.contract_hash AS fixture_contract_hash,
       cell.arm, cell.arm_configuration_hash AS cell_arm_hash,
       cell.model_slot_id, cell.repetition, run.model_assignments_json,
       suite.compiler_version AS suite_compiler_version,
       suite.evaluation_project_id, attempt.status AS attempt_status,
       attempt.context_trace_id AS attempt_trace_id,
       attempt.model_invocation_id AS attempt_invocation_id,
       invocation.task AS invocation_task, invocation.status AS invocation_status,
       invocation.connection_id, invocation.catalog_entry_id,
       invocation.provider_kind_snapshot, invocation.model_id_snapshot,
       invocation.started_at, invocation.completed_at, invocation.error_code,
       invocation.finish_reason, invocation.visible_content_length,
       invocation.input_tokens AS invocation_input_tokens,
       invocation.output_tokens AS invocation_output_tokens,
       invocation.estimated_cost_micros AS invocation_estimated_cost_micros,
       trace.project_id AS trace_project_id, trace.chapter_id AS trace_chapter_id,
       trace.task_type AS trace_task_type,
       trace.maximum_context_tokens AS trace_maximum_context_tokens,
       trace.required_tokens AS trace_required_tokens,
       trace.used_tokens AS trace_used_tokens,
       trace.remaining_tokens AS trace_remaining_tokens,
       trace.discarded_tokens AS trace_discarded_tokens,
       trace.token_estimate_source AS trace_token_estimate_source,
       trace.candidate_count AS trace_candidate_count,
       trace.included_count AS trace_included_count,
       trace.discarded_count AS trace_discarded_count,
       execution_link.generation_id, execution_link.generation_run_id,
       execution_link.created_at AS execution_created_at,
       candidate.project_id AS candidate_project_id,
       candidate.chapter_id AS candidate_chapter_id,
       candidate.base_version_id AS candidate_base_version_id,
       candidate.content AS candidate_content,
       candidate.content_checksum AS candidate_checksum,
       candidate.status AS candidate_status,
       candidate.incomplete AS candidate_incomplete,
       snapshot.compiler_version AS snapshot_compiler_version,
       snapshot.configuration_snapshot_json AS snapshot_configuration_json
     FROM novel_skill_evaluation_observations AS observation
     INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = observation.cell_id
     INNER JOIN novel_skill_evaluation_runs AS run ON run.id = observation.run_id
     INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = run.suite_id
     INNER JOIN novel_skill_evaluation_fixtures AS fixture
       ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id
     INNER JOIN novel_skill_evaluation_attempts AS attempt
       ON attempt.id = observation.attempt_id AND attempt.run_id = run.id
      AND attempt.cell_id = cell.id
     INNER JOIN model_invocation_facts AS invocation
       ON invocation.id = observation.model_invocation_id
     INNER JOIN context_compilation_runs AS trace
       ON trace.id = observation.context_trace_id
     INNER JOIN context_compilation_execution_links AS execution_link
       ON execution_link.trace_id = trace.id
     INNER JOIN context_compilation_model_invocation_links AS model_link
       ON model_link.trace_id = trace.id
      AND model_link.model_invocation_id = invocation.id
     INNER JOIN context_compilation_output_candidate_links AS output_link
       ON output_link.trace_id = trace.id
      AND output_link.ai_candidate_id = observation.output_candidate_id
     INNER JOIN ai_candidates AS candidate ON candidate.id = output_link.ai_candidate_id
     LEFT JOIN novel_skill_invocation_snapshots AS snapshot
       ON snapshot.id = observation.novel_skill_snapshot_id
      AND snapshot.context_trace_id = trace.id
      AND snapshot.model_invocation_id = invocation.id
     WHERE observation.run_id = ?
     ORDER BY cell.fixture_id, cell.arm, cell.model_slot_id, cell.repetition`,
    [runId],
  );
  if (rows.length !== (expectedRows[0]?.count ?? -1)) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Stored evaluation evidence has lost an exact trace, model or Candidate link.",
    );
  }
  const digestRows: unknown[] = [];
  for (const row of rows) {
    const invocation: InvocationEvidenceRow = {
      task: row.invocation_task,
      status: row.invocation_status,
      connection_id: row.connection_id,
      catalog_entry_id: row.catalog_entry_id,
      provider_kind_snapshot: row.provider_kind_snapshot,
      model_id_snapshot: row.model_id_snapshot,
      started_at: row.started_at,
      completed_at: row.completed_at,
      error_code: row.error_code,
      finish_reason: row.finish_reason,
      visible_content_length: row.visible_content_length,
      input_tokens: row.invocation_input_tokens,
      output_tokens: row.invocation_output_tokens,
      estimated_cost_micros: row.invocation_estimated_cost_micros,
    };
    const modelIdentityHash = await hashNovelSkillEvaluationModelIdentity({
      catalogEntryId: row.catalog_entry_id,
      connectionId: row.connection_id,
      modelId: row.model_id_snapshot,
      providerKind: row.provider_kind_snapshot,
    });
    const modelArtifactHash = await hashNovelSkillEvaluationModelArtifact({
      modelId: row.model_id_snapshot,
      providerKind: row.provider_kind_snapshot,
    });
    const assignment = parseAssignments(row.model_assignments_json).find(
      ({ slotId }) => slotId === row.model_slot_id,
    );
    const actualArmHash = await readActualArmHash(
      transaction,
      row.model_invocation_id,
      row.context_trace_id,
      row.novel_skill_snapshot_id,
      row.arm,
    );
    const preferenceHash = await readPreferenceConfigurationHash(transaction, row.context_trace_id);
    const sources = await readAndValidateTraceSources(transaction, row);
    const skillItems = await readNovelSkillItemDigest(transaction, row.novel_skill_snapshot_id);
    const latency = invocationLatencyMilliseconds(invocation);
    const actualCandidateHash = await sha256Hex(row.candidate_content);
    if (
      !usableInvocation(invocation) ||
      row.attempt_status !== "succeeded" ||
      row.attempt_trace_id !== row.context_trace_id ||
      row.attempt_invocation_id !== row.model_invocation_id ||
      row.invocation_task !== row.fixture_task_type ||
      row.trace_task_type !== row.fixture_task_type ||
      row.trace_project_id !== row.evaluation_project_id ||
      row.trace_chapter_id !== null ||
      row.candidate_project_id !== row.evaluation_project_id ||
      row.candidate_chapter_id !== null ||
      row.candidate_base_version_id !== null ||
      row.candidate_status !== "ready" ||
      row.candidate_incomplete !== 0 ||
      row.candidate_content.length === 0 ||
      actualCandidateHash !== row.candidate_checksum ||
      row.candidate_checksum !== row.result_hash ||
      Array.from(row.candidate_content).length !== row.visible_content_length ||
      modelIdentityHash !== row.model_identity_hash ||
      modelArtifactHash !== row.model_artifact_hash ||
      assignment?.modelIdentityHash !== modelIdentityHash ||
      assignment.modelArtifactHash !== modelArtifactHash ||
      actualArmHash !== row.cell_arm_hash ||
      actualArmHash !== row.observed_arm_hash ||
      preferenceHash !== row.preference_configuration_hash ||
      latency !== row.latency_milliseconds ||
      row.input_tokens !== row.invocation_input_tokens ||
      row.output_tokens !== row.invocation_output_tokens ||
      row.estimated_cost_micros !== parseCost(row.invocation_estimated_cost_micros) ||
      (row.arm === "no_skill"
        ? row.novel_skill_snapshot_id !== null || row.snapshot_compiler_version !== null
        : row.novel_skill_snapshot_id === null ||
          row.snapshot_compiler_version !== row.suite_compiler_version)
    ) {
      throw storeError(
        EVALUATION_EVIDENCE_CODE,
        "Stored evaluation evidence no longer matches its exact immutable chain.",
      );
    }
    if (row.snapshot_configuration_json !== null) {
      assertSnapshotConfigurationMatchesTrace(row, sources);
    }
    digestRows.push({
      observationId: row.observation_id,
      cellId: row.cell_id,
      attemptId: row.attempt_id,
      contextTraceId: row.context_trace_id,
      modelInvocationId: row.model_invocation_id,
      outputCandidateId: row.output_candidate_id,
      novelSkillSnapshotId: row.novel_skill_snapshot_id,
      modelIdentityHash,
      modelArtifactHash,
      armConfigurationHash: actualArmHash,
      preferenceConfigurationHash: preferenceHash,
      resultHash: row.result_hash,
      latencyMilliseconds: latency,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostMicros: row.estimated_cost_micros,
      execution: {
        generationId: row.generation_id,
        generationRunId: row.generation_run_id,
        createdAt: row.execution_created_at,
      },
      trace: {
        maximumContextTokens: row.trace_maximum_context_tokens,
        requiredTokens: row.trace_required_tokens,
        usedTokens: row.trace_used_tokens,
        remainingTokens: row.trace_remaining_tokens,
        discardedTokens: row.trace_discarded_tokens,
        tokenEstimateSource: row.trace_token_estimate_source,
        candidateCount: row.trace_candidate_count,
        includedCount: row.trace_included_count,
        discardedCount: row.trace_discarded_count,
      },
      sources,
      skillItems,
    });
  }
  const scores = await transaction.select<{
    readonly observation_id: string;
    readonly metric: string;
    readonly score_basis_points: number;
    readonly reviewer_id: string;
    readonly rubric_version: string;
    readonly scored_at: string;
  }>(
    `SELECT score.observation_id, score.metric, score.score_basis_points,
            score.reviewer_id, score.rubric_version, score.scored_at
     FROM novel_skill_evaluation_scores AS score
     INNER JOIN novel_skill_evaluation_observations AS observation
       ON observation.id = score.observation_id
     WHERE observation.run_id = ?
     ORDER BY score.observation_id, score.metric`,
    [runId],
  );
  const attempts = await transaction.select<{
    readonly id: string;
    readonly cell_id: string;
    readonly attempt_number: number;
    readonly status: string;
    readonly context_trace_id: string | null;
    readonly model_invocation_id: string | null;
    readonly error_code: string | null;
    readonly started_at: string;
    readonly completed_at: string | null;
  }>(
    `SELECT id, cell_id, attempt_number, status, context_trace_id,
            model_invocation_id, error_code, started_at, completed_at
     FROM novel_skill_evaluation_attempts
     WHERE run_id = ? ORDER BY cell_id, attempt_number`,
    [runId],
  );
  const runState = await transaction.select<{ readonly status: string }>(
    "SELECT status FROM novel_skill_evaluation_runs WHERE id = ?",
    [runId],
  );
  if (
    (runState[0]?.status === "completed" || rows.length === 192) &&
    (attempts.length !== rows.length ||
      attempts.some(
        (attempt) =>
          attempt.attempt_number !== 1 ||
          attempt.status !== "succeeded" ||
          attempt.error_code !== null ||
          attempt.completed_at === null ||
          !digestRows.some(
            (evidence) =>
              (evidence as { readonly attemptId: string }).attemptId === attempt.id &&
              (evidence as { readonly cellId: string }).cellId === attempt.cell_id &&
              (evidence as { readonly contextTraceId: string }).contextTraceId ===
                attempt.context_trace_id &&
              (evidence as { readonly modelInvocationId: string }).modelInvocationId ===
                attempt.model_invocation_id,
          ),
      ))
  ) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "A completed evaluation requires one successful paid attempt per exact cell.",
    );
  }
  return sha256Hex(canonicalJson({ attempts, evidence: digestRows, scores }));
}

function evaluationResultHash(
  result: NovelSkillEvaluationResult,
  evidenceDigest: string,
): Promise<string> {
  return sha256Hex(canonicalJson({ evaluationResult: result, evidenceDigest }));
}

interface TraceSourceDigestRow {
  readonly candidateId: string;
  readonly layer: string;
  readonly selectionReason: string;
  readonly included: boolean;
  readonly discardedReason: string | null;
  readonly estimatedTokens: number;
  readonly evaluationOrder: number;
  readonly layerOrder: number;
  readonly priority: number;
  readonly relevanceScore: number | null;
  readonly required: boolean;
  readonly budgetRemainingBefore: number;
  readonly budgetRemainingAfter: number;
  readonly sourceOrder: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly locator: string | null;
  readonly contentHash: string | null;
}

async function readAndValidateTraceSources(
  transaction: TransactionExecutor,
  evidence: EvidenceChainRow,
): Promise<readonly TraceSourceDigestRow[]> {
  const rows = await transaction.select<{
    readonly candidate_id: string;
    readonly layer: string;
    readonly selection_reason: string;
    readonly included: number;
    readonly discarded_reason: string | null;
    readonly estimated_tokens: number;
    readonly evaluation_order: number;
    readonly layer_order: number;
    readonly priority: number;
    readonly relevance_score: number | null;
    readonly required: number;
    readonly budget_remaining_before: number;
    readonly budget_remaining_after: number;
    readonly source_order: number | null;
    readonly source_type: string | null;
    readonly source_id: string | null;
    readonly source_version_id: string | null;
    readonly locator: string | null;
    readonly content_hash: string | null;
  }>(
    `SELECT entry.candidate_id, entry.layer, entry.selection_reason, entry.included,
            entry.discarded_reason, entry.estimated_tokens, entry.evaluation_order,
            entry.layer_order, entry.priority, entry.relevance_score, entry.required,
            entry.budget_remaining_before, entry.budget_remaining_after,
            source.source_order, source.source_type,
            source.source_id, source.source_version_id, source.locator, source.content_hash
     FROM context_compilation_entries AS entry
     LEFT JOIN context_compilation_entry_sources AS source
       ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
     WHERE entry.run_id = ?
     ORDER BY entry.layer_order, entry.evaluation_order, source.source_order`,
    [evidence.context_trace_id],
  );
  if (rows.length === 0) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Evaluation trace has no context source.");
  }
  const entryStates = new Map<string, number>();
  for (const row of rows) entryStates.set(row.candidate_id, row.included);
  const includedCount = [...entryStates.values()].filter((included) => included === 1).length;
  if (
    entryStates.size !== evidence.trace_candidate_count ||
    includedCount !== evidence.trace_included_count ||
    entryStates.size - includedCount !== evidence.trace_discarded_count
  ) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation trace entry counts no longer match its immutable budget receipt.",
    );
  }
  const normalized: TraceSourceDigestRow[] = [];
  let hasCurrentTask = false;
  for (const row of rows) {
    if (row.source_order === null || row.source_type === null || row.source_id === null) {
      throw storeError(
        EVALUATION_EVIDENCE_CODE,
        "Evaluation trace contains an unproven context entry.",
      );
    }
    const currentTask =
      row.layer === "current_task" &&
      row.candidate_id === `evaluation-fixture:${evidence.fixture_id}` &&
      row.source_type === "user_input" &&
      row.source_id === evidence.fixture_id &&
      row.source_version_id === null &&
      row.locator === "novel_skill_evaluation_fixture" &&
      row.content_hash === evidence.fixture_input_hash;
    const fixtureLayer =
      row.layer !== "current_task" &&
      row.candidate_id === `evaluation-fixture-layer:${evidence.fixture_id}:${row.layer}` &&
      row.source_type === "user_input" &&
      row.source_id === evidence.fixture_id &&
      row.source_version_id === null &&
      row.locator === "novel_skill_evaluation_fixture_contract" &&
      row.content_hash === evidence.fixture_contract_hash;
    const preference =
      evidence.arm === "core_genre_preferences" &&
      row.candidate_id.startsWith("writing-preference:") &&
      row.source_type === "user_input" &&
      row.locator === "writing_preference" &&
      isHash(row.content_hash);
    if (!currentTask && !fixtureLayer && !preference) {
      throw storeError(
        EVALUATION_EVIDENCE_CODE,
        "Evaluation trace includes a non-evaluation project source.",
      );
    }
    hasCurrentTask ||= currentTask && row.included === 1;
    normalized.push({
      candidateId: row.candidate_id,
      layer: row.layer,
      selectionReason: row.selection_reason,
      included: row.included === 1,
      discardedReason: row.discarded_reason,
      estimatedTokens: row.estimated_tokens,
      evaluationOrder: row.evaluation_order,
      layerOrder: row.layer_order,
      priority: row.priority,
      relevanceScore: row.relevance_score,
      required: row.required === 1,
      budgetRemainingBefore: row.budget_remaining_before,
      budgetRemainingAfter: row.budget_remaining_after,
      sourceOrder: row.source_order,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      locator: row.locator,
      contentHash: row.content_hash,
    });
  }
  if (!hasCurrentTask) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation trace lacks its exact fixture task source.",
    );
  }
  return Object.freeze(normalized);
}

function assertSnapshotConfigurationMatchesTrace(
  evidence: EvidenceChainRow,
  sources: readonly TraceSourceDigestRow[],
): void {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(evidence.snapshot_configuration_json ?? "null");
  } catch (cause) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation Skill snapshot configuration is invalid.",
      cause,
    );
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation Skill snapshot configuration is invalid.",
    );
  }
  const configuration = snapshot as {
    readonly compilerVersion?: unknown;
    readonly taskType?: unknown;
    readonly invocationMode?: unknown;
    readonly genreTags?: unknown;
    readonly availableContextLayers?: unknown;
  };
  const traceLayers = [
    ...new Set(sources.filter(({ included }) => included).map(({ layer }) => layer)),
  ].sort();
  let fixtureGenres: unknown;
  try {
    fixtureGenres = JSON.parse(evidence.fixture_genre_tags_json);
  } catch {
    fixtureGenres = null;
  }
  if (
    configuration.compilerVersion !== evidence.suite_compiler_version ||
    configuration.taskType !== evidence.fixture_task_type ||
    configuration.invocationMode !== evidence.fixture_invocation_mode ||
    canonicalJson(configuration.genreTags) !== canonicalJson(fixtureGenres) ||
    canonicalJson(
      isPortableLocatorArray(configuration.availableContextLayers, 128)
        ? configuration.availableContextLayers.slice().sort()
        : configuration.availableContextLayers,
    ) !== canonicalJson(traceLayers)
  ) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation Skill snapshot does not match its fixture and trace contract.",
    );
  }
}

async function readNovelSkillItemDigest(
  transaction: TransactionExecutor,
  snapshotId: string | null,
): Promise<readonly unknown[]> {
  if (snapshotId === null) return Object.freeze([]);
  const rows = await transaction.select<{
    readonly item_order: number;
    readonly skill_id: string;
    readonly skill_version: string;
    readonly definition_hash: string;
    readonly activation_source: string;
    readonly selection_reason: string;
    readonly precedence: number;
    readonly included: number;
    readonly discarded_reason: string | null;
    readonly estimated_tokens: number;
  }>(
    `SELECT item_order, skill_id, skill_version, definition_hash, activation_source,
            selection_reason, precedence, included, discarded_reason, estimated_tokens
     FROM novel_skill_invocation_items WHERE snapshot_id = ? ORDER BY item_order`,
    [snapshotId],
  );
  if (rows.length === 0) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation Skill snapshot has lost its considered items.",
    );
  }
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

async function readActualArmHash(
  transaction: TransactionExecutor,
  invocationId: string,
  contextTraceId: string,
  snapshotId: string | null,
  arm: NovelSkillEvaluationArm,
): Promise<string | null> {
  const hiddenSnapshots = await transaction.select<{ readonly id: string }>(
    `SELECT id FROM novel_skill_invocation_snapshots WHERE model_invocation_id = ?`,
    [invocationId],
  );
  if (arm === "no_skill") {
    if (snapshotId !== null || hiddenSnapshots.length !== 0) {
      throw storeError(
        EVALUATION_EVIDENCE_CODE,
        "No-Skill evidence cannot hide a Novel Skill snapshot.",
      );
    }
    return null;
  }
  if (snapshotId === null || hiddenSnapshots[0]?.id !== snapshotId) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Skill arm lacks its exact snapshot.");
  }
  const items = await transaction.select<ManifestItemRow>(
    `SELECT item.skill_id, item.skill_version, item.definition_hash, definition.kind
     FROM novel_skill_invocation_snapshots AS snapshot
     INNER JOIN novel_skill_invocation_items AS item
       ON item.snapshot_id = snapshot.id
     INNER JOIN novel_skill_definitions AS definition
       ON definition.skill_id = item.skill_id AND definition.version = item.skill_version
     WHERE snapshot.id = ? AND snapshot.model_invocation_id = ? AND snapshot.context_trace_id = ?
     ORDER BY item.skill_id, item.skill_version`,
    [snapshotId, invocationId, contextTraceId],
  );
  if (
    items.length === 0 ||
    items.some(({ kind }) => kind === "custom") ||
    !items.some(({ kind }) => kind === "core") ||
    (arm === "core" && items.some(({ kind }) => kind !== "core")) ||
    (arm !== "core" && !items.some(({ kind }) => kind === "genre"))
  ) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Snapshot considered Skill kinds do not match the planned A/B arm.",
    );
  }
  return sha256Hex(canonicalJson(items.map(normalizeManifestRow)));
}

async function readMethodApplicability(
  transaction: TransactionExecutor,
  snapshotId: string | null,
  arm: NovelSkillEvaluationArm,
): Promise<Readonly<{ readonly core: boolean; readonly genre: boolean }>> {
  if (arm === "no_skill") {
    if (snapshotId !== null) {
      throw storeError(
        EVALUATION_EVIDENCE_CODE,
        "No-Skill evidence cannot report method applicability.",
      );
    }
    return Object.freeze({ core: false, genre: false });
  }
  if (snapshotId === null) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Skill evidence lacks its snapshot.");
  }
  const rows = await transaction.select<{
    readonly kind: "core" | "genre" | "custom";
    readonly included: number;
  }>(
    `SELECT definition.kind, item.included
     FROM novel_skill_invocation_items AS item
     INNER JOIN novel_skill_definitions AS definition
       ON definition.skill_id = item.skill_id AND definition.version = item.skill_version
     WHERE item.snapshot_id = ?`,
    [snapshotId],
  );
  return Object.freeze({
    core: rows.some(({ kind, included }) => kind === "core" && included === 1),
    genre: rows.some(({ kind, included }) => kind === "genre" && included === 1),
  });
}

async function readPreferenceConfigurationHash(
  transaction: TransactionExecutor,
  contextTraceId: string,
): Promise<string | null> {
  const rows = await transaction.select<{
    readonly source_id: string;
    readonly source_version_id: string | null;
    readonly content_hash: string | null;
  }>(
    `SELECT source.source_id, source.source_version_id, source.content_hash
     FROM context_compilation_entries AS entry
     INNER JOIN context_compilation_entry_sources AS source
       ON source.run_id = entry.run_id AND source.candidate_id = entry.candidate_id
     WHERE entry.run_id = ? AND entry.included = 1
       AND entry.candidate_id GLOB 'writing-preference:*'
       AND source.source_type = 'user_input' AND source.locator = 'writing_preference'
     ORDER BY source.source_id, source.source_version_id`,
    [contextTraceId],
  );
  if (rows.length === 0) return null;
  return hashNovelSkillEvaluationPreferenceConfiguration(
    rows.map(
      ({ source_id: sourceId, source_version_id: sourceVersionId, content_hash: contentHash }) => {
        if (!isHash(contentHash)) {
          throw storeError(
            EVALUATION_EVIDENCE_CODE,
            "Preference context evidence lacks an exact content hash.",
          );
        }
        return { sourceId, sourceVersionId, contentHash };
      },
    ),
  );
}

interface ManifestItemRow {
  readonly skill_id: string;
  readonly skill_version: string;
  readonly definition_hash: string;
  readonly kind: "core" | "genre" | "custom";
}

function normalizeManifestRow(row: ManifestItemRow): NovelSkillEvaluationManifestItem {
  if (row.kind === "custom") {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Custom Skills are outside the fixed A/B arms.");
  }
  return {
    skillId: row.skill_id,
    version: row.skill_version,
    definitionHash: row.definition_hash,
    kind: row.kind,
  };
}

function assertExactPlan(plan: NovelSkillEvaluationExecutionPlan): void {
  assertExactObjectKeys(
    plan,
    [
      "schemaVersion",
      "evaluatorVersion",
      "compilerVersion",
      "status",
      "modelSlots",
      "minimumRepetitionsPerCell",
      "cells",
      "note",
    ],
    "evaluation plan",
  );
  for (const slot of plan.modelSlots) {
    assertExactObjectKeys(slot, ["slotId", "modelTier"], "evaluation model slot");
  }
  for (const cell of plan.cells) {
    assertExactObjectKeys(
      cell,
      ["fixtureId", "arm", "modelSlotId", "modelTier", "repetition"],
      "evaluation cell",
    );
  }
  const expected = createNovelSkillEvaluationExecutionPlan(plan.modelSlots, 2);
  if (
    (plan as { readonly schemaVersion: unknown }).schemaVersion !== 1 ||
    (plan as { readonly evaluatorVersion: unknown }).evaluatorVersion !== "novel-skill-ab@1" ||
    (plan as { readonly compilerVersion: unknown }).compilerVersion !==
      NOVEL_SKILL_COMPILER_VERSION ||
    (plan as { readonly status: unknown }).status !== "NOT_EVALUATED" ||
    plan.minimumRepetitionsPerCell !== 2 ||
    canonicalJson(plan.cells) !== canonicalJson(expected.cells)
  ) {
    throw storeError(
      EVALUATION_INVALID_CODE,
      "Evaluation plan must be the exact 12 x 4 x 2 x 2 matrix.",
    );
  }
}

async function manifestHash(
  values: readonly NovelSkillEvaluationManifestItem[],
  arm: Exclude<NovelSkillEvaluationArm, "no_skill">,
): Promise<string> {
  if (values.length === 0 || values.length > 64) {
    throw storeError(EVALUATION_INVALID_CODE, `${arm} manifest is empty or too large.`);
  }
  const ordered = orderedManifest(values);
  if (
    new Set(ordered.map(({ skillId }) => skillId)).size !== ordered.length ||
    ordered.some(
      ({ skillId, version, definitionHash, kind }) =>
        !/^[a-z][a-z0-9._-]{2,95}$/u.test(skillId) ||
        !/^\d+\.\d+\.\d+$/u.test(version) ||
        !isHash(definitionHash) ||
        !["core", "genre"].includes(kind),
    ) ||
    !ordered.some(({ kind }) => kind === "core") ||
    (arm === "core" && ordered.some(({ kind }) => kind !== "core")) ||
    (arm !== "core" && !ordered.some(({ kind }) => kind === "genre"))
  ) {
    throw storeError(EVALUATION_INVALID_CODE, `${arm} manifest has invalid membership.`);
  }
  return sha256Hex(canonicalJson(ordered));
}

function orderedManifest(
  values: readonly NovelSkillEvaluationManifestItem[],
): readonly NovelSkillEvaluationManifestItem[] {
  return [...values].sort((left, right) =>
    `${left.skillId}/${left.version}`.localeCompare(`${right.skillId}/${right.version}`, "en"),
  );
}

function orderedModelSlots(
  values: readonly NovelSkillEvaluationModelSlot[],
): readonly NovelSkillEvaluationModelSlot[] {
  if (
    values.length !== 2 ||
    new Set(values.map(({ slotId }) => slotId)).size !== 2 ||
    new Set(values.map(({ modelTier }) => modelTier)).size !== 2
  ) {
    throw storeError(EVALUATION_INVALID_CODE, "Exactly two distinct model slots are required.");
  }
  return Object.freeze(
    [...values]
      .sort((left, right) => left.slotId.localeCompare(right.slotId, "en"))
      .map((value) => Object.freeze({ ...value })),
  );
}

function orderedAssignments(
  values: readonly NovelSkillEvaluationModelAssignment[],
): readonly NovelSkillEvaluationModelAssignment[] {
  if (
    values.length !== 2 ||
    new Set(values.map(({ slotId }) => slotId)).size !== 2 ||
    new Set(values.map(({ modelIdentityHash }) => modelIdentityHash)).size !== 2 ||
    new Set(values.map(({ modelArtifactHash }) => modelArtifactHash)).size !== 2 ||
    values.some((assignment) => {
      assertExactObjectKeys(
        assignment,
        ["slotId", "modelIdentityHash", "modelArtifactHash"],
        "model assignment",
      );
      return !isHash(assignment.modelIdentityHash) || !isHash(assignment.modelArtifactHash);
    })
  ) {
    throw storeError(
      EVALUATION_INVALID_CODE,
      "Run requires two distinct dispatch identities and two distinct provider/model artifacts.",
    );
  }
  return [...values].sort((left, right) => left.slotId.localeCompare(right.slotId, "en"));
}

function parseModelSlots(serialized: string): readonly NovelSkillEvaluationModelSlot[] {
  try {
    return orderedModelSlots(JSON.parse(serialized) as NovelSkillEvaluationModelSlot[]);
  } catch (cause) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Stored model slots are invalid.", cause);
  }
}

function parseAssignments(serialized: string): readonly NovelSkillEvaluationModelAssignment[] {
  try {
    return orderedAssignments(JSON.parse(serialized) as NovelSkillEvaluationModelAssignment[]);
  } catch (cause) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Stored model assignments are invalid.", cause);
  }
}

function sameSlotIds(
  slots: readonly NovelSkillEvaluationModelSlot[],
  assignments: readonly NovelSkillEvaluationModelAssignment[],
): boolean {
  return slots.every(({ slotId }) =>
    assignments.some((assignment) => assignment.slotId === slotId),
  );
}

function armHash(suite: SuiteRow, arm: NovelSkillEvaluationArm): string | null {
  if (arm === "no_skill") return null;
  if (arm === "core") return suite.core_manifest_hash;
  if (arm === "core_genre") return suite.core_genre_manifest_hash;
  return suite.core_genre_preferences_manifest_hash;
}

function assertObservationMatchesCell(
  observation: Omit<NovelSkillEvaluationObservation, "scores">,
  invocationId: string,
  cell: CellEvidenceRow,
): void {
  if (
    observation.fixtureId !== cell.fixture_id ||
    observation.arm !== cell.arm ||
    observation.modelSlotId !== cell.model_slot_id ||
    observation.modelTier !== cell.model_tier ||
    observation.repetition !== cell.repetition ||
    observation.modelInvocationId !== invocationId
  ) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Evaluation score does not match its planned cell.");
  }
}

function usableInvocation(
  value: InvocationEvidenceRow | undefined,
): value is InvocationEvidenceRow {
  return (
    value?.status === "succeeded" &&
    value.started_at !== null &&
    value.completed_at !== null &&
    value.error_code === null &&
    value.visible_content_length !== null &&
    value.visible_content_length > 0 &&
    !["length", "max_tokens", "max_output_tokens"].includes(value.finish_reason ?? "")
  );
}

function parseCost(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Invocation cost is outside the evaluation ledger range.",
    );
  }
  return parsed;
}

function invocationLatencyMilliseconds(
  invocation: Pick<InvocationEvidenceRow, "started_at" | "completed_at">,
): number {
  if (invocation.started_at === null || invocation.completed_at === null) {
    throw storeError(EVALUATION_EVIDENCE_CODE, "Evaluation invocation is missing timing evidence.");
  }
  const startedAt = Date.parse(invocation.started_at);
  const completedAt = Date.parse(invocation.completed_at);
  const elapsed = completedAt - startedAt;
  if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > 86_400_000) {
    throw storeError(
      EVALUATION_EVIDENCE_CODE,
      "Evaluation invocation timestamps produce an invalid latency.",
    );
  }
  return elapsed;
}

function assertObservationInput(
  input: RecordNovelSkillEvaluationObservationInput | RecordNovelSkillEvaluationEvidenceInput,
): void {
  assertUuidV7(input.observationId, "observationId");
  assertUuidV7(input.runId, "runId");
  assertUuidV7(input.cellId, "cellId");
  assertUuidV7(input.attemptId, "attemptId");
  assertUuidV7(input.contextTraceId, "contextTraceId");
  assertUuidV7(input.outputCandidateId, "outputCandidateId");
  if (input.novelSkillSnapshotId !== null)
    assertUuidV7(input.novelSkillSnapshotId, "novelSkillSnapshotId");
  assertIsoUtc(input.createdAt, "createdAt");
  assertHash(input.resultHash, "resultHash");
  if (input.preferenceConfigurationHash !== null) {
    assertHash(input.preferenceConfigurationHash, "preferenceConfigurationHash");
  }
}

function assertScores(scores: NovelSkillEvaluationObservation["scores"]): void {
  assertExactObjectKeys(scores, [...NOVEL_SKILL_EVALUATION_METRICS], "manual scores");
  for (const metric of NOVEL_SKILL_EVALUATION_METRICS) {
    const score = scores[metric];
    if (score === null || !Number.isFinite(score) || score < 0 || score > 1) {
      throw storeError(
        EVALUATION_INVALID_CODE,
        `Manual ${metric} score must be present and between zero and one.`,
      );
    }
  }
}

function isErrorCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [
      "RUN_INVALIDATED",
      "USER_CANCELLED",
      "PRE_DISPATCH_CANCELLED",
      "PREFLIGHT_FAILED",
      "MODEL_TIMEOUT",
      "MODEL_RATE_LIMITED",
      "MODEL_AUTH_FAILED",
      "MODEL_CONNECTION_FAILED",
      "MODEL_PROVIDER_ERROR",
      "MODEL_OUTPUT_EMPTY",
      "MODEL_OUTPUT_TRUNCATED",
      "MODEL_POLICY_BLOCKED",
      "CONTEXT_COMPILATION_FAILED",
      "CANDIDATE_PERSIST_FAILED",
      "DISPATCH_INTERRUPTED",
      "UNKNOWN_PROVIDER_FAILURE",
    ].includes(value)
  );
}

async function deterministicCellId(
  runId: string,
  fixtureId: string,
  arm: string,
  slotId: string,
  repetition: number,
): Promise<string> {
  const suffix = await sha256Hex(`${runId}/${fixtureId}/${arm}/${slotId}/${String(repetition)}`);
  return `${runId.slice(0, 24)}${suffix.slice(0, 12)}`;
}

function assertUuidV7(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw storeError(EVALUATION_INVALID_CODE, `${field} must be a lowercase UUIDv7.`);
  }
}

function assertIsoUtc(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw storeError(EVALUATION_INVALID_CODE, `${field} must be an ISO UTC timestamp.`);
  }
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (!isHash(value)) {
    throw storeError("NOVEL_SKILL_EVALUATION_PRIVACY", `${field} must be a SHA-256 hash.`);
  }
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isPortableLocator(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000\t\r\n ]/u.test(value)
  );
}

function isPortableLocatorArray(value: unknown, maximumLength: number): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => isPortableLocator(entry, maximumLength));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareBinaryText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertManifestHierarchy(
  manifests: CreateNovelSkillEvaluationSuiteInput["manifests"],
): void {
  assertExactObjectKeys(manifests, ["core", "coreGenre", "coreGenrePreferences"], "manifest set");
  for (const values of [manifests.core, manifests.coreGenre, manifests.coreGenrePreferences]) {
    if (!Array.isArray(values)) {
      throw storeError(EVALUATION_INVALID_CODE, "Skill manifests must be arrays.");
    }
    for (const item of values) {
      assertExactObjectKeys(
        item,
        ["skillId", "version", "definitionHash", "kind"],
        "manifest item",
      );
    }
  }
  const core = canonicalJson(
    [...manifests.core].sort((left, right) => left.skillId.localeCompare(right.skillId, "en")),
  );
  const coreInGenre = canonicalJson(
    manifests.coreGenre
      .filter(({ kind }) => kind === "core")
      .sort((left, right) => left.skillId.localeCompare(right.skillId, "en")),
  );
  const genre = canonicalJson(
    [...manifests.coreGenre].sort((left, right) => left.skillId.localeCompare(right.skillId, "en")),
  );
  const preferenceArm = canonicalJson(
    [...manifests.coreGenrePreferences].sort((left, right) =>
      left.skillId.localeCompare(right.skillId, "en"),
    ),
  );
  if (core !== coreInGenre || genre !== preferenceArm) {
    throw storeError(
      EVALUATION_INVALID_CODE,
      "A/B manifests must add only Genre Skills, then keep identical Skill membership for preferences.",
    );
  }
}

function assertExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw storeError("NOVEL_SKILL_EVALUATION_PRIVACY", `${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw storeError(
      "NOVEL_SKILL_EVALUATION_PRIVACY",
      `${label} contains missing or unsupported fields.`,
    );
  }
}

function storeError(
  code: NovelSkillEvaluationStoreErrorCode,
  message: string,
  cause?: unknown,
): NovelSkillEvaluationStoreError {
  return new NovelSkillEvaluationStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
