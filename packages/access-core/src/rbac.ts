import { AccessCoreError } from "./errors.js";
import { requireIdentifier, requireIsoTimestamp, uniqueSortedIdentifiers } from "./validation.js";

export const TEAM_ROLES = [
  "owner",
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const ACCESS_RESOURCE_TYPES = [
  "team",
  "membership",
  "project_metadata",
  "project_content",
  "review",
  "project_key_metadata",
  "project_template",
  "billing_metadata",
  "audit",
] as const;
export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number];

export const ACCESS_ACTIONS = [
  "team.read",
  "team.update",
  "team.delete",
  "project.read",
  "project.edit_content",
  "project.export",
  "project.delete",
  "project.manage_assignment",
  "review.read",
  "review.submit",
  "review.comment",
  "review.suggest",
  "review.question",
  "review.request_rewrite",
  "review.approve",
  "review.reject",
  "review.reply",
  "review.resolve",
  "review.decide_suggestion",
  "member.list",
  "member.invite",
  "member.change_role",
  "member.remove",
  "key.issue_envelope",
  "key.rotate",
  "template.read",
  "template.create",
  "template.clone",
  "template.apply",
  "template.publish",
  "template.archive",
  "billing.read",
  "billing.manage",
  "audit.read",
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const ACCESS_RESOURCE_STATES = [
  "active",
  "archived",
  "trashed",
  "read_only",
  "under_review",
  "conflicted",
  "migrating",
  "deletion_scheduled",
  "deleting",
  "deleted",
  "revoked",
] as const;
export type AccessResourceState = (typeof ACCESS_RESOURCE_STATES)[number];

export type MembershipState = "active" | "revoked";

/**
 * projectIds is an explicit project grant set. null means no project content
 * grants; it never means that a team administrator may decrypt every project.
 */
export interface TeamMembership {
  readonly membershipId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly role: TeamRole;
  readonly state: MembershipState;
  readonly projectIds: readonly string[] | null;
  readonly revision: number;
}

export interface AccessRequest {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string | null;
  readonly resourceType: AccessResourceType;
  readonly action: AccessAction;
  readonly resourceState: AccessResourceState;
}

export type AccessDenialReason =
  | "membership_revoked"
  | "tenant_mismatch"
  | "team_mismatch"
  | "scope_mismatch"
  | "project_assignment_required"
  | "project_out_of_scope"
  | "resource_action_mismatch"
  | "resource_read_only"
  | "resource_unavailable"
  | "role_forbidden";

export type AccessDecision =
  | { readonly allowed: true; readonly reason: "allowed" }
  | { readonly allowed: false; readonly reason: AccessDenialReason };

const ROLE_ACTIONS: Readonly<Record<TeamRole, ReadonlySet<AccessAction>>> = {
  owner: new Set(ACCESS_ACTIONS),
  admin: new Set([
    "team.read",
    "team.update",
    "project.read",
    "project.edit_content",
    "project.export",
    "project.delete",
    "project.manage_assignment",
    "review.read",
    "review.submit",
    "review.comment",
    "review.suggest",
    "review.question",
    "review.request_rewrite",
    "review.approve",
    "review.reject",
    "review.reply",
    "review.resolve",
    "review.decide_suggestion",
    "member.list",
    "member.invite",
    "member.change_role",
    "member.remove",
    "key.issue_envelope",
    "key.rotate",
    "template.read",
    "template.create",
    "template.clone",
    "template.apply",
    "template.publish",
    "template.archive",
    "billing.read",
    "billing.manage",
    "audit.read",
  ]),
  author: new Set([
    "team.read",
    "project.read",
    "project.edit_content",
    "project.export",
    "review.read",
    "review.submit",
    "review.comment",
    "review.suggest",
    "review.question",
    "review.reply",
    "review.resolve",
    "review.decide_suggestion",
    "template.read",
    "template.create",
    "template.clone",
    "template.apply",
  ]),
  reviewer: new Set([
    "team.read",
    "project.read",
    "project.export",
    "review.read",
    "review.comment",
    "review.suggest",
    "review.question",
    "review.request_rewrite",
    "review.approve",
    "review.reject",
    "review.reply",
    "review.resolve",
    "template.read",
  ]),
  read_only: new Set(["team.read", "project.read", "project.export", "template.read"]),
  finance_admin: new Set(["billing.read", "billing.manage"]),
};

const ACTION_RESOURCE_TYPE: Readonly<Record<AccessAction, AccessResourceType>> = {
  "team.read": "team",
  "team.update": "team",
  "team.delete": "team",
  "project.read": "project_content",
  "project.edit_content": "project_content",
  "project.export": "project_content",
  "project.delete": "project_metadata",
  "project.manage_assignment": "project_metadata",
  "review.read": "review",
  "review.submit": "review",
  "review.comment": "review",
  "review.suggest": "review",
  "review.question": "review",
  "review.request_rewrite": "review",
  "review.approve": "review",
  "review.reject": "review",
  "review.reply": "review",
  "review.resolve": "review",
  "review.decide_suggestion": "review",
  "member.list": "membership",
  "member.invite": "membership",
  "member.change_role": "membership",
  "member.remove": "membership",
  "key.issue_envelope": "project_key_metadata",
  "key.rotate": "project_key_metadata",
  "template.read": "project_template",
  "template.create": "project_template",
  "template.clone": "project_template",
  "template.apply": "project_template",
  "template.publish": "project_template",
  "template.archive": "project_template",
  "billing.read": "billing_metadata",
  "billing.manage": "billing_metadata",
  "audit.read": "audit",
};

const PROJECT_SCOPED_ACTIONS = new Set<AccessAction>([
  "project.read",
  "project.edit_content",
  "project.export",
  "project.delete",
  "project.manage_assignment",
  "review.read",
  "review.submit",
  "review.comment",
  "review.suggest",
  "review.question",
  "review.request_rewrite",
  "review.approve",
  "review.reject",
  "review.reply",
  "review.resolve",
  "review.decide_suggestion",
  "key.issue_envelope",
  "key.rotate",
  "template.read",
  "template.create",
  "template.clone",
  "template.apply",
  "template.publish",
  "template.archive",
]);

const READ_ONLY_ACTIONS = new Set<AccessAction>([
  "team.read",
  "project.read",
  "project.export",
  "member.list",
  "billing.read",
  "audit.read",
  "template.read",
]);

const TERMINAL_RESOURCE_STATES = new Set<AccessResourceState>(["deleting", "deleted", "revoked"]);

export function authorizeTeamAction(
  membershipValue: TeamMembership,
  requestValue: AccessRequest,
): AccessDecision {
  const membership = normalizeMembership(membershipValue);
  const request = normalizeRequest(requestValue);
  if (membership.state === "revoked") {
    return deny("membership_revoked");
  }
  if (membership.tenantId !== request.tenantId) {
    return deny("tenant_mismatch");
  }
  if (membership.teamId !== request.teamId) {
    return deny("team_mismatch");
  }
  if (ACTION_RESOURCE_TYPE[request.action] !== request.resourceType) {
    return deny("resource_action_mismatch");
  }

  const isProjectScoped = PROJECT_SCOPED_ACTIONS.has(request.action);
  if (isProjectScoped && request.projectId === null) {
    return deny("scope_mismatch");
  }
  if (!isProjectScoped && request.projectId !== null) {
    return deny("scope_mismatch");
  }
  if (isProjectScoped && membership.projectIds === null) {
    return deny("project_assignment_required");
  }
  if (
    isProjectScoped &&
    request.projectId !== null &&
    membership.projectIds !== null &&
    !membership.projectIds.includes(request.projectId)
  ) {
    return deny("project_out_of_scope");
  }

  if (TERMINAL_RESOURCE_STATES.has(request.resourceState)) {
    return deny("resource_unavailable");
  }
  if (!isActionCompatibleWithState(request.action, request.resourceState)) {
    return deny("resource_read_only");
  }
  return ROLE_ACTIONS[membership.role].has(request.action)
    ? { allowed: true, reason: "allowed" }
    : deny("role_forbidden");
}

export interface ProjectBusinessAccessDecision {
  readonly allowed: boolean;
  readonly reason: AccessDecision["reason"];
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
}

/**
 * Produces a project-bound business authorization proof. It does not imply that
 * a device is entitled to receive a project-key envelope.
 */
export function authorizeProjectBusinessAccess(
  membershipValue: TeamMembership,
  requestValue: AccessRequest & { readonly projectId: string },
): ProjectBusinessAccessDecision {
  const membership = normalizeMembership(membershipValue);
  const request = normalizeRequest(requestValue);
  if (!PROJECT_SCOPED_ACTIONS.has(request.action) || request.projectId === null) {
    throw new AccessCoreError(
      "ACCESS_VALIDATION_FAILED",
      "A project business access proof requires a project-scoped action.",
    );
  }
  const decision = authorizeTeamAction(membership, request);
  return Object.freeze({
    ...decision,
    tenantId: request.tenantId,
    teamId: request.teamId,
    projectId: request.projectId,
    membershipId: membership.membershipId,
    membershipRevision: membership.revision,
  });
}

export type ProjectKeyEnvelopeDenialReason =
  | "business_access_denied"
  | "business_proof_mismatch"
  | "membership_revoked"
  | "device_account_mismatch"
  | "device_revoked"
  | "device_public_key_unavailable"
  | "project_key_not_active"
  | "project_not_active";

export type ProjectKeyEnvelopeDecision =
  | { readonly eligible: true; readonly reason: "eligible" }
  | { readonly eligible: false; readonly reason: ProjectKeyEnvelopeDenialReason };

export interface ProjectKeyEnvelopeEligibilityRequest {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly membership: TeamMembership;
  readonly businessAccess: ProjectBusinessAccessDecision;
  readonly recipientDevice: {
    readonly deviceId: string;
    readonly accountId: string;
    readonly state: "active" | "revoked";
    readonly publicKeyState: "active" | "revoked" | "missing";
  };
  readonly projectState: "active" | "archived" | "deletion_scheduled" | "deleted";
  readonly projectKeyState: "active" | "retiring" | "retired";
}

/**
 * Key distribution is a second gate after business authorization. An allowed
 * business action can never by itself authorize an envelope, and envelope
 * eligibility does not grant any content mutation action.
 */
export function evaluateProjectKeyEnvelopeEligibility(
  value: ProjectKeyEnvelopeEligibilityRequest,
): ProjectKeyEnvelopeDecision {
  const tenantId = requireIdentifier(value.tenantId, "tenantId");
  const teamId = requireIdentifier(value.teamId, "teamId");
  const projectId = requireIdentifier(value.projectId, "projectId");
  const membership = normalizeMembership(value.membership);
  requireIdentifier(value.recipientDevice.deviceId, "deviceId");
  requireIdentifier(value.recipientDevice.accountId, "deviceAccountId");

  if (
    value.businessAccess.tenantId !== tenantId ||
    value.businessAccess.teamId !== teamId ||
    value.businessAccess.projectId !== projectId ||
    value.businessAccess.membershipId !== membership.membershipId ||
    value.businessAccess.membershipRevision !== membership.revision
  ) {
    return { eligible: false, reason: "business_proof_mismatch" };
  }
  if (!value.businessAccess.allowed) {
    return { eligible: false, reason: "business_access_denied" };
  }
  if (membership.state !== "active") {
    return { eligible: false, reason: "membership_revoked" };
  }
  if (value.recipientDevice.accountId !== membership.accountId) {
    return { eligible: false, reason: "device_account_mismatch" };
  }
  if (value.recipientDevice.state !== "active") {
    return { eligible: false, reason: "device_revoked" };
  }
  if (value.recipientDevice.publicKeyState !== "active") {
    return { eligible: false, reason: "device_public_key_unavailable" };
  }
  if (value.projectKeyState !== "active") {
    return { eligible: false, reason: "project_key_not_active" };
  }
  if (value.projectState !== "active") {
    return { eligible: false, reason: "project_not_active" };
  }
  return { eligible: true, reason: "eligible" };
}

export type MembershipMutation =
  | {
      readonly kind: "change_role";
      readonly role: TeamRole;
    }
  | {
      readonly kind: "revoke";
    };

export type MembershipMutationDenialReason =
  | AccessDenialReason
  | "revision_conflict"
  | "revision_exhausted"
  | "target_membership_revoked"
  | "self_membership_change_forbidden"
  | "last_owner_required"
  | "owner_change_requires_owner"
  | "role_escalation_forbidden"
  | "role_change_noop";

export interface AppendOnlyAccessAuditIntent {
  readonly storageMode: "append_only";
  readonly requestId: string;
  readonly occurredAt: string;
  readonly actorAccountId: string;
  readonly actorMembershipId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly resourceType: "membership";
  readonly resourceId: string;
  readonly action: "member.change_role" | "member.remove";
  readonly result: "allowed" | "denied";
  readonly reason: "allowed" | MembershipMutationDenialReason;
  readonly redactedDiff: Readonly<{
    readonly roleFrom: TeamRole;
    readonly roleTo: TeamRole | null;
    readonly stateFrom: MembershipState;
    readonly stateTo: MembershipState;
  }>;
}

export interface MembershipMutationPlanInput {
  readonly requestId: string;
  readonly occurredAt: string;
  readonly actor: TeamMembership;
  readonly target: TeamMembership;
  readonly expectedTargetRevision: number;
  readonly activeOwnerCount: number;
  readonly mutation: MembershipMutation;
}

export type MembershipMutationPlan =
  | {
      readonly allowed: true;
      readonly reason: "allowed";
      readonly expectedTargetRevision: number;
      readonly nextTarget: TeamMembership;
      readonly auditIntent: AppendOnlyAccessAuditIntent;
    }
  | {
      readonly allowed: false;
      readonly reason: MembershipMutationDenialReason;
      readonly auditIntent: AppendOnlyAccessAuditIntent;
    };

/**
 * Plans a membership mutation without writing state. The returned revision is
 * an exact CAS successor and every result carries a redacted append-only audit
 * intent. Callers must persist the mutation and audit event atomically.
 */
export function planMembershipMutation(value: MembershipMutationPlanInput): MembershipMutationPlan {
  const actor = normalizeMembership(value.actor);
  const target = normalizeMembership(value.target);
  const requestId = requireIdentifier(value.requestId, "requestId");
  const occurredAt = requireIsoTimestamp(value.occurredAt, "occurredAt");
  const expectedTargetRevision = requirePositiveSafeInteger(
    value.expectedTargetRevision,
    "expectedTargetRevision",
  );
  const activeOwnerCount = requirePositiveSafeInteger(value.activeOwnerCount, "activeOwnerCount");
  const mutation = normalizeMutation(value.mutation);
  const intendedRole = mutation.kind === "change_role" ? mutation.role : null;
  const intendedState = mutation.kind === "revoke" ? "revoked" : target.state;
  const action = mutation.kind === "change_role" ? "member.change_role" : "member.remove";

  const audit = (
    result: "allowed" | "denied",
    reason: "allowed" | MembershipMutationDenialReason,
  ): AppendOnlyAccessAuditIntent =>
    Object.freeze({
      storageMode: "append_only",
      requestId,
      occurredAt,
      actorAccountId: actor.accountId,
      actorMembershipId: actor.membershipId,
      tenantId: actor.tenantId,
      teamId: actor.teamId,
      resourceType: "membership",
      resourceId: target.membershipId,
      action,
      result,
      reason,
      redactedDiff: Object.freeze({
        roleFrom: target.role,
        roleTo: intendedRole,
        stateFrom: target.state,
        stateTo: intendedState,
      }),
    });

  const reject = (reason: MembershipMutationDenialReason): MembershipMutationPlan => ({
    allowed: false,
    reason,
    auditIntent: audit("denied", reason),
  });

  if (actor.state === "revoked") {
    return reject("membership_revoked");
  }
  if (actor.tenantId !== target.tenantId) {
    return reject("tenant_mismatch");
  }
  if (actor.teamId !== target.teamId) {
    return reject("team_mismatch");
  }
  if (target.state === "revoked") {
    return reject("target_membership_revoked");
  }
  if (expectedTargetRevision !== target.revision) {
    return reject("revision_conflict");
  }
  if (target.role === "owner" && activeOwnerCount <= 1) {
    return reject("last_owner_required");
  }
  if (actor.membershipId === target.membershipId) {
    return reject("self_membership_change_forbidden");
  }

  const actorDecision = authorizeTeamAction(actor, {
    tenantId: target.tenantId,
    teamId: target.teamId,
    projectId: null,
    resourceType: "membership",
    action,
    resourceState: "active",
  });
  if (!actorDecision.allowed) {
    return reject(actorDecision.reason);
  }

  if (target.role === "owner" && actor.role !== "owner") {
    return reject("owner_change_requires_owner");
  }
  if (mutation.kind === "change_role") {
    if (mutation.role === target.role) {
      return reject("role_change_noop");
    }
    if (
      actor.role !== "owner" &&
      (isPrivilegedRole(target.role) || isPrivilegedRole(mutation.role))
    ) {
      return reject("role_escalation_forbidden");
    }
  } else if (actor.role !== "owner" && isPrivilegedRole(target.role)) {
    return reject("role_escalation_forbidden");
  }

  if (target.revision >= Number.MAX_SAFE_INTEGER) {
    return reject("revision_exhausted");
  }

  const nextTarget: TeamMembership = Object.freeze({
    ...target,
    role: mutation.kind === "change_role" ? mutation.role : target.role,
    state: mutation.kind === "revoke" ? "revoked" : target.state,
    revision: target.revision + 1,
  });
  return Object.freeze({
    allowed: true,
    reason: "allowed",
    expectedTargetRevision,
    nextTarget,
    auditIntent: audit("allowed", "allowed"),
  });
}

function isActionCompatibleWithState(action: AccessAction, state: AccessResourceState): boolean {
  if (state === "active") {
    return true;
  }
  if (state === "under_review") {
    return action.startsWith("review.") || READ_ONLY_ACTIONS.has(action);
  }
  if (
    state === "archived" ||
    state === "trashed" ||
    state === "read_only" ||
    state === "conflicted" ||
    state === "migrating"
  ) {
    return READ_ONLY_ACTIONS.has(action);
  }
  if (state === "deletion_scheduled") {
    return action === "team.read" || action === "member.list" || action === "audit.read";
  }
  return false;
}

function normalizeMembership(value: TeamMembership): TeamMembership {
  if (!TEAM_ROLES.includes(value.role) || !["active", "revoked"].includes(value.state)) {
    throw new AccessCoreError("ACCESS_VALIDATION_FAILED", "Membership fields are invalid.");
  }
  return Object.freeze({
    membershipId: requireIdentifier(value.membershipId, "membershipId"),
    accountId: requireIdentifier(value.accountId, "accountId"),
    tenantId: requireIdentifier(value.tenantId, "tenantId"),
    teamId: requireIdentifier(value.teamId, "teamId"),
    role: value.role,
    state: value.state,
    projectIds:
      value.projectIds === null
        ? null
        : uniqueSortedIdentifiers(value.projectIds, "projectIds", 10_000),
    revision: requirePositiveSafeInteger(value.revision, "revision"),
  });
}

function normalizeRequest(value: AccessRequest): AccessRequest {
  if (
    !ACCESS_ACTIONS.includes(value.action) ||
    !ACCESS_RESOURCE_TYPES.includes(value.resourceType) ||
    !ACCESS_RESOURCE_STATES.includes(value.resourceState)
  ) {
    throw new AccessCoreError("ACCESS_VALIDATION_FAILED", "Access request fields are invalid.");
  }
  return Object.freeze({
    tenantId: requireIdentifier(value.tenantId, "tenantId"),
    teamId: requireIdentifier(value.teamId, "teamId"),
    projectId: value.projectId === null ? null : requireIdentifier(value.projectId, "projectId"),
    resourceType: value.resourceType,
    action: value.action,
    resourceState: value.resourceState,
  });
}

function normalizeMutation(value: MembershipMutation): MembershipMutation {
  if (value.kind === "revoke") {
    return Object.freeze({ kind: "revoke" });
  }
  if (TEAM_ROLES.includes(value.role)) {
    return Object.freeze({ kind: "change_role", role: value.role });
  }
  throw new AccessCoreError("ACCESS_VALIDATION_FAILED", "Membership mutation is invalid.");
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AccessCoreError(
      "ACCESS_VALIDATION_FAILED",
      `${field} must be a positive portable integer.`,
    );
  }
  return value;
}

function isPrivilegedRole(role: TeamRole): boolean {
  return role === "owner" || role === "admin" || role === "finance_admin";
}

function deny(reason: AccessDenialReason): AccessDecision {
  return { allowed: false, reason };
}
