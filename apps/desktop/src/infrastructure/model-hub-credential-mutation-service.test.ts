import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteModelHubCredential,
  saveModelHubCredential,
} from "./model-hub-credential-mutation-service";
import { modelHubCredentialProviderId } from "./model-hub-native-config";
import { recoverModelHubCredentialCommitForConnection } from "./model-hub-credential-commit-recovery";
import { createDevelopmentRuntime, type CredentialStore, type DesktopRuntime } from "./runtime";

describe("Model Hub credential mutation service", () => {
  beforeEach(() => window.localStorage.clear());

  it("moves an existing quick connection to a new slot without publishing fake readiness", async () => {
    const harness = createHarness({ "quick-key-old": "old-secret" });
    const existing = await seedReadyConnection(harness.runtime, "quick-key-old");

    const saved = await saveModelHubCredential(harness.runtime, {
      connection: connectionInput(existing),
      secret: "test-new-credential",
    });

    const activeSlot = modelHubCredentialProviderId(saved.connection);
    expect(activeSlot).toMatch(/^model-key-/u);
    expect(harness.secrets.get(activeSlot)).toBe("test-new-credential");
    expect(harness.secrets.has("quick-key-old")).toBe(false);
    expect(saved.connection).toMatchObject({
      enabled: true,
      connectionStatus: "not_tested",
      credentialRef: `keyring:model-hub:${activeSlot}`,
    });
    expect(saved.oldCredentialCleanupPending).toBe(false);
    await expect(
      harness.runtime.modelHub.findTaskRoute("book_start_guidance"),
    ).resolves.toMatchObject({ primaryCatalogEntryId: "credential-model" });
  });

  it("preserves the old ready connection when slot save or database publication fails", async () => {
    const saveFailure = createHarness({ "quick-key-old": "old-secret" }, { failNewSlotSave: true });
    const original = await seedReadyConnection(saveFailure.runtime, "quick-key-old");
    await expect(
      saveModelHubCredential(saveFailure.runtime, {
        connection: connectionInput(original),
        secret: "test-new-credential",
      }),
    ).rejects.toBeDefined();
    await expect(saveFailure.runtime.modelHub.findConnection(original.id)).resolves.toEqual(
      original,
    );
    expect(saveFailure.secrets).toEqual(new Map([["quick-key-old", "old-secret"]]));
    await expect(saveFailure.runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);

    window.localStorage.clear();
    const publishFailure = createHarness({ "quick-key-old": "old-secret" });
    const publishOriginal = await seedReadyConnection(publishFailure.runtime, "quick-key-old");
    vi.spyOn(publishFailure.runtime.modelHub, "publishCredentialCommit").mockRejectedValueOnce(
      new Error("simulated SQLite failure"),
    );
    await expect(
      saveModelHubCredential(publishFailure.runtime, {
        connection: connectionInput(publishOriginal),
        secret: "test-new-credential",
      }),
    ).rejects.toBeDefined();
    await expect(
      publishFailure.runtime.modelHub.findConnection(publishOriginal.id),
    ).resolves.toEqual(publishOriginal);
    expect([...publishFailure.secrets.keys()]).toEqual(["quick-key-old"]);
    await expect(publishFailure.runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);
  });

  it("keeps a published new slot usable when old-slot cleanup must retry", async () => {
    const harness = createHarness(
      { "quick-key-old": "old-secret" },
      { failDeleteOnceFor: "quick-key-old" },
    );
    const existing = await seedReadyConnection(harness.runtime, "quick-key-old");
    const saved = await saveModelHubCredential(harness.runtime, {
      connection: connectionInput(existing),
      secret: "test-new-credential",
    });

    expect(saved.oldCredentialCleanupPending).toBe(true);
    expect(harness.secrets.has(modelHubCredentialProviderId(saved.connection))).toBe(true);
    expect(harness.secrets.has("quick-key-old")).toBe(true);
    await expect(harness.runtime.modelHub.findConnectionCommit(existing.id)).resolves.toMatchObject(
      {
        phase: "cleanup_pending",
        cleanupCredentialProviderId: "quick-key-old",
      },
    );

    await expect(
      recoverModelHubCredentialCommitForConnection(harness.runtime, existing.id),
    ).resolves.toBe(true);
    expect(harness.secrets.has("quick-key-old")).toBe(false);
    expect(harness.secrets.has(modelHubCredentialProviderId(saved.connection))).toBe(true);
  });

  it("repairs an unowned historical reference without guessing or deleting its vault slot", async () => {
    const harness = createHarness({});
    const malformed = await harness.runtime.modelHub.saveConnection({
      id: "expert-openai",
      providerKind: "openai",
      displayName: "Malformed historical reference",
      credentialRef: "keyring:external-vault:unknown-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });

    const saved = await saveModelHubCredential(harness.runtime, {
      connection: connectionInput(malformed),
      secret: "test-replacement-credential",
    });

    expect(saved.connection.credentialRef).toMatch(/^keyring:model-hub:model-key-/u);
    expect(saved.connection.connectionStatus).toBe("not_tested");
    expect(harness.deleteCredential).not.toHaveBeenCalledWith("unknown-slot");
    expect(harness.deleteCredential).not.toHaveBeenCalledWith(malformed.id);
  });

  it("disables an unowned historical reference without deleting a guessed vault slot", async () => {
    const harness = createHarness({});
    const malformed = await harness.runtime.modelHub.saveConnection({
      id: "expert-openai",
      providerKind: "openai",
      displayName: "Malformed historical reference",
      credentialRef: "keyring:external-vault:unknown-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });

    const deleted = await deleteModelHubCredential(harness.runtime, {
      connection: connectionInput(malformed),
    });

    expect(deleted.connection).toMatchObject({
      enabled: false,
      connectionStatus: "disabled",
      credentialRef: null,
      credentialState: "missing",
    });
    expect(deleted.credentialCleanup).toBe("skipped_unowned_reference");
    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });

  it("disables metadata before deleting the current referenced slot and journals a retry", async () => {
    const harness = createHarness({ "versioned-current-slot": "current-secret" });
    const existing = await seedReadyConnection(harness.runtime, "versioned-current-slot");
    const deleted = await deleteModelHubCredential(harness.runtime, {
      connection: connectionInput(existing),
    });

    expect(harness.deleteCredential).toHaveBeenCalledWith("versioned-current-slot");
    expect(harness.deleteCredential).not.toHaveBeenCalledWith(existing.id);
    expect(deleted.connection).toMatchObject({
      enabled: false,
      connectionStatus: "disabled",
      credentialRef: null,
      credentialState: "missing",
    });

    window.localStorage.clear();
    const retry = createHarness(
      { "versioned-current-slot": "current-secret" },
      { failDeleteOnceFor: "versioned-current-slot" },
    );
    const retryExisting = await seedReadyConnection(retry.runtime, "versioned-current-slot");
    await expect(
      deleteModelHubCredential(retry.runtime, {
        connection: connectionInput(retryExisting),
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CREDENTIAL_DELETE_INCOMPLETE" });
    await expect(retry.runtime.modelHub.findConnection(retryExisting.id)).resolves.toMatchObject({
      enabled: false,
      connectionStatus: "disabled",
      credentialRef: null,
    });
    await expect(
      retry.runtime.modelHub.findConnectionCommit(retryExisting.id),
    ).resolves.toMatchObject({ phase: "cleanup_pending" });
    const disabled = await retry.runtime.modelHub.findConnection(retryExisting.id);
    if (disabled === null) throw new Error("Expected disabled credential connection.");
    await expect(
      deleteModelHubCredential(retry.runtime, {
        connection: connectionInput(disabled),
      }),
    ).resolves.toMatchObject({
      connection: { enabled: false, credentialRef: null },
      credential: { configured: false },
    });
    expect(retry.secrets.has("versioned-current-slot")).toBe(false);
  });

  it("clears a legacy selected model and pricing after the shared Model Hub key is deleted", async () => {
    const harness = createHarness({ "versioned-current-slot": "current-secret" });
    const existing = await seedReadyConnection(harness.runtime, "versioned-current-slot");
    await harness.runtime.modelCenter.save({
      providerId: existing.id,
      provider: "open_ai_compatible",
      baseUrl: existing.baseUrl,
      authentication: "bearer_keyring",
      selectedModel: "writer-model",
      pricing: {
        contextWindowTokens: 32_768,
        currency: "USD",
        inputMicrosPerMillionTokens: 1,
        outputMicrosPerMillionTokens: 2,
        cachedInputMicrosPerMillionTokens: 0,
        pricingVersion: "test-v1",
        priceUpdatedAt: "2026-08-08T00:00:00.000Z",
      },
      expectedRevision: null,
    });

    await deleteModelHubCredential(harness.runtime, {
      connection: connectionInput(existing),
    });

    await expect(harness.runtime.modelCenter.findByProviderId(existing.id)).resolves.toMatchObject({
      selectedModel: null,
      pricing: null,
    });
  });

  it("rebinds the same disabled connection after restart without changing its internal id", async () => {
    const harness = createHarness({ "versioned-current-slot": "current-secret" });
    const existing = await seedReadyConnection(harness.runtime, "versioned-current-slot");
    const deleted = await deleteModelHubCredential(harness.runtime, {
      connection: connectionInput(existing),
    });
    expect(deleted.connection).toMatchObject({
      id: existing.id,
      enabled: false,
      credentialRef: null,
      credentialState: "missing",
    });

    const reopenedBase = createDevelopmentRuntime(window.localStorage);
    const reopened: DesktopRuntime = Object.freeze({
      ...reopenedBase,
      mode: "tauri",
      credentials: harness.runtime.credentials,
    });
    const persistedDisabled = await reopened.modelHub.findConnection(existing.id);
    if (persistedDisabled === null)
      throw new Error("Expected the disabled connection after restart.");
    const rebound = await saveModelHubCredential(reopened, {
      connection: connectionInput(persistedDisabled),
      secret: "test-rebound-credential",
    });

    expect(rebound.connection).toMatchObject({
      id: existing.id,
      enabled: true,
      connectionStatus: "not_tested",
      credentialState: "present",
    });
    expect(modelHubCredentialProviderId(rebound.connection)).toMatch(/^model-key-/u);
    await expect(reopened.modelHub.findTaskRoute("book_start_guidance")).resolves.toMatchObject({
      primaryCatalogEntryId: "credential-model",
    });
  });

  it("serializes concurrent rebind attempts so only one credential publication wins", async () => {
    const harness = createHarness({ "versioned-current-slot": "current-secret" });
    const existing = await seedReadyConnection(harness.runtime, "versioned-current-slot");
    const deleted = await deleteModelHubCredential(harness.runtime, {
      connection: connectionInput(existing),
    });
    harness.saveCredential.mockClear();

    const outcomes = await Promise.allSettled([
      saveModelHubCredential(harness.runtime, {
        connection: connectionInput(deleted.connection),
        secret: "test-first-rebind-key",
      }),
      saveModelHubCredential(harness.runtime, {
        connection: connectionInput(deleted.connection),
        secret: "test-second-rebind-key",
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(harness.saveCredential).toHaveBeenCalledTimes(1);
    await expect(harness.runtime.modelHub.findConnection(existing.id)).resolves.toMatchObject({
      enabled: true,
      credentialState: "present",
      connectionStatus: "not_tested",
    });
    await expect(harness.runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);
  });

  it("never publishes a new vault slot into a retired connection id", async () => {
    const harness = createHarness({ "versioned-current-slot": "current-secret" });
    const existing = await seedReadyConnection(harness.runtime, "versioned-current-slot");
    const retired = await harness.runtime.modelHub.retireConnection({
      connectionId: existing.id,
      expectedRevision: existing.revision,
    });
    harness.saveCredential.mockClear();

    await expect(
      saveModelHubCredential(harness.runtime, {
        connection: connectionInput(retired),
        secret: "test-must-not-be-published",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_RETIRED" });

    expect(harness.saveCredential).not.toHaveBeenCalled();
    await expect(harness.runtime.modelHub.findConnection(existing.id)).resolves.toEqual(retired);
    await expect(harness.runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);
  });
});

function createHarness(
  initialSecrets: Readonly<Record<string, string>>,
  options: Readonly<{
    failNewSlotSave?: boolean;
    failDeleteOnceFor?: string;
  }> = {},
) {
  const base = createDevelopmentRuntime(window.localStorage);
  const secrets = new Map(Object.entries(initialSecrets));
  let deleteFailed = false;
  const saveCredential = vi.fn((providerId: string, secret: string) => {
    if (options.failNewSlotSave === true && providerId.startsWith("model-key-")) {
      return Promise.reject(new Error("vault save failed"));
    }
    secrets.set(providerId, secret);
    return Promise.resolve({ configured: true, lastFour: secret.slice(-4) });
  });
  const deleteCredential = vi.fn((providerId: string) => {
    if (providerId === options.failDeleteOnceFor && !deleteFailed) {
      deleteFailed = true;
      return Promise.reject(new Error("vault delete failed"));
    }
    secrets.delete(providerId);
    return Promise.resolve({ configured: false, lastFour: null });
  });
  const credentials: CredentialStore = {
    getSummary: (providerId) =>
      Promise.resolve({
        configured: secrets.has(providerId),
        lastFour: secrets.get(providerId)?.slice(-4) ?? null,
      }),
    save: saveCredential,
    delete: deleteCredential,
  };
  const runtime: DesktopRuntime = Object.freeze({ ...base, mode: "tauri", credentials });
  return { runtime, secrets, saveCredential, deleteCredential };
}

async function seedReadyConnection(runtime: DesktopRuntime, credentialProviderId: string) {
  let connection = await runtime.modelHub.saveConnection({
    id: "expert-openai",
    providerKind: "openai",
    displayName: "Expert OpenAI",
    credentialRef: `keyring:model-hub:${credentialProviderId}`,
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    enabled: true,
    expectedRevision: null,
  });
  connection = await runtime.modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await runtime.modelHub.syncCatalog({
    syncId: "credential-sync",
    connectionId: connection.id,
    source: "provider_api",
    status: "succeeded",
    models: [{ id: "credential-model", providerModelId: "writer-model" }],
  });
  const current = await runtime.modelHub.findConnection(connection.id);
  if (current === null) throw new Error("Expected seeded connection.");
  await runtime.modelHub.saveTaskRoute({
    task: "book_start_guidance",
    primaryCatalogEntryId: "credential-model",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "ask_user",
    routeOrigin: "user",
    expectedRevision: null,
  });
  return current;
}

function connectionInput(connection: Awaited<ReturnType<typeof seedReadyConnection>>) {
  return {
    id: connection.id,
    providerKind: connection.providerKind,
    displayName: connection.displayName,
    region: connection.region,
    workspaceId: connection.workspaceId,
    endpointId: connection.endpointId,
    baseUrlOverride: connection.baseUrl,
    credentialRef: connection.credentialRef,
    credentialState: connection.credentialState,
    authenticationMode: connection.authenticationMode,
    credentialHeaderName: connection.credentialHeaderName,
    modelDiscoveryPath: connection.modelDiscoveryPath,
    textGenerationPath: connection.textGenerationPath,
    embeddingPath: connection.embeddingPath,
    requestTimeoutMs: connection.requestTimeoutMs,
    retryLimit: connection.retryLimit,
    legacyProviderId: connection.legacyProviderId,
    enabled: connection.enabled,
    expectedRevision: connection.revision,
  } as const;
}
