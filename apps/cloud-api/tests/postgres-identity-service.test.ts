import { createECDH, createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CloudDeviceListResponseSchema,
  CloudIdentityChallengeResponseSchema,
  CloudMutationAcceptedResponseSchema,
  CloudSessionGrantResponseSchema,
  CloudSessionListResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudDeviceRegistrationInput,
} from "@inkshadow/contracts";
import type { Pool } from "pg";

import { PostgresCloudIdentityStore } from "../src/postgres/identity-store.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { ScryptPasswordHasher } from "../src/security/passwords.js";
import { CloudTokenService } from "../src/security/tokens.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import {
  CloudIdentityService,
  type IdentityChallengeDelivery,
  type IdentityChallengeNotifier,
} from "../src/service/identity-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

class CapturingNotifier implements IdentityChallengeNotifier {
  public readonly deliveries: IdentityChallengeDelivery[] = [];

  public deliver(delivery: IdentityChallengeDelivery): Promise<void> {
    this.deliveries.push(delivery);
    return Promise.resolve();
  }

  public codeFor(challengeId: string): string {
    const delivery = this.deliveries.find((candidate) => candidate.challengeId === challengeId);
    if (delivery === undefined) {
      throw new Error("The requested challenge was not delivered.");
    }
    return delivery.code;
  }
}

