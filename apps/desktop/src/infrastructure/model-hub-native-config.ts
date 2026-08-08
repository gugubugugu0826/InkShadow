import { getModelProviderPreset } from "./model-hub-provider-registry";
import type { ModelProviderConnection } from "./model-hub-store";
import type { NativeGatewayEndpointConfig } from "./native-model-gateway-contract";

const OWNED_CREDENTIAL_PREFIX = "keyring:model-hub:";
const LEGACY_CREDENTIAL_PREFIX = "keyring:legacy-model-profile:";

export class ModelHubCredentialReferenceError extends Error {
  public readonly code = "MODEL_HUB_CREDENTIAL_REFERENCE_INVALID";
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = "ModelHubCredentialReferenceError";
  }
}

export function modelHubCredentialProviderId(connection: ModelProviderConnection): string {
  if (connection.authenticationMode === "none") {
    return requireCredentialProviderId(connection.id);
  }
  if (connection.credentialState !== "present" || connection.credentialRef === null) {
    throw new ModelHubCredentialReferenceError(
      "The enabled keyring connection does not have a present credential reference.",
    );
  }
  for (const prefix of [OWNED_CREDENTIAL_PREFIX, LEGACY_CREDENTIAL_PREFIX]) {
    if (connection.credentialRef.startsWith(prefix)) {
      return requireCredentialProviderId(connection.credentialRef.slice(prefix.length));
    }
  }
  throw new ModelHubCredentialReferenceError(
    "The credential reference is not an InkShadow-owned keyring reference.",
  );
}

export function modelHubCredentialRef(providerId: string): string {
  return `${OWNED_CREDENTIAL_PREFIX}${requireCredentialProviderId(providerId)}`;
}

/**
 * Builds the only native endpoint contract used by Model Hub operations.
 * Custom paths and Header-name metadata are forwarded only for the custom
 * OpenAI-compatible provider; named provider presets retain their official
 * endpoints and authentication behavior.
 */
export function modelHubNativeEndpointConfig(
  connection: ModelProviderConnection,
): NativeGatewayEndpointConfig {
  const protocol = getModelProviderPreset(connection.providerKind).protocol;
  const custom = connection.providerKind === "custom_openai_compatible";
  return Object.freeze({
    providerId: modelHubCredentialProviderId(connection),
    provider: protocol === "openai_compatible" ? "open_ai_compatible" : protocol,
    baseUrl: connection.baseUrl,
    authentication: connection.authenticationMode,
    requestTimeoutMs: connection.requestTimeoutMs,
    retryLimit: connection.retryLimit,
    ...(custom
      ? {
          modelDiscoveryPath: connection.modelDiscoveryPath,
          textGenerationPath: connection.textGenerationPath,
          embeddingPath: connection.embeddingPath,
          credentialHeaderName: connection.credentialHeaderName,
        }
      : {}),
  });
}

function requireCredentialProviderId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new ModelHubCredentialReferenceError("The credential provider identifier is invalid.");
  }
  return value;
}
