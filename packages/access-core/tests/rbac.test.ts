import { describe, expect, it } from "vitest";

import {
  AccessCoreError,
  authorizeProjectBusinessAccess,
  authorizeTeamAction,
  evaluateProjectKeyEnvelopeEligibility,
  planMembershipMutation,
  type AccessAction,
  type AccessRequest,
  type AccessResourceType,
  type TeamMembership,
  type TeamRole,
} from "../src/index.js";

const MEMBER: TeamMembership = {
  membershipId: "membership-author",
  accountId: "account-author",
  tenantId: "tenant-a",
  teamId: "team-a",
  role: "author",
  state: "active",
  projectIds: ["project-1"],
  revision: 3,
};

const RESOURCE_BY_ACTION: Readonly<Record<AccessAction, AccessResourceType>> = {
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

function projectRequest(
  action: AccessAction,
  overrides: Partial<AccessRequest> = {},
): AccessRequest {
  return {
    tenantId: "tenant-a",
    teamId: "team-a",
    projectId: "project-1",
    action,
    resourceType: RESOURCE_BY_ACTION[action],
    resourceState: "active",
    ...overrides,
  };
}

function teamRequest(action: AccessAction, overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    tenantId: "tenant-a",
    teamId: "team-a",
    projectId: null,
    action,
    resourceType: RESOURCE_BY_ACTION[action],
    resourceState: "active",
    ...overrides,
  };
}

describe("tenant, team and project authorization", () => {
  it("keeps representative role grants inside their documented boundaries", () => {
    const cases: readonly [TeamRole, readonly AccessAction[], readonly AccessAction[]][] = [
      [
        "owner",
        [
          "team.delete",
          "project.edit_content",
          "member.change_role",
          "billing.manage",
          "template.publish",
        ],
        [],
      ],
      [
        "admin",
        [
          "team.update",
          "project.edit_content",
          "member.invite",
          "billing.manage",
          "audit.read",
          "template.archive",
        ],
        ["team.delete"],
      ],
      [
        "author",
        [
          "project.edit_content",
          "review.submit",
          "review.decide_suggestion",
          "template.create",
          "template.clone",
          "template.apply",
        ],
        ["review.approve", "member.invite", "billing.read", "template.publish"],
      ],
      [
        "reviewer",
        ["project.read", "review.read", "review.approve", "template.read"],
        [
          "project.edit_content",
          "review.submit",
          "review.decide_suggestion",
          "member.invite",
          "template.apply",
        ],
      ],
      [
        "read_only",
        ["project.read", "project.export", "template.read"],
        ["review.comment", "project.edit_content", "template.clone"],
      ],
      [
        "finance_admin",
        ["billing.read", "billing.manage"],
        ["team.read", "project.read", "template.read"],
      ],
    ];

    for (const [role, allowed, denied] of cases) {
      const membershipValue = { ...MEMBER, role };
      for (const action of allowed) {
        expect(authorizeTeamAction(membershipValue, requestForAction(action)).allowed).toBe(true);
      }
      for (const action of denied) {
        expect(authorizeTeamAction(membershipValue, requestForAction(action)).allowed).toBe(false);
      }
    }
  });

  it("allows authors to edit only explicitly assigned active projects", () => {
    expect(authorizeTeamAction(MEMBER, projectRequest("project.edit_content"))).toEqual({
      allowed: true,
      reason: "allowed",
    });
    expect(
      authorizeTeamAction(
        MEMBER,
        projectRequest("project.edit_content", { projectId: "project-2" }),
      ),
    ).toEqual({ allowed: false, reason: "project_out_of_scope" });
    expect(
      authorizeTeamAction(
        { ...MEMBER, role: "owner", projectIds: null },
        projectRequest("project.read"),
      ),
    ).toEqual({ allowed: false, reason: "project_assignment_required" });
  });

  it("denies cross-tenant, cross-team, wrong-scope and wrong-resource requests first", () => {
    expect(
      authorizeTeamAction(MEMBER, projectRequest("project.read", { tenantId: "tenant-b" })),
    ).toEqual({ allowed: false, reason: "tenant_mismatch" });
    expect(
      authorizeTeamAction(MEMBER, projectRequest("project.read", { teamId: "team-b" })),
    ).toEqual({ allowed: false, reason: "team_mismatch" });
    expect(
      authorizeTeamAction(MEMBER, projectRequest("project.read", { projectId: null })),
    ).toEqual({ allowed: false, reason: "scope_mismatch" });
    expect(
      authorizeTeamAction(
        MEMBER,
        projectRequest("project.read", { resourceType: "billing_metadata" }),
      ),
    ).toEqual({ allowed: false, reason: "resource_action_mismatch" });
  });

  it("lets reviewers perform review work but never overwrite formal content", () => {
    const reviewer = { ...MEMBER, role: "reviewer" } as const;

    for (const action of [
      "review.comment",
      "review.suggest",
      "review.question",
      "review.request_rewrite",
      "review.approve",
      "review.reject",
      "review.reply",
      "review.resolve",
    ] as const) {
      expect(authorizeTeamAction(reviewer, projectRequest(action)).allowed).toBe(true);
    }
    expect(authorizeTeamAction(reviewer, projectRequest("project.edit_content"))).toEqual({
      allowed: false,
      reason: "role_forbidden",
    });
    expect(
      authorizeTeamAction(
        reviewer,
        projectRequest("review.approve", { resourceState: "under_review" }),
      ).allowed,
    ).toBe(true);
    expect(
      authorizeTeamAction(
        { ...MEMBER, role: "owner" },
        projectRequest("project.edit_content", { resourceState: "under_review" }),
      ),
    ).toEqual({ allowed: false, reason: "resource_read_only" });
  });

  it("keeps finance admins inside billing metadata only", () => {
    const finance = { ...MEMBER, role: "finance_admin", projectIds: null } as const;

    expect(authorizeTeamAction(finance, teamRequest("billing.read")).allowed).toBe(true);
    expect(authorizeTeamAction(finance, teamRequest("billing.manage")).allowed).toBe(true);
    expect(authorizeTeamAction(finance, teamRequest("team.read"))).toEqual({
      allowed: false,
      reason: "role_forbidden",
    });
    expect(authorizeTeamAction(finance, projectRequest("project.read"))).toEqual({
      allowed: false,
      reason: "project_assignment_required",
    });
    expect(authorizeTeamAction(finance, projectRequest("key.issue_envelope"))).toEqual({
      allowed: false,
      reason: "project_assignment_required",
    });
  });

  it("applies resource-state gates before role grants", () => {
    expect(
      authorizeTeamAction(
        MEMBER,
        projectRequest("project.edit_content", { resourceState: "archived" }),
      ),
    ).toEqual({ allowed: false, reason: "resource_read_only" });
    expect(
      authorizeTeamAction(MEMBER, projectRequest("project.read", { resourceState: "trashed" }))
        .allowed,
    ).toBe(true);
    expect(
      authorizeTeamAction(MEMBER, projectRequest("project.read", { resourceState: "deleting" })),
    ).toEqual({ allowed: false, reason: "resource_unavailable" });
    expect(
      authorizeTeamAction({ ...MEMBER, state: "revoked" }, projectRequest("project.read")),
    ).toEqual({ allowed: false, reason: "membership_revoked" });
  });
});

