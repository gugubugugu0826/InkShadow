import {
  compileContext,
  compiledContextToPromptSections,
  type CompiledContext,
  type ContextCandidate,
} from "@inkshadow/ai-core";
import {
  AiCandidate,
  AppError,
  err,
  ok,
  parseUuidV7,
  type Chapter,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";

import { ModelCenterError } from "./model-center-store";
import {
  executeModelHubTextTask,
  inspectModelHubTextTask,
  ModelHubExecutionError,
  type InspectModelHubTextTaskInput,
  type ModelHubTextTaskInspection,
} from "./model-hub-execution-service";
import { SINGLE_ATTEMPT_VISIBLE_PROSE_POLICY } from "./model-execution-policy";
import { createContextCompilationTrace } from "./context-compilation-trace-store";
import {
  validateCreativeOpeningDirection,
  validateCreativeOpeningIdea,
  validateCreativeOpeningProse,
} from "./creative-opening-input-policy";
import { recordSafeGenerationErrorCode } from "./generation-preflight-diagnostics";
import {
  ProjectContextPrivacyError,
  projectContextDispatchScope,
  projectContextRequiredDataDestination,
  type ProjectContextPrivacyReceipt,
} from "./project-context-privacy-authority";
import { selectProjectSeedContextCandidates } from "./project-seed-context-adapter";
import type { PreparedNovelSkillInvocation } from "./novel-skill-runtime";
import {
  assertDisclosedSelection,
  assertModelHubInspectionAuthority,
  modelHubInspectionAuthority,
  providerActionFingerprint,
  providerConnectionDisplayName,
  totalDisclosedCost,
  type ProviderActionDisclosure,
} from "./provider-action-disclosure";
import type { DesktopRuntime, NativeModelMessage } from "./runtime";

export interface CreativeOpeningResult {
  readonly requestId: string;
  readonly text: string;
  readonly source: "provider" | "local_fallback";
  readonly completion: "complete" | "partial";
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly noticeCode: string | null;
  /** Exact project-context trace for a real provider result; never shown in ordinary UI. */
  readonly contextTraceId: string | null;
}

export type CreativeOpeningAngle = "immediate_action" | "relationship_dialogue" | "mystery_clue";

export const CREATIVE_OPENING_BATCH_ANGLES = Object.freeze([
  "immediate_action",
  "relationship_dialogue",
  "mystery_clue",
] as const satisfies readonly CreativeOpeningAngle[]);

export type CreativeOpeningProviderActionKind =
  "initial_batch" | "replacement_batch" | "complete_partial" | "regenerate_single";

export interface CreativeOpeningProviderActionInput {
  readonly actionId: string;
  readonly kind: CreativeOpeningProviderActionKind;
  readonly idea: string;
  readonly direction?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly projectContext: CreativeOpeningProjectContext;
  /** Three stable slot ids for a batch, or one stable id for a single-slot action. */
  readonly requestIds: readonly string[];
  /** Required for single-slot actions and derived from the fixed angle set for batches. */
  readonly openingAngle?: CreativeOpeningAngle;
  /** Required only when completing one explicitly selected partial proposal. */
  readonly partialOpening?: string;
}

export interface CreativeOpeningProviderCallDisclosure {
  readonly requestId: string;
  readonly openingAngle: CreativeOpeningAngle;
  readonly connectionDisplayName: string;
  readonly modelId: string;
  readonly dataDestination: "local" | "remote";
  readonly estimatedMaximumCostMicros: string | null;
  readonly currency: string | null;
}

export interface CreativeOpeningProviderActionDisclosure extends ProviderActionDisclosure {
  readonly kind: CreativeOpeningProviderActionKind;
  readonly requestCount: 1 | 3;
  readonly maximumProviderCalls: 1 | 3;
  readonly perRequestMaximumProviderCalls: 1;
  readonly automaticRetryCount: 0;
  readonly calls: readonly CreativeOpeningProviderCallDisclosure[];
}

export interface ExecuteCreativeOpeningProviderActionInput extends CreativeOpeningProviderActionInput {
  readonly humanConfirmed?: boolean;
  readonly disclosureFingerprint?: string;
  readonly assertBeforeProviderDispatch?: (requestId: string) => void;
  readonly onInvocationPrepared?: (
    requestId: string,
    input: Readonly<{
      invocationId: string;
      connectionId: string;
      modelId: string;
    }>,
  ) => void | Promise<void>;
  readonly onProviderDispatchStarted?: (requestId: string, invocationId: string) => void;
  readonly onDelta?: (requestId: string, text: string) => void;
  /** Persists each independently settled slot without waiting for the rest of a batch. */
  readonly onResult?: (result: CreativeOpeningResult) => void | Promise<void>;
}

/** A truncated proposal below this boundary is not useful enough to offer to the author. */
export const MINIMUM_USABLE_PARTIAL_OPENING_CHARACTERS = 160;

export type CreativeOpeningDestination =
  | Readonly<{ kind: "local" }>
  | Readonly<{
      kind: "provider";
      providerId: string;
      connectionDisplayName: string;
      modelId: string;
    }>;

export interface CreativeOpeningProjectContext {
  readonly projectId: string;
  readonly chapterId: string;
}

interface PreparedCreativeOpeningProjectContext extends CreativeOpeningProjectContext {
  readonly compiled: CompiledContext;
  readonly privacyReceipt: ProjectContextPrivacyReceipt;
  readonly contextTraceId: string;
  readonly novelSkillSnapshotId: string;
  readonly novelSkillPreparation: PreparedNovelSkillInvocation;
  readonly novelSkillPromptSection: string | null;
  readonly chapterVersionId: string;
}

interface NormalizedCreativeOpeningProviderRequest {
  readonly requestId: string;
  readonly openingAngle: CreativeOpeningAngle;
  readonly partialOpening: string | null;
}

interface CreativeOpeningDispatchBinding {
  readonly inspection: ModelHubTextTaskInspection;
  readonly sourceFingerprint: string;
}

interface PreparedCreativeOpeningProviderCall {
  readonly request: NormalizedCreativeOpeningProviderRequest;
  readonly inspectionRequest: InspectModelHubTextTaskInput;
  readonly inspection: ModelHubTextTaskInspection;
  readonly connectionDisplayName: string;
  readonly sourceFingerprint: string;
}

interface PreparedCreativeOpeningProviderAction {
  readonly calls: readonly PreparedCreativeOpeningProviderCall[];
  readonly disclosure: CreativeOpeningProviderActionDisclosure;
}

/**
 * Resolves the complete bounded opening action without creating an invocation
 * or crossing the native Provider boundary. The caller must present this exact
 * fingerprint and obtain a fresh explicit confirmation before execution.
 */
export async function prepareCreativeOpeningProviderAction(
  runtime: DesktopRuntime,
  input: CreativeOpeningProviderActionInput,
): Promise<CreativeOpeningProviderActionDisclosure> {
  return (await prepareCreativeOpeningProviderActionCurrent(runtime, input)).disclosure;
}

/**
 * Executes exactly the disclosed opening slots. Every slot is a separate
 * single-attempt invocation; batches contain three slots and single-slot
 * completion/regeneration contains one. No action inherits Provider retries.
 */
export async function executeCreativeOpeningProviderAction(
  runtime: DesktopRuntime,
  input: ExecuteCreativeOpeningProviderActionInput,
): Promise<readonly CreativeOpeningResult[]> {
  if (input.humanConfirmed !== true || input.disclosureFingerprint === undefined) {
    throw new ModelCenterError(
      "CREATIVE_OPENING_CONFIRMATION_REQUIRED",
      "请先查看并确认这次开头生成的模型、发送范围、隐私和费用状态。",
    );
  }
  const prepared = await prepareCreativeOpeningProviderActionCurrent(runtime, input);
  if (prepared.disclosure.fingerprint !== input.disclosureFingerprint) {
    throw creativeOpeningDisclosureChanged();
  }
  const settled = await Promise.allSettled(
    prepared.calls.map(async (call) => {
      const result = await generateCreativeOpeningInternal(
        runtime,
        {
          idea: input.idea,
          ...(input.direction === undefined ? {} : { direction: input.direction }),
          answers: input.answers ?? {},
          openingAngle: call.request.openingAngle,
          ...(call.request.partialOpening === null
            ? {}
            : { partialOpening: call.request.partialOpening }),
          requestId: call.request.requestId,
          projectContext: input.projectContext,
          ...(input.assertBeforeProviderDispatch === undefined
            ? {}
            : {
                assertBeforeProviderDispatch: () =>
                  input.assertBeforeProviderDispatch?.(call.request.requestId),
              }),
          ...(input.onInvocationPrepared === undefined
            ? {}
            : {
                onInvocationPrepared: (selection) =>
                  input.onInvocationPrepared?.(call.request.requestId, selection),
              }),
          ...(input.onProviderDispatchStarted === undefined
            ? {}
            : {
                onProviderDispatchStarted: (invocationId) =>
                  input.onProviderDispatchStarted?.(call.request.requestId, invocationId),
              }),
          ...(input.onDelta === undefined
            ? {}
            : {
                onDelta: (text) => input.onDelta?.(call.request.requestId, text),
              }),
        },
        Object.freeze({
          inspection: call.inspection,
          sourceFingerprint: call.sourceFingerprint,
        }),
      );
      // Await the exact slot checkpoint, but do not let its rejection stop the
      // other confirmed calls. The aggregate error is surfaced only after
      // every slot has independently reached a provider/local terminal.
      await input.onResult?.(result);
      return result;
    }),
  );
  const rejected = settled.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  const rejectionReasons = rejected.map(({ reason }) => reason as unknown);
  if (rejected.length === 1) {
    throw rejectionReasons[0];
  }
  if (rejected.length > 1) {
    throw new AggregateError(rejectionReasons, "多个开头位置未能独立完成本地归档。");
  }
  return Object.freeze(
    settled.map((outcome) => {
      if (outcome.status !== "fulfilled") {
        throw new Error("开头位置结算状态不完整。");
      }
      return outcome.value;
    }),
  );
}

export async function inspectCreativeOpeningDestination(
  runtime: DesktopRuntime,
): Promise<CreativeOpeningDestination> {
  if (runtime.mode === "tauri") {
    const route = await runtime.modelHub.findTaskRoute("book_start_guidance").catch(() => null);
    if (route?.enabled === true) {
      const connections = await runtime.modelHub.listConnections().catch(() => []);
      for (const catalogEntryId of [route.primaryCatalogEntryId, route.fallbackCatalogEntryId]) {
        if (catalogEntryId === null) {
          continue;
        }
        for (const connection of connections) {
          if (
            !connection.enabled ||
            (connection.connectionStatus !== "ready" && connection.connectionStatus !== "degraded")
          ) {
            continue;
          }
          const catalog = await runtime.modelHub.listCatalog(connection.id).catch(() => []);
          const entry = catalog.find(({ id }) => id === catalogEntryId);
          if (entry !== undefined) {
            return {
              kind: "provider",
              providerId: connection.id,
              connectionDisplayName: connection.displayName,
              modelId: entry.providerModelId,
            };
          }
        }
      }
      return { kind: "local" };
    }
  }
  return { kind: "local" };
}

async function prepareCreativeOpeningProviderActionCurrent(
  runtime: DesktopRuntime,
  input: CreativeOpeningProviderActionInput,
): Promise<PreparedCreativeOpeningProviderAction> {
  if (runtime.mode !== "tauri" || !runtime.modelGateway.available) {
    throw new ModelCenterError(
      "MODEL_NATIVE_GATEWAY_UNAVAILABLE",
      "AI 开头需要桌面版中已连接的模型。请先连接模型，再返回继续。",
    );
  }
  const actionId = normalizeOpeningActionIdentifier(input.actionId, "动作");
  const idea = validateCreativeOpeningIdea(input.idea);
  const direction =
    input.direction === undefined || input.direction.trim().length === 0
      ? null
      : validateCreativeOpeningDirection(input.direction);
  const answers = input.answers ?? {};
  const requests = normalizeCreativeOpeningProviderRequests(input);
  const calls: PreparedCreativeOpeningProviderCall[] = [];

  for (const request of requests) {
    const preparedProjectContext = await prepareCreativeOpeningProjectContext(runtime, {
      ...input.projectContext,
      idea,
      direction,
      answers,
      openingAngle: request.openingAngle,
      partialOpening: request.partialOpening,
      requestId: request.requestId,
    });
    const messages = buildOpeningMessages(
      idea,
      direction,
      answers,
      request.openingAngle,
      request.partialOpening,
      preparedProjectContext.compiled,
      preparedProjectContext.novelSkillPromptSection,
    );
    const inspectionRequest = creativeOpeningInspectionRequest(
      messages,
      preparedProjectContext.privacyReceipt,
    );
    const inspection = await inspectModelHubTextTask(runtime, inspectionRequest);
    try {
      runtime.projectContextPrivacy.assertRouteEligible(
        preparedProjectContext.privacyReceipt,
        inspection.dataDestination === "local",
      );
    } catch (cause: unknown) {
      if (cause instanceof ProjectContextPrivacyError) {
        throw new ModelCenterError(cause.code, cause.message, cause.retryable);
      }
      throw cause;
    }
    let connectionDisplayName: string;
    try {
      connectionDisplayName = await providerConnectionDisplayName(runtime.modelHub, inspection);
    } catch {
      throw creativeOpeningDisclosureChanged();
    }
    calls.push(
      Object.freeze({
        request,
        inspectionRequest,
        inspection,
        connectionDisplayName,
        sourceFingerprint: await creativeOpeningSourceFingerprint({
          requestId: request.requestId,
          idea,
          direction,
          answers,
          openingAngle: request.openingAngle,
          partialOpening: request.partialOpening,
          messages,
          preparedProjectContext,
        }),
      }),
    );
  }

  const first = calls[0];
  if (first === undefined || calls.some((call) => !sameOpeningDisclosureTarget(first, call))) {
    throw new ModelCenterError(
      "CREATIVE_OPENING_ACTION_ROUTE_INCONSISTENT",
      "同一次开头操作解析到了不同模型或隐私去向，本次没有发送；请检查任务分工后重试。",
      true,
    );
  }
  const maximumProviderCalls = openingActionMaximumProviderCalls(input.kind);
  const cost = totalDisclosedCost(calls.map(({ inspection }) => inspection));
  const fingerprint = await providerActionFingerprint({
    actionId,
    kind: input.kind,
    projectContext: input.projectContext,
    idea,
    direction,
    answers,
    calls: calls.map(({ request, inspection, connectionDisplayName, sourceFingerprint }) => ({
      request,
      inspection: modelHubInspectionAuthority(inspection),
      connectionDisplayName,
      sourceFingerprint,
    })),
    maximumProviderCalls,
    perRequestMaximumProviderCalls: 1,
    automaticRetryCount: 0,
  });
  const disclosureCalls = calls.map(
    ({ request, inspection, connectionDisplayName }): CreativeOpeningProviderCallDisclosure =>
      Object.freeze({
        requestId: request.requestId,
        openingAngle: request.openingAngle,
        connectionDisplayName,
        modelId: inspection.modelId,
        dataDestination: inspection.dataDestination,
        estimatedMaximumCostMicros: inspection.pricing.estimatedMaximumCostMicros,
        currency:
          inspection.pricing.estimatedMaximumCostMicros === null
            ? null
            : inspection.pricing.currency,
      }),
  );
  const disclosure: CreativeOpeningProviderActionDisclosure = Object.freeze({
    fingerprint,
    kind: input.kind,
    requestCount: maximumProviderCalls,
    connectionDisplayName: first.connectionDisplayName,
    modelId: first.inspection.modelId,
    dataDestination: first.inspection.dataDestination,
    privacy:
      first.inspection.dataDestination === "local"
        ? "本次开头资料只发送给当前已验证的本机模型。"
        : "下列开头资料会发送到所选 AI 服务；生成结果仍是隔离建议，不会自动写入正文。",
    sends: creativeOpeningSendingScope({
      idea,
      direction,
      answers,
      calls,
    }),
    maximumProviderCalls,
    perRequestMaximumProviderCalls: 1 as const,
    automaticRetryCount: 0 as const,
    estimatedMaximumCostMicros: cost.estimatedMaximumCostMicros,
    currency: cost.currency,
    calls: Object.freeze(disclosureCalls),
  });
  return Object.freeze({ calls: Object.freeze(calls), disclosure });
}

function normalizeCreativeOpeningProviderRequests(
  input: CreativeOpeningProviderActionInput,
): readonly NormalizedCreativeOpeningProviderRequest[] {
  const maximumProviderCalls = openingActionMaximumProviderCalls(input.kind);
  if (input.requestIds.length !== maximumProviderCalls) {
    throw invalidCreativeOpeningAction(
      `“${input.kind}”必须绑定 ${String(maximumProviderCalls)} 个稳定请求。`,
    );
  }
  const requestIds = input.requestIds.map((requestId) =>
    normalizeOpeningActionIdentifier(requestId, "请求"),
  );
  if (new Set(requestIds).size !== requestIds.length) {
    throw invalidCreativeOpeningAction("同一次开头操作不能重复使用请求标识。");
  }
  if (maximumProviderCalls === 3) {
    if (input.openingAngle !== undefined || input.partialOpening !== undefined) {
      throw invalidCreativeOpeningAction("三方案动作使用固定的三个创作角度，不能附带单方案参数。");
    }
    return Object.freeze(
      CREATIVE_OPENING_BATCH_ANGLES.map((openingAngle, index) =>
        Object.freeze({
          requestId: requestIds[index] ?? "",
          openingAngle,
          partialOpening: null,
        }),
      ),
    );
  }
  if (input.openingAngle === undefined) {
    throw invalidCreativeOpeningAction("单方案动作必须绑定原方案的创作角度。");
  }
  if (input.kind === "complete_partial") {
    if (input.partialOpening === undefined) {
      throw invalidCreativeOpeningAction("补全动作必须绑定作者明确选择的未完整开头。");
    }
    return Object.freeze([
      Object.freeze({
        requestId: requestIds[0] ?? "",
        openingAngle: input.openingAngle,
        partialOpening: validateCreativeOpeningProse(input.partialOpening, 64_000, "未完整开头"),
      }),
    ]);
  }
  if (input.partialOpening !== undefined) {
    throw invalidCreativeOpeningAction("单方案重新生成不能把旧方案作为续写正文发送。");
  }
  return Object.freeze([
    Object.freeze({
      requestId: requestIds[0] ?? "",
      openingAngle: input.openingAngle,
      partialOpening: null,
    }),
  ]);
}

function openingActionMaximumProviderCalls(kind: CreativeOpeningProviderActionKind): 1 | 3 {
  return kind === "initial_batch" || kind === "replacement_batch" ? 3 : 1;
}

function normalizeOpeningActionIdentifier(value: string, label: string): string {
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw invalidCreativeOpeningAction(`${label}标识无效。`);
  }
  return normalized;
}

