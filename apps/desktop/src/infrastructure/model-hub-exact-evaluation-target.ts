import type { Clock } from "@inkshadow/domain";

import {
  getModelProviderPreset,
  type ModelHubCapability,
  type ModelProviderKind,
} from "./model-hub-provider-registry";
import {
  modelHubCredentialProviderId,
  modelHubNativeEndpointConfig,
} from "./model-hub-native-config";
import { modelHubFinalDispatchIdentity } from "./model-hub-final-dispatch-guard";
import {
  requiredCapabilitiesForNovelTask,
  resolveModelCapabilityVerdict,
} from "./model-hub-router";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelHubStore,
  ModelProviderConnection,
} from "./model-hub-store";
import { MODEL_HUB_TEXT_TASKS, type ModelHubTextTask } from "./model-hub-execution-service";
import type {
  NativeModelGatewayClient,
  NativeModelGenerationResult,
  NativeModelMessage,
} from "./runtime";

export const MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION =
  "model-hub-exact-evaluation-request@1" as const;
export const MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH =
  "896247754b670bf5c4ac89424e7c5f2fffa598df9adcdc1377d8fcf0868831a6" as const;

export interface ModelHubExactEvaluationTargetSelector {
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderKind;
  readonly modelId: string;
}

/**
 * Provider-facing request parameters are represented without `undefined` so
 * omission is part of the immutable profile instead of an incidental object
 * shape. Evaluation always permits exactly one provider attempt.
 */
export interface ModelHubExactEvaluationRequestProfile {
  readonly version: typeof MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION;
  readonly task: ModelHubTextTask;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly temperatureBasisPoints: number;
  readonly topPBasisPoints: number;
  readonly reasoningMode: "disabled";
  readonly responseFormat: "text";
  readonly streaming: true;
  readonly stopPolicyHash: typeof MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH;
  readonly providerCallPolicy: "single_attempt";
}

export interface ModelHubExactEvaluationTargetLock extends ModelHubExactEvaluationTargetSelector {
  readonly connectionRevision: number;
  readonly catalogRevision: number;
  readonly costPrivacyRevision: number;
  readonly capabilityEvidenceHash: string;
  readonly costProfileHash: string;
  readonly targetIdentityHash: string;
}

export interface ModelHubExactEvaluationInspection {
  readonly target: ModelHubExactEvaluationTargetLock;
  readonly requestProfile: ModelHubExactEvaluationRequestProfile;
  readonly requestProfileHash: string;
  /** Hash of the canonical message list only, independent of target and pricing. */
  readonly messagePayloadHash: string;
  /** Hash of the exact messages plus target and request profile; messages are not retained. */
  readonly payloadHash: string;
  readonly executionLockHash: string;
  readonly requiredCapabilities: readonly ModelHubCapability[];
  readonly dataDestination: "local" | "remote";
  readonly estimatedInputTokens: number;
  readonly estimatedTotalTokens: number;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly pricing: Readonly<{
    readonly currency: string;
    readonly estimatedMaximumCostMicros: string;
    readonly pricingVersion: string;
    readonly priceUpdatedAt: string;
    readonly evidenceSource: ModelCostPrivacyProfile["evidenceSource"];
    readonly evidenceVersion: string | null;
    readonly evidenceUpdatedAt: string;
  }>;
}

export interface InspectModelHubExactEvaluationTargetInput {
  readonly target: ModelHubExactEvaluationTargetSelector;
  readonly requestProfile: ModelHubExactEvaluationRequestProfile;
  readonly messages: readonly NativeModelMessage[];
}

/** Content-free receipt intended for the future 0063 reservation UoW. */
export interface ModelHubExactEvaluationPredispatchReceipt {
  readonly generationId: string;
  readonly target: ModelHubExactEvaluationTargetLock;
  readonly requestProfileHash: string;
  readonly messagePayloadHash: string;
  readonly payloadHash: string;
  readonly executionLockHash: string;
  readonly currency: string;
  readonly estimatedMaximumCostMicros: string;
  readonly dataDestination: "local" | "remote";
}

export interface ModelHubExactEvaluationExecutionLockInput {
  readonly targetIdentityHash: string;
  readonly requestProfileHash: string;
  readonly payloadHash: string;
  readonly currency: string;
  readonly estimatedMaximumCostMicros: string;
}

