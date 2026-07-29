import type { NativeAuthenticationMode, NativeProviderKind } from "./model-center-store";

export interface NativeEmbeddingEndpointConfig {
  readonly providerId: string;
  readonly provider: NativeProviderKind;
  readonly baseUrl: string;
  readonly authentication: NativeAuthenticationMode;
}

export interface NativeEmbeddingInput {
  readonly config: NativeEmbeddingEndpointConfig;
  readonly model: string;
  readonly inputs: readonly string[];
}

export interface NativeEmbeddingResult {
  readonly provider: NativeProviderKind;
  readonly endpointOrigin: string;
  readonly model: string;
  readonly dimension: number;
  readonly vectorCount: number;
  readonly embeddings: readonly (readonly number[])[];
}

export interface NativeEmbeddingGatewayClient {
  readonly available: boolean;
  embed(input: NativeEmbeddingInput): Promise<NativeEmbeddingResult>;
}
