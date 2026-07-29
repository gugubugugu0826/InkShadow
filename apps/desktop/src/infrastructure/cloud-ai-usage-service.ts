import type {
  CloudMutationOptions,
  CloudQueryOptions,
  InkShadowCloudApiClient,
} from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  type CloudAiProjectBudgetResponse,
  type CloudAiProjectBudgetUpdateRequest,
  type CloudAiTeamBudgetResponse,
  type CloudAiTeamBudgetUpdateRequest,
  type CloudAiUsageCancellationRequest,
  type CloudAiUsageEventListResponse,
  type CloudAiUsageReservationRequest,
  type CloudAiUsageReservationResponse,
  type CloudAiUsageSettlementRequest,
  type CloudAiUsageSummaryResponse,
} from "@inkshadow/contracts";
import type { UuidV7Generator } from "@inkshadow/domain";

import type {
  CloudSessionCoordinator,
  ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";

export type CloudAiUsageApi = Pick<
  InkShadowCloudApiClient,
  | "updateTeamAiBudget"
  | "updateProjectAiBudget"
  | "getTeamAiUsageSummary"
  | "listTeamAiUsageEvents"
  | "reserveTeamProjectAiUsage"
  | "settleTeamProjectAiUsage"
  | "cancelTeamProjectAiUsage"
>;

export interface CloudAiUsageRuntimePort {
  getSummary(
    teamId: string,
    projectId?: string | null,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageSummaryResponse>;
  listEvents(
    teamId: string,
    projectId?: string | null,
    options?: Pick<CloudQueryOptions, "cursor" | "limit" | "signal">,
  ): Promise<CloudAiUsageEventListResponse>;
  updateTeamBudget(
    teamId: string,
    input: Omit<CloudAiTeamBudgetUpdateRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiTeamBudgetResponse>;
  updateProjectBudget(
    teamId: string,
    projectId: string,
    input: Omit<CloudAiProjectBudgetUpdateRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiProjectBudgetResponse>;
  reserve(
    teamId: string,
    projectId: string,
    input: Omit<CloudAiUsageReservationRequest, "schemaVersion" | "reservationId">,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageReservationResponse>;
  settle(
    teamId: string,
    projectId: string,
    reservationId: string,
    input: Omit<CloudAiUsageSettlementRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageReservationResponse>;
  cancel(
    teamId: string,
    projectId: string,
    reservationId: string,
    input: Omit<CloudAiUsageCancellationRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageReservationResponse>;
}

/**
 * Native Studio bridge for authoritative server-side AI accounting.
 *
 * The service transports only identifiers, token counts, prices and monetary
 * counters. Creative content and credentials stay outside this boundary.
 */
export class CloudAiUsageService implements CloudAiUsageRuntimePort {
  public constructor(
    private readonly api: CloudAiUsageApi,
    private readonly session: Pick<CloudSessionCoordinator, "runWithSession">,
    private readonly ids: UuidV7Generator,
  ) {}

  public getSummary(
    teamId: string,
    projectId: string | null = null,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageSummaryResponse> {
    return this.withSession(
      () => this.api.getTeamAiUsageSummary(teamId, projectId, signalOption(signal)),
      signal,
    );
  }

  public listEvents(
    teamId: string,
    projectId: string | null = null,
    options: Pick<CloudQueryOptions, "cursor" | "limit" | "signal"> = {},
  ): Promise<CloudAiUsageEventListResponse> {
    return this.withSession(
      () => this.api.listTeamAiUsageEvents(teamId, projectId, options),
      options.signal,
    );
  }

  public updateTeamBudget(
    teamId: string,
    input: Omit<CloudAiTeamBudgetUpdateRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiTeamBudgetResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.updateTeamAiBudget(
          teamId,
          { schemaVersion: CONTRACT_SCHEMA_VERSION, ...input },
          mutationOption(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public updateProjectBudget(
    teamId: string,
    projectId: string,
    input: Omit<CloudAiProjectBudgetUpdateRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiProjectBudgetResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.updateProjectAiBudget(
          teamId,
          projectId,
          { schemaVersion: CONTRACT_SCHEMA_VERSION, ...input },
          mutationOption(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public reserve(
    teamId: string,
    projectId: string,
    input: Omit<CloudAiUsageReservationRequest, "schemaVersion" | "reservationId">,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageReservationResponse> {
    const reservationId = this.ids.next();
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.reserveTeamProjectAiUsage(
          teamId,
          projectId,
          { schemaVersion: CONTRACT_SCHEMA_VERSION, reservationId, ...input },
          mutationOption(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public settle(
    teamId: string,
    projectId: string,
    reservationId: string,
    input: Omit<CloudAiUsageSettlementRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageReservationResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.settleTeamProjectAiUsage(
          teamId,
          projectId,
          reservationId,
          { schemaVersion: CONTRACT_SCHEMA_VERSION, ...input },
          mutationOption(idempotencyKey, signal),
        ),
      signal,
    );
  }

  public cancel(
    teamId: string,
    projectId: string,
    reservationId: string,
    input: Omit<CloudAiUsageCancellationRequest, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<CloudAiUsageReservationResponse> {
    const idempotencyKey = this.ids.next();
    return this.withSession(
      () =>
        this.api.cancelTeamProjectAiUsage(
          teamId,
          projectId,
          reservationId,
          { schemaVersion: CONTRACT_SCHEMA_VERSION, ...input },
          mutationOption(idempotencyKey, signal),
        ),
      signal,
    );
  }

  private withSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    signal: AbortSignal | undefined,
  ): Promise<Value> {
    return this.session.runWithSession(operation, signal === undefined ? undefined : { signal });
  }
}

function mutationOption(
  idempotencyKey: string,
  signal: AbortSignal | undefined,
): CloudMutationOptions {
  return signal === undefined ? { idempotencyKey } : { idempotencyKey, signal };
}

function signalOption(signal: AbortSignal | undefined): Pick<CloudQueryOptions, "signal"> {
  return signal === undefined ? {} : { signal };
}
