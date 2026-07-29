export type ModelTask =
  | "fast"
  | "high_quality"
  | "long_context"
  | "embedding"
  | "validation"
  | "translation"
  | "local_private";

export interface ModelConfig {
  readonly providerId: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly credentialRef?: string;
  readonly timeoutMs: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly tasks: readonly ModelTask[];
  readonly contextWindow: number;
  readonly supportsStreaming: boolean;
  readonly supportsEmbedding: boolean;
  readonly dataDestination: "local" | "provider";
}

export interface ModelHealthResult {
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly checkedAt: string;
  readonly latencyMs?: number;
  readonly errorCode?: string;
}

export interface PromptSection {
  readonly kind:
    | "instruction"
    | "project_rule"
    | "chapter"
    | "character"
    | "world"
    | "foreshadow"
    | "material"
    | "user_input";
  readonly text: string;
  readonly sourceId?: string;
  readonly inclusion: "user" | "pinned" | "retrieved" | "required";
}

export interface GenerateRequest {
  readonly taskId: string;
  readonly projectId: string;
  readonly chapterId?: string;
  readonly modelId: string;
  readonly sections: readonly PromptSection[];
  readonly maximumOutputTokens: number;
  readonly temperature?: number;
}

export type GenerateEvent =
  | {
      readonly type: "started";
      readonly sequence: number;
    }
  | {
      readonly type: "context";
      readonly sequence: number;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly type: "delta";
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: "validation";
      readonly sequence: number;
      readonly passed: boolean;
      readonly codes: readonly string[];
    }
  | {
      readonly type: "candidate_ready";
      readonly sequence: number;
      readonly candidateId: string;
    }
  | {
      readonly type: "completed";
      readonly sequence: number;
    }
  | {
      readonly type: "failed";
      readonly sequence: number;
      readonly errorCode: string;
      readonly retryable: boolean;
    }
  | {
      readonly type: "cancelled";
      readonly sequence: number;
    }
  | {
      readonly type: "heartbeat";
      readonly sequence: number;
    };

export interface EmbedRequest {
  readonly modelId: string;
  readonly inputs: readonly string[];
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly dimensions: number;
}

export interface TokenCountInput {
  readonly modelId: string;
  readonly sections: readonly PromptSection[];
}

export interface TokenCountResult {
  readonly inputTokens: number;
}

export interface ModelAdapter {
  readonly providerId: string;
  listModels(config: ModelConfig): Promise<readonly ModelInfo[]>;
  healthCheck(config: ModelConfig): Promise<ModelHealthResult>;
  generate(config: ModelConfig, request: GenerateRequest): AsyncIterable<GenerateEvent>;
  embed?(config: ModelConfig, request: EmbedRequest): Promise<EmbeddingResult>;
  countTokens?(config: ModelConfig, input: TokenCountInput): Promise<TokenCountResult>;
}

/**
 * Desktop/native code implements this boundary. This package intentionally
 * contains no network transport and no credential store implementation.
 */
export interface NativeModelGateway {
  readonly kind: "native";
  listProviderIds(): Promise<readonly string[]>;
  resolveAdapter(providerId: string): Promise<ModelAdapter | undefined>;
}