export interface ExecuteModelHubExactEvaluationTargetInput {
  readonly generationId: string;
  readonly inspection: ModelHubExactEvaluationInspection;
  readonly messages: readonly NativeModelMessage[];
  /** Atomically creates the 0063 reservation and binds its trace/invocation receipt. */
  readonly reserveAndBindBeforeDispatch: (
    receipt: ModelHubExactEvaluationPredispatchReceipt,
  ) => void | Promise<void>;
  /**
   * Commits the reservation's `dispatched` boundary after the final target
   * check and before any provider request can start.
   */
  readonly markDispatchStarted: (
    receipt: ModelHubExactEvaluationPredispatchReceipt,
  ) => void | Promise<void>;
  /** Final synchronous cancellation/authorization latch immediately before the gateway call. */
  readonly assertBeforeProviderDispatch: () => void;
  readonly onDelta?: (accumulatedText: string) => void;
}

export interface ModelHubExactEvaluationExecutionResult {
  readonly text: string;
  readonly usage: NativeModelGenerationResult["usage"];
  readonly streamed: boolean | null;
  readonly visibleOutputHash: string;
  /** Unicode code-point length, matching the invocation and SQLite evidence contract. */
  readonly visibleContentLength: number;
  readonly estimatedActualCostMicros: string | null;
  readonly currency: string;
  readonly dataDestination: "local" | "remote";
  readonly target: ModelHubExactEvaluationTargetLock;
  readonly requestProfileHash: string;
  readonly messagePayloadHash: string;
  readonly payloadHash: string;
  readonly executionLockHash: string;
}

export interface ModelHubExactEvaluationDependencies {
  readonly modelHub: Pick<
    ModelHubStore,
    "findConnection" | "listCatalog" | "listCapabilityEvidence" | "findCostPrivacyProfile"
  >;
  readonly modelGateway: Pick<NativeModelGatewayClient, "available" | "generate">;
  readonly credentials: Readonly<{
    getSummary(providerId: string): Promise<Readonly<{ configured: boolean }>>;
  }>;
  readonly clock: Clock;
}

export type ModelHubExactEvaluationErrorCode =
  | "MODEL_HUB_EXACT_EVALUATION_GATEWAY_UNAVAILABLE"
  | "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID"
  | "MODEL_HUB_EXACT_EVALUATION_TARGET_MISMATCH"
  | "MODEL_HUB_EXACT_EVALUATION_CONNECTION_NOT_READY"
  | "MODEL_HUB_EXACT_EVALUATION_CATALOG_UNAVAILABLE"
  | "MODEL_HUB_EXACT_EVALUATION_CREDENTIAL_MISSING"
  | "MODEL_HUB_EXACT_EVALUATION_CAPABILITY_UNVERIFIED"
  | "MODEL_HUB_EXACT_EVALUATION_CONTEXT_LIMIT_UNKNOWN"
  | "MODEL_HUB_EXACT_EVALUATION_CONTEXT_LIMIT_EXCEEDED"
  | "MODEL_HUB_EXACT_EVALUATION_COST_UNVERIFIED"
  | "MODEL_HUB_EXACT_EVALUATION_CONFIGURATION_CHANGED"
  | "MODEL_HUB_EXACT_EVALUATION_RESERVATION_FAILED"
  | "MODEL_HUB_EXACT_EVALUATION_CANCELLED_BEFORE_DISPATCH"
  | "MODEL_HUB_EXACT_EVALUATION_DISPATCH_MARK_FAILED"
  | "MODEL_HUB_EXACT_EVALUATION_CANCELLED_AFTER_DISPATCH_MARK"
  | "MODEL_HUB_EXACT_EVALUATION_OUTPUT_EMPTY"
  | "MODEL_HUB_EXACT_EVALUATION_OUTPUT_INVALID"
  | "MODEL_HUB_EXACT_EVALUATION_PROVIDER_FAILED";

export class ModelHubExactEvaluationError extends Error {
  public constructor(
    readonly code: ModelHubExactEvaluationErrorCode,
    message: string,
    readonly dispatched = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelHubExactEvaluationError";
  }
}

interface ResolvedExactEvaluationTarget {
  readonly inspection: ModelHubExactEvaluationInspection;
  readonly connection: ModelProviderConnection;
  readonly catalogEntry: ModelCatalogEntry;
  readonly costPrivacy: ModelCostPrivacyProfile;
}

type VerifiedCostField =
  | "currency"
  | "inputMicrosPerMillionTokens"
  | "outputMicrosPerMillionTokens"
  | "pricingVersion"
  | "priceUpdatedAt";

