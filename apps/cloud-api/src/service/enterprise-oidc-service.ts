import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  CloudEnterpriseSsoAuthorizationResponseSchema,
  CloudEnterpriseSsoSessionResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudEnterpriseSsoAuthorizationRequest,
  type CloudEnterpriseSsoAuthorizationResponse,
  type CloudEnterpriseSsoCallbackRequest,
  type CloudEnterpriseSsoSessionResponse,
} from "@inkshadow/contracts";

import type {
  CloudEnterpriseOidcFlowRecord,
  CloudEnterprisePublicSsoPolicyRecord,
} from "../domain/enterprise-records.js";
import type { CloudTeamAuditEventRecord } from "../domain/team-records.js";
import {
  enterpriseLicenseIsCurrentlyValid,
  type EnterpriseConfiguration,
  type EnterpriseOidcProviderConfiguration,
} from "../enterprise/configuration.js";
import {
  OidcProviderUnavailableError,
  OidcTokenValidationError,
  type EnterpriseOidcClient,
  type OidcDiscoveryMetadata,
  type VerifiedOidcIdentity,
} from "../enterprise/oidc-client.js";
import type {
  CloudEnterpriseStore,
  CloudEnterpriseTransaction,
} from "../repository/enterprise-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import { verifyDevicePublicKey } from "../security/device-public-key.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  enterpriseLicenseInvalid,
  enterpriseLicenseRequired,
  enterprisePolicyRequired,
  idempotencyConflict,
  resourceNotFound,
  ssoCallbackInProgress,
  ssoDeviceNotApproved,
  ssoDomainForbidden,
  ssoFlowExpired,
  ssoFlowReplayed,
  ssoMembershipRequired,
  ssoNotConfigured,
  ssoProviderUnavailable,
  ssoStateInvalid,
  ssoTokenInvalid,
  validationFailed,
} from "./errors.js";
import type { CloudIdentityService, CloudMutationContext } from "./identity-service.js";

export interface CloudEnterpriseOidcServiceOptions {
  readonly claimLeaseMs?: number;
  readonly clock?: () => Date;
  readonly configuration: EnterpriseConfiguration;
  readonly idempotencyLifetimeMs?: number;
  readonly identityService: CloudIdentityService;
  readonly oidcClient: EnterpriseOidcClient;
  readonly store: CloudEnterpriseStore;
  readonly uuid: UuidV7Factory;
}

interface FlowSecrets {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

interface ClaimedFlow {
  readonly kind: "claimed";
  readonly claimId: string;
  readonly flow: CloudEnterpriseOidcFlowRecord;
  readonly policy: CloudEnterprisePublicSsoPolicyRecord;
  readonly provider: EnterpriseOidcProviderConfiguration;
}

interface ReplayFlow {
  readonly kind: "replay";
  readonly flow: CloudEnterpriseOidcFlowRecord & {
    readonly verifiedAccountId: string;
  };
}

type FlowClaim = ClaimedFlow | ReplayFlow;

interface StartSnapshot {
  readonly snapshotKind: "enterprise_oidc_authorization_v1";
  readonly flowId: string;
  readonly teamId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const MAXIMUM_FLOW_ATTEMPTS = 5;

export class CloudEnterpriseOidcService {
  private readonly claimLeaseMs: number;
  private readonly clock: () => Date;
  private readonly configuration: EnterpriseConfiguration;
  private readonly idempotencyLifetimeMs: number;
  private readonly identityService: CloudIdentityService;
  private readonly oidcClient: EnterpriseOidcClient;
  private readonly store: CloudEnterpriseStore;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudEnterpriseOidcServiceOptions) {
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.clock = options.clock ?? (() => new Date());
    this.configuration = options.configuration;
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.identityService = options.identityService;
    this.oidcClient = options.oidcClient;
    this.store = options.store;
    this.uuid = options.uuid;
    if (
      !Number.isSafeInteger(this.claimLeaseMs) ||
      this.claimLeaseMs < 5_000 ||
      this.claimLeaseMs > 120_000 ||
      !Number.isSafeInteger(this.idempotencyLifetimeMs) ||
      this.idempotencyLifetimeMs < 60_000 ||
      this.idempotencyLifetimeMs > 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new Error("Enterprise OIDC service lifetimes are invalid.");
    }
  }

