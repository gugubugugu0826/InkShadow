import { describe, expect, it } from "vitest";

import { ModelRoutingInputError, resolveModelRoute } from "../src/index.js";

const route = {
  role: "high_quality",
  primary: { providerId: "cloud-primary", modelId: "writer-large" },
  fallback: { providerId: "ollama-local", modelId: "qwen-local" },
} as const;

describe("model role routing", () => {
  it("selects an exact verified primary without silently changing the route", () => {
    const result = resolveModelRoute(route, [
      {
        ...route.primary,
        location: "remote",
        verification: "verified",
        capabilities: ["high_quality"],
      },
      {
        ...route.fallback,
        location: "local",
        verification: "verified",
        capabilities: ["high_quality", "local_private"],
      },
    ]);

    expect(result).toMatchObject({
      status: "resolved",
      selected: route.primary,
      reason: "primary_verified",
      requiresConfirmation: false,
    });
  });

  it("surfaces an explicitly configured verified fallback for confirmation", () => {
    const result = resolveModelRoute(route, [
      {
        ...route.primary,
        location: "remote",
        verification: "unavailable",
        capabilities: ["high_quality"],
      },
      {
        ...route.fallback,
        location: "local",
        verification: "verified",
        capabilities: ["high_quality", "local_private"],
      },
    ]);

    expect(result).toMatchObject({
      status: "resolved",
      selected: route.fallback,
      reason: "fallback_verified",
      requiresConfirmation: true,
    });
  });

  it("keeps an offline primary pending rather than inventing verification", () => {
    const result = resolveModelRoute(route, [
      {
        ...route.primary,
        location: "remote",
        verification: "not_checked",
        capabilities: ["high_quality"],
      },
    ]);

    expect(result).toMatchObject({
      status: "resolved",
      selected: route.primary,
      reason: "primary_pending_verification",
      requiresConfirmation: true,
    });
  });

  it("blocks when no configured target has the requested capability", () => {
    const result = resolveModelRoute(route, [
      {
        ...route.primary,
        location: "remote",
        verification: "verified",
        capabilities: ["embedding"],
      },
    ]);

    expect(result).toMatchObject({ status: "blocked", reason: "no_eligible_target" });
  });

  it("rejects duplicate primary and fallback targets", () => {
    expect(() =>
      resolveModelRoute(
        {
          ...route,
          fallback: route.primary,
        },
        [],
      ),
    ).toThrow(ModelRoutingInputError);
  });
});