type VerifiedModelCostPrivacyProfile = Omit<ModelCostPrivacyProfile, VerifiedCostField> & {
  readonly [Key in VerifiedCostField]: NonNullable<ModelCostPrivacyProfile[Key]>;
};

const MAXIMUM_TEXT_MESSAGES = 256;
const MAXIMUM_MESSAGE_CHARACTERS = 2_000_000;
const MAXIMUM_TOTAL_MESSAGE_CHARACTERS = 4_000_000;
const MAXIMUM_OUTPUT_TOKENS = 1_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RATE_PATTERN = /^(0|[1-9][0-9]{0,29})$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

/**
 * Resolves one explicit connection/catalog pair. It never reads or mutates a
 * task route, and therefore cannot select a fallback model.
 */
export async function inspectModelHubExactEvaluationTarget(
  dependencies: ModelHubExactEvaluationDependencies,
  input: InspectModelHubExactEvaluationTargetInput,
): Promise<ModelHubExactEvaluationInspection> {
  return (await resolveExactEvaluationTarget(dependencies, input)).inspection;
}

export async function hashModelHubExactEvaluationRequestProfile(
  profile: ModelHubExactEvaluationRequestProfile,
): Promise<string> {
  validateRequestProfile(profile);
  return sha256Hex(canonicalJson(profile));
}

export async function hashModelHubExactEvaluationExecutionLock(
  input: ModelHubExactEvaluationExecutionLockInput,
): Promise<string> {
  if (
    !SHA256_PATTERN.test(input.targetIdentityHash) ||
    !SHA256_PATTERN.test(input.requestProfileHash) ||
    !SHA256_PATTERN.test(input.payloadHash) ||
    !CURRENCY_PATTERN.test(input.currency) ||
    !RATE_PATTERN.test(input.estimatedMaximumCostMicros)
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
      "The exact evaluation execution lock input is invalid.",
    );
  }
  return sha256Hex(
    canonicalJson({
      version: "model-hub-exact-evaluation-execution-lock@1",
      targetIdentityHash: input.targetIdentityHash,
      requestProfileHash: input.requestProfileHash,
      payloadHash: input.payloadHash,
      currency: input.currency,
      estimatedMaximumCostMicros: input.estimatedMaximumCostMicros,
    }),
  );
}

/**
 * Executes the already-inspected target exactly once. No invocation, Candidate
 * or evaluation row is persisted here; the content-free predispatch callback
 * and returned hashes are the boundaries for the future 0063 SQLite UoWs.
 */
