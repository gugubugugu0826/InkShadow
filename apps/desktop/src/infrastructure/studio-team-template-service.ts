import type {
  CloudMutationOptions,
  CloudQueryOptions,
  InkShadowCloudApiClient,
} from "@inkshadow/cloud-client";
import {
  UuidV7Schema,
  type CloudProjectAssignment,
  type CloudTeamMembership,
  type CloudTeamTemplateApplicationResponse,
  type CloudTeamTemplateApplyRequest,
  type CloudTeamTemplateArchiveRequest,
  type CloudTeamTemplateCloneRequest,
  type CloudTeamTemplateCreateRequest,
  type CloudTeamTemplateListResponse,
  type CloudTeamTemplateMutationResponse,
  type CloudTeamTemplatePublishRequest,
  type CloudTeamTemplateResponse,
  type CloudTeamTemplateVersionCreateRequest,
  type CloudTeamTemplateVersionListResponse,
  type CloudTeamTemplateVersionResponse,
} from "@inkshadow/contracts";

export type StudioTeamTemplateRole = CloudTeamMembership["role"];

export interface StudioTeamTemplateSessionContext {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly deviceId: string;
  readonly role: StudioTeamTemplateRole;
  readonly membershipState: CloudTeamMembership["state"];
  readonly assignmentState: CloudProjectAssignment["state"] | "missing";
}

export type StudioTeamTemplateAction =
  "read" | "create" | "create_version" | "clone" | "apply" | "publish" | "archive";

export interface StudioTeamTemplateCapabilities {
  readonly read: boolean;
  readonly create: boolean;
  readonly createVersion: boolean;
  readonly clone: boolean;
  readonly apply: boolean;
  readonly publish: boolean;
  readonly archive: boolean;
}

export interface StudioTeamTemplateConnectivityPort {
  isOnline(): boolean;
}

export interface StudioTeamTemplateFeatureFlagPort {
  /**
   * Mutation rollout is fail-closed. Historical reads intentionally remain
   * available while the feature is disabled so encrypted records are never
   * hidden from authorized project members.
   */
  isMutationEnabled(): boolean;
}

export type StudioTeamTemplateRemotePort = Pick<
  InkShadowCloudApiClient,
  | "archiveTeamTemplate"
  | "cloneTeamTemplate"
  | "createTeamTemplate"
  | "createTeamTemplateVersion"
  | "getTeamTemplate"
  | "getTeamTemplateVersion"
  | "listTeamTemplates"
  | "listTeamTemplateVersions"
  | "publishTeamTemplate"
  | "recordTeamTemplateApplication"
>;

export type StudioTeamTemplateServiceErrorCode =
  | "TEAM_TEMPLATE_FEATURE_DISABLED"
  | "TEAM_TEMPLATE_OFFLINE"
  | "TEAM_TEMPLATE_PERMISSION_DENIED"
  | "TEAM_TEMPLATE_SCOPE_INVALID";

export class StudioTeamTemplateServiceError extends Error {
  public constructor(
    public readonly code: StudioTeamTemplateServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioTeamTemplateServiceError";
  }
}

/**
 * Fail-closed desktop transport boundary for encrypted team templates.
 *
 * This layer owns role, membership, exact project-assignment, rollout and
 * connectivity gates. It never receives a plaintext title or template body.
 */
export class StudioTeamTemplateService {
  public constructor(
    private readonly remote: StudioTeamTemplateRemotePort,
    private readonly connectivity: StudioTeamTemplateConnectivityPort,
    private readonly featureFlag: StudioTeamTemplateFeatureFlagPort,
  ) {}

