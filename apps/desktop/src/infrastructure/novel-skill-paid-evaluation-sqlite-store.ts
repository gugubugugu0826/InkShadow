import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import type { AiCandidateSnapshot } from "@inkshadow/domain";

import type {
  ModelHubExactEvaluationRequestProfile,
  ModelHubExactEvaluationExecutionResult,
  ModelHubExactEvaluationInspection,
  ModelHubExactEvaluationPredispatchReceipt,
} from "./model-hub-exact-evaluation-target";
import {
  MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
  MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
  hashModelHubExactEvaluationExecutionLock,
  hashModelHubExactEvaluationRequestProfile,
} from "./model-hub-exact-evaluation-target";
import { MODEL_HUB_TEXT_TASKS, type ModelHubTextTask } from "./model-hub-execution-service";
import type { ContextCompilationTrace } from "./context-compilation-trace-store";
import {
  NovelSkillEvaluationStoreError,
  hashNovelSkillEvaluationPreferenceConfiguration,
  hashNovelSkillEvaluationModelArtifact,
  hashNovelSkillEvaluationModelIdentity,
} from "./novel-skill-evaluation-sqlite-store";
import {
  NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION,
  validateNovelSkillPaidEvaluationPayloadAuthority,
  type CompileNovelSkillPaidEvaluationPayloadInput,
  type NovelSkillPaidEvaluationAuthoritativePayload,
  type NovelSkillPaidEvaluationPayloadAuthorityManifest,
} from "./novel-skill-paid-evaluation-payload-authority";

export const NOVEL_SKILL_PAID_EVALUATION_PROTOCOL_VERSION = "novel-skill-paid-ab@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION = "novel-skill-human-rubric@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT = 192 as const;
export const NOVEL_SKILL_PAID_EVALUATION_PREDISPATCH_AUTHORITY_VERSION =
  "novel-skill-paid-predispatch-authority@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_PROVIDER_RECEIPT_SHAPE_VERSION =
  "model-hub-exact-evaluation-predispatch-receipt@1" as const;
export const NOVEL_SKILL_PAID_EVALUATION_FINAL_DISPATCH_AUTHORITY_VERSION =
  "novel-skill-paid-final-dispatch-authority@1" as const;

export interface NovelSkillPaidEvaluationRequestProfileInput {
  readonly taskType: string;
  readonly profileVersion: string;
  readonly requestProfileHash: string;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly temperatureBasisPoints: number;
  readonly topPBasisPoints: number;
  readonly streaming: true;
  readonly stopPolicyHash: string;
}

export interface NovelSkillPaidEvaluationContextBaselineInput {
  readonly fixtureId: string;
  readonly baselineContractHash: string;
  readonly includedSourceManifestHash: string;
  readonly omittedSourceManifestHash: string;
  readonly compiledBaselineHash: string;
  readonly baselineTokenBudget: number;
}

export interface NovelSkillPaidEvaluationInvariantRequestInput {
  readonly runId: string;
  readonly suiteId: string;
  readonly fixtureId: string;
  readonly taskType: string;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly repetition: 1 | 2;
  readonly protocolHash: string;
  readonly requestProfileHash: string;
  readonly contextBaselineHash: string;
  readonly promptTemplateHash: string;
}

export interface CreateNovelSkillPaidEvaluationProtocolInput {
  readonly suiteId: string;
  readonly promptTemplateVersion: string;
  readonly promptTemplateHash: string;
  readonly rubricContentHash: string;
  readonly evaluatorContractHash: string;
  readonly blindingProtocolVersion: string;
  readonly blindingProtocolHash: string;
  readonly randomizationProtocolVersion: string;
  readonly randomizationProtocolHash: string;
  readonly requestProfiles: readonly NovelSkillPaidEvaluationRequestProfileInput[];
  readonly contextBaselines: readonly NovelSkillPaidEvaluationContextBaselineInput[];
  readonly createdAt: string;
}

export interface NovelSkillPaidEvaluationProtocolRecord {
  readonly suiteId: string;
  readonly protocolHash: string;
  readonly requestProfileManifestHash: string;
  readonly contextBaselineManifestHash: string;
  readonly promptTemplateHash: string;
  readonly rubricContentHash: string;
}

export interface BindNovelSkillPaidEvaluationTargetInput {
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly inspection: ModelHubExactEvaluationInspection;
  readonly artifactIdentitySource: "provider_model_id";
}

export interface NovelSkillPaidEvaluationTargetRecord {
  readonly runId: string;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: string;
  readonly providerModelId: string;
  readonly modelIdentityHash: string;
  readonly modelArtifactHash: string;
  readonly targetHash: string;
  readonly pricingSnapshotHash: string;
  readonly currency: string;
}

export interface NovelSkillPaidEvaluationQuoteCurrency {
  readonly currency: string;
  readonly estimatedMaximumCostMicros: string;
}

export interface NovelSkillPaidEvaluationQuote {
  readonly runId: string;
  readonly protocolHash: string;
  readonly targetManifestHash: string;
  readonly pricingManifestHash: string;
  readonly quoteHash: string;
  readonly authorizedCallCount: typeof NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT;
  readonly currencies: readonly NovelSkillPaidEvaluationQuoteCurrency[];
}

export interface AuthorizeNovelSkillPaidEvaluationRunInput {
  readonly authorizationId: string;
  readonly runId: string;
  readonly quoteHash: string;
  readonly confirmationHash: string;
  readonly hardCeilings: readonly Readonly<{
    currency: string;
    hardCeilingMicros: string;
  }>[];
  readonly authorizedAt: string;
}

export interface NovelSkillPaidEvaluationCommercialConfirmationInput {
  readonly quote: NovelSkillPaidEvaluationQuote;
  readonly hardCeilings: readonly Readonly<{
    currency: string;
    hardCeilingMicros: string;
  }>[];
}

export interface ReserveNovelSkillPaidEvaluationDispatchInput {
  readonly reservationId: string;
  readonly authorizationId: string;
  readonly runId: string;
  readonly cellId: string;
  readonly attemptId: string;
  readonly modelSlotId: "text_tier_a" | "text_tier_b";
  readonly dispatchGeneration: number;
  readonly plannedContextTraceId: string;
  readonly plannedModelInvocationId: string;
  readonly plannedCandidateId: string;
  readonly receipt: ModelHubExactEvaluationPredispatchReceipt;
  readonly contextBaselineHash: string;
  readonly promptTemplateHash: string;
  readonly invariantRequestHash: string;
  readonly skillConfigurationHash: string | null;
  readonly preferenceConfigurationHash: string | null;
  readonly idempotencyKeyHash: string;
  readonly reservedAt: string;
}

export interface NovelSkillPaidEvaluationReservationRecord {
  readonly id: string;
  readonly runId: string;
  readonly cellId: string;
  readonly attemptId: string;
  readonly state: "reserved" | "bound" | "dispatched" | "settled" | "ambiguous" | "not_dispatched";
  readonly plannedContextTraceId: string;
  readonly plannedModelInvocationId: string;
  readonly plannedCandidateId: string;
  readonly revision: number;
}

export interface ReserveAndBindNovelSkillPaidEvaluationDispatchInput {
  readonly reservation: ReserveNovelSkillPaidEvaluationDispatchInput;
  readonly trace: ContextCompilationTrace;
  /** Transient code-owned payload and compile inputs; neither is persisted. */
  readonly payloadAuthorityInput: CompileNovelSkillPaidEvaluationPayloadInput;
  readonly payloadAuthority: NovelSkillPaidEvaluationAuthoritativePayload;
  readonly boundAt: string;
}

export interface SettleNovelSkillPaidEvaluationSuccessInput {
  readonly reservationId: string;
  readonly expectedRevision: number;
  readonly candidate: AiCandidateSnapshot;
  readonly result: ModelHubExactEvaluationExecutionResult;
  readonly completedAt: string;
}

export type NovelSkillPaidEvaluationFailureOutcome =
  "failed" | "cancelled" | "timed_out" | "policy_blocked";

export type NovelSkillPaidEvaluationFailureCode =
  | "USER_CANCELLED"
  | "MODEL_TIMEOUT"
  | "MODEL_RATE_LIMITED"
  | "MODEL_AUTH_FAILED"
  | "MODEL_CONNECTION_FAILED"
  | "MODEL_PROVIDER_ERROR"
  | "MODEL_OUTPUT_EMPTY"
  | "MODEL_OUTPUT_TRUNCATED"
  | "MODEL_POLICY_BLOCKED"
  | "UNKNOWN_PROVIDER_FAILURE";

export interface SettleNovelSkillPaidEvaluationFailureInput {
  readonly reservationId: string;
  readonly expectedRevision: number;
  readonly outcome: NovelSkillPaidEvaluationFailureOutcome;
  readonly errorCode: NovelSkillPaidEvaluationFailureCode;
  /** Usage observed at the provider boundary, when the failed response supplied it. */
  readonly usage: ModelHubExactEvaluationExecutionResult["usage"];
  /** Locally estimated from the same locked price snapshot; the Store recomputes it. */
  readonly estimatedActualCostMicros: string | null;
  readonly completedAt: string;
}

interface FixtureRow {
  readonly fixture_id: string;
  readonly task_type: string;
}

interface RunRow {
  readonly id: string;
  readonly suite_id: string;
  readonly status: string;
  readonly model_assignments_json: string;
}

interface ConnectionCatalogCostRow {
  readonly connection_id: string;
  readonly provider_kind: string;
  readonly protocol: string;
  readonly region: string | null;
  readonly workspace_id: string | null;
  readonly endpoint_id: string | null;
  readonly base_url: string;
  readonly credential_ref: string | null;
  readonly credential_state: string;
  readonly authentication_mode: string;
  readonly credential_header_name: string | null;
  readonly model_discovery_path: string | null;
  readonly text_generation_path: string | null;
  readonly embedding_path: string | null;
  readonly request_timeout_ms: number;
  readonly retry_limit: number;
  readonly connection_status: string;
  readonly connection_enabled: number;
  readonly connection_revision: number;
  readonly catalog_id: string;
  readonly catalog_connection_id: string;
  readonly provider_model_id: string;
  readonly catalog_source: string;
  readonly availability: string;
  readonly lifecycle: string;
  readonly input_token_limit: number | null;
  readonly output_token_limit: number | null;
  readonly stale_after: string | null;
  readonly catalog_revision: number;
  readonly currency: string | null;
  readonly input_rate: string | null;
  readonly output_rate: string | null;
  readonly cached_input_rate: string | null;
  readonly pricing_version: string | null;
  readonly price_updated_at: string | null;
  readonly data_destination: string;
  readonly retention_policy: string;
  readonly training_policy: string;
  readonly evidence_source: string;
  readonly evidence_version: string | null;
  readonly evidence_summary: string | null;
  readonly evidence_updated_at: string;
  readonly cost_revision: number;
  readonly cost_created_at: string;
  readonly cost_updated_at: string;
}

interface TargetQuoteRow {
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly currency: string;
  readonly input_rate: string;
  readonly output_rate: string;
  readonly target_hash: string;
  readonly pricing_snapshot_hash: string;
  readonly connection_id: string;
  readonly catalog_entry_id: string;
  readonly model_identity_hash: string;
  readonly model_artifact_hash: string;
}

interface QuoteWorkRow extends TargetQuoteRow {
  readonly task_type: string;
  readonly maximum_input_tokens: number;
  readonly maximum_output_tokens: number;
  readonly cell_count: number;
}

interface ReservationRow {
  readonly id: string;
  readonly run_id: string;
  readonly cell_id: string;
  readonly attempt_id: string;
  readonly state: NovelSkillPaidEvaluationReservationRecord["state"];
  readonly planned_context_trace_id: string;
  readonly planned_model_invocation_id: string;
  readonly planned_candidate_id: string;
  readonly revision: number;
}

interface PredispatchAuthorityRow {
  readonly reservation_id: string;
  readonly schema_version: number;
  readonly authority_snapshot_version: string;
  readonly payload_authority_schema_version: number;
  readonly payload_authority_version: string;
  readonly payload_authority_manifest_hash: string;
  readonly run_id: string;
  readonly suite_id: string;
  readonly cell_id: string;
  readonly fixture_id: string;
  readonly fixture_contract_hash: string;
  readonly fixture_input_content_hash: string;
  readonly task_type: string;
  readonly invocation_mode: string;
  readonly genre_tags_hash: string;
  readonly coverage_dimensions_hash: string;
  readonly arm: NovelSkillPaidEvaluationPayloadAuthorityManifest["arm"];
  readonly arm_configuration_hash: string | null;
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly repetition: 1 | 2;
  readonly prompt_template_version: string;
  readonly prompt_template_hash: string;
  readonly context_baseline_hash: string;
  readonly context_baseline_projection_hash: string;
  readonly available_context_layers_hash: string;
  readonly skill_compiler_version: string;
  readonly skill_selection_hash: string | null;
  readonly compiled_skill_snapshot_hash: string | null;
  readonly rendered_skill_section_hash: string | null;
  readonly preference_configuration_hash: string | null;
  readonly preference_projection_hash: string | null;
  readonly rendered_preference_section_hash: string | null;
  readonly base_message_payload_hash: string;
  readonly message_payload_hash: string;
  readonly generation_id: string;
  readonly connection_id: string;
  readonly catalog_entry_id: string;
  readonly provider_kind: string;
  readonly provider_model_id: string;
  readonly connection_revision: number;
  readonly catalog_revision: number;
  readonly cost_privacy_revision: number;
  readonly capability_evidence_hash: string;
  readonly cost_profile_hash: string;
  readonly target_identity_hash: string;
  readonly request_profile_hash: string;
  readonly request_payload_hash: string;
  readonly execution_lock_hash: string;
  readonly currency: string;
  readonly exact_predispatch_estimated_max_cost_micros: string;
  readonly data_destination: "local" | "remote";
  readonly provider_receipt_shape_version: string;
  readonly provider_receipt_shape_hash: string;
  readonly final_dispatch_authority_version: string;
  readonly final_dispatch_authority_hash: string;
  readonly authority_snapshot_hash: string;
  readonly captured_at: string;
  readonly authorization_id: string;
  readonly attempt_id: string;
  readonly dispatch_generation: number;
  readonly planned_context_trace_id: string;
  readonly planned_model_invocation_id: string;
  readonly planned_candidate_id: string;
  readonly idempotency_key_hash: string;
  readonly reservation_run_id: string;
  readonly reservation_cell_id: string;
  readonly reservation_model_slot_id: "text_tier_a" | "text_tier_b";
  readonly reservation_target_hash: string;
  readonly reservation_pricing_snapshot_hash: string;
  readonly reservation_request_profile_hash: string;
  readonly reservation_message_payload_hash: string;
  readonly reservation_request_payload_hash: string;
  readonly reservation_execution_lock_hash: string;
  readonly reservation_payload_authority_manifest_hash: string;
  readonly reservation_currency: string;
  readonly reservation_data_destination: "local" | "remote";
  readonly reservation_reserved_max_cost_micros: string;
  readonly reservation_reserved_at: string;
}

interface ProtocolReplayRow {
  readonly schema_version: number;
  readonly execution_protocol_version: string;
  readonly protocol_hash: string;
  readonly request_profile_manifest_hash: string;
  readonly context_baseline_manifest_hash: string;
  readonly prompt_template_version: string;
  readonly prompt_template_hash: string;
  readonly rubric_version: string;
  readonly rubric_content_hash: string;
  readonly evaluator_contract_hash: string;
  readonly blinding_protocol_version: string;
  readonly blinding_protocol_hash: string;
  readonly randomization_protocol_version: string;
  readonly randomization_protocol_hash: string;
  readonly created_at: string;
}

interface RequestProfileReplayRow {
  readonly task_type: string;
  readonly profile_version: string;
  readonly request_profile_hash: string;
  readonly maximum_input_tokens: number;
  readonly maximum_output_tokens: number;
  readonly temperature_basis_points: number;
  readonly top_p_basis_points: number;
  readonly reasoning_policy: string;
  readonly response_format: string;
  readonly streaming: number;
  readonly stop_policy_hash: string;
  readonly created_at: string;
}

interface ContextBaselineReplayRow {
  readonly fixture_id: string;
  readonly baseline_contract_hash: string;
  readonly included_source_manifest_hash: string;
  readonly omitted_source_manifest_hash: string;
  readonly compiled_baseline_hash: string;
  readonly baseline_token_budget: number;
  readonly created_at: string;
}

interface PersistedTargetAuthority {
  readonly run_id: string;
  readonly model_slot_id: "text_tier_a" | "text_tier_b";
  readonly connection_id: string;
  readonly catalog_entry_id: string;
  readonly provider_kind_snapshot: string;
  readonly connection_protocol_snapshot: string;
  readonly connection_revision: number;
  readonly connection_configuration_hash: string;
  readonly catalog_revision: number;
  readonly provider_model_id_snapshot: string;
  readonly catalog_identity_hash: string;
  readonly model_identity_hash: string;
  readonly model_artifact_hash: string;
  readonly artifact_identity_source: "provider_model_id";
  readonly cost_profile_revision: number;
  readonly currency: string;
  readonly input_micros_per_million_tokens: string;
  readonly output_micros_per_million_tokens: string;
  readonly cached_input_micros_per_million_tokens: string | null;
  readonly pricing_version: string;
  readonly price_updated_at: string;
  readonly pricing_snapshot_hash: string;
  readonly target_hash: string;
  readonly created_at: string;
}

