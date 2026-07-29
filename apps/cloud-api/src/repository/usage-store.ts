import type { CloudProjectRecord } from "../domain/project-records.js";
import type { CloudPageAnchor } from "../domain/records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamMembershipRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type {
  CloudAiProjectBudgetRecord,
  CloudAiTeamBudgetRecord,
  CloudAiUsageEventRecord,
  CloudAiUsageIdempotencyRecord,
  CloudAiUsageMonthRecord,
  CloudAiUsageReservationRecord,
} from "../domain/usage-records.js";
import type { CloudPrincipal } from "../service/identity-service.js";

export interface CloudAiUsageTransaction {
  setPrincipal(accountId: string, deviceId: string): Promise<void>;
  setTeamScope(tenantId: string, teamId: string): Promise<void>;
  clearTeamScope(): Promise<void>;
  assertPrincipalActive(principal: CloudPrincipal, at: Date): Promise<boolean>;

  findActiveMembershipForAccount(
    accountId: string,
    teamId: string,
  ): Promise<CloudTeamMembershipRecord | null>;
  findTeam(tenantId: string, teamId: string): Promise<CloudTeamRecord | null>;
  findProject(tenantId: string, projectId: string): Promise<CloudProjectRecord | null>;
  teamHasActiveProjectAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
  ): Promise<boolean>;
  findAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
    membershipId: string,
  ): Promise<CloudProjectAssignmentRecord | null>;

  lockIdempotency(idempotencyKeyHashSha256: string): Promise<void>;
  findIdempotency(idempotencyKeyHashSha256: string): Promise<CloudAiUsageIdempotencyRecord | null>;
  purgeExpiredIdempotency(
    idempotencyKeyHashSha256: string,
    actorAccountId: string,
    now: Date,
  ): Promise<void>;
  insertIdempotency(record: CloudAiUsageIdempotencyRecord): Promise<void>;

  lockBudgetScope(tenantId: string, teamId: string, projectId: string | null): Promise<void>;
  findTeamBudget(
    tenantId: string,
    teamId: string,
    forUpdate?: boolean,
  ): Promise<CloudAiTeamBudgetRecord | null>;
  insertTeamBudget(record: CloudAiTeamBudgetRecord): Promise<void>;
  updateTeamBudgetCas(record: CloudAiTeamBudgetRecord, expectedRevision: number): Promise<boolean>;
  findProjectBudget(
    tenantId: string,
    teamId: string,
    projectId: string,
    forUpdate?: boolean,
  ): Promise<CloudAiProjectBudgetRecord | null>;
  insertProjectBudget(record: CloudAiProjectBudgetRecord): Promise<void>;
  updateProjectBudgetCas(
    record: CloudAiProjectBudgetRecord,
    expectedRevision: number,
  ): Promise<boolean>;

  getOrCreateTeamUsageMonth(
    tenantId: string,
    teamId: string,
    periodStart: string,
    now: Date,
    forUpdate?: boolean,
  ): Promise<CloudAiUsageMonthRecord>;
  getOrCreateProjectUsageMonth(
    tenantId: string,
    teamId: string,
    projectId: string,
    periodStart: string,
    now: Date,
    forUpdate?: boolean,
  ): Promise<CloudAiUsageMonthRecord>;
  updateTeamUsageMonth(record: CloudAiUsageMonthRecord): Promise<void>;
  updateProjectUsageMonth(record: CloudAiUsageMonthRecord): Promise<void>;

  insertReservation(record: CloudAiUsageReservationRecord): Promise<void>;
  findReservation(
    tenantId: string,
    teamId: string,
    projectId: string,
    reservationId: string,
    forUpdate?: boolean,
  ): Promise<CloudAiUsageReservationRecord | null>;
  updateReservationCas(
    record: CloudAiUsageReservationRecord,
    expectedRevision: number,
  ): Promise<boolean>;
  listExpiredReservations(
    tenantId: string,
    teamId: string,
    now: Date,
    limit: number,
  ): Promise<readonly CloudAiUsageReservationRecord[]>;
  countActiveReservations(tenantId: string, teamId: string, now: Date): Promise<number>;
  countActiveProjectReservations(
    tenantId: string,
    teamId: string,
    projectId: string,
    now: Date,
  ): Promise<number>;

  insertUsageEvent(record: CloudAiUsageEventRecord): Promise<void>;
  listUsageEvents(
    tenantId: string,
    teamId: string,
    projectId: string | null,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudAiUsageEventRecord[]>;
}

export interface CloudAiUsageStore {
  transaction<T>(operation: (transaction: CloudAiUsageTransaction) => Promise<T>): Promise<T>;
}
