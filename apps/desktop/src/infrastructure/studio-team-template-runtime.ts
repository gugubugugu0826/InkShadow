import type {
  CloudMutationOptions,
  CloudQueryOptions,
  InkShadowCloudApiClient,
} from "@inkshadow/cloud-client";
import {
  UuidV7Schema,
  type CloudProjectAssignment,
  type CloudTeamMembership,
} from "@inkshadow/contracts";
import { TeamTemplateApplicationSqliteStore, type SqlExecutor } from "@inkshadow/data";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import type { CloudSessionCoordinator } from "./cloud-session-coordinator";
import type { CloudTeamWorkspacePort } from "./cloud-team-workspace-service";
import type { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import {
  StudioTeamTemplateCoordinator,
  type ApplyPublishedStudioTeamTemplateOutcome,
  type StudioTeamTemplateProjectKeyAccessPort,
} from "./studio-team-template-coordinator";
import { StudioTeamTemplateCrypto } from "./studio-team-template-crypto";
import {
  StudioTeamTemplateService,
  type StudioTeamTemplateConnectivityPort,
  type StudioTeamTemplateRemotePort,
  type StudioTeamTemplateSessionContext,
} from "./studio-team-template-service";
import { StudioTeamTemplateSqliteApplication } from "./studio-team-template-sqlite-application";

export class StudioTeamTemplateRuntimeError extends Error {
  public constructor(
    public readonly code:
      | "TEAM_TEMPLATE_AUTHORITY_INCOMPLETE"
      | "TEAM_TEMPLATE_AUTHORITY_INVALID"
      | "TEAM_TEMPLATE_SESSION_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "StudioTeamTemplateRuntimeError";
  }
}

export interface StudioTeamTemplateRuntime {
  readonly coordinator: StudioTeamTemplateCoordinator;
  isMutationEnabled(): boolean;
  isOnline(): boolean;
  resolveContext(
    teamId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateSessionContext>;
  recoverPendingApplications(
    context: StudioTeamTemplateSessionContext,
    options?: Readonly<{ limit?: number; signal?: AbortSignal }>,
  ): Promise<readonly ApplyPublishedStudioTeamTemplateOutcome[]>;
}

export interface CreateStudioTeamTemplateRuntimeOptions {
  readonly api: InkShadowCloudApiClient;
  readonly session: CloudSessionCoordinator;
  readonly teams: CloudTeamWorkspacePort;
  readonly projectSecurity: ProjectKeyLifecycleService;
  readonly executor: SqlExecutor;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
  readonly mutationEnabled: boolean;
  readonly connectivity?: StudioTeamTemplateConnectivityPort;
  readonly cryptoProvider?: Crypto;
}

/**
 * Production composition root for project-DEK encrypted team templates.
 *
 * Plaintext and opened project keys remain inside this desktop process. The
 * remote boundary is session-bound and the local application boundary owns the
 * atomic project-revision CAS plus durable idempotency receipt.
 */
export function createStudioTeamTemplateRuntime(
  options: CreateStudioTeamTemplateRuntimeOptions,
): StudioTeamTemplateRuntime {
  const connectivity = options.connectivity ?? new NavigatorStudioTeamTemplateConnectivity();
  const mutationFlag = Object.freeze({
    isMutationEnabled: () => options.mutationEnabled,
  });
  const coordinator = new StudioTeamTemplateCoordinator({
    service: new StudioTeamTemplateService(
      createSessionBoundTeamTemplateRemote(options.api, options.session),
      connectivity,
      mutationFlag,
    ),
    crypto: new StudioTeamTemplateCrypto(options.cryptoProvider),
    projectKeys: new LifecycleStudioTeamTemplateProjectKeys(
      options.projectSecurity,
      options.session,
    ),
    applications: new StudioTeamTemplateSqliteApplication(
      new TeamTemplateApplicationSqliteStore(options.executor, options.clock),
    ),
    ids: options.ids,
    idempotencyKeys: {
      next: () => options.ids.next(),
    },
  });
  const authority = new CloudStudioTeamTemplateAuthority(options.teams, options.session);
  return Object.freeze({
    coordinator,
    isMutationEnabled: () => mutationFlag.isMutationEnabled(),
    isOnline: () => connectivity.isOnline(),
    resolveContext: (teamId: string, projectId: string, signal?: AbortSignal) =>
      authority.resolveContext(teamId, projectId, signal),
    recoverPendingApplications: (
      context: StudioTeamTemplateSessionContext,
      recoveryOptions: Readonly<{ limit?: number; signal?: AbortSignal }> = {},
    ) => coordinator.recoverPendingApplicationRecords(context, recoveryOptions),
  });
}

class NavigatorStudioTeamTemplateConnectivity implements StudioTeamTemplateConnectivityPort {
  public isOnline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine;
  }
}

export class CloudStudioTeamTemplateAuthority {
  public constructor(
    private readonly teams: CloudTeamWorkspacePort,
    private readonly session: CloudSessionCoordinator,
  ) {}

  public async resolveContext(
    teamIdValue: string,
    projectIdValue: string,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplateSessionContext> {
    throwIfAborted(signal);
    const teamId = requireUuid(teamIdValue);
    const projectId = requireUuid(projectIdValue);
    const before = await this.session.ensureReady(signal === undefined ? {} : { signal });
    const [members, assignments] = await Promise.all([
      this.teams.listTeamMembers(teamId, signal),
      this.teams.listProjectAssignments(teamId, projectId, signal),
    ]);
    throwIfAborted(signal);
    const after = await this.session.ensureReady(signal === undefined ? {} : { signal });
    if (
      before.account.accountId !== after.account.accountId ||
      before.device.device.deviceId !== after.device.device.deviceId ||
      before.session.sessionId !== after.session.sessionId
    ) {
      throw new StudioTeamTemplateRuntimeError(
        "TEAM_TEMPLATE_SESSION_CHANGED",
        "The cloud account, device, or session changed while template authority was resolved.",
      );
    }
    if (members.nextCursor !== null || assignments.nextCursor !== null) {
      throw new StudioTeamTemplateRuntimeError(
        "TEAM_TEMPLATE_AUTHORITY_INCOMPLETE",
        "Template authority cannot be decided from a truncated membership or assignment page.",
      );
    }

    const memberships = members.memberships.map((membership) =>
      requireMembershipScope(membership, teamId),
    );
    const actorCandidates = memberships.filter(
      (membership) => membership.accountId === before.account.accountId,
    );
    if (actorCandidates.length !== 1) {
      throw invalidAuthority("The current account does not have one exact team membership.");
    }
    const actor = actorCandidates[0];
    if (actor === undefined) {
      throw invalidAuthority("The current team membership is unavailable.");
    }
    if (memberships.some((membership) => membership.tenantId !== actor.tenantId)) {
      throw invalidAuthority("The membership response crossed its tenant scope.");
    }
    const scopedAssignments = assignments.assignments.map((assignment) =>
      requireAssignmentScope(assignment, actor.tenantId, teamId, projectId),
    );
    const membershipIds = new Set(memberships.map((membership) => membership.membershipId));
    if (scopedAssignments.some((assignment) => !membershipIds.has(assignment.membershipId))) {
      throw invalidAuthority("A project assignment referenced an unknown team membership.");
    }
    const actorAssignments = scopedAssignments.filter(
      (assignment) => assignment.membershipId === actor.membershipId,
    );
    if (actorAssignments.length > 1) {
      throw invalidAuthority("The current membership has duplicate project assignments.");
    }
    return Object.freeze({
      tenantId: actor.tenantId,
      teamId,
      projectId,
      membershipId: actor.membershipId,
      deviceId: before.device.device.deviceId,
      role: actor.role,
      membershipState: actor.state,
      assignmentState: actorAssignments[0]?.state ?? "missing",
    });
  }
}

class LifecycleStudioTeamTemplateProjectKeys implements StudioTeamTemplateProjectKeyAccessPort {
  public constructor(
    private readonly projectSecurity: ProjectKeyLifecycleService,
    private readonly session: CloudSessionCoordinator,
  ) {}

  public openCurrentTemplateProjectKey(
    scope: Readonly<{ tenantId: string; teamId: string; projectId: string }>,
    signal?: AbortSignal,
  ) {
    return this.open(scope.projectId, undefined, signal);
  }

  public openTemplateProjectKey(
    scope: Readonly<{
      tenantId: string;
      teamId: string;
      projectId: string;
      keyVersion: number;
    }>,
    signal?: AbortSignal,
  ) {
    return this.open(scope.projectId, scope.keyVersion, signal);
  }

  private async open(projectId: string, keyVersion: number | undefined, signal?: AbortSignal) {
    const status = await this.session.ensureReady(signal === undefined ? {} : { signal });
    throwIfAborted(signal);
    const opened = await this.projectSecurity.openProjectDataKeyForDevice(
      projectId,
      status.device.device.deviceId,
      keyVersion,
      {
        accountId: status.account.accountId,
        expectedSessionId: status.session.sessionId,
      },
    );
    throwIfAborted(signal);
    if (
      opened.projectId !== projectId ||
      (keyVersion !== undefined && opened.keyVersion !== keyVersion)
    ) {
      throw invalidAuthority("The opened project key crossed its requested template scope.");
    }
    return Object.freeze({
      projectId: opened.projectId,
      keyVersion: opened.keyVersion,
      key: opened.key,
    });
  }
}

function createSessionBoundTeamTemplateRemote(
  api: InkShadowCloudApiClient,
  session: CloudSessionCoordinator,
): StudioTeamTemplateRemotePort {
  const run = <Value>(signal: AbortSignal | undefined, operation: () => Promise<Value>) =>
    session.runWithSession(() => operation(), signal === undefined ? {} : { signal });
  return Object.freeze({
    listTeamTemplates: (teamId, projectId, options: CloudQueryOptions = {}) =>
      run(options.signal, () => api.listTeamTemplates(teamId, projectId, options)),
    getTeamTemplate: (teamId, projectId, templateId, options = {}) =>
      run(options.signal, () => api.getTeamTemplate(teamId, projectId, templateId, options)),
    listTeamTemplateVersions: (teamId, projectId, templateId, options: CloudQueryOptions = {}) =>
      run(options.signal, () =>
        api.listTeamTemplateVersions(teamId, projectId, templateId, options),
      ),
    getTeamTemplateVersion: (teamId, projectId, templateId, versionId, options = {}) =>
      run(options.signal, () =>
        api.getTeamTemplateVersion(teamId, projectId, templateId, versionId, options),
      ),
    createTeamTemplate: (teamId, projectId, request, options: CloudMutationOptions) =>
      run(options.signal, () => api.createTeamTemplate(teamId, projectId, request, options)),
    createTeamTemplateVersion: (
      teamId,
      projectId,
      templateId,
      request,
      options: CloudMutationOptions,
    ) =>
      run(options.signal, () =>
        api.createTeamTemplateVersion(teamId, projectId, templateId, request, options),
      ),
    cloneTeamTemplate: (
      teamId,
      projectId,
      sourceTemplateId,
      request,
      options: CloudMutationOptions,
    ) =>
      run(options.signal, () =>
        api.cloneTeamTemplate(teamId, projectId, sourceTemplateId, request, options),
      ),
    publishTeamTemplate: (teamId, projectId, templateId, request, options: CloudMutationOptions) =>
      run(options.signal, () =>
        api.publishTeamTemplate(teamId, projectId, templateId, request, options),
      ),
    archiveTeamTemplate: (teamId, projectId, templateId, request, options: CloudMutationOptions) =>
      run(options.signal, () =>
        api.archiveTeamTemplate(teamId, projectId, templateId, request, options),
      ),
    recordTeamTemplateApplication: (
      teamId,
      projectId,
      templateId,
      request,
      options: CloudMutationOptions,
    ) =>
      run(options.signal, () =>
        api.recordTeamTemplateApplication(teamId, projectId, templateId, request, options),
      ),
  });
}

function requireMembershipScope(
  membership: CloudTeamMembership,
  teamId: string,
): CloudTeamMembership {
  if (membership.teamId !== teamId) {
    throw invalidAuthority("The membership response crossed its requested team scope.");
  }
  return membership;
}

function requireAssignmentScope(
  assignment: CloudProjectAssignment,
  tenantId: string,
  teamId: string,
  projectId: string,
): CloudProjectAssignment {
  if (
    assignment.tenantId !== tenantId ||
    assignment.teamId !== teamId ||
    assignment.projectId !== projectId
  ) {
    throw invalidAuthority("The assignment response crossed its requested project scope.");
  }
  return assignment;
}

function requireUuid(value: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw invalidAuthority("Team-template authority requires canonical UUIDv7 identifiers.");
  }
  return parsed.data.toLowerCase();
}

function invalidAuthority(message: string): StudioTeamTemplateRuntimeError {
  return new StudioTeamTemplateRuntimeError("TEAM_TEMPLATE_AUTHORITY_INVALID", message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException(
      "The Studio team-template runtime operation was cancelled.",
      "AbortError",
    );
  }
}