  public capabilities(
    contextValue: StudioTeamTemplateSessionContext,
  ): StudioTeamTemplateCapabilities {
    const context = normalizeContext(contextValue);
    if (context.membershipState !== "active" || context.assignmentState !== "active") {
      return NO_CAPABILITIES;
    }
    const actions = ROLE_ACTIONS[context.role];
    const mutationsEnabled = this.featureFlag.isMutationEnabled();
    return Object.freeze({
      read: actions.has("read"),
      create: mutationsEnabled && actions.has("create"),
      createVersion: mutationsEnabled && actions.has("create_version"),
      clone: mutationsEnabled && actions.has("clone"),
      apply: mutationsEnabled && actions.has("apply"),
      publish: mutationsEnabled && actions.has("publish"),
      archive: mutationsEnabled && actions.has("archive"),
    });
  }

  public authorize(
    contextValue: StudioTeamTemplateSessionContext,
    action: StudioTeamTemplateAction,
  ): void {
    const context = normalizeContext(contextValue);
    if (
      context.membershipState !== "active" ||
      context.assignmentState !== "active" ||
      !ROLE_ACTIONS[context.role].has(action)
    ) {
      throw new StudioTeamTemplateServiceError(
        "TEAM_TEMPLATE_PERMISSION_DENIED",
        "The active team role and exact project assignment do not authorize this template action.",
      );
    }
    if (action !== "read" && !this.featureFlag.isMutationEnabled()) {
      throw new StudioTeamTemplateServiceError(
        "TEAM_TEMPLATE_FEATURE_DISABLED",
        "Encrypted team-template mutations are disabled by the current rollout flag.",
      );
    }
  }

  public assertAvailable(
    contextValue: StudioTeamTemplateSessionContext,
    action: StudioTeamTemplateAction,
    signal?: AbortSignal,
  ): void {
    this.requireRemote(contextValue, action, signal);
  }

  public async listTemplates(
    contextValue: StudioTeamTemplateSessionContext,
    options: CloudQueryOptions = {},
  ): Promise<CloudTeamTemplateListResponse> {
    const context = this.requireRemote(contextValue, "read", options.signal);
    return this.remote.listTeamTemplates(context.teamId, context.projectId, options);
  }