function invalidCreativeOpeningAction(message: string): ModelCenterError {
  return new ModelCenterError("CREATIVE_OPENING_ACTION_INVALID", message);
}

function sameOpeningDisclosureTarget(
  first: PreparedCreativeOpeningProviderCall,
  candidate: PreparedCreativeOpeningProviderCall,
): boolean {
  return (
    first.inspection.connectionId === candidate.inspection.connectionId &&
    first.inspection.catalogEntryId === candidate.inspection.catalogEntryId &&
    first.inspection.modelId === candidate.inspection.modelId &&
    first.inspection.dataDestination === candidate.inspection.dataDestination &&
    first.inspection.privacyPolicy === candidate.inspection.privacyPolicy &&
    first.connectionDisplayName === candidate.connectionDisplayName
  );
}

function creativeOpeningSendingScope(input: {
  readonly idea: string;
  readonly direction: string | null;
  readonly answers: Readonly<Record<string, string>>;
  readonly calls: readonly PreparedCreativeOpeningProviderCall[];
}): readonly string[] {
  const answerCount = Object.values(input.answers).filter(
    (value) => value.trim().length > 0,
  ).length;
  const includedContextCount =
    input.calls[0]?.inspectionRequest.messages.length === 0 ? 0 : input.calls.length;
  const partialCharacters = input.calls.reduce(
    (sum, { request }) => sum + (request.partialOpening?.length ?? 0),
    0,
  );
  return Object.freeze(
    [
      `一句话灵感（${String(input.idea.length)} 个字符）`,
      input.direction === null ? null : `本轮方向（${String(input.direction.length)} 个字符）`,
      answerCount === 0 ? null : `${String(answerCount)} 项作者已填写偏好`,
      `${String(input.calls.length)} 个独立开头请求及其固定创作角度`,
      includedContextCount === 0 ? null : "当前空白作品中本次编译明确选中的来源与实验性写作方法",
      partialCharacters === 0
        ? null
        : `作者明确选择的未完整开头（${String(partialCharacters)} 个字符）`,
    ].filter((value): value is string => value !== null),
  );
}