export async function executeModelHubExactEvaluationTarget(
  dependencies: ModelHubExactEvaluationDependencies,
  input: ExecuteModelHubExactEvaluationTargetInput,
): Promise<ModelHubExactEvaluationExecutionResult> {
  assertPortableLocator(input.generationId, "generation id", 128);
  const expected = snapshotInspection(validateInspection(input.inspection));
  // The caller may own a mutable array despite the readonly API surface. Take
  // one immutable value snapshot before any awaited persistence callback so a
  // callback or UI update cannot change the provider payload after its hash
  // has been reserved.
  const lockedMessages = Object.freeze(
    input.messages.map(({ role, content }) => Object.freeze({ role, content })),
  );
  const request: InspectModelHubExactEvaluationTargetInput = {
    target: {
      connectionId: expected.target.connectionId,
      catalogEntryId: expected.target.catalogEntryId,
      providerKind: expected.target.providerKind,
      modelId: expected.target.modelId,
    },
    requestProfile: expected.requestProfile,
    messages: lockedMessages,
  };

  const beforeBinding = await resolveExactEvaluationTarget(dependencies, request);
  assertInspectionUnchanged(expected, beforeBinding.inspection);
  const predispatchReceipt: ModelHubExactEvaluationPredispatchReceipt = Object.freeze({
    generationId: input.generationId,
    target: expected.target,
    requestProfileHash: expected.requestProfileHash,
    messagePayloadHash: expected.messagePayloadHash,
    payloadHash: expected.payloadHash,
    executionLockHash: expected.executionLockHash,
    currency: expected.pricing.currency,
    estimatedMaximumCostMicros: expected.pricing.estimatedMaximumCostMicros,
    dataDestination: expected.dataDestination,
  });
  try {
    await input.reserveAndBindBeforeDispatch(predispatchReceipt);
  } catch (cause: unknown) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_RESERVATION_FAILED",
      "The exact evaluation dispatch could not be reserved and bound. No provider request was sent.",
      false,
      { cause },
    );
  }

  const atDispatch = await resolveExactEvaluationTarget(dependencies, request);
  assertInspectionUnchanged(expected, atDispatch.inspection);
  try {
    input.assertBeforeProviderDispatch();
  } catch (cause: unknown) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_CANCELLED_BEFORE_DISPATCH",
      "The exact evaluation was cancelled before the dispatch boundary. No provider request was sent.",
      false,
      { cause },
    );
  }
  try {
    await input.markDispatchStarted(predispatchReceipt);
  } catch (cause: unknown) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_DISPATCH_MARK_FAILED",
      "The exact evaluation dispatch boundary could not be committed. No provider request was sent.",
      false,
      { cause },
    );
  }
  try {
    input.assertBeforeProviderDispatch();
  } catch (cause: unknown) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_CANCELLED_AFTER_DISPATCH_MARK",
      "The exact evaluation was cancelled after the dispatch boundary was committed. The reservation must be treated as ambiguous and must not be retried.",
      true,
      { cause },
    );
  }

  let generated: NativeModelGenerationResult;
  try {
    generated = await dependencies.modelGateway.generate({
      generationId: input.generationId,
      config: Object.freeze({
        ...modelHubNativeEndpointConfig(atDispatch.connection),
        // Native POST generation does not retry today; pin zero here so the
        // exact-evaluation contract remains explicit if transport code evolves.
        retryLimit: 0,
      }),
      model: atDispatch.catalogEntry.providerModelId,
      messages: lockedMessages,
      maxOutputTokens: expected.requestProfile.maximumOutputTokens,
      temperature: expected.requestProfile.temperatureBasisPoints / 10_000,
      topP: expected.requestProfile.topPBasisPoints / 10_000,
      reasoningMode: expected.requestProfile.reasoningMode,
      dispatchScope: { kind: "non_project", reason: "novel_skill_evaluation" },
      ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
    });
  } catch (cause: unknown) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_PROVIDER_FAILED",
      "The exact evaluation provider request did not complete. It was not retried or rerouted.",
      true,
      { cause },
    );
  }

  if (typeof generated.text !== "string" || generated.text.trim().length === 0) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_OUTPUT_EMPTY",
      "The exact evaluation provider request produced no visible output.",
      true,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(generated.text)) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_OUTPUT_INVALID",
      "The exact evaluation provider output contains unsupported control characters.",
      true,
    );
  }
  validateUsage(generated.usage);
  const visibleOutputHash = await sha256Hex(generated.text);
  const estimatedActualCostMicros = calculateActualCost(atDispatch.costPrivacy, generated.usage);

  return Object.freeze({
    text: generated.text,
    usage: generated.usage,
    streamed: generated.streamed ?? null,
    visibleOutputHash,
    visibleContentLength: Array.from(generated.text).length,
    estimatedActualCostMicros,
    currency: expected.pricing.currency,
    dataDestination: expected.dataDestination,
    target: expected.target,
    requestProfileHash: expected.requestProfileHash,
    messagePayloadHash: expected.messagePayloadHash,
    payloadHash: expected.payloadHash,
    executionLockHash: expected.executionLockHash,
  });
}

