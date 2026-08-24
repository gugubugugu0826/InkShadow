import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import {
  executeModelHubTextTask,
  inspectModelHubTextTask,
  ModelHubExecutionError,
  type ModelHubTextExecutionDependencies,
  type ModelHubTextTask,
  type ModelHubTextTaskExecutionResult,
  type ModelHubTextTaskInspection,
} from "./model-hub-execution-service";
import { SINGLE_ATTEMPT_CAPABILITY_PROBE_POLICY } from "./model-execution-policy";
import type { ModelEvaluationResult, ModelHubStore } from "./model-hub-store";
import { MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS } from "./model-hub-text-capability-probe";
import {
  assertDisclosedSelection,
  assertModelHubInspectionAuthority,
  modelHubInspectionAuthority,
  providerActionFingerprint,
  providerConnectionDisplayName,
  totalDisclosedCost,
  type ProviderActionDisclosure,
} from "./provider-action-disclosure";

export interface ModelHubLocalEvaluationReceipt {
  readonly result: ModelEvaluationResult;
  readonly task: ModelHubTextTask;
  readonly modelId: string;
  readonly exactInstructionPassCount: number;
  readonly sampleCount: number;
  readonly scope: "basic_instruction_adherence";
}

export interface ModelHubLocalEvaluationDisclosure extends ProviderActionDisclosure {
  readonly task: ModelHubTextTask;
  readonly maximumProviderCalls: 2;
  readonly automaticRetryCount: 0;
}

export interface RunModelHubLocalEvaluationInput {
  readonly task: ModelHubTextTask;
  readonly disclosureFingerprint: string;
  readonly humanConfirmed: boolean;
}