export async function generateCreativeOpening(
  runtime: DesktopRuntime,
  input: Readonly<{
    idea: string;
    direction?: string;
    answers?: Readonly<Record<string, string>>;
    openingAngle?: CreativeOpeningAngle;
    /** An explicitly selected incomplete proposal to continue without repeating its visible text. */
    partialOpening?: string;
    requestId?: string;
    onDelta?: (text: string) => void;
    /** Final synchronous journey/slot latch immediately before native dispatch. */
    assertBeforeProviderDispatch?: () => void;
    /** Persists the exact invocation owning this stable opening slot before dispatch. */
    onInvocationPrepared?: (
      input: Readonly<{
        invocationId: string;
        connectionId: string;
        modelId: string;
      }>,
    ) => void | Promise<void>;
    /** Synchronous UI notification backed by the durable invocation receipt. */
    onProviderDispatchStarted?: (invocationId: string) => void;
    /** Existing empty workspace that owns this traceable opening attempt. */
    projectContext?: CreativeOpeningProjectContext;
  }>,
): Promise<CreativeOpeningResult> {
  return generateCreativeOpeningInternal(runtime, input, null);
}

async function generateCreativeOpeningInternal(
  runtime: DesktopRuntime,
  input: Parameters<typeof generateCreativeOpening>[1],
  dispatchBinding: CreativeOpeningDispatchBinding | null,
): Promise<CreativeOpeningResult> {
  let idea: string;
  let direction: string | null;
  let partialOpening: string | null;
  try {
    idea = validateCreativeOpeningIdea(input.idea);
    direction =
      input.direction === undefined || input.direction.trim().length === 0
        ? null
        : validateCreativeOpeningDirection(input.direction);
    partialOpening =
      input.partialOpening === undefined
        ? null
        : validateCreativeOpeningProse(input.partialOpening, 64_000, "未完整开头");
  } catch (cause: unknown) {
    recordSafeGenerationErrorCode(runtime, safeModelFailureCode(cause));
    throw cause;
  }
  const requestId = input.requestId ?? runtime.ids.next();
  let preparedProjectContext: PreparedCreativeOpeningProjectContext | null = null;
  if (input.projectContext !== undefined) {
    try {
      preparedProjectContext = await prepareCreativeOpeningProjectContext(runtime, {
        ...input.projectContext,
        idea,
        direction,
        answers: input.answers ?? {},
        openingAngle: input.openingAngle ?? null,
        partialOpening,
        requestId,
      });
    } catch (cause: unknown) {
      return localOpening(runtime, requestId, idea, direction, safeModelFailureCode(cause));
    }
  }
  const messages = buildOpeningMessages(
    idea,
    direction,
    input.answers ?? {},
    input.openingAngle ?? null,
    partialOpening,
    preparedProjectContext?.compiled ?? null,
    preparedProjectContext?.novelSkillPromptSection ?? null,
  );
  const inspectionRequest = creativeOpeningInspectionRequest(
    messages,
    preparedProjectContext?.privacyReceipt ?? null,
  );
  let visibleText = partialOpening ?? "";
  const receiveVisibleText = (text: string) => {
    visibleText = combineOpeningText(partialOpening, text);
    input.onDelta?.(visibleText);
  };

  if (runtime.mode === "tauri" && runtime.modelGateway.available) {
    const dispatchedTarget: { connectionId: string | null; modelId: string | null } = {
      connectionId: null,
      modelId: null,
    };
    try {
      const currentInspection = await inspectModelHubTextTask(runtime, inspectionRequest);
      const expectedInspection = dispatchBinding?.inspection ?? currentInspection;
      assertCreativeOpeningInspection(expectedInspection, currentInspection);
      if (dispatchBinding !== null) {
        const currentSourceFingerprint = await creativeOpeningSourceFingerprint({
          requestId,
          idea,
          direction,
          answers: input.answers ?? {},
          openingAngle: input.openingAngle ?? null,
          partialOpening,
          messages,
          preparedProjectContext,
        });
        if (currentSourceFingerprint !== dispatchBinding.sourceFingerprint) {
          throw creativeOpeningDisclosureChanged();
        }
      }
      const generated = await executeModelHubTextTask(runtime, {
        dispatchScope:
          preparedProjectContext === null
            ? { kind: "non_project", reason: "creative_opening" }
            : projectContextDispatchScope(preparedProjectContext.privacyReceipt),
        ...inspectionRequest,
        generationId: requestId,
        invocationId: requestId,
        executionPolicy: SINGLE_ATTEMPT_VISIBLE_PROSE_POLICY,
        generationRetryLimitOverride: 0,
        reasoningPolicy: "visible_prose",
        ...(preparedProjectContext === null ||
        projectContextRequiredDataDestination(preparedProjectContext.privacyReceipt) === undefined
          ? {}
          : { requiredDataDestination: "local" as const }),
        onBeforeDispatch: async ({
          connectionId,
          modelId,
          generationId,
          invocationId,
          localOnlyEligible,
          catalogEntryId,
          usedFallback,
        }) => {
          assertCreativeOpeningSelection(expectedInspection, {
            connectionId,
            catalogEntryId,
            modelId,
            usedFallback,
          });
          await assertCreativeOpeningInspectionCurrent(
            runtime,
            inspectionRequest,
            expectedInspection,
          );
          dispatchedTarget.connectionId = connectionId;
          dispatchedTarget.modelId = modelId;
          await input.onInvocationPrepared?.({ invocationId, connectionId, modelId });
          if (preparedProjectContext === null) {
            return;
          }
          const createdAt = runtime.clock.now();
          await runtime.contextTraces.save(
            createContextCompilationTrace({
              id: preparedProjectContext.contextTraceId,
              projectId: preparedProjectContext.projectId,
              chapterId: preparedProjectContext.chapterId,
              taskType: "book_start_guidance",
              compiled: preparedProjectContext.compiled,
              createdAt,
              execution: {
                generationId,
                modelInvocationId: null,
              },
            }),
          );
          await runtime.contextTraces.linkModelInvocation({
            traceId: preparedProjectContext.contextTraceId,
            modelInvocationId: invocationId,
            linkedAt: createdAt,
          });
          await assertCreativeOpeningProjectCurrent(runtime, preparedProjectContext);
          runtime.projectContextPrivacy.assertRouteEligible(
            preparedProjectContext.privacyReceipt,
            localOnlyEligible === true,
          );
          if (preparedProjectContext.novelSkillPreparation.compiled !== null) {
            await runtime.novelSkills.commitBeforeDispatch({
              snapshotId: preparedProjectContext.novelSkillSnapshotId,
              projectId: preparedProjectContext.projectId,
              contextTraceId: preparedProjectContext.contextTraceId,
              modelInvocationId: invocationId,
              taskType: "book_start_guidance",
              invocationMode: "draft",
              preparation: preparedProjectContext.novelSkillPreparation,
              createdAt,
            });
          }
        },
        ...(preparedProjectContext === null
          ? {}
          : {
              onFinalBeforeProviderDispatch: async (selection) => {
                assertCreativeOpeningSelection(expectedInspection, selection);
                await assertCreativeOpeningInspectionCurrent(
                  runtime,
                  inspectionRequest,
                  expectedInspection,
                );
                if (dispatchBinding !== null) {
                  await assertCreativeOpeningSourceCurrent(runtime, {
                    requestId,
                    idea,
                    direction,
                    answers: input.answers ?? {},
                    openingAngle: input.openingAngle ?? null,
                    partialOpening,
                    projectContext: preparedProjectContext,
                    expectedSourceFingerprint: dispatchBinding.sourceFingerprint,
                  });
                }
                await assertCreativeOpeningProjectCurrent(runtime, preparedProjectContext);
                runtime.projectContextPrivacy.assertRouteEligible(
                  preparedProjectContext.privacyReceipt,
                  selection.localOnlyEligible === true,
                );
              },
            }),
        ...(input.assertBeforeProviderDispatch === undefined
          ? {}
          : { assertBeforeProviderDispatch: input.assertBeforeProviderDispatch }),
        ...(input.onProviderDispatchStarted === undefined
          ? {}
          : {
              onProviderDispatchStarted: ({ invocationId }) =>
                input.onProviderDispatchStarted?.(invocationId),
            }),
        onDelta: receiveVisibleText,
      });
      if (preparedProjectContext !== null) {
        await assertCreativeOpeningProjectCurrent(runtime, preparedProjectContext);
      }
      const text = combineOpeningText(partialOpening, generated.text).trim();
      if (text.length === 0) {
        return localOpening(runtime, requestId, idea, direction, "MODEL_OUTPUT_EMPTY");
      }
      return Object.freeze({
        requestId,
        text,
        source: "provider",
        completion: "complete",
        providerId: generated.connectionId,
        modelId: generated.modelId,
        noticeCode: generated.costCeilingExceededAfterDispatch
          ? "MODEL_HUB_COST_CEILING_EXCEEDED_AFTER_DISPATCH"
          : null,
        contextTraceId: preparedProjectContext?.contextTraceId ?? null,
      });
    } catch (cause: unknown) {
      const partial = usableTruncatedOpening(
        requestId,
        visibleText,
        cause,
        dispatchedTarget.connectionId,
        dispatchedTarget.modelId,
        preparedProjectContext?.contextTraceId ?? null,
      );
      if (partial !== null) {
        recordSafeGenerationErrorCode(runtime, "MODEL_OUTPUT_TRUNCATED");
        if (preparedProjectContext !== null) {
          try {
            await assertCreativeOpeningProjectCurrent(runtime, preparedProjectContext);
          } catch (workspaceCause: unknown) {
            return localOpening(
              runtime,
              requestId,
              idea,
              direction,
              safeModelFailureCode(workspaceCause),
            );
          }
        }
        return partial;
      }
      if (
        !(cause instanceof ModelHubExecutionError) ||
        cause.code !== "MODEL_HUB_ROUTE_NOT_CONFIGURED"
      ) {
        return localOpening(runtime, requestId, idea, direction, safeModelFailureCode(cause));
      }
    }
  }

  // Every real opening request must be traceable through Model Hub. A legacy
  // profile cannot provide the invocation, cost, privacy and recovery receipt,
  // so a missing route fails closed to the labelled local example.
  return localOpening(runtime, requestId, idea, direction, "MODEL_HUB_ROUTE_NOT_CONFIGURED");
}

