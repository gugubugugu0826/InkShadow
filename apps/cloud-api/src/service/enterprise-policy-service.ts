import {
  CloudEnterprisePolicyEvaluationResponseSchema,
  CloudEnterprisePolicyResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudEnterprisePolicy,
  type CloudEnterprisePolicyDecisionReason,
  type CloudEnterprisePolicyEvaluationRequest,
  type CloudEnterprisePolicyEvaluationResponse,
  type CloudEnterprisePolicyResponse,
  type CloudEnterprisePolicyUpdateRequest,
  type CloudEnterpriseSsoStatusResponse,
} from "@inkshadow/contracts";

import type { CloudEnterprisePolicyRecord } from "../domain/enterprise-records.js";
import type {
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import {
  enterpriseLicenseIsCurrentlyValid,
  type EnterpriseConfiguration,
} from "../enterprise/configuration.js";
import type {
  CloudEnterpriseStore,
  CloudEnterpriseTransaction,
} from "../repository/enterprise-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  enterpriseLicenseInvalid,
  enterpriseLicenseRequired,
  enterprisePolicyRequired,
  idempotencyConflict,
  resourceNotFound,
  revisionConflict,
  sessionExpired,
  ssoNotConfigured,
  ssoRequired,
} from "./errors.js";
import type {
  CloudMutationContext,
  CloudPasswordLoginPolicy,
  CloudPrincipal,
  CloudReadContext,
} from "./identity-service.js";

interface AuthorizedEnterpriseScope {
  readonly actor: CloudTeamMembershipRecord;
  readonly team: CloudTeamRecord;
}

