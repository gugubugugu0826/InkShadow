import type {
  ModelHubTextTaskInspection,
  ModelHubTextDispatchSelection,
} from "./model-hub-execution-service";
import type { ModelHubStore } from "./model-hub-store";

export interface ProviderActionDisclosure {
  readonly fingerprint: string;
  readonly connectionDisplayName: string;
  readonly modelId: string;
  readonly dataDestination: "local" | "remote";
  readonly privacy: string;
  readonly sends: readonly string[];
  readonly maximumProviderCalls: number;
  readonly automaticRetryCount: 0;
  readonly estimatedMaximumCostMicros: string | null;
  readonly currency: string | null;
}

/**
 * Returns the ordinary-user name for a locked route without exposing internal
 * connection identifiers or provider protocol kinds.
 */
export async function providerConnectionDisplayName(
  modelHub: Pick<ModelHubStore, "findConnection">,
  inspection: ModelHubTextTaskInspection,
): Promise<string> {
  const connection = await modelHub.findConnection(inspection.connectionId);
  if (connection?.id !== inspection.connectionId) {
    throw new Error("MODEL_HUB_DISCLOSURE_TARGET_UNAVAILABLE");
  }
  return connection.displayName;
}

export function modelHubInspectionAuthority(
  inspection: ModelHubTextTaskInspection,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    task: inspection.task,
    configuredPrimaryCatalogEntryId: inspection.configuredPrimaryCatalogEntryId,
    configuredFallbackCatalogEntryId: inspection.configuredFallbackCatalogEntryId,
    selectionKind: inspection.selectionKind,
    usedFallback: inspection.usedFallback,
    attempt: inspection.attempt,
    connectionId: inspection.connectionId,
    catalogEntryId: inspection.catalogEntryId,
    providerKind: inspection.providerKind,
    modelId: inspection.modelId,
    dataDestination: inspection.dataDestination,
    privacyPolicy: inspection.privacyPolicy,
    failurePolicy: inspection.failurePolicy,
    maximumOutputTokens: inspection.maximumOutputTokens,
    temperature: inspection.temperature,
    estimatedInputTokens: inspection.estimatedInputTokens,
    estimatedTotalTokens: inspection.estimatedTotalTokens,
    inputTokenLimit: inspection.inputTokenLimit,
    outputTokenLimit: inspection.outputTokenLimit,
    tokenLimitEvidence: inspection.tokenLimitEvidence,
    pricing: inspection.pricing,
  });
}

export function assertModelHubInspectionAuthority(
  expected: ModelHubTextTaskInspection,
  actual: ModelHubTextTaskInspection,
): void {
  if (
    canonicalJson(modelHubInspectionAuthority(expected)) !==
    canonicalJson(modelHubInspectionAuthority(actual))
  ) {
    throw new Error("MODEL_HUB_DISCLOSURE_CHANGED");
  }
}

export function assertDisclosedSelection(
  inspection: ModelHubTextTaskInspection,
  selection: Pick<
    ModelHubTextDispatchSelection,
    "connectionId" | "catalogEntryId" | "modelId" | "usedFallback"
  >,
): void {
  if (
    inspection.connectionId !== selection.connectionId ||
    inspection.catalogEntryId !== selection.catalogEntryId ||
    inspection.modelId !== selection.modelId ||
    inspection.usedFallback !== selection.usedFallback
  ) {
    throw new Error("MODEL_HUB_DISCLOSURE_CHANGED");
  }
}

export async function providerActionFingerprint(authority: unknown): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `inkshadow/provider-action-disclosure/v1\u0000${canonicalJson(authority)}`,
      ),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function totalDisclosedCost(
  inspections: readonly ModelHubTextTaskInspection[],
): Readonly<{ estimatedMaximumCostMicros: string | null; currency: string | null }> {
  const costs = inspections.map(({ pricing }) => ({
    micros: pricing.estimatedMaximumCostMicros,
    currency: pricing.currency,
  }));
  const currency = costs[0]?.currency ?? null;
  if (
    costs.length === 0 ||
    currency === null ||
    costs.some(({ micros, currency: itemCurrency }) => micros === null || itemCurrency !== currency)
  ) {
    return Object.freeze({ estimatedMaximumCostMicros: null, currency: null });
  }
  return Object.freeze({
    estimatedMaximumCostMicros: costs
      .reduce((sum, { micros }) => sum + BigInt(micros ?? "0"), 0n)
      .toString(),
    currency,
  });
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