/** Returns the deterministic, clearly labelled local example without contacting a provider. */
export function generateLocalCreativeOpening(
  runtime: Pick<DesktopRuntime, "ids">,
  input: Readonly<{ idea: string; direction?: string; requestId?: string }>,
): CreativeOpeningResult {
  const idea = validateCreativeOpeningIdea(input.idea);
  const direction =
    input.direction === undefined || input.direction.trim().length === 0
      ? null
      : validateCreativeOpeningDirection(input.direction);
  return localOpening(
    runtime,
    input.requestId ?? runtime.ids.next(),
    idea,
    direction,
    "LOCAL_SAMPLE",
  );
}

export async function persistCreativeOpeningCandidate(
  runtime: DesktopRuntime,
  chapterId: UuidV7,
  textValue: string,
  candidateId?: UuidV7,
  incomplete = false,
  contextTraceId: string | null = null,
): Promise<Result<AiCandidate, AppError | ModelCenterError>> {
  const chapterResult = await runtime.repositories.chapters.findById(chapterId);
  if (!chapterResult.ok) {
    return chapterResult;
  }
  const chapter = chapterResult.value;
  if (chapter === null) {
    return err(
      new AppError({
        code: "CHAPTER_NOT_FOUND",
        message: "The opening chapter no longer exists.",
      }),
    );
  }
  let text: string;
  try {
    text = validateCreativeOpeningProse(textValue, 5_000_000, "开头正文");
  } catch (cause: unknown) {
    recordSafeGenerationErrorCode(runtime, safeModelFailureCode(cause));
    throw cause;
  }
  const streaming = AiCandidate.createStreaming({
    id: candidateId ?? runtime.ids.next(),
    projectId: chapter.projectId,
    chapterId: chapter.id,
    source: "generate",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
  });
  if (!streaming.ok) {
    return streaming;
  }
  const checksum = await runtime.hasher.sha256(text);
  if (!checksum.ok) {
    return checksum;
  }
  const ready = streaming.value.markReady(text, checksum.value, runtime.clock.now(), incomplete);
  if (!ready.ok) {
    return ready;
  }
  if (contextTraceId !== null) {
    try {
      await assertCreativeOpeningCandidateTraceCurrent(runtime, contextTraceId, chapter);
      await runtime.contextTraceOutputs.commit({
        traceId: contextTraceId,
        candidate: ready.value,
        linkedAt: runtime.clock.now(),
      });
      return ok(ready.value);
    } catch (cause: unknown) {
      return err(
        new ModelCenterError(
          "CONTEXT_TRACE_UNAVAILABLE",
          cause instanceof Error
            ? cause.message
            : "无法同时保存 AI 建议版本及其来源记录，正文和已有版本均未改变。",
          true,
        ),
      );
    }
  }
  const saved = await runtime.repositories.aiCandidates.create(ready.value);
  return saved.ok ? ok(ready.value) : saved;
}