async function resolveExactEvaluationTarget(
  dependencies: ModelHubExactEvaluationDependencies,
  input: InspectModelHubExactEvaluationTargetInput,
): Promise<ResolvedExactEvaluationTarget> {
  if (!dependencies.modelGateway.available) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_GATEWAY_UNAVAILABLE",
      "Exact model evaluation is available only through the desktop native gateway.",
    );
  }
  validateRequest(input);
  const now = dependencies.clock.now();
  const connection = await dependencies.modelHub.findConnection(input.target.connectionId);
  if (
    connection?.id !== input.target.connectionId ||
    connection.providerKind !== input.target.providerKind
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_TARGET_MISMATCH",
      "The exact provider connection does not match the pinned evaluation target.",
    );
  }
  if (!connection.enabled || connection.connectionStatus !== "ready") {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_CONNECTION_NOT_READY",
      "The exact provider connection is not ready.",
    );
  }

  const catalogMatches = (await dependencies.modelHub.listCatalog(connection.id)).filter(
    ({ id }) => id === input.target.catalogEntryId,
  );
  const catalogEntry = catalogMatches[0];
  if (
    catalogMatches.length !== 1 ||
    catalogEntry?.connectionId !== connection.id ||
    catalogEntry.providerModelId !== input.target.modelId
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_TARGET_MISMATCH",
      "The exact catalog entry, provider and model do not form one authoritative target.",
    );
  }
  if (
    catalogEntry.availability !== "available" ||
    catalogEntry.lifecycle === "deprecated" ||
    (catalogEntry.staleAfter !== null && catalogEntry.staleAfter <= now)
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_CATALOG_UNAVAILABLE",
      "The exact catalog entry is unavailable, deprecated or stale.",
    );
  }

  const preset = getModelProviderPreset(connection.providerKind);
  if (preset.protocol === "anthropic" && input.requestProfile.temperatureBasisPoints !== 10_000) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
      "The exact request profile is not supported by the selected provider protocol.",
    );
  }
  if (preset.credentialRequired || connection.credentialState === "present") {
    const summary = await dependencies.credentials
      .getSummary(modelHubCredentialProviderId(connection))
      .catch(() => ({ configured: false }));
    if (!summary.configured) {
      throw exactError(
        "MODEL_HUB_EXACT_EVALUATION_CREDENTIAL_MISSING",
        "The exact provider connection has no usable credential.",
      );
    }
  }

  const requiredCapabilities = requiredEvaluationCapabilities(input.requestProfile);
  const capabilityEvidence = await dependencies.modelHub.listCapabilityEvidence(catalogEntry.id);
  if (
    requiredCapabilities.some(
      (capability) =>
        resolveModelCapabilityVerdict({
          catalogEntryId: catalogEntry.id,
          capability,
          evidence: capabilityEvidence,
          now,
        }) !== "supported",
    )
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_CAPABILITY_UNVERIFIED",
      "The exact model lacks current evidence for every required request capability.",
    );
  }
  const relevantEvidence = capabilityEvidence
    .filter(({ capability }) => requiredCapabilities.includes(capability))
    .map(capabilityEvidenceProjection)
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), "en"));
  const capabilityEvidenceHash = await sha256Hex(
    canonicalJson({ requiredCapabilities, evidence: relevantEvidence }),
  );

  if (catalogEntry.inputTokenLimit === null || catalogEntry.outputTokenLimit === null) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_CONTEXT_LIMIT_UNKNOWN",
      "Exact evaluation requires catalog-backed input and output limits.",
    );
  }
  const estimatedInputTokens = estimateMessageTokens(input.messages);
  if (
    estimatedInputTokens > input.requestProfile.maximumInputTokens ||
    input.requestProfile.maximumOutputTokens > catalogEntry.outputTokenLimit ||
    estimatedInputTokens + input.requestProfile.maximumOutputTokens > catalogEntry.inputTokenLimit
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_CONTEXT_LIMIT_EXCEEDED",
      "The exact request profile exceeds the selected catalog limits.",
    );
  }

  const costPrivacy = await dependencies.modelHub.findCostPrivacyProfile(catalogEntry.id);
  assertVerifiedCostProfile(costPrivacy, catalogEntry.id);
  const lockedCostPrivacy = costPrivacy;
  const costProfileHash = await sha256Hex(canonicalJson(costProfileProjection(lockedCostPrivacy)));
  const estimatedMaximumCostMicros = calculateMaximumCost(
    lockedCostPrivacy,
    estimatedInputTokens,
    input.requestProfile.maximumOutputTokens,
  );
  if (estimatedMaximumCostMicros === null) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_COST_UNVERIFIED",
      "Exact evaluation requires verifiable pricing and currency metadata.",
    );
  }

  const requestProfileHash = await hashModelHubExactEvaluationRequestProfile(input.requestProfile);
  const messagePayloadHash = await hashModelHubExactEvaluationMessages(input.messages);
  const payloadHash = await sha256Hex(
    canonicalJson({
      version: "model-hub-exact-evaluation-payload@1",
      target: input.target,
      requestProfileHash,
      messages: input.messages,
    }),
  );
  const targetIdentityHash = await sha256Hex(
    canonicalJson({
      version: "model-hub-exact-evaluation-target@1",
      finalDispatchIdentity: modelHubFinalDispatchIdentity({
        connection,
        catalogEntry,
        costPrivacy: lockedCostPrivacy,
      }),
      capabilityEvidenceHash,
      costProfileHash,
    }),
  );
  const target: ModelHubExactEvaluationTargetLock = Object.freeze({
    ...input.target,
    connectionRevision: connection.revision,
    catalogRevision: catalogEntry.revision,
    costPrivacyRevision: lockedCostPrivacy.revision,
    capabilityEvidenceHash,
    costProfileHash,
    targetIdentityHash,
  });
  const executionLockHash = await hashModelHubExactEvaluationExecutionLock({
    targetIdentityHash,
    requestProfileHash,
    payloadHash,
    currency: lockedCostPrivacy.currency,
    estimatedMaximumCostMicros,
  });
  const inspection: ModelHubExactEvaluationInspection = Object.freeze({
    target,
    requestProfile: Object.freeze({ ...input.requestProfile }),
    requestProfileHash,
    messagePayloadHash,
    payloadHash,
    executionLockHash,
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    dataDestination: lockedCostPrivacy.dataDestination as "local" | "remote",
    estimatedInputTokens,
    estimatedTotalTokens: estimatedInputTokens + input.requestProfile.maximumOutputTokens,
    inputTokenLimit: catalogEntry.inputTokenLimit,
    outputTokenLimit: catalogEntry.outputTokenLimit,
    pricing: Object.freeze({
      currency: lockedCostPrivacy.currency,
      estimatedMaximumCostMicros,
      pricingVersion: lockedCostPrivacy.pricingVersion,
      priceUpdatedAt: lockedCostPrivacy.priceUpdatedAt,
      evidenceSource: lockedCostPrivacy.evidenceSource,
      evidenceVersion: lockedCostPrivacy.evidenceVersion,
      evidenceUpdatedAt: lockedCostPrivacy.evidenceUpdatedAt,
    }),
  });
  return Object.freeze({ inspection, connection, catalogEntry, costPrivacy: lockedCostPrivacy });
}

