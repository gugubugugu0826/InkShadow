import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IsoUtcTimestamp } from "@inkshadow/domain";

import {
  executeAuditedModelHubEmbeddingCapabilityProbe,
  MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_INPUTS,
  runModelHubEmbeddingCapabilityProbe,
} from "./model-hub-embedding-capability-probe";
import { BrowserDevelopmentModelHubStore } from "./model-hub-store";
import type { NativeEmbeddingInput, NativeEmbeddingResult } from "./native-embedding-gateway";
import type { NativeModelEndpointConfig } from "./runtime";

const NOW = "2026-08-28T01:02:03.000Z" as IsoUtcTimestamp;
const clock = Object.freeze({ now: () => NOW });

beforeEach(() => {
  window.localStorage.clear();
});

describe("Model Hub embedding capability probe", () => {
  it("uses one fixed non-project embedding request with zero retries and returns only a summary", async () => {
    const embed = vi.fn(() => Promise.resolve(validResult()));

    const result = await runModelHubEmbeddingCapabilityProbe({
      gateway: { embed },
      config: endpoint({ retryLimit: 3 }),
      model: "text-embedding-v4",
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith({
      config: endpoint(),
      model: "text-embedding-v4",
      inputs: MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_INPUTS,
      dispatchScope: { kind: "non_project", reason: "connection_probe" },
    });
    expect(result).toEqual({ dimension: 3, vectorCount: 1 });
    expect(JSON.stringify(result)).not.toContain(MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_INPUTS[0]);
    expect(result).not.toHaveProperty("embeddings");
  });

  it.each([
    ["空响应", { vectorCount: 0, embeddings: [] }, "MODEL_EMBEDDING_COUNT_INVALID"],
    ["条目数不符", { vectorCount: 2 }, "MODEL_EMBEDDING_COUNT_INVALID"],
    ["维度为零", { dimension: 0, embeddings: [[]] }, "MODEL_EMBEDDING_DIMENSION_INVALID"],
    ["向量长度不符", { dimension: 2 }, "MODEL_EMBEDDING_DIMENSION_INVALID"],
    ["含非有限数值", { embeddings: [[0.2, Number.NaN, 0.4]] }, "MODEL_EMBEDDING_VALUE_INVALID"],
    ["全零向量", { embeddings: [[0, 0, 0]] }, "MODEL_EMBEDDING_VALUE_INVALID"],
  ] as const)("rejects %s", async (_label, overrides, code) => {
    const embed = vi.fn(() => Promise.resolve({ ...validResult(), ...overrides }));

    await expect(
      runModelHubEmbeddingCapabilityProbe({
        gateway: { embed },
        config: endpoint(),
        model: "text-embedding-v4",
      }),
    ).rejects.toMatchObject({ code });
    expect(embed).toHaveBeenCalledOnce();
  });

  it("preserves a definite provider 404 without retrying", async () => {
    const providerFailure = Object.assign(new Error("not found"), {
      code: "MODEL_HTTP_NOT_FOUND",
      diagnostics: { httpStatus: 404 },
    });
    const embed = vi.fn(() => Promise.reject(providerFailure));

    await expect(
      runModelHubEmbeddingCapabilityProbe({
        gateway: { embed },
        config: endpoint(),
        model: "text-embedding-v4",
      }),
    ).rejects.toBe(providerFailure);
    expect(embed).toHaveBeenCalledOnce();
  });

  it("lets the native gateway persist the only dispatch receipt after native preflight", async () => {
    const store = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    const connection = await store.saveConnection({
      id: "native-qwen-embedding-probe",
      providerKind: "alibaba_qwen",
      displayName: "原生向量检查",
      region: "china_beijing",
      credentialRef: "keyring:model-hub:native-qwen-embedding-probe",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const [catalogEntry] = await store.syncCatalog({
      syncId: "native-qwen-embedding-probe-catalog",
      connectionId: connection.id,
      source: "manual",
      status: "succeeded",
      models: [{ id: "native-qwen-embedding-v4", providerModelId: "text-embedding-v4" }],
    });
    if (catalogEntry === undefined) throw new Error("missing embedding catalog entry");
    const currentConnection = await store.findConnection(connection.id);
    if (currentConnection === null) throw new Error("missing embedding connection");
    const rendererDispatch = vi.spyOn(store, "markInvocationDispatched");
    const embed = vi.fn(async (request: NativeEmbeddingInput) => {
      expect(request.invocationDispatchLedger).toMatchObject({
        taskSnapshot: "capability_probe",
        connectionId: connection.id,
        catalogEntryId: catalogEntry.id,
        modelIdSnapshot: "text-embedding-v4",
      });
      const ledger = request.invocationDispatchLedger;
      if (ledger === undefined) throw new Error("missing native dispatch ledger");
      const dispatched = await store.markInvocationDispatched({
        id: ledger.invocationId,
        dispatchedAt: NOW,
        expectedRevision: ledger.expectedRevision,
      });
      await request.onInvocationDispatchAccepted?.({
        invocationId: dispatched.id,
        dispatchedAt: dispatched.providerDispatchStartedAt ?? NOW,
        revision: dispatched.revision,
      });
      return validResult();
    });
    const gateway = {
      supportsNativeInvocationDispatchLedger: true as const,
      embed,
    };

    const result = await executeAuditedModelHubEmbeddingCapabilityProbe({
      gateway,
      modelHub: store,
      clock,
      providerKind: "alibaba_qwen",
      invocationId: "capability-probe-invocation-019f9f4a-b3c7-7350-9226-000000000601",
      connection: currentConnection,
      catalogEntry,
      config: endpoint({ providerId: connection.id }),
      model: "text-embedding-v4",
    });

    expect(rendererDispatch).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledOnce();
    expect(result.invocation).toMatchObject({
      status: "succeeded",
      providerDispatchStartedAt: NOW,
      revision: 3,
    });
  });

  it("records one content-free capability invocation and never serializes the fixed text or vectors", async () => {
    const store = new BrowserDevelopmentModelHubStore(window.localStorage, clock);
    const connection = await store.saveConnection({
      id: "qwen-embedding-probe",
      providerKind: "alibaba_qwen",
      displayName: "阿里云百炼 / Qwen",
      region: "china_beijing",
      credentialRef: "keyring:model-hub:qwen-embedding-probe",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const [catalogEntry] = await store.syncCatalog({
      syncId: "qwen-embedding-probe-manual",
      connectionId: connection.id,
      source: "manual",
      status: "succeeded",
      models: [{ id: "qwen-embedding-v4", providerModelId: "text-embedding-v4" }],
    });
    if (catalogEntry === undefined) throw new Error("missing embedding catalog entry");
    const currentConnection = await store.findConnection(connection.id);
    if (currentConnection === null) throw new Error("missing embedding connection");
    const embed = vi.fn(() => Promise.resolve(validResult()));

    const result = await executeAuditedModelHubEmbeddingCapabilityProbe({
      gateway: { embed },
      modelHub: store,
      clock,
      providerKind: "alibaba_qwen",
      invocationId: "qwen-embedding-capability-invocation",
      connection: currentConnection,
      catalogEntry,
      config: endpoint({ providerId: connection.id, retryLimit: 2 }),
      model: "text-embedding-v4",
    });

    expect(embed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ dimension: 3, vectorCount: 1 });
    expect(result.invocation).toMatchObject({
      task: "capability_probe",
      status: "succeeded",
      attempt: 1,
      inputTokens: null,
      outputTokens: null,
    });
    const serialized = JSON.stringify(await store.findInvocation(result.invocation.id));
    expect(serialized).not.toContain(MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_INPUTS[0]);
    expect(serialized).not.toContain("0.125");
    expect(serialized).not.toMatch(/embeddings/iu);
  });
});

function validResult(): NativeEmbeddingResult {
  return Object.freeze({
    provider: "open_ai_compatible",
    endpointOrigin: "https://dashscope.aliyuncs.com",
    model: "text-embedding-v4",
    dimension: 3,
    vectorCount: 1,
    embeddings: Object.freeze([Object.freeze([0.125, -0.25, 0.5])]),
  });
}

function endpoint(overrides: Partial<NativeModelEndpointConfig> = {}): NativeModelEndpointConfig {
  return Object.freeze({
    providerId: "qwen-embedding-probe",
    provider: "open_ai_compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authentication: "bearer_keyring",
    retryLimit: 0,
    ...overrides,
  });
}
