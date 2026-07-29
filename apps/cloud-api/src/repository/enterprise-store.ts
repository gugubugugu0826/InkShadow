import type {
  CloudEnterpriseMemberRecord,
  CloudEnterpriseOidcBindingRecord,
  CloudEnterpriseOidcFlowRecord,
  CloudEnterprisePolicyRecord,
  CloudEnterprisePublicSsoPolicyRecord,
} from "../domain/enterprise-records.js";
import type { CloudIdempotencyRecord, RegisteredDeviceRecord } from "../domain/records.js";
import type {
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type { CloudPrincipal } from "../service/identity-service.js";

export interface CloudEnterpriseTransaction {
  setPrincipal(accountId: string, deviceId?: string): Promise<void>;
  clearTeamScope(): Promise<void>;
  setTeamScope(tenantId: string, teamId: string): Promise<void>;
  assertPrincipalActive(principal: CloudPrincipal, at: Date): Promise<boolean>;
  findActiveMembershipForAccount(
    accountId: string,
    teamId: string,
  ): Promise<CloudTeamMembershipRecord | null>;
  findTeam(tenantId: string, teamId: string, forUpdate?: boolean): Promise<CloudTeamRecord | null>;
  findMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
    forUpdate?: boolean,
  ): Promise<CloudTeamMembershipRecord | null>;
  countTrustedDevices(accountId: string): Promise<number>;
  findTrustedDevice(accountId: string, deviceId: string): Promise<RegisteredDeviceRecord | null>;

  lockIdempotency(scopeHashSha256: string): Promise<void>;
  findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null>;
  insertIdempotency(record: CloudIdempotencyRecord): Promise<void>;

  findPolicy(
    tenantId: string,
    teamId: string,
    forUpdate?: boolean,
  ): Promise<CloudEnterprisePolicyRecord | null>;
  insertPolicy(record: CloudEnterprisePolicyRecord): Promise<void>;
  updatePolicyCas(record: CloudEnterprisePolicyRecord, expectedRevision: number): Promise<boolean>;
  findPublicSsoPolicy(teamId: string): Promise<CloudEnterprisePublicSsoPolicyRecord | null>;
  findRequiredSsoTeams(accountId: string): Promise<readonly { tenantId: string; teamId: string }[]>;

  insertOidcFlow(record: CloudEnterpriseOidcFlowRecord): Promise<void>;
  resolveOidcFlowScope(
    flowId: string,
  ): Promise<{ readonly tenantId: string; readonly teamId: string } | null>;
  findOidcFlow(
    tenantId: string,
    teamId: string,
    flowId: string,
    forUpdate?: boolean,
  ): Promise<CloudEnterpriseOidcFlowRecord | null>;
  updateOidcFlow(record: CloudEnterpriseOidcFlowRecord): Promise<void>;
  resolveMember(
    teamId: string,
    emailCanonical: string,
  ): Promise<CloudEnterpriseMemberRecord | null>;
  findOidcBinding(
    tenantId: string,
    teamId: string,
    issuerHashSha256: string,
    subjectHashSha256: string,
    forUpdate?: boolean,
  ): Promise<CloudEnterpriseOidcBindingRecord | null>;
  findOidcBindingForAccount(
    tenantId: string,
    teamId: string,
    issuerHashSha256: string,
    accountId: string,
    forUpdate?: boolean,
  ): Promise<CloudEnterpriseOidcBindingRecord | null>;
  insertOidcBinding(record: CloudEnterpriseOidcBindingRecord): Promise<void>;
  updateOidcBinding(record: CloudEnterpriseOidcBindingRecord): Promise<void>;

  insertAuditEvent(record: CloudTeamAuditEventRecord): Promise<void>;
}

export interface CloudEnterpriseStore {
  transaction<T>(operation: (transaction: CloudEnterpriseTransaction) => Promise<T>): Promise<T>;
}