describe("project-key envelope eligibility is separate from business RBAC", () => {
  it("requires an exactly bound business proof, active recipient device and active key", () => {
    const reviewer = { ...MEMBER, role: "reviewer" } as const;
    const businessAccess = authorizeProjectBusinessAccess(
      reviewer,
      projectRequest("project.read") as AccessRequest & { readonly projectId: string },
    );
    expect(businessAccess.allowed).toBe(true);

    const input = {
      tenantId: "tenant-a",
      teamId: "team-a",
      projectId: "project-1",
      membership: reviewer,
      businessAccess,
      recipientDevice: {
        deviceId: "device-reviewer",
        accountId: "account-author",
        state: "active" as const,
        publicKeyState: "active" as const,
      },
      projectState: "active" as const,
      projectKeyState: "active" as const,
    };
    expect(evaluateProjectKeyEnvelopeEligibility(input)).toEqual({
      eligible: true,
      reason: "eligible",
    });
    expect(
      evaluateProjectKeyEnvelopeEligibility({
        ...input,
        recipientDevice: { ...input.recipientDevice, state: "revoked" },
      }),
    ).toEqual({ eligible: false, reason: "device_revoked" });
    expect(
      evaluateProjectKeyEnvelopeEligibility({
        ...input,
        businessAccess: { ...businessAccess, membershipRevision: 2 },
      }),
    ).toEqual({ eligible: false, reason: "business_proof_mismatch" });

    expect(authorizeTeamAction(reviewer, projectRequest("project.edit_content")).allowed).toBe(
      false,
    );
  });

  it("does not turn a denied business action into key eligibility", () => {
    const readOnly = { ...MEMBER, role: "read_only" } as const;
    const deniedProof = authorizeProjectBusinessAccess(
      readOnly,
      projectRequest("key.issue_envelope") as AccessRequest & { readonly projectId: string },
    );
    expect(deniedProof.allowed).toBe(false);
    expect(
      evaluateProjectKeyEnvelopeEligibility({
        tenantId: "tenant-a",
        teamId: "team-a",
        projectId: "project-1",
        membership: readOnly,
        businessAccess: deniedProof,
        recipientDevice: {
          deviceId: "device-reader",
          accountId: "account-author",
          state: "active",
          publicKeyState: "active",
        },
        projectState: "active",
        projectKeyState: "active",
      }),
    ).toEqual({ eligible: false, reason: "business_access_denied" });
  });
});