async function assertExactProtocolReplayOrMissing(
  transaction: TransactionExecutor,
  authority: Readonly<{
    input: CreateNovelSkillPaidEvaluationProtocolInput;
    protocolHash: string;
    requestProfileManifestHash: string;
    contextBaselineManifestHash: string;
    profiles: readonly NovelSkillPaidEvaluationRequestProfileInput[];
    baselines: readonly NovelSkillPaidEvaluationContextBaselineInput[];
  }>,
): Promise<boolean> {
  const [protocol] = await transaction.select<ProtocolReplayRow>(
    `SELECT schema_version,execution_protocol_version,protocol_hash,request_profile_manifest_hash,context_baseline_manifest_hash,prompt_template_version,prompt_template_hash,rubric_version,rubric_content_hash,evaluator_contract_hash,blinding_protocol_version,blinding_protocol_hash,randomization_protocol_version,randomization_protocol_hash,created_at FROM novel_skill_evaluation_protocols WHERE suite_id = ?`,
    [authority.input.suiteId],
  );
  if (protocol === undefined) return false;
  const [profileRows, baselineRows] = await Promise.all([
    transaction.select<RequestProfileReplayRow>(
      `SELECT task_type,profile_version,request_profile_hash,maximum_input_tokens,maximum_output_tokens,temperature_basis_points,top_p_basis_points,reasoning_policy,response_format,streaming,stop_policy_hash,created_at FROM novel_skill_evaluation_request_profiles WHERE suite_id = ? ORDER BY task_type`,
      [authority.input.suiteId],
    ),
    transaction.select<ContextBaselineReplayRow>(
      `SELECT fixture_id,baseline_contract_hash,included_source_manifest_hash,omitted_source_manifest_hash,compiled_baseline_hash,baseline_token_budget,created_at FROM novel_skill_evaluation_context_baselines WHERE suite_id = ? ORDER BY fixture_id`,
      [authority.input.suiteId],
    ),
  ]);
  const expectedProfiles = authority.profiles.map((profile) => ({
    task_type: profile.taskType,
    profile_version: profile.profileVersion,
    request_profile_hash: profile.requestProfileHash,
    maximum_input_tokens: profile.maximumInputTokens,
    maximum_output_tokens: profile.maximumOutputTokens,
    temperature_basis_points: profile.temperatureBasisPoints,
    top_p_basis_points: profile.topPBasisPoints,
    reasoning_policy: "disabled",
    response_format: "text",
    streaming: 1,
    stop_policy_hash: profile.stopPolicyHash,
    created_at: authority.input.createdAt,
  }));
  const expectedBaselines = authority.baselines.map((baseline) => ({
    fixture_id: baseline.fixtureId,
    baseline_contract_hash: baseline.baselineContractHash,
    included_source_manifest_hash: baseline.includedSourceManifestHash,
    omitted_source_manifest_hash: baseline.omittedSourceManifestHash,
    compiled_baseline_hash: baseline.compiledBaselineHash,
    baseline_token_budget: baseline.baselineTokenBudget,
    created_at: authority.input.createdAt,
  }));
  const exact =
    protocol.schema_version === 1 &&
    protocol.execution_protocol_version === NOVEL_SKILL_PAID_EVALUATION_PROTOCOL_VERSION &&
    protocol.protocol_hash === authority.protocolHash &&
    protocol.request_profile_manifest_hash === authority.requestProfileManifestHash &&
    protocol.context_baseline_manifest_hash === authority.contextBaselineManifestHash &&
    protocol.prompt_template_version === authority.input.promptTemplateVersion &&
    protocol.prompt_template_hash === authority.input.promptTemplateHash &&
    protocol.rubric_version === NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION &&
    protocol.rubric_content_hash === authority.input.rubricContentHash &&
    protocol.evaluator_contract_hash === authority.input.evaluatorContractHash &&
    protocol.blinding_protocol_version === authority.input.blindingProtocolVersion &&
    protocol.blinding_protocol_hash === authority.input.blindingProtocolHash &&
    protocol.randomization_protocol_version === authority.input.randomizationProtocolVersion &&
    protocol.randomization_protocol_hash === authority.input.randomizationProtocolHash &&
    protocol.created_at === authority.input.createdAt &&
    canonicalJson(profileRows) === canonicalJson(expectedProfiles) &&
    canonicalJson(baselineRows) === canonicalJson(expectedBaselines);
  if (!exact) {
    throw conflict(
      "A paid evaluation protocol for this suite already exists under different canonical authority.",
    );
  }
  return true;
}

/**
 * Content-free authority store for 0063. It never accepts Prompt, fixture body,
 * provider output, hidden reasoning or credential material.
 */
export class NovelSkillPaidEvaluationSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async createExecutionProtocol(
    input: CreateNovelSkillPaidEvaluationProtocolInput,
  ): Promise<NovelSkillPaidEvaluationProtocolRecord> {
    assertUuidV7(input.suiteId, "suiteId");
    assertIsoUtc(input.createdAt, "createdAt");
    for (const value of [
      input.promptTemplateHash,
      input.rubricContentHash,
      input.evaluatorContractHash,
      input.blindingProtocolHash,
      input.randomizationProtocolHash,
    ]) {
      assertHash(value, "protocol hash");
    }
    for (const value of [
      input.promptTemplateVersion,
      input.blindingProtocolVersion,
      input.randomizationProtocolVersion,
    ]) {
      assertVersion(value);
    }

    return this.executor.transaction(async (transaction) => {
      const fixtures = await transaction.select<FixtureRow>(
        `SELECT fixture_id,task_type FROM novel_skill_evaluation_fixtures WHERE suite_id = ? ORDER BY fixture_id`,
        [input.suiteId],
      );
      if (fixtures.length !== 12) {
        throw invalid("A paid evaluation protocol requires the fixed 12-fixture suite.");
      }
      const fixtureIds = fixtures.map(({ fixture_id }) => fixture_id);
      const taskTypes = [...new Set(fixtures.map(({ task_type }) => task_type))].sort(compareText);
      const profiles = normalizeRequestProfiles(input.requestProfiles);
      for (const profile of profiles) {
        const exactProfile = exactRequestProfile(profile);
        const expectedHash = await hashModelHubExactEvaluationRequestProfile(exactProfile);
        if (profile.requestProfileHash !== expectedHash) {
          throw invalid("The request profile hash does not match its fixed wire contract.");
        }
      }
      const baselines = normalizeContextBaselines(input.contextBaselines);
      if (
        !sameStrings(
          taskTypes,
          profiles.map(({ taskType }) => taskType),
        )
      ) {
        throw invalid("Request profiles must exactly cover the fixture task types.");
      }
      if (
        !sameStrings(
          fixtureIds,
          baselines.map(({ fixtureId }) => fixtureId),
        )
      ) {
        throw invalid("Context baselines must exactly cover the fixed fixture registry.");
      }

      const requestProfileManifestHash = await sha256Hex(canonicalJson(profiles));
      const contextBaselineManifestHash = await sha256Hex(canonicalJson(baselines));
      const protocolHash = await sha256Hex(
        canonicalJson({
          schemaVersion: 1,
          executionProtocolVersion: NOVEL_SKILL_PAID_EVALUATION_PROTOCOL_VERSION,
          suiteId: input.suiteId,
          requestProfileManifestHash,
          contextBaselineManifestHash,
          promptTemplateVersion: input.promptTemplateVersion,
          promptTemplateHash: input.promptTemplateHash,
          rubricVersion: NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION,
          rubricContentHash: input.rubricContentHash,
          evaluatorContractHash: input.evaluatorContractHash,
          blindingProtocolVersion: input.blindingProtocolVersion,
          blindingProtocolHash: input.blindingProtocolHash,
          randomizationProtocolVersion: input.randomizationProtocolVersion,
          randomizationProtocolHash: input.randomizationProtocolHash,
        }),
      );
      const replayed = await assertExactProtocolReplayOrMissing(transaction, {
        input,
        protocolHash,
        requestProfileManifestHash,
        contextBaselineManifestHash,
        profiles,
        baselines,
      });
      if (replayed) {
        return Object.freeze({
          suiteId: input.suiteId,
          protocolHash,
          requestProfileManifestHash,
          contextBaselineManifestHash,
          promptTemplateHash: input.promptTemplateHash,
          rubricContentHash: input.rubricContentHash,
        });
      }
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_protocols(suite_id,schema_version,execution_protocol_version,protocol_hash,request_profile_manifest_hash,context_baseline_manifest_hash,prompt_template_version,prompt_template_hash,rubric_version,rubric_content_hash,evaluator_contract_hash,blinding_protocol_version,blinding_protocol_hash,randomization_protocol_version,randomization_protocol_hash,created_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.suiteId,
          NOVEL_SKILL_PAID_EVALUATION_PROTOCOL_VERSION,
          protocolHash,
          requestProfileManifestHash,
          contextBaselineManifestHash,
          input.promptTemplateVersion,
          input.promptTemplateHash,
          NOVEL_SKILL_PAID_EVALUATION_RUBRIC_VERSION,
          input.rubricContentHash,
          input.evaluatorContractHash,
          input.blindingProtocolVersion,
          input.blindingProtocolHash,
          input.randomizationProtocolVersion,
          input.randomizationProtocolHash,
          input.createdAt,
        ],
      );
      for (const profile of profiles) {
        await transaction.execute(
          `INSERT INTO novel_skill_evaluation_request_profiles(suite_id,task_type,profile_version,request_profile_hash,maximum_input_tokens,maximum_output_tokens,temperature_basis_points,top_p_basis_points,reasoning_policy,response_format,streaming,stop_policy_hash,created_at) VALUES(?,?,?,?,?,?,?,?,'disabled','text',1,?,?)`,
          [
            input.suiteId,
            profile.taskType,
            profile.profileVersion,
            profile.requestProfileHash,
            profile.maximumInputTokens,
            profile.maximumOutputTokens,
            profile.temperatureBasisPoints,
            profile.topPBasisPoints,
            profile.stopPolicyHash,
            input.createdAt,
          ],
        );
      }
      for (const baseline of baselines) {
        await transaction.execute(
          `INSERT INTO novel_skill_evaluation_context_baselines(suite_id,fixture_id,baseline_contract_hash,included_source_manifest_hash,omitted_source_manifest_hash,compiled_baseline_hash,baseline_token_budget,created_at) VALUES(?,?,?,?,?,?,?,?)`,
          [
            input.suiteId,
            baseline.fixtureId,
            baseline.baselineContractHash,
            baseline.includedSourceManifestHash,
            baseline.omittedSourceManifestHash,
            baseline.compiledBaselineHash,
            baseline.baselineTokenBudget,
            input.createdAt,
          ],
        );
      }
      return Object.freeze({
        suiteId: input.suiteId,
        protocolHash,
        requestProfileManifestHash,
        contextBaselineManifestHash,
        promptTemplateHash: input.promptTemplateHash,
        rubricContentHash: input.rubricContentHash,
      });
    });
  }

  public async bindExactModelTargets(
    runId: string,
    targets: readonly BindNovelSkillPaidEvaluationTargetInput[],
    createdAt: string,
  ): Promise<readonly NovelSkillPaidEvaluationTargetRecord[]> {
    assertUuidV7(runId, "runId");
    assertIsoUtc(createdAt, "createdAt");
    if (targets.length !== 2 || new Set(targets.map(({ modelSlotId }) => modelSlotId)).size !== 2) {
      throw invalid("Paid evaluation requires exactly two distinct model slots.");
    }
    return this.executor.transaction(async (transaction) => {
      const [run] = await transaction.select<RunRow>(
        `SELECT id,suite_id,status,model_assignments_json FROM novel_skill_evaluation_runs WHERE id = ?`,
        [runId],
      );
      if (run?.status !== "planned") {
        throw conflict("Exact targets can only be bound to a planned evaluation run.");
      }
      const assignments = parseAssignments(run.model_assignments_json);
      const records: NovelSkillPaidEvaluationTargetRecord[] = [];
      const persistedTargets: PersistedTargetAuthority[] = [];
      for (const target of [...targets].sort((left, right) =>
        compareText(left.modelSlotId, right.modelSlotId),
      )) {
        if (
          (target as { readonly artifactIdentitySource: unknown }).artifactIdentitySource !==
          "provider_model_id"
        ) {
          throw invalid(
            "This runner only accepts model artifacts identified by an exact provider model id.",
          );
        }
        const row = await readLiveTarget(transaction, target.inspection.target);
        if (
          row.cached_input_rate !== null &&
          BigInt(row.cached_input_rate) > BigInt(requiredString(row.input_rate, "input price"))
        ) {
          throw invalid("Cached-input pricing cannot exceed the locked input-token price.");
        }
        const modelIdentityHash = await hashNovelSkillEvaluationModelIdentity({
          catalogEntryId: row.catalog_id,
          connectionId: row.connection_id,
          modelId: row.provider_model_id,
          providerKind: row.provider_kind,
        });
        const modelArtifactHash = await hashNovelSkillEvaluationModelArtifact({
          modelId: row.provider_model_id,
          providerKind: row.provider_kind,
        });
        const assignment = assignments.find(({ slotId }) => slotId === target.modelSlotId);
        if (
          assignment?.modelIdentityHash !== modelIdentityHash ||
          assignment.modelArtifactHash !== modelArtifactHash
        ) {
          throw conflict("The planned model assignment does not match the exact live target.");
        }
        const connectionConfigurationHash = await sha256Hex(
          canonicalJson(connectionProjection(row)),
        );
        const catalogIdentityHash = await sha256Hex(canonicalJson(catalogProjection(row)));
        const pricingSnapshotHash = await sha256Hex(canonicalJson(costProjection(row)));
        if (pricingSnapshotHash !== target.inspection.target.costProfileHash) {
          throw conflict("The exact target pricing snapshot changed before it was bound.");
        }
        const targetHash = await hashLiveExactTarget(
          row,
          target.inspection.target.capabilityEvidenceHash,
          pricingSnapshotHash,
        );
        if (targetHash !== target.inspection.target.targetIdentityHash) {
          throw conflict("The exact target capability authority changed before it was bound.");
        }
        const persistedTarget = {
          run_id: runId,
          model_slot_id: target.modelSlotId,
          connection_id: row.connection_id,
          catalog_entry_id: row.catalog_id,
          provider_kind_snapshot: row.provider_kind,
          connection_protocol_snapshot: row.protocol,
          connection_revision: row.connection_revision,
          connection_configuration_hash: connectionConfigurationHash,
          catalog_revision: row.catalog_revision,
          provider_model_id_snapshot: row.provider_model_id,
          catalog_identity_hash: catalogIdentityHash,
          model_identity_hash: modelIdentityHash,
          model_artifact_hash: modelArtifactHash,
          artifact_identity_source: target.artifactIdentitySource,
          cost_profile_revision: row.cost_revision,
          currency: requiredString(row.currency, "currency"),
          input_micros_per_million_tokens: requiredString(row.input_rate, "input price"),
          output_micros_per_million_tokens: requiredString(row.output_rate, "output price"),
          cached_input_micros_per_million_tokens: row.cached_input_rate,
          pricing_version: requiredString(row.pricing_version, "pricing version"),
          price_updated_at: requiredString(row.price_updated_at, "price update time"),
          pricing_snapshot_hash: pricingSnapshotHash,
          target_hash: targetHash,
          created_at: createdAt,
        } satisfies PersistedTargetAuthority;
        persistedTargets.push(persistedTarget);
        records.push(
          Object.freeze({
            runId,
            modelSlotId: target.modelSlotId,
            connectionId: row.connection_id,
            catalogEntryId: row.catalog_id,
            providerKind: row.provider_kind,
            providerModelId: row.provider_model_id,
            modelIdentityHash,
            modelArtifactHash,
            targetHash,
            pricingSnapshotHash,
            currency: requiredString(row.currency, "currency"),
          }),
        );
      }
      if (new Set(records.map(({ modelArtifactHash }) => modelArtifactHash)).size !== 2) {
        throw invalid("The two evaluation slots must refer to different model artifacts.");
      }
      const existingTargets = await transaction.select<PersistedTargetAuthority>(
        `SELECT run_id,model_slot_id,connection_id,catalog_entry_id,provider_kind_snapshot,connection_protocol_snapshot,connection_revision,connection_configuration_hash,catalog_revision,provider_model_id_snapshot,catalog_identity_hash,model_identity_hash,model_artifact_hash,artifact_identity_source,cost_profile_revision,currency,input_micros_per_million_tokens,output_micros_per_million_tokens,cached_input_micros_per_million_tokens,pricing_version,price_updated_at,pricing_snapshot_hash,target_hash,created_at FROM novel_skill_evaluation_run_model_targets WHERE run_id = ? ORDER BY model_slot_id`,
        [runId],
      );
      if (existingTargets.length > 0) {
        if (canonicalJson(existingTargets) !== canonicalJson(persistedTargets)) {
          throw conflict(
            "Exact targets for this run already exist under different canonical authority.",
          );
        }
        return Object.freeze(records);
      }
      for (const target of persistedTargets) {
        await transaction.execute(
          `INSERT INTO novel_skill_evaluation_run_model_targets(run_id,model_slot_id,connection_id,catalog_entry_id,provider_kind_snapshot,connection_protocol_snapshot,connection_revision,connection_configuration_hash,catalog_revision,provider_model_id_snapshot,catalog_identity_hash,model_identity_hash,model_artifact_hash,artifact_identity_source,cost_profile_revision,currency,input_micros_per_million_tokens,output_micros_per_million_tokens,cached_input_micros_per_million_tokens,pricing_version,price_updated_at,pricing_snapshot_hash,target_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            target.run_id,
            target.model_slot_id,
            target.connection_id,
            target.catalog_entry_id,
            target.provider_kind_snapshot,
            target.connection_protocol_snapshot,
            target.connection_revision,
            target.connection_configuration_hash,
            target.catalog_revision,
            target.provider_model_id_snapshot,
            target.catalog_identity_hash,
            target.model_identity_hash,
            target.model_artifact_hash,
            target.artifact_identity_source,
            target.cost_profile_revision,
            target.currency,
            target.input_micros_per_million_tokens,
            target.output_micros_per_million_tokens,
            target.cached_input_micros_per_million_tokens,
            target.pricing_version,
            target.price_updated_at,
            target.pricing_snapshot_hash,
            target.target_hash,
            target.created_at,
          ],
        );
      }
      return Object.freeze(records);
    });
  }

  public async quoteCommercialRun(runId: string): Promise<NovelSkillPaidEvaluationQuote> {
    assertUuidV7(runId, "runId");
    return quoteCommercialRun(this.executor, runId);
  }

  public async authorizeCommercialRun(
    input: AuthorizeNovelSkillPaidEvaluationRunInput,
  ): Promise<NovelSkillPaidEvaluationQuote> {
    assertUuidV7(input.authorizationId, "authorizationId");
    assertUuidV7(input.runId, "runId");
    assertHash(input.quoteHash, "quoteHash");
    assertHash(input.confirmationHash, "confirmationHash");
    assertIsoUtc(input.authorizedAt, "authorizedAt");
    return this.executor.transaction(async (transaction) => {
      const quote = await quoteCommercialRun(transaction, input.runId);
      if (quote.quoteHash !== input.quoteHash) {
        throw conflict("The commercial quote changed before authorization.");
      }
      const ceilings = [...input.hardCeilings]
        .map((value) => ({
          currency: normalizeCurrency(value.currency),
          hardCeilingMicros: normalizeMicros(value.hardCeilingMicros),
        }))
        .sort((left, right) => compareText(left.currency, right.currency));
      if (
        new Set(ceilings.map(({ currency }) => currency)).size !== ceilings.length ||
        !sameStrings(
          quote.currencies.map(({ currency }) => currency),
          ceilings.map(({ currency }) => currency),
        )
      ) {
        throw invalid("Hard ceilings must exactly cover the quote currencies.");
      }
      for (const quoteCurrency of quote.currencies) {
        const ceiling = ceilings.find(({ currency }) => currency === quoteCurrency.currency);
        if (
          ceiling === undefined ||
          BigInt(ceiling.hardCeilingMicros) < BigInt(quoteCurrency.estimatedMaximumCostMicros)
        ) {
          throw invalid("A per-currency hard ceiling is below the conservative quote.");
        }
      }
      const expectedConfirmationHash = await hashNovelSkillPaidEvaluationCommercialConfirmation({
        quote,
        hardCeilings: ceilings,
      });
      if (input.confirmationHash !== expectedConfirmationHash) {
        throw invalid(
          "The commercial confirmation does not match the exact targets, quote and hard ceilings.",
        );
      }
      await transaction.execute(
        `INSERT INTO novel_skill_evaluation_dispatch_authorizations(id,run_id,protocol_hash,target_manifest_hash,pricing_manifest_hash,quote_hash,confirmation_hash,authorized_call_count,authorized_by,commercial_use_acknowledged,authorized_at) VALUES(?,?,?,?,?,?,?,192,'local_user',1,?)`,
        [
          input.authorizationId,
          input.runId,
          quote.protocolHash,
          quote.targetManifestHash,
          quote.pricingManifestHash,
          quote.quoteHash,
          input.confirmationHash,
          input.authorizedAt,
        ],
      );
      for (const quoteCurrency of quote.currencies) {
        const ceiling = ceilings.find(({ currency }) => currency === quoteCurrency.currency);
        if (ceiling === undefined) throw invalid("Missing quote currency ceiling.");
        await transaction.execute(
          `INSERT INTO novel_skill_evaluation_authorization_limits(authorization_id,currency,estimated_max_cost_micros,hard_ceiling_micros,created_at) VALUES(?,?,?,?,?)`,
          [
            input.authorizationId,
            quoteCurrency.currency,
            quoteCurrency.estimatedMaximumCostMicros,
            ceiling.hardCeilingMicros,
            input.authorizedAt,
          ],
        );
      }
      return quote;
    });
  }

  public async startAuthorizedRun(runId: string, startedAt: string): Promise<void> {
    assertUuidV7(runId, "runId");
    assertIsoUtc(startedAt, "startedAt");
    const result = await this.executor.execute(
      `UPDATE novel_skill_evaluation_runs SET status = 'running',started_at = ?,revision = revision+1 WHERE id = ? AND status = 'planned' AND evaluation_status = 'NOT_EVALUATED'`,
      [startedAt, runId],
    );
    if (result.rowsAffected !== 1) {
      throw conflict("The paid evaluation run is not authorized or no longer startable.");
    }
  }

  public async reserveAndBindAttemptDispatch(
    input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
  ): Promise<NovelSkillPaidEvaluationReservationRecord> {
    assertReservationInput(input.reservation);
    assertIsoUtc(input.boundAt, "boundAt");
    assertEvaluationTraceBinding(input);
    let payloadAuthority: NovelSkillPaidEvaluationAuthoritativePayload;
    try {
      payloadAuthority = await validateNovelSkillPaidEvaluationPayloadAuthority(
        input.payloadAuthority,
        input.payloadAuthorityInput,
      );
    } catch (cause: unknown) {
      throw invalid("The authoritative evaluation payload failed validation.", cause);
    }
    assertPayloadAuthorityBinding(input, payloadAuthority.manifest);
    const tracePreferenceConfigurationHash =
      await hashNovelSkillPaidEvaluationTracePreferenceConfiguration(input.trace);
    if (
      tracePreferenceConfigurationHash !== payloadAuthority.manifest.preferenceConfigurationHash
    ) {
      throw invalid(
        "The evaluation trace preference evidence does not match the authoritative payload.",
      );
    }
    const traceBaselineHash = await hashNovelSkillPaidEvaluationTraceBaseline(input.trace);
    if (traceBaselineHash !== input.reservation.contextBaselineHash) {
      throw invalid("The evaluation trace does not match the frozen context baseline.");
    }
    return this.executor.transaction(async (transaction) => {
      const reservation = await reserveAttemptDispatch(
        transaction,
        input.reservation,
        payloadAuthority.manifest,
        payloadAuthority.manifestHash,
      );
      await persistPredispatchAuthoritySnapshot(
        transaction,
        input.reservation,
        payloadAuthority.manifest,
        payloadAuthority.manifestHash,
      );
      if (reservation.state === "bound") {
        await assertExistingBoundDispatch(transaction, input);
        return reservation;
      }
      if (reservation.state !== "reserved" || reservation.revision !== 1) {
        throw conflict("The immutable dispatch reservation is no longer bindable.");
      }
      await insertEvaluationTrace(transaction, input.reservation.reservationId, input.trace);
      await insertEvaluationInvocation(transaction, input);
      await transaction.execute(
        `INSERT INTO context_compilation_model_invocation_links(trace_id,model_invocation_id,linked_at) VALUES(?,?,?)`,
        [input.trace.id, input.reservation.plannedModelInvocationId, input.boundAt],
      );
      const attempt = await transaction.execute(
        `UPDATE novel_skill_evaluation_attempts SET context_trace_id = ?,model_invocation_id = ? WHERE id = ? AND run_id = ? AND cell_id = ? AND status = 'started' AND context_trace_id IS NULL AND model_invocation_id IS NULL`,
        [
          input.trace.id,
          input.reservation.plannedModelInvocationId,
          input.reservation.attemptId,
          input.reservation.runId,
          input.reservation.cellId,
        ],
      );
      if (attempt.rowsAffected !== 1) {
        throw conflict("The exact evaluation attempt could not be bound atomically.");
      }
      const bound = await transaction.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'bound',bound_at = ?,revision = revision+1 WHERE id = ? AND revision = 1 AND state = 'reserved'`,
        [input.boundAt, input.reservation.reservationId],
      );
      if (bound.rowsAffected !== 1) {
        throw conflict("The exact evaluation reservation could not be bound atomically.");
      }
      return readRequiredReservation(transaction, input.reservation.reservationId);
    });
  }

  public async settleDispatchSuccess(
    input: SettleNovelSkillPaidEvaluationSuccessInput,
  ): Promise<NovelSkillPaidEvaluationReservationRecord> {
    assertUuidV7(input.reservationId, "reservationId");
    assertRevision(input.expectedRevision);
    assertIsoUtc(input.completedAt, "completedAt");
    const candidate = await normalizeEvaluationCandidate(
      input.candidate,
      input.result,
      input.completedAt,
    );
    return this.executor.transaction(async (transaction) => {
      const authority = await requirePredispatchAuthoritySnapshot(transaction, input.reservationId);
      const [reservation] = await transaction.select<{
        readonly attempt_id: string;
        readonly planned_context_trace_id: string;
        readonly planned_model_invocation_id: string;
        readonly planned_candidate_id: string;
        readonly target_hash: string;
        readonly pricing_snapshot_hash: string;
        readonly request_profile_hash: string;
        readonly message_payload_hash: string;
        readonly request_payload_hash: string;
        readonly execution_lock_hash: string;
        readonly data_destination: "local" | "remote";
        readonly currency: string;
        readonly reserved_max_cost_micros: string;
        readonly input_rate: string;
        readonly output_rate: string;
        readonly cached_input_rate: string | null;
        readonly maximum_input_tokens: number;
        readonly maximum_output_tokens: number;
      }>(
        `SELECT reservation.attempt_id,reservation.planned_context_trace_id,reservation.planned_model_invocation_id,reservation.planned_candidate_id,reservation.target_hash AS target_hash,reservation.pricing_snapshot_hash AS pricing_snapshot_hash,reservation.request_profile_hash,reservation.message_payload_hash,reservation.request_payload_hash,reservation.execution_lock_hash,reservation.data_destination,reservation.currency AS currency,reservation.reserved_max_cost_micros,target.input_micros_per_million_tokens AS input_rate,target.output_micros_per_million_tokens AS output_rate,target.cached_input_micros_per_million_tokens AS cached_input_rate,profile.maximum_input_tokens,profile.maximum_output_tokens FROM novel_skill_evaluation_dispatch_reservations AS reservation INNER JOIN novel_skill_evaluation_run_model_targets AS target ON target.run_id = reservation.run_id AND target.model_slot_id = reservation.model_slot_id INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id INNER JOIN novel_skill_evaluation_fixtures AS fixture ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id INNER JOIN novel_skill_evaluation_request_profiles AS profile ON profile.suite_id = cell.suite_id AND profile.task_type = fixture.task_type WHERE reservation.id = ? AND reservation.revision = ? AND reservation.state = 'dispatched'`,
        [input.reservationId, input.expectedRevision],
      );
      if (
        reservation?.planned_candidate_id !== candidate.id ||
        authority.connection_id !== input.result.target.connectionId ||
        authority.catalog_entry_id !== input.result.target.catalogEntryId ||
        authority.provider_kind !== input.result.target.providerKind ||
        authority.provider_model_id !== input.result.target.modelId ||
        authority.connection_revision !== input.result.target.connectionRevision ||
        authority.catalog_revision !== input.result.target.catalogRevision ||
        authority.cost_privacy_revision !== input.result.target.costPrivacyRevision ||
        authority.capability_evidence_hash !== input.result.target.capabilityEvidenceHash ||
        reservation.target_hash !== input.result.target.targetIdentityHash ||
        reservation.pricing_snapshot_hash !== input.result.target.costProfileHash ||
        reservation.request_profile_hash !== input.result.requestProfileHash ||
        reservation.message_payload_hash !== input.result.messagePayloadHash ||
        reservation.request_payload_hash !== input.result.payloadHash ||
        reservation.execution_lock_hash !== input.result.executionLockHash ||
        reservation.data_destination !== input.result.dataDestination ||
        reservation.currency !== input.result.currency
      ) {
        throw conflict("The dispatched evaluation receipt no longer matches its reservation.");
      }
      const actualCostMicros = requiredActualCost(input.result, reservation);
      if (
        input.result.usage !== null &&
        (input.result.usage.inputTokens > reservation.maximum_input_tokens ||
          input.result.usage.outputTokens > reservation.maximum_output_tokens)
      ) {
        throw conflict("The provider token counts exceed the frozen request profile.");
      }
      if (BigInt(actualCostMicros) > BigInt(reservation.reserved_max_cost_micros)) {
        throw conflict("The provider cost exceeds the authorized dispatch reservation.");
      }
      const providerReceiptHash = await hashProviderSettlementReceipt(
        input.result,
        input.completedAt,
      );
      const invocation = await transaction.execute(
        `UPDATE model_invocation_facts SET status = 'succeeded',input_tokens = ?,output_tokens = ?,cached_input_tokens = ?,estimated_cost_micros = ?,currency = ?,error_code = NULL,error_summary = NULL,finish_reason = NULL,visible_content_length = ?,reasoning_present = NULL,streamed = 1,requested_max_output_tokens = ?,completed_at = ?,revision = revision+1 WHERE id = ? AND status = 'running' AND revision = 2`,
        [
          input.result.usage?.inputTokens ?? null,
          input.result.usage?.outputTokens ?? null,
          input.result.usage?.cachedInputTokens ?? null,
          actualCostMicros,
          input.result.currency,
          input.result.visibleContentLength,
          reservation.maximum_output_tokens,
          input.completedAt,
          reservation.planned_model_invocation_id,
        ],
      );
      if (invocation.rowsAffected !== 1) {
        throw conflict("The exact model invocation could not be completed atomically.");
      }
      await insertEvaluationCandidate(transaction, input.reservationId, candidate);
      await transaction.execute(
        `INSERT INTO context_compilation_output_candidate_links(trace_id,ai_candidate_id,linked_at) VALUES(?,?,?)`,
        [reservation.planned_context_trace_id, candidate.id, input.completedAt],
      );
      const attempt = await transaction.execute(
        `UPDATE novel_skill_evaluation_attempts SET status = 'succeeded',error_code = NULL,completed_at = ? WHERE id = ? AND status = 'started' AND context_trace_id = ? AND model_invocation_id = ?`,
        [
          input.completedAt,
          reservation.attempt_id,
          reservation.planned_context_trace_id,
          reservation.planned_model_invocation_id,
        ],
      );
      if (attempt.rowsAffected !== 1) {
        throw conflict("The exact evaluation attempt could not be completed atomically.");
      }
      const settled = await transaction.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'settled',settlement_outcome = 'succeeded',provider_receipt_hash = ?,provider_visible_output_hash = ?,output_candidate_id = ?,actual_cost_micros = ?,terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state = 'dispatched'`,
        [
          providerReceiptHash,
          input.result.visibleOutputHash,
          candidate.id,
          actualCostMicros,
          input.completedAt,
          input.reservationId,
          input.expectedRevision,
        ],
      );
      if (settled.rowsAffected !== 1) {
        throw conflict("The exact evaluation settlement changed concurrently.");
      }
      return readRequiredReservation(transaction, input.reservationId);
    });
  }

  public async settleDispatchFailure(
    input: SettleNovelSkillPaidEvaluationFailureInput,
  ): Promise<NovelSkillPaidEvaluationReservationRecord> {
    assertUuidV7(input.reservationId, "reservationId");
    assertRevision(input.expectedRevision);
    assertIsoUtc(input.completedAt, "completedAt");
    assertFailureOutcome(input.outcome, input.errorCode);
    return this.executor.transaction(async (transaction) => {
      await requirePredispatchAuthoritySnapshot(transaction, input.reservationId);
      const [reservation] = await transaction.select<{
        readonly run_id: string;
        readonly attempt_id: string;
        readonly planned_model_invocation_id: string;
        readonly target_hash: string;
        readonly pricing_snapshot_hash: string;
        readonly request_profile_hash: string;
        readonly request_payload_hash: string;
        readonly currency: string;
        readonly reserved_max_cost_micros: string;
        readonly input_rate: string;
        readonly output_rate: string;
        readonly cached_input_rate: string | null;
        readonly maximum_input_tokens: number;
        readonly maximum_output_tokens: number;
      }>(
        `SELECT reservation.run_id,reservation.attempt_id,reservation.planned_model_invocation_id,reservation.target_hash AS target_hash,reservation.pricing_snapshot_hash AS pricing_snapshot_hash,reservation.request_profile_hash,reservation.request_payload_hash,reservation.currency,reserved_max_cost_micros,target.input_micros_per_million_tokens AS input_rate,target.output_micros_per_million_tokens AS output_rate,target.cached_input_micros_per_million_tokens AS cached_input_rate,profile.maximum_input_tokens,profile.maximum_output_tokens FROM novel_skill_evaluation_dispatch_reservations AS reservation INNER JOIN novel_skill_evaluation_run_model_targets AS target ON target.run_id = reservation.run_id AND target.model_slot_id = reservation.model_slot_id INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id INNER JOIN novel_skill_evaluation_fixtures AS fixture ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id INNER JOIN novel_skill_evaluation_request_profiles AS profile ON profile.suite_id = cell.suite_id AND profile.task_type = fixture.task_type WHERE reservation.id = ? AND reservation.revision = ? AND reservation.state = 'dispatched'`,
        [input.reservationId, input.expectedRevision],
      );
      if (reservation === undefined) {
        throw conflict("The failed dispatch no longer matches its bounded reservation.");
      }
      if (
        input.usage !== null &&
        (input.usage.inputTokens > reservation.maximum_input_tokens ||
          input.usage.outputTokens > reservation.maximum_output_tokens)
      ) {
        throw conflict("The failed provider token counts exceed the frozen request profile.");
      }
      const actualCostMicros = optionalActualCost(input, reservation);
      if (
        actualCostMicros !== null &&
        BigInt(actualCostMicros) > BigInt(reservation.reserved_max_cost_micros)
      ) {
        throw conflict("The provider cost exceeds the authorized dispatch reservation.");
      }
      const invocationStatus = failureInvocationStatus(input.outcome);
      const invocationErrorCode =
        invocationStatus === "cancelled" ? null : invocationFailureErrorCode(input.errorCode);
      const invocation = await transaction.execute(
        `UPDATE model_invocation_facts SET status = ?,estimated_cost_micros = ?,currency = ?,error_code = ?,error_summary = NULL,input_tokens = ?,output_tokens = ?,cached_input_tokens = ?,completed_at = ?,revision = revision+1 WHERE id = ? AND status = 'running' AND revision = 2`,
        [
          invocationStatus,
          actualCostMicros,
          reservation.currency,
          invocationErrorCode,
          input.usage?.inputTokens ?? null,
          input.usage?.outputTokens ?? null,
          input.usage?.cachedInputTokens ?? null,
          input.completedAt,
          reservation.planned_model_invocation_id,
        ],
      );
      if (invocation.rowsAffected !== 1) {
        throw conflict("The failed exact invocation could not be closed atomically.");
      }
      const attemptStatus = input.outcome === "cancelled" ? "cancelled" : "failed";
      const attempt = await transaction.execute(
        `UPDATE novel_skill_evaluation_attempts SET status = ?,error_code = ?,completed_at = ? WHERE id = ? AND status = 'started'`,
        [attemptStatus, input.errorCode, input.completedAt, reservation.attempt_id],
      );
      if (attempt.rowsAffected !== 1) {
        throw conflict("The failed exact evaluation attempt could not be closed atomically.");
      }
      const providerReceiptHash = await hashProviderFailureReceipt({
        ...input,
        actualCostMicros,
        targetHash: reservation.target_hash,
        pricingSnapshotHash: reservation.pricing_snapshot_hash,
        requestProfileHash: reservation.request_profile_hash,
        requestPayloadHash: reservation.request_payload_hash,
        currency: reservation.currency,
      });
      const settled = await transaction.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'settled',settlement_outcome = ?,provider_receipt_hash = ?,actual_cost_micros = ?,terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state = 'dispatched'`,
        [
          input.outcome,
          providerReceiptHash,
          actualCostMicros,
          input.completedAt,
          input.reservationId,
          input.expectedRevision,
        ],
      );
      if (settled.rowsAffected !== 1) {
        throw conflict("The failed exact evaluation settlement changed concurrently.");
      }
      await invalidateRun(transaction, reservation.run_id, input.completedAt);
      return readRequiredReservation(transaction, input.reservationId);
    });
  }

  public async markDispatchStarted(
    reservationId: string,
    expectedRevision: number,
    dispatchedAt: string,
  ): Promise<NovelSkillPaidEvaluationReservationRecord> {
    assertUuidV7(reservationId, "reservationId");
    assertRevision(expectedRevision);
    assertIsoUtc(dispatchedAt, "dispatchedAt");
    return this.executor.transaction(async (transaction) => {
      await requirePredispatchAuthoritySnapshot(transaction, reservationId, true);
      const [reservation] = await transaction.select<{
        readonly planned_model_invocation_id: string;
      }>(
        `SELECT planned_model_invocation_id FROM novel_skill_evaluation_dispatch_reservations WHERE id = ? AND revision = ? AND state = 'bound'`,
        [reservationId, expectedRevision],
      );
      if (reservation === undefined) {
        throw conflict("The bound dispatch reservation changed before provider dispatch.");
      }
      const invocation = await transaction.execute(
        `UPDATE model_invocation_facts SET status = 'running',started_at = ?,revision = revision+1 WHERE id = ? AND status = 'queued' AND revision = 1`,
        [dispatchedAt, reservation.planned_model_invocation_id],
      );
      if (invocation.rowsAffected !== 1) {
        throw conflict("The exact model invocation is not dispatchable.");
      }
      const dispatched = await transaction.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'dispatched',dispatched_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state = 'bound'`,
        [dispatchedAt, reservationId, expectedRevision],
      );
      if (dispatched.rowsAffected !== 1) {
        throw conflict("The dispatch reservation changed before provider dispatch.");
      }
      return readRequiredReservation(transaction, reservationId);
    });
  }

  public async markNotDispatched(
    reservationId: string,
    expectedRevision: number,
    terminalAt: string,
  ): Promise<NovelSkillPaidEvaluationReservationRecord> {
    assertUuidV7(reservationId, "reservationId");
    assertRevision(expectedRevision);
    assertIsoUtc(terminalAt, "terminalAt");
    return this.executor.transaction(async (transaction) => {
      const [reservation] = await transaction.select<{
        readonly attempt_id: string;
        readonly planned_model_invocation_id: string;
        readonly state: "reserved" | "bound";
      }>(
        `SELECT attempt_id,planned_model_invocation_id,state FROM novel_skill_evaluation_dispatch_reservations WHERE id = ? AND revision = ? AND state IN ('reserved','bound')`,
        [reservationId, expectedRevision],
      );
      if (reservation === undefined) throw conflict("The reservation cannot be released safely.");
      if (reservation.state === "bound") {
        await cancelPreDispatchInvocation(
          transaction,
          reservation.planned_model_invocation_id,
          terminalAt,
        );
      }
      await cancelPreDispatchAttempt(transaction, reservation.attempt_id, terminalAt);
      const released = await transaction.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'not_dispatched',terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state IN ('reserved','bound')`,
        [terminalAt, reservationId, expectedRevision],
      );
      if (released.rowsAffected !== 1) {
        throw conflict("The reservation changed while it was being released.");
      }
      return readRequiredReservation(transaction, reservationId);
    });
  }

  public async markDispatchAmbiguous(
    reservationId: string,
    expectedRevision: number,
    terminalAt: string,
  ): Promise<NovelSkillPaidEvaluationReservationRecord> {
    assertUuidV7(reservationId, "reservationId");
    assertRevision(expectedRevision);
    assertIsoUtc(terminalAt, "terminalAt");
    return this.executor.transaction(async (transaction) => {
      const [reservation] = await transaction.select<{
        readonly run_id: string;
        readonly attempt_id: string;
        readonly planned_model_invocation_id: string;
      }>(
        `SELECT run_id,attempt_id,planned_model_invocation_id FROM novel_skill_evaluation_dispatch_reservations WHERE id = ? AND revision = ? AND state = 'dispatched'`,
        [reservationId, expectedRevision],
      );
      if (reservation === undefined) throw conflict("The dispatch is not ambiguously recoverable.");
      await interruptDispatchedInvocation(
        transaction,
        reservation.planned_model_invocation_id,
        terminalAt,
      );
      await cancelDispatchedAttempt(transaction, reservation.attempt_id, terminalAt);
      const ambiguous = await transaction.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'ambiguous',terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state = 'dispatched'`,
        [terminalAt, reservationId, expectedRevision],
      );
      if (ambiguous.rowsAffected !== 1) {
        throw conflict("The dispatched reservation changed during recovery.");
      }
      await invalidateRun(transaction, reservation.run_id, terminalAt);
      return readRequiredReservation(transaction, reservationId);
    });
  }

  public async recoverInterruptedDispatches(
    runId: string,
    recoveredAt: string,
  ): Promise<Readonly<{ released: number; ambiguous: number }>> {
    assertUuidV7(runId, "runId");
    assertIsoUtc(recoveredAt, "recoveredAt");
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<ReservationRow>(
        `${RESERVATION_SELECT} WHERE run_id = ? AND state IN ('reserved','bound','dispatched')`,
        [runId],
      );
      let released = 0;
      let ambiguous = 0;
      for (const row of rows) {
        if (row.state === "dispatched") {
          await interruptDispatchedInvocation(
            transaction,
            row.planned_model_invocation_id,
            recoveredAt,
          );
          await cancelDispatchedAttempt(transaction, row.attempt_id, recoveredAt);
          const changed = await transaction.execute(
            `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'ambiguous',terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state = 'dispatched'`,
            [recoveredAt, row.id, row.revision],
          );
          if (changed.rowsAffected !== 1) {
            throw conflict("A dispatched reservation changed during restart recovery.");
          }
          ambiguous += 1;
        } else {
          if (row.state === "bound") {
            await cancelPreDispatchInvocation(
              transaction,
              row.planned_model_invocation_id,
              recoveredAt,
            );
          }
          await cancelPreDispatchAttempt(transaction, row.attempt_id, recoveredAt);
          const changed = await transaction.execute(
            `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'not_dispatched',terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state IN ('reserved','bound')`,
            [recoveredAt, row.id, row.revision],
          );
          if (changed.rowsAffected !== 1) {
            throw conflict("A predispatch reservation changed during restart recovery.");
          }
          released += 1;
        }
      }
      if (ambiguous > 0) await invalidateRun(transaction, runId, recoveredAt);
      return Object.freeze({ released, ambiguous });
    });
  }
}

export async function hashNovelSkillPaidEvaluationCommercialConfirmation(
  input: NovelSkillPaidEvaluationCommercialConfirmationInput,
): Promise<string> {
  assertUuidV7(input.quote.runId, "commercial confirmation runId");
  for (const value of [
    input.quote.protocolHash,
    input.quote.targetManifestHash,
    input.quote.pricingManifestHash,
    input.quote.quoteHash,
  ]) {
    assertHash(value, "commercial confirmation hash");
  }
  if (
    (input.quote as { readonly authorizedCallCount: unknown }).authorizedCallCount !==
    NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT
  ) {
    throw invalid("Commercial confirmation must cover exactly 192 provider calls.");
  }
  const quoteCurrencies = [...input.quote.currencies]
    .map(({ currency, estimatedMaximumCostMicros }) => ({
      currency: normalizeCurrency(currency),
      estimatedMaximumCostMicros: normalizeMicros(estimatedMaximumCostMicros),
    }))
    .sort((left, right) => compareText(left.currency, right.currency));
  const ceilings = [...input.hardCeilings]
    .map(({ currency, hardCeilingMicros }) => ({
      currency: normalizeCurrency(currency),
      hardCeilingMicros: normalizeMicros(hardCeilingMicros),
    }))
    .sort((left, right) => compareText(left.currency, right.currency));
  if (
    new Set(quoteCurrencies.map(({ currency }) => currency)).size !== quoteCurrencies.length ||
    new Set(ceilings.map(({ currency }) => currency)).size !== ceilings.length ||
    !sameStrings(
      quoteCurrencies.map(({ currency }) => currency),
      ceilings.map(({ currency }) => currency),
    )
  ) {
    throw invalid("Commercial confirmation currencies do not match the frozen quote.");
  }
  const currencies = quoteCurrencies.map((quoteCurrency) => {
    const ceiling = ceilings.find(({ currency }) => currency === quoteCurrency.currency);
    if (
      ceiling === undefined ||
      BigInt(ceiling.hardCeilingMicros) < BigInt(quoteCurrency.estimatedMaximumCostMicros)
    ) {
      throw invalid("Commercial confirmation hard ceiling is below the frozen quote.");
    }
    return { ...quoteCurrency, hardCeilingMicros: ceiling.hardCeilingMicros };
  });
  return sha256Hex(
    canonicalJson({
      version: "novel-skill-paid-commercial-confirmation@1",
      runId: input.quote.runId,
      protocolHash: input.quote.protocolHash,
      targetManifestHash: input.quote.targetManifestHash,
      pricingManifestHash: input.quote.pricingManifestHash,
      quoteHash: input.quote.quoteHash,
      authorizedCallCount: NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
      currencies,
      acknowledgements: {
        commercialUse: true,
        exactTargetsOnly: true,
        fallbackAllowed: false,
        automaticRetryAllowed: false,
        automaticResumeAfterRestart: false,
        perCurrencyHardCeilings: true,
      },
    }),
  );
}

/**
 * Hashes the complete content-free context compiler decision. Preference rows
 * are the one intentional arm variable and are bound separately by
 * `preferenceConfigurationHash`.
 */
export async function hashNovelSkillPaidEvaluationTraceBaseline(
  trace: ContextCompilationTrace,
): Promise<string> {
  const entries = trace.entries
    .filter(({ contextCandidateId }) => !contextCandidateId.startsWith("writing-preference:"))
    .map((entry) => ({
      contextCandidateId: entry.contextCandidateId,
      layer: entry.layer,
      selectionReason: entry.selectionReason,
      included: entry.included,
      discardedReason: entry.discardedReason,
      estimatedTokens: entry.estimatedTokens,
      evaluationOrder: entry.evaluationOrder,
      layerOrder: entry.layerOrder,
      priority: entry.priority,
      relevanceScore: entry.relevanceScore,
      required: entry.required,
      budgetRemainingBefore: entry.budgetRemainingBefore,
      budgetRemainingAfter: entry.budgetRemainingAfter,
      sources: entry.sources.map((source, sourceOrder) => ({
        sourceOrder: sourceOrder + 1,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceVersionId: source.sourceVersionId,
        locator: source.locator,
        contentHash: source.contentHash,
      })),
    }))
    .sort(
      (left, right) =>
        left.evaluationOrder - right.evaluationOrder ||
        compareText(left.contextCandidateId, right.contextCandidateId),
    );
  return sha256Hex(
    canonicalJson({
      version: "novel-skill-paid-evaluation-trace-baseline@1",
      taskType: trace.taskType,
      maximumContextTokens: trace.maximumContextTokens,
      requiredTokens: trace.requiredTokens,
      usedTokens: trace.usedTokens,
      remainingTokens: trace.remainingTokens,
      discardedTokens: trace.discardedTokens,
      tokenEstimateSource: trace.tokenEstimateSource,
      entries,
    }),
  );
}

export async function hashNovelSkillPaidEvaluationTracePreferenceConfiguration(
  trace: ContextCompilationTrace,
): Promise<string | null> {
  const preferenceEntries = trace.entries.filter(({ contextCandidateId }) =>
    contextCandidateId.startsWith("writing-preference:"),
  );
  if (preferenceEntries.length === 0) return null;
  const evidence = preferenceEntries.flatMap((entry) => {
    if (!entry.included || entry.sources.length < 1) {
      throw invalid("Paid evaluation preference trace entries must be included and sourced.");
    }
    return entry.sources.map((source) => {
      if (
        source.sourceType !== "user_input" ||
        source.locator !== "writing_preference" ||
        source.contentHash === null
      ) {
        throw invalid("Paid evaluation preference trace evidence is malformed.");
      }
      return {
        sourceId: source.sourceId,
        sourceVersionId: source.sourceVersionId,
        contentHash: source.contentHash,
      };
    });
  });
  return hashNovelSkillEvaluationPreferenceConfiguration(evidence);
}

async function reserveAttemptDispatch(
  transaction: TransactionExecutor,
  input: ReserveNovelSkillPaidEvaluationDispatchInput,
  payloadManifest: NovelSkillPaidEvaluationPayloadAuthorityManifest,
  payloadManifestHash: string,
): Promise<NovelSkillPaidEvaluationReservationRecord> {
  const [target] = await transaction.select<{
    readonly target_hash: string;
    readonly pricing_snapshot_hash: string;
    readonly connection_id: string;
    readonly catalog_entry_id: string;
    readonly provider_kind_snapshot: string;
    readonly provider_model_id_snapshot: string;
    readonly connection_revision: number;
    readonly catalog_revision: number;
    readonly cost_profile_revision: number;
    readonly currency: string;
    readonly input_rate: string;
    readonly output_rate: string;
    readonly data_destination: "local" | "remote";
    readonly maximum_input_tokens: number;
    readonly maximum_output_tokens: number;
    readonly suite_id: string;
    readonly fixture_id: string;
    readonly task_type: string;
    readonly invocation_mode: string;
    readonly fixture_contract_hash: string;
    readonly fixture_input_content_hash: string;
    readonly arm: string;
    readonly arm_configuration_hash: string | null;
    readonly repetition: 1 | 2;
    readonly protocol_hash: string;
    readonly request_profile_hash: string;
    readonly context_baseline_hash: string;
    readonly prompt_template_hash: string;
  }>(
    `SELECT target.target_hash,target.pricing_snapshot_hash,target.connection_id,target.catalog_entry_id,target.provider_kind_snapshot,target.provider_model_id_snapshot,target.connection_revision,target.catalog_revision,target.cost_profile_revision,target.currency,target.input_micros_per_million_tokens AS input_rate,target.output_micros_per_million_tokens AS output_rate,cost.data_destination,profile.maximum_input_tokens,profile.maximum_output_tokens,cell.suite_id,cell.fixture_id,fixture.task_type,fixture.invocation_mode,fixture.contract_hash AS fixture_contract_hash,fixture.input_content_hash AS fixture_input_content_hash,cell.arm,cell.arm_configuration_hash,cell.repetition,protocol.protocol_hash,profile.request_profile_hash,baseline.compiled_baseline_hash AS context_baseline_hash,protocol.prompt_template_hash FROM novel_skill_evaluation_run_model_targets AS target INNER JOIN novel_skill_evaluation_cells AS cell ON cell.run_id = target.run_id AND cell.model_slot_id = target.model_slot_id INNER JOIN novel_skill_evaluation_fixtures AS fixture ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id INNER JOIN novel_skill_evaluation_request_profiles AS profile ON profile.suite_id = cell.suite_id AND profile.task_type = fixture.task_type INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = cell.suite_id INNER JOIN novel_skill_evaluation_context_baselines AS baseline ON baseline.suite_id = cell.suite_id AND baseline.fixture_id = cell.fixture_id INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = target.catalog_entry_id WHERE target.run_id = ? AND target.model_slot_id = ? AND cell.id = ?`,
    [input.runId, input.modelSlotId, input.cellId],
  );
  const liveTarget =
    target === undefined ? null : await readLiveTarget(transaction, input.receipt.target);
  const livePricingSnapshotHash =
    liveTarget === null ? null : await sha256Hex(canonicalJson(costProjection(liveTarget)));
  const expectedTargetIdentityHash =
    liveTarget === null || livePricingSnapshotHash === null
      ? null
      : await hashLiveExactTarget(
          liveTarget,
          input.receipt.target.capabilityEvidenceHash,
          livePricingSnapshotHash,
        );
  const reservedMaximumCostMicros =
    target === undefined
      ? null
      : calculateMaximumCost(
          target.maximum_input_tokens,
          target.maximum_output_tokens,
          target.input_rate,
          target.output_rate,
        ).toString();
  const expectedInvariantHash =
    target === undefined
      ? null
      : await hashNovelSkillPaidEvaluationInvariantRequest({
          runId: input.runId,
          suiteId: target.suite_id,
          fixtureId: target.fixture_id,
          taskType: target.task_type,
          modelSlotId: input.modelSlotId,
          repetition: target.repetition,
          protocolHash: target.protocol_hash,
          requestProfileHash: target.request_profile_hash,
          contextBaselineHash: target.context_baseline_hash,
          promptTemplateHash: target.prompt_template_hash,
        });
  const expectedExecutionLockHash =
    target === undefined
      ? null
      : await hashModelHubExactEvaluationExecutionLock({
          targetIdentityHash: target.target_hash,
          requestProfileHash: target.request_profile_hash,
          payloadHash: input.receipt.payloadHash,
          currency: target.currency,
          estimatedMaximumCostMicros: input.receipt.estimatedMaximumCostMicros,
        });
  const mismatch =
    target === undefined
      ? "target"
      : livePricingSnapshotHash !== target.pricing_snapshot_hash ||
          expectedTargetIdentityHash !== target.target_hash
        ? "target_authority"
        : target.target_hash !== input.receipt.target.targetIdentityHash
          ? "target_identity"
          : target.connection_id !== input.receipt.target.connectionId ||
              target.catalog_entry_id !== input.receipt.target.catalogEntryId ||
              target.provider_kind_snapshot !== input.receipt.target.providerKind ||
              target.provider_model_id_snapshot !== input.receipt.target.modelId
            ? "target_selector"
            : target.connection_revision !== input.receipt.target.connectionRevision ||
                target.catalog_revision !== input.receipt.target.catalogRevision ||
                target.cost_profile_revision !== input.receipt.target.costPrivacyRevision
              ? "target_revision"
              : target.pricing_snapshot_hash !== input.receipt.target.costProfileHash
                ? "pricing"
                : target.currency !== input.receipt.currency
                  ? "currency"
                  : target.request_profile_hash !== input.receipt.requestProfileHash
                    ? "request_profile"
                    : target.data_destination !== input.receipt.dataDestination
                      ? "data_destination"
                      : target.context_baseline_hash !== input.contextBaselineHash
                        ? "context_baseline"
                        : target.prompt_template_hash !== input.promptTemplateHash
                          ? "prompt_template"
                          : payloadManifest.suiteId !== target.suite_id ||
                              payloadManifest.fixtureId !== target.fixture_id ||
                              payloadManifest.taskType !== target.task_type ||
                              payloadManifest.invocationMode !== target.invocation_mode ||
                              payloadManifest.fixtureContractHash !==
                                target.fixture_contract_hash ||
                              payloadManifest.fixtureInputContentHash !==
                                target.fixture_input_content_hash ||
                              payloadManifest.arm !== target.arm ||
                              payloadManifest.armConfigurationHash !==
                                target.arm_configuration_hash ||
                              payloadManifest.repetition !== target.repetition
                            ? "payload_authority"
                            : expectedInvariantHash !== input.invariantRequestHash
                              ? "invariant_request"
                              : expectedExecutionLockHash !== input.receipt.executionLockHash
                                ? "execution_lock"
                                : reservedMaximumCostMicros === null ||
                                    BigInt(input.receipt.estimatedMaximumCostMicros) >
                                      BigInt(reservedMaximumCostMicros)
                                  ? "cost_reservation"
                                  : null;
  if (mismatch !== null) {
    throw conflict(
      `The exact predispatch receipt does not match the authorized model target (${mismatch}).`,
    );
  }
  if (target === undefined || reservedMaximumCostMicros === null) {
    throw conflict("The exact predispatch target is unavailable.");
  }
  const existing = await readReservationByAttempt(transaction, input.attemptId);
  if (existing !== null) {
    if (
      existing.id === input.reservationId &&
      existing.runId === input.runId &&
      existing.cellId === input.cellId &&
      existing.plannedContextTraceId === input.plannedContextTraceId &&
      existing.plannedModelInvocationId === input.plannedModelInvocationId &&
      existing.plannedCandidateId === input.plannedCandidateId
    ) {
      await assertExistingReservationMatchesInput(
        transaction,
        input,
        reservedMaximumCostMicros,
        payloadManifestHash,
      );
      return existing;
    }
    throw conflict("The attempt already has a different immutable dispatch reservation.");
  }
  await transaction.execute(
    `INSERT INTO novel_skill_evaluation_dispatch_reservations(id,authorization_id,run_id,cell_id,attempt_id,model_slot_id,dispatch_generation,planned_context_trace_id,planned_model_invocation_id,planned_candidate_id,state,target_hash,pricing_snapshot_hash,request_profile_hash,context_baseline_hash,prompt_template_hash,invariant_request_hash,request_payload_hash,execution_lock_hash,message_payload_hash,payload_authority_version,payload_authority_manifest_hash,data_destination,skill_configuration_hash,preference_configuration_hash,idempotency_key_hash,currency,reserved_max_cost_micros,settlement_outcome,provider_receipt_hash,provider_visible_output_hash,output_candidate_id,actual_cost_micros,reserved_at,bound_at,dispatched_at,terminal_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,NULL,NULL,NULL,1)`,
    [
      input.reservationId,
      input.authorizationId,
      input.runId,
      input.cellId,
      input.attemptId,
      input.modelSlotId,
      input.dispatchGeneration,
      input.plannedContextTraceId,
      input.plannedModelInvocationId,
      input.plannedCandidateId,
      target.target_hash,
      target.pricing_snapshot_hash,
      input.receipt.requestProfileHash,
      input.contextBaselineHash,
      input.promptTemplateHash,
      input.invariantRequestHash,
      input.receipt.payloadHash,
      input.receipt.executionLockHash,
      input.receipt.messagePayloadHash,
      NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION,
      payloadManifestHash,
      input.receipt.dataDestination,
      input.skillConfigurationHash,
      input.preferenceConfigurationHash,
      input.idempotencyKeyHash,
      target.currency,
      reservedMaximumCostMicros,
      input.reservedAt,
    ],
  );
  const created = await readReservationByAttempt(transaction, input.attemptId);
  if (created === null) throw conflict("The dispatch reservation was not persisted.");
  return created;
}

export async function hashNovelSkillPaidEvaluationInvariantRequest(
  input: NovelSkillPaidEvaluationInvariantRequestInput,
): Promise<string> {
  assertUuidV7(input.runId, "runId");
  assertUuidV7(input.suiteId, "suiteId");
  assertPortableLocator(input.fixtureId, "fixtureId", 128);
  assertPortableLocator(input.taskType, "taskType", 128);
  if (!(["text_tier_a", "text_tier_b"] as const).includes(input.modelSlotId)) {
    throw invalid("The invariant request model slot is invalid.");
  }
  const runtimeRepetition: unknown = input.repetition;
  if (runtimeRepetition !== 1 && runtimeRepetition !== 2) {
    throw invalid("The invariant request repetition is invalid.");
  }
  for (const [hash, label] of [
    [input.protocolHash, "protocolHash"],
    [input.requestProfileHash, "requestProfileHash"],
    [input.contextBaselineHash, "contextBaselineHash"],
    [input.promptTemplateHash, "promptTemplateHash"],
  ] as const) {
    assertHash(hash, label);
  }
  return sha256Hex(
    canonicalJson({
      version: "novel-skill-paid-evaluation-invariant-request@1",
      runId: input.runId,
      suiteId: input.suiteId,
      fixtureId: input.fixtureId,
      taskType: input.taskType,
      modelSlotId: input.modelSlotId,
      repetition: input.repetition,
      protocolHash: input.protocolHash,
      requestProfileHash: input.requestProfileHash,
      contextBaselineHash: input.contextBaselineHash,
      promptTemplateHash: input.promptTemplateHash,
    }),
  );
}

async function assertExistingReservationMatchesInput(
  transaction: TransactionExecutor,
  input: ReserveNovelSkillPaidEvaluationDispatchInput,
  reservedMaximumCostMicros: string,
  payloadManifestHash: string,
): Promise<void> {
  const [row] = await transaction.select<{ readonly valid: number }>(
    `SELECT count(*) AS valid FROM novel_skill_evaluation_dispatch_reservations WHERE id = ? AND authorization_id = ? AND run_id = ? AND cell_id = ? AND attempt_id = ? AND model_slot_id = ? AND dispatch_generation = ? AND planned_context_trace_id = ? AND planned_model_invocation_id = ? AND planned_candidate_id = ? AND target_hash = ? AND pricing_snapshot_hash = ? AND request_profile_hash = ? AND context_baseline_hash = ? AND prompt_template_hash = ? AND invariant_request_hash = ? AND request_payload_hash = ? AND execution_lock_hash = ? AND message_payload_hash = ? AND payload_authority_version = ? AND payload_authority_manifest_hash = ? AND data_destination = ? AND skill_configuration_hash IS ? AND preference_configuration_hash IS ? AND idempotency_key_hash = ? AND currency = ? AND reserved_max_cost_micros = ? AND reserved_at = ?`,
    [
      input.reservationId,
      input.authorizationId,
      input.runId,
      input.cellId,
      input.attemptId,
      input.modelSlotId,
      input.dispatchGeneration,
      input.plannedContextTraceId,
      input.plannedModelInvocationId,
      input.plannedCandidateId,
      input.receipt.target.targetIdentityHash,
      input.receipt.target.costProfileHash,
      input.receipt.requestProfileHash,
      input.contextBaselineHash,
      input.promptTemplateHash,
      input.invariantRequestHash,
      input.receipt.payloadHash,
      input.receipt.executionLockHash,
      input.receipt.messagePayloadHash,
      NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION,
      payloadManifestHash,
      input.receipt.dataDestination,
      input.skillConfigurationHash,
      input.preferenceConfigurationHash,
      input.idempotencyKeyHash,
      input.receipt.currency,
      reservedMaximumCostMicros,
      input.reservedAt,
    ],
  );
  if (row?.valid !== 1) {
    throw conflict("The idempotent dispatch reservation payload does not match its receipt.");
  }
}

function providerReceiptShapeProjection(receipt: ModelHubExactEvaluationPredispatchReceipt) {
  return {
    version: NOVEL_SKILL_PAID_EVALUATION_PROVIDER_RECEIPT_SHAPE_VERSION,
    generationId: receipt.generationId,
    target: {
      connectionId: receipt.target.connectionId,
      catalogEntryId: receipt.target.catalogEntryId,
      providerKind: receipt.target.providerKind,
      modelId: receipt.target.modelId,
      connectionRevision: receipt.target.connectionRevision,
      catalogRevision: receipt.target.catalogRevision,
      costPrivacyRevision: receipt.target.costPrivacyRevision,
      capabilityEvidenceHash: receipt.target.capabilityEvidenceHash,
      costProfileHash: receipt.target.costProfileHash,
      targetIdentityHash: receipt.target.targetIdentityHash,
    },
    requestProfileHash: receipt.requestProfileHash,
    messagePayloadHash: receipt.messagePayloadHash,
    payloadHash: receipt.payloadHash,
    executionLockHash: receipt.executionLockHash,
    currency: receipt.currency,
    estimatedMaximumCostMicros: receipt.estimatedMaximumCostMicros,
    dataDestination: receipt.dataDestination,
  };
}

function providerReceiptShapeProjectionFromRow(row: PredispatchAuthorityRow) {
  return providerReceiptShapeProjection({
    generationId: row.generation_id,
    target: {
      connectionId: row.connection_id,
      catalogEntryId: row.catalog_entry_id,
      providerKind:
        row.provider_kind as ModelHubExactEvaluationPredispatchReceipt["target"]["providerKind"],
      modelId: row.provider_model_id,
      connectionRevision: row.connection_revision,
      catalogRevision: row.catalog_revision,
      costPrivacyRevision: row.cost_privacy_revision,
      capabilityEvidenceHash: row.capability_evidence_hash,
      costProfileHash: row.cost_profile_hash,
      targetIdentityHash: row.target_identity_hash,
    },
    requestProfileHash: row.request_profile_hash,
    messagePayloadHash: row.message_payload_hash,
    payloadHash: row.request_payload_hash,
    executionLockHash: row.execution_lock_hash,
    currency: row.currency,
    estimatedMaximumCostMicros: row.exact_predispatch_estimated_max_cost_micros,
    dataDestination: row.data_destination,
  });
}

function payloadAuthorityManifestProjectionFromRow(row: PredispatchAuthorityRow) {
  return {
    schemaVersion: row.payload_authority_schema_version,
    authorityVersion: row.payload_authority_version,
    runId: row.run_id,
    suiteId: row.suite_id,
    cellId: row.cell_id,
    fixtureId: row.fixture_id,
    fixtureContractHash: row.fixture_contract_hash,
    fixtureInputContentHash: row.fixture_input_content_hash,
    taskType: row.task_type,
    invocationMode: row.invocation_mode,
    genreTagsHash: row.genre_tags_hash,
    coverageDimensionsHash: row.coverage_dimensions_hash,
    arm: row.arm,
    armConfigurationHash: row.arm_configuration_hash,
    modelSlotId: row.model_slot_id,
    repetition: row.repetition,
    promptTemplateVersion: row.prompt_template_version,
    promptTemplateHash: row.prompt_template_hash,
    contextBaselineHash: row.context_baseline_hash,
    contextBaselineProjectionHash: row.context_baseline_projection_hash,
    availableContextLayersHash: row.available_context_layers_hash,
    skillCompilerVersion: row.skill_compiler_version,
    skillSelectionHash: row.skill_selection_hash,
    compiledSkillSnapshotHash: row.compiled_skill_snapshot_hash,
    renderedSkillSectionHash: row.rendered_skill_section_hash,
    preferenceConfigurationHash: row.preference_configuration_hash,
    preferenceProjectionHash: row.preference_projection_hash,
    renderedPreferenceSectionHash: row.rendered_preference_section_hash,
    baseMessagePayloadHash: row.base_message_payload_hash,
    messagePayloadHash: row.message_payload_hash,
  };
}

function finalDispatchAuthorityProjection(
  reservation: ReserveNovelSkillPaidEvaluationDispatchInput,
  payloadAuthorityManifestHash: string,
  providerReceiptShapeHash: string,
) {
  return {
    version: NOVEL_SKILL_PAID_EVALUATION_FINAL_DISPATCH_AUTHORITY_VERSION,
    reservationId: reservation.reservationId,
    authorizationId: reservation.authorizationId,
    runId: reservation.runId,
    cellId: reservation.cellId,
    attemptId: reservation.attemptId,
    modelSlotId: reservation.modelSlotId,
    dispatchGeneration: reservation.dispatchGeneration,
    plannedContextTraceId: reservation.plannedContextTraceId,
    plannedModelInvocationId: reservation.plannedModelInvocationId,
    plannedCandidateId: reservation.plannedCandidateId,
    idempotencyKeyHash: reservation.idempotencyKeyHash,
    payloadAuthorityManifestHash,
    providerReceiptShapeHash,
  };
}

function finalDispatchAuthorityProjectionFromRow(row: PredispatchAuthorityRow) {
  return {
    version: row.final_dispatch_authority_version,
    reservationId: row.reservation_id,
    authorizationId: row.authorization_id,
    runId: row.run_id,
    cellId: row.cell_id,
    attemptId: row.attempt_id,
    modelSlotId: row.model_slot_id,
    dispatchGeneration: row.dispatch_generation,
    plannedContextTraceId: row.planned_context_trace_id,
    plannedModelInvocationId: row.planned_model_invocation_id,
    plannedCandidateId: row.planned_candidate_id,
    idempotencyKeyHash: row.idempotency_key_hash,
    payloadAuthorityManifestHash: row.payload_authority_manifest_hash,
    providerReceiptShapeHash: row.provider_receipt_shape_hash,
  };
}

function predispatchAuthoritySnapshotProjection(
  reservationId: string,
  manifest: Readonly<Record<string, unknown>> | NovelSkillPaidEvaluationPayloadAuthorityManifest,
  payloadAuthorityManifestHash: string,
  providerReceiptShapeHash: string,
  finalDispatchAuthorityHash: string,
  exactPredispatchEstimatedMaximumCostMicros: string,
  capturedAt: string,
) {
  return {
    schemaVersion: 1,
    version: NOVEL_SKILL_PAID_EVALUATION_PREDISPATCH_AUTHORITY_VERSION,
    reservationId,
    payloadAuthorityManifest: manifest,
    payloadAuthorityManifestHash,
    providerReceiptShapeVersion: NOVEL_SKILL_PAID_EVALUATION_PROVIDER_RECEIPT_SHAPE_VERSION,
    providerReceiptShapeHash,
    finalDispatchAuthorityVersion: NOVEL_SKILL_PAID_EVALUATION_FINAL_DISPATCH_AUTHORITY_VERSION,
    finalDispatchAuthorityHash,
    exactPredispatchEstimatedMaximumCostMicros,
    capturedAt,
  };
}

async function readPredispatchAuthorityRow(
  transaction: TransactionExecutor,
  reservationId: string,
): Promise<PredispatchAuthorityRow | null> {
  const rows = await transaction.select<PredispatchAuthorityRow>(
    `${PREDISPATCH_AUTHORITY_SELECT} WHERE snapshot.reservation_id = ?`,
    [reservationId],
  );
  if (rows.length > 1) throw conflict("The predispatch authority snapshot is not unique.");
  return rows[0] ?? null;
}

async function verifyPredispatchLiveTargetAuthority(
  transaction: TransactionExecutor,
  row: PredispatchAuthorityRow,
): Promise<void> {
  const liveTarget = await readLiveTarget(transaction, {
    connectionId: row.connection_id,
    catalogEntryId: row.catalog_entry_id,
    providerKind:
      row.provider_kind as ModelHubExactEvaluationPredispatchReceipt["target"]["providerKind"],
    modelId: row.provider_model_id,
    connectionRevision: row.connection_revision,
    catalogRevision: row.catalog_revision,
    costPrivacyRevision: row.cost_privacy_revision,
    capabilityEvidenceHash: row.capability_evidence_hash,
    costProfileHash: row.cost_profile_hash,
    targetIdentityHash: row.target_identity_hash,
  });
  const liveCostProfileHash = await sha256Hex(canonicalJson(costProjection(liveTarget)));
  const liveTargetIdentityHash = await hashLiveExactTarget(
    liveTarget,
    row.capability_evidence_hash,
    liveCostProfileHash,
  );
  if (
    row.cost_profile_hash !== liveCostProfileHash ||
    row.target_identity_hash !== liveTargetIdentityHash
  ) {
    throw conflict("The persisted predispatch target is no longer live and exact.");
  }
}

async function verifyPredispatchAuthorityRow(row: PredispatchAuthorityRow): Promise<void> {
  const manifest = payloadAuthorityManifestProjectionFromRow(row);
  const manifestHash = await sha256Hex(canonicalJson(manifest));
  const providerReceiptShapeHash = await sha256Hex(
    canonicalJson(providerReceiptShapeProjectionFromRow(row)),
  );
  const executionLockHash = await hashModelHubExactEvaluationExecutionLock({
    targetIdentityHash: row.target_identity_hash,
    requestProfileHash: row.request_profile_hash,
    payloadHash: row.request_payload_hash,
    currency: row.currency,
    estimatedMaximumCostMicros: row.exact_predispatch_estimated_max_cost_micros,
  });
  const finalDispatchAuthorityHash = await sha256Hex(
    canonicalJson(finalDispatchAuthorityProjectionFromRow(row)),
  );
  const snapshot = predispatchAuthoritySnapshotProjection(
    row.reservation_id,
    manifest,
    row.payload_authority_manifest_hash,
    row.provider_receipt_shape_hash,
    row.final_dispatch_authority_hash,
    row.exact_predispatch_estimated_max_cost_micros,
    row.captured_at,
  );
  const authoritySnapshotHash = await sha256Hex(canonicalJson(snapshot));
  if (
    row.schema_version !== 1 ||
    row.authority_snapshot_version !== NOVEL_SKILL_PAID_EVALUATION_PREDISPATCH_AUTHORITY_VERSION ||
    row.payload_authority_schema_version !== 1 ||
    row.payload_authority_version !== NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION ||
    row.provider_receipt_shape_version !==
      NOVEL_SKILL_PAID_EVALUATION_PROVIDER_RECEIPT_SHAPE_VERSION ||
    row.final_dispatch_authority_version !==
      NOVEL_SKILL_PAID_EVALUATION_FINAL_DISPATCH_AUTHORITY_VERSION ||
    row.generation_id !== row.planned_model_invocation_id ||
    row.run_id !== row.reservation_run_id ||
    row.cell_id !== row.reservation_cell_id ||
    row.model_slot_id !== row.reservation_model_slot_id ||
    row.target_identity_hash !== row.reservation_target_hash ||
    row.cost_profile_hash !== row.reservation_pricing_snapshot_hash ||
    row.request_profile_hash !== row.reservation_request_profile_hash ||
    row.message_payload_hash !== row.reservation_message_payload_hash ||
    row.request_payload_hash !== row.reservation_request_payload_hash ||
    row.execution_lock_hash !== row.reservation_execution_lock_hash ||
    row.execution_lock_hash !== executionLockHash ||
    row.payload_authority_manifest_hash !== row.reservation_payload_authority_manifest_hash ||
    row.currency !== row.reservation_currency ||
    row.data_destination !== row.reservation_data_destination ||
    row.captured_at !== row.reservation_reserved_at ||
    (row.arm === "no_skill" && row.base_message_payload_hash !== row.message_payload_hash) ||
    BigInt(row.exact_predispatch_estimated_max_cost_micros) >
      BigInt(row.reservation_reserved_max_cost_micros) ||
    manifestHash !== row.payload_authority_manifest_hash ||
    providerReceiptShapeHash !== row.provider_receipt_shape_hash ||
    finalDispatchAuthorityHash !== row.final_dispatch_authority_hash ||
    authoritySnapshotHash !== row.authority_snapshot_hash
  ) {
    throw conflict("The persisted predispatch authority snapshot is not canonically verifiable.");
  }
}

async function requirePredispatchAuthoritySnapshot(
  transaction: TransactionExecutor,
  reservationId: string,
  requireLiveTarget = false,
): Promise<PredispatchAuthorityRow> {
  const row = await readPredispatchAuthorityRow(transaction, reservationId);
  if (row === null) {
    throw conflict("The dispatch has no verifiable content-free predispatch authority snapshot.");
  }
  await verifyPredispatchAuthorityRow(row);
  if (requireLiveTarget) await verifyPredispatchLiveTargetAuthority(transaction, row);
  return row;
}

async function persistPredispatchAuthoritySnapshot(
  transaction: TransactionExecutor,
  reservation: ReserveNovelSkillPaidEvaluationDispatchInput,
  manifest: NovelSkillPaidEvaluationPayloadAuthorityManifest,
  payloadAuthorityManifestHash: string,
): Promise<void> {
  const providerReceiptShapeHash = await sha256Hex(
    canonicalJson(providerReceiptShapeProjection(reservation.receipt)),
  );
  const finalDispatchAuthorityHash = await sha256Hex(
    canonicalJson(
      finalDispatchAuthorityProjection(
        reservation,
        payloadAuthorityManifestHash,
        providerReceiptShapeHash,
      ),
    ),
  );
  const snapshot = predispatchAuthoritySnapshotProjection(
    reservation.reservationId,
    manifest,
    payloadAuthorityManifestHash,
    providerReceiptShapeHash,
    finalDispatchAuthorityHash,
    reservation.receipt.estimatedMaximumCostMicros,
    reservation.reservedAt,
  );
  const authoritySnapshotHash = await sha256Hex(canonicalJson(snapshot));
  const existing = await readPredispatchAuthorityRow(transaction, reservation.reservationId);
  if (existing !== null) {
    await verifyPredispatchAuthorityRow(existing);
    await verifyPredispatchLiveTargetAuthority(transaction, existing);
    const existingProjection = predispatchAuthoritySnapshotProjection(
      existing.reservation_id,
      payloadAuthorityManifestProjectionFromRow(existing),
      existing.payload_authority_manifest_hash,
      existing.provider_receipt_shape_hash,
      existing.final_dispatch_authority_hash,
      existing.exact_predispatch_estimated_max_cost_micros,
      existing.captured_at,
    );
    if (
      canonicalJson(existingProjection) !== canonicalJson(snapshot) ||
      existing.authority_snapshot_hash !== authoritySnapshotHash
    ) {
      throw conflict("The idempotent predispatch authority snapshot has drifted.");
    }
    return;
  }
  const values: readonly (string | number | null)[] = [
    reservation.reservationId,
    1,
    NOVEL_SKILL_PAID_EVALUATION_PREDISPATCH_AUTHORITY_VERSION,
    manifest.schemaVersion,
    manifest.authorityVersion,
    payloadAuthorityManifestHash,
    manifest.runId,
    manifest.suiteId,
    manifest.cellId,
    manifest.fixtureId,
    manifest.fixtureContractHash,
    manifest.fixtureInputContentHash,
    manifest.taskType,
    manifest.invocationMode,
    manifest.genreTagsHash,
    manifest.coverageDimensionsHash,
    manifest.arm,
    manifest.armConfigurationHash,
    manifest.modelSlotId,
    manifest.repetition,
    manifest.promptTemplateVersion,
    manifest.promptTemplateHash,
    manifest.contextBaselineHash,
    manifest.contextBaselineProjectionHash,
    manifest.availableContextLayersHash,
    manifest.skillCompilerVersion,
    manifest.skillSelectionHash,
    manifest.compiledSkillSnapshotHash,
    manifest.renderedSkillSectionHash,
    manifest.preferenceConfigurationHash,
    manifest.preferenceProjectionHash,
    manifest.renderedPreferenceSectionHash,
    manifest.baseMessagePayloadHash,
    manifest.messagePayloadHash,
    reservation.receipt.generationId,
    reservation.receipt.target.connectionId,
    reservation.receipt.target.catalogEntryId,
    reservation.receipt.target.providerKind,
    reservation.receipt.target.modelId,
    reservation.receipt.target.connectionRevision,
    reservation.receipt.target.catalogRevision,
    reservation.receipt.target.costPrivacyRevision,
    reservation.receipt.target.capabilityEvidenceHash,
    reservation.receipt.target.costProfileHash,
    reservation.receipt.target.targetIdentityHash,
    reservation.receipt.requestProfileHash,
    reservation.receipt.payloadHash,
    reservation.receipt.executionLockHash,
    reservation.receipt.currency,
    reservation.receipt.estimatedMaximumCostMicros,
    reservation.receipt.dataDestination,
    NOVEL_SKILL_PAID_EVALUATION_PROVIDER_RECEIPT_SHAPE_VERSION,
    providerReceiptShapeHash,
    NOVEL_SKILL_PAID_EVALUATION_FINAL_DISPATCH_AUTHORITY_VERSION,
    finalDispatchAuthorityHash,
    authoritySnapshotHash,
    reservation.reservedAt,
  ];
  const inserted = await transaction.execute(
    `INSERT INTO novel_skill_evaluation_predispatch_authority_snapshots(${PREDISPATCH_AUTHORITY_COLUMNS.join(", ")}) VALUES(${PREDISPATCH_AUTHORITY_COLUMNS.map(() => "?").join(", ")})`,
    values,
  );
  if (inserted.rowsAffected !== 1) {
    throw conflict("The predispatch authority snapshot was not persisted atomically.");
  }
  const persisted = await requirePredispatchAuthoritySnapshot(
    transaction,
    reservation.reservationId,
    true,
  );
  if (persisted.authority_snapshot_hash !== authoritySnapshotHash) {
    throw conflict("The persisted predispatch authority snapshot changed unexpectedly.");
  }
}

function assertEvaluationTraceBinding(
  input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
): void {
  const { reservation, trace } = input;
  assertUuidV7(trace.id, "trace.id");
  assertUuidV7(trace.projectId, "trace.projectId");
  assertUuidV7(reservation.receipt.generationId, "generationId");
  assertIsoUtc(trace.createdAt, "trace.createdAt");
  if (
    trace.id !== reservation.plannedContextTraceId ||
    trace.chapterId !== null ||
    trace.outputCandidateId !== null ||
    trace.execution?.generationId !== reservation.receipt.generationId ||
    trace.execution.generationRunId !== null ||
    trace.execution.modelInvocationId !== reservation.plannedModelInvocationId ||
    trace.entries.length < 1 ||
    trace.createdAt > input.boundAt
  ) {
    throw invalid("The evaluation trace does not match its exact predispatch reservation.");
  }
  assertContentFreeAuditLocator(trace.tokenEstimateSource, "trace token estimate source", 64);
  for (const entry of trace.entries) {
    assertContentFreeAuditLocator(entry.contextCandidateId, "trace candidate id", 192);
    assertContentFreeAuditLocator(entry.layer, "trace layer", 64);
    assertContentFreeAuditLocator(entry.selectionReason, "trace selection reason", 128);
    if (entry.discardedReason !== null) {
      assertContentFreeAuditLocator(entry.discardedReason, "trace discarded reason", 128);
    }
    for (const source of entry.sources) {
      assertContentFreeAuditLocator(source.sourceType, "trace source type", 64);
      assertContentFreeAuditLocator(source.sourceId, "trace source id", 192);
      if (source.sourceVersionId !== null) {
        assertContentFreeAuditLocator(source.sourceVersionId, "trace source version", 192);
      }
      if (source.locator !== null) {
        assertContentFreeAuditLocator(source.locator, "trace source locator", 192);
      }
      if (source.contentHash !== null) assertHash(source.contentHash, "trace source content hash");
    }
  }
}

function assertPayloadAuthorityBinding(
  input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
  manifest: NovelSkillPaidEvaluationPayloadAuthorityManifest,
): void {
  const { reservation } = input;
  if (
    (manifest as { readonly authorityVersion: unknown }).authorityVersion !==
      NOVEL_SKILL_PAID_EVALUATION_PAYLOAD_AUTHORITY_VERSION ||
    manifest.runId !== reservation.runId ||
    manifest.cellId !== reservation.cellId ||
    manifest.modelSlotId !== reservation.modelSlotId ||
    manifest.messagePayloadHash !== reservation.receipt.messagePayloadHash ||
    manifest.contextBaselineHash !== reservation.contextBaselineHash ||
    manifest.promptTemplateHash !== reservation.promptTemplateHash ||
    manifest.armConfigurationHash !== reservation.skillConfigurationHash ||
    manifest.preferenceConfigurationHash !== reservation.preferenceConfigurationHash
  ) {
    throw invalid("The exact dispatch is not bound to its authoritative evaluation payload.");
  }
}

async function insertEvaluationTrace(
  transaction: TransactionExecutor,
  reservationId: string,
  trace: ContextCompilationTrace,
): Promise<void> {
  const includedCount = trace.entries.filter(({ included }) => included).length;
  const discardedCount = trace.entries.length - includedCount;
  const run = await transaction.execute(
    `INSERT INTO context_compilation_runs(id,project_id,chapter_id,task_type,maximum_context_tokens,required_tokens,used_tokens,remaining_tokens,discarded_tokens,token_estimate_source,candidate_count,included_count,discarded_count,created_at) SELECT ?,suite.evaluation_project_id,NULL,fixture.task_type,?,?,?,?,?,?,?,?,?,? FROM novel_skill_evaluation_dispatch_reservations AS reservation INNER JOIN novel_skill_evaluation_runs AS evaluation_run ON evaluation_run.id = reservation.run_id INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = evaluation_run.suite_id INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id INNER JOIN novel_skill_evaluation_fixtures AS fixture ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id WHERE reservation.id = ? AND reservation.state = 'reserved' AND suite.evaluation_project_id = ? AND fixture.task_type = ?`,
    [
      trace.id,
      trace.maximumContextTokens,
      trace.requiredTokens,
      trace.usedTokens,
      trace.remainingTokens,
      trace.discardedTokens,
      trace.tokenEstimateSource,
      trace.entries.length,
      includedCount,
      discardedCount,
      trace.createdAt,
      reservationId,
      trace.projectId,
      trace.taskType,
    ],
  );
  if (run.rowsAffected !== 1) throw conflict("The evaluation context trace was not created.");
  for (const entry of trace.entries) {
    await transaction.execute(
      `INSERT INTO context_compilation_entries(run_id,candidate_id,layer,selection_reason,included,discarded_reason,estimated_tokens,evaluation_order,layer_order,priority,relevance_score,required,budget_remaining_before,budget_remaining_after) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        trace.id,
        entry.contextCandidateId,
        entry.layer,
        entry.selectionReason,
        entry.included ? 1 : 0,
        entry.discardedReason,
        entry.estimatedTokens,
        entry.evaluationOrder,
        entry.layerOrder,
        entry.priority,
        entry.relevanceScore,
        entry.required ? 1 : 0,
        entry.budgetRemainingBefore,
        entry.budgetRemainingAfter,
      ],
    );
    for (const [sourceIndex, source] of entry.sources.entries()) {
      await transaction.execute(
        `INSERT INTO context_compilation_entry_sources(run_id,candidate_id,source_order,source_type,source_id,source_version_id,locator,content_hash) VALUES(?,?,?,?,?,?,?,?)`,
        [
          trace.id,
          entry.contextCandidateId,
          sourceIndex + 1,
          source.sourceType,
          source.sourceId,
          source.sourceVersionId,
          source.locator,
          source.contentHash,
        ],
      );
    }
  }
  const execution = trace.execution;
  if (execution === null) throw invalid("The evaluation trace has no exact execution binding.");
  await transaction.execute(
    `INSERT INTO context_compilation_execution_links(trace_id,generation_id,generation_run_id,created_at) VALUES(?,?,NULL,?)`,
    [trace.id, execution.generationId, trace.createdAt],
  );
}

