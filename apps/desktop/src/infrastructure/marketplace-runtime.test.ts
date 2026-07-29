import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalMarketplaceJson,
  marketplaceSubmissionSignaturePayload,
  type CloudMarketplaceDownloadResponse,
} from "@inkshadow/contracts/marketplace";
import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import {
  BrowserMarketplaceInstallStore,
  InMemoryMarketplaceInstallStore,
  MarketplaceRuntime,
  SqliteMarketplaceInstallStore,
  type InstalledMarketplaceArtifact,
  type MarketplaceCloudGateway,
} from "./marketplace-runtime.js";
import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";

const ARTIFACT_ID = "0198b555-0000-7000-8000-000000000001";
const VERSION_ID = "0198b555-0000-7000-8000-000000000002";
const ACCOUNT_ID = "0198b555-0000-7000-8000-000000000003";
const REQUEST_ID = "0198b555-0000-7000-8000-000000000004";
const AUDIT_ID = "0198b555-0000-7000-8000-000000000005";
const NOW = new Date("2026-07-29T06:00:00.000Z");
const MARKETPLACE_MIGRATION = readWorkspaceFile(
  "packages",
  "data",
  "migrations",
  "0029_community_marketplace_installs.sql",
);

describe("MarketplaceRuntime", () => {
  it("defaults off, never calls the network and preserves installed local copies", async () => {
    const store = new InMemoryMarketplaceInstallStore();
    await store.put(installedFixture());
    const gateway = gatewayStub();
    const runtime = new MarketplaceRuntime({
      client: gateway,
      installStore: store,
      now: () => NOW,
    });
    const snapshot = await runtime.refreshCatalog();
    expect(snapshot.remoteState).toBe("disabled");
    expect(snapshot.installed).toHaveLength(1);
    expect(snapshot.installed[0]?.artifact.artifactId).toBe(ARTIFACT_ID);
    expect(gateway.listCatalog).not.toHaveBeenCalled();
    await expect(runtime.install(ARTIFACT_ID, VERSION_ID)).rejects.toMatchObject({
      code: "MARKETPLACE_DISABLED",
    });
    expect(gateway.download).not.toHaveBeenCalled();
  });

  it("keeps local copies usable while offline without requesting the catalog", async () => {
    const store = new InMemoryMarketplaceInstallStore();
    await store.put(installedFixture());
    const gateway = gatewayStub();
    const runtime = new MarketplaceRuntime({
      client: gateway,
      featureEnabled: true,
      installStore: store,
      isOnline: () => false,
      now: () => NOW,
    });
    const snapshot = await runtime.refreshCatalog();
    expect(snapshot.remoteState).toBe("offline");
    expect(snapshot.installed).toHaveLength(1);
    expect(snapshot.installed[0]?.artifact.artifactId).toBe(ARTIFACT_ID);
    expect(gateway.listCatalog).not.toHaveBeenCalled();
    await expect(runtime.install(ARTIFACT_ID, VERSION_ID)).rejects.toMatchObject({
      code: "MARKETPLACE_OFFLINE",
    });
  });

  it("verifies digest, signing key and Ed25519 signature before installing", async () => {
    const response = signedDownload();
    const store = new InMemoryMarketplaceInstallStore();
    const gateway = gatewayStub({
      download: () => Promise.resolve(response),
      listCatalog: () =>
        Promise.resolve({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          artifacts: [response.artifact],
          nextCursor: null,
        }),
    });
    const runtime = new MarketplaceRuntime({
      client: gateway,
      featureEnabled: true,
      idempotencyKeyFactory: () => "market-runtime-install-0001",
      installStore: store,
      isOnline: () => true,
      now: () => NOW,
    });
    const catalogSnapshot = await runtime.refreshCatalog();
    expect(catalogSnapshot.remoteState).toBe("ready");
    expect(catalogSnapshot.catalog).toHaveLength(1);
    expect(catalogSnapshot.catalog[0]?.artifactId).toBe(ARTIFACT_ID);
    await expect(runtime.install(ARTIFACT_ID, VERSION_ID)).resolves.toMatchObject({
      artifact: { artifactId: ARTIFACT_ID },
      installedAt: NOW.toISOString(),
    });
    expect(gateway.download).toHaveBeenCalledWith(
      ARTIFACT_ID,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, versionId: VERSION_ID },
      { idempotencyKey: "market-runtime-install-0001" },
    );

    runtime.setFeatureEnabled(false);
    const localOnly = await runtime.snapshot();
    expect(localOnly.remoteState).toBe("disabled");
    expect(localOnly.installed).toHaveLength(1);
  });

  it("rejects a tampered but structurally valid download without creating a local copy", async () => {
    const response = signedDownload();
    const firstSection = response.content.sections[0];
    if (firstSection === undefined) {
      throw new Error("Signed download fixture requires a first section.");
    }
    const tampered: CloudMarketplaceDownloadResponse = {
      ...response,
      content: {
        ...response.content,
        sections: [
          {
            ...firstSection,
            items: [
              {
                itemId: "premise",
                kind: "text",
                label: "Premise",
                value: "Tampered content that was not signed.",
              },
            ],
          },
        ],
      },
    };
    const store = new InMemoryMarketplaceInstallStore();
    const gateway = gatewayStub({ download: () => Promise.resolve(tampered) });
    const runtime = new MarketplaceRuntime({
      client: gateway,
      featureEnabled: true,
      installStore: store,
      isOnline: () => true,
    });
    await expect(runtime.install(ARTIFACT_ID, VERSION_ID)).rejects.toMatchObject({
      code: "MARKETPLACE_UNTRUSTED",
    });
    expect(await store.list()).toEqual([]);
  });

  it("persists verified local copies in SQLite across store instances", async () => {
    const executor = new NodeSqliteExecutor(MARKETPLACE_MIGRATION);
    try {
      const first = new SqliteMarketplaceInstallStore(executor);
      await first.put(installedFixture());

      const reopened = new SqliteMarketplaceInstallStore(executor);
      await expect(reopened.list()).resolves.toMatchObject([
        {
          artifact: { artifactId: ARTIFACT_ID },
          version: { versionId: VERSION_ID },
          installedAt: NOW.toISOString(),
        },
      ]);

      await reopened.remove(ARTIFACT_ID);
      await expect(first.list()).resolves.toEqual([]);
    } finally {
      await executor.close();
    }
  });

  it("fails closed without deleting a locally corrupted SQLite copy", async () => {
    const executor = new NodeSqliteExecutor(MARKETPLACE_MIGRATION);
    try {
      const store = new SqliteMarketplaceInstallStore(executor);
      const installed = installedFixture();
      await store.put(installed);
      const corrupted = structuredClone(installed);
      const section = corrupted.content.sections[0];
      if (section === undefined) {
        throw new Error("Marketplace fixture requires one section.");
      }
      section.items[0] = {
        itemId: "premise",
        kind: "text",
        label: "Premise",
        value: "Locally tampered content.",
      };
      await executor.execute(
        `UPDATE community_marketplace_installs
         SET payload_json = ?1
         WHERE artifact_id = ?2`,
        [JSON.stringify(corrupted), ARTIFACT_ID],
      );

      await expect(store.list()).rejects.toThrow(/integrity validation/u);
      const rows = await executor.select<{ readonly count: number }>(
        `SELECT COUNT(*) AS count
         FROM community_marketplace_installs`,
      );
      expect(rows).toEqual([{ count: 1 }]);
    } finally {
      await executor.close();
    }
  });

  it("does not silently delete a corrupted browser-development install", async () => {
    const key = "inkshadow.marketplace.installs.v1";
    const storage = new Map<string, string>([[key, "{not-json"]]);
    const store = new BrowserMarketplaceInstallStore({
      getItem: (name) => storage.get(name) ?? null,
      removeItem: (name) => {
        storage.delete(name);
      },
      setItem: (name, value) => {
        storage.set(name, value);
      },
    });

    await expect(store.list()).rejects.toThrow(/integrity validation/u);
    expect(storage.get(key)).toBe("{not-json");
  });
});

