import type {
  NativeGatewayAuthenticationMode,
  NativeGatewayProviderKind,
} from "./native-model-gateway-contract";

export type NativeRerankProtocol = "qwen_open_ai_compatible";

export interface NativeRerankEndpointConfig {
  readonly providerId: string;
  readonly provider: NativeGatewayProviderKind;
  readonly baseUrl: string;
  readonly authentication: NativeGatewayAuthenticationMode;
}

export interface NativeRerankInput {
  readonly config: NativeRerankEndpointConfig;
  readonly protocol: NativeRerankProtocol;
  readonly model: string;
  readonly query: string;
  readonly documents: readonly string[];
  readonly topN: number;
}

export interface NativeRerankScore {
  readonly index: number;
  readonly relevanceScore: number;
}

export interface NativeRerankResult {
  readonly provider: NativeGatewayProviderKind;
  readonly protocol: NativeRerankProtocol;
  readonly endpointOrigin: string;
  readonly model: string;
  readonly rankings: readonly NativeRerankScore[];
  readonly inputTokens: number | null;
}

export interface NativeRerankGatewayClient {
  readonly available: boolean;
  rerank(input: NativeRerankInput): Promise<NativeRerankResult>;
}