async function insertEvaluationInvocation(
  transaction: TransactionExecutor,
  input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
): Promise<void> {
  const result = await transaction.execute(
    `INSERT INTO model_invocation_facts(id,task,route_task,connection_id,catalog_entry_id,provider_kind_snapshot,model_id_snapshot,route_reason,status,attempt,fallback_from_invocation_id,privacy_policy,data_destination,maximum_cost_micros,currency,started_at,created_at,revision) SELECT reservation.planned_model_invocation_id,fixture.task_type,NULL,target.connection_id,target.catalog_entry_id,target.provider_kind_snapshot,target.provider_model_id_snapshot,'user_override','queued',reservation.dispatch_generation,NULL,CASE cost.data_destination WHEN 'local' THEN 'local_only' ELSE 'cloud_allowed' END,cost.data_destination,reservation.reserved_max_cost_micros,reservation.currency,NULL,?,1 FROM novel_skill_evaluation_dispatch_reservations AS reservation INNER JOIN novel_skill_evaluation_cells AS cell ON cell.id = reservation.cell_id INNER JOIN novel_skill_evaluation_fixtures AS fixture ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id INNER JOIN novel_skill_evaluation_run_model_targets AS target ON target.run_id = reservation.run_id AND target.model_slot_id = reservation.model_slot_id INNER JOIN model_provider_connections AS connection ON connection.id = target.connection_id INNER JOIN model_catalog_entries AS catalog ON catalog.id = target.catalog_entry_id INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = catalog.id WHERE reservation.id = ? AND reservation.state = 'reserved' AND connection.enabled = 1 AND connection.connection_status = 'ready' AND connection.credential_state = 'present' AND connection.revision = target.connection_revision AND catalog.connection_id = connection.id AND catalog.availability = 'available' AND catalog.revision = target.catalog_revision AND cost.revision = target.cost_profile_revision AND cost.data_destination = reservation.data_destination`,
    [input.boundAt, input.reservation.reservationId],
  );
  if (result.rowsAffected !== 1) {
    throw conflict("The exact evaluation invocation could not be started atomically.");
  }
}

