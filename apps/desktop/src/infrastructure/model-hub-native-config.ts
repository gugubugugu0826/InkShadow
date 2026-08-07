import { getModelProviderPreset } from "./model-hub-provider-registry";
import type { ModelProviderConnection } from "./model-hub-store";
import type { NativeGatewayEndpointConfig } from "./native-model-gateway-contract";

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
    providerId: connection.id,
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