type GatewayOverrides = Partial<Pick<MarketplaceCloudGateway, "download" | "listCatalog">>;

function gatewayStub(overrides: GatewayOverrides = {}) {
  const unused = vi.fn<() => Promise<never>>(() =>
    Promise.reject(new Error("Unexpected marketplace gateway invocation.")),
  );
  const download = vi.fn<MarketplaceCloudGateway["download"]>(
    overrides.download ?? (() => Promise.reject(new Error("Unexpected marketplace download."))),
  );
  const listCatalog = vi.fn<MarketplaceCloudGateway["listCatalog"]>(
    overrides.listCatalog ??
      (() =>
        Promise.resolve({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          artifacts: [],
          nextCursor: null,
        })),
  );
  return {
    appealVersion: unused,
    download,
    listCatalog,
    reportVersion: unused,
    submitVersion: unused,
    withdrawVersion: unused,
  } satisfies MarketplaceCloudGateway;
}

function signedDownload(): CloudMarketplaceDownloadResponse {
  const keys = generateKeyPairSync("ed25519");
  const content = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    format: "inkshadow.marketplace.structured-artifact.v1" as const,
    sections: [
      {
        sectionId: "story_seed",
        title: "Story seed",
        items: [
          {
            itemId: "premise",
            kind: "text" as const,
            label: "Premise",
            value: "A cartographer discovers a city erased from every map.",
          },
        ],
      },
    ],
  };
  const artifact = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    authorAccountId: ACCOUNT_ID,
    authorDisplayName: "Ink Cartographer",
    kind: "story_template" as const,
    title: "The Vanished City",
    summary: "A structured story seed for mystery adventures.",
    tags: ["adventure", "mystery"],
    license: "cc-by-4.0" as const,
    state: "published" as const,
    revision: 2,
    latestVersionNumber: 1,
    pendingVersionId: null,
    publishedVersionId: VERSION_ID,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    publishedAt: NOW.toISOString(),
    quarantinedAt: null,
    withdrawnAt: null,
    retentionUntil: null,
  };
  const signaturePayload = Buffer.from(
    canonicalMarketplaceJson(
      marketplaceSubmissionSignaturePayload({
        artifactId: ARTIFACT_ID,
        authorAccountId: ACCOUNT_ID,
        authorDisplayName: artifact.authorDisplayName,
        content,
        kind: artifact.kind,
        license: artifact.license,
        semanticVersion: "1.0.0",
        summary: artifact.summary,
        tags: artifact.tags,
        title: artifact.title,
        versionId: VERSION_ID,
        versionNumber: 1,
      }),
    ),
    "utf8",
  );
  const publicKeyBytes = keys.publicKey.export({ format: "der", type: "spki" });
  const response: CloudMarketplaceDownloadResponse = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    downloadAuditId: AUDIT_ID,
    retentionUntil: "2026-10-27T06:00:00.000Z",
    artifact,
    version: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      artifactId: ARTIFACT_ID,
      versionId: VERSION_ID,
      versionNumber: 1,
      semanticVersion: "1.0.0",
      state: "published",
      contentDigestSha256: createHash("sha256").update(signaturePayload).digest("hex"),
      authorSigningKeyFingerprintSha256: createHash("sha256").update(publicKeyBytes).digest("hex"),
      contentBytes: Buffer.byteLength(canonicalMarketplaceJson(content), "utf8"),
      createdAt: NOW.toISOString(),
      submittedAt: NOW.toISOString(),
      reviewedAt: NOW.toISOString(),
      publishedAt: NOW.toISOString(),
      quarantinedAt: null,
      withdrawnAt: null,
      retentionUntil: null,
    },
    content,
    authorPublicKeySpki: publicKeyBytes.toString("base64url"),
    authorSignature: sign(null, signaturePayload, keys.privateKey).toString("base64url"),
  };
  signaturePayload.fill(0);
  return response;
}

function installedFixture(): InstalledMarketplaceArtifact {
  const response = signedDownload();
  return {
    artifact: response.artifact,
    authorPublicKeySpki: response.authorPublicKeySpki,
    authorSignature: response.authorSignature,
    content: response.content,
    contentDigestSha256: response.version.contentDigestSha256,
    installedAt: NOW.toISOString(),
    version: response.version,
  };
}

function readWorkspaceFile(...segments: string[]): string {
  const workspaceRoot = [process.cwd(), path.resolve(process.cwd(), "..", "..")].find((candidate) =>
    existsSync(
      path.join(
        candidate,
        "packages",
        "data",
        "migrations",
        "0029_community_marketplace_installs.sql",
      ),
    ),
  );
  if (workspaceRoot === undefined) {
    throw new Error("Unable to locate the InkShadow workspace root.");
  }
  return readFileSync(path.resolve(workspaceRoot, ...segments), "utf8");
}