describe("membership mutation planning", () => {
  it("plans an exact CAS successor and redacted append-only audit intent", () => {
    const actor = membership("owner-1", "account-owner", "owner", 8);
    const target = membership("author-1", "account-author-2", "author", 4);

    const plan = planMembershipMutation({
      requestId: "request-role-change",
      occurredAt: "2026-07-28T00:00:00.000Z",
      actor,
      target,
      expectedTargetRevision: 4,
      activeOwnerCount: 1,
      mutation: { kind: "change_role", role: "reviewer" },
    });

    expect(plan).toMatchObject({
      allowed: true,
      reason: "allowed",
      expectedTargetRevision: 4,
      nextTarget: {
        membershipId: "author-1",
        role: "reviewer",
        revision: 5,
      },
      auditIntent: {
        storageMode: "append_only",
        requestId: "request-role-change",
        actorAccountId: "account-owner",
        resourceId: "author-1",
        action: "member.change_role",
        result: "allowed",
        reason: "allowed",
        redactedDiff: {
          roleFrom: "author",
          roleTo: "reviewer",
          stateFrom: "active",
          stateTo: "active",
        },
      },
    });
    expect(JSON.stringify(plan)).not.toMatch(/password|token|secret|key/iu);
  });

  it("fails closed for CAS mismatch, cross-tenant mutation and admin role escalation", () => {
    const admin = membership("admin-1", "account-admin", "admin", 2);
    const target = membership("author-1", "account-author-2", "author", 4);
    const common = {
      requestId: "request-denied",
      occurredAt: "2026-07-28T00:00:00.000Z",
      actor: admin,
      target,
      expectedTargetRevision: 4,
      activeOwnerCount: 1,
      mutation: { kind: "change_role", role: "reviewer" as TeamRole },
    } as const;

    expect(planMembershipMutation({ ...common, expectedTargetRevision: 3 })).toMatchObject({
      allowed: false,
      reason: "revision_conflict",
      auditIntent: { storageMode: "append_only", result: "denied" },
    });
    expect(
      planMembershipMutation({
        ...common,
        target: { ...target, tenantId: "tenant-b" },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "tenant_mismatch",
      auditIntent: { tenantId: "tenant-a", result: "denied" },
    });
    expect(
      planMembershipMutation({
        ...common,
        mutation: { kind: "change_role", role: "admin" },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "role_escalation_forbidden",
      auditIntent: { result: "denied" },
    });
  });

  it("protects the last owner and forbids owner self-demotion or self-removal", () => {
    const owner = membership("owner-1", "account-owner", "owner", 8);
    expect(
      planMembershipMutation({
        requestId: "request-last-owner",
        occurredAt: "2026-07-28T00:00:00.000Z",
        actor: owner,
        target: owner,
        expectedTargetRevision: 8,
        activeOwnerCount: 1,
        mutation: { kind: "revoke" },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "last_owner_required",
      auditIntent: { result: "denied", action: "member.remove" },
    });
    expect(
      planMembershipMutation({
        requestId: "request-self-demotion",
        occurredAt: "2026-07-28T00:00:00.000Z",
        actor: owner,
        target: owner,
        expectedTargetRevision: 8,
        activeOwnerCount: 2,
        mutation: { kind: "change_role", role: "author" },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "self_membership_change_forbidden",
    });
  });

  it("lets admins change ordinary roles but not owners, admins or finance admins", () => {
    const admin = membership("admin-1", "account-admin", "admin", 2);
    const author = membership("author-1", "account-author-2", "author", 4);
    expect(
      planMembershipMutation({
        requestId: "request-admin-change",
        occurredAt: "2026-07-28T00:00:00.000Z",
        actor: admin,
        target: author,
        expectedTargetRevision: 4,
        activeOwnerCount: 1,
        mutation: { kind: "change_role", role: "reviewer" },
      }).allowed,
    ).toBe(true);
    expect(
      planMembershipMutation({
        requestId: "request-admin-finance",
        occurredAt: "2026-07-28T00:00:00.000Z",
        actor: admin,
        target: author,
        expectedTargetRevision: 4,
        activeOwnerCount: 1,
        mutation: { kind: "change_role", role: "finance_admin" },
      }),
    ).toMatchObject({ allowed: false, reason: "role_escalation_forbidden" });
  });

  it("throws a validation error instead of planning malformed revisions", () => {
    expect(() =>
      planMembershipMutation({
        requestId: "request-invalid",
        occurredAt: "2026-07-28T00:00:00.000Z",
        actor: membership("owner-1", "account-owner", "owner", 1),
        target: membership("author-1", "account-author-2", "author", 1),
        expectedTargetRevision: 0,
        activeOwnerCount: 1,
        mutation: { kind: "revoke" },
      }),
    ).toThrowError(AccessCoreError);
  });
});

function membership(
  membershipId: string,
  accountId: string,
  role: TeamRole,
  revision: number,
): TeamMembership {
  return {
    membershipId,
    accountId,
    tenantId: "tenant-a",
    teamId: "team-a",
    role,
    state: "active",
    projectIds: ["project-1"],
    revision,
  };
}

function requestForAction(action: AccessAction): AccessRequest {
  return action.startsWith("project.") ||
    action.startsWith("review.") ||
    action.startsWith("key.") ||
    action.startsWith("template.")
    ? projectRequest(action)
    : teamRequest(action);
}
