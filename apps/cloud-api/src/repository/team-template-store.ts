import type { CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudIdempotencyRecord,
  CloudPageAnchor,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type {
  CloudTeamTemplateApplicationRecord,
  CloudTeamTemplateRecord,
  CloudTeamTemplateVersionRecord,
} from "../domain/team-template-records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamProjectKeyVersionRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type { CloudPrincipal } from "../service/identity-service.js";

export interface CloudTeamTemplateTransaction {
  setPrincipal(accountId: string, deviceId: string): Promise<void>;
  setTeamScope(tenantId: string, teamId: string): Promise<void>;
  clearTeamScope(): Promise<void>;
  assertPrincipalActive(principal: CloudPrincipal, at: Date): Promise<boolean>;

  lockIdempotency(scopeHashSha256: string): Promise<void>;
  findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null>;
  insertIdempotency(record: CloudIdempotencyRecord): Promise<void>;

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
  findProject(
    tenantId: string,
    projectId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectRecord | null>;
  findAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
    membershipId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectAssignmentRecord | null>;
  findProjectKeyVersion(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    forUpdate?: boolean,
  ): Promise<CloudTeamProjectKeyVersionRecord | null>;
  findDevice(deviceId: string, forUpdate?: boolean): Promise<RegisteredDeviceRecord | null>;

  insertTemplate(record: CloudTeamTemplateRecord): Promise<void>;
  findTemplate(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    forUpdate?: boolean,
  ): Promise<CloudTeamTemplateRecord | null>;
  listTemplates(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamTemplateRecord[]>;
  updateTemplateCas(record: CloudTeamTemplateRecord, expectedRevision: number): Promise<boolean>;

  insertVersion(record: CloudTeamTemplateVersionRecord): Promise<void>;
  findVersion(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    versionId: string,
  ): Promise<CloudTeamTemplateVersionRecord | null>;
  findVersionByNumber(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    versionNumber: number,
  ): Promise<CloudTeamTemplateVersionRecord | null>;
  listVersions(
    tenantId: string,
    teamId: string,
    projectId: string,
    templateId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamTemplateVersionRecord[]>;

  insertApplication(record: CloudTeamTemplateApplicationRecord): Promise<void>;
  findApplication(
    tenantId: string,
    teamId: string,
    projectId: string,
    applicationId: string,
  ): Promise<CloudTeamTemplateApplicationRecord | null>;

  insertAuditEvent(record: CloudTeamAuditEventRecord): Promise<void>;
}

export interface CloudTeamTemplateStore {
  transaction<T>(operation: (transaction: CloudTeamTemplateTransaction) => Promise<T>): Promise<T>;
}
