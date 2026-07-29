import type {
  CloudProjectAssignment,
  CloudTeamInvitationRole,
  CloudTeamMembership,
} from "@inkshadow/contracts";

export type StudioTeamRole = CloudTeamMembership["role"];

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

const ALLOWED: PermissionDecision = Object.freeze({ allowed: true, reason: "" });

export function canCreateInvitation(
  actor: CloudTeamMembership | null,
  invitedRole: CloudTeamInvitationRole,
): PermissionDecision {
  const actorDecision = requireActiveManager(actor);
  if (!actorDecision.allowed) {
    return actorDecision;
  }
  if (actor?.role === "admin" && (invitedRole === "admin" || invitedRole === "finance_admin")) {
    return denied("管理员不能邀请管理员或财务管理员；请由团队所有者操作。");
  }
  return ALLOWED;
}

export function canChangeMemberRole(input: {
  readonly actor: CloudTeamMembership | null;
  readonly target: CloudTeamMembership;
  readonly nextRole: StudioTeamRole;
  readonly activeOwnerCount: number;
}): PermissionDecision {
  const common = canMutateMember(input);
  if (!common.allowed) {
    return common;
  }
  if (input.target.role === input.nextRole) {
    return denied("新角色与当前角色相同。");
  }
  if (
    input.actor?.role === "admin" &&
    (isPrivileged(input.target.role) || isPrivileged(input.nextRole))
  ) {
    return denied("管理员不能变更所有者、管理员或财务管理员的特权角色。");
  }
  return ALLOWED;
}

export function canRemoveMember(input: {
  readonly actor: CloudTeamMembership | null;
  readonly target: CloudTeamMembership;
  readonly activeOwnerCount: number;
}): PermissionDecision {
  const common = canMutateMember(input);
  if (!common.allowed) {
    return common;
  }
  if (input.actor?.role === "admin" && isPrivileged(input.target.role)) {
    return denied("管理员不能移除所有者、管理员或财务管理员。");
  }
  return ALLOWED;
}

export function canManageProjectAssignments(input: {
  readonly actor: CloudTeamMembership | null;
  readonly assignments: readonly CloudProjectAssignment[] | null;
  readonly assignmentsComplete: boolean;
}): PermissionDecision {
  const actorDecision = requireActiveManager(input.actor);
  if (!actorDecision.allowed) {
    return actorDecision;
  }
  if (!input.assignmentsComplete || input.assignments === null) {
    return denied("项目分配尚未完整验证，管理操作已关闭。");
  }
  const actorAssignment = input.assignments.find(
    (assignment) =>
      assignment.membershipId === input.actor?.membershipId && assignment.state === "active",
  );
  if (actorAssignment === undefined) {
    return denied("当前成员没有该项目的有效分配，不能管理项目成员。");
  }
  return ALLOWED;
}

export function canRequestProjectAssignments(
  actor: CloudTeamMembership | null,
): PermissionDecision {
  return requireActiveManager(actor);
}

export function activeOwnerCount(memberships: readonly CloudTeamMembership[]): number {
  return memberships.filter(
    (membership) => membership.state === "active" && membership.role === "owner",
  ).length;
}

function canMutateMember(input: {
  readonly actor: CloudTeamMembership | null;
  readonly target: CloudTeamMembership;
  readonly activeOwnerCount: number;
}): PermissionDecision {
  const actorDecision = requireActiveManager(input.actor);
  if (!actorDecision.allowed) {
    return actorDecision;
  }
  if (input.target.state !== "active") {
    return denied("该成员已被移除，不能再次变更。");
  }
  if (input.actor?.membershipId === input.target.membershipId) {
    return denied("不能在此页面变更或移除自己的成员身份。");
  }
  if (input.target.role === "owner" && input.activeOwnerCount <= 1) {
    return denied("不能变更或移除团队最后一位有效所有者。");
  }
  if (input.target.role === "owner" && input.actor?.role !== "owner") {
    return denied("只有团队所有者可以变更其他所有者。");
  }
  return ALLOWED;
}

function requireActiveManager(actor: CloudTeamMembership | null): PermissionDecision {
  if (actor === null) {
    return denied("无法验证当前成员角色，管理操作已关闭。");
  }
  if (actor.state !== "active") {
    return denied("当前成员身份已被移除。");
  }
  switch (actor.role) {
    case "owner":
    case "admin":
      return ALLOWED;
    case "author":
    case "reviewer":
    case "read_only":
    case "finance_admin":
      return denied("当前角色没有团队成员管理权限。");
  }
}

function isPrivileged(role: StudioTeamRole): boolean {
  return role === "owner" || role === "admin" || role === "finance_admin";
}

function denied(reason: string): PermissionDecision {
  return Object.freeze({ allowed: false, reason });
}
