import type { AppError, Result } from "@inkshadow/domain";
import type {
  GraphEntity,
  GraphRagProjectSnapshot,
  GraphRelation,
  GraphSourceVersion,
  GraphSourceVersionState,
} from "@inkshadow/search-core";

export type GraphRagProjectionStatus = "ready" | "paused" | "corrupt";

export interface PersistedGraphRagProject extends GraphRagProjectSnapshot {
  readonly revision: number;
  readonly status: GraphRagProjectionStatus;
  readonly updatedAt: string;
  readonly lastRebuiltAt?: string;
}

export interface GraphRagMutationReceipt {
  readonly projectId: string;
  readonly previousRevision: number;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface GraphRagMutationAuthority {
  readonly expectedRevision: number;
  readonly mutatedAt: string;
}

export interface UpsertGraphSourceVersionCommand extends GraphRagMutationAuthority {
  readonly source: GraphSourceVersion;
}

export interface InvalidateGraphSourceVersionCommand extends GraphRagMutationAuthority {
  readonly projectId: string;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly state: Exclude<GraphSourceVersionState, "current">;
}

export interface UpsertGraphEntityCommand extends GraphRagMutationAuthority {
  readonly entity: GraphEntity;
}

export interface DeleteGraphEntityCommand extends GraphRagMutationAuthority {
  readonly projectId: string;
  readonly entityId: string;
}

export interface UpsertGraphRelationCommand extends GraphRagMutationAuthority {
  readonly relation: GraphRelation;
}

export interface DeleteGraphRelationCommand extends GraphRagMutationAuthority {
  readonly projectId: string;
  readonly relationId: string;
}

export interface ReplaceGraphRagProjectCommand extends GraphRagMutationAuthority {
  readonly snapshot: GraphRagProjectSnapshot;
}

export interface GraphRagProjectionRepository {
  loadProject(projectId: string): Promise<Result<PersistedGraphRagProject | null, AppError>>;

  upsertSourceVersion(
    command: UpsertGraphSourceVersionCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>>;

  invalidateSourceVersion(
    command: InvalidateGraphSourceVersionCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>>;

  upsertEntity(
    command: UpsertGraphEntityCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>>;

  softDeleteEntity(
    command: DeleteGraphEntityCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>>;

  upsertRelation(
    command: UpsertGraphRelationCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>>;

  softDeleteRelation(
    command: DeleteGraphRelationCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>>;

  replaceProject(
    command: ReplaceGraphRagProjectCommand,
  ): Promise<Result<GraphRagMutationReceipt, AppError>>;
}
