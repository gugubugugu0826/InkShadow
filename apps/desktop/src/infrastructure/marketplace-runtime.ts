import {
  CloudMarketplaceDownloadResponseSchema,
  canonicalMarketplaceJson,
  marketplaceSubmissionSignaturePayload,
  type CloudMarketplaceAppealRequest,
  type CloudMarketplaceAppealResponse,
  type CloudMarketplaceArtifactKind,
  type CloudMarketplaceArtifactSummary,
  type CloudMarketplaceCatalogResponse,
  type CloudMarketplaceDownloadResponse,
  type CloudMarketplaceReportRequest,
  type CloudMarketplaceReportResponse,
  type CloudMarketplaceSubmissionRequest,
  type CloudMarketplaceSubmissionResponse,
  type CloudMarketplaceWithdrawalRequest,
} from "@inkshadow/contracts/marketplace";
import type {
  CloudMarketplaceCatalogOptions,
  CloudMarketplaceClient,
} from "@inkshadow/cloud-client/marketplace";
import type { SqlExecutor } from "@inkshadow/data";

const LOCAL_STORAGE_KEY = "inkshadow.marketplace.installs.v1";

export type MarketplaceCloudGateway = Pick<
  CloudMarketplaceClient,
  | "appealVersion"
  | "download"
  | "listCatalog"
  | "reportVersion"
  | "submitVersion"
  | "withdrawVersion"
>;

export interface InstalledMarketplaceArtifact {
  readonly artifact: CloudMarketplaceArtifactSummary;
  readonly authorPublicKeySpki: string;
  readonly authorSignature: string;
  readonly content: CloudMarketplaceDownloadResponse["content"];
  readonly contentDigestSha256: string;
  readonly installedAt: string;
  readonly version: CloudMarketplaceDownloadResponse["version"];
}

export interface MarketplaceInstallStore {
  list(): Promise<readonly InstalledMarketplaceArtifact[]>;
  put(artifact: InstalledMarketplaceArtifact): Promise<void>;
  remove(artifactId: string): Promise<void>;
}

export interface MarketplaceRuntimeSnapshot {
  readonly catalog: readonly CloudMarketplaceArtifactSummary[];
  readonly installed: readonly InstalledMarketplaceArtifact[];
  readonly remoteState: "disabled" | "offline" | "idle" | "loading" | "ready" | "error";
  readonly remoteError: string | null;
}

export interface MarketplaceRuntimeOptions {
  readonly client: MarketplaceCloudGateway;
  readonly featureEnabled?: boolean;
  readonly idempotencyKeyFactory?: () => string;
  readonly installStore: MarketplaceInstallStore;
  readonly isOnline?: () => boolean;
  readonly now?: () => Date;
}

export function createUnavailableMarketplaceCloudGateway(): MarketplaceCloudGateway {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new Error(
        "The community marketplace endpoint is not configured. Installed local artifacts remain available.",
      ),
    );
  return Object.freeze({
    appealVersion: unavailable,
    download: unavailable,
    listCatalog: unavailable,
    reportVersion: unavailable,
    submitVersion: unavailable,
    withdrawVersion: unavailable,
  });
}

export class MarketplaceRuntime {
  private readonly client: MarketplaceCloudGateway;
  private featureEnabled: boolean;
  private readonly idempotencyKeyFactory: () => string;
  private readonly installStore: MarketplaceInstallStore;
  private readonly isOnline: () => boolean;
  private readonly now: () => Date;
  private catalog: readonly CloudMarketplaceArtifactSummary[] = Object.freeze([]);
  private remoteError: string | null = null;
  private remoteState: MarketplaceRuntimeSnapshot["remoteState"];

  public constructor(options: MarketplaceRuntimeOptions) {
    this.client = options.client;
    this.featureEnabled = options.featureEnabled ?? false;
    this.idempotencyKeyFactory =
      options.idempotencyKeyFactory ?? (() => `marketplace-${globalThis.crypto.randomUUID()}`);
    this.installStore = options.installStore;
    this.isOnline =
      options.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
    this.now = options.now ?? (() => new Date());
    this.remoteState = this.featureEnabled ? "idle" : "disabled";
  }

  public setFeatureEnabled(enabled: boolean): void {
    this.featureEnabled = enabled;
    this.catalog = Object.freeze([]);
    this.remoteError = null;
    this.remoteState = enabled ? (this.isOnline() ? "idle" : "offline") : "disabled";
  }

  public async snapshot(): Promise<MarketplaceRuntimeSnapshot> {
    const installed = await this.installStore.list();
    const remoteState = this.featureEnabled && !this.isOnline() ? "offline" : this.remoteState;
    return {
      catalog: Object.freeze([...this.catalog]),
      installed: Object.freeze([...installed]),
      remoteState,
      remoteError: this.remoteError,
    };
  }