function validateRequest(input: InspectModelHubExactEvaluationTargetInput): void {
  assertPortableLocator(input.target.connectionId, "connection id", 128);
  assertPortableLocator(input.target.catalogEntryId, "catalog entry id", 128);
  assertPortableLocator(input.target.modelId, "model id", 512);
  validateRequestProfile(input.requestProfile);
  normalizeExactEvaluationMessages(input.messages);
}

/** Hashes the immutable provider message list without retaining its text. */
export async function hashModelHubExactEvaluationMessages(messagesValue: unknown): Promise<string> {
  const messages = normalizeExactEvaluationMessages(messagesValue);
  return sha256Hex(
    canonicalJson({
      version: "model-hub-exact-evaluation-messages@1",
      messages,
    }),
  );
}

function normalizeExactEvaluationMessages(messagesValue: unknown): readonly NativeModelMessage[] {
  const rawMessages: unknown = messagesValue;
  if (!Array.isArray(rawMessages)) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
      "The exact evaluation message list is invalid.",
    );
  }
  const messages: readonly unknown[] = rawMessages;
  if (messages.length < 1 || messages.length > MAXIMUM_TEXT_MESSAGES) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
      "The exact evaluation message list is invalid.",
    );
  }
  const normalized: NativeModelMessage[] = [];
  let totalCharacters = 0;
  for (const message of messages) {
    if (
      !isRecord(message) ||
      !["system", "user", "assistant"].includes(String(message.role)) ||
      typeof message.content !== "string"
    ) {
      throw exactError(
        "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
        "The exact evaluation messages contain invalid or oversized content.",
      );
    }
    const content = message.content;
    totalCharacters += content.length;
    if (
      content.trim().length < 1 ||
      content.length > MAXIMUM_MESSAGE_CHARACTERS ||
      totalCharacters > MAXIMUM_TOTAL_MESSAGE_CHARACTERS ||
      CONTROL_CHARACTER_PATTERN.test(content)
    ) {
      throw exactError(
        "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
        "The exact evaluation messages contain invalid or oversized content.",
      );
    }
    normalized.push(
      Object.freeze({
        role: message.role as NativeModelMessage["role"],
        content,
      }),
    );
  }
  return Object.freeze(normalized);
}

function validateRequestProfile(profile: unknown): void {
  if (
    !isRecord(profile) ||
    profile.version !== MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION ||
    !(MODEL_HUB_TEXT_TASKS as readonly unknown[]).includes(profile.task) ||
    typeof profile.maximumInputTokens !== "number" ||
    !Number.isSafeInteger(profile.maximumInputTokens) ||
    profile.maximumInputTokens < 1 ||
    profile.maximumInputTokens > 1_000_000_000 ||
    typeof profile.maximumOutputTokens !== "number" ||
    !Number.isSafeInteger(profile.maximumOutputTokens) ||
    profile.maximumOutputTokens < 1 ||
    profile.maximumOutputTokens > MAXIMUM_OUTPUT_TOKENS ||
    typeof profile.temperatureBasisPoints !== "number" ||
    !Number.isSafeInteger(profile.temperatureBasisPoints) ||
    profile.temperatureBasisPoints < 0 ||
    profile.temperatureBasisPoints > 20_000 ||
    typeof profile.topPBasisPoints !== "number" ||
    !Number.isSafeInteger(profile.topPBasisPoints) ||
    profile.topPBasisPoints < 0 ||
    profile.topPBasisPoints > 10_000 ||
    profile.reasoningMode !== "disabled" ||
    profile.responseFormat !== "text" ||
    profile.streaming !== true ||
    profile.stopPolicyHash !== MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH ||
    profile.providerCallPolicy !== "single_attempt"
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
      "The exact evaluation request profile is invalid.",
    );
  }
}

