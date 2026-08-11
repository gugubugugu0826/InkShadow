/**
 * Protocols implemented by the native desktop model gateway.
 *
 * This is deliberately separate from the legacy model profile provider type:
 * persisted model profiles still support only OpenAI-compatible endpoints and
 * Ollama until their data model is migrated explicitly.
 */
export type NativeGatewayProviderKind = "open_ai_compatible" | "ollama" | "anthropic" | "gemini";

export type NativeGatewayAuthenticationMode = "none" | "bearer_keyring" | "custom_header_keyring";

export interface NativeProjectContextChapterAuthority {
  readonly chapterId: string;
  readonly currentVersionId: string;
  readonly revision: number;
  readonly privacyRevision: number;
  readonly privacyMode: "standard" | "local_only";
  readonly status: "active" | "trashed";
}

export interface NativeProjectContextPrivacyReceipt {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly activeChapterCount: number;
  readonly retainedChapterCount: number;
  readonly requiresVerifiedLocal: boolean;
  readonly chapters: readonly NativeProjectContextChapterAuthority[];
}

export type NativeModelDispatchScope =
  | Readonly<{
      kind: "non_project";
      reason: "creative_opening" | "connection_probe" | "novel_skill_evaluation";
    }>
  | Readonly<{
      kind: "project_context";
      receipt: NativeProjectContextPrivacyReceipt;
    }>;

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

/** Native generation accepts the provider-neutral nucleus sampling range only. */
export function isNativeGenerationTopP(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isNativeGatewayProviderKind(value: unknown): value is NativeGatewayProviderKind {
  return (
    value === "open_ai_compatible" ||
    value === "ollama" ||
    value === "anthropic" ||
    value === "gemini"
  );
}
