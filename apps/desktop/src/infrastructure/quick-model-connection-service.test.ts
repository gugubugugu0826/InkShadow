import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureQuickBookStartRoute,
  connectQuickModelProvider,
  inspectQuickBookStartRouteProbe,
  QUICK_MODEL_PROVIDERS,
  QuickModelConnectionError,
  selectQuickBookStartCatalogEntry,
} from "./quick-model-connection-service";
import { ModelCenterError } from "./model-center-store";
import { modelHubCredentialProviderId } from "./model-hub-native-config";
import {
  createDevelopmentRuntime,
  type CredentialStore,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";

describe("quick Model Hub connection", () => {
  beforeEach(() => window.localStorage.clear());

  it("offers the five common entry providers plus GLM and independent compatible connections", () => {
    expect(QUICK_MODEL_PROVIDERS).toEqual([
      "deepseek",
      "openai",
      "alibaba_qwen",
      "volcengine_doubao",
      "ollama",
      "zhipu_glm",
      "custom_openai_compatible",
    ]);
    expect(new Set(QUICK_MODEL_PROVIDERS).size).toBe(QUICK_MODEL_PROVIDERS.length);
  });

  it("tests a new key in staging and never overwrites the working key when authentication fails", async () => {
    const harness = createHarness({ secrets: { openai: "working-key" }, failAuthentication: true });

    await expect(
      connectQuickModelProvider(harness.runtime, {
        provider: "openai",
        secret: "test-wrong-new-key",
      }),
    ).rejects.toBeInstanceOf(QuickModelConnectionError);

    expect(harness.secrets.get("openai")).toBe("working-key");
    expect([...harness.secrets.keys()].filter((key) => key.startsWith("quick-key-"))).toEqual([]);
    const stagingId = harness.saveCredential.mock.calls[0]?.[0];
    expect(stagingId).toMatch(/^quick-key-/u);
    expect(harness.deleteCredential).toHaveBeenCalledWith(stagingId);
    expect(harness.saveCredential).not.toHaveBeenCalledWith("openai", "test-wrong-new-key");
    expect(await harness.runtime.modelHub.findConnection("openai")).toBeNull();
  });

  it("commits only a verified key, stores no secret in Model Hub, and routes book start after a text probe", async () => {
    const harness = createHarness();
    const publishConnectionCommit = vi.spyOn(harness.runtime.modelHub, "publishConnectionCommit");
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-verified-secret-value",
    });

    const credentialProviderId = modelHubCredentialProviderId(connected.connection);
    expect(credentialProviderId).toMatch(/^quick-key-/u);
    expect(harness.secrets.get(credentialProviderId)).toBe("test-verified-secret-value");
    expect(harness.secrets.has("openai")).toBe(false);
    expect(harness.saveCredential).toHaveBeenCalledTimes(1);
    expect(harness.saveCredential.mock.invocationCallOrder[0]).toBeLessThan(
      publishConnectionCommit.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(connected.catalog.map(({ providerModelId }) => providerModelId)).toEqual([
      "novel-text-model",
    ]);
    const serializedMetadata = JSON.stringify({
      connections: await harness.runtime.modelHub.listConnections(),
      catalog: await harness.runtime.modelHub.listCatalog(connected.connection.id),
    });
    expect(serializedMetadata).not.toContain("test-verified-secret-value");
    expect(JSON.stringify(window.localStorage)).not.toContain("test-verified-secret-value");
    await expect(harness.runtime.modelHub.findTaskRoute("book_start_guidance")).resolves.toBeNull();

    const ready = await configureConfirmedQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    expect(ready.route.task).toBe("book_start_guidance");
    expect(ready.route.primaryCatalogEntryId).toBe(ready.catalogEntry.id);
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0].messages).toEqual([
      { role: "user", content: "只回复：OK" },
    ]);
    expect(harness.generate.mock.calls[0]?.[0].maxOutputTokens).toBe(64);
    expect(harness.generate.mock.calls[0]?.[0]).not.toHaveProperty("reasoningMode");
    expect(harness.generate.mock.calls[0]?.[0].config.providerId).toBe(credentialProviderId);
    expect(startInvocation).toHaveBeenCalledOnce();
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "capability_probe",
        routeTask: null,
        connectionId: connected.connection.id,
        catalogEntryId: ready.catalogEntry.id,
        routeReason: "user_override",
        attempt: 1,
        maximumCostMicros: null,
        currency: null,
      }),
    );
    const invocationId = startInvocation.mock.calls[0]?.[0].id;
    expect(invocationId).toBeDefined();
    const invocation = await harness.runtime.modelHub.findInvocation(invocationId ?? "missing");
    expect(invocation).toMatchObject({
      task: "capability_probe",
      status: "succeeded",
      inputTokens: null,
      outputTokens: null,
      estimatedCostMicros: null,
    });
    expect(typeof invocation?.providerDispatchStartedAt).toBe("string");
    await expect(
      harness.runtime.modelHub.listCapabilityEvidence(ready.catalogEntry.id),
    ).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "streaming",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        }),
      ]),
    );
  });

  it("uses the provider-owned DeepSeek reasoning policy for the quick text probe", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "deepseek",
      secret: "test-deepseek-secret",
    });

    await configureConfirmedQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });

    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 64,
      reasoningMode: "disabled",
      messages: [{ role: "user", content: "只回复：OK" }],
    });
  });

  it("does not dispatch the fixed probe before an explicit disclosure confirmation", async () => {
    const harness = createHarness();
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-disclosure-secret",
    });
    harness.generate.mockClear();
    const catalogEntry = connected.catalog[0];
    expect(catalogEntry).toBeDefined();
    if (catalogEntry === undefined) {
      throw new Error("测试目录缺少首个模型");
    }

    await expect(
      configureQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: catalogEntry.id,
        targetSnapshot: {
          connection: connected.connection,
          catalogEntry,
        },
        invocationId: harness.runtime.ids.next(),
        humanConfirmed: true,
        disclosureFingerprint: "",
      }),
    ).rejects.toMatchObject({ code: "QUICK_MODEL_PROBE_CONFIRMATION_REQUIRED" });
    expect(harness.generate).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
  });

  it("records one capability invocation with exact usage while keeping unknown cost unknown", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-usage-secret",
    });
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");
    harness.generate.mockResolvedValueOnce({
      text: "OK",
      streamed: true,
      usage: { inputTokens: 11, outputTokens: 2, cachedInputTokens: 3 },
    });

    await configureConfirmedQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });

    expect(harness.generate).toHaveBeenCalledOnce();
    expect(startInvocation).toHaveBeenCalledOnce();
    const invocationId = startInvocation.mock.calls[0]?.[0].id ?? "missing";
    await expect(harness.runtime.modelHub.findInvocation(invocationId)).resolves.toMatchObject({
      task: "capability_probe",
      status: "succeeded",
      inputTokens: 11,
      outputTokens: 2,
      cachedInputTokens: 3,
      estimatedCostMicros: null,
      currency: null,
    });
    const stored = JSON.parse(
      window.localStorage.getItem("inkshadow.development.model-hub.v1") ?? "{}",
    ) as { state?: { capabilityScans?: Record<string, { modelInvocationId?: string | null }> } };
    expect(Object.values(stored.state?.capabilityScans ?? {})).toEqual(
      expect.arrayContaining([expect.objectContaining({ modelInvocationId: invocationId })]),
    );
  });

  it("uses the native accepted boundary before settling a capability invocation", async () => {
    const harness = createHarness({ nativeInvocationLedger: true });
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-native-ledger-secret",
    });
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");

    await configureConfirmedQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });

    expect(harness.generate).toHaveBeenCalledOnce();
    const dispatched = harness.generate.mock.calls[0]?.[0];
    expect(dispatched?.invocationDispatchLedger).toMatchObject({ expectedRevision: 1 });
    expect(dispatched?.onInvocationDispatchAccepted).toBeTypeOf("function");
    const invocationId = startInvocation.mock.calls[0]?.[0].id ?? "missing";
    await expect(harness.runtime.modelHub.findInvocation(invocationId)).resolves.toMatchObject({
      task: "capability_probe",
      status: "succeeded",
      providerDispatchStartedAt: "2026-08-21T00:00:00.000Z",
      revision: 3,
    });
  });

  it("keeps native preparation rejection at zero provider dispatch receipts", async () => {
    const harness = createHarness({
      nativeInvocationLedger: true,
      rejectBeforeNativeInvocationReceipt: true,
    });
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-native-predispatch-secret",
    });
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");

    await expect(
      configureConfirmedQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: connected.catalog[0]?.id ?? "missing",
      }),
    ).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_MISSING" });

    const invocationId = startInvocation.mock.calls[0]?.[0].id ?? "missing";
    await expect(harness.runtime.modelHub.findInvocation(invocationId)).resolves.toMatchObject({
      task: "capability_probe",
      status: "failed",
      providerDispatchStartedAt: null,
      errorCode: "CAPABILITY_PROBE_NOT_DISPATCHED",
    });
  });

  it("settles an uncertain post-dispatch probe once and never resends it automatically", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-ambiguous-secret",
    });
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");
    const recordCapabilityScan = vi.spyOn(harness.runtime.modelHub, "recordCapabilityScan");
    harness.generate.mockRejectedValueOnce(
      Object.assign(new Error("connection ended before a response"), {
        code: "MODEL_NETWORK_TIMEOUT",
        retryable: true,
        diagnostics: { requestId: "probe-request-ambiguous" },
      }),
    );

    await expect(
      configureConfirmedQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: connected.catalog[0]?.id ?? "missing",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RESULT_AMBIGUOUS", retryable: false });

    expect(harness.generate).toHaveBeenCalledOnce();
    expect(startInvocation).toHaveBeenCalledOnce();
    const invocationId = startInvocation.mock.calls[0]?.[0].id ?? "missing";
    const invocation = await harness.runtime.modelHub.findInvocation(invocationId);
    expect(invocation).toMatchObject({
      task: "capability_probe",
      status: "timed_out",
      errorCode: "PROVIDER_RESULT_AMBIGUOUS",
    });
    expect(typeof invocation?.providerDispatchStartedAt).toBe("string");
    expect(
      recordCapabilityScan.mock.calls.filter(([scan]) => scan.status === "failed"),
    ).toHaveLength(0);
    const recentFailures = await harness.runtime.modelHub.listRecentAiFailures();
    expect(recentFailures).toHaveLength(1);
    expect(recentFailures[0]).toMatchObject({
      taskType: "capability_probe",
      normalizedErrorCode: "PROVIDER_RESULT_AMBIGUOUS",
    });
    expect(recentFailures[0]?.diagnosticId.startsWith("model_invocation:")).toBe(true);
  });
  it("keeps a returned probe pending review when the completion ledger write fails", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-settlement-failure-secret",
    });
    const disclosure = await inspectQuickBookStartRouteProbe(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    vi.spyOn(harness.runtime.modelHub, "finishInvocation").mockRejectedValue(
      new Error("simulated invocation settlement failure"),
    );

    await expect(
      configureQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: connected.catalog[0]?.id ?? "missing",
        targetSnapshot: disclosure.targetSnapshot,
        invocationId: disclosure.invocationId,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESULT_AMBIGUOUS",
      retryable: false,
      failureStage: "probe_result",
      providerDispatchCount: 1,
    });

    expect(harness.generate).toHaveBeenCalledOnce();
    const pendingInvocation = await harness.runtime.modelHub.findInvocation(
      disclosure.invocationId,
    );
    expect(pendingInvocation?.status).toBe("running");
    expect(typeof pendingInvocation?.providerDispatchStartedAt).toBe("string");
  });

  it("creates and settles the confirmed invocation before a capability metadata write fails", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-metadata-failure-secret",
    });
    const disclosure = await inspectQuickBookStartRouteProbe(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    vi.spyOn(harness.runtime.modelHub, "recordCapabilityScan").mockRejectedValueOnce(
      new Error("simulated metadata scan failure"),
    );

    await expect(
      configureQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: connected.catalog[0]?.id ?? "missing",
        targetSnapshot: disclosure.targetSnapshot,
        invocationId: disclosure.invocationId,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
      }),
    ).rejects.toMatchObject({
      failureStage: "probe_preparation",
      providerDispatchCount: 0,
    });

    expect(harness.generate).not.toHaveBeenCalled();
    await expect(
      harness.runtime.modelHub.findInvocation(disclosure.invocationId),
    ).resolves.toMatchObject({
      id: disclosure.invocationId,
      status: "failed",
      providerDispatchStartedAt: null,
      errorCode: "CAPABILITY_PROBE_NOT_DISPATCHED",
    });
  });
  it("creates the confirmed invocation before the authoritative target reread fails", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-target-reread-failure-secret",
    });
    const disclosure = await inspectQuickBookStartRouteProbe(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    vi.spyOn(harness.runtime.modelHub, "findConnection").mockRejectedValueOnce(
      new Error("simulated authoritative target reread failure"),
    );

    await expect(
      configureQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: connected.catalog[0]?.id ?? "missing",
        targetSnapshot: disclosure.targetSnapshot,
        invocationId: disclosure.invocationId,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
      }),
    ).rejects.toMatchObject({
      failureStage: "probe_preparation",
      providerDispatchCount: 0,
    });

    expect(harness.generate).not.toHaveBeenCalled();
    await expect(
      harness.runtime.modelHub.findInvocation(disclosure.invocationId),
    ).resolves.toMatchObject({
      id: disclosure.invocationId,
      status: "failed",
      providerDispatchStartedAt: null,
      errorCode: "CAPABILITY_PROBE_NOT_DISPATCHED",
    });
  });

  it("stops when multiple same-provider connections have no explicit stable choice", async () => {
    const harness = createHarness();
    for (const id of ["deepseek-work", "deepseek-personal"]) {
      await harness.runtime.modelHub.saveConnection({
        id,
        providerKind: "deepseek",
        displayName: id,
        credentialRef: `keyring:model-hub:${id}`,
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        enabled: true,
        expectedRevision: null,
      });
    }

    await expect(
      connectQuickModelProvider(harness.runtime, {
        provider: "deepseek",
        secret: "test-ambiguous-connection-secret",
      }),
    ).rejects.toMatchObject({
      code: "QUICK_MODEL_CONNECTION_SELECTION_REQUIRED",
      retryable: false,
    });
    expect(harness.saveCredential).not.toHaveBeenCalled();
    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });

  it("leaves pure-text opening unselected when only an experimental vision model is available", async () => {
    const harness = createHarness({
      models: [
        {
          id: "deepseek-v4-flash-vision-exp",
          displayName: "deepseek-v4-flash-vision-exp",
        },
      ],
    });
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "deepseek",
      secret: "test-vision-only-secret",
    });

    await expect(selectQuickBookStartCatalogEntry(harness.runtime, connected)).resolves.toBeNull();
  });

  it("reports the authoritative route for review when post-save validation and rollback both fail", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-route-review-secret",
    });
    const disclosure = await inspectQuickBookStartRouteProbe(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    const findTaskRoute = harness.runtime.modelHub.findTaskRoute.bind(harness.runtime.modelHub);
    let routeReadCount = 0;
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockImplementation(async (task) => {
      routeReadCount += 1;
      if (routeReadCount === 2) {
        throw new Error("simulated post-save route validation failure");
      }
      return findTaskRoute(task);
    });
    vi.spyOn(harness.runtime.modelHub, "deleteTaskRoute").mockRejectedValueOnce(
      new Error("simulated route rollback failure"),
    );

    await expect(
      configureQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: connected.catalog[0]?.id ?? "missing",
        targetSnapshot: disclosure.targetSnapshot,
        invocationId: disclosure.invocationId,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
      }),
    ).rejects.toMatchObject({
      code: "QUICK_MODEL_ROUTE_STATE_REQUIRES_REVIEW",
      retryable: false,
    });

    expect(harness.generate).toHaveBeenCalledOnce();
    await expect(
      harness.runtime.modelHub.findTaskRoute("book_start_guidance"),
    ).resolves.toMatchObject({
      primaryCatalogEntryId: connected.catalog[0]?.id,
      enabled: true,
    });
  });

  it("records a truthful partial scan when a truncated probe already emitted visible text", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "deepseek",
      secret: "test-deepseek-secret",
    });
    harness.generate.mockImplementationOnce((request) => {
      request.onDelta?.("OK");
      return Promise.reject(
        new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "truncated", false, {
          requestId: "deepseek-request-1",
          httpStatus: 200,
          finishReason: "length",
          visibleContentLength: 2,
          reasoningPresent: true,
          stream: true,
          inputTokens: 4,
          outputTokens: 64,
        }),
      );
    });

    const ready = await configureConfirmedQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });

    await expect(
      harness.runtime.modelHub.listCapabilityEvidence(ready.catalogEntry.id),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        }),
      ]),
    );
    await expect(harness.runtime.modelHub.listRecentAiFailures()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedErrorCode: "MODEL_OUTPUT_TRUNCATED",
          finishReason: "length",
          visibleContentLength: 2,
          requestedMaxOutputTokens: 64,
        }),
      ]),
    );
  });

  it("does not run the fixed probe when the connection is disabled during capability setup", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-verified-secret-value",
    });
    const recordCapabilityScan = harness.runtime.modelHub.recordCapabilityScan.bind(
      harness.runtime.modelHub,
    );
    vi.spyOn(harness.runtime.modelHub, "recordCapabilityScan").mockImplementationOnce(
      async (input) => {
        const saved = await recordCapabilityScan(input);
        const connection = await harness.runtime.modelHub.findConnection(connected.connection.id);
        if (connection === null) throw new Error("test connection missing");
        await harness.runtime.modelHub.saveConnection({
          id: connection.id,
          providerKind: connection.providerKind,
          displayName: connection.displayName,
          credentialRef: connection.credentialRef,
          credentialState: connection.credentialState,
          authenticationMode: connection.authenticationMode,
          enabled: false,
          expectedRevision: connection.revision,
        });
        return saved;
      },
    );
    harness.generate.mockClear();

    await expect(
      configureConfirmedQuickBookStartRoute(harness.runtime, {
        connectionId: connected.connection.id,
        catalogEntryId: connected.catalog[0]?.id ?? "missing",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CONFIGURATION_CHANGED_BEFORE_DISPATCH" });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("does not commit a new formal key when non-secret catalog persistence fails", async () => {
    const harness = createHarness({ secrets: { openai: "test-working-key" } });
    let previous = await harness.runtime.modelHub.saveConnection({
      id: "openai",
      providerKind: "openai",
      displayName: "Existing OpenAI",
      credentialRef: "keyring:model-hub:openai",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    previous = await harness.runtime.modelHub.recordConnectionTest({
      connectionId: previous.id,
      status: "ready",
      expectedRevision: previous.revision,
    });
    const previousCatalog = await harness.runtime.modelHub.syncCatalog({
      syncId: "previous-catalog-sync",
      connectionId: previous.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "previous-catalog-entry", providerModelId: "previous-model" }],
    });
    const previousRoute = await harness.runtime.modelHub.saveTaskRoute({
      task: "book_start_guidance",
      primaryCatalogEntryId: "previous-catalog-entry",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "ask_user",
      routeOrigin: "user",
      expectedRevision: null,
    });
    const previousCurrent = await harness.runtime.modelHub.findConnection(previous.id);
    vi.spyOn(harness.runtime.modelHub, "publishConnectionCommit").mockRejectedValueOnce(
      new Error("simulated metadata persistence failure"),
    );

    await expect(
      connectQuickModelProvider(harness.runtime, {
        provider: "openai",
        secret: "test-new-key",
        baseUrlOverride: "https://changed-endpoint.example.test/v1",
      }),
    ).rejects.toBeInstanceOf(QuickModelConnectionError);

    expect(harness.secrets.get("openai")).toBe("test-working-key");
    expect(harness.saveCredential).not.toHaveBeenCalledWith("openai", "test-new-key");
    expect([...harness.secrets.keys()].some((key) => key.startsWith("quick-key-"))).toBe(false);
    expect(await harness.runtime.modelHub.findConnection("openai")).toEqual(previousCurrent);
    expect(await harness.runtime.modelHub.listCatalog("openai")).toEqual(previousCatalog);
    expect(await harness.runtime.modelHub.findTaskRoute("book_start_guidance")).toEqual(
      previousRoute,
    );
  });

  it("reuses expert connection metadata instead of replacing endpoints with quick defaults", async () => {
    const harness = createHarness({ secrets: { "expert-openai": "old-key" } });
    const seeded = await harness.runtime.modelHub.saveConnection({
      id: "expert-openai",
      providerKind: "openai",
      displayName: "我的 OpenAI 代理",
      region: "expert-region",
      workspaceId: "expert-workspace",
      endpointId: "expert-endpoint",
      baseUrlOverride: "https://models.example.test/v1",
      credentialRef: "keyring:model-hub:expert-openai",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      requestTimeoutMs: 47_000,
      retryLimit: 2,
      enabled: true,
      expectedRevision: null,
    });

    await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-verified-new-key",
    });
    const saved = await harness.runtime.modelHub.findConnection(seeded.id);

    expect(saved).toMatchObject({
      id: "expert-openai",
      displayName: "我的 OpenAI 代理",
      region: "expert-region",
      workspaceId: "expert-workspace",
      endpointId: "expert-endpoint",
      baseUrl: "https://models.example.test/v1",
      requestTimeoutMs: 47_000,
      retryLimit: 2,
    });
    expect(harness.checkConnection.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "https://models.example.test/v1",
      requestTimeoutMs: 47_000,
      retryLimit: 2,
    });

    const ollama = createHarness();
    await ollama.runtime.modelHub.saveConnection({
      id: "local-ollama",
      providerKind: "ollama",
      displayName: "书房 Ollama",
      baseUrlOverride: "http://127.0.0.1:22441",
      credentialState: "missing",
      authenticationMode: "none",
      requestTimeoutMs: 52_000,
      retryLimit: 0,
      enabled: true,
      expectedRevision: null,
    });
    await connectQuickModelProvider(ollama.runtime, { provider: "ollama" });
    expect(await ollama.runtime.modelHub.findConnection("local-ollama")).toMatchObject({
      baseUrl: "http://127.0.0.1:22441",
      displayName: "书房 Ollama",
      requestTimeoutMs: 52_000,
    });
    expect(ollama.checkConnection).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:22441" }),
    );
  });

  it("repairs an unowned historical credential reference without guessing its vault slot", async () => {
    const harness = createHarness();
    await harness.runtime.modelHub.saveConnection({
      id: "openai",
      providerKind: "openai",
      displayName: "Historical OpenAI",
      credentialRef: "keyring:external-vault:unknown-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });

    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-replacement-credential",
    });

    expect(connected.connection.credentialRef).toMatch(/^keyring:model-hub:quick-key-/u);
    expect(harness.deleteCredential).not.toHaveBeenCalledWith("unknown-slot");
    expect(harness.deleteCredential).not.toHaveBeenCalledWith("openai");
  });

  it("reenables a verified disabled local connection and makes book start routable", async () => {
    const harness = createHarness();
    await harness.runtime.modelHub.saveConnection({
      id: "disabled-ollama",
      providerKind: "ollama",
      displayName: "暂停过的 Ollama",
      baseUrlOverride: "http://127.0.0.1:22661",
      credentialState: "missing",
      authenticationMode: "none",
      enabled: false,
      expectedRevision: null,
    });

    const connected = await connectQuickModelProvider(harness.runtime, { provider: "ollama" });
    expect(connected.connection).toMatchObject({
      enabled: true,
      credentialState: "missing",
      authenticationMode: "none",
      connectionStatus: "ready",
    });
    const ready = await configureConfirmedQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    expect(ready.route.enabled).toBe(true);
    expect(ready.route.privacyPolicy).toBe("local_only");
  });

  it("creates a fresh ordinary id after retirement and routes only the exact active catalog", async () => {
    const harness = createHarness();
    let retired = await harness.runtime.modelHub.saveConnection({
      id: "deepseek",
      providerKind: "deepseek",
      displayName: "Retired DeepSeek",
      credentialRef: "keyring:model-hub:retired-deepseek-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    await harness.runtime.modelHub.syncCatalog({
      syncId: "retired-deepseek-sync",
      connectionId: retired.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "retired-deepseek-model", providerModelId: "novel-text-model" }],
    });
    const currentRetired = await harness.runtime.modelHub.findConnection(retired.id);
    if (currentRetired === null) throw new Error("Expected the retired source connection.");
    retired = await harness.runtime.modelHub.retireConnection({
      connectionId: currentRetired.id,
      expectedRevision: currentRetired.revision,
    });

    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "deepseek",
      secret: "test-new-deepseek-key",
    });

    expect(connected.connection.id).toBe("deepseek-2");
    expect(connected.connection).toMatchObject({ enabled: true, connectionStatus: "ready" });
    await expect(harness.runtime.modelHub.findConnection(retired.id)).resolves.toEqual(retired);
    const routed = await configureConfirmedQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    expect(routed.catalogEntry.connectionId).toBe("deepseek-2");
    expect(routed.route.primaryCatalogEntryId).toBe(routed.catalogEntry.id);
    expect(routed.route.primaryCatalogEntryId).not.toBe("retired-deepseek-model");
  });

  it("connects a manual Qwen model without generation, then probes only after disclosure", async () => {
    const harness = createHarness();
    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "alibaba_qwen",
      secret: "test-qwen-key",
      region: "singapore",
      workspaceId: "workspace-demo",
      manualModelId: "qwen-account-model",
    });

    expect(harness.checkConnection).toHaveBeenCalledOnce();
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    const disclosure = await inspectQuickBookStartRouteProbe(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
    });
    expect(disclosure).toMatchObject({
      connectionDisplayName: "阿里云百炼 / Qwen",
      modelId: "qwen-account-model",
      maximumProviderCalls: 1,
      sends: ["固定短句“只回复：OK”", "最多 64 个输出内容额度"],
      automaticRetryCount: 0,
      estimatedMaximumCostMicros: null,
      dataDestination: "remote",
    });
    await configureQuickBookStartRoute(harness.runtime, {
      connectionId: connected.connection.id,
      catalogEntryId: connected.catalog[0]?.id ?? "missing",
      targetSnapshot: disclosure.targetSnapshot,
      invocationId: disclosure.invocationId,
      humanConfirmed: true,
      disclosureFingerprint: disclosure.fingerprint,
    });
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      model: "qwen-account-model",
      messages: [{ role: "user", content: "只回复：OK" }],
      dispatchScope: { kind: "non_project", reason: "connection_probe" },
      maxOutputTokens: 64,
      config: { retryLimit: 0 },
    });
    expect(harness.generate.mock.calls[0]?.[0]).not.toHaveProperty("reasoningMode");
    expect(connected.connection).toMatchObject({
      providerKind: "alibaba_qwen",
      region: "singapore",
      workspaceId: "workspace-demo",
      baseUrl: "https://workspace-demo.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    });
    expect(connected.catalog).toEqual([
      expect.objectContaining({
        providerModelId: "qwen-account-model",
        catalogSource: "manual",
      }),
    ]);
  });

  it("uses the region currently shown in quick setup when reconnecting Qwen", async () => {
    const harness = createHarness({ secrets: { alibaba_qwen: "saved-qwen-key" } });
    await harness.runtime.modelHub.saveConnection({
      id: "alibaba_qwen",
      providerKind: "alibaba_qwen",
      displayName: "阿里云百炼 / Qwen",
      region: "china_beijing",
      baseUrlOverride: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      credentialRef: "keyring:model-hub:alibaba_qwen",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });

    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "alibaba_qwen",
      region: "singapore",
      workspaceId: "workspace-updated",
      manualModelId: "qwen-updated-model",
    });

    expect(harness.checkConnection.mock.calls[0]?.[0].baseUrl).toBe(
      "https://workspace-updated.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    expect(connected.connection).toMatchObject({
      region: "singapore",
      workspaceId: "workspace-updated",
      baseUrl: "https://workspace-updated.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    });
    expect(connected.reusedCredential).toBe(true);
    expect(harness.saveCredential).not.toHaveBeenCalledWith("alibaba_qwen", expect.any(String));
  });

  it("keeps each quick custom compatible connection independent", async () => {
    const harness = createHarness();
    const first = await connectQuickModelProvider(harness.runtime, {
      provider: "custom_openai_compatible",
      connectionId: "quick-custom-one",
      baseUrlOverride: "https://one.example.test/v1",
      manualModelId: "writer-one",
      secret: "test-custom-one",
    });
    const second = await connectQuickModelProvider(harness.runtime, {
      provider: "custom_openai_compatible",
      connectionId: "quick-custom-two",
      baseUrlOverride: "https://two.example.test/v1",
      manualModelId: "writer-two",
      secret: "test-custom-two",
    });

    expect(first.connection.id).toBe("quick-custom-one");
    expect(second.connection.id).toBe("quick-custom-two");
    expect(first.connection.baseUrl).toBe("https://one.example.test/v1");
    expect(second.connection.baseUrl).toBe("https://two.example.test/v1");
    expect(harness.secrets.get(modelHubCredentialProviderId(first.connection))).toBe(
      "test-custom-one",
    );
    expect(harness.secrets.get(modelHubCredentialProviderId(second.connection))).toBe(
      "test-custom-two",
    );
    expect(
      (await harness.runtime.modelHub.listConnections()).filter(
        ({ providerKind }) => providerKind === "custom_openai_compatible",
      ),
    ).toHaveLength(2);
  });

  it("keeps a new connection unpublished when the versioned credential slot cannot be saved", async () => {
    const harness = createHarness({ failCredentialSave: true });

    await expect(
      connectQuickModelProvider(harness.runtime, {
        provider: "openai",
        secret: "test-save-failure-key",
      }),
    ).rejects.toMatchObject({ code: "QUICK_MODEL_STAGING_CREDENTIAL_FAILED" });

    await expect(harness.runtime.modelHub.findConnection("openai")).resolves.toBeNull();
    await expect(harness.runtime.modelHub.listCatalog("openai")).resolves.toEqual([]);
    await expect(harness.runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);
    expect([...harness.secrets.keys()].some((key) => key.startsWith("quick-key-"))).toBe(false);
  });

  it("recovers a prepared crash journal for an unpublished connection before retrying", async () => {
    const harness = createHarness();
    harness.secrets.set("quick-key-abandoned", "abandoned-secret");
    await harness.runtime.modelHub.prepareConnectionCommit({
      id: "abandoned-quick-commit",
      connectionId: "openai",
      credentialProviderId: "quick-key-abandoned",
    });

    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-retry-secret",
    });

    expect(harness.deleteCredential).toHaveBeenCalledWith("quick-key-abandoned");
    expect(harness.secrets.has("quick-key-abandoned")).toBe(false);
    expect(harness.secrets.get(modelHubCredentialProviderId(connected.connection))).toBe(
      "test-retry-secret",
    );
    await expect(harness.runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);
  });

  it("keeps the new ready connection valid while old-slot cleanup retries", async () => {
    const harness = createHarness({
      secrets: { openai: "test-old-secret" },
      failDeleteOnceFor: "openai",
    });
    const existing = await harness.runtime.modelHub.saveConnection({
      id: "openai",
      providerKind: "openai",
      displayName: "Existing OpenAI",
      credentialRef: "keyring:model-hub:openai",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    await harness.runtime.modelHub.recordConnectionTest({
      connectionId: existing.id,
      status: "ready",
      expectedRevision: existing.revision,
    });

    const connected = await connectQuickModelProvider(harness.runtime, {
      provider: "openai",
      secret: "test-new-secret",
    });
    const activeSlot = modelHubCredentialProviderId(connected.connection);
    expect(activeSlot).toMatch(/^quick-key-/u);
    expect(harness.secrets.get(activeSlot)).toBe("test-new-secret");
    expect(harness.secrets.get("openai")).toBe("test-old-secret");
    await expect(harness.runtime.modelHub.findConnection("openai")).resolves.toMatchObject({
      enabled: true,
      connectionStatus: "ready",
      credentialRef: `keyring:model-hub:${activeSlot}`,
    });
    await expect(harness.runtime.modelHub.findConnectionCommit("openai")).resolves.toMatchObject({
      phase: "cleanup_pending",
      cleanupCredentialProviderId: "openai",
    });

    const retried = await connectQuickModelProvider(harness.runtime, { provider: "openai" });
    expect(modelHubCredentialProviderId(retried.connection)).toBe(activeSlot);
    expect(harness.secrets.has("openai")).toBe(false);
    expect(harness.secrets.get(activeSlot)).toBe("test-new-secret");
    await expect(harness.runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);
  });

  it("requires an explicit account model when the provider has no reliable catalog", async () => {
    const harness = createHarness();
    await expect(
      connectQuickModelProvider(harness.runtime, {
        provider: "zhipu_glm",
        secret: "test-glm-key",
      }),
    ).rejects.toMatchObject({ code: "QUICK_MODEL_ID_REQUIRED" });
    expect(harness.saveCredential).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });
});