async function assertCreativeOpeningCandidateTraceCurrent(
  runtime: DesktopRuntime,
  contextTraceId: string,
  chapter: Chapter,
): Promise<void> {
  const trace = await runtime.contextTraces.findById(contextTraceId);
  if (trace === null) {
    throw staleCreativeOpeningTrace();
  }
  const taskSource = trace.entries
    .flatMap(({ sources }) => sources)
    .find(
      ({ sourceType, locator }) =>
        sourceType === "generation_task" && locator === "idea-journey:opening-request",
    );
  if (trace.execution === null || taskSource === undefined) {
    throw staleCreativeOpeningTrace();
  }
  if (
    trace.taskType !== "book_start_guidance" ||
    trace.projectId !== chapter.projectId ||
    trace.chapterId !== chapter.id ||
    trace.execution.modelInvocationId === null ||
    taskSource.sourceVersionId !== chapter.currentVersionId ||
    taskSource.sourceId !== trace.execution.generationId
  ) {
    throw staleCreativeOpeningTrace();
  }
}

function staleCreativeOpeningTrace(): ModelCenterError {
  return new ModelCenterError(
    "CONTEXT_TRACE_UNAVAILABLE",
    "AI 建议版本的来源记录与当前第一章版本不一致，因此没有创建建议版本；正文和已有版本均未改变。",
    true,
  );
}

