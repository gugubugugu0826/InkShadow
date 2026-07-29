/* eslint-disable @typescript-eslint/unbound-method -- Vitest mocks are context-free functions. */
import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { UuidV7, UuidV7Generator } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { ConfiguredCloudSessionStatus } from "./cloud-session-coordinator";
import {
  CloudTeamWorkspaceService,
  type CloudTeamSessionPort,
  type CloudTeamWorkspaceApi,
} from "./cloud-team-workspace-service";

const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const INVITATION_ID = "019f9f4a-b3c7-7350-9226-000000000104";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000105";
const IDEMPOTENCY_KEY = "019f9f4a-b3c7-7350-9226-000000000106";

describe("CloudTeamWorkspaceService", () => {
  it("uses the coordinated native session and sends exact parameters for all nine team APIs", async () => {
    const signal = new AbortController().signal;
    const api = createApi();
    const session = new RecordingSession();
    const nextId = vi.fn(() => IDEMPOTENCY_KEY as UuidV7);
    const ids: UuidV7Generator = { next: nextId };
    const service = new CloudTeamWorkspaceService(api, session, ids);

    await expect(service.getCurrentAccountId(signal)).resolves.toBe(ACCOUNT_ID);
    await service.createTeam("Studio Team", signal);
    await service.listTeams(signal);
    await service.listTeamMembers(TEAM_ID, signal);
    await service.createInvitation(
      TEAM_ID,
      {
        inviteeEmail: "author@example.test",
        role: "author",
        expiresAt: "2030-01-02T00:00:00.000Z",
      },
      signal,
    );
    await service.acceptInvitation(INVITATION_ID, 4, "one-time-secret-token", signal);
    await service.changeMemberRole(TEAM_ID, MEMBERSHIP_ID, 5, "reviewer", signal);
    await service.revokeMembership(TEAM_ID, MEMBERSHIP_ID, 6, signal);
    await service.listProjectAssignments(TEAM_ID, PROJECT_ID, signal);
    await service.setProjectAssignment(TEAM_ID, PROJECT_ID, MEMBERSHIP_ID, null, "active", signal);

    expect(api.createTeam).toHaveBeenCalledWith(
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "Studio Team" },
      { idempotencyKey: IDEMPOTENCY_KEY, signal },
    );
    expect(api.listTeams).toHaveBeenCalledWith({ limit: 1_024, signal });
    expect(api.listTeamMembers).toHaveBeenCalledWith(TEAM_ID, { limit: 1_024, signal });
    expect(api.createTeamInvitation).toHaveBeenCalledWith(
      TEAM_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        inviteeEmail: "author@example.test",
        role: "author",
        expiresAt: "2030-01-02T00:00:00.000Z",
      },
      { idempotencyKey: IDEMPOTENCY_KEY, signal },
    );
    expect(api.acceptTeamInvitation).toHaveBeenCalledWith(
      INVITATION_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: 4,
        invitationToken: "one-time-secret-token",
      },
      { idempotencyKey: IDEMPOTENCY_KEY, signal },
    );
    expect(api.changeTeamMemberRole).toHaveBeenCalledWith(
      TEAM_ID,
      MEMBERSHIP_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: 5,
        role: "reviewer",
      },
      { idempotencyKey: IDEMPOTENCY_KEY, signal },
    );
    expect(api.revokeTeamMembership).toHaveBeenCalledWith(
      TEAM_ID,
      MEMBERSHIP_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: 6,
      },
      { idempotencyKey: IDEMPOTENCY_KEY, signal },
    );
    expect(api.listProjectAssignments).toHaveBeenCalledWith(TEAM_ID, PROJECT_ID, {
      limit: 1_024,
      signal,
    });
    expect(api.setProjectAssignment).toHaveBeenCalledWith(
      TEAM_ID,
      PROJECT_ID,
      MEMBERSHIP_ID,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        desiredState: "active",
      },
      { idempotencyKey: IDEMPOTENCY_KEY, signal },
    );
    expect(nextId).toHaveBeenCalledTimes(6);
    expect(session.calls).toHaveLength(10);
    expect(session.calls.every((options) => options.signal === signal)).toBe(true);
    expect(JSON.stringify(service)).not.toContain("one-time-secret-token");
  });

  it("reuses one idempotency key when the session coordinator replays a mutation", async () => {
    const api = createApi();
    const session = new ReplayingSession();
    const nextId = vi.fn(() => IDEMPOTENCY_KEY as UuidV7);
    const service = new CloudTeamWorkspaceService(api, session, { next: nextId });

    await service.createTeam("Replay-safe team");

    expect(nextId).toHaveBeenCalledTimes(1);
    expect(api.createTeam).toHaveBeenCalledTimes(2);
    const firstOptions = vi.mocked(api.createTeam).mock.calls[0]?.[1];
    const secondOptions = vi.mocked(api.createTeam).mock.calls[1]?.[1];
    expect(firstOptions?.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(secondOptions?.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  });
});

class RecordingSession implements CloudTeamSessionPort {
  public readonly calls: { readonly signal?: AbortSignal }[] = [];

  public runWithSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Value> {
    this.calls.push(options);
    return operation({
      account: { accountId: ACCOUNT_ID },
    } as ConfiguredCloudSessionStatus);
  }
}

class ReplayingSession implements CloudTeamSessionPort {
  public async runWithSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
  ): Promise<Value> {
    await operation(sessionStatus());
    return operation(sessionStatus());
  }
}

function sessionStatus(): ConfiguredCloudSessionStatus {
  return {
    account: { accountId: ACCOUNT_ID },
  } as ConfiguredCloudSessionStatus;
}

function createApi(): CloudTeamWorkspaceApi {
  return {
    createTeam: vi.fn().mockResolvedValue(undefined),
    listTeams: vi.fn().mockResolvedValue(undefined),
    listTeamMembers: vi.fn().mockResolvedValue(undefined),
    createTeamInvitation: vi.fn().mockResolvedValue(undefined),
    acceptTeamInvitation: vi.fn().mockResolvedValue(undefined),
    changeTeamMemberRole: vi.fn().mockResolvedValue(undefined),
    revokeTeamMembership: vi.fn().mockResolvedValue(undefined),
    listProjectAssignments: vi.fn().mockResolvedValue(undefined),
    setProjectAssignment: vi.fn().mockResolvedValue(undefined),
  };
}