async function configureConfirmedQuickBookStartRoute(
  runtime: DesktopRuntime,
  input: Readonly<{ connectionId: string; catalogEntryId: string }>,
) {
  const disclosure = await inspectQuickBookStartRouteProbe(runtime, input);
  return configureQuickBookStartRoute(runtime, {
    ...input,
    targetSnapshot: disclosure.targetSnapshot,
    invocationId: disclosure.invocationId,
    humanConfirmed: true,
    disclosureFingerprint: disclosure.fingerprint,
  });
}

function createHarness(
  input: Readonly<{
    secrets?: Readonly<Record<string, string>>;
    failAuthentication?: boolean;
    failCredentialSave?: boolean;
    failDeleteOnceFor?: string;
    nativeInvocationLedger?: boolean;
    rejectBeforeNativeInvocationReceipt?: boolean;
    models?: readonly { readonly id: string; readonly displayName: string }[];
  }> = {},
) {
  const base = createDevelopmentRuntime(window.localStorage);
  const secrets = new Map(Object.entries(input.secrets ?? {}));
  let deleteFailed = false;
  const saveCredential = vi.fn((providerId: string, secret: string) => {
    if (input.failCredentialSave === true && providerId.startsWith("quick-key-")) {
      return Promise.reject(new Error("simulated credential save failure"));
    }
    secrets.set(providerId, secret);
    return Promise.resolve({ configured: true, lastFour: secret.slice(-4) });
  });
  const deleteCredential = vi.fn((providerId: string) => {
    if (providerId === input.failDeleteOnceFor && !deleteFailed) {
      deleteFailed = true;
      return Promise.reject(new Error("simulated credential delete failure"));
    }
    secrets.delete(providerId);
    return Promise.resolve({ configured: false, lastFour: null });
  });
  const credentials: CredentialStore = {
    getSummary: vi.fn((providerId: string) => {
      const secret = secrets.get(providerId);
      return Promise.resolve({
        configured: secret !== undefined,
        lastFour: secret?.slice(-4) ?? null,
      });
    }),
    save: saveCredential,
    delete: deleteCredential,
  };
  const checkConnection = vi.fn(
    (config: Parameters<NativeModelGatewayClient["checkConnection"]>[0]) => {
      if (input.failAuthentication === true) {
        return Promise.reject(
          Object.assign(new Error("provider rejected credential"), {
            code: "MODEL_HTTP_UNAUTHORIZED",
          }),
        );
      }
      return Promise.resolve({
        provider: config.provider,
        endpointOrigin: new URL(config.baseUrl).origin,
        modelCount: 1,
        latencyMs: 12,
      });
    },
  );
  const listModels = vi.fn((config: Parameters<NativeModelGatewayClient["listModels"]>[0]) =>
    Promise.resolve({
      provider: config.provider,
      models: input.models ?? [{ id: "novel-text-model", displayName: "Novel Text Model" }],
    }),
  );
  const generate = vi.fn<NativeModelGatewayClient["generate"]>(async (request) => {
    if (input.rejectBeforeNativeInvocationReceipt === true) {
      throw Object.assign(new Error("native preparation rejected"), {
        code: "MODEL_CREDENTIAL_MISSING",
        retryable: false,
      });
    }
    if (input.nativeInvocationLedger === true) {
      const ledger = request.invocationDispatchLedger;
      if (ledger === undefined) throw new Error("missing native invocation ledger boundary");
      const persisted = await base.modelHub.markInvocationDispatched({
        id: ledger.invocationId,
        dispatchedAt: "2026-08-21T00:00:00.000Z",
        expectedRevision: ledger.expectedRevision,
      });
      await request.onInvocationDispatchAccepted?.({
        invocationId: persisted.id,
        dispatchedAt: persisted.providerDispatchStartedAt ?? "",
        revision: persisted.revision,
      });
    }
    request.onDelta?.("OK");
    return { text: "OK", usage: null };
  });
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    ...(input.nativeInvocationLedger === true
      ? { supportsNativeInvocationDispatchLedger: true as const }
      : {}),
    checkConnection,
    listModels,
    generate,
    cancelGeneration: () => Promise.resolve(false),
    embed: base.modelGateway.embed.bind(base.modelGateway),
    ...(base.modelGateway.rerank === undefined
      ? {}
      : { rerank: base.modelGateway.rerank.bind(base.modelGateway) }),
  };
  const runtime: DesktopRuntime = Object.freeze({
    ...base,
    mode: "tauri",
    credentials,
    modelGateway,
  });
  return {
    runtime,
    secrets,
    saveCredential,
    deleteCredential,
    checkConnection,
    listModels,
    generate,
  };
}
