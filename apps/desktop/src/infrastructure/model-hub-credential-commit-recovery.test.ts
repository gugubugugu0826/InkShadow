import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  recoverModelHubCredentialCommitForConnection,
  recoverModelHubCredentialCommits,
} from "./model-hub-credential-commit-recovery";
import { createDevelopmentRuntime } from "./runtime";

describe("Model Hub credential commit recovery", () => {
  beforeEach(() => window.localStorage.clear());

  it("recovers a prepared slot for a connection that was never published", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const secrets = new Map([["quick-key-abandoned", "secret"]]);
    const deleteCredential = vi.fn((providerId: string) => {
      secrets.delete(providerId);
      return Promise.resolve({ configured: false });
    });
    await runtime.modelHub.prepareConnectionCommit({
      id: "abandoned-commit",
      connectionId: "never-published",
      credentialProviderId: "quick-key-abandoned",
    });

    await expect(
      recoverModelHubCredentialCommits({
        modelHub: runtime.modelHub,
        credentials: { delete: deleteCredential },
      }),
    ).resolves.toEqual({ recoveredCount: 1, remainingCount: 0 });
    expect(deleteCredential).toHaveBeenCalledWith("quick-key-abandoned");
    expect(secrets.has("quick-key-abandoned")).toBe(false);
    await expect(runtime.modelHub.listConnectionCommits()).resolves.toEqual([]);
    await expect(runtime.modelHub.findConnection("never-published")).resolves.toBeNull();
  });

  it("cleans an old slot after publication without deleting the active slot", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    let existing = await runtime.modelHub.saveConnection({
      id: "published-connection",
      providerKind: "openai",
      displayName: "Published",
      credentialRef: "keyring:model-hub:old-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    existing = await runtime.modelHub.recordConnectionTest({
      connectionId: existing.id,
      status: "ready",
      expectedRevision: existing.revision,
    });
    await runtime.modelHub.prepareConnectionCommit({
      id: "published-commit",
      connectionId: existing.id,
      credentialProviderId: "new-slot",
    });
    await runtime.modelHub.publishConnectionCommit({
      id: "published-commit",
      credentialProviderId: "new-slot",
      cleanupCredentialProviderId: "old-slot",
      connection: {
        id: existing.id,
        providerKind: existing.providerKind,
        displayName: existing.displayName,
        baseUrlOverride: existing.baseUrl,
        credentialRef: "keyring:model-hub:new-slot",
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        enabled: true,
        expectedRevision: existing.revision,
      },
      catalog: {
        syncId: "published-sync",
        connectionId: existing.id,
        source: "provider_api",
        status: "succeeded",
        models: [{ id: "published-model", providerModelId: "writer" }],
      },
    });
    const secrets = new Map([
      ["old-slot", "old"],
      ["new-slot", "new"],
    ]);
    const deleteCredential = vi.fn((providerId: string) => {
      secrets.delete(providerId);
      return Promise.resolve({ configured: false });
    });

    await expect(
      recoverModelHubCredentialCommitForConnection(
        {
          modelHub: runtime.modelHub,
          credentials: { delete: deleteCredential },
        },
        existing.id,
      ),
    ).resolves.toBe(true);
    expect(deleteCredential).toHaveBeenCalledWith("old-slot");
    expect(deleteCredential).not.toHaveBeenCalledWith("new-slot");
    expect(secrets.has("old-slot")).toBe(false);
    expect(secrets.get("new-slot")).toBe("new");
    await expect(runtime.modelHub.findConnection(existing.id)).resolves.toMatchObject({
      enabled: true,
      connectionStatus: "ready",
      credentialRef: "keyring:model-hub:new-slot",
    });
  });

  it("finishes cleanup without deleting a superseded slot still shared by another connection", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelHub.saveConnection({
      id: "shared-slot-owner",
      providerKind: "openai",
      displayName: "Shared owner",
      credentialRef: "keyring:model-hub:shared-old-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    const target = await runtime.modelHub.saveConnection({
      id: "shared-slot-target",
      providerKind: "openai",
      displayName: "Shared target",
      credentialRef: "keyring:model-hub:shared-old-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    await runtime.modelHub.prepareConnectionCommit({
      id: "shared-slot-commit",
      connectionId: target.id,
      credentialProviderId: "shared-new-slot",
    });
    await runtime.modelHub.publishConnectionCommit({
      id: "shared-slot-commit",
      credentialProviderId: "shared-new-slot",
      cleanupCredentialProviderId: "shared-old-slot",
      connection: {
        id: target.id,
        providerKind: target.providerKind,
        displayName: target.displayName,
        credentialRef: "keyring:model-hub:shared-new-slot",
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        enabled: true,
        expectedRevision: target.revision,
      },
      catalog: {
        syncId: "shared-slot-sync",
        connectionId: target.id,
        source: "provider_api",
        status: "succeeded",
        models: [{ id: "shared-slot-model", providerModelId: "writer" }],
      },
    });
    const deleteCredential = vi.fn(() => Promise.resolve({ configured: false }));

    await expect(
      recoverModelHubCredentialCommitForConnection(
        {
          modelHub: runtime.modelHub,
          credentials: { delete: deleteCredential },
        },
        target.id,
      ),
    ).resolves.toBe(true);
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(runtime.modelHub.findConnectionCommit(target.id)).resolves.toBeNull();
  });

  it("never deletes a slot referenced by a published connection and retries vault failure", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelHub.saveConnection({
      id: "active-connection",
      providerKind: "openai",
      displayName: "Active",
      credentialRef: "keyring:model-hub:active-slot",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });
    await runtime.modelHub.prepareConnectionCommit({
      id: "stale-prepared",
      connectionId: "unpublished-shadow",
      credentialProviderId: "active-slot",
    });
    const deleteCredential = vi.fn(() => Promise.reject(new Error("vault unavailable")));

    await expect(
      recoverModelHubCredentialCommits({
        modelHub: runtime.modelHub,
        credentials: { delete: deleteCredential },
      }),
    ).resolves.toEqual({ recoveredCount: 0, remainingCount: 1 });
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(
      runtime.modelHub.findConnectionCommit("unpublished-shadow"),
    ).resolves.toMatchObject({ id: "stale-prepared" });

    await runtime.modelHub.finishConnectionCommit("unpublished-shadow", "stale-prepared");
    await runtime.modelHub.prepareConnectionCommit({
      id: "retry-prepared",
      connectionId: "retry-unpublished",
      credentialProviderId: "retry-slot",
    });
    await expect(
      recoverModelHubCredentialCommits({
        modelHub: runtime.modelHub,
        credentials: { delete: deleteCredential },
      }),
    ).resolves.toEqual({ recoveredCount: 0, remainingCount: 1 });
    await expect(runtime.modelHub.findConnectionCommit("retry-unpublished")).resolves.toMatchObject(
      { id: "retry-prepared" },
    );
  });
});
