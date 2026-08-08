import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import {
  executeModelHubTextTask,
  type ModelHubTextExecutionDependencies,
  type ModelHubTextTask,
  type ModelHubTextTaskExecutionResult,
} from "./model-hub-execution-service";
import type { ModelEvaluationResult, ModelHubStore } from "./model-hub-store";

export interface ModelHubLocalEvaluationReceipt {
  readonly result: ModelEvaluationResult;
  readonly task: ModelHubTextTask;
  readonly modelId: string;
  readonly providerKind: string;
  readonly exactInstructionPassCount: number;
  readonly sampleCount: number;
  readonly scope: "basic_instruction_adherence";
}

export class ModelHubLocalEvaluationError extends Error {
  public constructor(
    readonly code:
      | "MODEL_EVALUATION_INVALID"
      | "MODEL_EVALUATION_INCONSISTENT_ROUTE"
      | "MODEL_EVALUATION_UNAVAILABLE",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ModelHubLocalEvaluationError";
  }
}

type ExecuteText = (
  dependencies: ModelHubTextExecutionDependencies,
  input: Parameters<typeof executeModelHubTextTask>[1],
) => Promise<ModelHubTextTaskExecutionResult>;

const EVALUATION_VERSION = "local-basic-instruction-adherence-v1";

/**
 * Runs two fixed, content-free probes through the same persisted task route as
 * production. It measures only basic instruction/structure adherence and
 * latency; it must never be presented as literary-quality judgement.
 */
export class ModelHubLocalEvaluationService {
  public constructor(
    private readonly dependencies: ModelHubTextExecutionDependencies,
    private readonly modelHub: Pick<ModelHubStore, "recordEvaluationResult">,
    private readonly ids: Pick<UuidV7Generator, "next">,
    private readonly clock: Clock,
    private readonly executeText: ExecuteText = executeModelHubTextTask,
  ) {}

  public async evaluate(task: ModelHubTextTask): Promise<ModelHubLocalEvaluationReceipt> {
    const probes = [
      {
        messages: [
          {
            role: "user" as const,
            content: "这是不含作品内容的本地能力测试。请只回复 INKSHADOW_OK，不要添加标点或说明。",
          },
        ],
        score: scoreExactMarker,
      },
      {
        messages: [
          {
            role: "user" as const,
            content:
              '这是不含作品内容的本地结构测试。请只回复一行 JSON：{"status":"ok","items":["a","b"]}',
          },
        ],
        score: scoreExactJson,
      },
    ] as const;
    const observations: {
      result: ModelHubTextTaskExecutionResult;
      latencyMs: number;
      score: number;
      exact: boolean;
    }[] = [];

    for (const probe of probes) {
      const startedAt = Date.now();
      let result: ModelHubTextTaskExecutionResult;
      try {
        result = await this.executeText(this.dependencies, {
          dispatchScope: { kind: "non_project", reason: "connection_probe" },
          task,
          messages: probe.messages,
          maximumOutputTokens: 64,
          temperature: 0,
          generationId: this.ids.next(),
        });
      } catch (cause: unknown) {
        throw new ModelHubLocalEvaluationError(
          "MODEL_EVALUATION_UNAVAILABLE",
          cause instanceof Error
            ? `基础评测未完成：${cause.message}`
            : "基础评测未完成，请检查模型分工与连接后重试。",
          true,
        );
      }
      const scored = probe.score(result.text);
      observations.push({
        result,
        latencyMs: Math.max(0, Date.now() - startedAt),
        score: scored.score,
        exact: scored.exact,
      });
    }

    const [first, second] = observations;
    if (first === undefined || second === undefined) {
      throw new ModelHubLocalEvaluationError("MODEL_EVALUATION_INVALID", "基础评测样本不完整。");
    }
    if (
      first.result.catalogEntryId !== second.result.catalogEntryId ||
      first.result.modelId !== second.result.modelId
    ) {
      throw new ModelHubLocalEvaluationError(
        "MODEL_EVALUATION_INCONSISTENT_ROUTE",
        "两次评测使用了不同模型，结果不会写入目录；请检查主模型和备用模型后重试。",
        true,
      );
    }
    const observedAt = this.clock.now();
    const expiresAt = new Date(Date.parse(observedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const sortedLatencies = observations.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
    const latencyP50Ms = sortedLatencies[Math.floor((sortedLatencies.length - 1) / 2)] ?? 0;
    const scoreBasisPoints = Math.round(
      observations.reduce((sum, observation) => sum + observation.score, 0) / observations.length,
    );
    const result = await this.modelHub.recordEvaluationResult({
      id: this.ids.next(),
      catalogEntryId: first.result.catalogEntryId,
      task,
      scoreBasisPoints,
      latencyP50Ms,
      sampleCount: observations.length,
      evaluationSource: "local_evaluation",
      evaluationVersion: EVALUATION_VERSION,
      observedAt,
      expiresAt,
    });
    return Object.freeze({
      result,
      task,
      modelId: first.result.modelId,
      providerKind: first.result.providerKind,
      exactInstructionPassCount: observations.filter(({ exact }) => exact).length,
      sampleCount: observations.length,
      scope: "basic_instruction_adherence",
    });
  }
}

function scoreExactMarker(text: string): Readonly<{ score: number; exact: boolean }> {
  const normalized = text.trim();
  if (normalized === "INKSHADOW_OK") return Object.freeze({ score: 10_000, exact: true });
  return Object.freeze({
    score: normalized.includes("INKSHADOW_OK") ? 6_000 : normalized.length > 0 ? 2_000 : 0,
    exact: false,
  });
}

function scoreExactJson(text: string): Readonly<{ score: number; exact: boolean }> {
  const normalized = text.trim();
  const expected = '{"status":"ok","items":["a","b"]}';
  if (normalized === expected) return Object.freeze({ score: 10_000, exact: true });
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).status === "ok"
    ) {
      return Object.freeze({ score: 6_000, exact: false });
    }
  } catch {
    // A fenced or explanatory answer did not follow the exact probe contract.
  }
  return Object.freeze({ score: normalized.length > 0 ? 2_000 : 0, exact: false });
}