describePostgres("PostgreSQL cloud identity, sessions and devices", () => {
  let pool: Pool;
  let service: CloudIdentityService;
  let notifier: CapturingNotifier;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  const now = new Date("2026-07-27T11:00:00.000Z");

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      connectionString: databaseUrl,
      applicationName: "inkshadow-cloud-identity-test",
      maximumConnections: 4,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    notifier = new CapturingNotifier();
    const tokenService = new CloudTokenService({
      challengeCodeKey: Buffer.alloc(32, 0x61),
      challengeHashKey: Buffer.alloc(32, 0x62),
      sessionTokenKey: Buffer.alloc(32, 0x63),
    });
    service = new CloudIdentityService({
      clock: () => now,
      minimumClientVersion: "0.1.0",
      notifier,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0x64)),
      passwordHasher: new ScryptPasswordHasher({
        cost: 1_024,
        maximumMemoryBytes: 16 * 1024 * 1024,
      }),
      store: new PostgresCloudIdentityStore(pool),
      tokenService,
      uuid,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("completes enumeration-safe registration, session rotation, lockout, reset and revocation", async () => {
    const suffix = randomBytes(8).toString("hex");
    const email = `identity-${suffix}@example.test`;
    const firstPassword = "first-password-phrase";
    const nextPassword = "next-password-phrase";
    const firstDevice = createDevice(uuid(), "Primary workstation");
    const registrationContext = mutationContext(uuid(), `register-${suffix}-00000001`);
    const registration = await service.registerIdentity(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
        password: firstPassword,
      },
      registrationContext,
    );
    expect(CloudIdentityChallengeResponseSchema.safeParse(registration).success).toBe(true);
    expect(notifier.deliveries).toHaveLength(1);

    const registrationReplay = await service.registerIdentity(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
        password: firstPassword,
      },
      {
        ...registrationContext,
        requestId: uuid(),
      },
    );
    expect(registrationReplay.challengeId).toBe(registration.challengeId);
    expect(notifier.deliveries).toHaveLength(1);
    await expect(
      service.registerIdentity(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          email,
          password: nextPassword,
        },
        {
          ...registrationContext,
          requestId: uuid(),
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.registerIdentity(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          email: `other-${suffix}@example.test`,
          password: firstPassword,
        },
        {
          ...registrationContext,
          requestId: uuid(),
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await expect(
      service.verifyEmail(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          challengeId: registration.challengeId,
          code: "000000",
          device: firstDevice,
        },
        mutationContext(uuid(), `verify-wrong-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const verifyContext = mutationContext(uuid(), `verify-${suffix}-0000000001`);
    const grant = await service.verifyEmail(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        challengeId: registration.challengeId,
        code: notifier.codeFor(registration.challengeId),
        device: firstDevice,
      },
      verifyContext,
    );
    expect(CloudSessionGrantResponseSchema.safeParse(grant).success).toBe(true);
    expect(grant.device.device.deviceId).toBe(firstDevice.deviceId);
    const registrationReplayAfterConsumption = await service.registerIdentity(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
        password: firstPassword,
      },
      {
        ...registrationContext,
        requestId: uuid(),
      },
    );
    expect({
      ...registrationReplayAfterConsumption,
      requestId: registration.requestId,
    }).toEqual(registration);
    await expect(
      service.verifyEmail(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          challengeId: registration.challengeId,
          code: "000000",
          device: firstDevice,
        },
        { ...verifyContext, requestId: uuid() },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const principal = await service.authenticateAccessToken(grant.tokens.accessToken, {
      requestId: uuid(),
    });
    expect(principal.deviceId).toBe(firstDevice.deviceId);

    const sessions = await service.listSessions(principal, null, { requestId: uuid() });
    const devices = await service.listDevices(principal, null, { requestId: uuid() });
    expect(CloudSessionListResponseSchema.safeParse(sessions).success).toBe(true);
    expect(CloudDeviceListResponseSchema.safeParse(devices).success).toBe(true);
    expect(sessions.sessions).toHaveLength(1);
    expect(devices.devices).toHaveLength(1);

    const refreshContext = mutationContext(uuid(), `refresh-${suffix}-00000001`);
    const rotated = await service.refresh(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId: firstDevice.deviceId,
        refreshToken: grant.tokens.refreshToken,
      },
      refreshContext,
    );
    const rotatedReplay = await service.refresh(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId: firstDevice.deviceId,
        refreshToken: grant.tokens.refreshToken,
      },
      { ...refreshContext, requestId: uuid() },
    );
    expect(rotatedReplay.session.sessionId).toBe(rotated.session.sessionId);
    expect(rotatedReplay.tokens).toEqual(rotated.tokens);
    await expect(
      service.refresh(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          deviceId: firstDevice.deviceId,
          refreshToken: "isk_rt_wrong-but-well-formed-refresh-token",
        },
        { ...refreshContext, requestId: uuid() },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    await expect(
      service.refresh(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          deviceId: firstDevice.deviceId,
          refreshToken: grant.tokens.refreshToken,
        },
        mutationContext(uuid(), `refresh-replay-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "AUTH_REFRESH_REPLAYED" });
    await expect(
      service.authenticateAccessToken(rotated.tokens.accessToken, { requestId: uuid() }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_REVOKED" });
    const verifyReplayAfterSessionRevocation = await service.verifyEmail(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        challengeId: registration.challengeId,
        code: notifier.codeFor(registration.challengeId),
        device: firstDevice,
      },
      {
        ...verifyContext,
        requestId: uuid(),
      },
    );
    expect({
      ...verifyReplayAfterSessionRevocation,
      requestId: grant.requestId,
    }).toEqual(grant);
    const refreshReplayAfterSessionRevocation = await service.refresh(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId: firstDevice.deviceId,
        refreshToken: grant.tokens.refreshToken,
      },
      {
        ...refreshContext,
        requestId: uuid(),
      },
    );
    expect({
      ...refreshReplayAfterSessionRevocation,
      requestId: rotated.requestId,
    }).toEqual(rotated);

    const persistedSessionSnapshots = await pool.query<{ response_snapshot: unknown }>(
      `SELECT response_snapshot
       FROM cloud_idempotency_records
       WHERE result_kind = 'session'
         AND result_resource_id = ANY($1::uuid[])
       ORDER BY result_resource_id`,
      [[grant.session.sessionId, rotated.session.sessionId]],
    );
    expect(persistedSessionSnapshots.rows).toHaveLength(2);
    for (const row of persistedSessionSnapshots.rows) {
      const serialized = JSON.stringify(row.response_snapshot);
      expect(hasNestedKey(row.response_snapshot, "accessToken")).toBe(false);
      expect(hasNestedKey(row.response_snapshot, "refreshToken")).toBe(false);
      expect(serialized).not.toContain(grant.tokens.accessToken);
      expect(serialized).not.toContain(grant.tokens.refreshToken);
      expect(serialized).not.toContain(rotated.tokens.accessToken);
      expect(serialized).not.toContain(rotated.tokens.refreshToken);
      expect(row.response_snapshot).toMatchObject({
        snapshotKind: "session_grant_v1",
      });
      expect(
        typeof (row.response_snapshot as { readonly tokenGeneration?: unknown }).tokenGeneration,
      ).toBe("number");
    }

    const loginContext = mutationContext(uuid(), `login-${suffix}-00000000001`);
    const login = await service.login(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
        password: firstPassword,
        device: firstDevice,
      },
      loginContext,
    );
    const loginReplay = await service.login(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
        password: firstPassword,
        device: firstDevice,
      },
      { ...loginContext, requestId: uuid() },
    );
    expect(loginReplay.session.sessionId).toBe(login.session.sessionId);
    expect(loginReplay.tokens).toEqual(login.tokens);
    await expect(
      service.login(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          email,
          password: "test-definitely-wrong-password",
          device: firstDevice,
        },
        { ...loginContext, requestId: uuid() },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.login(
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            email,
            password: "test-definitely-wrong-password",
            device: firstDevice,
          },
          mutationContext(uuid(), `bad-login-${suffix}-${String(attempt).padStart(4, "0")}`),
        ),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
    }
    await expect(
      service.login(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          email,
          password: firstPassword,
          device: firstDevice,
        },
        mutationContext(uuid(), `locked-login-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_LOCKED" });

    const deliveryCountBeforeUnknownReset = notifier.deliveries.length;
    const unknownReset = await service.requestPasswordReset(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: `missing-${suffix}@example.test`,
      },
      mutationContext(uuid(), `missing-reset-${suffix}`),
    );
    expect(CloudIdentityChallengeResponseSchema.safeParse(unknownReset).success).toBe(true);
    expect(notifier.deliveries).toHaveLength(deliveryCountBeforeUnknownReset);

    const reset = await service.requestPasswordReset(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
      },
      mutationContext(uuid(), `reset-${suffix}-0000000001`),
    );
    expect(notifier.deliveries).toHaveLength(deliveryCountBeforeUnknownReset + 1);
    const resetConfirmationContext = mutationContext(uuid(), `reset-confirm-${suffix}-00000001`);
    const resetRequest = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      challengeId: reset.challengeId,
      code: notifier.codeFor(reset.challengeId),
      newPassword: nextPassword,
    } as const;
    const resetAccepted = await service.confirmPasswordReset(
      resetRequest,
      resetConfirmationContext,
    );
    const resetReplay = await service.confirmPasswordReset(resetRequest, {
      ...resetConfirmationContext,
      requestId: uuid(),
    });
    expect(CloudMutationAcceptedResponseSchema.safeParse(resetReplay).success).toBe(true);
    expect({
      ...resetReplay,
      requestId: resetAccepted.requestId,
    }).toEqual(resetAccepted);
    const passwordResetSnapshot = await pool.query<{ response_snapshot: unknown }>(
      `SELECT response_snapshot
       FROM cloud_idempotency_records
       WHERE operation_id = 'identity.confirmPasswordReset'
         AND result_resource_id = $1`,
      [grant.account.accountId],
    );
    expect(passwordResetSnapshot.rows).toEqual([{ response_snapshot: resetAccepted }]);
    await expect(
      service.confirmPasswordReset(
        {
          ...resetRequest,
          newPassword: firstPassword,
        },
        {
          ...resetConfirmationContext,
          requestId: uuid(),
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.confirmPasswordReset(
        {
          ...resetRequest,
          code: "000000",
        },
        {
          ...resetConfirmationContext,
          requestId: uuid(),
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(CloudMutationAcceptedResponseSchema.safeParse(resetAccepted).success).toBe(true);
    await expect(
      service.authenticateAccessToken(login.tokens.accessToken, { requestId: uuid() }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_REVOKED" });
    await expect(
      service.login(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          email,
          password: firstPassword,
          device: firstDevice,
        },
        mutationContext(uuid(), `old-password-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });

    const secondDevice = createDevice(uuid(), "Replacement workstation");
    const replacementLogin = await service.login(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email,
        password: nextPassword,
        device: secondDevice,
      },
      mutationContext(uuid(), `new-password-${suffix}`),
    );
    const replacementPrincipal = await service.authenticateAccessToken(
      replacementLogin.tokens.accessToken,
      { requestId: uuid() },
    );
    const enrolledDevice = createDevice(uuid(), "Idempotency replay device");
    const registerDeviceContext = mutationContext(uuid(), `register-device-${suffix}-00000001`);
    const registeredDevice = await service.registerDevice(
      replacementPrincipal,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        device: enrolledDevice,
      },
      registerDeviceContext,
    );
    const revokedEnrolledDevice = await service.revokeDevice(
      replacementPrincipal,
      enrolledDevice.deviceId,
      mutationContext(uuid(), `revoke-enrolled-device-${suffix}`),
    );
    expect(revokedEnrolledDevice.device.device.state).toBe("revoked");
    const registrationReplayAfterDeviceRevocation = await service.registerDevice(
      replacementPrincipal,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        device: enrolledDevice,
      },
      {
        ...registerDeviceContext,
        requestId: uuid(),
      },
    );
    expect({
      ...registrationReplayAfterDeviceRevocation,
      requestId: registeredDevice.requestId,
    }).toEqual(registeredDevice);
    expect(registrationReplayAfterDeviceRevocation.device.device.state).toBe("trusted");
    const revokedDevice = await service.revokeDevice(
      replacementPrincipal,
      firstDevice.deviceId,
      mutationContext(uuid(), `revoke-device-${suffix}`),
    );
    expect(revokedDevice.device.device.state).toBe("revoked");
    await expect(
      service.login(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          email,
          password: nextPassword,
          device: firstDevice,
        },
        mutationContext(uuid(), `revoked-device-login-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "AUTH_DEVICE_REVOKED" });

    const logout = await service.logout(
      replacementPrincipal,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        sessionId: replacementPrincipal.sessionId,
      },
      mutationContext(uuid(), `logout-${suffix}-000000001`),
    );
    expect(CloudMutationAcceptedResponseSchema.safeParse(logout).success).toBe(true);
    await expect(
      service.authenticateAccessToken(replacementLogin.tokens.accessToken, {
        requestId: uuid(),
      }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_REVOKED" });
  }, 30_000);
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

function mutationContext(requestId: string, idempotencyKey: string) {
  return { requestId, idempotencyKey };
}

function hasNestedKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasNestedKey(item, key));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    Object.hasOwn(record, key) || Object.values(record).some((item) => hasNestedKey(item, key))
  );
}