  public async refreshCatalog(
    options: Pick<CloudMarketplaceCatalogOptions, "kind" | "limit"> = {},
  ): Promise<MarketplaceRuntimeSnapshot> {
    if (!this.featureEnabled) {
      this.catalog = Object.freeze([]);
      this.remoteError = null;
      this.remoteState = "disabled";
      return this.snapshot();
    }
    if (!this.isOnline()) {
      this.catalog = Object.freeze([]);
      this.remoteError = null;
      this.remoteState = "offline";
      return this.snapshot();
    }
    this.remoteState = "loading";
    this.remoteError = null;
    try {
      const response: CloudMarketplaceCatalogResponse = await this.client.listCatalog(options);
      this.catalog = Object.freeze([...response.artifacts]);
      this.remoteState = "ready";
    } catch (error: unknown) {
      this.catalog = Object.freeze([]);
      this.remoteError = safeErrorMessage(error);
      this.remoteState = "error";
    }
    return this.snapshot();
  }

  public async install(
    artifactId: string,
    versionId: string,
  ): Promise<InstalledMarketplaceArtifact> {
    this.requireRemoteCapability();
    const response = await this.client.download(
      artifactId,
      { schemaVersion: 1, versionId },
      { idempotencyKey: this.idempotencyKeyFactory() },
    );
    await verifyMarketplaceDownload(response);
    const installed: InstalledMarketplaceArtifact = {
      artifact: response.artifact,
      authorPublicKeySpki: response.authorPublicKeySpki,
      authorSignature: response.authorSignature,
      content: response.content,
      contentDigestSha256: response.version.contentDigestSha256,
      installedAt: validNow(this.now).toISOString(),
      version: response.version,
    };
    await this.installStore.put(installed);
    return installed;
  }

  public async uninstall(artifactId: string): Promise<void> {
    await this.installStore.remove(artifactId);
  }

  public publish(
    request: CloudMarketplaceSubmissionRequest,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    this.requireRemoteCapability();
    return this.client.submitVersion(request, {
      idempotencyKey: this.idempotencyKeyFactory(),
    });
  }

  public report(
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceReportRequest,
  ): Promise<CloudMarketplaceReportResponse> {
    this.requireRemoteCapability();
    return this.client.reportVersion(artifactId, versionId, request, {
      idempotencyKey: this.idempotencyKeyFactory(),
    });
  }

  public withdraw(
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceWithdrawalRequest,
  ): Promise<CloudMarketplaceSubmissionResponse> {
    this.requireRemoteCapability();
    return this.client.withdrawVersion(artifactId, versionId, request, {
      idempotencyKey: this.idempotencyKeyFactory(),
    });
  }

  public appeal(
    artifactId: string,
    versionId: string,
    request: CloudMarketplaceAppealRequest,
  ): Promise<CloudMarketplaceAppealResponse> {
    this.requireRemoteCapability();
    return this.client.appealVersion(artifactId, versionId, request, {
      idempotencyKey: this.idempotencyKeyFactory(),
    });
  }

  public availableKinds(): readonly CloudMarketplaceArtifactKind[] {
    return Object.freeze(["story_template", "style_template", "world_template"]);
  }

  private requireRemoteCapability(): void {
    if (!this.featureEnabled) {
      throw new MarketplaceRuntimeError(
        "MARKETPLACE_DISABLED",
        "The community marketplace is disabled. Installed local artifacts remain available.",
      );
    }
    if (!this.isOnline()) {
      throw new MarketplaceRuntimeError(
        "MARKETPLACE_OFFLINE",
        "The community marketplace is offline. Installed local artifacts remain available.",
      );
    }
  }
}

export class MarketplaceRuntimeError extends Error {
  public constructor(
    public readonly code: "MARKETPLACE_DISABLED" | "MARKETPLACE_OFFLINE" | "MARKETPLACE_UNTRUSTED",
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceRuntimeError";
  }
}

export class InMemoryMarketplaceInstallStore implements MarketplaceInstallStore {
  private readonly artifacts = new Map<string, InstalledMarketplaceArtifact>();

  public async list(): Promise<readonly InstalledMarketplaceArtifact[]> {
    const artifacts = [...this.artifacts.values()].map(cloneInstalled);
    await Promise.all(artifacts.map((artifact) => verifyInstalledMarketplaceArtifact(artifact)));
    return artifacts.sort((left, right) => left.artifact.title.localeCompare(right.artifact.title));
  }

  public async put(artifact: InstalledMarketplaceArtifact): Promise<void> {
    await verifyInstalledMarketplaceArtifact(artifact);
    this.artifacts.set(artifact.artifact.artifactId, cloneInstalled(artifact));
  }

