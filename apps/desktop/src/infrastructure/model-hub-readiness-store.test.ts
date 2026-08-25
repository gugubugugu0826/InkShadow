import { describe, expect, it, vi } from "vitest";

import { createDevelopmentRuntime } from "./runtime";
import { projectModelHubReadiness, type ModelHubReadinessProjection } from "./model-hub-readiness";
import {
  createModelHubReadinessStore,
  getModelHubReadinessStore,
} from "./model-hub-readiness-store";

describe("shared authoritative Model Hub readiness store", () => {
  it("returns one store for every consumer of the same runtime", () => {
    const runtime = createDevelopmentRuntime(window.localStorage);

    expect(getModelHubReadinessStore(runtime)).toBe(getModelHubReadinessStore(runtime));
  });

  it("ignores an older refresh that settles after the newest request", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const older = deferred<ModelHubReadinessProjection>();
    const newest = deferred<ModelHubReadinessProjection>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newest.promise);
    const store = createModelHubReadinessStore(runtime, { load });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const firstRefresh = store.refresh({ showChecking: false });
    const secondRefresh = store.refresh({ showChecking: false });
    newest.resolve(projection("fully_ready"));
    await secondRefresh;
    older.resolve(projection("unconnected"));
    await firstRefresh;

    expect(store.getSnapshot().readiness.state).toBe("fully_ready");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("marks every in-flight refresh as rechecking without discarding the last known evidence", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const pending = deferred<ModelHubReadinessProjection>();
    const load = vi
      .fn<() => Promise<ModelHubReadinessProjection>>()
      .mockResolvedValueOnce(projection("fully_ready"))
      .mockReturnValueOnce(pending.promise);
    const store = createModelHubReadinessStore(runtime, { load });

    await store.refresh({ showChecking: false });
    const beforeRefresh = store.getSnapshot().readiness;
    const refresh = store.refresh({ showChecking: false });

    expect(store.getSnapshot()).toMatchObject({
      checking: true,
      readiness: {
        state: "checking",
        shortLabel: "AI 正在重新核对",
        tone: "info",
        needsRecheck: true,
        savedConnectionCount: beforeRefresh.savedConnectionCount,
        runnableCoreTaskCount: beforeRefresh.runnableCoreTaskCount,
      },
    });
    expect(store.getSnapshot().readiness.description).toContain("上次核对结果仍保留");

    pending.resolve(projection("unconnected"));
    await refresh;
  });

  it("keeps the last hydrated connection when a later read fails and exposes Chinese recovery evidence", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const hydrated = projectModelHubReadiness({
      connections: [savedConnection()],
      catalog: [],
      routes: [],
    });
    const load = vi
      .fn<() => Promise<ModelHubReadinessProjection>>()
      .mockResolvedValueOnce(hydrated)
      .mockRejectedValueOnce(
        Object.assign(new Error("catalog read failed"), { code: "CATALOG_READ_FAILED" }),
      );
    const store = createModelHubReadinessStore(runtime, { load });

    await store.refresh({ showChecking: false });
    await store.refresh({ showChecking: false });

    expect(store.getSnapshot().readiness).toMatchObject({
      savedConnectionCount: 1,
      needsRecheck: true,
    });
    expect(store.getSnapshot().readiness.state).not.toBe("connection_failed");
    const failure = store.getSnapshot().failure;
    expect(failure).not.toBeNull();
    if (failure === null) throw new Error("expected a recoverable read failure");
    expect(failure.title.length).toBeGreaterThan(0);
    expect(failure.description).toMatch(/[\u4e00-\u9fff]/u);
    expect(failure.supportId).toMatch(/^墨影-/u);
    expect(failure.recovery).toMatch(/重新/u);
  });
});

function projection(state: "fully_ready" | "unconnected"): ModelHubReadinessProjection {
  const base = projectModelHubReadiness(
    state === "unconnected"
      ? { connections: [], catalog: [], routes: [] }
      : { connections: [savedConnection()], catalog: [], routes: [] },
  );
  return state === "unconnected"
    ? base
    : Object.freeze({
        ...base,
        state: "fully_ready" as const,
      });
}

function savedConnection() {
  const now = "2026-08-25T00:00:00.000Z";
  return {
    id: "saved",
    providerKind: "openai" as const,
    displayName: "已保存连接",
    protocol: "openai_compatible" as const,
    region: null,
    workspaceId: null,
    endpointId: null,
    baseUrl: "https://api.openai.com/v1",
    credentialRef: "keyring:saved",
    credentialState: "present" as const,
    authenticationMode: "bearer_keyring" as const,
    credentialHeaderName: null,
    modelDiscoveryPath: "/models",
    textGenerationPath: "/chat/completions",
    embeddingPath: "/embeddings",
    requestTimeoutMs: 30_000,
    retryLimit: 0,
    connectionStatus: "ready" as const,
    catalogSyncStatus: "failed" as const,
    lastTestedAt: now,
    lastCatalogSyncedAt: null,
    lastErrorCode: null,
    lastErrorSummary: null,
    legacyProviderId: null,
    enabled: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