const CREATIVE_OPENING_CONTEXT_TOKEN_BUDGET = 32_000;
const CREATIVE_OPENING_SKILL_TOKEN_BUDGET = 1_200;

async function prepareCreativeOpeningProjectContext(
  runtime: DesktopRuntime,
  input: CreativeOpeningProjectContext &
    Readonly<{
      idea: string;
      direction: string | null;
      answers: Readonly<Record<string, string>>;
      openingAngle: CreativeOpeningAngle | null;
      partialOpening: string | null;
      requestId: string;
    }>,
): Promise<PreparedCreativeOpeningProjectContext> {
  const projectId = parseUuidV7(input.projectId);
  const chapterId = parseUuidV7(input.chapterId);
  if (!projectId.ok) throw projectId.error;
  if (!chapterId.ok) throw chapterId.error;
  const [projectResult, chapterResult, seedRecord] = await Promise.all([
    runtime.repositories.projects.findById(projectId.value),
    runtime.repositories.chapters.findById(chapterId.value),
    runtime.projectSeeds.findByProjectId(projectId.value),
  ]);
  if (!projectResult.ok) throw projectResult.error;
  if (!chapterResult.ok) throw chapterResult.error;
  const project = projectResult.value;
  const chapter = chapterResult.value;
  if (
    project?.status !== "active" ||
    chapter?.status !== "active" ||
    chapter.projectId !== projectId.value ||
    chapter.content.length !== 0
  ) {
    throw new ModelCenterError(
      "CREATIVE_OPENING_WORKSPACE_CHANGED",
      "开书使用的空白作品或第一章已经发生变化，因此本次没有调用 AI。正文和已有版本均未改变。",
      true,
    );
  }
  const privacyReceipt = await runtime.projectContextPrivacy.inspect(projectId.value);
  runtime.projectContextPrivacy.assertChapterMatches(privacyReceipt, chapter);
  const reservedSkillTokens = await runtime.novelSkills.getReservedTokens({
    projectId: projectId.value,
    taskType: "book_start_guidance",
  });
  const currentTask: ContextCandidate = Object.freeze({
    id: `creative-opening-task:${input.requestId}`,
    layer: "current_task",
    content: buildOpeningTaskContent(
      input.idea,
      input.direction,
      input.answers,
      input.openingAngle,
      input.partialOpening,
    ),
    selectionReason: "The author explicitly requested this exact opening proposal.",
    evidence: Object.freeze([
      Object.freeze({
        sourceType: "generation_task" as const,
        sourceId: input.requestId,
        sourceVersionId: chapter.currentVersionId,
        locator: "idea-journey:opening-request",
        contentHash: null,
        excerpt: null,
      }),
    ]),
    priority: 1_000,
    relevanceScore: 1,
  });
  const compiled = compileContext({
    maximumContextTokens: Math.max(1, CREATIVE_OPENING_CONTEXT_TOKEN_BUDGET - reservedSkillTokens),
    candidates: Object.freeze([currentTask, ...selectProjectSeedContextCandidates(seedRecord)]),
  });
  const novelSkillPreparation = await runtime.novelSkills.prepareInvocation({
    projectId: projectId.value,
    taskType: "book_start_guidance",
    invocationMode: "draft",
    maximumSkillTokens:
      reservedSkillTokens === 0
        ? CREATIVE_OPENING_SKILL_TOKEN_BUDGET
        : Math.min(reservedSkillTokens, CREATIVE_OPENING_SKILL_TOKEN_BUDGET),
    availableContextLayers: Object.freeze([
      ...new Set(compiled.entries.filter(({ included }) => included).map(({ layer }) => layer)),
    ]),
  });
  return Object.freeze({
    projectId: projectId.value,
    chapterId: chapterId.value,
    chapterVersionId: chapter.currentVersionId,
    compiled,
    privacyReceipt,
    contextTraceId: runtime.ids.next(),
    novelSkillSnapshotId: runtime.ids.next(),
    novelSkillPreparation,
    novelSkillPromptSection: novelSkillPreparation.promptSection,
  });
}