async function assertExistingBoundDispatch(
  transaction: TransactionExecutor,
  input: ReserveAndBindNovelSkillPaidEvaluationDispatchInput,
): Promise<void> {
  const [row] = await transaction.select<{ readonly valid: number }>(
    `SELECT count(*) AS valid FROM novel_skill_evaluation_dispatch_reservations AS reservation INNER JOIN novel_skill_evaluation_attempts AS attempt ON attempt.id = reservation.attempt_id INNER JOIN context_compilation_runs AS trace ON trace.id = reservation.planned_context_trace_id INNER JOIN context_compilation_execution_links AS execution ON execution.trace_id = trace.id INNER JOIN context_compilation_model_invocation_links AS model_link ON model_link.trace_id = trace.id INNER JOIN model_invocation_facts AS invocation ON invocation.id = reservation.planned_model_invocation_id WHERE reservation.id = ? AND reservation.state = 'bound' AND attempt.context_trace_id = trace.id AND attempt.model_invocation_id = invocation.id AND execution.generation_id = ? AND model_link.model_invocation_id = invocation.id`,
    [input.reservation.reservationId, input.reservation.receipt.generationId],
  );
  if (row?.valid !== 1) {
    throw conflict("The persisted bound evaluation dispatch is incomplete or corrupt.");
  }
}

