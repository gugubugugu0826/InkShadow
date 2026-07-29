import type { CloudProjectAccessRecord, CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudIdempotencyRecord,
  CloudPageAnchor,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type { TeamInvitationOutboxRecord } from "../domain/team-invitation-outbox-record.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamInvitationRecord,
  CloudTeamMembershipRecord,
  CloudTeamProjectKeyEnvelopeRecord,
  CloudTeamProjectKeyVersionRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type { CloudPrincipal } from "../service/identity-service.js";

export interface CloudTeamTransaction {
  setPrincipal(accountId: string, deviceId?: string): Promise<void>;
  setTeamScope(tenantId: string, teamId: string): Promise<void>;
  clearTeamScope(): Promise<void>;
  assertPrincipalActive(principal: CloudPrincipal, at: Date): Promise<boolean>;
  findActiveAccountEmail(accountId: string): Promise<string | null>;

  lockIdempotency(scopeHashSha256: string): Promise<void>;
  findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null>;
  insertIdempotency(record: CloudIdempotencyRecord): Promise<void>;

  insertTeam(record: CloudTeamRecord): Promise<void>;
  findTeam(tenantId: string, teamId: string, forUpdate?: boolean): Promise<CloudTeamRecord | null>;
  lockTeam(tenantId: string, teamId: string): Promise<CloudTeamRecord | null>;

  insertMembership(record: CloudTeamMembershipRecord): Promise<void>;
  findMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
    forUpdate?: boolean,
  ): Promise<CloudTeamMembershipRecord | null>;
  findActiveMembershipForAccount(
    accountId: string,
    teamId: string,
    forUpdate?: boolean,
  ): Promise<CloudTeamMembershipRecord | null>;
  listActiveMembershipsForAccount(
    accountId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamMembershipRecord[]>;
  listMemberships(
    tenantId: string,
    teamId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudTeamMembershipRecord[]>;
  hasActiveMembershipForEmail(
    tenantId: string,
    teamId: string,
    emailCanonical: string,
  ): Promise<boolean>;
  listActiveProjectIdsForMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
  ): Promise<readonly string[]>;
  lockActiveOwners(tenantId: string, teamId: string): Promise<readonly CloudTeamMembershipRecord[]>;
  updateMembershipCas(
    record: CloudTeamMembershipRecord,
    expectedRevision: number,
  ): Promise<boolean>;

  insertInvitation(record: CloudTeamInvitationRecord): Promise<void>;
  insertInvitationOutbox(record: TeamInvitationOutboxRecord): Promise<void>;
  cancelInvitationOutbox(
    tenantId: string,
    teamId: string,
    invitationId: string,
    at: Date,
    errorCode: string,
  ): Promise<boolean>;
  expirePendingInvitations(
    tenantId: string,
    teamId: string,
    inviteeEmail: string,
    at: Date,
  ): Promise<number>;
  findInvitationForInvitee(
    invitationId: string,
    forUpdate?: boolean,
  ): Promise<CloudTeamInvitationRecord | null>;
  updateInvitationCas(
    record: CloudTeamInvitationRecord,
    expectedRevision: number,
  ): Promise<boolean>;

  findProject(
    tenantId: string,
    projectId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectRecord | null>;
  findProjectAccess(
    tenantId: string,
    projectId: string,
    accountId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectAccessRecord | null>;
  findProjectKeyVersion(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    forUpdate?: boolean,
  ): Promise<CloudTeamProjectKeyVersionRecord | null>;
  findCurrentProjectKeyVersion(
    tenantId: string,
    projectId: string,
  ): Promise<CloudTeamProjectKeyVersionRecord | null>;
  findDevice(deviceId: string, forUpdate?: boolean): Promise<RegisteredDeviceRecord | null>;
  hasActivePersonalDeviceEnvelope(
    tenantId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
  ): Promise<boolean>;
  findAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
    membershipId: string,
    forUpdate?: boolean,
  ): Promise<CloudProjectAssignmentRecord | null>;
  listAssignments(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudProjectAssignmentRecord[]>;
  insertAssignment(record: CloudProjectAssignmentRecord): Promise<void>;
  updateAssignmentCas(
    record: CloudProjectAssignmentRecord,
    expectedRevision: number,
  ): Promise<boolean>;
  revokeActiveAssignmentsForMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
    actorMembershipId: string,
    at: Date,
  ): Promise<number>;

  listActiveTeamProjectKeyRecipientCandidates(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly CloudTeamProjectKeyRecipientCandidate[]>;
  findActiveTeamProjectKeyEnvelope(
    tenantId: string,
    teamId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
  ): Promise<CloudTeamProjectKeyEnvelopeRecord | null>;
  hasActiveTeamProjectKeyEnvelope(
    tenantId: string,
    teamId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
  ): Promise<boolean>;
  hasCurrentPrincipalTeamProjectKeyEnvelope(
    tenantId: string,
    teamId: string,
    projectId: string,
    keyVersion: number,
  ): Promise<boolean>;
  findTeamProjectKeyEnvelopeById(
    tenantId: string,
    teamId: string,
    envelopeId: string,
  ): Promise<CloudTeamProjectKeyEnvelopeRecord | null>;
  insertTeamProjectKeyEnvelope(record: CloudTeamProjectKeyEnvelopeRecord): Promise<void>;

  insertAuditEvent(record: CloudTeamAuditEventRecord): Promise<void>;
}

export interface CloudTeamProjectKeyRecipientCandidate {
  readonly assignment: CloudProjectAssignmentRecord;
  readonly device: RegisteredDeviceRecord;
  readonly membership: CloudTeamMembershipRecord;
}

export interface CloudTeamStore {
  transaction<T>(operation: (transaction: CloudTeamTransaction) => Promise<T>): Promise<T>;
}