  public remove(artifactId: string): Promise<void> {
    this.artifacts.delete(artifactId);
    return Promise.resolve();
  }
}

export class BrowserMarketplaceInstallStore implements MarketplaceInstallStore {
  public constructor(
    private readonly storage: Pick<Storage, "getItem" | "removeItem" | "setItem">,
  ) {}

  public async list(): Promise<readonly InstalledMarketplaceArtifact[]> {
    const serialized = this.storage.getItem(LOCAL_STORAGE_KEY);
    if (serialized === null) {
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw invalidLocalInstall();
    }
    if (!Array.isArray(value)) {
      throw invalidLocalInstall();
    }
    const installed: InstalledMarketplaceArtifact[] = [];
    for (const candidate of value) {
      const parsed = parseInstalled(candidate);
      if (parsed === null) {
        throw invalidLocalInstall();
      }
      await verifyInstalledMarketplaceArtifact(parsed);
      installed.push(parsed);
    }
    return installed.sort((left, right) => left.artifact.title.localeCompare(right.artifact.title));
  }

  public async put(artifact: InstalledMarketplaceArtifact): Promise<void> {
    await verifyInstalledMarketplaceArtifact(artifact);
    const current = await this.list();
    const next = current.filter(
      (candidate) => candidate.artifact.artifactId !== artifact.artifact.artifactId,
    );
    next.push(cloneInstalled(artifact));
    this.persist(next);
  }

  public async remove(artifactId: string): Promise<void> {
    const current = await this.list();
    this.persist(current.filter((candidate) => candidate.artifact.artifactId !== artifactId));
  }

  private persist(artifacts: readonly InstalledMarketplaceArtifact[]): void {
    if (artifacts.length === 0) {
      this.storage.removeItem(LOCAL_STORAGE_KEY);
      return;
    }
    this.storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(artifacts));
  }
}

export class SqliteMarketplaceInstallStore implements MarketplaceInstallStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async list(): Promise<readonly InstalledMarketplaceArtifact[]> {
    const rows = await this.executor.select<{ readonly payloadJson: string }>(
      `SELECT payload_json AS payloadJson
       FROM community_marketplace_installs
       ORDER BY installed_at DESC, artifact_id`,
    );
    const installed: InstalledMarketplaceArtifact[] = [];
    for (const row of rows) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(row.payloadJson) as unknown;
      } catch {
        throw invalidLocalInstall();
      }
      const parsed = parseInstalled(decoded);
      if (parsed === null) {
        throw invalidLocalInstall();
      }
      await verifyInstalledMarketplaceArtifact(parsed);
      installed.push(parsed);
    }
    return installed.sort((left, right) => left.artifact.title.localeCompare(right.artifact.title));
  }

  public async put(artifact: InstalledMarketplaceArtifact): Promise<void> {
    const parsed = parseInstalled(artifact);
    if (parsed === null || artifact.contentDigestSha256 !== artifact.version.contentDigestSha256) {
      throw invalidLocalInstall();
    }
    await verifyInstalledMarketplaceArtifact(parsed);
    const payloadJson = JSON.stringify(parsed);
    const result = await this.executor.execute(
      `INSERT INTO community_marketplace_installs (
         artifact_id,
         version_id,
         content_digest_sha256,
         installed_at,
         payload_json
       ) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(artifact_id) DO UPDATE SET
         version_id = excluded.version_id,
         content_digest_sha256 = excluded.content_digest_sha256,
         installed_at = excluded.installed_at,
         payload_json = excluded.payload_json`,
      [
        parsed.artifact.artifactId,
        parsed.version.versionId,
        parsed.contentDigestSha256,
        parsed.installedAt,
        payloadJson,
      ],
    );
    if (result.rowsAffected !== 1) {
      throw new Error("The local marketplace install was not persisted.");
    }
  }

  public async remove(artifactId: string): Promise<void> {
    await this.executor.execute(
      `DELETE FROM community_marketplace_installs
       WHERE artifact_id = ?1`,
      [artifactId],
    );
  }
}

