import type { CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudReviewRecord,
  CloudReviewThreadItemRecord,
  CloudReviewThreadRecord,
} from "../domain/review-records.js";
import type { CloudIdempotencyRecord, CloudPageAnchor } from "../domain/records.js";
import type {
  CloudProjectAssignmentRecord,
  CloudTeamAuditEventRecord,
  CloudTeamMembershipRecord,
  CloudTeamProjectKeyVersionRecord,
  CloudTeamRecord,
} from "../domain/team-records.js";
import type { CloudPrincipal } from "../service/identity-service.js";

export interface CloudReviewTransaction {
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
  findTeam(tenantId: string, teamId: string): Promise<CloudTeamRecord | null>;
  findMembership(
    tenantId: string,
    teamId: string,
    membershipId: string,
  ): Promise<CloudTeamMembershipRecord | null>;
  findProject(tenantId: string, projectId: string): Promise<CloudProjectRecord | null>;
  findAssignment(
    tenantId: string,
    teamId: string,
    projectId: string,
    membershipId: string,
  ): Promise<CloudProjectAssignmentRecord | null>;
  findProjectKeyVersion(
    tenantId: string,
    projectId: string,
    keyVersion: number,
  ): Promise<CloudTeamProjectKeyVersionRecord | null>;

  insertReview(record: CloudReviewRecord): Promise<void>;
  findReview(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    forUpdate?: boolean,
  ): Promise<CloudReviewRecord | null>;
  listReviews(
    tenantId: string,
    teamId: string,
    projectId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudReviewRecord[]>;
  updateReviewDecisionCas(record: CloudReviewRecord, expectedRevision: number): Promise<boolean>;

  insertThread(record: CloudReviewThreadRecord): Promise<void>;
  findThread(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    forUpdate?: boolean,
  ): Promise<CloudReviewThreadRecord | null>;
  listThreads(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudReviewThreadRecord[]>;
  updateThreadCas(record: CloudReviewThreadRecord, expectedRevision: number): Promise<boolean>;

  insertThreadItem(record: CloudReviewThreadItemRecord): Promise<void>;
  findThreadItem(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    itemId: string,
    forUpdate?: boolean,
  ): Promise<CloudReviewThreadItemRecord | null>;
  listThreadItems(
    tenantId: string,
    teamId: string,
    projectId: string,
    reviewId: string,
    threadId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudReviewThreadItemRecord[]>;
  updateSuggestionDecisionCas(
    record: CloudReviewThreadItemRecord,
    expectedRevision: number,
  ): Promise<boolean>;

  insertAuditEvent(record: CloudTeamAuditEventRecord): Promise<void>;
}

export interface CloudReviewStore {
  transaction<T>(operation: (transaction: CloudReviewTransaction) => Promise<T>): Promise<T>;
}
