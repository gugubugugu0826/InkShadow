import { describe, expect, it, vi } from "vitest";

import {
  StudioReviewService,
  type StudioReviewRemotePort,
  type StudioReviewRole,
  type StudioReviewSessionContext,
} from "./studio-review-service";

const ROLES: readonly StudioReviewRole[] = [
  "owner",
  "admin",
  "author",
  "reviewer",
  "read_only",
  "finance_admin",
];

describe("Studio review remote permission boundary", () => {
  it.each(ROLES)("matches the fail-closed review capability matrix for %s", (role) => {
    const service = new StudioReviewService(remote(), { isOnline: () => true });
    const capabilities = service.capabilities(context(role));

    expect(capabilities.read).toBe(
      role === "owner" || role === "admin" || role === "author" || role === "reviewer",
    );
    expect(capabilities.submit).toBe(role === "owner" || role === "admin" || role === "author");
    expect(capabilities.requestRewrite).toBe(
      role === "owner" || role === "admin" || role === "reviewer",
    );
    expect(capabilities.approve).toBe(role === "owner" || role === "admin" || role === "reviewer");
    expect(capabilities.decideSuggestion).toBe(
      role === "owner" || role === "admin" || role === "author",
    );
  });

  it("blocks reviewer submission and suggestion acceptance before any remote call", () => {
    const cloud = remote();
    const service = new StudioReviewService(cloud, { isOnline: () => true });

    expect(() => service.authorize(context("reviewer"), "submit")).toThrow(
      expect.objectContaining({ code: "REVIEW_PERMISSION_DENIED" }),
    );
    expect(() => service.authorize(context("reviewer"), "decide_suggestion")).toThrow(
      expect.objectContaining({ code: "REVIEW_PERMISSION_DENIED" }),
    );
    expect(cloud.submitReview).not.toHaveBeenCalled();
    expect(cloud.decideReviewSuggestion).not.toHaveBeenCalled();
  });

  it("requires an active exact assignment even for owners and admins", () => {
    const service = new StudioReviewService(remote(), { isOnline: () => true });

    expect(() =>
      service.authorize({ ...context("owner"), assignmentState: "missing" }, "read"),
    ).toThrow(expect.objectContaining({ code: "REVIEW_PERMISSION_DENIED" }));
    expect(() =>
      service.authorize({ ...context("admin"), assignmentState: "revoked" }, "submit"),
    ).toThrow(expect.objectContaining({ code: "REVIEW_PERMISSION_DENIED" }));
    expect(() =>
      service.authorize({ ...context("author"), membershipState: "revoked" }, "read"),
    ).toThrow(expect.objectContaining({ code: "REVIEW_PERMISSION_DENIED" }));
  });

  it("does not fake remote success while offline", async () => {
    const cloud = remote();
    const service = new StudioReviewService(cloud, { isOnline: () => false });

    await expect(service.listReviews(context("author"))).rejects.toMatchObject({
      code: "REVIEW_OFFLINE",
    });
    expect(cloud.listReviews).not.toHaveBeenCalled();
  });

  it("honours pre-cancellation without crossing the transport boundary", async () => {
    const cloud = remote();
    const service = new StudioReviewService(cloud, { isOnline: () => true });
    const abort = new AbortController();
    abort.abort();

    await expect(service.getReview(context("author"), uuid(8), abort.signal)).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(cloud.getReview).not.toHaveBeenCalled();
  });
});

function remote(): StudioReviewRemotePort {
  return {
    appendReviewThreadItem: vi.fn(),
    decideReview: vi.fn(),
    decideReviewSuggestion: vi.fn(),
    getReview: vi.fn(),
    listReviews: vi.fn(),
    listReviewThreadItems: vi.fn(),
    listReviewThreads: vi.fn(),
    resolveReviewThread: vi.fn(),
    submitReview: vi.fn(),
  };
}

function context(role: StudioReviewRole): StudioReviewSessionContext {
  return {
    tenantId: uuid(1),
    teamId: uuid(2),
    projectId: uuid(3),
    membershipId: uuid(4),
    role,
    membershipState: "active",
    assignmentState: "active",
  };
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
