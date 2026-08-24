import { describe, expect, it } from "vitest";

import type { NovelAiTask } from "./model-hub-provider-registry";
import type { ModelCatalogEntry, ModelProviderConnection, NovelTaskRoute } from "./model-hub-store";
import { projectModelHubReadiness } from "./model-hub-readiness";

const NOW = "2026-08-08T00:00:00.000Z";
const CORE_TASKS: readonly NovelAiTask[] = [
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "chapter_summary",
  "long_memory_compression",
  "contradiction_check",
  "pov_check",
  "character_voice_check",
  "content_quality_check",
];

describe("projectModelHubReadiness", () => {
  it.each([
    ["unconnected", [], [], []],
    ["checking", [connection({ connectionStatus: "checking" })], [], []],
    [
      "connection_failed",
      [connection({ connectionStatus: "error", lastErrorCode: "HTTP_401" })],
      [],
      [],
    ],
    [
      "quota_insufficient",
      [connection({ connectionStatus: "error", lastErrorCode: "INSUFFICIENT_BALANCE" })],
      [],
      [],
    ],
  ] as const)(
    "projects %s without inventing task readiness",
    (state, connections, catalog, routes) => {
      expect(projectModelHubReadiness({ connections, catalog, routes, now: NOW }).state).toBe(
        state,
      );
    },
  );

  it("distinguishes partial from complete base configuration without claiming request readiness", () => {
    const connections = [connection()];
    const catalog = [catalogEntry()];
    const basicRoutes = CORE_TASKS.slice(0, 4).map((task) => route(task));
    const basic = projectModelHubReadiness({ connections, catalog, routes: basicRoutes, now: NOW });
    expect(basic).toMatchObject({
      state: "basic_ready",
      runnableCoreTaskCount: 4,
      shortLabel: "AI 基础连接可用",
    });
    expect(basic.description).toContain("当前作品仍会在发送前单独检查隐私、参考资料和请求长度");

    const complete = projectModelHubReadiness({
      connections,
      catalog,
      routes: CORE_TASKS.map((task) => route(task)),
      now: NOW,
    });
    expect(complete).toMatchObject({
      state: "fully_ready",
      runnableCoreTaskCount: 10,
      missingCoreTasks: [],
      shortLabel: "AI 基础连接可用",
    });
    expect(complete.description).toContain("每个章节在发送前仍会单独检查");
  });

  it("reports partial availability when a configured fallback is actually required", () => {
    const connections = [connection(), connection({ id: "fallback" })];
    const catalog = [
      catalogEntry({ availability: "unavailable" }),
      catalogEntry({ id: "fallback-model", connectionId: "fallback" }),
    ];
    const routes = CORE_TASKS.map((task) =>
      route(task, {
        fallbackCatalogEntryId: "fallback-model",
        failurePolicy: "use_fallback",
      }),
    );
    expect(projectModelHubReadiness({ connections, catalog, routes, now: NOW })).toMatchObject({
      state: "partially_unavailable",
      runnableCoreTaskCount: 10,
    });
  });

  it("does not treat an available catalog entry without task routing as ready", () => {
    expect(
      projectModelHubReadiness({
        connections: [connection()],
        catalog: [catalogEntry()],
        routes: [],
        now: NOW,
      }),
    ).toMatchObject({ state: "partially_unavailable", runnableCoreTaskCount: 0 });
  });

  it("does not claim basic readiness when the exact continuation resolver blocks a shallow-ready route", () => {
    const readiness = projectModelHubReadiness({
      connections: [connection()],
      catalog: [catalogEntry()],
      routes: CORE_TASKS.slice(0, 4).map((task) => route(task)),
      exactBlockers: [
        {
          task: "continuation",
          code: "MODEL_HUB_CREDENTIAL_MISSING",
        },
      ],
      now: NOW,
    });
    expect(readiness).toMatchObject({
      state: "partially_unavailable",
      runnableCoreTaskCount: 3,
    });
    expect(readiness.missingCoreTasks).toContain("continuation");
    expect(readiness.exactBlockers).toEqual([
      { task: "continuation", code: "MODEL_HUB_CREDENTIAL_MISSING" },
    ]);
  });
});

function connection(overrides: Partial<ModelProviderConnection> = {}): ModelProviderConnection {
  return {
    id: "primary",
    providerKind: "openai",
    displayName: "OpenAI",
    protocol: "openai_compatible",
    region: null,
    workspaceId: null,
    endpointId: null,
    baseUrl: "https://api.openai.com/v1",
    credentialRef: "keyring:test",
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    credentialHeaderName: null,
    modelDiscoveryPath: "/models",
    textGenerationPath: "/chat/completions",
    embeddingPath: "/embeddings",
    requestTimeoutMs: 30_000,
    retryLimit: 0,
    connectionStatus: "ready",
    catalogSyncStatus: "succeeded",
    lastTestedAt: NOW,
    lastCatalogSyncedAt: NOW,
    lastErrorCode: null,
    lastErrorSummary: null,
    legacyProviderId: null,
    enabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function catalogEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: "primary-model",
    connectionId: "primary",
    providerModelId: "writer",
    displayName: "Writer",
    ownedBy: null,
    catalogSource: "provider_api",
    availability: "available",
    lifecycle: "stable",
    inputTokenLimit: 32_000,
    outputTokenLimit: 4_000,
    firstDiscoveredAt: NOW,
    lastSeenAt: NOW,
    staleAfter: "2026-09-08T00:00:00.000Z",
    lastSyncId: null,
    revision: 1,
    ...overrides,
  };
}

function route(task: NovelAiTask, overrides: Partial<NovelTaskRoute> = {}): NovelTaskRoute {
  return {
    task,
    primaryCatalogEntryId: "primary-model",
    fallbackCatalogEntryId: null,
    presetId: null,
    parameterPolicy: {},
    maximumCostMicros: null,
    currency: null,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "ask_user",
    routeOrigin: "automatic",
    enabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
