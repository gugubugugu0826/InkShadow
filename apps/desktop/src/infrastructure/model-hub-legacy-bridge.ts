import type { Clock } from "@inkshadow/domain";

import type { ModelCenterStore, ModelProfile } from "./model-center-store";
import { MODEL_HUB_CAPABILITIES, isLoopbackModelBaseUrl } from "./model-hub-provider-registry";
import type { ModelCatalogEntry, ModelHubStore, ModelProviderConnection } from "./model-hub-store";

export interface LegacyCredentialSummaryReader {
  getSummary(providerId: string): Promise<Readonly<{ configured: boolean }>>;
}

export interface LegacyModelHubBridgeResult {
  readonly connectionCount: number;
  readonly catalogEntryCount: number;
  readonly skippedNonLegacyConnectionCount: number;
}

/**
 * Imports legacy model profiles without changing or deleting the legacy records.
 *
 * Keeping the same connection id is intentional: the native credential command
 * resolves secrets by the old provider id, so no key is copied, read, or entered
 * again. Existing non-legacy Model Hub connections always win and are not
 * downgraded by this compatibility bridge.
 */
export async function bridgeLegacyModelProfilesToModelHub(
  input: Readonly<{
    modelCenter: Pick<ModelCenterStore, "listProfiles">;
    modelHub: ModelHubStore;
    credentials: LegacyCredentialSummaryReader;
    clock: Clock;
  }>,
): Promise<LegacyModelHubBridgeResult> {
  const profiles = await input.modelCenter.listProfiles();
  let connectionCount = 0;
  let catalogEntryCount = 0;
  let skippedNonLegacyConnectionCount = 0;

  for (const profile of profiles) {
    const existing = await input.modelHub.findConnection(profile.providerId);
    if (existing !== null && existing.legacyProviderId !== profile.providerId) {
      skippedNonLegacyConnectionCount += 1;
      continue;
    }
    const connection =
      existing ?? (await createLegacyConnection(input.modelHub, input.credentials, profile));
    connectionCount += 1;
    const selectedModel = profile.selectedModel;
    if (selectedModel === null) {
      continue;
    }
    const catalogEntry = await ensureLegacyCatalogEntry(
      input.modelHub,
      input.clock,
      connection,
      profile,
      selectedModel,
    );
    catalogEntryCount += 1;
    await ensureLegacyCapabilityEvidence(input.modelHub, input.clock, catalogEntry);
    await ensureLegacyCostPrivacyProfile(input.modelHub, profile, catalogEntry);
  }

  return Object.freeze({ connectionCount, catalogEntryCount, skippedNonLegacyConnectionCount });
}

async function createLegacyConnection(
  modelHub: ModelHubStore,
  credentials: LegacyCredentialSummaryReader,
  profile: ModelProfile,
): Promise<ModelProviderConnection> {
  const credentialConfigured =
    profile.authentication === "bearer_keyring" &&
    (await credentials.getSummary(profile.providerId).catch(() => ({ configured: false })))
      .configured;
  return modelHub.saveConnection({
    id: profile.providerId,
    providerKind: profile.provider === "ollama" ? "ollama" : "custom_openai_compatible",
    displayName: profile.providerId,
    baseUrlOverride: profile.baseUrl,
    credentialRef: credentialConfigured
      ? `keyring:legacy-model-profile:${profile.providerId}`
      : null,
    credentialState: credentialConfigured ? "present" : "missing",
    legacyProviderId: profile.providerId,
    enabled: true,
    expectedRevision: null,
  });
}

async function ensureLegacyCatalogEntry(
  modelHub: ModelHubStore,
  clock: Clock,
  connection: ModelProviderConnection,
  profile: ModelProfile,
  selectedModel: string,
): Promise<ModelCatalogEntry> {
  const existing = (await modelHub.listCatalog(connection.id)).find(
    ({ providerModelId }) => providerModelId === selectedModel,
  );
  if (existing !== undefined) {
    return existing;
  }
  const syncId = `legacy-sync-${stableLegacySuffix(`${profile.providerId}\u0000${selectedModel}`)}`;
  const catalog = await modelHub.syncCatalog({
    syncId,
    connectionId: connection.id,
    source: "legacy",
    status: "succeeded",
    startedAt: clock.now(),
    models: [
      {
        id: `legacy-catalog-${stableLegacySuffix(`${profile.providerId}\u0000${selectedModel}`)}`,
        providerModelId: selectedModel,
        displayName: selectedModel,
        inputTokenLimit: profile.pricing?.contextWindowTokens ?? null,
      },
    ],
  });
  const saved = catalog.find(({ providerModelId }) => providerModelId === selectedModel);
  if (saved === undefined) {
    throw new Error("Legacy model catalog bridge did not persist the selected model.");
  }
  return saved;
}

async function ensureLegacyCapabilityEvidence(
  modelHub: ModelHubStore,
  clock: Clock,
  catalogEntry: ModelCatalogEntry,
): Promise<void> {
  if ((await modelHub.listCapabilityEvidence(catalogEntry.id)).length > 0) {
    return;
  }
  const suffix = stableLegacySuffix(catalogEntry.id);
  await modelHub.recordCapabilityScan({
    scanId: `legacy-capability-scan-${suffix}`,
    catalogEntryId: catalogEntry.id,
    scanKind: "provider_metadata",
    status: "succeeded",
    evidenceVersion: "legacy-profile-v1",
    requestedAt: clock.now(),
    evidence: MODEL_HUB_CAPABILITIES.map((capability) => ({
      id: `legacy-capability-${suffix}-${capability}`,
      capability,
      verdict: "unknown",
      evidenceSource: "legacy",
      evidenceSummary: "旧配置没有可验证的能力元数据，需重新测试或由用户确认。",
    })),
  });
}

async function ensureLegacyCostPrivacyProfile(
  modelHub: ModelHubStore,
  profile: ModelProfile,
  catalogEntry: ModelCatalogEntry,
): Promise<void> {
  if ((await modelHub.findCostPrivacyProfile(catalogEntry.id)) !== null) {
    return;
  }
  const local = isLoopbackModelBaseUrl(profile.baseUrl);
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: catalogEntry.id,
    currency: profile.pricing?.currency ?? null,
    inputMicrosPerMillionTokens:
      profile.pricing === null ? null : String(profile.pricing.inputMicrosPerMillionTokens),
    outputMicrosPerMillionTokens:
      profile.pricing === null ? null : String(profile.pricing.outputMicrosPerMillionTokens),
    cachedInputMicrosPerMillionTokens:
      profile.pricing?.cachedInputMicrosPerMillionTokens === null ||
      profile.pricing?.cachedInputMicrosPerMillionTokens === undefined
        ? null
        : String(profile.pricing.cachedInputMicrosPerMillionTokens),
    pricingVersion: profile.pricing?.pricingVersion ?? null,
    priceUpdatedAt: profile.pricing?.priceUpdatedAt ?? null,
    dataDestination: local ? "local" : "remote",
    retentionPolicy: local ? "none" : "provider_default",
    trainingPolicy: local ? "not_used" : "unknown",
    evidenceSource: "legacy",
    evidenceVersion: "legacy-profile-v1",
    evidenceSummary: local
      ? "从旧回环地址配置迁移；仍需连接测试确认模型当前可用。"
      : "从旧云端配置迁移；供应商的数据保留和训练政策仍需复核。",
    expectedRevision: null,
  });
}

function stableLegacySuffix(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash.toString(36);
}
