import assert from "node:assert/strict";
import test from "node:test";

import { createSupportBundle } from "./create-support-bundle.mjs";

const SNAPSHOT = {
  schemaVersion: 1,
  appVersion: "0.1.0",
  deploymentMode: "private",
  configuration: {
    databaseTlsRequired: true,
    httpsRequired: true,
    minimumClientVersion: "0.1.0",
    oidcProviderCount: 1,
    licensedTeamCount: 1,
    teamInvitationDeliveryConfigured: true,
  },
  health: {
    ready: true,
    postgresIdleConnections: 3,
    postgresTotalConnections: 5,
    postgresWaitingRequests: 0,
  },
  errorCounts: [{ code: "SSO_PROVIDER_UNAVAILABLE", count: 2 }],
  recentEvents: [
    {
      at: "2026-07-28T00:00:00.000Z",
      requestId: "018f0d7a-3b2c-7abc-8def-000000000001",
      code: "SSO_PROVIDER_UNAVAILABLE",
      route: "/v1/enterprise/sso/callbacks",
      durationMs: 250,
    },
  ],
};

test("support bundle contains only allowlisted operational fields", () => {
  const bundle = createSupportBundle(SNAPSHOT, new Date("2026-07-28T01:00:00.000Z"));
  assert.equal(bundle.generatedAt, "2026-07-28T01:00:00.000Z");
  assert.match(bundle.supportId, /^[0-9a-f-]{36}$/u);
  const serialized = JSON.stringify(bundle);
  for (const canary of [
    "writer@example.com",
    "postgresql://secret",
    "Bearer secret",
    "novel prose canary",
    "C:\\Users\\writer\\book.txt",
  ]) {
    assert.equal(serialized.includes(canary), false);
  }
});

test("support bundle rejects unknown fields instead of attempting heuristic redaction", () => {
  assert.throws(
    () =>
      createSupportBundle({
        ...SNAPSHOT,
        prompt: "novel prose canary",
      }),
    /unsupported field/u,
  );
  assert.throws(
    () =>
      createSupportBundle({
        ...SNAPSHOT,
        recentEvents: [
          {
            ...SNAPSHOT.recentEvents[0],
            email: "writer@example.com",
          },
        ],
      }),
    /unsupported field/u,
  );
});

test("support bundle accepts route templates but rejects concrete resource identifiers", () => {
  assert.doesNotThrow(() =>
    createSupportBundle({
      ...SNAPSHOT,
      recentEvents: [
        {
          ...SNAPSHOT.recentEvents[0],
          route: "/v1/teams/:teamId/enterprise/policy",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      createSupportBundle({
        ...SNAPSHOT,
        recentEvents: [
          {
            ...SNAPSHOT.recentEvents[0],
            route: "/v1/teams/018f0d7a-3b2c-7abc-8def-000000000001/enterprise/policy",
          },
        ],
      }),
    /recent event is invalid/u,
  );
});