async function assertCreativeOpeningProjectCurrent(
  runtime: DesktopRuntime,
  prepared: PreparedCreativeOpeningProjectContext,
): Promise<void> {
  const projectId = parseUuidV7(prepared.projectId);
  const chapterId = parseUuidV7(prepared.chapterId);
  if (!projectId.ok || !chapterId.ok) {
    throw new ModelHubExecutionError(
      "CREATIVE_OPENING_WORKSPACE_CHANGED",
      "开书作品的范围无法再次核对，本次请求在发送 0 字后停止。",
      true,
    );
  }
  const [projectResult, chapterResult] = await Promise.all([
    runtime.repositories.projects.findById(projectId.value),
    runtime.repositories.chapters.findById(chapterId.value),
  ]);
  const project = projectResult.ok ? projectResult.value : null;
  const chapter = chapterResult.ok ? chapterResult.value : null;
  if (
    project?.status !== "active" ||
    chapter?.status !== "active" ||
    chapter.projectId !== projectId.value ||
    chapter.currentVersionId !== prepared.chapterVersionId ||
    chapter.content.length !== 0
  ) {
    throw new ModelHubExecutionError(
      "CREATIVE_OPENING_WORKSPACE_CHANGED",
      "开书作品或第一章在发送前发生了变化，本次请求在发送 0 字后停止。",
      true,
    );
  }
  try {
    runtime.projectContextPrivacy.assertChapterMatches(prepared.privacyReceipt, chapter);
    await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(prepared.privacyReceipt);
  } catch (cause: unknown) {
    if (cause instanceof ProjectContextPrivacyError) {
      throw new ModelHubExecutionError(cause.code, cause.message, cause.retryable);
    }
    throw cause;
  }
}

function creativeOpeningInspectionRequest(
  messages: readonly NativeModelMessage[],
  privacyReceipt: ProjectContextPrivacyReceipt | null,
): InspectModelHubTextTaskInput {
  const requiredDataDestination =
    privacyReceipt === null ? undefined : projectContextRequiredDataDestination(privacyReceipt);
  return Object.freeze({
    task: "book_start_guidance" as const,
    messages,
    maximumOutputTokens: 1_200,
    temperature: 0.85,
    ...(requiredDataDestination === undefined ? {} : { requiredDataDestination }),
  });
}

async function creativeOpeningSourceFingerprint(input: {
  readonly requestId: string;
  readonly idea: string;
  readonly direction: string | null;
  readonly answers: Readonly<Record<string, string>>;
  readonly openingAngle: CreativeOpeningAngle | null;
  readonly partialOpening: string | null;
  readonly messages: readonly NativeModelMessage[];
  readonly preparedProjectContext: PreparedCreativeOpeningProjectContext | null;
}): Promise<string> {
  const prepared = input.preparedProjectContext;
  return providerActionFingerprint({
    authority: "creative_opening_source_v1",
    requestId: input.requestId,
    idea: input.idea,
    direction: input.direction,
    answers: input.answers,
    openingAngle: input.openingAngle,
    partialOpening: input.partialOpening,
    messages: input.messages,
    project:
      prepared === null
        ? null
        : {
            projectId: prepared.projectId,
            chapterId: prepared.chapterId,
            chapterVersionId: prepared.chapterVersionId,
            privacyFingerprint: prepared.privacyReceipt.fingerprint,
            compiledSources: prepared.compiled.entries.map((entry) => ({
              id: entry.id,
              layer: entry.layer,
              content: entry.content,
              evidence: entry.evidence,
              included: entry.included,
              discardedReason: entry.discardedReason,
            })),
            novelSkill: {
              promptSection: prepared.novelSkillPreparation.promptSection,
              methods: prepared.novelSkillPreparation.methods,
            },
          },
  });
}

async function assertCreativeOpeningSourceCurrent(
  runtime: DesktopRuntime,
  input: Readonly<{
    requestId: string;
    idea: string;
    direction: string | null;
    answers: Readonly<Record<string, string>>;
    openingAngle: CreativeOpeningAngle | null;
    partialOpening: string | null;
    projectContext: CreativeOpeningProjectContext;
    expectedSourceFingerprint: string;
  }>,
): Promise<void> {
  try {
    const preparedProjectContext = await prepareCreativeOpeningProjectContext(runtime, {
      ...input.projectContext,
      idea: input.idea,
      direction: input.direction,
      answers: input.answers,
      openingAngle: input.openingAngle,
      partialOpening: input.partialOpening,
      requestId: input.requestId,
    });
    const messages = buildOpeningMessages(
      input.idea,
      input.direction,
      input.answers,
      input.openingAngle,
      input.partialOpening,
      preparedProjectContext.compiled,
      preparedProjectContext.novelSkillPromptSection,
    );
    const current = await creativeOpeningSourceFingerprint({
      requestId: input.requestId,
      idea: input.idea,
      direction: input.direction,
      answers: input.answers,
      openingAngle: input.openingAngle,
      partialOpening: input.partialOpening,
      messages,
      preparedProjectContext,
    });
    if (current !== input.expectedSourceFingerprint) {
      throw creativeOpeningDisclosureChanged();
    }
  } catch (cause: unknown) {
    if (cause instanceof ModelCenterError && cause.code === "CREATIVE_OPENING_DISCLOSURE_CHANGED") {
      throw creativeOpeningDispatchDisclosureChanged();
    }
    throw creativeOpeningDispatchDisclosureChanged();
  }
}

async function assertCreativeOpeningInspectionCurrent(
  runtime: DesktopRuntime,
  request: InspectModelHubTextTaskInput,
  expected: ModelHubTextTaskInspection,
): Promise<void> {
  try {
    assertModelHubInspectionAuthority(expected, await inspectModelHubTextTask(runtime, request));
  } catch {
    throw creativeOpeningDispatchDisclosureChanged();
  }
}

function assertCreativeOpeningInspection(
  expected: ModelHubTextTaskInspection,
  current: ModelHubTextTaskInspection,
): void {
  try {
    assertModelHubInspectionAuthority(expected, current);
  } catch {
    throw creativeOpeningDisclosureChanged();
  }
}

function assertCreativeOpeningSelection(
  expected: ModelHubTextTaskInspection,
  selection: Parameters<typeof assertDisclosedSelection>[1],
): void {
  try {
    assertDisclosedSelection(expected, selection);
  } catch {
    throw creativeOpeningDispatchDisclosureChanged();
  }
}

function creativeOpeningDisclosureChanged(): ModelCenterError {
  return new ModelCenterError(
    "CREATIVE_OPENING_DISCLOSURE_CHANGED",
    "模型、费用、发送来源或隐私范围已经改变；本次没有发送，请重新查看并确认。",
    true,
  );
}

function creativeOpeningDispatchDisclosureChanged(): ModelHubExecutionError {
  return new ModelHubExecutionError(
    "CREATIVE_OPENING_DISCLOSURE_CHANGED",
    "模型、费用、发送来源或隐私范围已经改变；本次请求在发送 0 字后停止。",
    true,
  );
}