function validateInspection(
  inspection: ModelHubExactEvaluationInspection,
): ModelHubExactEvaluationInspection {
  validateRequestProfile(inspection.requestProfile);
  for (const hash of [
    inspection.target.capabilityEvidenceHash,
    inspection.target.costProfileHash,
    inspection.target.targetIdentityHash,
    inspection.requestProfileHash,
    inspection.messagePayloadHash,
    inspection.payloadHash,
    inspection.executionLockHash,
  ]) {
    if (!SHA256_PATTERN.test(hash)) {
      throw exactError(
        "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
        "The exact evaluation inspection contains an invalid hash lock.",
      );
    }
  }
  return inspection;
}

function snapshotInspection(
  inspection: ModelHubExactEvaluationInspection,
): ModelHubExactEvaluationInspection {
  return Object.freeze({
    target: Object.freeze({ ...inspection.target }),
    requestProfile: Object.freeze({ ...inspection.requestProfile }),
    requestProfileHash: inspection.requestProfileHash,
    messagePayloadHash: inspection.messagePayloadHash,
    payloadHash: inspection.payloadHash,
    executionLockHash: inspection.executionLockHash,
    requiredCapabilities: Object.freeze([...inspection.requiredCapabilities]),
    dataDestination: inspection.dataDestination,
    estimatedInputTokens: inspection.estimatedInputTokens,
    estimatedTotalTokens: inspection.estimatedTotalTokens,
    inputTokenLimit: inspection.inputTokenLimit,
    outputTokenLimit: inspection.outputTokenLimit,
    pricing: Object.freeze({ ...inspection.pricing }),
  });
}

function assertInspectionUnchanged(
  expected: ModelHubExactEvaluationInspection,
  current: ModelHubExactEvaluationInspection,
): void {
  if (
    expected.target.targetIdentityHash !== current.target.targetIdentityHash ||
    expected.target.connectionRevision !== current.target.connectionRevision ||
    expected.target.catalogRevision !== current.target.catalogRevision ||
    expected.target.costPrivacyRevision !== current.target.costPrivacyRevision ||
    expected.requestProfileHash !== current.requestProfileHash ||
    expected.messagePayloadHash !== current.messagePayloadHash ||
    expected.payloadHash !== current.payloadHash ||
    expected.executionLockHash !== current.executionLockHash
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_CONFIGURATION_CHANGED",
      "The exact target, capability, cost or request profile changed before provider dispatch.",
    );
  }
}

function requiredEvaluationCapabilities(
  profile: ModelHubExactEvaluationRequestProfile,
): readonly ModelHubCapability[] {
  const required = [...requiredCapabilitiesForNovelTask(profile.task)];
  return Object.freeze(required.sort((left, right) => left.localeCompare(right, "en")));
}

function capabilityEvidenceProjection(evidence: ModelCapabilityEvidence) {
  return {
    id: evidence.id,
    catalogEntryId: evidence.catalogEntryId,
    scanId: evidence.scanId,
    capability: evidence.capability,
    verdict: evidence.verdict,
    evidenceSource: evidence.evidenceSource,
    evidenceVersion: evidence.evidenceVersion,
    evidenceSummary: evidence.evidenceSummary,
    observedAt: evidence.observedAt,
    expiresAt: evidence.expiresAt,
  };
}

