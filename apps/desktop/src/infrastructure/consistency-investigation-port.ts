import type {
  ConsistencyInvestigationDisclosure,
  ConsistencyInvestigationSnapshot,
  PrepareConsistencyInvestigationInput,
  RunConsistencyInvestigationInput,
} from "./consistency-investigation-service";
import type {
  ConsistencyRepairCandidateDisclosure,
  ConsistencyRepairCandidateResult,
  PrepareConsistencyRepairCandidateInput,
  RunConsistencyRepairCandidateInput,
} from "./consistency-repair-candidate-service";
import type {
  ConsistencyInvestigationFinding,
  ConsistencyInvestigationRun,
} from "./consistency-investigation-store";

export interface ConsistencyInvestigationRuntimePort {
  prepare(input: PrepareConsistencyInvestigationInput): Promise<ConsistencyInvestigationDisclosure>;
  run(input: RunConsistencyInvestigationInput): Promise<ConsistencyInvestigationSnapshot>;
  cancel(runId: string): Promise<ConsistencyInvestigationSnapshot>;
  get(runId: string): Promise<ConsistencyInvestigationSnapshot>;
  list(projectId: string): Promise<readonly ConsistencyInvestigationRun[]>;
  decideFinding(
    input: Readonly<{
      findingId: string;
      expectedRevision: number;
      decision: "ignored" | "allowed";
    }>,
  ): Promise<ConsistencyInvestigationFinding>;
  prepareRepairCandidate(
    input: PrepareConsistencyRepairCandidateInput,
  ): Promise<ConsistencyRepairCandidateDisclosure>;
  runRepairCandidate(
    input: RunConsistencyRepairCandidateInput,
  ): Promise<ConsistencyRepairCandidateResult>;
  cancelRepairCandidate(taskId: string): Promise<void>;
}

export function createLazyConsistencyInvestigationRuntime(
  initialize: () => Promise<ConsistencyInvestigationRuntimePort>,
): ConsistencyInvestigationRuntimePort {
  let pending: Promise<ConsistencyInvestigationRuntimePort> | null = null;
  const load = (): Promise<ConsistencyInvestigationRuntimePort> => {
    pending ??= initialize().catch((cause: unknown) => {
      pending = null;
      throw cause;
    });
    return pending;
  };
  const runtime: ConsistencyInvestigationRuntimePort = {
    prepare: async (input: PrepareConsistencyInvestigationInput) => (await load()).prepare(input),
    run: async (input: RunConsistencyInvestigationInput) => (await load()).run(input),
    cancel: async (runId: string) => (await load()).cancel(runId),
    get: async (runId: string) => (await load()).get(runId),
    list: async (projectId: string) => (await load()).list(projectId),
    decideFinding: async (input) => (await load()).decideFinding(input),
    prepareRepairCandidate: async (input) => (await load()).prepareRepairCandidate(input),
    runRepairCandidate: async (input) => (await load()).runRepairCandidate(input),
    cancelRepairCandidate: async (taskId) => (await load()).cancelRepairCandidate(taskId),
  };
  return Object.freeze(runtime);
}
