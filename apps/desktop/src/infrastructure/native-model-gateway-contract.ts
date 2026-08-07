/**
 * Protocols implemented by the native desktop model gateway.
 *
 * This is deliberately separate from the legacy model profile provider type:
 * persisted model profiles still support only OpenAI-compatible endpoints and
 * Ollama until their data model is migrated explicitly.
 */
export type NativeGatewayProviderKind = "open_ai_compatible" | "ollama" | "anthropic" | "gemini";

export type NativeGatewayAuthenticationMode = "none" | "bearer_keyring" | "custom_header_keyring";

export interface NativeGatewayEndpointConfig {
  readonly providerId: string;
  readonly provider: NativeGatewayProviderKind;
  readonly baseUrl: string;
  readonly authentication: NativeGatewayAuthenticationMode;
  /** Custom OpenAI-compatible only. Values are absolute paths, never URLs. */
  readonly modelDiscoveryPath?: string | null;
  readonly textGenerationPath?: string | null;
  readonly embeddingPath?: string | null;
  /** Non-secret metadata. The Header value is loaded from the OS credential vault. */
  readonly credentialHeaderName?: string | null;
  readonly requestTimeoutMs?: number;
  /** Applied only to idempotent connection/catalog GET requests. */
  readonly retryLimit?: number;
}

export function isNativeGatewayProviderKind(value: unknown): value is NativeGatewayProviderKind {
  return (
    value === "open_ai_compatible" ||
    value === "ollama" ||
    value === "anthropic" ||
    value === "gemini"
  );
}
