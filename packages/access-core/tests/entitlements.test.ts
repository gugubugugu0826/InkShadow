import { describe, expect, it } from "vitest";

import { evaluateEntitlements, LOCAL_CAPABILITIES } from "../src/index.js";

describe("entitlement evaluation", () => {
  it.each(["expired", "canceled", "refunded", "offline_expired"] as const)(
    "keeps every local capability available when subscription is %s",
    (subscriptionState) => {
      const result = evaluateEntitlements({
        tier: "pro",
        subscriptionState,
        evidence: "server_verified",
        grantedCapabilities: [],
        enabledFlags: [],
      });

      expect(LOCAL_CAPABILITIES.every((capability) => result.can(capability))).toBe(true);
      expect(result.can("sync.e2ee")).toBe(false);
    },
  );

  it("requires tier, verified entitlement, subscription, and flag for remote capability", () => {
    const allowed = evaluateEntitlements({
      tier: "pro",
      subscriptionState: "active",
      evidence: "server_verified",
      grantedCapabilities: ["sync.e2ee"],
      enabledFlags: ["sync.e2ee"],
    });
    expect(allowed.decisions["sync.e2ee"]).toEqual({
      capability: "sync.e2ee",
      allowed: true,
      reason: "verified_entitlement",
    });

    expect(
      evaluateEntitlements({
        tier: "pro",
        subscriptionState: "active",
        evidence: "server_verified",
        grantedCapabilities: ["sync.e2ee"],
        enabledFlags: [],
      }).decisions["sync.e2ee"].reason,
    ).toBe("feature_flag_disabled");
    expect(
      evaluateEntitlements({
        tier: "community",
        subscriptionState: "active",
        evidence: "server_verified",
        grantedCapabilities: ["sync.e2ee"],
        enabledFlags: ["sync.e2ee"],
      }).decisions["sync.e2ee"].reason,
    ).toBe("tier_unavailable");
  });

  it("never trusts an unverified client-side capability claim", () => {
    const result = evaluateEntitlements({
      tier: "enterprise",
      subscriptionState: "active",
      evidence: "unverified",
      grantedCapabilities: ["enterprise.sso"],
      enabledFlags: ["enterprise.sso"],
    });

    expect(result.decisions["enterprise.sso"]).toMatchObject({
      allowed: false,
      reason: "evidence_unverified",
    });
  });

  it("allows explicit grace access but denies past-due access without a grace state", () => {
    const common = {
      tier: "studio",
      evidence: "server_verified",
      grantedCapabilities: ["team.review"],
      enabledFlags: ["team.review"],
    } as const;
    expect(evaluateEntitlements({ ...common, subscriptionState: "grace" }).can("team.review")).toBe(
      true,
    );
    expect(
      evaluateEntitlements({ ...common, subscriptionState: "past_due" }).can("team.review"),
    ).toBe(false);
  });
});
