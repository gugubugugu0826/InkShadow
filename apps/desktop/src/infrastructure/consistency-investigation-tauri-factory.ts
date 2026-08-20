import type { ContentHasher } from "@inkshadow/application";
import type { SqlExecutor } from "@inkshadow/data";
import type { Clock, ProjectSeedStore, UuidV7Generator } from "@inkshadow/domain";

import { ConsistencyInvestigationService } from "./consistency-investigation-service";
import { ConsistencyInvestigationSqliteStore } from "./consistency-investigation-store";
import { ConsistencyInvestigationToolRegistry } from "./consistency-investigation-tool-registry";
import { CompositeStoryMemoryReadModel } from "./story-memory-read-model";
import type { ContextCompilationTraceStore } from "./context-compilation-trace-store";
import type { ContextTraceOutputCommitUnitOfWork } from "./context-trace-output-commit";
import type { ConsistencyInvestigationRuntimePort } from "./consistency-investigation-port";
import type { ModelHubStore } from "./model-hub-store";
import type { ProjectContextPrivacyAuthority } from "./project-context-privacy-authority";
import type { ProjectSearchService } from "./project-search";
import type { ConsistencyRepairCandidateService } from "./consistency-repair-candidate-service";
import type {
  CredentialStore,
  NativeModelGatewayClient,
  RuntimeRepositories,
  RuntimeStory,
} from "./runtime";
import type { TaskCenterStore } from "./task-center-store";

export interface TauriConsistencyInvestigationFactoryInput {
  readonly executor: SqlExecutor;
  readonly repositories: RuntimeRepositories;
  readonly projectSeeds: ProjectSeedStore;
  readonly runtime: Readonly<{
    taskCenter: TaskCenterStore;
    contextTraces: ContextCompilationTraceStore;
    contextTraceOutputs: ContextTraceOutputCommitUnitOfWork;
    modelHub: ModelHubStore;
    modelGateway: NativeModelGatewayClient;
    projectContextPrivacy: ProjectContextPrivacyAuthority;
    ids: UuidV7Generator;
    clock: Clock;
    hasher: ContentHasher;
    search: ProjectSearchService;
    story: Pick<RuntimeStory, "facts" | "memoryRecords" | "causalGraph" | "chapterValidation">;
  }>;
  readonly credentials: CredentialStore;
}

export function createTauriConsistencyInvestigationService(
  input: TauriConsistencyInvestigationFactoryInput,
): ConsistencyInvestigationRuntimePort {
  const memory = new CompositeStoryMemoryReadModel({
    chapters: input.repositories.chapters,
    chapterVersions: input.repositories.chapterVersions,
    facts: input.runtime.story.facts,
    memoryRecords: input.runtime.story.memoryRecords,
    projectSeeds: input.projectSeeds,
    hasher: input.runtime.hasher,
    candidates: input.repositories.aiCandidates,
  });
  const store = new ConsistencyInvestigationSqliteStore(input.executor);
  const tools = new ConsistencyInvestigationToolRegistry({
    memory,
    search: input.runtime.search,
    hasher: input.runtime.hasher,
    causalGraph: input.runtime.story.causalGraph,
    chapters: input.repositories.chapters,
    validator: input.runtime.story.chapterValidation,
  });
  const investigations = new ConsistencyInvestigationService({
    store,
    tools,
    taskCenter: input.runtime.taskCenter,
    chapters: input.repositories.chapters,
    contextTraces: input.runtime.contextTraces,
    modelHub: input.runtime.modelHub,
    modelGateway: input.runtime.modelGateway,
    credentials: input.credentials,
    projectContextPrivacy: input.runtime.projectContextPrivacy,
    ids: input.runtime.ids,
    clock: input.runtime.clock,
    hasher: input.runtime.hasher,
  });
  const loadRepair = createRetryableLazyRepairLoader<ConsistencyRepairCandidateService>(() =>
    import("./consistency-repair-candidate-service").then(
      ({ ConsistencyRepairCandidateService }) =>
        new ConsistencyRepairCandidateService({
          executor: input.executor,
          store,
          tools,
          taskCenter: input.runtime.taskCenter,
          chapters: input.repositories.chapters,
          chapterVersions: input.repositories.chapterVersions,
          contextTraces: input.runtime.contextTraces,
          contextTraceOutputs: input.runtime.contextTraceOutputs,
          modelHub: input.runtime.modelHub,
          modelGateway: input.runtime.modelGateway,
          credentials: input.credentials,
          projectContextPrivacy: input.runtime.projectContextPrivacy,
          ids: input.runtime.ids,
          clock: input.runtime.clock,
          hasher: input.runtime.hasher,
        }),
    ),
  );
  return Object.freeze({
    prepare: investigations.prepare.bind(investigations),
    run: investigations.run.bind(investigations),
    cancel: investigations.cancel.bind(investigations),
    get: investigations.get.bind(investigations),
    list: investigations.list.bind(investigations),
    decideFinding: investigations.decideFinding.bind(investigations),
    prepareRepairCandidate: async (
      repairInput: Parameters<ConsistencyInvestigationRuntimePort["prepareRepairCandidate"]>[0],
    ) => (await loadRepair()).prepare(repairInput),
    runRepairCandidate: async (
      repairInput: Parameters<ConsistencyInvestigationRuntimePort["runRepairCandidate"]>[0],
    ) => (await loadRepair()).run(repairInput),
    cancelRepairCandidate: async (
      taskId: Parameters<ConsistencyInvestigationRuntimePort["cancelRepairCandidate"]>[0],
    ) => (await loadRepair()).cancel(taskId),
  });
}

/** Shares concurrent loads, but clears a failed module load so an explicit retry can recover. */
export function createRetryableLazyRepairLoader<Service>(
  initialize: () => Promise<Service>,
): () => Promise<Service> {
  let pending: Promise<Service> | null = null;
  return () => {
    pending ??= initialize().catch((cause: unknown) => {
      pending = null;
      throw cause;
    });
    return pending;
  };
}