export interface CloudEnterprisePolicyServiceOptions {
  readonly clock?: () => Date;
  readonly configuration: EnterpriseConfiguration;
  readonly idempotencyLifetimeMs?: number;
  readonly store: CloudEnterpriseStore;
  readonly uuid: UuidV7Factory;
}

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export class CloudEnterprisePolicyService implements CloudPasswordLoginPolicy {
  private readonly clock: () => Date;
  private readonly configuration: EnterpriseConfiguration;
  private readonly idempotencyLifetimeMs: number;
  private readonly store: CloudEnterpriseStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudEnterprisePolicyServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.configuration = options.configuration;
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.store = options.store;
    this.uuid = options.uuid;
    if (
      !Number.isSafeInteger(this.idempotencyLifetimeMs) ||
      this.idempotencyLifetimeMs < 60_000 ||
      this.idempotencyLifetimeMs > 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new Error("Enterprise policy idempotency lifetime is invalid.");
    }
  }

  public async getPolicy(
    principal: CloudPrincipal,
    teamId: string,
    context: CloudReadContext,
  ): Promise<CloudEnterprisePolicyResponse> {
    const now = this.now();
    this.assertLicense(now, "enterprise.policy", teamId);
    return this.store.transaction(async (transaction) => {
      const scope = await this.requireScope(transaction, principal, teamId, now, false);
      const policy = await transaction.findPolicy(scope.team.tenantId, teamId);
      if (policy === null) {
        throw enterprisePolicyRequired();
      }
      return toPolicyResponse(policy, context.requestId);
    });
  }

  public async updatePolicy(
    principal: CloudPrincipal,
    teamId: string,
    request: CloudEnterprisePolicyUpdateRequest,
    context: CloudMutationContext,
  ): Promise<CloudEnterprisePolicyResponse> {
    const now = this.now();
    this.assertLicense(now, "enterprise.policy", teamId);
    if (
      request.ssoMode === "required" &&
      (!this.configuration.providers.has(teamId) || this.configuration.flowKey === null)
    ) {
      throw ssoNotConfigured();
    }
    const requestHash = hashCanonicalJson({ request, teamId });
    return this.store.transaction(async (transaction) => {
      const scope = await this.requireScope(transaction, principal, teamId, now, true);
      this.requireAdministrator(scope.actor);
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "enterprisePolicies.update",
        principal.accountId,
        context,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return replayPolicyResponse(
          existingIdempotency.responseSnapshot,
          context.requestId,
          teamId,
        );
      }
      const existing = await transaction.findPolicy(scope.team.tenantId, teamId, true);
      if (
        (existing === null && request.expectedRevision !== null) ||
        (existing !== null && request.expectedRevision !== existing.revision)
      ) {
        throw revisionConflict();
      }
      const policy: CloudEnterprisePolicyRecord = {
        tenantId: scope.team.tenantId,
        teamId,
        revision: (existing?.revision ?? 0) + 1,
        ssoMode: request.ssoMode,
        allowedEmailDomains: Object.freeze([...request.allowedEmailDomains]),
        sessionMaximumMinutes: request.sessionMaximumMinutes,
        maximumTrustedDevices: request.maximumTrustedDevices,
        deviceApprovalMode: request.deviceApprovalMode,
        approvedDeviceFingerprints: Object.freeze([...request.approvedDeviceFingerprints]),
        exportMode: request.exportMode,
        externalEgressMode: request.externalEgressMode,
        allowedExternalHosts: Object.freeze([...request.allowedExternalHosts]),
        supportBundleMode: request.supportBundleMode,
        createdByMembershipId: existing?.createdByMembershipId ?? scope.actor.membershipId,
        updatedByMembershipId: scope.actor.membershipId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing === null) {
        await transaction.insertPolicy(policy);
      } else if (!(await transaction.updatePolicyCas(policy, existing.revision))) {
        throw revisionConflict();
      }
      const response = toPolicyResponse(policy, context.requestId);
      await transaction.insertAuditEvent(
        this.audit({
          action: "enterprise.policy.updated",
          actor: scope.actor,
          context,
          now,
          reason: existing === null ? "policy_created" : "policy_revised",
          redactedDiff: {
            allowedDomainCount: policy.allowedEmailDomains.length,
            allowedExternalHostCount: policy.allowedExternalHosts.length,
            approvedDeviceCount: policy.approvedDeviceFingerprints.length,
            deviceApprovalMode: policy.deviceApprovalMode,
            exportMode: policy.exportMode,
            externalEgressMode: policy.externalEgressMode,
            maximumTrustedDevices: policy.maximumTrustedDevices,
            revisionFrom: existing?.revision ?? null,
            revisionTo: policy.revision,
            sessionMaximumMinutes: policy.sessionMaximumMinutes,
            ssoMode: policy.ssoMode,
            supportBundleMode: policy.supportBundleMode,
          },
          result: "allowed",
          team: scope.team,
        }),
      );
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "enterprisePolicies.update",
        requestHash,
        response,
        teamId,
      });
      return response;
    });
  }

  public async evaluatePolicy(
    principal: CloudPrincipal,
    teamId: string,
    request: CloudEnterprisePolicyEvaluationRequest,
    context: CloudMutationContext,
  ): Promise<CloudEnterprisePolicyEvaluationResponse> {
    const now = this.now();
    this.assertLicense(now, "enterprise.policy", teamId);
    const requestHash = hashCanonicalJson({ request, teamId });
    return this.store.transaction(async (transaction) => {
      const scope = await this.requireScope(transaction, principal, teamId, now, false);
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "enterprisePolicies.evaluate",
        principal.accountId,
        context,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return replayEvaluationResponse(
          existingIdempotency.responseSnapshot,
          context.requestId,
          teamId,
        );
      }
      const policy = await transaction.findPolicy(scope.team.tenantId, teamId);
      if (policy === null) {
        throw enterprisePolicyRequired();
      }
      const reason = await this.evaluate(transaction, principal, scope.actor, policy, request);
      const response = CloudEnterprisePolicyEvaluationResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        tenantId: policy.tenantId,
        teamId,
        policyRevision: policy.revision,
        action: request.action,
        allowed: reason === "allowed",
        reason,
      });
      await transaction.insertAuditEvent(
        this.audit({
          action: `enterprise.policy.evaluate.${request.action}`,
          actor: scope.actor,
          context,
          now,
          reason,
          redactedDiff: {
            action: request.action,
            externalHostProvided: request.externalHost !== null,
            policyRevision: policy.revision,
          },
          result: reason === "allowed" ? "allowed" : "denied",
          team: scope.team,
        }),
      );
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "enterprisePolicies.evaluate",
        requestHash,
        response,
        teamId,
      });
      return response;
    });
  }

  public async getSsoStatus(
    principal: CloudPrincipal,
    teamId: string,
    context: CloudReadContext,
  ): Promise<CloudEnterpriseSsoStatusResponse> {
    const now = this.now();
    this.assertLicense(now, "enterprise.sso", teamId);
    const provider = this.configuration.providers.get(teamId);
    if (provider === undefined || this.configuration.flowKey === null) {
      throw ssoNotConfigured();
    }
    return this.store.transaction(async (transaction) => {
      const scope = await this.requireScope(transaction, principal, teamId, now, false);
      this.requireAdministrator(scope.actor);
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        teamId,
        configured: true,
        issuer: provider.issuer,
        allowedRedirectUris: [...provider.redirectUris],
        metadataCacheSeconds: this.configuration.metadataCacheMs / 1_000,
        licenseValidUntil: this.requireLicense().validUntil,
      };
    });
  }

  public async assertPasswordLoginAllowed(input: {
    readonly accountId: string;
    readonly emailCanonical: string;
  }): Promise<void> {
    const now = this.now();
    const requiredTeams = await this.store.transaction((transaction) =>
      transaction.findRequiredSsoTeams(input.accountId),
    );
    if (requiredTeams.length === 0) {
      return;
    }
    for (const team of requiredTeams) {
      this.assertLicense(now, "enterprise.sso", team.teamId);
      if (!this.configuration.providers.has(team.teamId) || this.configuration.flowKey === null) {
        throw ssoNotConfigured();
      }
    }
    throw ssoRequired();
  }

  private async evaluate(
    transaction: CloudEnterpriseTransaction,
    principal: CloudPrincipal,
    actor: CloudTeamMembershipRecord,
    policy: CloudEnterprisePolicyRecord,
    request: CloudEnterprisePolicyEvaluationRequest,
  ): Promise<CloudEnterprisePolicyDecisionReason> {
    switch (request.action) {
      case "create_session": {
        const device = await transaction.findTrustedDevice(principal.accountId, principal.deviceId);
        if (
          device === null ||
          (policy.deviceApprovalMode === "approved_fingerprint" &&
            !policy.approvedDeviceFingerprints.includes(device.publicKeyFingerprint))
        ) {
          return "device_not_approved";
        }
        return (await transaction.countTrustedDevices(principal.accountId)) >
          policy.maximumTrustedDevices
          ? "device_limit_exceeded"
          : "allowed";
      }
      case "export":
        if (policy.exportMode === "blocked") {
          return "export_blocked";
        }
        return policy.exportMode === "owners_and_admins" &&
          actor.role !== "owner" &&
          actor.role !== "admin"
          ? "export_role_forbidden"
          : "allowed";
      case "external_egress":
        if (policy.externalEgressMode === "blocked") {
          return "external_egress_blocked";
        }
        return request.externalHost !== null &&
          policy.allowedExternalHosts.includes(request.externalHost)
          ? "allowed"
          : "external_host_not_allowlisted";
      case "support_bundle":
        return policy.supportBundleMode === "owners_and_admins" &&
          actor.role !== "owner" &&
          actor.role !== "admin"
          ? "support_role_forbidden"
          : "allowed";
    }
  }

  private async requireScope(
    transaction: CloudEnterpriseTransaction,
    principal: CloudPrincipal,
    teamId: string,
    now: Date,
    forUpdate: boolean,
  ): Promise<AuthorizedEnterpriseScope> {
    await transaction.setPrincipal(principal.accountId, principal.deviceId);
    if (!(await transaction.assertPrincipalActive(principal, now))) {
      throw sessionExpired();
    }
    await transaction.clearTeamScope();
    const discovered = await transaction.findActiveMembershipForAccount(
      principal.accountId,
      teamId,
    );
    if (discovered === null) {
      throw resourceNotFound();
    }
    await transaction.setTeamScope(discovered.tenantId, teamId);
    const team = await transaction.findTeam(discovered.tenantId, teamId, forUpdate);
    const actor = await transaction.findMembership(
      discovered.tenantId,
      teamId,
      discovered.membershipId,
      forUpdate,
    );
    if (team?.state !== "active" || actor?.state !== "active") {
      throw resourceNotFound();
    }
    return { actor, team };
  }

  private requireAdministrator(actor: CloudTeamMembershipRecord): void {
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw accessForbidden();
    }
  }

  private assertLicense(
    now: Date,
    capability: "enterprise.policy" | "enterprise.sso",
    teamId: string,
  ): void {
    if (this.configuration.license === null) {
      throw enterpriseLicenseRequired();
    }
    if (!enterpriseLicenseIsCurrentlyValid(this.configuration, now, capability, teamId)) {
      throw enterpriseLicenseInvalid();
    }
  }

  private requireLicense() {
    const license = this.configuration.license;
    if (license === null) {
      throw enterpriseLicenseRequired();
    }
    return license;
  }

  private async findIdempotency(
    transaction: CloudEnterpriseTransaction,
    operationId: "enterprisePolicies.evaluate" | "enterprisePolicies.update",
    actorAccountId: string,
    context: CloudMutationContext,
    requestHash: string,
    now: Date,
  ) {
    const scopeHashSha256 = createIdempotencyScopeHash({
      actorAccountId,
      idempotencyKey: context.idempotencyKey,
      operationId,
    });
    await transaction.lockIdempotency(scopeHashSha256);
    const existing = await transaction.findIdempotency(scopeHashSha256);
    if (existing === null) {
      return null;
    }
    if (
      existing.actorAccountId !== actorAccountId ||
      existing.operationId !== operationId ||
      existing.requestHashSha256 !== requestHash ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private async insertIdempotency(
    transaction: CloudEnterpriseTransaction,
    options: {
      readonly actorAccountId: string;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: "enterprisePolicies.evaluate" | "enterprisePolicies.update";
      readonly requestHash: string;
      readonly response: unknown;
      readonly teamId: string;
    },
  ): Promise<void> {
    await transaction.insertIdempotency({
      actorAccountId: options.actorAccountId,
      createdAt: options.now,
      expiresAt: new Date(options.now.getTime() + this.idempotencyLifetimeMs),
      idempotencyKeyHashSha256: hashUtf8(options.context.idempotencyKey),
      operationId: options.operationId,
      requestHashSha256: options.requestHash,
      responseSnapshot: options.response,
      responseStatus: 200,
      resultDigestSha256: hashCanonicalJson(options.response),
      resultKind: "team",
      resultResourceId: options.teamId,
      scopeHashSha256: createIdempotencyScopeHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
      }),
    });
  }

  private audit(options: {
    readonly action: string;
    readonly actor: CloudTeamMembershipRecord;
    readonly context: CloudReadContext;
    readonly now: Date;
    readonly reason: string;
    readonly redactedDiff: Readonly<Record<string, unknown>>;
    readonly result: CloudTeamAuditEventRecord["result"];
    readonly team: CloudTeamRecord;
  }): CloudTeamAuditEventRecord {
    return {
      action: options.action,
      actorAccountId: options.actor.accountId,
      actorMembershipId: options.actor.membershipId,
      createdAt: options.now,
      eventId: this.uuid(),
      reason: options.reason,
      redactedDiff: options.redactedDiff,
      requestId: options.context.requestId,
      resourceId: options.team.teamId,
      resourceType: "team",
      result: options.result,
      teamId: options.team.teamId,
      tenantId: options.team.tenantId,
    };
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The Enterprise policy clock returned an invalid timestamp.");
    }
    return new Date(value);
  }
}

