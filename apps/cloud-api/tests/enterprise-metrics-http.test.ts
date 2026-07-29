import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createCloudApiServer } from "../src/http/server.js";
import { CloudMetricsRegistry } from "../src/operations/metrics.js";
import type { CloudProjectSyncService } from "../src/service/project-sync-service.js";
import type { CloudIdentityService } from "../src/service/identity-service.js";

const TOKEN = "metrics-token-".padEnd(48, "m");
const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const servers: ReturnType<typeof createCloudApiServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Enterprise metrics HTTP boundary", () => {
  it("keeps metrics internal, authenticated and free of bearer material", async () => {
    const metrics = new CloudMetricsRegistry({
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
      deploymentMode: "private",
      licenseNotBeforeTimestampSeconds: Date.parse("2026-01-01T00:00:00.000Z") / 1_000,
      licenseExpiryTimestampSeconds: Date.parse("2027-01-01T00:00:00.000Z") / 1_000,
      poolSnapshot: () => ({
        idleConnections: 3,
        totalConnections: 5,
        waitingRequests: 0,
      }),
    });
    metrics.observeRequest({
      durationMs: 12,
      method: "GET",
      route: `/v1/projects/${REQUEST_ID}`,
      status: 404,
    });
    const server = createTestServer(metrics);

    const denied = await server.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: { "x-request-id": REQUEST_ID },
    });
    expect(denied.statusCode).toBe(403);

    const response = await server.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-request-id": REQUEST_ID,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain('inkshadow_build_info{deployment_mode="private"} 1');
    expect(response.body).toContain('inkshadow_postgres_connections{state="total"} 5');
    expect(response.body).toContain('route="unknown"');
    expect(response.body).not.toContain(REQUEST_ID);
    expect(response.body).not.toContain(TOKEN);
  });

  it("permits cluster probes over pod HTTP while business routes still require HTTPS", async () => {
    const server = createTestServer(new CloudMetricsRegistry({ deploymentMode: "private" }));
    const live = await server.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const business = await server.inject({
      method: "GET",
      url: "/v1/teams/018f0d7a-3b2c-7abc-8def-000000000001/enterprise/policy",
    });
    expect(business.statusCode).toBe(400);
    expect(business.json()).toMatchObject({
      error: { code: "ACCESS_FORBIDDEN" },
    });
  });
});

function createTestServer(metrics: CloudMetricsRegistry) {
  const server = createCloudApiServer({
    identityService: {} as CloudIdentityService,
    metrics,
    metricsBearerTokenHash: createHash("sha256").update(TOKEN, "utf8").digest(),
    projectSyncService: {} as CloudProjectSyncService,
    requireHttps: true,
    uuid: () => REQUEST_ID,
  });
  servers.push(server);
  return server;
}
