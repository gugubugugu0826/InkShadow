import { beforeEach, describe, expect, it, vi } from "vitest";

import { retireModelHubConnection } from "./model-hub-connection-retirement-service";
import { isRetiredModelProviderConnection } from "./model-hub-store";
import { createDevelopmentRuntime } from "./runtime";

describe("retireModelHubConnection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("removes the credential, clears legacy selection, and is safe to retry", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.modelHub.saveConnection({
      id: "retire-service-provider",
      providerKind: "custom_openai_compatible",
      displayName: "Retire service provider",
      baseUrlOverride: "https://retire.example.test/v1",
      credentialRef: "keyring:model-hub:retire-service-provider",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    await runtime.modelCenter.save({
      providerId: created.id,
      provider: "open_ai_compatible",
      baseUrl: created.baseUrl,
      authentication: "bearer_keyring",
      selectedModel: "writer-model",
      expectedRevision: null,
    });
    let credentialConfigured = true;
    const deleteCredential = vi.fn(() => {
      credentialConfigured = false;
      return Promise.resolve({ configured: false, lastFour: null });
    });
    const dependencies = {
      modelHub: runtime.modelHub,
      modelCenter: runtime.modelCenter,
      credentials: { delete: deleteCredential },
    };

    const retired = await retireModelHubConnection(dependencies, {
      connectionId: created.id,
      expectedRevision: created.revision,
    });
    expect(isRetiredModelProviderConnection(retired.connection)).toBe(true);
    expect(retired.credential).toEqual({ configured: false, lastFour: null });
    expect(retired.credentialCleanup).toBe("deleted");
    expect(credentialConfigured).toBe(false);
    await expect(runtime.modelCenter.findByProviderId(created.id)).resolves.toMatchObject({
      selectedModel: null,
    });

    await expect(
      retireModelHubConnection(dependencies, {
        connectionId: created.id,
        expectedRevision: created.revision,
      }),
    ).resolves.toMatchObject({ connection: retired.connection });
    expect(deleteCredential).toHaveBeenCalledTimes(1);
  });

  it("retires a malformed or unowned credential reference without guessing a vault slot", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.modelHub.saveConnection({
      id: "retire-corrupt-reference",
      providerKind: "custom_openai_compatible",
      displayName: "Corrupt reference",
      baseUrlOverride: "https://retire-corrupt.example.test/v1",
      credentialRef: "keyring:external-vault:unknown-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));

    const retired = await retireModelHubConnection(
      {
        modelHub: runtime.modelHub,
        modelCenter: runtime.modelCenter,
        credentials: { delete: deleteCredential },
      },
      { connectionId: created.id, expectedRevision: created.revision },
    );

    expect(isRetiredModelProviderConnection(retired.connection)).toBe(true);
    expect(retired.credentialCleanup).toBe("skipped_unowned_reference");
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("finishes cleanup after a partial failure when retried with the refreshed CAS revision", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.modelHub.saveConnection({
      id: "retire-service-cleanup-retry",
      providerKind: "custom_openai_compatible",
      displayName: "Retire cleanup retry",
      baseUrlOverride: "https://retire-retry.example.test/v1",
      credentialRef: "keyring:model-hub:retire-service-cleanup-retry",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    const deleteCredential = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary vault failure"))
      .mockResolvedValue({ configured: false, lastFour: null });
    const dependencies = {
      modelHub: runtime.modelHub,
      modelCenter: runtime.modelCenter,
      credentials: { delete: deleteCredential },
    };

    await expect(
      retireModelHubConnection(dependencies, {
        connectionId: created.id,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CONNECTION_RETIREMENT_INCOMPLETE" });
    const disabled = await runtime.modelHub.findConnection(created.id);
    expect(disabled).toMatchObject({
      enabled: false,
      revision: created.revision + 1,
      credentialRef: created.credentialRef,
    });
    if (disabled === null) throw new Error("Expected the disabled connection.");

    const retired = await retireModelHubConnection(dependencies, {
      connectionId: disabled.id,
      expectedRevision: disabled.revision,
    });
    expect(isRetiredModelProviderConnection(retired.connection)).toBe(true);
    expect(retired.connection.revision).toBe(created.revision + 2);
    expect(deleteCredential).toHaveBeenCalledTimes(2);
  });
});
