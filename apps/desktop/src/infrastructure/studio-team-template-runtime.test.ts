import type { CloudProjectAssignment, CloudTeamMembership } from "@inkshadow/contracts";
import { describe, expect, it, vi } from "vitest";

import type { CloudSessionCoordinator } from "./cloud-session-coordinator";
import type { CloudTeamWorkspacePort } from "./cloud-team-workspace-service";
import { CloudStudioTeamTemplateAuthority } from "./studio-team-template-runtime";

const TENANT_ID = uuid(1);
const ACCOUNT_ID = uuid(2);
const TEAM_ID = uuid(3);
const PROJECT_ID = uuid(4);
const MEMBERSHIP_ID = uuid(5);
const ASSIGNMENT_ID = uuid(6);
const DEVICE_ID = uuid(7);
const SESSION_ID = uuid(8);
const NOW = "2026-07-28T04:00:00.000Z";

describe("CloudStudioTeamTemplateAuthority", () => {
  it("binds complete team authority to the exact session device", async () => {
    const authority = new CloudStudioTeamTemplateAuthority(teamService(), sessionService());

    await expect(authority.resolveContext(TEAM_ID, PROJECT_ID)).resolves.toEqual({
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      membershipId: MEMBERSHIP_ID,
      deviceId: DEVICE_ID,
      role: "author",
      membershipState: "active",
      assignmentState: "active",
    });
  });

  it("fails closed on truncated authority or a mid-resolution session change", async () => {
    const truncatedTeams: CloudTeamWorkspacePort = {
      ...teamService(),
      listTeamMembers: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        requestId: uuid(20),
        memberships: [membership()],
        nextCursor: "more",
      }),
    };
    await expect(
      new CloudStudioTeamTemplateAuthority(truncatedTeams, sessionService()).resolveContext(
        TEAM_ID,
        PROJECT_ID,
      ),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_AUTHORITY_INCOMPLETE" });

    const ensureReady = vi
      .fn()
      .mockResolvedValueOnce(sessionStatus())
      .mockResolvedValueOnce(sessionStatus({ deviceId: uuid(99) }));
    await expect(
      new CloudStudioTeamTemplateAuthority(teamService(), {
        ensureReady,
      } as unknown as CloudSessionCoordinator).resolveContext(TEAM_ID, PROJECT_ID),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_SESSION_CHANGED" });
  });

  it("rejects cross-project assignments and duplicate actor memberships", async () => {
    const crossProject: CloudTeamWorkspacePort = {
      ...teamService(),
      listProjectAssignments: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        requestId: uuid(21),
        assignments: [assignment({ projectId: uuid(98) })],
        nextCursor: null,
      }),
    };
    await expect(
      new CloudStudioTeamTemplateAuthority(crossProject, sessionService()).resolveContext(
        TEAM_ID,
        PROJECT_ID,
      ),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_AUTHORITY_INVALID" });

    const duplicates: CloudTeamWorkspacePort = {
      ...teamService(),
      listTeamMembers: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        requestId: uuid(22),
        memberships: [membership(), { ...membership(), membershipId: uuid(97) }],
        nextCursor: null,
      }),
    };
    await expect(
      new CloudStudioTeamTemplateAuthority(duplicates, sessionService()).resolveContext(
        TEAM_ID,
        PROJECT_ID,
      ),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_AUTHORITY_INVALID" });
  });
});

function sessionService(): CloudSessionCoordinator {
  return {
    ensureReady: vi.fn().mockResolvedValue(sessionStatus()),
  } as unknown as CloudSessionCoordinator;
}

function sessionStatus(overrides: Readonly<{ deviceId?: string }> = {}) {
  return {
    account: { accountId: ACCOUNT_ID },
    device: { device: { deviceId: overrides.deviceId ?? DEVICE_ID } },
    session: { sessionId: SESSION_ID },
  };
}

function teamService(): CloudTeamWorkspacePort {
  return {
    getCurrentAccountId: vi.fn().mockResolvedValue(ACCOUNT_ID),
    createTeam: vi.fn(),
    listTeams: vi.fn(),
    listTeamMembers: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: uuid(10),
      memberships: [membership()],
      nextCursor: null,
    }),
    createInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    changeMemberRole: vi.fn(),
    revokeMembership: vi.fn(),
    listProjectAssignments: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: uuid(11),
      assignments: [assignment()],
      nextCursor: null,
    }),
    setProjectAssignment: vi.fn(),
  };
}

function membership(): CloudTeamMembership {
  return {
    schemaVersion: 1,
    membershipId: MEMBERSHIP_ID,
    accountId: ACCOUNT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    role: "author",
    state: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function assignment(overrides: Readonly<{ projectId?: string }> = {}): CloudProjectAssignment {
  return {
    schemaVersion: 1,
    assignmentId: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    membershipId: MEMBERSHIP_ID,
    state: "active",
    revision: 1,
    grantedByMembershipId: MEMBERSHIP_ID,
    revokedByMembershipId: null,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function uuid(index: number): string {
  return `019f9f4a-b3c7-7350-9226-${String(index).padStart(12, "0")}`;
}