  public async getTemplate(
    contextValue: StudioTeamTemplateSessionContext,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateResponse> {
    const context = this.requireRemote(contextValue, "read", signal);
    return this.remote.getTeamTemplate(
      context.teamId,
      context.projectId,
      requireUuid(templateId),
      signal === undefined ? {} : { signal },
    );
  }

  public async listVersions(
    contextValue: StudioTeamTemplateSessionContext,
    templateId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudTeamTemplateVersionListResponse> {
    const context = this.requireRemote(contextValue, "read", options.signal);
    return this.remote.listTeamTemplateVersions(
      context.teamId,
      context.projectId,
      requireUuid(templateId),
      options,
    );
  }

  public async getVersion(
    contextValue: StudioTeamTemplateSessionContext,
    templateId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateVersionResponse> {
    const context = this.requireRemote(contextValue, "read", signal);
    return this.remote.getTeamTemplateVersion(
      context.teamId,
      context.projectId,
      requireUuid(templateId),
      requireUuid(versionId),
      signal === undefined ? {} : { signal },
    );
  }

  public async createTemplate(
    contextValue: StudioTeamTemplateSessionContext,
    request: CloudTeamTemplateCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateMutationResponse> {
    const context = this.requireRemote(contextValue, "create", options.signal);
    return this.remote.createTeamTemplate(context.teamId, context.projectId, request, options);
  }

  public async createVersion(
    contextValue: StudioTeamTemplateSessionContext,
    templateId: string,
    request: CloudTeamTemplateVersionCreateRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateMutationResponse> {
    const context = this.requireRemote(contextValue, "create_version", options.signal);
    return this.remote.createTeamTemplateVersion(
      context.teamId,
      context.projectId,
      requireUuid(templateId),
      request,
      options,
    );
  }

  public async cloneTemplate(
    contextValue: StudioTeamTemplateSessionContext,
    sourceTemplateId: string,
    request: CloudTeamTemplateCloneRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateMutationResponse> {
    const context = this.requireRemote(contextValue, "clone", options.signal);
    return this.remote.cloneTeamTemplate(
      context.teamId,
      context.projectId,
      requireUuid(sourceTemplateId),
      request,
      options,
    );
  }

  public async publishTemplate(
    contextValue: StudioTeamTemplateSessionContext,
    templateId: string,
    request: CloudTeamTemplatePublishRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateResponse> {
    const context = this.requireRemote(contextValue, "publish", options.signal);
    return this.remote.publishTeamTemplate(
      context.teamId,
      context.projectId,
      requireUuid(templateId),
      request,
      options,
    );
  }

  public async archiveTemplate(
    contextValue: StudioTeamTemplateSessionContext,
    templateId: string,
    request: CloudTeamTemplateArchiveRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateResponse> {
    const context = this.requireRemote(contextValue, "archive", options.signal);
    return this.remote.archiveTeamTemplate(
      context.teamId,
      context.projectId,
      requireUuid(templateId),
      request,
      options,
    );
  }

  public async recordApplication(
    contextValue: StudioTeamTemplateSessionContext,
    templateId: string,
    request: CloudTeamTemplateApplyRequest,
    options: CloudMutationOptions,
  ): Promise<CloudTeamTemplateApplicationResponse> {
    const context = this.requireRemote(contextValue, "apply", options.signal);
    return this.remote.recordTeamTemplateApplication(
      context.teamId,
      context.projectId,
      requireUuid(templateId),
      request,
      options,
    );
  }

  private requireRemote(
    contextValue: StudioTeamTemplateSessionContext,
    action: StudioTeamTemplateAction,
    signal?: AbortSignal,
  ): StudioTeamTemplateSessionContext {
    throwIfAborted(signal);
    const context = normalizeContext(contextValue);
    this.authorize(context, action);
    if (!this.connectivity.isOnline()) {
      throw new StudioTeamTemplateServiceError(
        "TEAM_TEMPLATE_OFFLINE",
        "Encrypted team-template cloud operations require an online connection.",
      );
    }
    return context;
  }
}

const ROLE_ACTIONS: Readonly<
  Record<StudioTeamTemplateRole, ReadonlySet<StudioTeamTemplateAction>>
> = {
  owner: new Set(["read", "create", "create_version", "clone", "apply", "publish", "archive"]),
  admin: new Set(["read", "create", "create_version", "clone", "apply", "publish", "archive"]),
  author: new Set(["read", "create", "create_version", "clone", "apply"]),
  reviewer: new Set(["read"]),
  read_only: new Set(["read"]),
  finance_admin: new Set(),
};

const NO_CAPABILITIES: StudioTeamTemplateCapabilities = Object.freeze({
  read: false,
  create: false,
  createVersion: false,
  clone: false,
  apply: false,
  publish: false,
  archive: false,
});

function normalizeContext(
  value: StudioTeamTemplateSessionContext,
): StudioTeamTemplateSessionContext {
  if (
    !Object.hasOwn(ROLE_ACTIONS, value.role) ||
    !["active", "revoked"].includes(value.membershipState) ||
    !["active", "revoked", "missing"].includes(value.assignmentState)
  ) {
    throw invalidScope();
  }
  return Object.freeze({
    tenantId: requireUuid(value.tenantId),
    teamId: requireUuid(value.teamId),
    projectId: requireUuid(value.projectId),
    membershipId: requireUuid(value.membershipId),
    deviceId: requireUuid(value.deviceId),
    role: value.role,
    membershipState: value.membershipState,
    assignmentState: value.assignmentState,
  });
}

function requireUuid(value: unknown): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw invalidScope();
  }
  return parsed.data.toLowerCase();
}

function invalidScope(): StudioTeamTemplateServiceError {
  return new StudioTeamTemplateServiceError(
    "TEAM_TEMPLATE_SCOPE_INVALID",
    "The Studio team-template tenant, team, project or membership scope is invalid.",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The Studio team-template operation was cancelled.", "AbortError");
  }
}
