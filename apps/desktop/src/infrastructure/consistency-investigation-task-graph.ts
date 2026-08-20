import type { EvidenceRef } from "@inkshadow/ai-core";

import type { ConsistencyInvestigationSnapshot } from "./consistency-investigation-service";
import type {
  ConsistencyInvestigationFinding,
  ConsistencyInvestigationRun,
  ConsistencyInvestigationStep,
} from "./consistency-investigation-store";

export type InvestigationTaskGraphNodeKind =
  "goal" | "plan" | "action" | "tool" | "observation" | "verification" | "result";

export interface InvestigationTaskGraphNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: InvestigationTaskGraphNodeKind;
  readonly status: ConsistencyInvestigationRun["status"] | ConsistencyInvestigationStep["status"];
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly invocationId: string | null;
  readonly contextTraceId: string | null;
  readonly attemptId: string;
  readonly previousAttemptId: string | null;
  readonly evidence: readonly EvidenceRef[];
  /** Content-free operational summary safe for task/diagnostic surfaces. */
  readonly safeSummary: Readonly<Record<string, string | number | boolean | null>>;
}

export interface InvestigationTaskGraphProjection {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly previousAttemptId: string | null;
  readonly nodes: readonly InvestigationTaskGraphNode[];
}

/**
 * Pure read projection over the existing run/step/task/invocation/finding chain.
 * It owns no queue and persists no status, so rebuilding after restart cannot
 * dispatch or retry a provider invocation.
 */
export function projectConsistencyInvestigationTaskGraph(
  snapshot: ConsistencyInvestigationSnapshot,
): InvestigationTaskGraphProjection {
  const { run } = snapshot;
  const goalId = `task-graph:${run.id}:goal`;
  const planId = `task-graph:${run.id}:plan`;
  const verificationId = `task-graph:${run.id}:verification`;
  const nodes: InvestigationTaskGraphNode[] = [
    node(run, {
      id: goalId,
      parentId: null,
      kind: "goal",
      status: run.status,
      safeSummary: { operation: "consistency_investigation", chapterCount: run.chapterCount },
    }),
    node(run, {
      id: planId,
      parentId: goalId,
      kind: "plan",
      status: run.status,
      safeSummary: {
        maximumModelCalls: run.policy.maximumModelCalls,
        maximumToolSteps: run.policy.maximumToolSteps,
        automaticRetryCount: run.policy.automaticRetryCount,
      },
    }),
  ];

  const orderedSteps = [...snapshot.steps].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  );
  for (const step of orderedSteps) {
    const actionId = `task-graph:${run.id}:action:${step.id}`;
    const toolId = `task-graph:${run.id}:tool:${step.id}`;
    nodes.push(
      node(run, {
        id: actionId,
        parentId: planId,
        kind: "action",
        status: step.status,
        step,
        safeSummary: { ordinal: step.ordinal, kind: step.kind, permission: step.permission },
      }),
      node(run, {
        id: toolId,
        parentId: actionId,
        kind: "tool",
        status: step.status,
        step,
        safeSummary: { name: step.name, version: step.version, permission: step.permission },
      }),
      node(run, {
        id: `task-graph:${run.id}:observation:${step.id}`,
        parentId: toolId,
        kind: "observation",
        status: step.status,
        step,
        safeSummary: {
          hasObservation: step.observationDigest !== null,
          terminalCause: step.terminalCause,
        },
      }),
    );
  }

  const findings = [...snapshot.findings].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  );
  nodes.push(
    node(run, {
      id: verificationId,
      parentId: planId,
      kind: "verification",
      status: verificationStatus(run, orderedSteps),
      evidence: uniqueEvidence(findings.flatMap((finding) => finding.evidence)),
      safeSummary: findingSummary(findings),
    }),
    node(run, {
      id: `task-graph:${run.id}:result`,
      parentId: verificationId,
      kind: "result",
      status: run.status,
      safeSummary: {
        findingCount: run.findingCount,
        droppedFindingCount: run.droppedFindingCount,
        failureCode: run.failureCode,
        cancellationRequested: run.cancellationRequested,
      },
    }),
  );

  return Object.freeze({
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.id,
    attemptId: run.id,
    previousAttemptId: run.restartOfRunId,
    nodes: Object.freeze(nodes),
  });
}

function node(
  run: ConsistencyInvestigationRun,
  input: Readonly<{
    id: string;
    parentId: string | null;
    kind: InvestigationTaskGraphNodeKind;
    status: InvestigationTaskGraphNode["status"];
    step?: ConsistencyInvestigationStep;
    evidence?: readonly EvidenceRef[];
    safeSummary: InvestigationTaskGraphNode["safeSummary"];
  }>,
): InvestigationTaskGraphNode {
  return Object.freeze({
    id: input.id,
    parentId: input.parentId,
    kind: input.kind,
    status: input.status,
    taskId: run.taskId,
    runId: run.id,
    stepId: input.step?.id ?? null,
    invocationId: input.step?.invocationId ?? input.step?.plannedInvocationId ?? null,
    contextTraceId: run.contextTraceId,
    attemptId: run.id,
    previousAttemptId: run.restartOfRunId,
    evidence: Object.freeze([...(input.evidence ?? [])]),
    safeSummary: Object.freeze({ ...input.safeSummary }),
  });
}

function verificationStatus(
  run: ConsistencyInvestigationRun,
  steps: readonly ConsistencyInvestigationStep[],
): InvestigationTaskGraphNode["status"] {
  if (steps.some(({ status }) => status === "ambiguous")) return "ambiguous";
  if (steps.some(({ status }) => status === "failed")) return "failed";
  return run.status;
}

function findingSummary(
  findings: readonly ConsistencyInvestigationFinding[],
): InvestigationTaskGraphNode["safeSummary"] {
  return {
    total: findings.length,
    pending: findings.filter(({ status }) => status === "pending").length,
    ignored: findings.filter(({ status }) => status === "ignored").length,
    allowed: findings.filter(({ status }) => status === "allowed").length,
    withEvidence: findings.filter(({ evidence }) => evidence.length > 0).length,
  };
}

function uniqueEvidence(values: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const byIdentity = new Map<string, EvidenceRef>();
  for (const value of values) {
    const key = JSON.stringify([
      value.projectId,
      value.chapterId,
      value.immutableVersionId,
      value.sourceKind,
      value.locator,
      value.excerptDigest,
    ]);
    if (!byIdentity.has(key)) byIdentity.set(key, value);
  }
  return Object.freeze([...byIdentity.values()]);
}