function buildOpeningMessages(
  idea: string,
  direction: string | null,
  answers: Readonly<Record<string, string>>,
  openingAngle: CreativeOpeningAngle | null,
  partialOpening: string | null,
  compiled: CompiledContext | null,
  novelSkillPromptSection: string | null,
): readonly NativeModelMessage[] {
  const known = Object.entries(answers)
    .filter(([, value]) => value.trim().length > 0)
    .slice(0, 12)
    .map(([key, value]) => `${key}：${value}`)
    .join("\n");
  const baseSystemMessage =
    partialOpening === null
      ? "你是长篇小说开篇助手。根据作者的一句话灵感写一段 500 至 900 字、可直接继续修改的小说开头。只输出正文，不要标题、分析、设定表、Markdown 围栏或元评论。不要把推测写成已经确认的长期设定；聚焦具体场景、人物行动和一个能推动下一段的问题。"
      : "你是长篇小说开篇助手。续写作者明确选择的未完整开头，只输出从已有文字结尾之后开始的新正文。不要复述已有文字，不要标题、分析、设定表、Markdown 围栏或元评论；让补全后的开头形成一个可继续修改的完整场景。";
  const systemMessage =
    novelSkillPromptSection === null
      ? baseSystemMessage
      : `${baseSystemMessage}\n\n以下是作者明确开启的实验性写作方法，只用于辅助本次开头建议。若它与作者当前要求、已确认并锁定的故事规则或写作边界冲突，必须忽略冲突的方法规则。不要向作者解释这些方法。\n${novelSkillPromptSection}`;
  const compiledPrompt =
    compiled === null
      ? null
      : compiledContextToPromptSections(compiled)
          .map(({ text }) => text)
          .join("\n\n");
  return Object.freeze([
    {
      role: "system",
      content: systemMessage,
    },
    {
      role: "user",
      content:
        compiledPrompt ??
        [
          `作者的一句话灵感：${idea}`,
          direction === null ? "" : `本轮修改方向：${direction}`,
          openingAngle === null ? "" : `本次开头方案侧重：${openingAngleInstruction(openingAngle)}`,
          known.length === 0 ? "" : `作者已经表达的偏好：\n${known}`,
          partialOpening === null ? "" : `需要从结尾继续的已有开头：\n${partialOpening}`,
        ]
          .filter((value) => value.length > 0)
          .join("\n\n"),
    },
  ]);
}

function buildOpeningTaskContent(
  idea: string,
  direction: string | null,
  answers: Readonly<Record<string, string>>,
  openingAngle: CreativeOpeningAngle | null,
  partialOpening: string | null,
): string {
  const known = Object.entries(answers)
    .filter(([, value]) => value.trim().length > 0)
    .slice(0, 12)
    .map(([key, value]) => `${key}：${value}`)
    .join("\n");
  return [
    "[本次开头创作任务]",
    `作者的一句话灵感：${idea}`,
    direction === null ? "" : `本轮修改方向：${direction}`,
    openingAngle === null ? "" : `本次方案侧重：${openingAngleInstruction(openingAngle)}`,
    known.length === 0 ? "" : `作者本次已表达的信息：\n${known}`,
    partialOpening === null ? "" : `仅从以下未完整开头的结尾继续，不得复述：\n${partialOpening}`,
  ]
    .filter((value) => value.length > 0)
    .join("\n\n");
}

function openingAngleInstruction(angle: CreativeOpeningAngle): string {
  switch (angle) {
    case "immediate_action":
      return "从一个正在发生的选择或行动切入，尽快建立场景目标";
    case "relationship_dialogue":
      return "从人物关系与具体对话切入，让关系张力推动读者继续阅读";
    case "mystery_clue":
      return "从一个异常细节或未解线索切入，但不要提前解释真相";
  }
}

function localOpening(
  runtime: object,
  requestId: string,
  idea: string,
  direction: string | null,
  noticeCode: string,
): CreativeOpeningResult {
  if (noticeCode !== "LOCAL_SAMPLE") {
    recordSafeGenerationErrorCode(runtime, noticeCode);
  }
  const subject = idea.replaceAll(/\s+/gu, " ").slice(0, 80);
  const directionHint = direction === null ? "" : localDirectionHint(direction);
  const text = [
    `傍晚六点十七分，天光刚从窗沿退下去，${subject}这件事第一次有了真实的重量。`,
    `房间里没有人催促，桌上的水却已经凉了。主角盯着那条刚出现的消息，手指停在屏幕上方，明明只要轻轻一点，原本熟悉的生活就会从这里裂开一道缝${directionHint}。`,
    `门外传来脚步声。对方没有敲门，只隔着薄薄的门板叫了一次名字。那声音太平静，反而让人无法继续假装什么都没有发生。`,
    `主角把手机扣在桌面，站起身时碰倒了椅子。就在门被推开的前一秒，屏幕再次亮起——这次只有一句话：别相信刚才见到的那个人。`,
  ].join("\n\n");
  return Object.freeze({
    requestId,
    text,
    source: "local_fallback",
    completion: "complete",
    providerId: null,
    modelId: null,
    noticeCode,
    contextTraceId: null,
  });
}

function usableTruncatedOpening(
  requestId: string,
  visibleText: string,
  cause: unknown,
  providerId: string | null,
  modelId: string | null,
  contextTraceId: string | null,
): CreativeOpeningResult | null {
  const text = visibleText.trim();
  if (
    safeModelFailureCode(cause) !== "MODEL_OUTPUT_TRUNCATED" ||
    providerId === null ||
    modelId === null ||
    text.length < MINIMUM_USABLE_PARTIAL_OPENING_CHARACTERS
  ) {
    return null;
  }
  return Object.freeze({
    requestId,
    text,
    source: "provider",
    completion: "partial",
    providerId,
    modelId,
    noticeCode: "MODEL_OUTPUT_TRUNCATED",
    contextTraceId,
  });
}

function combineOpeningText(partialOpening: string | null, continuation: string): string {
  return partialOpening === null ? continuation : `${partialOpening}${continuation}`;
}

function localDirectionHint(direction: string): string {
  const commonDirections: Readonly<Record<string, string>> = {
    更甜一点: "，而一丝尚未说破的甜意正悄悄靠近",
    更搞笑一点: "，而一个意料之外的误会正把紧张悄悄冲淡",
    增加悬念: "，而那条消息背后显然还藏着另一层真相",
    换一种男女主关系: "，而门外那个人与主角的关系或许并非表面那样",
    更接近日系轻小说: "，而日常与异常的边界正从这一刻开始松动",
  };
  return (
    commonDirections[direction] ??
    `，而“${direction.replaceAll(/[“”"]/gu, "").slice(0, 24)}”会从这一刻改变故事的走向`
  );
}

export function failedCreativeOpeningResult(
  runtime: object,
  requestId: string,
  cause: unknown,
): CreativeOpeningResult {
  const code = safeModelFailureCode(cause);
  recordSafeGenerationErrorCode(runtime, code);
  return Object.freeze({
    requestId,
    text: "",
    source: "local_fallback",
    completion: "complete",
    providerId: null,
    modelId: null,
    noticeCode: code,
    contextTraceId: null,
  });
}

function safeModelFailureCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return cause.code;
  }
  return "MODEL_GENERATION_FAILED";
}