async function normalizeEvaluationCandidate(
  candidate: AiCandidateSnapshot,
  result: ModelHubExactEvaluationExecutionResult,
  completedAt: string,
): Promise<AiCandidateSnapshot> {
  assertUuidV7(candidate.id, "candidate.id");
  assertUuidV7(candidate.projectId, "candidate.projectId");
  assertIsoUtc(candidate.createdAt, "candidate.createdAt");
  assertIsoUtc(candidate.updatedAt, "candidate.updatedAt");
  const contentHash = await sha256Hex(candidate.content);
  if (
    candidate.chapterId !== null ||
    candidate.baseVersionId !== null ||
    candidate.source !== "generate" ||
    candidate.status !== "ready" ||
    (candidate.revision ?? 1) !== 1 ||
    candidate.incomplete ||
    candidate.decidedAt !== null ||
    candidate.createdAt !== completedAt ||
    candidate.updatedAt !== completedAt ||
    candidate.content.trim().length === 0 ||
    candidate.content !== result.text ||
    candidate.contentChecksum !== result.visibleOutputHash ||
    contentHash !== result.visibleOutputHash ||
    Array.from(candidate.content).length !== result.visibleContentLength
  ) {
    throw invalid("The evaluation Candidate does not match the exact visible provider output.");
  }
  return Object.freeze({ ...candidate, revision: 1 });
}

