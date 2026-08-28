import type {
  NativeGatewayEndpointConfig,
  NativeModelDispatchScope,
  NativeGatewayProviderKind,
} from "./native-model-gateway-contract";

export type NativeEmbeddingEndpointConfig = NativeGatewayEndpointConfig;

export interface NativeEmbeddingInvocationDispatchLedger {
  readonly invocationId: string;
  readonly taskSnapshot: string;
  readonly expectedRevision: number;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly catalogEntryId: string;
  readonly catalogEntryRevision: number;
  readonly providerKindSnapshot: string;
  readonly modelIdSnapshot: string;
}

export interface NativeEmbeddingInvocationDispatchReceipt {
  readonly invocationId: string;
  readonly dispatchedAt: string;
  readonly revision: number;
}

export interface NativeEmbeddingInput {
  readonly config: NativeEmbeddingEndpointConfig;
  readonly model: string;
  readonly inputs: readonly string[];
  readonly dispatchScope: NativeModelDispatchScope;
  /**
   * Content-free SQLite fence written by the native gateway only after all
   * endpoint, provider, request, credential and privacy checks succeed.
   */
  readonly invocationDispatchLedger?: NativeEmbeddingInvocationDispatchLedger;
  /** Runs only after the native SQLite dispatch receipt is durable. */
  readonly onInvocationDispatchAccepted?: (
    receipt: NativeEmbeddingInvocationDispatchReceipt,
  ) => void | Promise<void>;
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
  /** True only when embedding dispatch is fenced by the native SQLite ledger. */
  readonly supportsNativeInvocationDispatchLedger?: true;
  embed(input: NativeEmbeddingInput): Promise<NativeEmbeddingResult>;
}
