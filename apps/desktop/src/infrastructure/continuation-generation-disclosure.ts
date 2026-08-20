import {
  inspectModelHubTextTask,
  type InspectModelHubTextTaskInput,
  type ModelHubTextTaskInspection,
} from "./model-hub-execution-service";
import { ModelCenterError } from "./model-center-store";
import {
  assertModelHubInspectionAuthority,
  modelHubInspectionAuthority,
  providerActionFingerprint,
  providerConnectionDisplayName,
  type ProviderActionDisclosure,
} from "./provider-action-disclosure";
import { projectContextRequiredDataDestination } from "./project-context-privacy-authority";
import type { DesktopRuntime, PreparedGenerationPlan } from "./runtime";

export interface ContinuationGenerationDisclosure extends ProviderActionDisclosure {
  readonly maximumProviderCalls: 1;
  readonly automaticRetryCount: 0;
  readonly sentScopeLabel: string;
}

/**
 * Resolves the exact continuation Provider authority without dispatching. The
 * returned fingerprint binds the model route, pricing, privacy receipt, saved
 * source version, output contract and complete message payload. Local demo
 * generation has no Provider boundary and therefore returns null.
 */
export async function prepareContinuationGenerationDisclosure(
  runtime: DesktopRuntime,
  plan: PreparedGenerationPlan,
): Promise<ContinuationGenerationDisclosure | null> {
  if (plan.executionMode === "local_demo") return null;
  if (
    plan.executionMode !== "model_hub" ||
    plan.modelHubInspection === null ||
    plan.contextCompilation === null ||
    plan.projectId === null ||
    plan.baseVersionId === null
  ) {
    throw disclosureChanged();
  }

  const request = continuationInspectionRequest(plan);
  const inspection = await inspectModelHubTextTask(runtime, request);
  try {
    assertModelHubInspectionAuthority(plan.modelHubInspection, inspection);
  } catch {
    throw disclosureChanged();
  }

  let connectionDisplayName: string;
  try {
    connectionDisplayName = await providerConnectionDisplayName(runtime.modelHub, inspection);
  } catch {
    throw disclosureChanged();
  }

  const selectedSourceKinds = Object.freeze(
    Array.from(
      new Set(
        plan.contextCompilation.compiled.entries
          .filter(({ included }) => included)
          .flatMap(({ evidence }) => evidence.map(({ sourceType }) => sourceType)),
      ),
    ).sort(),
  );
  const sentScopeLabel =
    selectedSourceKinds.length === 0 ? "当前章节" : "当前章节和本次明确选中的故事资料";
  const fingerprint = await providerActionFingerprint({
    action: "continuation",
    projectId: plan.projectId,
    chapterId: plan.chapterId,
    baseVersionId: plan.baseVersionId,
    applicationCursorUtf16: plan.applicationCursorUtf16,
    partialCandidateId: plan.partialCandidateId,
    outputContract: plan.outputContract,
    contextBudget: plan.contextBudget,
    privacyFingerprint: plan.contextCompilation.projectPrivacy.fingerprint,
    selectedSourceKinds,
    inspection: modelHubInspectionAuthority(inspection),
    messages: plan.messages,
    maximumProviderCalls: 1,
    automaticRetryCount: 0,
    connectionDisplayName,
  });
  const estimatedMaximumCostMicros = inspection.pricing.estimatedMaximumCostMicros;
  return Object.freeze({
    fingerprint,
    connectionDisplayName,
    modelId: inspection.modelId,
    dataDestination: inspection.dataDestination,
    privacy:
      inspection.dataDestination === "local"
        ? "正文和本次选中的故事资料只发送给当前已验证的本机模型。"
        : "正文、续写要求和本次选中的故事资料会发送到所选 AI 服务。",
    sends: Object.freeze([
      sentScopeLabel,
      "本次续写长度与收束要求",
      "上下文编译明确列出的必要故事资料",
    ]),
    maximumProviderCalls: 1 as const,
    automaticRetryCount: 0 as const,
    estimatedMaximumCostMicros,
    currency: estimatedMaximumCostMicros === null ? null : inspection.pricing.currency,
    sentScopeLabel,
  });
}

export function assertContinuationDisclosureMatches(
  expected: ContinuationGenerationDisclosure | null,
  actual: ContinuationGenerationDisclosure | null,
): void {
  if (expected?.fingerprint !== actual?.fingerprint) throw disclosureChanged();
}

export function continuationInspectionRequest(
  plan: PreparedGenerationPlan,
): InspectModelHubTextTaskInput {
  if (plan.contextCompilation === null) throw disclosureChanged();
  const requiredDataDestination = projectContextRequiredDataDestination(
    plan.contextCompilation.projectPrivacy,
  );
  return Object.freeze({
    task: "continuation",
    messages: plan.messages,
    maximumOutputTokens: plan.maximumOutputTokens,
    temperature: 0.8,
    ...(requiredDataDestination === undefined ? {} : { requiredDataDestination }),
  });
}

export function assertPreparedContinuationInspectionCurrent(
  plan: PreparedGenerationPlan,
  actual: ModelHubTextTaskInspection,
): void {
  if (plan.modelHubInspection === null) throw disclosureChanged();
  try {
    assertModelHubInspectionAuthority(plan.modelHubInspection, actual);
  } catch {
    throw disclosureChanged();
  }
}

function disclosureChanged(): ModelCenterError {
  return new ModelCenterError(
    "CONTINUATION_DISCLOSURE_CHANGED",
    "模型、发送范围、费用、隐私或正文版本已经变化；本次没有发送，请重新查看生成前检查。",
    true,
  );
}
