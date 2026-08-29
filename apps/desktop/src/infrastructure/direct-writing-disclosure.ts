import type { PreparedGenerationPlan, DesktopRuntime } from "./runtime";
import type {
  RecordWritingProviderDisclosureGrantInput,
  WritingProviderDisclosureGrant,
} from "./writing-experience-store";
import { isLoopbackModelBaseUrl } from "./model-hub-provider-registry";

export interface DirectWritingDisclosure {
  readonly input: RecordWritingProviderDisclosureGrantInput;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly sentScopeLabel: string;
  readonly costLabel: string;
}

export async function projectDirectWritingDisclosure(
  runtime: Pick<DesktopRuntime, "hasher" | "modelHub">,
  plan: PreparedGenerationPlan,
): Promise<DirectWritingDisclosure | null> {
  if (
    plan.executionMode === "local_demo" ||
    plan.modelHubInspection?.dataDestination === "local" ||
    (plan.executionMode === "legacy_profile" &&
      plan.legacyGatewayConfig?.provider === "ollama" &&
      isLoopbackModelBaseUrl(plan.legacyGatewayConfig.baseUrl))
  ) {
    return null;
  }

  const selectedSourceKinds = Object.freeze(
    Array.from(
      new Set(
        (plan.contextCompilation?.compiled.entries ?? [])
          .filter(({ included }) => included)
          .flatMap(({ evidence }) => evidence.map(({ sourceType }) => sourceType)),
      ),
    ).sort(),
  );
  const sentScope =
    selectedSourceKinds.length === 0 ? "chapter_text" : "chapter_and_selected_context";
  const sentScopeLabel = sentScope === "chapter_text" ? "当前章节" : "当前章节和本次选中的必要设定";
  const scopeDigest = await runtime.hasher.sha256(
    JSON.stringify({ version: 1, sentScope, selectedSourceKinds }),
  );
  if (!scopeDigest.ok) throw scopeDigest.error;

  let providerLabel = plan.providerId;
  if (plan.modelHubInspection !== null) {
    const connection = await runtime.modelHub.findConnection(plan.modelHubInspection.connectionId);
    if (!connection?.enabled) {
      throw new Error("当前模型连接已经变化，请重新检查后再继续写。");
    }
    providerLabel = connection.displayName;
  }

  const estimate = plan.preflight.estimate;
  const costStatus = estimate === null ? "unknown" : "estimated";
  const estimatedCostMicros = estimate === null ? null : estimate.micros.toString();
  const currency = estimate?.currency ?? null;
  const fingerprintAuthority = Object.freeze({
    version: 1,
    task: "continuation" as const,
    providerId: plan.providerId,
    modelId: plan.modelId,
    sentScope,
    sentScopeHash: scopeDigest.value,
    callCount: 1,
    // Direct continuation is one user-authorized Provider POST. Connection
    // discovery retry settings never widen this generation authority.
    retryLimit: 0,
    costStatus,
    estimatedCostMicros,
    currency,
    privacyPolicy: "cloud_allowed" as const,
  });
  const fingerprint = await runtime.hasher.sha256(JSON.stringify(fingerprintAuthority));
  if (!fingerprint.ok) throw fingerprint.error;

  return Object.freeze({
    input: Object.freeze({
      ...fingerprintAuthority,
      estimatedCostMicros,
      fingerprint: fingerprint.value,
    }),
    providerLabel,
    modelLabel: plan.modelId,
    sentScopeLabel,
    costLabel:
      estimate === null
        ? "服务商没有提供可计算的单价，实际费用请以服务商账单为准。"
        : `预计 ${formatMicros(estimate.micros, estimate.currency)}（以供应商账单为准）`,
  });
}

export function disclosureGrantMatches(
  disclosure: DirectWritingDisclosure,
  grant: WritingProviderDisclosureGrant | null,
): boolean {
  return (
    grant !== null &&
    grant.state === "active" &&
    grant.fingerprint === disclosure.input.fingerprint &&
    grant.providerId === disclosure.input.providerId &&
    grant.modelId === disclosure.input.modelId &&
    grant.sentScope === disclosure.input.sentScope &&
    grant.sentScopeHash === disclosure.input.sentScopeHash &&
    grant.callCount === disclosure.input.callCount &&
    grant.retryLimit === disclosure.input.retryLimit &&
    grant.costStatus === disclosure.input.costStatus &&
    grant.estimatedCostMicros === disclosure.input.estimatedCostMicros &&
    grant.currency === disclosure.input.currency
  );
}

function formatMicros(micros: bigint, currency: string): string {
  const amount = Number(micros) / 1_000_000;
  if (!Number.isFinite(amount)) return `${micros.toString()} 微单位 ${currency}`;
  return `${amount.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} ${currency}`;
}
