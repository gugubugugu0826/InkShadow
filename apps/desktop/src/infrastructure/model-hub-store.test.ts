import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ExecuteResult, SqlPrimitive } from "@inkshadow/data";
import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  BrowserDevelopmentModelHubStore,
  DEVELOPMENT_MODEL_HUB_KEY,
  isRetiredModelProviderConnection,
  TauriModelHubStore,
  type ModelHubStore,
} from "./model-hub-store";

const NOW = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };
const migration = [
  readMigration("0004_model_profiles.sql"),
  readMigration("0031_model_hub.sql"),
  readMigration("0037_model_hub_expert_options.sql"),
  readMigration("0046_model_hub_zhipu_glm.sql"),
  readMigration("0051_model_hub_connection_commits.sql"),
  readMigration("0056_model_hub_failure_diagnostics.sql"),
  readMigration("0057_model_hub_content_quality_task.sql"),
  readMigration("0065_model_invocation_dispatch_boundary.sql"),
].join("\n");

describe("TauriModelHubStore", () => {
  it("atomically applies idempotent automatic plans while preserving manual routes in SQLite and browser storage", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const sqlite = new TauriModelHubStore(executor, clock);
    await assertAutomaticRoutingPlanIsIdempotent(
      sqlite,
      () => new TauriModelHubStore(executor, clock),
      "sqlite-automatic-plan",
    );
    await executor.close();

    window.localStorage.clear();
    const browser = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await assertAutomaticRoutingPlanIsIdempotent(
      browser,
      () => new BrowserDevelopmentModelHubStore(window.localStorage, clock),
      "browser-automatic-plan",
    );
  });

  it("rolls back the complete SQLite plan when a later route write fails", async () => {
    const executor = new FailingNodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);
    const catalogIds = await seedAvailableCatalog(store, "rollback-plan");
    await store.applyAutomaticRoutingPlan({
      preset: automaticPreset("smart"),
      routes: [automaticRoute("idea_discussion", catalogIds[0])],
    });
    const originalRoute = await store.findTaskRoute("idea_discussion");
    const originalPreset = await store.findActivePreset();

    executor.failNextMatching("INSERT INTO novel_task_routes");
    await expect(
      store.applyAutomaticRoutingPlan({
        preset: automaticPreset("quality"),
        routes: [
          automaticRoute("idea_discussion", catalogIds[1]),
          automaticRoute("book_start_guidance", catalogIds[1]),
        ],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
      retryable: true,
    });

    const reopened = new TauriModelHubStore(executor, clock);
    await expect(reopened.findActivePreset()).resolves.toEqual(originalPreset);
    await expect(reopened.findTaskRoute("idea_discussion")).resolves.toEqual(originalRoute);
    await expect(reopened.findTaskRoute("book_start_guidance")).resolves.toBeNull();
    await expect(reopened.listPresets()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "automatic-quality" })]),
    );
    await executor.close();
  });

  it("keeps browser memory and persisted state unchanged when plan persistence fails", async () => {
    const storage = new ToggleFailStorage();
    const store = new BrowserDevelopmentModelHubStore(storage, clock);
    const catalogIds = await seedAvailableCatalog(store, "browser-plan-failure");
    storage.failWrites = true;

    await expect(
      store.applyAutomaticRoutingPlan({
        preset: automaticPreset("smart"),
        routes: [automaticRoute("content_quality_check", catalogIds[0])],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
      retryable: true,
    });
    await expect(store.findActivePreset()).resolves.toBeNull();
    await expect(store.findTaskRoute("content_quality_check")).resolves.toBeNull();

    storage.failWrites = false;
    const reopened = new BrowserDevelopmentModelHubStore(storage, clock);
    await expect(reopened.findActivePreset()).resolves.toBeNull();
    await expect(reopened.findTaskRoute("content_quality_check")).resolves.toBeNull();
  });

  it("publishes a verified connection and catalog atomically while preserving the old route on failure", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);
    let existing = await store.saveConnection({
      id: "atomic-openai",
      providerKind: "openai",
      displayName: "Atomic OpenAI",
      credentialRef: "keyring:model-hub:atomic-openai",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    existing = await store.recordConnectionTest({
      connectionId: existing.id,
      status: "ready",
      expectedRevision: existing.revision,
    });
    await store.syncCatalog({
      syncId: "atomic-old-sync",
      connectionId: existing.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "atomic-old-entry", providerModelId: "writer-model" }],
    });
    const current = await store.findConnection(existing.id);
    if (current === null) throw new Error("Expected the seeded connection.");
    const route = await store.saveTaskRoute({
      task: "book_start_guidance",
      primaryCatalogEntryId: "atomic-old-entry",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "ask_user",
      routeOrigin: "user",
      expectedRevision: null,
    });
    await store.saveConnection({
      id: "atomic-other",
      providerKind: "ollama",
      displayName: "Other",
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await store.syncCatalog({
      syncId: "atomic-other-sync",
      connectionId: "atomic-other",
      source: "manual",
      status: "succeeded",
      models: [{ id: "atomic-collision", providerModelId: "other-model" }],
    });
    await store.prepareConnectionCommit({
      id: "atomic-commit",
      connectionId: current.id,
      credentialProviderId: "atomic-new-slot",
    });

    await expect(
      store.publishConnectionCommit({
        id: "atomic-commit",
        credentialProviderId: "atomic-new-slot",
        cleanupCredentialProviderId: "atomic-openai",
        connection: {
          id: current.id,
          providerKind: current.providerKind,
          displayName: current.displayName,
          baseUrlOverride: current.baseUrl,
          credentialRef: "keyring:model-hub:atomic-new-slot",
          credentialState: "present",
          authenticationMode: "bearer_keyring",
          enabled: true,
          expectedRevision: current.revision,
        },
        catalog: {
          syncId: "atomic-failed-sync",
          connectionId: current.id,
          source: "provider_api",
          status: "succeeded",
          models: [{ id: "atomic-collision", providerModelId: "new-writer-model" }],
        },
      }),
    ).rejects.toBeDefined();

    await expect(store.findConnection(current.id)).resolves.toEqual(current);
    await expect(store.listCatalog(current.id)).resolves.toEqual([
      expect.objectContaining({ id: "atomic-old-entry", availability: "available" }),
    ]);
    await expect(store.findTaskRoute("book_start_guidance")).resolves.toEqual(route);
    await expect(store.findConnectionCommit(current.id)).resolves.toMatchObject({
      id: "atomic-commit",
      phase: "prepared",
    });

    const published = await store.publishConnectionCommit({
      id: "atomic-commit",
      credentialProviderId: "atomic-new-slot",
      cleanupCredentialProviderId: "atomic-openai",
      connection: {
        id: current.id,
        providerKind: current.providerKind,
        displayName: current.displayName,
        baseUrlOverride: current.baseUrl,
        credentialRef: "keyring:model-hub:atomic-new-slot",
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        enabled: true,
        expectedRevision: current.revision,
      },
      catalog: {
        syncId: "atomic-success-sync",
        connectionId: current.id,
        source: "provider_api",
        status: "succeeded",
        models: [{ id: "unused-new-id", providerModelId: "writer-model" }],
      },
    });
    expect(published.connection).toMatchObject({
      connectionStatus: "ready",
      credentialRef: "keyring:model-hub:atomic-new-slot",
    });
    expect(published.catalog).toContainEqual(
      expect.objectContaining({ id: "atomic-old-entry", availability: "available" }),
    );
    expect(published.commit).toMatchObject({
      phase: "cleanup_pending",
      cleanupCredentialProviderId: "atomic-openai",
    });
    await expect(store.findTaskRoute("book_start_guidance")).resolves.toEqual(route);
    await executor.close();
  });

  it("persists the registered Zhipu GLM provider in real SQLite", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);
    const saved = await store.saveConnection({
      id: "zhipu-glm-primary",
      providerKind: "zhipu_glm",
      displayName: "智谱 GLM",
      credentialRef: "keyring:model-hub:zhipu-glm-primary",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });

    expect(saved).toMatchObject({
      providerKind: "zhipu_glm",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      authenticationMode: "bearer_keyring",
      credentialState: "present",
      revision: 1,
    });
    const reopened = new TauriModelHubStore(executor, clock);
    await expect(reopened.findConnection(saved.id)).resolves.toMatchObject(saved);
    await executor.close();
  });

  it("persists bounded custom endpoint metadata without storing a credential Header value", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);
    const saved = await store.saveConnection({
      id: "custom-safe",
      providerKind: "custom_openai_compatible",
      displayName: "Custom safe gateway",
      baseUrlOverride: "https://models.example.test/v1",
      credentialRef: "keyring:model-hub:custom-safe",
      credentialState: "present",
      authenticationMode: "custom_header_keyring",
      credentialHeaderName: "X-API-Key",
      modelDiscoveryPath: "/catalog/models",
      textGenerationPath: "/generation/chat",
      embeddingPath: "/vectors/embed",
      requestTimeoutMs: 45_000,
      retryLimit: 2,
      expectedRevision: null,
    });

    expect(saved).toMatchObject({
      authenticationMode: "custom_header_keyring",
      credentialHeaderName: "x-api-key",
      modelDiscoveryPath: "/catalog/models",
      textGenerationPath: "/generation/chat",
      embeddingPath: "/vectors/embed",
      requestTimeoutMs: 45_000,
      retryLimit: 2,
      revision: 1,
    });
    const reopened = new TauriModelHubStore(executor, clock);
    await expect(reopened.findConnection(saved.id)).resolves.toMatchObject(saved);
    const columns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('model_provider_connections') ORDER BY cid",
    );
    expect(columns.map(({ name }) => name)).not.toContain("credential_header_value");
    expect(
      JSON.stringify(await executor.select("SELECT * FROM model_provider_connections")),
    ).not.toContain("super-secret-header-value");
    await expect(
      store.saveConnection({
        ...saved,
        baseUrlOverride: saved.baseUrl,
        expectedRevision: 9,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_CONFLICT" });
    await executor.close();
  });

  it("rejects unsafe or ineffective authentication declarations before persistence", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);
    await expect(
      store.saveConnection({
        id: "named-without-key",
        providerKind: "openai",
        displayName: "Named cloud",
        credentialState: "missing",
        authenticationMode: "bearer_keyring",
        enabled: true,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CREDENTIAL_REQUIRED" });
    await expect(
      store.saveConnection({
        id: "custom-header-without-key",
        providerKind: "custom_openai_compatible",
        displayName: "Custom cloud",
        baseUrlOverride: "https://models.example.test/v1",
        credentialState: "missing",
        authenticationMode: "custom_header_keyring",
        credentialHeaderName: "x-api-key",
        enabled: false,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CREDENTIAL_REQUIRED" });
    await expect(
      store.saveConnection({
        id: "unused-key",
        providerKind: "custom_openai_compatible",
        displayName: "Unused key",
        baseUrlOverride: "https://models.example.test/v1",
        credentialRef: "keyring:model-hub:unused-key",
        credentialState: "present",
        authenticationMode: "none",
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CREDENTIAL_UNUSED" });
    await expect(
      store.saveConnection({
        id: "named-path-override",
        providerKind: "openai",
        displayName: "Named path override",
        credentialRef: "keyring:model-hub:named-path-override",
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        modelDiscoveryPath: "/other/models",
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_EXPERT_OPTIONS_FORBIDDEN" });
    await executor.close();
  });

  it("migrates and reopens browser expert metadata while failing closed on corruption", async () => {
    window.localStorage.clear();
    const store = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await store.saveConnection({
      id: "browser-custom",
      providerKind: "custom_openai_compatible",
      displayName: "Browser custom",
      baseUrlOverride: "https://browser-models.example/v1",
      credentialRef: "keyring:model-hub:browser-custom",
      credentialState: "present",
      authenticationMode: "custom_header_keyring",
      credentialHeaderName: "api-key",
      modelDiscoveryPath: "/model-catalog",
      textGenerationPath: "/text/generate",
      embeddingPath: "/text/embed",
      requestTimeoutMs: 90_000,
      retryLimit: 3,
      expectedRevision: null,
    });
    const reopened = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await expect(reopened.findConnection("browser-custom")).resolves.toMatchObject({
      credentialHeaderName: "api-key",
      modelDiscoveryPath: "/model-catalog",
      textGenerationPath: "/text/generate",
      embeddingPath: "/text/embed",
      requestTimeoutMs: 90_000,
      retryLimit: 3,
    });
    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_MODEL_HUB_KEY) ?? "null",
    ) as { state: { connections: Record<string, { credentialHeaderName: string }> } };
    const browserConnection = database.state.connections["browser-custom"];
    if (browserConnection === undefined) {
      throw new Error("Expected the persisted browser connection.");
    }
    browserConnection.credentialHeaderName = "Host";
    window.localStorage.setItem(DEVELOPMENT_MODEL_HUB_KEY, JSON.stringify(database));
    expect(() => new BrowserDevelopmentModelHubStore(window.localStorage, clock)).toThrow();
  });

  it("upgrades legacy browser scan ids as honest no-detail placeholders", async () => {
    window.localStorage.clear();
    const store = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await store.saveConnection({
      id: "legacy-browser-scan",
      providerKind: "custom_openai_compatible",
      displayName: "Legacy browser scan",
      baseUrlOverride: "https://legacy-browser.example.test/v1",
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await store.syncCatalog({
      syncId: "legacy-browser-sync",
      connectionId: "legacy-browser-scan",
      source: "manual",
      status: "succeeded",
      models: [{ id: "legacy-browser-model", providerModelId: "legacy-writer" }],
    });
    await store.recordCapabilityScan({
      scanId: "legacy-browser-scan-id",
      catalogEntryId: "legacy-browser-model",
      scanKind: "provider_metadata",
      status: "failed",
      evidenceVersion: "legacy-v1",
      errorCode: "MODEL_OUTPUT_TRUNCATED",
    });

    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_MODEL_HUB_KEY) ?? "null",
    ) as {
      schemaVersion: number;
      state: {
        capabilityScans?: Record<string, unknown>;
        capabilityScanIds?: Record<string, true>;
      };
    };
    database.schemaVersion = 5;
    database.state.capabilityScanIds = Object.fromEntries(
      Object.keys(database.state.capabilityScans ?? {}).map((id) => [id, true]),
    );
    delete database.state.capabilityScans;
    window.localStorage.setItem(DEVELOPMENT_MODEL_HUB_KEY, JSON.stringify(database));

    const reopened = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await expect(reopened.listRecentAiFailures()).resolves.toEqual([]);
    await expect(
      reopened.recordCapabilityScan({
        scanId: "legacy-browser-scan-id",
        catalogEntryId: "legacy-browser-model",
        scanKind: "provider_metadata",
        status: "failed",
        evidenceVersion: "replacement-v1",
        errorCode: "MODEL_OUTPUT_TRUNCATED",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_SCAN_CONFLICT" });
  });

  it("never reassigns an existing connection id to another provider kind", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const sqlite = new TauriModelHubStore(executor, clock);
    await assertProviderKindCannotBeOverwritten(sqlite, "sqlite-provider-id");
    await executor.close();

    window.localStorage.clear();
    const browser = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await assertProviderKindCannotBeOverwritten(browser, "browser-provider-id");
  });

  it("retires connections without deleting immutable invocation history in SQLite or browser storage", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const sqlite = new TauriModelHubStore(executor, clock);
    await assertConnectionRetirement(
      sqlite,
      () => new TauriModelHubStore(executor, clock),
      "sqlite-retired-provider",
    );
    const sqliteForeignKeys = await executor.select<{ violations: number }>(
      "SELECT COUNT(*) AS violations FROM pragma_foreign_key_check",
    );
    expect(sqliteForeignKeys[0]?.violations).toBe(0);
    await executor.close();

    window.localStorage.clear();
    const browser = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await assertConnectionRetirement(
      browser,
      () => new BrowserDevelopmentModelHubStore(window.localStorage, clock),
      "browser-retired-provider",
    );
  });

  it("invalidates local evidence and routes when an Ollama endpoint becomes remote", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const sqlite = new TauriModelHubStore(executor, clock);
    await assertLocalToRemoteTransitionFailsClosed(sqlite, "sqlite-ollama");
    await executor.close();

    window.localStorage.clear();
    const browser = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await assertLocalToRemoteTransitionFailsClosed(browser, "browser-ollama");
  });

  it("atomically commits capability probes only for the exact connection and catalog revisions", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const sqlite = new TauriModelHubStore(executor, clock);
    await assertCapabilityProbeCommitIsAtomic(sqlite, "sqlite-guarded-probe");
    await executor.close();

    window.localStorage.clear();
    const browser = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await assertCapabilityProbeCommitIsAtomic(browser, "browser-guarded-probe");
  });

  it("persists non-secret connections, dynamic catalogs, and CAS task routes", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);

    const connection = await store.saveConnection({
      id: "writer-cloud",
      providerKind: "openai",
      displayName: "写作模型",
      credentialRef: "keyring:model-hub:writer-cloud",
      credentialState: "present",
      expectedRevision: null,
    });
    expect(connection).toMatchObject({
      providerKind: "openai",
      protocol: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      revision: 1,
    });
    const tested = await store.recordConnectionTest({
      connectionId: connection.id,
      status: "error",
      errorCode: "AUTH_INVALID",
      errorSummary: "apiKey=sk-secretvalue123 was rejected",
      expectedRevision: 1,
    });
    expect(tested).toMatchObject({
      connectionStatus: "error",
      lastErrorCode: "AUTH_INVALID",
      revision: 2,
    });
    expect(tested.lastErrorSummary).toBe("apiKey=[REDACTED] was rejected");

    const firstCatalog = await store.syncCatalog({
      syncId: "sync-1",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        { id: "catalog-a", providerModelId: "runtime-model-a" },
        { id: "catalog-b", providerModelId: "runtime-model-b" },
      ],
    });
    expect(firstCatalog.map(({ providerModelId }) => providerModelId)).toEqual([
      "runtime-model-a",
      "runtime-model-b",
    ]);
    await expect(store.listCatalogSyncs(connection.id)).resolves.toMatchObject([
      { id: "sync-1", status: "succeeded", discoveredModelCount: 2 },
    ]);

    const evidence = await store.recordCapabilityScan({
      scanId: "scan-a",
      catalogEntryId: "catalog-a",
      scanKind: "provider_metadata",
      status: "succeeded",
      evidenceVersion: "provider-response-v1",
      evidence: [
        {
          id: "evidence-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "provider_metadata",
        },
        {
          id: "evidence-reasoning",
          capability: "reasoning",
          verdict: "unknown",
          evidenceSource: "provider_metadata",
        },
      ],
    });
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "text_generation", verdict: "supported" }),
        expect.objectContaining({ capability: "reasoning", verdict: "unknown" }),
      ]),
    );

    await store.savePreset({
      id: "smart-v1",
      scheme: "smart",
      displayName: "智能推荐",
      status: "active",
      privacyPolicy: "cloud_allowed",
      costPriority: "balanced",
      routeGenerationVersion: "router-v1",
      expectedRevision: null,
    });
    await store.savePreset({
      id: "privacy-v1",
      scheme: "local_privacy",
      displayName: "本地隐私",
      status: "active",
      privacyPolicy: "local_only",
      costPriority: "quality_first",
      routeGenerationVersion: "router-v1",
      expectedRevision: null,
    });
    await expect(store.findActivePreset()).resolves.toMatchObject({
      id: "privacy-v1",
      status: "active",
    });
    await expect(store.listPresets()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "smart-v1", status: "superseded", revision: 2 }),
      ]),
    );

    const createdRoute = await store.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: "catalog-a",
      fallbackCatalogEntryId: "catalog-b",
      parameterPolicy: { temperature: 0.7, streaming: true },
      maximumCostMicros: "5000000",
      currency: "USD",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "use_fallback",
      routeOrigin: "automatic",
      expectedRevision: null,
    });
    expect(createdRoute).toMatchObject({ revision: 1, parameterPolicy: { temperature: 0.7 } });
    await expect(
      store.saveTaskRoute({
        task: "prose_generation",
        primaryCatalogEntryId: "catalog-b",
        privacyPolicy: "cloud_allowed",
        failurePolicy: "stop",
        routeOrigin: "user",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_CONFLICT" });

    const secondCatalog = await store.syncCatalog({
      syncId: "sync-2",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "ignored-new-id", providerModelId: "runtime-model-a" }],
    });
    expect(secondCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "catalog-a", availability: "available" }),
        expect.objectContaining({ id: "catalog-b", availability: "unavailable" }),
      ]),
    );

    const database = JSON.stringify(await store.listConnections());
    expect(database).not.toContain("api-key-value");
    await executor.close();
  });

  it("records lifecycle-only invocation facts and enforces privacy and secret boundaries", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);
    await store.saveConnection({
      id: "local",
      providerKind: "ollama",
      displayName: "本地模型",
      credentialState: "missing",
      expectedRevision: null,
    });
    await store.syncCatalog({
      syncId: "local-sync",
      connectionId: "local",
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "local-model", providerModelId: "installed-model" }],
    });

    const started = await store.startInvocation({
      id: "call-1",
      task: "embedding",
      connectionId: "local",
      catalogEntryId: "local-model",
      providerKindSnapshot: "ollama",
      modelIdSnapshot: "installed-model",
      routeReason: "user_override",
      attempt: 1,
      privacyPolicy: "local_only",
      dataDestination: "local",
      maximumCostMicros: "0",
      currency: "USD",
    });
    expect(started).toMatchObject({
      status: "running",
      providerDispatchStartedAt: null,
      revision: 1,
    });
    const marked = await store.markInvocationDispatched({
      id: started.id,
      dispatchedAt: "2026-03-12T08:00:00.000Z",
      expectedRevision: started.revision,
    });
    expect(marked).toMatchObject({
      status: "running",
      providerDispatchStartedAt: "2026-03-12T08:00:00.000Z",
      revision: 2,
    });
    await expect(
      store.markInvocationDispatched({
        id: started.id,
        dispatchedAt: "2026-03-12T08:00:00.000Z",
        expectedRevision: started.revision,
      }),
    ).resolves.toEqual(marked);
    await expect(
      store.markInvocationDispatched({
        id: started.id,
        dispatchedAt: "2026-03-12T08:00:01.000Z",
        expectedRevision: marked.revision,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_INVOCATION_CONFLICT" });
    const completed = await store.finishInvocation({
      id: started.id,
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 0,
      cachedInputTokens: 0,
      estimatedCostMicros: "0",
      currency: "USD",
      completion: { visibleContentLength: 4, stream: false },
      expectedRevision: marked.revision,
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      completion: { visibleContentLength: 4, stream: false },
      failure: null,
      providerDispatchStartedAt: "2026-03-12T08:00:00.000Z",
      revision: 3,
    });
    await expect(store.findInvocation(started.id)).resolves.toMatchObject({
      completion: { visibleContentLength: 4, stream: false },
    });
    await expect(
      store.markInvocationDispatched({
        id: started.id,
        dispatchedAt: "2026-03-12T08:00:00.000Z",
        expectedRevision: completed.revision,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_INVOCATION_CONFLICT" });
    await expect(
      store.finishInvocation({
        id: started.id,
        status: "succeeded",
        completion: {
          visibleContentLength: 4,
          response: "must-not-persist",
        } as never,
        expectedRevision: completed.revision,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_COMPLETION_METADATA_INVALID" });

    await expect(
      store.startInvocation({
        id: "privacy-leak",
        task: "embedding",
        connectionId: "local",
        providerKindSnapshot: "ollama",
        modelIdSnapshot: "installed-model",
        routeReason: "user_override",
        attempt: 1,
        privacyPolicy: "local_only",
        dataDestination: "remote",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_PRIVACY_BLOCKED" });

    await expect(
      store.saveTaskRoute({
        task: "embedding",
        primaryCatalogEntryId: "local-model",
        parameterPolicy: { apiKey: "must-not-persist" },
        privacyPolicy: "local_only",
        failurePolicy: "stop",
        routeOrigin: "user",
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_SECRET_REJECTED" });
    await executor.close();
  });

  it("persists and lists only bounded AI failure metadata in SQLite and browser storage", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const sqlite = new TauriModelHubStore(executor, clock);
    await assertRecentAiFailurePersistence(
      sqlite,
      () => new TauriModelHubStore(executor, clock),
      "sqlite-failure",
    );
    await executor.close();

    window.localStorage.clear();
    const browser = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    await assertRecentAiFailurePersistence(
      browser,
      () => new BrowserDevelopmentModelHubStore(window.localStorage, clock),
      "browser-failure",
    );
  });

  it("persists cost, privacy, and aggregate evaluation evidence without content", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const store = new TauriModelHubStore(executor, clock);
    await store.saveConnection({
      id: "evaluation-cloud",
      providerKind: "openai",
      displayName: "Evaluation provider",
      credentialRef: "keyring:model-hub:evaluation-cloud",
      credentialState: "present",
      expectedRevision: null,
    });
    await store.syncCatalog({
      syncId: "evaluation-sync",
      connectionId: "evaluation-cloud",
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "evaluation-model", providerModelId: "discovered-model" }],
    });

    const profile = await store.saveCostPrivacyProfile({
      catalogEntryId: "evaluation-model",
      currency: "USD",
      inputMicrosPerMillionTokens: "1000000",
      outputMicrosPerMillionTokens: "3000000",
      pricingVersion: "pricing-2026-08",
      priceUpdatedAt: NOW,
      dataDestination: "remote",
      retentionPolicy: "provider_default",
      trainingPolicy: "opt_out",
      evidenceSource: "provider_policy",
      evidenceVersion: "policy-2026-08",
      evidenceSummary: "apiKey=sk-secretvalue123 was not retained",
      expectedRevision: null,
    });
    expect(profile).toMatchObject({
      currency: "USD",
      inputMicrosPerMillionTokens: "1000000",
      dataDestination: "remote",
      trainingPolicy: "opt_out",
      revision: 1,
    });
    expect(profile.evidenceSummary).toBe("apiKey=[REDACTED] was not retained");
    await expect(store.findCostPrivacyProfile("evaluation-model")).resolves.toEqual(profile);
    await expect(
      store.saveCostPrivacyProfile({
        catalogEntryId: "evaluation-model",
        dataDestination: "unknown",
        retentionPolicy: "unknown",
        trainingPolicy: "unknown",
        evidenceSource: "unknown",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_COST_PRIVACY_CONFLICT" });

    const evaluation = await store.recordEvaluationResult({
      id: "evaluation-prose-v1",
      catalogEntryId: "evaluation-model",
      task: "prose_generation",
      scoreBasisPoints: 8750,
      latencyP50Ms: 820,
      sampleCount: 48,
      evaluationSource: "local_evaluation",
      evaluationVersion: "novel-suite-v1",
      observedAt: NOW,
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    expect(evaluation).toMatchObject({
      task: "prose_generation",
      scoreBasisPoints: 8750,
      latencyP50Ms: 820,
      sampleCount: 48,
    });
    await expect(
      store.listEvaluationResults("evaluation-model", "prose_generation"),
    ).resolves.toEqual([evaluation]);
    await expect(
      store.recordEvaluationResult({
        id: "evaluation-duplicate-version",
        catalogEntryId: "evaluation-model",
        task: "prose_generation",
        scoreBasisPoints: 9000,
        latencyP50Ms: 700,
        sampleCount: 12,
        evaluationSource: "local_evaluation",
        evaluationVersion: "novel-suite-v1",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_EVALUATION_CONFLICT" });
    await expect(
      store.recordEvaluationResult({
        id: "evaluation-invalid-score",
        catalogEntryId: "evaluation-model",
        task: "rewrite",
        scoreBasisPoints: 10_001,
        latencyP50Ms: 700,
        sampleCount: 12,
        evaluationSource: "local_evaluation",
        evaluationVersion: "novel-suite-v2",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_EVALUATION_INVALID" });

    await expect(
      store.saveTaskRoute({
        task: "rewrite",
        primaryCatalogEntryId: "evaluation-model",
        privacyPolicy: "local_only",
        failurePolicy: "stop",
        routeOrigin: "user",
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_PRIVACY_BLOCKED" });
    await expect(
      store.saveTaskRoute({
        task: "rewrite",
        primaryCatalogEntryId: "evaluation-model",
        privacyPolicy: "cloud_allowed",
        failurePolicy: "use_fallback",
        routeOrigin: "user",
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_INVALID" });

    await executor.close();
  });
});

async function assertAutomaticRoutingPlanIsIdempotent(
  store: ModelHubStore,
  reopen: () => ModelHubStore,
  id: string,
): Promise<void> {
  const catalogIds = await seedAvailableCatalog(store, id);
  const manual = await store.saveTaskRoute({
    task: "rewrite",
    primaryCatalogEntryId: catalogIds[0],
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
  const input = {
    preset: automaticPreset("smart"),
    routes: [
      automaticRoute("rewrite", catalogIds[1]),
      automaticRoute("prose_generation", catalogIds[1]),
      automaticRoute("content_quality_check", catalogIds[1]),
    ],
  } as const;

  const first = await store.applyAutomaticRoutingPlan(input);
  expect(first).toMatchObject({
    changed: true,
    preservedUserRouteCount: 1,
  });
  expect(first.routes).toHaveLength(3);
  expect(first.routes.find(({ task }) => task === "rewrite")).toEqual(manual);
  expect(first.routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ task: "content_quality_check", routeOrigin: "automatic" }),
      expect.objectContaining({ task: "prose_generation", routeOrigin: "automatic" }),
    ]),
  );

  const second = await store.applyAutomaticRoutingPlan(input);
  expect(second.changed).toBe(false);
  expect(second.preset).toEqual(first.preset);
  expect(second.routes).toEqual(first.routes);

  const reopened = reopen();
  await expect(reopened.findTaskRoute("rewrite")).resolves.toEqual(manual);
  await expect(reopened.findTaskRoute("content_quality_check")).resolves.toEqual(
    first.routes.find(({ task }) => task === "content_quality_check"),
  );
  await expect(reopened.findActivePreset()).resolves.toEqual(first.preset);
}

async function seedAvailableCatalog(
  store: ModelHubStore,
  id: string,
): Promise<readonly [string, string]> {
  await store.saveConnection({
    id,
    providerKind: "custom_openai_compatible",
    displayName: id,
    baseUrlOverride: `https://${id}.example.test/v1`,
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  const catalogIds = [`${id}-model-a`, `${id}-model-b`] as const;
  await store.syncCatalog({
    syncId: `${id}-sync`,
    connectionId: id,
    source: "manual",
    status: "succeeded",
    models: catalogIds.map((catalogId) => ({
      id: catalogId,
      providerModelId: catalogId,
    })),
  });
  return catalogIds;
}

function automaticPreset(scheme: "smart" | "quality") {
  return {
    id: `automatic-${scheme}`,
    scheme,
    displayName: scheme === "smart" ? "智能推荐" : "高质量",
    status: "active" as const,
    privacyPolicy: "cloud_allowed" as const,
    costPriority: scheme === "quality" ? ("quality_first" as const) : ("balanced" as const),
    routeGenerationVersion: "model-hub-evidence-router-v1",
  };
}

function automaticRoute(
  task:
    | "idea_discussion"
    | "book_start_guidance"
    | "prose_generation"
    | "rewrite"
    | "content_quality_check",
  catalogEntryId: string,
) {
  return {
    task,
    primaryCatalogEntryId: catalogEntryId,
    fallbackCatalogEntryId: null,
    parameterPolicy: {},
    maximumCostMicros: null,
    currency: null,
    privacyPolicy: "cloud_allowed" as const,
    failurePolicy: "ask_user" as const,
    enabled: true,
  };
}

class FailingNodeSqliteExecutor extends NodeSqliteExecutor {
  private queryFragment: string | null = null;

  public failNextMatching(queryFragment: string): void {
    this.queryFragment = queryFragment;
  }

  public override async execute(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<ExecuteResult> {
    if (this.queryFragment !== null && query.includes(this.queryFragment)) {
      this.queryFragment = null;
      throw new Error("injected routing-plan write failure");
    }
    return super.execute(query, bindValues);
  }
}

class ToggleFailStorage implements Storage {
  private readonly values = new Map<string, string>();
  public failWrites = false;

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new DOMException("storage quota reached", "QuotaExceededError");
    }
    this.values.set(key, value);
  }
}

async function assertCapabilityProbeCommitIsAtomic(
  store: ModelHubStore,
  id: string,
): Promise<void> {
  await store.saveConnection({
    id,
    providerKind: "openai",
    displayName: "Guarded probe connection",
    credentialRef: `keyring:model-hub:${id}`,
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    expectedRevision: null,
  });
  await store.syncCatalog({
    syncId: `${id}-initial-sync`,
    connectionId: id,
    source: "manual",
    status: "succeeded",
    models: [{ id: `${id}-model`, providerModelId: "writer-model" }],
  });
  const initialConnection = await store.findConnection(id);
  const initialCatalog = await store.listCatalog(id);
  const initialEntry = initialCatalog[0];
  if (initialConnection === null || initialEntry === undefined) {
    throw new Error("Expected the guarded probe target.");
  }

  const stable = await store.commitCapabilityProbeResult({
    connectionId: id,
    expectedConnectionRevision: initialConnection.revision,
    catalogEntryId: initialEntry.id,
    expectedCatalogRevision: initialEntry.revision,
    expectedProviderModelId: initialEntry.providerModelId,
    scan: {
      scanId: `${id}-stable-scan`,
      catalogEntryId: initialEntry.id,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: `${id}-stable-v1`,
      evidence: [
        {
          id: `${id}-stable-evidence`,
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    },
    connectionTest: { status: "ready" },
  });
  expect(stable.connection).toMatchObject({
    connectionStatus: "ready",
    revision: initialConnection.revision + 1,
  });
  expect(stable.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: `${id}-stable-evidence`,
        capability: "text_generation",
        verdict: "supported",
      }),
    ]),
  );

  const staleConnection = stable.connection;
  const staleEntry = (await store.listCatalog(id))[0];
  if (staleEntry === undefined) throw new Error("Expected the stable catalog entry.");
  await store.syncCatalog({
    syncId: `${id}-concurrent-sync`,
    connectionId: id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: `${id}-unused-model-id`,
        providerModelId: staleEntry.providerModelId,
        displayName: "Concurrently updated model",
      },
    ],
  });
  const concurrentlyReady = await store.findConnection(id);
  if (concurrentlyReady === null) throw new Error("Expected the concurrently updated connection.");
  const readyRevision = await store.recordConnectionTest({
    connectionId: id,
    status: "ready",
    expectedRevision: concurrentlyReady.revision,
  });

  await expect(
    store.commitCapabilityProbeResult({
      connectionId: id,
      expectedConnectionRevision: staleConnection.revision,
      catalogEntryId: staleEntry.id,
      expectedCatalogRevision: staleEntry.revision,
      expectedProviderModelId: staleEntry.providerModelId,
      scan: {
        scanId: `${id}-stale-scan`,
        catalogEntryId: staleEntry.id,
        scanKind: "lightweight_probe",
        status: "failed",
        evidenceVersion: `${id}-stale-v1`,
        errorCode: "PROBE_FAILED",
      },
      connectionTest: {
        status: "error",
        errorCode: "PROBE_FAILED",
      },
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_PROBE_TARGET_CONFLICT" });
  await expect(store.findConnection(id)).resolves.toEqual(readyRevision);
  await expect(store.listCapabilityEvidence(staleEntry.id)).resolves.not.toEqual(
    expect.arrayContaining([expect.objectContaining({ evidenceVersion: `${id}-stale-v1` })]),
  );
}

async function assertProviderKindCannotBeOverwritten(
  store: TauriModelHubStore | BrowserDevelopmentModelHubStore,
  id: string,
): Promise<void> {
  const existing = await store.saveConnection({
    id,
    providerKind: "openai",
    displayName: "Existing OpenAI connection",
    credentialRef: `keyring:model-hub:${id}`,
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    expectedRevision: null,
  });
  await expect(
    store.saveConnection({
      id,
      providerKind: "custom_openai_compatible",
      displayName: "Unsafe replacement",
      baseUrlOverride: "https://replacement.example.test/v1",
      credentialRef: `keyring:model-hub:${id}`,
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: existing.revision,
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_PROVIDER_KIND_IMMUTABLE" });
  await expect(store.findConnection(id)).resolves.toMatchObject({ providerKind: "openai" });
}

async function assertConnectionRetirement(
  store: ModelHubStore,
  reopen: () => ModelHubStore,
  id: string,
): Promise<void> {
  await store.saveConnection({
    id,
    providerKind: "openai",
    displayName: "Retirable OpenAI connection",
    credentialRef: `keyring:model-hub:${id}`,
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    expectedRevision: null,
  });
  await store.syncCatalog({
    syncId: `${id}-sync`,
    connectionId: id,
    source: "manual",
    status: "succeeded",
    models: [{ id: `${id}-model`, providerModelId: "writer-model" }],
  });
  const invocation = await store.startInvocation({
    id: `${id}-invocation`,
    task: "prose_generation",
    connectionId: id,
    catalogEntryId: `${id}-model`,
    providerKindSnapshot: "openai",
    modelIdSnapshot: "writer-model",
    routeReason: "user_override",
    attempt: 1,
    privacyPolicy: "cloud_allowed",
    dataDestination: "remote",
  });
  await store.finishInvocation({
    id: invocation.id,
    status: "succeeded",
    inputTokens: 20,
    outputTokens: 10,
    expectedRevision: invocation.revision,
  });
  const current = await store.findConnection(id);
  if (current === null) {
    throw new Error("Expected the connection before retirement.");
  }

  const retired = await store.retireConnection({
    connectionId: id,
    expectedRevision: current.revision,
  });
  expect(isRetiredModelProviderConnection(retired)).toBe(true);
  expect(retired).toMatchObject({
    enabled: false,
    connectionStatus: "disabled",
    credentialRef: null,
    credentialState: "missing",
    lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
    revision: current.revision + 1,
  });

  const reopened = reopen();
  await expect(reopened.findConnection(id)).resolves.toEqual(retired);
  await expect(reopened.findInvocation(invocation.id)).resolves.toMatchObject({
    id: invocation.id,
    connectionId: id,
    status: "succeeded",
    providerKindSnapshot: "openai",
    modelIdSnapshot: "writer-model",
  });
  await expect(
    reopened.saveConnection({
      id,
      providerKind: "openai",
      displayName: "Unsafe retired reactivation",
      credentialRef: `keyring:model-hub:${id}-replacement`,
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: retired.revision,
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_RETIRED" });
  await expect(
    reopened.prepareConnectionCommit({
      id: `${id}-blocked-commit`,
      connectionId: id,
      credentialProviderId: `${id}-blocked-slot`,
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_RETIRED" });
  await expect(
    reopened.recordConnectionTest({
      connectionId: id,
      status: "ready",
      expectedRevision: retired.revision,
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_RETIRED" });
  await expect(
    reopened.syncCatalog({
      syncId: `${id}-blocked-sync`,
      connectionId: id,
      source: "manual",
      status: "succeeded",
      models: [{ id: `${id}-blocked-model`, providerModelId: "writer-model" }],
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_RETIRED" });
  await expect(reopened.findConnection(id)).resolves.toEqual(retired);
  await expect(reopened.listConnectionCommits()).resolves.toEqual([]);
  await expect(
    reopened.retireConnection({ connectionId: id, expectedRevision: current.revision }),
  ).resolves.toEqual(retired);
  await expect(
    reopened.startInvocation({
      id: `${id}-blocked-invocation`,
      task: "prose_generation",
      connectionId: id,
      catalogEntryId: `${id}-model`,
      providerKindSnapshot: "openai",
      modelIdSnapshot: "writer-model",
      routeReason: "user_override",
      attempt: 1,
      privacyPolicy: "cloud_allowed",
      dataDestination: "remote",
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_DISABLED" });
}

async function assertLocalToRemoteTransitionFailsClosed(
  store: TauriModelHubStore | BrowserDevelopmentModelHubStore,
  id: string,
): Promise<void> {
  const created = await store.saveConnection({
    id,
    providerKind: "ollama",
    displayName: "Local Ollama",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  await store.recordConnectionTest({
    connectionId: id,
    status: "ready",
    expectedRevision: created.revision,
  });
  await store.syncCatalog({
    syncId: `${id}-local-sync`,
    connectionId: id,
    source: "provider_api",
    status: "succeeded",
    models: [{ id: `${id}-local-model`, providerModelId: "local-model" }],
  });
  await store.saveCostPrivacyProfile({
    catalogEntryId: `${id}-local-model`,
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    pricingVersion: "local-zero-cost",
    priceUpdatedAt: NOW,
    dataDestination: "local",
    retentionPolicy: "none",
    trainingPolicy: "not_used",
    evidenceSource: "user_confirmed",
    evidenceVersion: "local-endpoint-v1",
    expectedRevision: null,
  });
  await store.saveTaskRoute({
    task: "embedding",
    primaryCatalogEntryId: `${id}-local-model`,
    privacyPolicy: "local_only",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
  await store.saveConnection({
    id: `${id}-primary-provider`,
    providerKind: "custom_openai_compatible",
    displayName: "Unaffected primary provider",
    baseUrlOverride: "https://primary.example.test/v1",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  await store.syncCatalog({
    syncId: `${id}-primary-sync`,
    connectionId: `${id}-primary-provider`,
    source: "manual",
    status: "succeeded",
    models: [{ id: `${id}-primary-model`, providerModelId: "primary-model" }],
  });
  await store.saveTaskRoute({
    task: "rewrite",
    primaryCatalogEntryId: `${id}-primary-model`,
    fallbackCatalogEntryId: `${id}-local-model`,
    parameterPolicy: { maximumOutputTokens: 321 },
    maximumCostMicros: "9000",
    currency: "USD",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "use_fallback",
    routeOrigin: "user",
    expectedRevision: null,
  });
  const current = await store.findConnection(id);
  if (current === null) {
    throw new Error("Expected the Ollama connection.");
  }
  const moved = await store.saveConnection({
    id,
    providerKind: "ollama",
    displayName: "Remote Ollama",
    baseUrlOverride: "https://remote-ollama.example.test",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: current.revision,
  });
  expect(moved).toMatchObject({
    baseUrl: "https://remote-ollama.example.test",
    connectionStatus: "not_tested",
    catalogSyncStatus: "never",
    lastTestedAt: null,
    lastCatalogSyncedAt: null,
  });
  await expect(store.listCatalog(id)).resolves.toEqual([]);
  await expect(store.findCostPrivacyProfile(`${id}-local-model`)).resolves.toBeNull();
  await expect(store.findTaskRoute("embedding")).resolves.toBeNull();
  await expect(store.findTaskRoute("rewrite")).resolves.toMatchObject({
    primaryCatalogEntryId: `${id}-primary-model`,
    fallbackCatalogEntryId: null,
    parameterPolicy: { maximumOutputTokens: 321 },
    maximumCostMicros: "9000",
    currency: "USD",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    revision: 2,
  });

  await store.syncCatalog({
    syncId: `${id}-remote-sync`,
    connectionId: id,
    source: "provider_api",
    status: "succeeded",
    models: [{ id: `${id}-remote-model`, providerModelId: "remote-model" }],
  });
  await store.saveCostPrivacyProfile({
    catalogEntryId: `${id}-remote-model`,
    dataDestination: "local",
    retentionPolicy: "none",
    trainingPolicy: "not_used",
    evidenceSource: "user_confirmed",
    evidenceVersion: "incorrect-local-claim",
    expectedRevision: null,
  });
  await expect(
    store.saveTaskRoute({
      task: "embedding",
      primaryCatalogEntryId: `${id}-remote-model`,
      privacyPolicy: "local_only",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_PRIVACY_BLOCKED" });
}

async function assertRecentAiFailurePersistence(
  store: TauriModelHubStore | BrowserDevelopmentModelHubStore,
  reopen: () => TauriModelHubStore | BrowserDevelopmentModelHubStore,
  id: string,
): Promise<void> {
  await store.saveConnection({
    id,
    providerKind: "custom_openai_compatible",
    displayName: "Failure diagnostics provider",
    baseUrlOverride: "https://failure-diagnostics.example.test/v1",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  await store.syncCatalog({
    syncId: `${id}-sync`,
    connectionId: id,
    source: "manual",
    status: "succeeded",
    models: [{ id: `${id}-model`, providerModelId: "writer-model" }],
  });

  await store.recordCapabilityScan({
    scanId: `${id}-scan`,
    catalogEntryId: `${id}-model`,
    scanKind: "lightweight_probe",
    status: "failed",
    evidenceVersion: "writing-probe-v1",
    errorCode: "MODEL_OUTPUT_TRUNCATED",
    errorSummary: "never-export-this-capability-summary",
    failure: {
      requestId: `req-${id}-probe-0001`,
      stage: "response_normalization",
      retryable: false,
      httpStatus: 200,
      finishReason: "length",
      visibleContentLength: 0,
      reasoningPresent: true,
      stream: false,
      attempt: 1,
      requestedMaxOutputTokens: 8,
    },
  });

  const invocation = await store.startInvocation({
    id: `${id}-invocation`,
    task: "prose_generation",
    connectionId: id,
    catalogEntryId: `${id}-model`,
    providerKindSnapshot: "custom_openai_compatible",
    modelIdSnapshot: "writer-model",
    routeReason: "user_override",
    attempt: 2,
    privacyPolicy: "cloud_allowed",
    dataDestination: "remote",
  });
  await store.finishInvocation({
    id: invocation.id,
    status: "failed",
    errorCode: "AI_UPSTREAM_UNAVAILABLE",
    errorSummary: "never-export-this-invocation-summary",
    failure: {
      requestId: `req-${id}-invoke-0001`,
      stage: "http_response",
      retryable: true,
      httpStatus: 503,
      visibleContentLength: 0,
      reasoningPresent: false,
      stream: true,
      attempt: 2,
      requestedMaxOutputTokens: 512,
    },
    expectedRevision: invocation.revision,
  });

  const failures = await reopen().listRecentAiFailures(25);
  expect(failures).toHaveLength(2);
  expect(failures).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        diagnosticId: `capability_scan:${id}-scan`,
        providerKind: "custom_openai_compatible",
        connectionId: id,
        modelId: "writer-model",
        taskType: "capability_probe",
        normalizedErrorCode: "MODEL_OUTPUT_TRUNCATED",
        stage: "response_normalization",
        requestId: `req-${id}-probe-0001`,
        httpStatus: 200,
        finishReason: "length",
        visibleContentLength: 0,
        reasoningPresent: true,
        stream: false,
        attempt: 1,
        requestedMaxOutputTokens: 8,
      }),
      expect.objectContaining({
        diagnosticId: `model_invocation:${id}-invocation`,
        taskType: "prose_generation",
        normalizedErrorCode: "AI_UPSTREAM_UNAVAILABLE",
        stage: "http_response",
        requestId: `req-${id}-invoke-0001`,
        retryable: true,
        httpStatus: 503,
        attempt: 2,
        requestedMaxOutputTokens: 512,
      }),
    ]),
  );
  expect(await reopen().listRecentAiFailures(1)).toHaveLength(1);
  expect(JSON.stringify(failures)).not.toContain("never-export-this");

  await expect(
    store.recordCapabilityScan({
      scanId: `${id}-invalid-success`,
      catalogEntryId: `${id}-model`,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "writing-probe-v1",
      failure: { requestId: `req-${id}-invalid-0001` },
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_SCAN_INVALID" });
  await expect(
    store.recordCapabilityScan({
      scanId: `${id}-invalid-success-error`,
      catalogEntryId: `${id}-model`,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "writing-probe-v1",
      errorCode: "MODEL_OUTPUT_TRUNCATED",
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_SCAN_INVALID" });
  await expect(
    store.recordCapabilityScan({
      scanId: `${id}-sensitive-failure`,
      catalogEntryId: `${id}-model`,
      scanKind: "lightweight_probe",
      status: "failed",
      evidenceVersion: "writing-probe-v1",
      errorCode: "MODEL_OUTPUT_TRUNCATED",
      failure: {
        requestId: `req-${id}-sensitive-0001`,
        prompt: "must-never-be-accepted",
      } as never,
    }),
  ).rejects.toMatchObject({ code: "MODEL_HUB_FAILURE_METADATA_INVALID" });
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