function requiredActualCost(
  result: ModelHubExactEvaluationExecutionResult,
  rates: Readonly<{
    input_rate: string;
    output_rate: string;
    cached_input_rate: string | null;
  }>,
): string {
  if (
    result.usage === null ||
    result.streamed !== true ||
    result.estimatedActualCostMicros === null
  ) {
    throw invalid("A paid evaluation result requires provider usage and exact cost evidence.");
  }
  const actual = calculateSettledCostMicros(
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.cachedInputTokens ?? 0,
    rates.input_rate,
    rates.output_rate,
    rates.cached_input_rate,
  );
  if (normalizeMicros(result.estimatedActualCostMicros) !== actual) {
    throw invalid("The reported provider cost does not match the locked pricing and usage.");
  }
  return actual;
}

function optionalActualCost(
  input: SettleNovelSkillPaidEvaluationFailureInput,
  rates: Readonly<{
    input_rate: string;
    output_rate: string;
    cached_input_rate: string | null;
  }>,
): string | null {
  if (input.usage === null) {
    if (input.estimatedActualCostMicros !== null) {
      throw invalid("A failed provider response cannot report cost without usage evidence.");
    }
    return null;
  }
  if (input.estimatedActualCostMicros === null) {
    throw invalid("A failed provider response with usage must include its local cost estimate.");
  }
  const actual = calculateSettledCostMicros(
    input.usage.inputTokens,
    input.usage.outputTokens,
    input.usage.cachedInputTokens ?? 0,
    rates.input_rate,
    rates.output_rate,
    rates.cached_input_rate,
  );
  if (normalizeMicros(input.estimatedActualCostMicros) !== actual) {
    throw invalid("The failed provider cost does not match the locked pricing and usage.");
  }
  return actual;
}

function calculateSettledCostMicros(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  inputRate: string,
  outputRate: string,
  cachedInputRate: string | null,
): string {
  assertInteger(inputTokens, 0, 1_000_000_000, "inputTokens");
  assertInteger(outputTokens, 0, 1_000_000_000, "outputTokens");
  assertInteger(cachedInputTokens, 0, inputTokens, "cachedInputTokens");
  const cached = BigInt(cachedInputTokens);
  const uncached = BigInt(inputTokens - cachedInputTokens);
  const numerator =
    uncached * BigInt(normalizeMicros(inputRate)) +
    BigInt(outputTokens) * BigInt(normalizeMicros(outputRate)) +
    cached * BigInt(normalizeMicros(cachedInputRate ?? inputRate));
  return ((numerator + 999_999n) / 1_000_000n).toString();
}

async function hashProviderSettlementReceipt(
  result: ModelHubExactEvaluationExecutionResult,
  completedAt: string,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      version: "novel-skill-paid-evaluation-provider-receipt@1",
      target: result.target,
      requestProfileHash: result.requestProfileHash,
      payloadHash: result.payloadHash,
      executionLockHash: result.executionLockHash,
      visibleOutputHash: result.visibleOutputHash,
      visibleContentLength: result.visibleContentLength,
      usage: result.usage,
      streamed: result.streamed,
      actualCostMicros: result.estimatedActualCostMicros,
      currency: result.currency,
      completedAt,
    }),
  );
}

function assertFailureOutcome(
  outcome: NovelSkillPaidEvaluationFailureOutcome,
  errorCode: NovelSkillPaidEvaluationFailureCode,
): void {
  const valid =
    (outcome === "cancelled" && errorCode === "USER_CANCELLED") ||
    (outcome === "timed_out" && errorCode === "MODEL_TIMEOUT") ||
    (outcome === "policy_blocked" && errorCode === "MODEL_POLICY_BLOCKED") ||
    (outcome === "failed" &&
      !["USER_CANCELLED", "MODEL_TIMEOUT", "MODEL_POLICY_BLOCKED"].includes(errorCode));
  if (!valid) throw invalid("The provider failure outcome and error code do not agree.");
}

function failureInvocationStatus(
  outcome: NovelSkillPaidEvaluationFailureOutcome,
): "failed" | "cancelled" | "timed_out" {
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "timed_out") return "timed_out";
  return "failed";
}

function invocationFailureErrorCode(errorCode: NovelSkillPaidEvaluationFailureCode): string {
  return errorCode;
}

async function hashProviderFailureReceipt(
  input: SettleNovelSkillPaidEvaluationFailureInput &
    Readonly<{
      actualCostMicros: string | null;
      targetHash: string;
      pricingSnapshotHash: string;
      requestProfileHash: string;
      requestPayloadHash: string;
      currency: string;
    }>,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      version: "novel-skill-paid-evaluation-local-failure-receipt@1",
      reservationId: input.reservationId,
      targetHash: input.targetHash,
      pricingSnapshotHash: input.pricingSnapshotHash,
      requestProfileHash: input.requestProfileHash,
      requestPayloadHash: input.requestPayloadHash,
      outcome: input.outcome,
      errorCode: input.errorCode,
      usage: input.usage,
      actualCostMicros: input.actualCostMicros,
      currency: input.currency,
      completedAt: input.completedAt,
    }),
  );
}

async function insertEvaluationCandidate(
  transaction: TransactionExecutor,
  reservationId: string,
  snapshot: AiCandidateSnapshot,
): Promise<void> {
  const result = await transaction.execute(
    `INSERT INTO ai_candidates(id,project_id,chapter_id,source,base_version_id,content,content_checksum,status,incomplete,created_at,updated_at,decided_at,task_intent,application_mode,payload_kind,anchor_start_utf16,anchor_end_utf16) SELECT ?,suite.evaluation_project_id,NULL,?,NULL,?,?,'ready',0,?,?,NULL,'legacy_full_document','replace_document','full_document',NULL,NULL FROM novel_skill_evaluation_dispatch_reservations AS reservation INNER JOIN novel_skill_evaluation_runs AS evaluation_run ON evaluation_run.id = reservation.run_id INNER JOIN novel_skill_evaluation_suites AS suite ON suite.id = evaluation_run.suite_id WHERE reservation.id = ? AND reservation.state = 'dispatched' AND reservation.planned_candidate_id = ? AND suite.evaluation_project_id = ?`,
    [
      snapshot.id,
      snapshot.source,
      snapshot.content,
      snapshot.contentChecksum,
      snapshot.createdAt,
      snapshot.updatedAt,
      reservationId,
      snapshot.id,
      snapshot.projectId,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw conflict("The evaluation Candidate project does not match its dispatched run.");
  }
}

async function quoteCommercialRun(
  executor: TransactionExecutor,
  runId: string,
): Promise<NovelSkillPaidEvaluationQuote> {
  const [protocol] = await executor.select<{ readonly protocol_hash: string }>(
    `SELECT protocol.protocol_hash FROM novel_skill_evaluation_runs AS run INNER JOIN novel_skill_evaluation_protocols AS protocol ON protocol.suite_id = run.suite_id WHERE run.id = ? AND run.status = 'planned'`,
    [runId],
  );
  if (protocol === undefined) throw conflict("The run has no immutable paid evaluation protocol.");
  const targets = await executor.select<TargetQuoteRow>(
    `SELECT model_slot_id,currency,input_micros_per_million_tokens AS input_rate,output_micros_per_million_tokens AS output_rate,target_hash,pricing_snapshot_hash,connection_id,catalog_entry_id,model_identity_hash,model_artifact_hash FROM novel_skill_evaluation_run_model_targets WHERE run_id = ? ORDER BY model_slot_id`,
    [runId],
  );
  if (
    targets.length !== 2 ||
    new Set(targets.map(({ model_artifact_hash }) => model_artifact_hash)).size !== 2
  ) {
    throw conflict("The run does not have two distinct exact model targets.");
  }
  const work = await executor.select<QuoteWorkRow>(
    `SELECT target.model_slot_id,target.currency,target.input_micros_per_million_tokens AS input_rate,target.output_micros_per_million_tokens AS output_rate,target.target_hash,target.pricing_snapshot_hash,target.connection_id,target.catalog_entry_id,target.model_identity_hash,target.model_artifact_hash,fixture.task_type,profile.maximum_input_tokens,profile.maximum_output_tokens,count(*) AS cell_count FROM novel_skill_evaluation_cells AS cell INNER JOIN novel_skill_evaluation_fixtures AS fixture ON fixture.suite_id = cell.suite_id AND fixture.fixture_id = cell.fixture_id INNER JOIN novel_skill_evaluation_request_profiles AS profile ON profile.suite_id = cell.suite_id AND profile.task_type = fixture.task_type INNER JOIN novel_skill_evaluation_run_model_targets AS target ON target.run_id = cell.run_id AND target.model_slot_id = cell.model_slot_id WHERE cell.run_id = ? GROUP BY target.model_slot_id,target.currency,target.input_micros_per_million_tokens,target.output_micros_per_million_tokens,target.target_hash,target.pricing_snapshot_hash,target.connection_id,target.catalog_entry_id,target.model_identity_hash,target.model_artifact_hash,fixture.task_type,profile.maximum_input_tokens,profile.maximum_output_tokens ORDER BY target.model_slot_id,fixture.task_type`,
    [runId],
  );
  const cellCount = work.reduce((total, row) => total + row.cell_count, 0);
  if (cellCount !== NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT) {
    throw conflict("The commercial quote requires the exact 192-cell matrix.");
  }
  const totals = new Map<string, bigint>();
  for (const row of work) {
    const maximumPerCall = calculateMaximumCost(
      row.maximum_input_tokens,
      row.maximum_output_tokens,
      row.input_rate,
      row.output_rate,
    );
    totals.set(
      row.currency,
      (totals.get(row.currency) ?? 0n) + maximumPerCall * BigInt(row.cell_count),
    );
  }
  const currencies = [...totals.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([currency, estimatedMaximumCost]) =>
      Object.freeze({
        currency,
        estimatedMaximumCostMicros: estimatedMaximumCost.toString(),
      }),
    );
  const targetManifestHash = await sha256Hex(canonicalJson(targets.map(targetManifestProjection)));
  const pricingManifestHash = await sha256Hex(
    canonicalJson(targets.map(pricingManifestProjection)),
  );
  const quoteHash = await sha256Hex(
    canonicalJson({
      version: "novel-skill-paid-evaluation-quote@1",
      runId,
      protocolHash: protocol.protocol_hash,
      targetManifestHash,
      pricingManifestHash,
      authorizedCallCount: NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
      currencies,
    }),
  );
  return Object.freeze({
    runId,
    protocolHash: protocol.protocol_hash,
    targetManifestHash,
    pricingManifestHash,
    quoteHash,
    authorizedCallCount: NOVEL_SKILL_PAID_EVALUATION_CALL_COUNT,
    currencies: Object.freeze(currencies),
  });
}

async function readLiveTarget(
  executor: TransactionExecutor,
  target: ModelHubExactEvaluationInspection["target"],
): Promise<ConnectionCatalogCostRow> {
  const [row] = await executor.select<ConnectionCatalogCostRow>(
    `SELECT connection.id AS connection_id,connection.provider_kind,connection.protocol,connection.region,connection.workspace_id,connection.endpoint_id,connection.base_url,connection.credential_ref,connection.credential_state,connection.authentication_mode,connection.credential_header_name,connection.model_discovery_path,connection.text_generation_path,connection.embedding_path,connection.request_timeout_ms,connection.retry_limit,connection.connection_status,connection.enabled AS connection_enabled,connection.revision AS connection_revision,catalog.id AS catalog_id,catalog.connection_id AS catalog_connection_id,catalog.provider_model_id,catalog.catalog_source,catalog.availability,catalog.lifecycle,catalog.input_token_limit,catalog.output_token_limit,catalog.stale_after,catalog.revision AS catalog_revision,cost.currency,cost.input_micros_per_million_tokens AS input_rate,cost.output_micros_per_million_tokens AS output_rate,cost.cached_input_micros_per_million_tokens AS cached_input_rate,cost.pricing_version,cost.price_updated_at,cost.data_destination,cost.retention_policy,cost.training_policy,cost.evidence_source,cost.evidence_version,cost.evidence_summary,cost.evidence_updated_at,cost.revision AS cost_revision,cost.created_at AS cost_created_at,cost.updated_at AS cost_updated_at FROM model_provider_connections AS connection INNER JOIN model_catalog_entries AS catalog ON catalog.connection_id = connection.id INNER JOIN model_cost_privacy_profiles AS cost ON cost.catalog_entry_id = catalog.id WHERE connection.id = ? AND catalog.id = ?`,
    [target.connectionId, target.catalogEntryId],
  );
  if (row === undefined) {
    throw conflict("The exact target no longer matches a ready, priced catalog connection.");
  }
  if (
    row.connection_enabled !== 1 ||
    row.connection_status !== "ready" ||
    row.credential_state !== "present" ||
    row.catalog_connection_id !== row.connection_id ||
    row.availability !== "available" ||
    row.provider_kind !== target.providerKind ||
    row.provider_model_id !== target.modelId ||
    row.connection_revision !== target.connectionRevision ||
    row.catalog_revision !== target.catalogRevision ||
    row.cost_revision !== target.costPrivacyRevision ||
    row.currency === null ||
    row.input_rate === null ||
    row.output_rate === null ||
    row.pricing_version === null ||
    row.price_updated_at === null
  ) {
    throw conflict("The exact target no longer matches a ready, priced catalog connection.");
  }
  return row;
}

async function cancelPreDispatchAttempt(
  executor: TransactionExecutor,
  attemptId: string,
  completedAt: string,
): Promise<void> {
  const result = await executor.execute(
    `UPDATE novel_skill_evaluation_attempts SET status = 'cancelled',error_code = 'PRE_DISPATCH_CANCELLED',completed_at = ? WHERE id = ? AND status = 'started'`,
    [completedAt, attemptId],
  );
  if (result.rowsAffected !== 1) {
    throw conflict("The predispatch attempt could not be terminated atomically.");
  }
}

async function cancelDispatchedAttempt(
  executor: TransactionExecutor,
  attemptId: string,
  completedAt: string,
): Promise<void> {
  const result = await executor.execute(
    `UPDATE novel_skill_evaluation_attempts SET status = 'cancelled',error_code = 'DISPATCH_INTERRUPTED',completed_at = ? WHERE id = ? AND status = 'started'`,
    [completedAt, attemptId],
  );
  if (result.rowsAffected !== 1) {
    throw conflict("The interrupted dispatch attempt could not be terminated atomically.");
  }
}

async function cancelPreDispatchInvocation(
  executor: TransactionExecutor,
  invocationId: string,
  completedAt: string,
): Promise<void> {
  const result = await executor.execute(
    `UPDATE model_invocation_facts SET status = 'cancelled',started_at = ?,completed_at = ?,revision = revision+1 WHERE id = ? AND status = 'queued'`,
    [completedAt, completedAt, invocationId],
  );
  if (result.rowsAffected !== 1) {
    throw conflict("The queued model invocation could not be cancelled atomically.");
  }
}

async function interruptDispatchedInvocation(
  executor: TransactionExecutor,
  invocationId: string,
  completedAt: string,
): Promise<void> {
  const result = await executor.execute(
    `UPDATE model_invocation_facts SET status = 'failed',error_code = 'DISPATCH_INTERRUPTED',error_summary = NULL,completed_at = ?,revision = revision+1 WHERE id = ? AND status = 'running' AND revision = 2`,
    [completedAt, invocationId],
  );
  if (result.rowsAffected !== 1) {
    throw conflict("The dispatched model invocation could not be interrupted atomically.");
  }
}

function connectionProjection(row: ConnectionCatalogCostRow) {
  return {
    id: row.connection_id,
    providerKind: row.provider_kind,
    protocol: row.protocol,
    region: row.region,
    workspaceId: row.workspace_id,
    endpointId: row.endpoint_id,
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    credentialState: row.credential_state,
    authenticationMode: row.authentication_mode,
    credentialHeaderName: row.credential_header_name,
    modelDiscoveryPath: row.model_discovery_path,
    textGenerationPath: row.text_generation_path,
    embeddingPath: row.embedding_path,
    requestTimeoutMs: row.request_timeout_ms,
    retryLimit: row.retry_limit,
    revision: row.connection_revision,
  };
}

function catalogProjection(row: ConnectionCatalogCostRow) {
  return {
    id: row.catalog_id,
    connectionId: row.catalog_connection_id,
    providerModelId: row.provider_model_id,
    catalogSource: row.catalog_source,
    availability: row.availability,
    lifecycle: row.lifecycle,
    inputTokenLimit: row.input_token_limit,
    outputTokenLimit: row.output_token_limit,
    staleAfter: row.stale_after,
    revision: row.catalog_revision,
  };
}

function costProjection(row: ConnectionCatalogCostRow) {
  return {
    catalogEntryId: row.catalog_id,
    currency: row.currency,
    inputMicrosPerMillionTokens: row.input_rate,
    outputMicrosPerMillionTokens: row.output_rate,
    cachedInputMicrosPerMillionTokens: row.cached_input_rate,
    pricingVersion: row.pricing_version,
    priceUpdatedAt: row.price_updated_at,
    dataDestination: row.data_destination,
    retentionPolicy: row.retention_policy,
    trainingPolicy: row.training_policy,
    evidenceSource: row.evidence_source,
    evidenceVersion: row.evidence_version,
    evidenceSummary: row.evidence_summary,
    evidenceUpdatedAt: row.evidence_updated_at,
    revision: row.cost_revision,
    createdAt: row.cost_created_at,
    updatedAt: row.cost_updated_at,
  };
}

function liveCredentialProviderId(row: ConnectionCatalogCostRow): string {
  if (row.authentication_mode === "none") {
    if (/^[A-Za-z0-9._-]{1,128}$/u.test(row.connection_id)) return row.connection_id;
    throw conflict("The exact target credential provider identifier is invalid.");
  }
  for (const prefix of ["keyring:model-hub:", "keyring:legacy-model-profile:"]) {
    if (row.credential_ref?.startsWith(prefix) === true) {
      const providerId = row.credential_ref.slice(prefix.length);
      if (/^[A-Za-z0-9._-]{1,128}$/u.test(providerId)) return providerId;
    }
  }
  throw conflict("The exact target credential authority is unavailable.");
}

function liveFinalDispatchIdentity(row: ConnectionCatalogCostRow): string {
  const custom = row.provider_kind === "custom_openai_compatible";
  const nativeProvider = row.protocol === "openai_compatible" ? "open_ai_compatible" : row.protocol;
  return JSON.stringify([
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    row.connection_id,
    row.connection_revision,
    row.connection_enabled === 1,
    row.provider_kind,
    row.protocol,
    row.base_url,
    row.credential_ref,
    row.credential_state,
    row.catalog_id,
    row.catalog_revision,
    row.catalog_connection_id,
    row.provider_model_id,
    row.availability,
    row.lifecycle,
    row.stale_after,
    row.cost_revision,
    liveCredentialProviderId(row),
    nativeProvider,
    row.base_url,
    row.authentication_mode,
    custom ? row.credential_header_name : null,
    custom ? row.model_discovery_path : null,
    custom ? row.text_generation_path : null,
    custom ? row.embedding_path : null,
    row.request_timeout_ms,
    row.retry_limit,
  ]);
}

async function hashLiveExactTarget(
  row: ConnectionCatalogCostRow,
  capabilityEvidenceHash: string,
  costProfileHash: string,
): Promise<string> {
  assertHash(capabilityEvidenceHash, "capabilityEvidenceHash");
  assertHash(costProfileHash, "costProfileHash");
  return sha256Hex(
    canonicalJson({
      version: "model-hub-exact-evaluation-target@1",
      finalDispatchIdentity: liveFinalDispatchIdentity(row),
      capabilityEvidenceHash,
      costProfileHash,
    }),
  );
}

function targetManifestProjection(row: TargetQuoteRow) {
  return {
    modelSlotId: row.model_slot_id,
    connectionId: row.connection_id,
    catalogEntryId: row.catalog_entry_id,
    modelIdentityHash: row.model_identity_hash,
    modelArtifactHash: row.model_artifact_hash,
    targetHash: row.target_hash,
  };
}

function pricingManifestProjection(row: TargetQuoteRow) {
  return {
    modelSlotId: row.model_slot_id,
    currency: row.currency,
    inputRate: row.input_rate,
    outputRate: row.output_rate,
    pricingSnapshotHash: row.pricing_snapshot_hash,
  };
}

function normalizeRequestProfiles(
  input: readonly NovelSkillPaidEvaluationRequestProfileInput[],
): readonly NovelSkillPaidEvaluationRequestProfileInput[] {
  if (input.length < 1 || input.length > 22) throw invalid("Request profile count is invalid.");
  const result = input.map((profile) => {
    assertPortableLocator(profile.taskType, "taskType", 128);
    if (
      !(MODEL_HUB_TEXT_TASKS as readonly string[]).includes(profile.taskType) ||
      profile.profileVersion !== MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION
    ) {
      throw invalid("The paid request profile task or version is unsupported.");
    }
    assertHash(profile.requestProfileHash, "requestProfileHash");
    if (profile.stopPolicyHash !== MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH) {
      throw invalid("Paid evaluation request profiles must use the fixed empty stop policy.");
    }
    assertInteger(profile.maximumInputTokens, 1, 1_000_000_000, "maximumInputTokens");
    assertInteger(profile.maximumOutputTokens, 1, 1_000_000_000, "maximumOutputTokens");
    assertInteger(profile.temperatureBasisPoints, 0, 20_000, "temperatureBasisPoints");
    assertInteger(profile.topPBasisPoints, 0, 10_000, "topPBasisPoints");
    const runtimeStreaming = (profile as unknown as { readonly streaming?: unknown }).streaming;
    if (runtimeStreaming !== true) {
      throw invalid("Paid evaluation request profiles must use the native streaming contract.");
    }
    return Object.freeze({ ...profile });
  });
  if (new Set(result.map(({ taskType }) => taskType)).size !== result.length) {
    throw invalid("Request profile task types must be unique.");
  }
  return Object.freeze(result.sort((left, right) => compareText(left.taskType, right.taskType)));
}

function exactRequestProfile(
  profile: NovelSkillPaidEvaluationRequestProfileInput,
): ModelHubExactEvaluationRequestProfile {
  return Object.freeze({
    version: MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
    task: profile.taskType as ModelHubTextTask,
    maximumInputTokens: profile.maximumInputTokens,
    maximumOutputTokens: profile.maximumOutputTokens,
    temperatureBasisPoints: profile.temperatureBasisPoints,
    topPBasisPoints: profile.topPBasisPoints,
    reasoningMode: "disabled",
    responseFormat: "text",
    streaming: true,
    stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
    providerCallPolicy: "single_attempt",
  });
}

function normalizeContextBaselines(
  input: readonly NovelSkillPaidEvaluationContextBaselineInput[],
): readonly NovelSkillPaidEvaluationContextBaselineInput[] {
  if (input.length !== 12) throw invalid("The fixed suite requires 12 context baselines.");
  const result = input.map((baseline) => {
    assertPortableLocator(baseline.fixtureId, "fixtureId", 128);
    for (const hash of [
      baseline.baselineContractHash,
      baseline.includedSourceManifestHash,
      baseline.omittedSourceManifestHash,
      baseline.compiledBaselineHash,
    ]) {
      assertHash(hash, "baseline hash");
    }
    assertInteger(baseline.baselineTokenBudget, 1, 1_000_000_000, "baselineTokenBudget");
    return Object.freeze({ ...baseline });
  });
  if (new Set(result.map(({ fixtureId }) => fixtureId)).size !== result.length) {
    throw invalid("Context baseline fixture identifiers must be unique.");
  }
  return Object.freeze(result.sort((left, right) => compareText(left.fixtureId, right.fixtureId)));
}

function parseAssignments(value: string): readonly Readonly<{
  slotId: string;
  modelIdentityHash: string;
  modelArtifactHash: string;
}>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause: unknown) {
    throw invalid("The run model assignment snapshot is corrupt.", cause);
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw invalid("The run must contain exactly two model assignments.");
  }
  return parsed.map((item: unknown) => {
    if (
      !isRecord(item) ||
      !["text_tier_a", "text_tier_b"].includes(String(item.slotId)) ||
      !isHash(item.modelIdentityHash) ||
      !isHash(item.modelArtifactHash)
    ) {
      throw invalid("The run model assignment snapshot is invalid.");
    }
    return {
      slotId: String(item.slotId),
      modelIdentityHash: item.modelIdentityHash,
      modelArtifactHash: item.modelArtifactHash,
    };
  });
}

