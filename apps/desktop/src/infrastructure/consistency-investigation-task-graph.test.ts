import type { ConsistencyInvestigationSnapshot } from "./consistency-investigation-service";
import type {
  ConsistencyInvestigationFinding,
  ConsistencyInvestigationRun,
  ConsistencyInvestigationStep,
} from "./consistency-investigation-store";
import { projectConsistencyInvestigationTaskGraph } from "./consistency-investigation-task-graph";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-20T00:00:00.000Z";

describe("consistency investigation TaskGraph projection", () => {
  it("rebuilds deterministically and preserves ambiguous separately from known failed", () => {
    const snapshot = fixture();
    const first = projectConsistencyInvestigationTaskGraph(snapshot);
    const afterRestart = projectConsistencyInvestigationTaskGraph(
      structuredClone({ ...snapshot, steps: [...snapshot.steps].reverse() }),
    );

    expect(afterRestart).toEqual(first);
    expect(first.nodes.map(({ kind }) => kind)).toEqual([
      "goal",
      "plan",
      "action",
      "tool",
      "observation",
      "action",
      "tool",
      "observation",
      "verification",
      "result",
    ]);
    expect(first.nodes.find(({ kind }) => kind === "verification")?.status).toBe("ambiguous");
    expect(first.nodes.find(({ stepId }) => stepId === "step-known-failed")?.status).toBe("failed");
    expect(first.previousAttemptId).toBe("prior-run");
  });

  it("projects existing task/invocation/evidence identities without adding dispatch authority", () => {
    const graph = projectConsistencyInvestigationTaskGraph(fixture());
    const modelTool = graph.nodes.find(
      ({ kind, stepId }) => kind === "tool" && stepId === "step-ambiguous",
    );
    const verification = graph.nodes.find(({ kind }) => kind === "verification");

    expect(modelTool).toMatchObject({ taskId: "task-1", invocationId: "invocation-1" });
    expect(verification?.evidence).toHaveLength(1);
    expect(JSON.stringify(graph)).not.toContain("private chapter prose");
  });
});

function fixture(): ConsistencyInvestigationSnapshot {
  const run = {
    id: "run-1",
    taskId: "task-1",
    projectId: "project-1",
    restartOfRunId: "prior-run",
    idempotencyKey: "idem",
    requestFingerprint: "request",
    status: "ambiguous",
    chapterCount: 2,
    policy: {
      maximumModelCalls: 1,
      maximumToolSteps: 5,
      maximumContextCharacters: 1000,
      maximumOutputTokens: 100,
      maximumDurationMs: 5000,
      automaticRetryCount: 0,
    },
    estimatedInputTokens: 10,
    estimatedMaximumCostMicros: null,
    currency: null,
    connectionId: "connection",
    catalogEntryId: "catalog",
    providerKind: "provider",
    modelId: "model",
    privacyFingerprint: "privacy",
    contextTraceId: "trace-1",
    generationId: "generation",
    summary: null,
    findingCount: 1,
    droppedFindingCount: 0,
    cancellationRequested: false,
    failureCode: "DISPATCH_OUTCOME_UNKNOWN",
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  } satisfies ConsistencyInvestigationRun;
  const base = {
    runId: run.id,
    kind: "model",
    name: "model_synthesis",
    version: "v1",
    permission: "model_dispatch",
    inputDigest: "digest",
    plannedInvocationId: "invocation-1",
    observationDigest: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  } as const;
  const steps: readonly ConsistencyInvestigationStep[] = [
    {
      ...base,
      id: "step-ambiguous",
      ordinal: 2,
      status: "ambiguous",
      invocationId: "invocation-1",
      terminalCause: "DISPATCH_OUTCOME_UNKNOWN",
    },
    {
      ...base,
      id: "step-known-failed",
      ordinal: 1,
      status: "failed",
      invocationId: null,
      terminalCause: "LOCAL_VALIDATION_FAILED",
    },
  ];
  const findings: readonly ConsistencyInvestigationFinding[] = [
    {
      id: "finding-1",
      runId: run.id,
      modelStepId: "step-ambiguous",
      ordinal: 1,
      severity: "warning",
      authorityGroup: "accepted_body",
      category: "pov",
      title: "private chapter prose",
      explanation: "private chapter prose",
      status: "pending",
      evidence: [
        {
          projectId: "project-1",
          chapterId: "chapter-1",
          immutableVersionId: "version-1",
          sourceKind: "chapter",
          locator: { kind: "utf16", startOffset: 0, endOffset: 1, sourceLength: 1 },
          excerptDigest: "b".repeat(64),
          sourceCreatedAt: NOW,
          observedAt: NOW,
          currentness: "current",
          branchId: null,
          privacy: "local_only",
        },
      ],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      decidedAt: null,
    },
  ];
  return { run, steps, findings };
}
