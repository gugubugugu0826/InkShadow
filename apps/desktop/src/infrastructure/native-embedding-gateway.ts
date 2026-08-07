import type {
  NativeGatewayEndpointConfig,
  NativeGatewayProviderKind,
} from "./native-model-gateway-contract";

export type NativeEmbeddingEndpointConfig = NativeGatewayEndpointConfig;

export interface NativeEmbeddingInput {
  readonly config: NativeEmbeddingEndpointConfig;
  readonly model: string;
  readonly inputs: readonly string[];
}

export interface NativeEmbeddingResult {
  readonly provider: NativeGatewayProviderKind;
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
