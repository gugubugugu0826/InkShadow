import type { ModelProfile, ModelCenterStore } from "./model-center-store";
import {
  ModelHubCredentialReferenceError,
  modelHubNativeEndpointConfig,
} from "./model-hub-native-config";
import type { ModelHubStore, ModelProviderConnection } from "./model-hub-store";
import type { NativeGatewayEndpointConfig } from "./native-model-gateway-contract";

export interface ModelProfileGatewayConfigResolution {
  /** Stable user-facing provider identity used by routes and audit receipts. */
  readonly logicalProviderId: string;
  /** Endpoint config whose providerId points at the current OS-vault slot. */
  readonly config: NativeGatewayEndpointConfig;
  readonly connection: ModelProviderConnection | null;
  readonly source: "model_hub" | "legacy_profile";
}

export interface ModelProfileGatewayConfigDependencies {
  readonly modelHub: Pick<ModelHubStore, "findConnection">;
  readonly credentials: Readonly<{
    getSummary(providerId: string): Promise<Readonly<{ configured: boolean }>>;
  }>;
}

export interface FinalModelProfileDispatchDependencies extends ModelProfileGatewayConfigDependencies {
  readonly modelCenter: Pick<ModelCenterStore, "findByProviderId">;
}

export class FinalModelProfileDispatchError extends Error {
  public readonly code = "MODEL_CONFIGURATION_CHANGED_BEFORE_DISPATCH";
  public readonly retryable = true;

  public constructor() {
    super(
      "The model profile, connection, credential, endpoint, or selected model changed before dispatch.",
    );
    this.name = "FinalModelProfileDispatchError";
  }
}

/**
 * Resolves a legacy Model Center profile through the current Model Hub
 * connection before any native request is dispatched.
 *
 * Model Center routes intentionally keep their stable logical provider id,
 * while a Model Hub key rotation moves the actual secret to a versioned vault
 * slot. Native gateway calls must therefore use this result's config instead
 * of treating profile.providerId as the vault account. A disabled/retired or
 * malformed Model Hub connection is authoritative and fails closed; it must
 * never fall back to a stale legacy key with the same logical id.
 */
export async function resolveModelProfileGatewayConfig(
  dependencies: ModelProfileGatewayConfigDependencies,
  profile: ModelProfile,
): Promise<ModelProfileGatewayConfigResolution | null> {
  const connection = await dependencies.modelHub.findConnection(profile.providerId);
  let config: NativeGatewayEndpointConfig;
  let source: ModelProfileGatewayConfigResolution["source"];

  if (connection !== null) {
    if (!connection.enabled) return null;
    try {
      config = modelHubNativeEndpointConfig(connection);
    } catch (cause: unknown) {
      if (cause instanceof ModelHubCredentialReferenceError) return null;
      throw cause;
    }
    if (!gatewayProtocolsAreCompatible(profile, config)) return null;
    source = "model_hub";
  } else {
    config = Object.freeze({
      providerId: profile.providerId,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      authentication: profile.authentication,
    });
    source = "legacy_profile";
  }

  if (config.authentication !== "none") {
    const configured = await dependencies.credentials
      .getSummary(config.providerId)
      .then((summary) => summary.configured)
      .catch(() => false);
    if (!configured) return null;
  }

  return Object.freeze({
    logicalProviderId: profile.providerId,
    config,
    connection,
    source,
  });
}

/**
 * Re-reads both authoritative stores after the caller's final asynchronous
 * privacy/lease/callback boundary. A previously captured endpoint is never
 * sufficient because key rotation intentionally leaves an old vault slot
 * behind while cleanup is pending.
 */
export async function resolveFinalModelProfileGatewayConfig(
  dependencies: FinalModelProfileDispatchDependencies,
  expectedProfile: ModelProfile,
  expectedResolution: ModelProfileGatewayConfigResolution,
): Promise<Readonly<{ profile: ModelProfile; resolution: ModelProfileGatewayConfigResolution }>> {
  const profile = await dependencies.modelCenter.findByProviderId(expectedProfile.providerId);
  const resolution =
    profile === null ? null : await resolveModelProfileGatewayConfig(dependencies, profile);
  if (
    profile === null ||
    resolution === null ||
    finalProfileDispatchIdentity(profile, resolution) !==
      finalProfileDispatchIdentity(expectedProfile, expectedResolution)
  ) {
    throw new FinalModelProfileDispatchError();
  }
  return Object.freeze({ profile, resolution });
}

export function nativeGatewayEndpointIdentity(config: NativeGatewayEndpointConfig): string {
  return JSON.stringify([
    config.providerId,
    config.provider,
    config.baseUrl,
    config.authentication,
    config.credentialHeaderName ?? null,
    config.modelDiscoveryPath ?? null,
    config.textGenerationPath ?? null,
    config.embeddingPath ?? null,
    config.requestTimeoutMs ?? null,
    config.retryLimit ?? null,
  ]);
}

/** Clears a stale legacy selection after the corresponding Model Hub key is removed. */
export async function clearLegacyModelProfileSelection(
  modelCenter: Pick<ModelCenterStore, "findByProviderId" | "save">,
  providerId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const profile = await modelCenter.findByProviderId(providerId);
    if (profile?.selectedModel == null) return;
    try {
      await modelCenter.save({
        providerId: profile.providerId,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        authentication: profile.authentication,
        selectedModel: null,
        pricing: null,
        expectedRevision: profile.revision,
      });
      return;
    } catch (cause: unknown) {
      if (attempt === 1) throw cause;
    }
  }
}

function gatewayProtocolsAreCompatible(
  profile: ModelProfile,
  config: NativeGatewayEndpointConfig,
): boolean {
  return (
    (profile.provider === "ollama" && config.provider === "ollama") ||
    (profile.provider === "open_ai_compatible" && config.provider === "open_ai_compatible")
  );
}

function finalProfileDispatchIdentity(
  profile: ModelProfile,
  resolution: ModelProfileGatewayConfigResolution,
): string {
  const connection = resolution.connection;
  const config = resolution.config;
  return JSON.stringify([
    profile.providerId,
    profile.revision,
    profile.provider,
    profile.baseUrl,
    profile.authentication,
    profile.selectedModel,
    resolution.logicalProviderId,
    resolution.source,
    connection?.id ?? null,
    connection?.revision ?? null,
    connection?.enabled ?? null,
    connection?.credentialRef ?? null,
    connection?.credentialState ?? null,
    nativeGatewayEndpointIdentity(config),
  ]);
}