  public async authorize(
    request: CloudEnterpriseSsoAuthorizationRequest,
    context: CloudMutationContext,
  ): Promise<CloudEnterpriseSsoAuthorizationResponse> {
    const now = this.now();
    const provider = this.requireProvider(request.teamId, now);
    if (!provider.redirectUris.includes(request.redirectUri)) {
      throw ssoStateInvalid();
    }
    if (
      !verifyDevicePublicKey({
        publicKey: request.device.publicKey,
        publicKeyFingerprint: request.device.publicKeyFingerprint,
      })
    ) {
      throw validationFailed("The device public key or fingerprint is invalid.");
    }
    const metadata = await this.discover(provider);
    const requestHash = hashCanonicalJson({ request, teamId: request.teamId });
    const flowSecret = this.deriveAuthorizationFlowSecret(context.idempotencyKey, requestHash);
    const secrets = this.deriveFlowSecrets(flowSecret);
    const authorizationUrl = buildAuthorizationUrl(
      metadata,
      provider,
      request.redirectUri,
      secrets,
    );
    const deviceBindingHashSha256 = hashCanonicalJson(request.device);
    const expiresAt = new Date(now.getTime() + this.configuration.flowLifetimeMs);

    return this.store.transaction(async (transaction) => {
      const policy = await transaction.findPublicSsoPolicy(request.teamId);
      if (policy === null) {
        throw enterprisePolicyRequired();
      }
      this.requireDeviceApproved(policy, request.device.publicKeyFingerprint);
      await transaction.setTeamScope(policy.tenantId, policy.teamId);
      const existing = await this.findStartIdempotency(transaction, context, requestHash, now);
      if (existing !== null) {
        const snapshot = parseStartSnapshot(existing.responseSnapshot, request.teamId);
        const flow = await transaction.findOidcFlow(
          policy.tenantId,
          policy.teamId,
          snapshot.flowId,
        );
        if (flow === null) {
          throw new Error("The Enterprise OIDC authorization replay is inconsistent.");
        }
        if (
          flow.flowSecretHashSha256 !== hashUtf8(flowSecret) ||
          flow.deviceBindingHashSha256 !== deviceBindingHashSha256 ||
          flow.redirectUri !== request.redirectUri
        ) {
          throw new Error("The Enterprise OIDC authorization replay is inconsistent.");
        }
        return CloudEnterpriseSsoAuthorizationResponseSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: context.requestId,
          teamId: request.teamId,
          flowId: flow.flowId,
          flowSecret,
          authorizationUrl: snapshot.authorizationUrl,
          expiresAt: snapshot.expiresAt,
        });
      }
      const flow: CloudEnterpriseOidcFlowRecord = {
        tenantId: policy.tenantId,
        teamId: policy.teamId,
        flowId: this.uuid(),
        policyRevision: policy.revision,
        sessionMaximumMinutes: policy.sessionMaximumMinutes,
        maximumTrustedDevices: policy.maximumTrustedDevices,
        flowSecretHashSha256: hashUtf8(flowSecret),
        stateHashSha256: hashUtf8(secrets.state),
        redirectUri: request.redirectUri,
        deviceBindingHashSha256,
        exchangeClaimId: null,
        exchangeStartedAt: null,
        attemptCount: 0,
        verifiedAccountId: null,
        verifiedMembershipId: null,
        subjectHashSha256: null,
        completionIdempotencyKeyHashSha256: null,
        expiresAt,
        consumedAt: null,
        createdAt: now,
      };
      await transaction.insertOidcFlow(flow);
      const response = CloudEnterpriseSsoAuthorizationResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: context.requestId,
        teamId: request.teamId,
        flowId: flow.flowId,
        flowSecret,
        authorizationUrl,
        expiresAt: expiresAt.toISOString(),
      });
      const snapshot: StartSnapshot = {
        snapshotKind: "enterprise_oidc_authorization_v1",
        flowId: flow.flowId,
        teamId: request.teamId,
        authorizationUrl,
        expiresAt: expiresAt.toISOString(),
      };
      await transaction.insertIdempotency({
        actorAccountId: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.idempotencyLifetimeMs),
        idempotencyKeyHashSha256: hashUtf8(context.idempotencyKey),
        operationId: "enterpriseSso.authorize",
        requestHashSha256: requestHash,
        responseSnapshot: snapshot,
        responseStatus: 201,
        resultDigestSha256: hashCanonicalJson(response),
        resultKind: "accepted",
        resultResourceId: flow.flowId,
        scopeHashSha256: createIdempotencyScopeHash({
          actorAccountId: null,
          idempotencyKey: context.idempotencyKey,
          operationId: "enterpriseSso.authorize",
        }),
      });
      return response;
    });
  }

  public async complete(
    request: CloudEnterpriseSsoCallbackRequest,
    context: CloudMutationContext,
  ): Promise<CloudEnterpriseSsoSessionResponse> {
    if (
      !verifyDevicePublicKey({
        publicKey: request.device.publicKey,
        publicKeyFingerprint: request.device.publicKeyFingerprint,
      })
    ) {
      throw validationFailed("The device public key or fingerprint is invalid.");
    }
    const now = this.now();
    const flowSecretHashSha256 = hashUtf8(request.flowSecret);
    const secrets = this.deriveFlowSecrets(request.flowSecret);
    const stateHashSha256 = hashUtf8(request.state);
    const deviceBindingHashSha256 = hashCanonicalJson(request.device);
    const completionIdempotencyKeyHashSha256 = hashUtf8(context.idempotencyKey);
    const claim = await this.claimFlow({
      completionIdempotencyKeyHashSha256,
      deviceBindingHashSha256,
      deviceFingerprint: request.device.publicKeyFingerprint,
      flowSecretHashSha256,
      now,
      redirectUri: request.redirectUri,
      stateHashSha256,
      flowId: request.flowId,
    });

    let verifiedAccountId: string;
    let flow: CloudEnterpriseOidcFlowRecord;
    if (claim.kind === "replay") {
      verifiedAccountId = claim.flow.verifiedAccountId;
      flow = claim.flow;
    } else {
      const verified = await this.exchangeAndVerify(claim, request, secrets).catch(
        async (error: unknown) => {
          await this.releaseClaim(claim.flow, claim.claimId);
          throw error;
        },
      );
      const domain = emailDomain(verified.emailCanonical);
      if (!claim.policy.allowedEmailDomains.includes(domain)) {
        await this.releaseClaim(claim.flow, claim.claimId);
        throw ssoDomainForbidden();
      }
      const completed = await this.finalizeFlow(
        claim,
        verified,
        completionIdempotencyKeyHashSha256,
        context,
        now,
      ).catch(async (error: unknown) => {
        await this.releaseClaim(claim.flow, claim.claimId);
        throw error;
      });
      verifiedAccountId = completed.verifiedAccountId;
      flow = completed;
    }

    const grant = await this.identityService.issueEnterpriseOidcSession(
      {
        accountId: verifiedAccountId,
        device: request.device,
        maximumTrustedDevices: flow.maximumTrustedDevices,
        sessionMaximumMinutes: flow.sessionMaximumMinutes,
        teamId: flow.teamId,
        policyRevision: flow.policyRevision,
      },
      context,
    );
    return CloudEnterpriseSsoSessionResponseSchema.parse({
      ...grant,
      enterprise: {
        authenticationMethod: "oidc",
        policyRevision: flow.policyRevision,
        teamId: flow.teamId,
      },
    });
  }

  private async claimFlow(options: {
    readonly completionIdempotencyKeyHashSha256: string;
    readonly deviceBindingHashSha256: string;
    readonly deviceFingerprint: string;
    readonly flowId: string;
    readonly flowSecretHashSha256: string;
    readonly now: Date;
    readonly redirectUri: string;
    readonly stateHashSha256: string;
  }): Promise<FlowClaim> {
    return this.store.transaction(async (transaction) => {
      const scope = await transaction.resolveOidcFlowScope(options.flowId);
      if (scope === null) {
        throw ssoStateInvalid();
      }
      this.requireProvider(scope.teamId, options.now);
      await transaction.setTeamScope(scope.tenantId, scope.teamId);
      const flow = await transaction.findOidcFlow(
        scope.tenantId,
        scope.teamId,
        options.flowId,
        true,
      );
      if (flow === null) {
        throw ssoStateInvalid();
      }
      this.requireFlowBinding(flow, options);
      if (flow.consumedAt !== null) {
        if (
          flow.completionIdempotencyKeyHashSha256 === options.completionIdempotencyKeyHashSha256 &&
          flow.verifiedAccountId !== null
        ) {
          return {
            kind: "replay",
            flow: {
              ...flow,
              verifiedAccountId: flow.verifiedAccountId,
            },
          };
        }
        throw ssoFlowReplayed();
      }
      if (flow.expiresAt.getTime() <= options.now.getTime()) {
        throw ssoFlowExpired();
      }
      const policy = await transaction.findPublicSsoPolicy(flow.teamId);
      if (policy === null) {
        throw ssoStateInvalid();
      }
      if (policy.revision !== flow.policyRevision) {
        throw ssoStateInvalid();
      }
      this.requireDeviceApproved(policy, options.deviceFingerprint);
      if (
        flow.exchangeStartedAt !== null &&
        flow.exchangeStartedAt.getTime() + this.claimLeaseMs > options.now.getTime()
      ) {
        throw ssoCallbackInProgress();
      }
      if (flow.attemptCount >= MAXIMUM_FLOW_ATTEMPTS) {
        throw ssoStateInvalid();
      }
      const claimId = this.uuid();
      const claimed: CloudEnterpriseOidcFlowRecord = {
        ...flow,
        attemptCount: flow.attemptCount + 1,
        exchangeClaimId: claimId,
        exchangeStartedAt: options.now,
      };
      await transaction.updateOidcFlow(claimed);
      return {
        kind: "claimed",
        claimId,
        flow: claimed,
        policy,
        provider: this.requireProvider(flow.teamId, options.now),
      };
    });
  }

  private async exchangeAndVerify(
    claim: ClaimedFlow,
    request: CloudEnterpriseSsoCallbackRequest,
    secrets: FlowSecrets,
  ): Promise<VerifiedOidcIdentity> {
    try {
      return await this.oidcClient.exchangeAndVerify({
        provider: claim.provider,
        code: request.code,
        redirectUri: request.redirectUri,
        codeVerifier: secrets.codeVerifier,
        expectedNonce: secrets.nonce,
      });
    } catch (error: unknown) {
      if (error instanceof OidcProviderUnavailableError) {
        throw ssoProviderUnavailable();
      }
      if (error instanceof OidcTokenValidationError) {
        throw ssoTokenInvalid();
      }
      throw error;
    }
  }

  private async finalizeFlow(
    claim: ClaimedFlow,
    verified: VerifiedOidcIdentity,
    completionIdempotencyKeyHashSha256: string,
    context: CloudMutationContext,
    now: Date,
  ): Promise<CloudEnterpriseOidcFlowRecord & { readonly verifiedAccountId: string }> {
    return this.store.transaction(async (transaction) => {
      const scope = await transaction.resolveOidcFlowScope(claim.flow.flowId);
      if (scope === null) {
        throw resourceNotFound();
      }
      await transaction.setTeamScope(scope.tenantId, scope.teamId);
      const flow = await transaction.findOidcFlow(
        scope.tenantId,
        scope.teamId,
        claim.flow.flowId,
        true,
      );
      if (flow === null) {
        throw ssoFlowReplayed();
      }
      if (flow.consumedAt !== null || flow.exchangeClaimId !== claim.claimId) {
        throw ssoFlowReplayed();
      }
      const member = await transaction.resolveMember(claim.flow.teamId, verified.emailCanonical);
      if (member === null) {
        throw ssoMembershipRequired();
      }
      if (member.tenantId !== flow.tenantId || member.teamId !== flow.teamId) {
        throw ssoMembershipRequired();
      }
      const issuerHashSha256 = hashUtf8(verified.issuer);
      const subjectHashSha256 = this.hashProviderSubject(verified.issuer, verified.subject);
      const subjectBinding = await transaction.findOidcBinding(
        flow.tenantId,
        flow.teamId,
        issuerHashSha256,
        subjectHashSha256,
        true,
      );
      const accountBinding = await transaction.findOidcBindingForAccount(
        flow.tenantId,
        flow.teamId,
        issuerHashSha256,
        member.accountId,
        true,
      );
      if (
        (subjectBinding !== null && subjectBinding.accountId !== member.accountId) ||
        (accountBinding !== null && accountBinding.subjectHashSha256 !== subjectHashSha256)
      ) {
        throw ssoTokenInvalid();
      }
      if (subjectBinding === null) {
        await transaction.insertOidcBinding({
          tenantId: flow.tenantId,
          teamId: flow.teamId,
          issuerHashSha256,
          subjectHashSha256,
          accountId: member.accountId,
          membershipId: member.membershipId,
          createdAt: now,
          lastAuthenticatedAt: now,
        });
      } else {
        await transaction.updateOidcBinding({
          ...subjectBinding,
          membershipId: member.membershipId,
          lastAuthenticatedAt: now,
        });
      }
      const completed: CloudEnterpriseOidcFlowRecord & {
        readonly verifiedAccountId: string;
      } = {
        ...flow,
        exchangeClaimId: null,
        exchangeStartedAt: null,
        verifiedAccountId: member.accountId,
        verifiedMembershipId: member.membershipId,
        subjectHashSha256,
        completionIdempotencyKeyHashSha256,
        consumedAt: now,
      };
      await transaction.updateOidcFlow(completed);
      await transaction.insertAuditEvent(
        oidcAuditEvent({
          context,
          eventId: this.uuid(),
          flow: completed,
          member,
          now,
        }),
      );
      return completed;
    });
  }

  private async releaseClaim(
    original: CloudEnterpriseOidcFlowRecord,
    claimId: string,
  ): Promise<void> {
    try {
      await this.store.transaction(async (transaction) => {
        await transaction.setTeamScope(original.tenantId, original.teamId);
        const flow = await transaction.findOidcFlow(
          original.tenantId,
          original.teamId,
          original.flowId,
          true,
        );
        if (flow !== null && flow.consumedAt === null && flow.exchangeClaimId === claimId) {
          await transaction.updateOidcFlow({
            ...flow,
            exchangeClaimId: null,
            exchangeStartedAt: null,
          });
        }
      });
    } catch {
      // Preserve the original callback error. The claim lease bounds crash recovery.
    }
  }

  private requireFlowBinding(
    flow: CloudEnterpriseOidcFlowRecord,
    options: {
      readonly deviceBindingHashSha256: string;
      readonly flowSecretHashSha256: string;
      readonly redirectUri: string;
      readonly stateHashSha256: string;
    },
  ): void {
    if (
      !constantTimeHexEqual(flow.flowSecretHashSha256, options.flowSecretHashSha256) ||
      !constantTimeHexEqual(flow.stateHashSha256, options.stateHashSha256) ||
      !constantTimeHexEqual(flow.deviceBindingHashSha256, options.deviceBindingHashSha256) ||
      flow.redirectUri !== options.redirectUri
    ) {
      throw ssoStateInvalid();
    }
  }

  private requireProvider(teamId: string, now: Date): EnterpriseOidcProviderConfiguration {
    if (this.configuration.license === null) {
      throw enterpriseLicenseRequired();
    }
    if (!enterpriseLicenseIsCurrentlyValid(this.configuration, now, "enterprise.sso", teamId)) {
      throw enterpriseLicenseInvalid();
    }
    const provider = this.configuration.providers.get(teamId);
    if (provider === undefined || this.configuration.flowKey === null) {
      throw ssoNotConfigured();
    }
    return provider;
  }

  private requireDeviceApproved(
    policy: CloudEnterprisePublicSsoPolicyRecord,
    fingerprint: string,
  ): void {
    if (
      policy.deviceApprovalMode === "approved_fingerprint" &&
      !policy.approvedDeviceFingerprints.includes(fingerprint)
    ) {
      throw ssoDeviceNotApproved();
    }
  }

  private async findStartIdempotency(
    transaction: CloudEnterpriseTransaction,
    context: CloudMutationContext,
    requestHash: string,
    now: Date,
  ) {
    const scopeHashSha256 = createIdempotencyScopeHash({
      actorAccountId: null,
      idempotencyKey: context.idempotencyKey,
      operationId: "enterpriseSso.authorize",
    });
    await transaction.lockIdempotency(scopeHashSha256);
    const existing = await transaction.findIdempotency(scopeHashSha256);
    if (existing === null) {
      return null;
    }
    if (
      existing.actorAccountId !== null ||
      existing.operationId !== "enterpriseSso.authorize" ||
      existing.requestHashSha256 !== requestHash ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private deriveAuthorizationFlowSecret(idempotencyKey: string, requestHash: string): string {
    return this.hmac("authorization-flow", `${idempotencyKey}\u0000${requestHash}`);
  }

  private deriveFlowSecrets(flowSecret: string): FlowSecrets {
    const state = this.hmac("state", flowSecret);
    const nonce = this.hmac("nonce", flowSecret);
    const codeVerifier = this.hmac("pkce-verifier", flowSecret);
    const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
    return { state, nonce, codeVerifier, codeChallenge };
  }

  private hashProviderSubject(issuer: string, subject: string): string {
    return this.hmac("provider-subject", `${issuer}\u0000${subject}`, "hex");
  }

  private hmac(label: string, value: string, encoding: "base64url" | "hex" = "base64url"): string {
    const flowKey = this.configuration.flowKey;
    if (flowKey === null) {
      throw ssoNotConfigured();
    }
    return createHmac("sha256", flowKey)
      .update(`inkshadow.enterprise-oidc.${label}.v1`, "utf8")
      .update("\u0000", "utf8")
      .update(value, "utf8")
      .digest(encoding);
  }

  private async discover(
    provider: EnterpriseOidcProviderConfiguration,
  ): Promise<OidcDiscoveryMetadata> {
    try {
      return await this.oidcClient.discover(provider);
    } catch (error: unknown) {
      if (error instanceof OidcProviderUnavailableError) {
        throw ssoProviderUnavailable();
      }
      if (error instanceof OidcTokenValidationError) {
        throw ssoTokenInvalid();
      }
      throw error;
    }
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The Enterprise OIDC service clock returned an invalid time.");
    }
    return new Date(value);
  }
}

