import { describe, expect, it, vi } from "vitest";

import {
  StudioTeamTemplateService,
  type StudioTeamTemplateRemotePort,
  type StudioTeamTemplateRole,
  type StudioTeamTemplateSessionContext,
} from "./studio-team-template-service";

const ROLES: readonly StudioTeamTemplateRole[] = [
  "owner",
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
];

describe("Studio team-template remote permission boundary", () => {
  it.each(ROLES)("matches the encrypted template capability matrix for %s", (role) => {
    const service = createService(remote(), true, true);
    const capabilities = service.capabilities(context(role));

    expect(capabilities.read).toBe(role !== "finance_admin");
    expect(capabilities.create).toBe(role === "owner" || role === "admin" || role === "author");
    expect(capabilities.clone).toBe(role === "owner" || role === "admin" || role === "author");
    expect(capabilities.apply).toBe(role === "owner" || role === "admin" || role === "author");
    expect(capabilities.publish).toBe(role === "owner" || role === "admin");
    expect(capabilities.archive).toBe(role === "owner" || role === "admin");
  });

  it("keeps authorized history reads available while the mutation rollout is disabled", () => {
    const service = createService(remote(), true, false);

    expect(service.capabilities(context("reviewer"))).toMatchObject({
      read: true,
      create: false,
      clone: false,
      apply: false,
      publish: false,
      archive: false,
    });
    expect(() => service.authorize(context("author"), "create")).toThrow(
      expect.objectContaining({ code: "TEAM_TEMPLATE_FEATURE_DISABLED" }),
    );
    expect(() => service.authorize(context("reviewer"), "read")).not.toThrow();
  });

  it("requires an active membership and exact active project assignment", () => {
    const service = createService(remote(), true, true);

    expect(() =>
      service.authorize({ ...context("owner"), assignmentState: "missing" }, "read"),
    ).toThrow(expect.objectContaining({ code: "TEAM_TEMPLATE_PERMISSION_DENIED" }));
    expect(() =>
      service.authorize({ ...context("admin"), assignmentState: "revoked" }, "archive"),
    ).toThrow(expect.objectContaining({ code: "TEAM_TEMPLATE_PERMISSION_DENIED" }));
    expect(() =>
      service.authorize({ ...context("author"), membershipState: "revoked" }, "create"),
    ).toThrow(expect.objectContaining({ code: "TEAM_TEMPLATE_PERMISSION_DENIED" }));
  });

  it("blocks finance and reviewer writes before the cloud client boundary", async () => {
    const cloud = remote();
    const service = createService(cloud, true, true);

    await expect(service.listTemplates(context("finance_admin"))).rejects.toMatchObject({
      code: "TEAM_TEMPLATE_PERMISSION_DENIED",
    });
    await expect(
      service.archiveTemplate(
        context("reviewer"),
        uuid(5),
        { schemaVersion: 1, expectedRevision: 1 },
        { idempotencyKey: "template.archive.00000001" },
      ),
    ).rejects.toMatchObject({ code: "TEAM_TEMPLATE_PERMISSION_DENIED" });
    expect(cloud.listTeamTemplates).not.toHaveBeenCalled();
    expect(cloud.archiveTeamTemplate).not.toHaveBeenCalled();
  });

  it("does not fake a remote read while offline and honours pre-cancellation", async () => {
    const cloud = remote();
    const offline = createService(cloud, false, true);
    await expect(offline.listTemplates(context("author"))).rejects.toMatchObject({
      code: "TEAM_TEMPLATE_OFFLINE",
    });

    const online = createService(cloud, true, true);
    const abort = new AbortController();
    abort.abort();
    await expect(
      online.getTemplate(context("author"), uuid(5), abort.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cloud.listTeamTemplates).not.toHaveBeenCalled();
    expect(cloud.getTeamTemplate).not.toHaveBeenCalled();
  });
});

function createService(
  cloud: StudioTeamTemplateRemotePort,
  online: boolean,
  enabled: boolean,
): StudioTeamTemplateService {
  return new StudioTeamTemplateService(
    cloud,
    { isOnline: () => online },
    { isMutationEnabled: () => enabled },
  );
}

function remote(): StudioTeamTemplateRemotePort {
  return {
    archiveTeamTemplate: vi.fn(),
    cloneTeamTemplate: vi.fn(),
    createTeamTemplate: vi.fn(),
    createTeamTemplateVersion: vi.fn(),
    getTeamTemplate: vi.fn(),
    getTeamTemplateVersion: vi.fn(),
    listTeamTemplates: vi.fn(),
    listTeamTemplateVersions: vi.fn(),
    publishTeamTemplate: vi.fn(),
    recordTeamTemplateApplication: vi.fn(),
  };
}

function context(role: StudioTeamTemplateRole): StudioTeamTemplateSessionContext {
  return {
    tenantId: uuid(1),
    teamId: uuid(2),
    projectId: uuid(3),
    membershipId: uuid(4),
    deviceId: uuid(9),
    role,
    membershipState: "active",
    assignmentState: "active",
  };
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
