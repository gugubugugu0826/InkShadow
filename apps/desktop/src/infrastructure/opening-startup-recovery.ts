import type { DesktopRuntime } from "./runtime";

export interface OpeningStartupRecoveryReceipt {
  readonly inspectedJourneyCount: number;
  readonly inspectedInvocationCount: number;
  readonly terminalizedInvocationCount: number;
  readonly failedInvocationCount: number;
}

/**
 * Inspects only already-persisted opening invocations during desktop startup.
 * The journey page later projects missing or terminal facts into its stable
 * slots while preserving queued/running facts. This never creates, finishes,
 * or dispatches an invocation and never calls the gateway.
 */
export async function recoverOrphanedOpeningInvocationsAtStartup(
  runtime: DesktopRuntime,
): Promise<OpeningStartupRecoveryReceipt> {
  const journeys = await runtime.creativeJourneys.listActive("idea");
  const invocationIds = new Set<string>();
  let inspectedJourneyCount = 0;
  for (const journey of journeys) {
    const ids = recoverableProviderInvocationIds(journey.snapshot);
    if (ids.length === 0) continue;
    inspectedJourneyCount += 1;
    ids.forEach((id) => invocationIds.add(id));
  }

  const terminalizedInvocationCount = 0;
  let failedInvocationCount = 0;
  for (const invocationId of invocationIds) {
    try {
      await runtime.modelHub.findInvocation(invocationId);
    } catch {
      failedInvocationCount += 1;
    }
  }

  return Object.freeze({
    inspectedJourneyCount,
    inspectedInvocationCount: invocationIds.size,
    terminalizedInvocationCount,
    failedInvocationCount,
  });
}

function recoverableProviderInvocationIds(
  snapshot: Readonly<Record<string, unknown>>,
): readonly string[] {
  const suggestionsValue: unknown = snapshot.openingSuggestions;
  if (snapshot.openingGenerationMode !== "provider" || !Array.isArray(suggestionsValue)) {
    return Object.freeze([]);
  }
  const invocationIds: string[] = [];
  for (const candidateValue of suggestionsValue as readonly unknown[]) {
    if (typeof candidateValue !== "object" || candidateValue === null) continue;
    const candidate = candidateValue as Readonly<Record<string, unknown>>;
    const requiresRecovery =
      candidate.status === "pending" ||
      candidate.dispatchState === "planned" ||
      candidate.dispatchState === "dispatched";
    const explicitInvocationId =
      typeof candidate.providerInvocationId === "string" ? candidate.providerInvocationId : null;
    const legacyPendingInvocationId =
      candidate.source === "provider" &&
      candidate.status === "pending" &&
      typeof candidate.id === "string"
        ? candidate.id
        : null;
    const invocationId = requiresRecovery
      ? (explicitInvocationId ?? legacyPendingInvocationId)
      : null;
    if (invocationId !== null && /^[A-Za-z0-9._:-]{1,128}$/u.test(invocationId)) {
      invocationIds.push(invocationId);
    }
  }
  return Object.freeze(invocationIds);
}
