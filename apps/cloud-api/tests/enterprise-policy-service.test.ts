import { describe, expect, it, vi, type Mock } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import type { CloudEnterprisePolicyRecord } from "../src/domain/enterprise-records.js";
import type { CloudTeamMembershipRecord, CloudTeamRecord } from "../src/domain/team-records.js";
import type { EnterpriseConfiguration } from "../src/enterprise/configuration.js";
import type {
  CloudEnterpriseStore,
  CloudEnterpriseTransaction,
} from "../src/repository/enterprise-store.js";
import type { CloudPrincipal } from "../src/service/identity-service.js";
import { CloudEnterprisePolicyService } from "../src/service/enterprise-policy-service.js";

const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const SESSION_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const EVENT_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const NOW = new Date("2026-07-28T00:00:00.000Z");

describe("Enterprise policy service", () => {
  it("creates a revision-bound policy and emits redacted audit/idempotency records", async () => {
    const transaction = transactionFixture("owner");
    const service = policyService(transaction);
    const response = await service.updatePolicy(
      principal(),
      TEAM_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        ssoMode: "required",
        allowedEmailDomains: ["example.com"],
        sessionMaximumMinutes: 480,
        maximumTrustedDevices: 3,
        deviceApprovalMode: "trusted_device",
        approvedDeviceFingerprints: [],
        exportMode: "owners_and_admins",
        externalEgressMode: "blocked",
        allowedExternalHosts: [],
        supportBundleMode: "owners_and_admins",
      },
      {
        idempotencyKey: "enterprise-policy-update-0001",
        requestId: REQUEST_ID,
      },
    );

    expect(response.policy).toMatchObject({
      revision: 1,
      teamId: TEAM_ID,
      tenantId: TENANT_ID,
      ssoMode: "required",
    });
    expect(transaction.insertPolicy.mock.calls).toHaveLength(1);
    expect(transaction.insertIdempotency.mock.calls[0]?.[0]).toMatchObject({
      operationId: "enterprisePolicies.update",
      responseStatus: 200,
      resultResourceId: TEAM_ID,
    });
    const auditEvent = transaction.insertAuditEvent.mock.calls[0]?.[0];
    expect(auditEvent).toMatchObject({
      action: "enterprise.policy.updated",
      actorAccountId: ACCOUNT_ID,
    });
    expect(auditEvent?.redactedDiff).not.toHaveProperty("email");
    expect(auditEvent?.redactedDiff).not.toHaveProperty("clientSecret");
  });

  it("denies policy mutation to a non-administrator", async () => {
    const transaction = transactionFixture("author");
    await expect(
      policyService(transaction).updatePolicy(
        principal(),
        TEAM_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: null,
          ssoMode: "optional",
          allowedEmailDomains: ["example.com"],
          sessionMaximumMinutes: 480,
          maximumTrustedDevices: 3,
          deviceApprovalMode: "trusted_device",
          approvedDeviceFingerprints: [],
          exportMode: "blocked",
          externalEgressMode: "blocked",
          allowedExternalHosts: [],
          supportBundleMode: "owners_and_admins",
        },
        {
          idempotencyKey: "enterprise-policy-update-0002",
          requestId: REQUEST_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    expect(transaction.insertPolicy.mock.calls).toHaveLength(0);
  });

  it("evaluates export governance for the active role and audits denials", async () => {
    const transaction = transactionFixture("author", policyRecord());
    const response = await policyService(transaction).evaluatePolicy(
      principal(),
      TEAM_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        action: "export",
        externalHost: null,
      },
      {
        idempotencyKey: "enterprise-policy-evaluation-0001",
        requestId: REQUEST_ID,
      },
    );
    expect(response).toMatchObject({
      allowed: false,
      reason: "export_role_forbidden",
      policyRevision: 1,
    });
    expect(transaction.insertAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action: "enterprise.policy.evaluate.export",
      result: "denied",
      reason: "export_role_forbidden",
    });
  });

  it("blocks password login when any active licensed team requires SSO", async () => {
    const transaction = transactionFixture("owner");
    transaction.findRequiredSsoTeams.mockResolvedValue([{ tenantId: TENANT_ID, teamId: TEAM_ID }]);
    await expect(
      policyService(transaction).assertPasswordLoginAllowed({
        accountId: ACCOUNT_ID,
        emailCanonical: "writer@example.com",
      }),
    ).rejects.toMatchObject({ code: "SSO_REQUIRED" });
  });
});

type TransactionFixture = Omit<
  CloudEnterpriseTransaction,
  "findRequiredSsoTeams" | "insertAuditEvent" | "insertIdempotency" | "insertPolicy"
> & {
  readonly findRequiredSsoTeams: Mock<CloudEnterpriseTransaction["findRequiredSsoTeams"]>;
  readonly insertAuditEvent: Mock<CloudEnterpriseTransaction["insertAuditEvent"]>;
  readonly insertIdempotency: Mock<CloudEnterpriseTransaction["insertIdempotency"]>;
  readonly insertPolicy: Mock<CloudEnterpriseTransaction["insertPolicy"]>;
};