function buildAuthorizationUrl(
  metadata: OidcDiscoveryMetadata,
  provider: EnterpriseOidcProviderConfiguration,
  redirectUri: string,
  secrets: FlowSecrets,
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("code_challenge", secrets.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", secrets.nonce);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", secrets.state);
  const serialized = url.toString();
  if (serialized.length > 4_096) {
    throw ssoNotConfigured();
  }
  return serialized;
}

function parseStartSnapshot(value: unknown, teamId: string): StartSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("snapshotKind" in value) ||
    value.snapshotKind !== "enterprise_oidc_authorization_v1" ||
    !("flowId" in value) ||
    typeof value.flowId !== "string" ||
    !("teamId" in value) ||
    value.teamId !== teamId ||
    !("authorizationUrl" in value) ||
    typeof value.authorizationUrl !== "string" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("The Enterprise OIDC authorization snapshot is invalid.");
  }
  return {
    snapshotKind: "enterprise_oidc_authorization_v1",
    flowId: value.flowId,
    teamId,
    authorizationUrl: value.authorizationUrl,
    expiresAt: value.expiresAt,
  };
}

function oidcAuditEvent(options: {
  readonly context: CloudMutationContext;
  readonly eventId: string;
  readonly flow: CloudEnterpriseOidcFlowRecord;
  readonly member: {
    readonly accountId: string;
    readonly membershipId: string;
    readonly teamId: string;
    readonly tenantId: string;
  };
  readonly now: Date;
}): CloudTeamAuditEventRecord {
  return {
    action: "enterprise.sso.identity_verified",
    actorAccountId: options.member.accountId,
    actorMembershipId: options.member.membershipId,
    createdAt: options.now,
    eventId: options.eventId,
    reason: "oidc_claims_verified",
    redactedDiff: {
      authenticationMethod: "oidc",
      policyRevision: options.flow.policyRevision,
    },
    requestId: options.context.requestId,
    resourceId: options.flow.teamId,
    resourceType: "team",
    result: "allowed",
    teamId: options.member.teamId,
    tenantId: options.member.tenantId,
  };
}

function emailDomain(emailCanonical: string): string {
  const separator = emailCanonical.lastIndexOf("@");
  if (separator < 1 || separator === emailCanonical.length - 1) {
    throw ssoTokenInvalid();
  }
  return emailCanonical.slice(separator + 1);
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