export class ModelHubLocalEvaluationError extends Error {
  public constructor(
    readonly code:
      | "MODEL_EVALUATION_INVALID"
      | "MODEL_EVALUATION_INCONSISTENT_ROUTE"
      | "MODEL_EVALUATION_CONFIRMATION_REQUIRED"
      | "MODEL_EVALUATION_DISCLOSURE_CHANGED"
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
type InspectText = typeof inspectModelHubTextTask;
const EVALUATION_VERSION = "local-basic-instruction-adherence-v1";

/** Two fixed, content-free probes. Preparing and cancelling call no provider. */
export class ModelHubLocalEvaluationService {
  public constructor(
    private readonly dependencies: ModelHubTextExecutionDependencies,
    private readonly modelHub: Pick<ModelHubStore, "findConnection" | "recordEvaluationResult">,
    private readonly ids: Pick<UuidV7Generator, "next">,
    private readonly clock: Clock,
    private readonly executeText: ExecuteText = executeModelHubTextTask,
    private readonly inspectText: InspectText = inspectModelHubTextTask,
  ) {}

  public async prepare(task: ModelHubTextTask): Promise<ModelHubLocalEvaluationDisclosure> {
    return (await this.prepareCurrent(task)).disclosure;
  }

  public async evaluate(
    input: RunModelHubLocalEvaluationInput,
  ): Promise<ModelHubLocalEvaluationReceipt> {
    if (!input.humanConfirmed) {
      throw new ModelHubLocalEvaluationError(
        "MODEL_EVALUATION_CONFIRMATION_REQUIRED",
        "需要先确认两次固定测试的模型、发送范围和费用状态。",
      );
    }
    const prepared = await this.prepareCurrent(input.task);
    if (prepared.disclosure.fingerprint !== input.disclosureFingerprint) {
      throw disclosureChanged();
    }
    const probes = evaluationProbes();
    const observations: {
      result: ModelHubTextTaskExecutionResult;
      latencyMs: number;
      score: number;
      exact: boolean;
    }[] = [];

    const assertCurrent = async (index: number): Promise<ModelHubTextTaskInspection> => {
      const expected = prepared.inspections[index];
      const probe = probes[index];
      if (expected === undefined || probe === undefined) throw disclosureChanged();
      const current = await this.inspectText(this.dependencies, inspectionInput(input.task, probe));
      try {
        assertModelHubInspectionAuthority(expected, current);
      } catch {
        throw disclosureChanged();
      }
      return expected;
    };

    for (const [index, probe] of probes.entries()) {
      // Repeated before the second fixed call: any post-first-call drift stops
      // the sequence before a second provider request can be dispatched.
      const expected = await assertCurrent(index);
      const startedAt = Date.now();
      let result: ModelHubTextTaskExecutionResult;
      try {
        result = await this.executeText(this.dependencies, {
          dispatchScope: { kind: "non_project", reason: "connection_probe" },
          executionPolicy: SINGLE_ATTEMPT_CAPABILITY_PROBE_POLICY,
          reasoningPolicy: "capability_probe",
          invocationLedgerTask: "capability_probe",
          task: input.task,
          messages: probe.messages,
          maximumOutputTokens: MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
          temperature: 0,
          generationId: this.ids.next(),
          onBeforeDispatch: async (selection) => {
            assertSelection(expected, selection);
            await assertCurrent(index);
          },
          onFinalBeforeProviderDispatch: async (selection) => {
            assertSelection(expected, selection);
            await assertCurrent(index);
          },
        });
      } catch (cause: unknown) {
        if (cause instanceof ModelHubLocalEvaluationError) throw cause;
        throw new ModelHubLocalEvaluationError(
          "MODEL_EVALUATION_UNAVAILABLE",
          cause instanceof ModelHubExecutionError && cause.dispatched
            ? "基础评测请求已发出，但结果需要核对。请先查看服务商后台记录，避免重复发送。"
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
        "两次评测使用了不同模型，结果不会写入目录；请重新查看发送信息。",
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
      task: input.task,
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
      task: input.task,
      modelId: first.result.modelId,
      exactInstructionPassCount: observations.filter(({ exact }) => exact).length,
      sampleCount: observations.length,
      scope: "basic_instruction_adherence",
    });
  }

  private async prepareCurrent(task: ModelHubTextTask): Promise<
    Readonly<{
      disclosure: ModelHubLocalEvaluationDisclosure;
      inspections: readonly [ModelHubTextTaskInspection, ModelHubTextTaskInspection];
    }>
  > {
    const probes = evaluationProbes();
    const resolved = await Promise.all(
      probes.map((probe) => this.inspectText(this.dependencies, inspectionInput(task, probe))),
    );
    const first = resolved[0];
    const second = resolved[1];
    if (first === undefined || second === undefined) {
      throw new ModelHubLocalEvaluationError("MODEL_EVALUATION_INVALID", "基础评测预检不完整。");
    }
    const inspections: readonly [ModelHubTextTaskInspection, ModelHubTextTaskInspection] =
      Object.freeze([first, second]);
    if (
      first.connectionId !== second.connectionId ||
      first.catalogEntryId !== second.catalogEntryId ||
      first.modelId !== second.modelId ||
      first.usedFallback !== second.usedFallback ||
      first.dataDestination !== second.dataDestination
    ) {
      throw new ModelHubLocalEvaluationError(
        "MODEL_EVALUATION_INCONSISTENT_ROUTE",
        "两项固定测试无法锁定到同一个模型；本次没有发出请求。",
      );
    }
    let connectionDisplayName: string;
    try {
      connectionDisplayName = await providerConnectionDisplayName(this.modelHub, first);
    } catch {
      throw disclosureChanged();
    }
    const cost = totalDisclosedCost(inspections);
    const fingerprint = await providerActionFingerprint({
      task,
      connectionDisplayName,
      inspections: inspections.map(modelHubInspectionAuthority),
      messages: probes.map(({ messages }) => messages),
      maximumProviderCalls: 2,
      automaticRetryCount: 0,
    });
    return Object.freeze({
      inspections,
      disclosure: Object.freeze({
        fingerprint,
        task,
        connectionDisplayName,
        modelId: first.modelId,
        dataDestination: first.dataDestination,
        privacy:
          first.dataDestination === "local"
            ? "两条固定测试文字只发送给当前已验证的本机模型。"
            : "两条固定测试文字会发送到所选 AI 服务；不读取或发送任何作品内容。",
        sends: Object.freeze([
          "固定文字 INKSHADOW_OK 指令测试",
          "固定的一行 JSON 结构测试",
          "不包含小说正文、设定、项目名或凭据",
        ]),
        maximumProviderCalls: 2 as const,
        automaticRetryCount: 0 as const,
        estimatedMaximumCostMicros: cost.estimatedMaximumCostMicros,
        currency: cost.currency,
      }),
    });
  }
}

function evaluationProbes() {
  return [
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
}

function inspectionInput(
  task: ModelHubTextTask,
  probe: ReturnType<typeof evaluationProbes>[number],
) {
  return {
    task,
    messages: probe.messages,
    maximumOutputTokens: MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
    temperature: 0,
  } as const;
}

function assertSelection(
  expected: ModelHubTextTaskInspection,
  selection: Parameters<typeof assertDisclosedSelection>[1],
): void {
  try {
    assertDisclosedSelection(expected, selection);
  } catch {
    throw disclosureChanged();
  }
}

function disclosureChanged(): ModelHubLocalEvaluationError {
  return new ModelHubLocalEvaluationError(
    "MODEL_EVALUATION_DISCLOSURE_CHANGED",
    "模型、发送范围或费用状态已经改变；本次没有继续发送，请重新查看并确认。",
    true,
  );
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
