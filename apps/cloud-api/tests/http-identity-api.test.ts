import { createECDH, createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CloudApiErrorResponseSchema,
  CloudDeviceListResponseSchema,
  CloudIdentityChallengeResponseSchema,
  CloudSessionGrantResponseSchema,
  CLOUD_API_OPERATIONS,
  CONTRACT_SCHEMA_VERSION,
  type CloudDeviceRegistrationInput,
} from "@inkshadow/contracts";
import type { Pool } from "pg";

import { createCloudApiServer } from "../src/http/server.js";
import { PostgresCloudIdentityStore } from "../src/postgres/identity-store.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudProjectStore } from "../src/postgres/project-store.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { ScryptPasswordHasher } from "../src/security/passwords.js";
import { SyncCursorCodec } from "../src/security/sync-cursor.js";
import { SyncSnapshotCursorCodec } from "../src/security/sync-snapshot-cursor.js";
import { CloudTokenService } from "../src/security/tokens.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import {
  CloudIdentityService,
  type IdentityChallengeDelivery,
  type IdentityChallengeNotifier,
} from "../src/service/identity-service.js";
import { CloudProjectSyncService } from "../src/service/project-sync-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

class HttpTestNotifier implements IdentityChallengeNotifier {
  public readonly deliveries: IdentityChallengeDelivery[] = [];

  public deliver(delivery: IdentityChallengeDelivery): Promise<void> {
    this.deliveries.push(delivery);
    return Promise.resolve();
  }
}

describePostgres("cloud identity HTTP API", () => {
  let pool: Pool;
  let server: ReturnType<typeof createCloudApiServer>;
  let notifier: HttpTestNotifier;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      connectionString: databaseUrl,
      applicationName: "inkshadow-cloud-http-test",
      maximumConnections: 4,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory();
    notifier = new HttpTestNotifier();
    const identityService = new CloudIdentityService({
      minimumClientVersion: "0.1.0",
      notifier,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0x71)),
      passwordHasher: new ScryptPasswordHasher({
        cost: 1_024,
        maximumMemoryBytes: 16 * 1024 * 1024,
      }),
      store: new PostgresCloudIdentityStore(pool),
      tokenService: new CloudTokenService({
        challengeCodeKey: Buffer.alloc(32, 0x72),
        challengeHashKey: Buffer.alloc(32, 0x73),
        sessionTokenKey: Buffer.alloc(32, 0x74),
      }),
      uuid,
    });
    const projectSyncService = new CloudProjectSyncService({
      cursorCodec: new SyncCursorCodec(Buffer.alloc(32, 0x75)),
      snapshotCursorCodec: new SyncSnapshotCursorCodec(Buffer.alloc(32, 0x76)),
      store: new PostgresCloudProjectStore(pool),
      uuid,
    });
    server = createCloudApiServer({
      identityService,
      projectSyncService,
      requireHttps: false,
      uuid,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("rejects malformed correlation and idempotency headers with stable errors", async () => {
    const invalidRequestId = await server.inject({
      method: "POST",
      url: "/v1/identity/registrations",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "http-invalid-request-0001",
        "x-request-id": "not-a-uuid",
      },
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: "invalid-request-id@example.test",
        password: "test-password-phrase-value",
      },
    });
    const invalidRequestError = CloudApiErrorResponseSchema.parse(invalidRequestId.json());
    expect(invalidRequestId.statusCode).toBe(400);
    expect(invalidRequestError.error.code).toBe("VALIDATION_FAILED");
    expect(invalidRequestId.headers["cache-control"]).toBe("no-store");
    expect(invalidRequestId.headers["x-content-type-options"]).toBe("nosniff");

    const missingIdempotency = await server.inject({
      method: "POST",
      url: "/v1/identity/registrations",
      headers: {
        "content-type": "application/json",
        "x-request-id": uuid(),
      },
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: "missing-idempotency@example.test",
        password: "test-password-phrase-value",
      },
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(CloudApiErrorResponseSchema.parse(missingIdempotency.json()).error.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("registers every operation declared by the public OpenAPI contract", () => {
    for (const operation of CLOUD_API_OPERATIONS) {
      const url = operation.path.replaceAll(/\{([^}]+)\}/gu, (_match, name: string) => `:${name}`);
      expect(
        server.hasRoute({
          method: operation.method.toUpperCase(),
          url,
        }),
        operation.operationId,
      ).toBe(true);
    }
  });

  it("returns the stable error contract for unknown routes", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/v1/unknown",
      headers: { "x-request-id": uuid() },
    });

    expect(response.statusCode).toBe(404);
    expect(CloudApiErrorResponseSchema.parse(response.json()).error.code).toBe(
      "RESOURCE_NOT_FOUND",
    );
  });

  it("serves the registration, verification and authenticated device-list contracts", async () => {
    const suffix = randomBytes(8).toString("hex");
    const email = `http-${suffix}@example.test`;
    const password = "test-http-password-phrase";
    const device = createDevice(uuid(), "HTTP contract device");
    const registrationRequestId = uuid();
    const registration = await server.inject({
      method: "POST",
      url: "/v1/identity/registrations",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `http-register-${suffix}`,
        "x-request-id": registrationRequestId,
      },
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
        password,
      },
    });
    const challenge = CloudIdentityChallengeResponseSchema.parse(registration.json());
    expect(registration.statusCode).toBe(202);
    expect(challenge.requestId).toBe(registrationRequestId);
    expect(registration.headers["x-request-id"]).toBe(registrationRequestId);
    expect(registration.body).not.toContain(password);

    const delivery = notifier.deliveries.find(
      (candidate) => candidate.challengeId === challenge.challengeId,
    );
    expect(delivery).toBeDefined();
    const verification = await server.inject({
      method: "POST",
      url: "/v1/identity/verifications",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `http-verify-${suffix}`,
        "x-request-id": uuid(),
      },
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        challengeId: challenge.challengeId,
        code: delivery?.code,
        device,
      },
    });
    const grant = CloudSessionGrantResponseSchema.parse(verification.json());
    expect(verification.statusCode).toBe(200);

    const deviceList = await server.inject({
      method: "GET",
      url: "/v1/devices",
      headers: {
        authorization: `Bearer ${grant.tokens.accessToken}`,
        "x-request-id": uuid(),
      },
    });
    const devices = CloudDeviceListResponseSchema.parse(deviceList.json());
    expect(deviceList.statusCode).toBe(200);
    expect(devices.devices.map((candidate) => candidate.device.deviceId)).toContain(
      device.deviceId,
    );

    const invalidBearer = await server.inject({
      method: "GET",
      url: "/v1/devices",
      headers: {
        authorization: "Bearer invalid",
        "x-request-id": uuid(),
      },
    });
    expect(invalidBearer.statusCode).toBe(401);
    expect(CloudApiErrorResponseSchema.parse(invalidBearer.json()).error.code).toBe(
      "AUTH_SESSION_EXPIRED",
    );
  });
});

function createDevice(deviceId: string, displayName: string): CloudDeviceRegistrationInput {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(undefined, "uncompressed");
  return {
    deviceId,
    displayName,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: publicKey.toString("base64url"),
    publicKeyFingerprint: createHash("sha256").update(publicKey).digest("hex"),
    clientVersion: "0.1.0",
  };
}