export async function verifyMarketplaceDownload(
  response: CloudMarketplaceDownloadResponse,
): Promise<void> {
  const parsed = CloudMarketplaceDownloadResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw untrusted("Downloaded marketplace artifact violated its contract.");
  }
  const signaturePayload = new TextEncoder().encode(
    canonicalMarketplaceJson(
      marketplaceSubmissionSignaturePayload({
        artifactId: response.artifact.artifactId,
        authorAccountId: response.artifact.authorAccountId,
        authorDisplayName: response.artifact.authorDisplayName,
        content: response.content,
        kind: response.artifact.kind,
        license: response.artifact.license,
        semanticVersion: response.version.semanticVersion,
        summary: response.artifact.summary,
        tags: response.artifact.tags,
        title: response.artifact.title,
        versionId: response.version.versionId,
        versionNumber: response.version.versionNumber,
      }),
    ),
  );
  const publicKeyBytes = decodeBase64Url(response.authorPublicKeySpki);
  const signatureBytes = decodeBase64Url(response.authorSignature);
  try {
    const digest = await sha256Hex(signaturePayload);
    const fingerprint = await sha256Hex(publicKeyBytes);
    if (
      digest !== response.version.contentDigestSha256 ||
      fingerprint !== response.version.authorSigningKeyFingerprintSha256
    ) {
      throw untrusted("Downloaded marketplace digest or signing-key fingerprint did not match.");
    }
    const publicKey = await globalThis.crypto.subtle.importKey(
      "spki",
      toArrayBuffer(publicKeyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    if (
      signatureBytes.length !== 64 ||
      !(await globalThis.crypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        toArrayBuffer(signatureBytes),
        toArrayBuffer(signaturePayload),
      ))
    ) {
      throw untrusted("Downloaded marketplace author signature did not verify.");
    }
  } catch (error: unknown) {
    if (error instanceof MarketplaceRuntimeError) {
      throw error;
    }
    throw untrusted("Downloaded marketplace author signature could not be verified.");
  } finally {
    signaturePayload.fill(0);
    publicKeyBytes.fill(0);
    signatureBytes.fill(0);
  }
}

async function verifyInstalledMarketplaceArtifact(
  artifact: InstalledMarketplaceArtifact,
): Promise<void> {
  if (artifact.contentDigestSha256 !== artifact.version.contentDigestSha256) {
    throw invalidLocalInstall();
  }
  try {
    await verifyMarketplaceDownload({
      schemaVersion: 1,
      requestId: "0198b444-0000-7000-8000-000000000001",
      downloadAuditId: "0198b444-0000-7000-8000-000000000002",
      retentionUntil: "2099-01-01T00:00:00.000Z",
      artifact: artifact.artifact,
      version: artifact.version,
      content: artifact.content,
      authorPublicKeySpki: artifact.authorPublicKeySpki,
      authorSignature: artifact.authorSignature,
    });
  } catch {
    throw invalidLocalInstall();
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  try {
    return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  } finally {
    digest.fill(0);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw untrusted("Downloaded marketplace signature used invalid encoding.");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = globalThis.atob(`${normalized}${padding}`);
  } catch {
    throw untrusted("Downloaded marketplace signature used invalid encoding.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const canonical = globalThis
    .btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (canonical !== value) {
    bytes.fill(0);
    throw untrusted("Downloaded marketplace signature encoding was not canonical.");
  }
  return bytes;
}

function parseInstalled(value: unknown): InstalledMarketplaceArtifact | null {
  if (typeof value !== "object" || value === null || !("installedAt" in value)) {
    return null;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const installedAt = record.installedAt;
  if (
    typeof installedAt !== "string" ||
    !Number.isFinite(Date.parse(installedAt)) ||
    new Date(installedAt).toISOString() !== installedAt
  ) {
    return null;
  }
  const response = CloudMarketplaceDownloadResponseSchema.safeParse({
    schemaVersion: 1,
    requestId: "0198b444-0000-7000-8000-000000000001",
    downloadAuditId: "0198b444-0000-7000-8000-000000000002",
    retentionUntil: "2099-01-01T00:00:00.000Z",
    artifact: record.artifact,
    version: record.version,
    content: record.content,
    authorPublicKeySpki: record.authorPublicKeySpki,
    authorSignature: record.authorSignature,
  });
  if (!response.success) {
    return null;
  }
  return {
    artifact: response.data.artifact,
    authorPublicKeySpki: response.data.authorPublicKeySpki,
    authorSignature: response.data.authorSignature,
    content: response.data.content,
    contentDigestSha256: response.data.version.contentDigestSha256,
    installedAt,
    version: response.data.version,
  };
}

function cloneInstalled(value: InstalledMarketplaceArtifact): InstalledMarketplaceArtifact {
  return structuredClone(value);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.slice(0, 500);
  }
  return "The marketplace could not be loaded.";
}

function validNow(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Marketplace runtime clock returned an invalid timestamp.");
  }
  return new Date(value);
}

function untrusted(message: string): MarketplaceRuntimeError {
  return new MarketplaceRuntimeError("MARKETPLACE_UNTRUSTED", message);
}

function invalidLocalInstall(): Error {
  return new Error(
    "A local marketplace install failed integrity validation. The stored copy was preserved.",
  );
}