function toPolicyResponse(
  record: CloudEnterprisePolicyRecord,
  requestId: string,
): CloudEnterprisePolicyResponse {
  return CloudEnterprisePolicyResponseSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    policy: toPolicy(record),
  });
}

function toPolicy(record: CloudEnterprisePolicyRecord): CloudEnterprisePolicy {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: record.tenantId,
    teamId: record.teamId,
    revision: record.revision,
    ssoMode: record.ssoMode,
    allowedEmailDomains: [...record.allowedEmailDomains],
    sessionMaximumMinutes: record.sessionMaximumMinutes,
    maximumTrustedDevices: record.maximumTrustedDevices,
    deviceApprovalMode: record.deviceApprovalMode,
    approvedDeviceFingerprints: [...record.approvedDeviceFingerprints],
    exportMode: record.exportMode,
    externalEgressMode: record.externalEgressMode,
    allowedExternalHosts: [...record.allowedExternalHosts],
    supportBundleMode: record.supportBundleMode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function replayPolicyResponse(
  snapshot: unknown,
  requestId: string,
  teamId: string,
): CloudEnterprisePolicyResponse {
  const parsed = CloudEnterprisePolicyResponseSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.policy.teamId !== teamId) {
    throw new Error("The Enterprise policy idempotency snapshot is invalid.");
  }
  return { ...parsed.data, requestId };
}

function replayEvaluationResponse(
  snapshot: unknown,
  requestId: string,
  teamId: string,
): CloudEnterprisePolicyEvaluationResponse {
  const parsed = CloudEnterprisePolicyEvaluationResponseSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.teamId !== teamId) {
    throw new Error("The Enterprise policy-evaluation idempotency snapshot is invalid.");
  }
  return { ...parsed.data, requestId };
}
