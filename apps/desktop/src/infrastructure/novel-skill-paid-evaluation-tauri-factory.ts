import type { ProjectRepository } from "@inkshadow/application";
import type { SqlExecutor } from "@inkshadow/data";

import { NovelSkillEvaluationSqliteStore } from "./novel-skill-evaluation-sqlite-store";
import { createSqliteArchivedEvaluationProjectPort } from "./novel-skill-paid-evaluation-archived-project";
import {
  createNovelSkillPaidEvaluationCoordinator,
  type NovelSkillPaidEvaluationCoordinatorPort,
} from "./novel-skill-paid-evaluation-coordinator";
import { NovelSkillPaidEvaluationControlSqliteStore } from "./novel-skill-paid-evaluation-control-sqlite-store";
import {
  NOVEL_SKILL_PAID_EVALUATION_CONTEXT_TOKEN_BUDGET,
  createNovelSkillPaidEvaluationPreparation,
  createNovelSkillPaidEvaluationRequestProfile,
  listNovelSkillPaidEvaluationPreferenceSources,
  type NovelSkillPaidEvaluationPreparationOptions,
} from "./novel-skill-paid-evaluation-preparation";
import {
  createNovelSkillPaidEvaluationRuntime,
  type NovelSkillPaidEvaluationRuntimeIdFactory,
} from "./novel-skill-paid-evaluation-runtime";
import { NovelSkillPaidEvaluationSqliteStore } from "./novel-skill-paid-evaluation-sqlite-store";
import { NovelSkillSqliteStore } from "./novel-skill-sqlite-store";

export interface TauriNovelSkillPaidEvaluationCoordinatorOptions {
  readonly executor: SqlExecutor;
  readonly projects: ProjectRepository;
  readonly exactTargetDependencies: NovelSkillPaidEvaluationPreparationOptions["exactTargetDependencies"];
  readonly ids: Readonly<{ next(): string }>;
}

/**
 * Heavy Tauri-only composition root. Callers reach this module through a
 * dynamic import so ordinary DesktopRuntime code does not eagerly bundle the
 * commercial evaluation stores, preparation compiler or 192-call runner.
 */
export function createTauriNovelSkillPaidEvaluationCoordinator(
  options: TauriNovelSkillPaidEvaluationCoordinatorOptions,
): NovelSkillPaidEvaluationCoordinatorPort {
  const { executor, projects, exactTargetDependencies, ids } = options;
  const evaluationStore = new NovelSkillEvaluationSqliteStore(executor);
  const paidStore = new NovelSkillPaidEvaluationSqliteStore(executor);
  const controlStore = new NovelSkillPaidEvaluationControlSqliteStore(executor);
  const novelSkillStore = new NovelSkillSqliteStore(executor);
  const preparationPort = createNovelSkillPaidEvaluationPreparation({
    clock: exactTargetDependencies.clock,
    evaluationStore,
    paidStore,
    controlStore,
    archivedProjectPort: createSqliteArchivedEvaluationProjectPort({
      projects,
      executor,
      clock: exactTargetDependencies.clock,
    }),
    exactTargetDependencies,
  });
  const runtimeIds: NovelSkillPaidEvaluationRuntimeIdFactory = Object.freeze({
    next: () => ids.next(),
  });

  return createNovelSkillPaidEvaluationCoordinator({
    controlStore,
    nextRunId: () => ids.next(),
    createRuntime: (runId) =>
      createNovelSkillPaidEvaluationRuntime({
        runId,
        reviewerId: `local-reviewer:${runId}`,
        clock: exactTargetDependencies.clock,
        ids: runtimeIds,
        evaluationStore,
        paidStore,
        controlStore,
        novelSkillStore,
        exactTargetDependencies,
        requestProfileForTask: createNovelSkillPaidEvaluationRequestProfile,
        contextBaselineTokenBudget: NOVEL_SKILL_PAID_EVALUATION_CONTEXT_TOKEN_BUDGET,
        preferencePort: {
          listFrozenPreferenceSources: () =>
            Promise.resolve(listNovelSkillPaidEvaluationPreferenceSources()),
        },
        preparationPort,
      }),
  });
}