function costProfileProjection(profile: ModelCostPrivacyProfile) {
  return {
    catalogEntryId: profile.catalogEntryId,
    currency: profile.currency,
    inputMicrosPerMillionTokens: profile.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: profile.outputMicrosPerMillionTokens,
    cachedInputMicrosPerMillionTokens: profile.cachedInputMicrosPerMillionTokens,
    pricingVersion: profile.pricingVersion,
    priceUpdatedAt: profile.priceUpdatedAt,
    dataDestination: profile.dataDestination,
    retentionPolicy: profile.retentionPolicy,
    trainingPolicy: profile.trainingPolicy,
    evidenceSource: profile.evidenceSource,
    evidenceVersion: profile.evidenceVersion,
    evidenceSummary: profile.evidenceSummary,
    evidenceUpdatedAt: profile.evidenceUpdatedAt,
    revision: profile.revision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function assertVerifiedCostProfile(
  profile: ModelCostPrivacyProfile | null,
  catalogEntryId: string,
): asserts profile is VerifiedModelCostPrivacyProfile {
  if (
    profile?.catalogEntryId !== catalogEntryId ||
    profile.dataDestination === "unknown" ||
    profile.evidenceSource === "unknown" ||
    profile.currency === null ||
    !CURRENCY_PATTERN.test(profile.currency) ||
    profile.inputMicrosPerMillionTokens === null ||
    !RATE_PATTERN.test(profile.inputMicrosPerMillionTokens) ||
    profile.outputMicrosPerMillionTokens === null ||
    !RATE_PATTERN.test(profile.outputMicrosPerMillionTokens) ||
    (profile.cachedInputMicrosPerMillionTokens !== null &&
      !RATE_PATTERN.test(profile.cachedInputMicrosPerMillionTokens)) ||
    profile.pricingVersion === null ||
    profile.priceUpdatedAt === null
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_COST_UNVERIFIED",
      "Exact evaluation requires a complete, evidence-backed cost profile.",
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function estimateMessageTokens(messages: readonly NativeModelMessage[]): number {
  const bytes = new TextEncoder().encode(messages.map(({ content }) => content).join("\n")).length;
  return Math.max(1, bytes + messages.length * 512 + 4_096);
}

function calculateMaximumCost(
  profile: ModelCostPrivacyProfile,
  inputTokens: number,
  outputTokens: number,
): string | null {
  if (
    profile.currency === null ||
    profile.inputMicrosPerMillionTokens === null ||
    profile.outputMicrosPerMillionTokens === null
  ) {
    return null;
  }
  return calculateCostMicros(
    inputTokens,
    outputTokens,
    0,
    profile.inputMicrosPerMillionTokens,
    profile.outputMicrosPerMillionTokens,
    profile.cachedInputMicrosPerMillionTokens,
  );
}

function calculateActualCost(
  profile: ModelCostPrivacyProfile,
  usage: NativeModelGenerationResult["usage"],
): string | null {
  if (
    usage === null ||
    profile.currency === null ||
    profile.inputMicrosPerMillionTokens === null ||
    profile.outputMicrosPerMillionTokens === null
  ) {
    return null;
  }
  return calculateCostMicros(
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens ?? 0,
    profile.inputMicrosPerMillionTokens,
    profile.outputMicrosPerMillionTokens,
    profile.cachedInputMicrosPerMillionTokens,
  );
}

function calculateCostMicros(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  inputRate: string,
  outputRate: string,
  cachedInputRate: string | null,
): string {
  const cached = BigInt(cachedInputTokens);
  const uncached = BigInt(Math.max(0, inputTokens - cachedInputTokens));
  const numerator =
    uncached * BigInt(inputRate) +
    BigInt(outputTokens) * BigInt(outputRate) +
    cached * BigInt(cachedInputRate ?? inputRate);
  return ((numerator + 999_999n) / 1_000_000n).toString();
}

function validateUsage(usage: NativeModelGenerationResult["usage"]): void {
  if (
    usage !== null &&
    (!validTokenCount(usage.inputTokens) ||
      !validTokenCount(usage.outputTokens) ||
      (usage.cachedInputTokens !== null && !validTokenCount(usage.cachedInputTokens)) ||
      (usage.cachedInputTokens ?? 0) > usage.inputTokens)
  ) {
    throw new ModelHubExactEvaluationError(
      "MODEL_HUB_EXACT_EVALUATION_OUTPUT_INVALID",
      "The exact evaluation provider returned invalid usage metadata.",
      true,
    );
  }
}

function validTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function assertPortableLocator(value: string, label: string, maximumLength: number): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    /[\u0000\t\r\n ]/u.test(value)
  ) {
    throw exactError(
      "MODEL_HUB_EXACT_EVALUATION_REQUEST_INVALID",
      `The exact evaluation ${label} is invalid.`,
    );
  }
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

function exactError(
  code: ModelHubExactEvaluationErrorCode,
  message: string,
): ModelHubExactEvaluationError {
  return new ModelHubExactEvaluationError(code, message);
}