function assertReservationInput(input: ReserveNovelSkillPaidEvaluationDispatchInput): void {
  for (const [value, label] of [
    [input.reservationId, "reservationId"],
    [input.authorizationId, "authorizationId"],
    [input.runId, "runId"],
    [input.cellId, "cellId"],
    [input.attemptId, "attemptId"],
    [input.plannedContextTraceId, "plannedContextTraceId"],
    [input.plannedCandidateId, "plannedCandidateId"],
  ] as const) {
    assertUuidV7(value, label);
  }
  assertPortableLocator(input.plannedModelInvocationId, "plannedModelInvocationId", 128);
  assertInteger(input.dispatchGeneration, 1, 8, "dispatchGeneration");
  for (const hash of [
    input.contextBaselineHash,
    input.promptTemplateHash,
    input.invariantRequestHash,
    input.idempotencyKeyHash,
    input.receipt.target.capabilityEvidenceHash,
    input.receipt.target.targetIdentityHash,
    input.receipt.target.costProfileHash,
    input.receipt.requestProfileHash,
    input.receipt.messagePayloadHash,
    input.receipt.payloadHash,
    input.receipt.executionLockHash,
  ]) {
    assertHash(hash, "reservation hash");
  }
  for (const [value, label, maximumLength] of [
    [input.receipt.target.connectionId, "target connectionId", 128],
    [input.receipt.target.catalogEntryId, "target catalogEntryId", 128],
    [input.receipt.target.providerKind, "target providerKind", 128],
    [input.receipt.target.modelId, "target modelId", 512],
  ] as const) {
    assertPortableLocator(value, label, maximumLength);
  }
  assertInteger(input.receipt.target.connectionRevision, 1, 2_147_483_647, "connectionRevision");
  assertInteger(input.receipt.target.catalogRevision, 1, 2_147_483_647, "catalogRevision");
  assertInteger(input.receipt.target.costPrivacyRevision, 1, 2_147_483_647, "costPrivacyRevision");
  if (input.skillConfigurationHash !== null) assertHash(input.skillConfigurationHash, "skill hash");
  if (input.preferenceConfigurationHash !== null) {
    assertHash(input.preferenceConfigurationHash, "preference hash");
  }
  assertIsoUtc(input.reservedAt, "reservedAt");
  normalizeCurrency(input.receipt.currency);
  normalizeMicros(input.receipt.estimatedMaximumCostMicros);
  if (!(["local", "remote"] as readonly unknown[]).includes(input.receipt.dataDestination)) {
    throw invalid("The exact evaluation data destination is invalid.");
  }
  if (input.receipt.generationId !== input.plannedModelInvocationId) {
    throw invalid("The gateway generation id must equal the predeclared model invocation id.");
  }
}

async function readReservationByAttempt(
  executor: TransactionExecutor,
  attemptId: string,
): Promise<NovelSkillPaidEvaluationReservationRecord | null> {
  const rows = await executor.select<ReservationRow>(`${RESERVATION_SELECT} WHERE attempt_id = ?`, [
    attemptId,
  ]);
  return rows[0] === undefined ? null : mapReservation(rows[0]);
}

async function readRequiredReservation(
  executor: TransactionExecutor,
  reservationId: string,
): Promise<NovelSkillPaidEvaluationReservationRecord> {
  const rows = await executor.select<ReservationRow>(`${RESERVATION_SELECT} WHERE id = ?`, [
    reservationId,
  ]);
  if (rows[0] === undefined) throw conflict("The dispatch reservation does not exist.");
  return mapReservation(rows[0]);
}

function mapReservation(row: ReservationRow): NovelSkillPaidEvaluationReservationRecord {
  return Object.freeze({
    id: row.id,
    runId: row.run_id,
    cellId: row.cell_id,
    attemptId: row.attempt_id,
    state: row.state,
    plannedContextTraceId: row.planned_context_trace_id,
    plannedModelInvocationId: row.planned_model_invocation_id,
    plannedCandidateId: row.planned_candidate_id,
    revision: row.revision,
  });
}

async function invalidateRun(
  transaction: TransactionExecutor,
  runId: string,
  invalidatedAt: string,
): Promise<void> {
  const activeReservations = await transaction.select<ReservationRow>(
    `${RESERVATION_SELECT} WHERE run_id = ? AND state IN ('reserved','bound','dispatched')`,
    [runId],
  );
  for (const reservation of activeReservations) {
    if (reservation.state === "dispatched") {
      await interruptDispatchedInvocation(
        transaction,
        reservation.planned_model_invocation_id,
        invalidatedAt,
      );
      await cancelDispatchedAttempt(transaction, reservation.attempt_id, invalidatedAt);
      const changed = await transaction.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'ambiguous',terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state = 'dispatched'`,
        [invalidatedAt, reservation.id, reservation.revision],
      );
      if (changed.rowsAffected !== 1) {
        throw conflict("An in-flight dispatch changed while the run was being invalidated.");
      }
      continue;
    }
    if (reservation.state === "bound") {
      await cancelPreDispatchInvocation(
        transaction,
        reservation.planned_model_invocation_id,
        invalidatedAt,
      );
    }
    await cancelPreDispatchAttempt(transaction, reservation.attempt_id, invalidatedAt);
    const changed = await transaction.execute(
      `UPDATE novel_skill_evaluation_dispatch_reservations SET state = 'not_dispatched',terminal_at = ?,revision = revision+1 WHERE id = ? AND revision = ? AND state IN ('reserved','bound')`,
      [invalidatedAt, reservation.id, reservation.revision],
    );
    if (changed.rowsAffected !== 1) {
      throw conflict("A predispatch reservation changed while the run was being invalidated.");
    }
  }
  await transaction.execute(
    `UPDATE novel_skill_evaluation_attempts SET status = 'cancelled',error_code = 'DISPATCH_INTERRUPTED',completed_at = ? WHERE run_id = ? AND status = 'started'`,
    [invalidatedAt, runId],
  );
  const result = await transaction.execute(
    `UPDATE novel_skill_evaluation_runs SET status = 'invalidated',evaluation_status = 'EVIDENCE_INCOMPLETE',completed_at = ?,revision = revision+1 WHERE id = ? AND status = 'running'`,
    [invalidatedAt, runId],
  );
  if (result.rowsAffected !== 1) throw conflict("The interrupted run is already terminal.");
  await transaction.execute(
    `UPDATE novel_skill_evaluation_cells SET state = 'invalidated' WHERE run_id = ? AND state = 'planned'`,
    [runId],
  );
}

function calculateMaximumCost(
  inputTokens: number,
  outputTokens: number,
  inputRate: string,
  outputRate: string,
): bigint {
  const numerator =
    BigInt(inputTokens) * BigInt(inputRate) + BigInt(outputTokens) * BigInt(outputRate);
  return (numerator + 999_999n) / 1_000_000n;
}

function normalizeCurrency(value: string): string {
  if (!/^[A-Z]{3}$/u.test(value)) throw invalid("Currency must be a three-letter code.");
  return value;
}

function normalizeMicros(value: string): string {
  if (!/^(0|[1-9][0-9]{0,17})$/u.test(value)) {
    throw invalid("Cost micros must be a canonical bounded decimal integer.");
  }
  return value;
}

function requiredString(value: string | null, label: string): string {
  if (value === null) throw invalid(`The exact target has no ${label}.`);
  return value;
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (!isHash(value)) throw invalid(`${label} must be a lower-case SHA-256 hash.`);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function assertVersion(value: string): void {
  if (!/^[A-Za-z0-9._:@/-]{3,96}$/u.test(value)) throw invalid("Protocol version is invalid.");
}

function assertUuidV7(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw invalid(`${label} must be a UUIDv7.`);
  }
}

function assertPortableLocator(value: string, label: string, maximumLength: number): void {
  if (
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    /[\u0000\t\r\n ]/u.test(value)
  ) {
    throw invalid(`${label} is invalid.`);
  }
}

function assertContentFreeAuditLocator(value: string, label: string, maximumLength: number): void {
  assertPortableLocator(value, label, maximumLength);
  if (!/^[A-Za-z0-9_.:@/-]+$/u.test(value)) {
    throw invalid(`${label} must be a content-free audit code.`);
  }
}

function assertIsoUtc(value: string, label: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw invalid(`${label} must be a canonical UTC timestamp.`);
  }
}

function assertRevision(value: number): void {
  assertInteger(value, 1, 2_147_483_647, "revision");
}

function assertInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${label} is outside its safe range.`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalid(message: string, cause?: unknown): NovelSkillEvaluationStoreError {
  return new NovelSkillEvaluationStoreError(
    "NOVEL_SKILL_EVALUATION_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function conflict(message: string): NovelSkillEvaluationStoreError {
  return new NovelSkillEvaluationStoreError("NOVEL_SKILL_EVALUATION_CONFLICT", message);
}

const RESERVATION_SELECT = `SELECT id,run_id,cell_id,attempt_id,state,planned_context_trace_id,planned_model_invocation_id,planned_candidate_id,revision FROM novel_skill_evaluation_dispatch_reservations`;

const PREDISPATCH_AUTHORITY_COLUMNS = [
  "reservation_id",
  "schema_version",
  "authority_snapshot_version",
  "payload_authority_schema_version",
  "payload_authority_version",
  "payload_authority_manifest_hash",
  "run_id",
  "suite_id",
  "cell_id",
  "fixture_id",
  "fixture_contract_hash",
  "fixture_input_content_hash",
  "task_type",
  "invocation_mode",
  "genre_tags_hash",
  "coverage_dimensions_hash",
  "arm",
  "arm_configuration_hash",
  "model_slot_id",
  "repetition",
  "prompt_template_version",
  "prompt_template_hash",
  "context_baseline_hash",
  "context_baseline_projection_hash",
  "available_context_layers_hash",
  "skill_compiler_version",
  "skill_selection_hash",
  "compiled_skill_snapshot_hash",
  "rendered_skill_section_hash",
  "preference_configuration_hash",
  "preference_projection_hash",
  "rendered_preference_section_hash",
  "base_message_payload_hash",
  "message_payload_hash",
  "generation_id",
  "connection_id",
  "catalog_entry_id",
  "provider_kind",
  "provider_model_id",
  "connection_revision",
  "catalog_revision",
  "cost_privacy_revision",
  "capability_evidence_hash",
  "cost_profile_hash",
  "target_identity_hash",
  "request_profile_hash",
  "request_payload_hash",
  "execution_lock_hash",
  "currency",
  "exact_predispatch_estimated_max_cost_micros",
  "data_destination",
  "provider_receipt_shape_version",
  "provider_receipt_shape_hash",
  "final_dispatch_authority_version",
  "final_dispatch_authority_hash",
  "authority_snapshot_hash",
  "captured_at",
] as const;

const PREDISPATCH_AUTHORITY_SELECT = `SELECT snapshot.*,reservation.authorization_id,reservation.attempt_id,reservation.dispatch_generation,reservation.planned_context_trace_id,reservation.planned_model_invocation_id,reservation.planned_candidate_id,reservation.idempotency_key_hash,reservation.run_id AS reservation_run_id,reservation.cell_id AS reservation_cell_id,reservation.model_slot_id AS reservation_model_slot_id,reservation.target_hash AS reservation_target_hash,reservation.pricing_snapshot_hash AS reservation_pricing_snapshot_hash,reservation.request_profile_hash AS reservation_request_profile_hash,reservation.message_payload_hash AS reservation_message_payload_hash,reservation.request_payload_hash AS reservation_request_payload_hash,reservation.execution_lock_hash AS reservation_execution_lock_hash,reservation.payload_authority_manifest_hash AS reservation_payload_authority_manifest_hash,reservation.currency AS reservation_currency,reservation.data_destination AS reservation_data_destination,reservation.reserved_max_cost_micros AS reservation_reserved_max_cost_micros,reservation.reserved_at AS reservation_reserved_at FROM novel_skill_evaluation_predispatch_authority_snapshots AS snapshot INNER JOIN novel_skill_evaluation_dispatch_reservations AS reservation ON reservation.id = snapshot.reservation_id`;