function transactionFixture(
  role: CloudTeamMembershipRecord["role"],
  existingPolicy: CloudEnterprisePolicyRecord | null = null,
): TransactionFixture {
  const membership: CloudTeamMembershipRecord = {
    accountId: ACCOUNT_ID,
    createdAt: NOW,
    membershipId: MEMBERSHIP_ID,
    revision: 1,
    revokedAt: null,
    role,
    state: "active",
    teamId: TEAM_ID,
    tenantId: TENANT_ID,
    updatedAt: NOW,
  };
  const team: CloudTeamRecord = {
    archivedAt: null,
    createdAt: NOW,
    displayName: "Private Studio",
    revision: 1,
    state: "active",
    teamId: TEAM_ID,
    tenantId: TENANT_ID,
    updatedAt: NOW,
  };
  return {
    setPrincipal: vi.fn(() => Promise.resolve()),
    clearTeamScope: vi.fn(() => Promise.resolve()),
    setTeamScope: vi.fn(() => Promise.resolve()),
    assertPrincipalActive: vi.fn(() => Promise.resolve(true)),
    findActiveMembershipForAccount: vi.fn(() => Promise.resolve(membership)),
    findTeam: vi.fn(() => Promise.resolve(team)),
    findMembership: vi.fn(() => Promise.resolve(membership)),
    countTrustedDevices: vi.fn(() => Promise.resolve(1)),
    findTrustedDevice: vi.fn(() => Promise.resolve(null)),
    lockIdempotency: vi.fn(() => Promise.resolve()),
    findIdempotency: vi.fn(() => Promise.resolve(null)),
    insertIdempotency: vi.fn<CloudEnterpriseTransaction["insertIdempotency"]>(() =>
      Promise.resolve(),
    ),
    findPolicy: vi.fn(() => Promise.resolve(existingPolicy)),
    insertPolicy: vi.fn<CloudEnterpriseTransaction["insertPolicy"]>(() => Promise.resolve()),
    updatePolicyCas: vi.fn(() => Promise.resolve(true)),
    findPublicSsoPolicy: vi.fn(() => Promise.resolve(null)),
    findRequiredSsoTeams: vi.fn<CloudEnterpriseTransaction["findRequiredSsoTeams"]>(() =>
      Promise.resolve([]),
    ),
    insertOidcFlow: vi.fn(() => Promise.resolve()),
    resolveOidcFlowScope: vi.fn(() => Promise.resolve(null)),
    findOidcFlow: vi.fn(() => Promise.resolve(null)),
    updateOidcFlow: vi.fn(() => Promise.resolve()),
    resolveMember: vi.fn(() => Promise.resolve(null)),
    findOidcBinding: vi.fn(() => Promise.resolve(null)),
    findOidcBindingForAccount: vi.fn(() => Promise.resolve(null)),
    insertOidcBinding: vi.fn(() => Promise.resolve()),
    updateOidcBinding: vi.fn(() => Promise.resolve()),
    insertAuditEvent: vi.fn<CloudEnterpriseTransaction["insertAuditEvent"]>(() =>
      Promise.resolve(),
    ),
  };
}

function policyService(transaction: CloudEnterpriseTransaction) {
  const store: CloudEnterpriseStore = {
    transaction: (operation) => operation(transaction),
  };
  return new CloudEnterprisePolicyService({
    clock: () => NOW,
    configuration: configuration(),
    store,
    uuid: () => EVENT_ID,
  });
}

function configuration(): EnterpriseConfiguration {
  return {
    deploymentId: "customer-primary",
    flowKey: Buffer.alloc(32, 0x71),
    flowLifetimeMs: 600_000,
    metadataCacheMs: 300_000,
    providers: new Map([
      [
        TEAM_ID,
        {
          teamId: TEAM_ID,
          issuer: "https://idp.example.test/",
          clientId: "inkshadow-private",
          clientSecret: "s".repeat(32),
          redirectUris: ["inkshadow://enterprise/sso/callback"],
        },
      ],
    ]),
    license: {
      schemaVersion: 1,
      product: "inkshadow",
      licenseId: "license-primary",
      keyId: "enterprise-2026",
      deploymentId: "customer-primary",
      tier: "enterprise",
      issuedAt: "2026-01-01T00:00:00.000Z",
      notBefore: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      capabilities: ["enterprise.policy", "enterprise.private_deployment", "enterprise.sso"],
      licensedTeamIds: [TEAM_ID],
      fingerprintSha256: "f".repeat(64),
    },
  };
}

function principal(): CloudPrincipal {
  return {
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
  };
}

function policyRecord(): CloudEnterprisePolicyRecord {
  return {
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    revision: 1,
    ssoMode: "required",
    allowedEmailDomains: ["example.com"],
    sessionMaximumMinutes: 480,
    maximumTrustedDevices: 3,
    deviceApprovalMode: "trusted_device",
    approvedDeviceFingerprints: [],
    exportMode: "owners_and_admins",
    externalEgressMode: "blocked",
    allowedExternalHosts: [],
    supportBundleMode: "owners_and_admins",
    createdByMembershipId: MEMBERSHIP_ID,
    updatedByMembershipId: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
