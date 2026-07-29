import type { CloudProjectAssignment, CloudTeamMembership } from "@inkshadow/contracts";
import { describe, expect, it } from "vitest";

import {
  canChangeMemberRole,
  canCreateInvitation,
  canManageProjectAssignments,
  canRemoveMember,
  canRequestProjectAssignments,
  type StudioTeamRole,
} from "./studio-team-permissions";

const ROLES: readonly StudioTeamRole[] = [
  "owner",
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
];

describe("studio team fail-closed permissions", () => {
  it.each(ROLES)("matches the invitation permission matrix for %s", (role) => {
    const actor = membership("actor", role);
    expect(canCreateInvitation(actor, "author").allowed).toBe(role === "owner" || role === "admin");
  });

  it("prevents an admin from granting privileged invitation roles", () => {
    const admin = membership("actor", "admin");
    expect(canCreateInvitation(admin, "admin").allowed).toBe(false);
    expect(canCreateInvitation(admin, "finance_admin").allowed).toBe(false);
    expect(canCreateInvitation(admin, "reviewer").allowed).toBe(true);
  });

  it("protects self-mutation, privileged roles, and the final active owner", () => {
    const owner = membership("owner-actor", "owner");
    const admin = membership("admin-actor", "admin");
    const lastOwner = membership("last-owner", "owner");
    const author = membership("author-target", "author");

    expect(canRemoveMember({ actor: owner, target: owner, activeOwnerCount: 2 }).allowed).toBe(
      false,
    );
    expect(canRemoveMember({ actor: admin, target: lastOwner, activeOwnerCount: 2 }).allowed).toBe(
      false,
    );
    expect(
      canChangeMemberRole({
        actor: owner,
        target: lastOwner,
        nextRole: "author",
        activeOwnerCount: 1,
      }).reason,
    ).toContain("最后一位");
    expect(
      canChangeMemberRole({
        actor: admin,
        target: author,
        nextRole: "finance_admin",
        activeOwnerCount: 1,
      }).allowed,
    ).toBe(false);
    expect(
      canChangeMemberRole({
        actor: owner,
        target: author,
        nextRole: "admin",
        activeOwnerCount: 1,
      }).allowed,
    ).toBe(true);
  });

  it.each(ROLES)("requires both a manager role and active project scope for %s", (role) => {
    const actor = membership("actor", role);
    const assignments = [assignment(actor.membershipId, "active")];
    expect(
      canManageProjectAssignments({
        actor,
        assignments,
        assignmentsComplete: true,
      }).allowed,
    ).toBe(role === "owner" || role === "admin");
  });

  it.each(ROLES)("only lets a verified manager request project assignments for %s", (role) => {
    expect(canRequestProjectAssignments(membership("actor", role)).allowed).toBe(
      role === "owner" || role === "admin",
    );
  });

  it("fails closed when assignment evidence is missing, incomplete, or revoked", () => {
    const owner = membership("owner", "owner");
    expect(
      canManageProjectAssignments({
        actor: owner,
        assignments: null,
        assignmentsComplete: false,
      }).allowed,
    ).toBe(false);
    expect(
      canManageProjectAssignments({
        actor: owner,
        assignments: [assignment(owner.membershipId, "active")],
        assignmentsComplete: false,
      }).allowed,
    ).toBe(false);
    expect(
      canManageProjectAssignments({
        actor: owner,
        assignments: [assignment(owner.membershipId, "revoked")],
        assignmentsComplete: true,
      }).allowed,
    ).toBe(false);
  });
});

function membership(id: string, role: StudioTeamRole): CloudTeamMembership {
  return {
    schemaVersion: 1,
    membershipId: uuid(id, 1),
    accountId: uuid(id, 2),
    tenantId: uuid("tenant", 1),
    teamId: uuid("team", 1),
    role,
    state: "active",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
  };
}

function assignment(
  membershipId: string,
  state: CloudProjectAssignment["state"],
): CloudProjectAssignment {
  return {
    schemaVersion: 1,
    assignmentId: uuid("assignment", state === "active" ? 1 : 2),
    tenantId: uuid("tenant", 1),
    teamId: uuid("team", 1),
    projectId: uuid("project", 1),
    membershipId,
    state,
    revision: 1,
    grantedByMembershipId: membershipId,
    revokedByMembershipId: state === "revoked" ? membershipId : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revokedAt: state === "revoked" ? "2026-01-01T00:00:00.000Z" : null,
  };
}

function uuid(seed: string, suffix: number): string {
  let numeric = suffix;
  for (const character of seed) {
    numeric += character.codePointAt(0) ?? 0;
  }
  return `019f9f4a-b3c7-7350-9226-${numeric.toString().padStart(12, "0").slice(-12)}`;
}
