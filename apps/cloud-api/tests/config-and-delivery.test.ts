import { describe, expect, it, vi } from "vitest";

import { loadCloudApiConfiguration } from "../src/config.js";
import { HttpChallengeNotifier } from "../src/delivery/http-challenge-notifier.js";
import { HttpTeamInvitationNotifier } from "../src/delivery/http-team-invitation-notifier.js";
import { Aes256GcmTeamInvitationTokenProtector } from "../src/security/team-invitation-token-protector.js";
import { UnavailableTeamInvitationTokenProtector } from "../src/service/team-service.js";

describe("cloud deployment boundaries", () => {
  it("requires explicit secrets, TLS and loopback-only insecure overrides", () => {
    expect(() => loadCloudApiConfiguration({})).toThrow("INKSHADOW_CLOUD_DATABASE_URL is required");
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_ALLOW_INSECURE_LOCAL_HTTP: "true",
        INKSHADOW_CLOUD_HOST: "0.0.0.0",
      }),
    ).toThrow("loopback");
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_CHALLENGE_DELIVERY_URL: "http://mailer.example.test/deliver",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_CHALLENGE_HASH_KEY: secret(0x91),
      }),
    ).toThrow("independently generated");
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_COMMUNITY_MARKETPLACE_ENABLED: "true",
      }),
    ).toThrow("INKSHADOW_MARKETPLACE_CURSOR_KEY is required");
    expect(
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_COMMUNITY_MARKETPLACE_ENABLED: "true",
        INKSHADOW_MARKETPLACE_CURSOR_KEY: secret(0x96),
      }).marketplace,
    ).toEqual({
      cursorKey: Buffer.alloc(32, 0x96),
      enabled: true,
    });
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_COMMUNITY_MARKETPLACE_ENABLED: "true",
        INKSHADOW_MARKETPLACE_CURSOR_KEY: secret(0x95),
      }),
    ).toThrow("independently generated");

    const configuration = loadCloudApiConfiguration(validEnvironment());
    expect(configuration.appEnvironment).toBe("development");
    expect(configuration.databaseMigrationRole).toBe("inkshadow_test");
    expect(configuration.databaseRuntimeRole).toBe("inkshadow_test");
    expect(configuration.databaseRolesSeparated).toBe(false);
    expect(configuration.requireHttps).toBe(false);
    expect(configuration.requireDatabaseTls).toBe(false);
    expect(configuration.sessionTokenKey).toHaveLength(32);
    expect(configuration.marketplace).toEqual({
      cursorKey: null,
      enabled: false,
    });
    expect(configuration.teamInvitationDelivery).toBeNull();
    expect(configuration.deletion).toMatchObject({
      backupRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      gracePeriodMs: 30 * 24 * 60 * 60 * 1_000,
      intervalMs: 30_000,
      workerId: null,
    });
    expect(
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_CLOUD_DELETION_BACKUP_RETENTION_DAYS: "0",
        INKSHADOW_CLOUD_DELETION_GRACE_DAYS: "45",
        INKSHADOW_CLOUD_DELETION_WORKER_ID: "deletion-worker:blue",
      }).deletion,
    ).toMatchObject({
      backupRetentionMs: 0,
      gracePeriodMs: 45 * 24 * 60 * 60 * 1_000,
      workerId: "deletion-worker:blue",
    });
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_CLOUD_DELETION_GRACE_DAYS: "0",
      }),
    ).toThrow("INKSHADOW_CLOUD_DELETION_GRACE_DAYS");
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_TEAM_INVITATION_DELIVERY_URL: "https://mailer.example.test/team-invitations",
      }),
    ).toThrow("must be configured together");
    const rotatingConfiguration = loadCloudApiConfiguration({
      ...validEnvironment(),
      INKSHADOW_TEAM_INVITATION_DELIVERY_TOKEN: "i".repeat(32),
      INKSHADOW_TEAM_INVITATION_DELIVERY_URL: "https://mailer.example.test/team-invitations",
      INKSHADOW_TEAM_INVITATION_OUTBOX_KEY: secret(0xb6),
      INKSHADOW_TEAM_INVITATION_OUTBOX_KEY_ID: "team-invitations-v1",
      INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON: JSON.stringify([
        { key: secret(0xb7), keyId: "team-invitations-v0" },
      ]),
    }).teamInvitationDelivery;
    expect(rotatingConfiguration).toEqual({
      encryptionKeyId: "team-invitations-v1",
      encryptionKeys: {
        "team-invitations-v0": Buffer.alloc(32, 0xb7),
        "team-invitations-v1": Buffer.alloc(32, 0xb6),
      },
      endpoint: "https://mailer.example.test/team-invitations",
      token: "i".repeat(32),
    });
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_TEAM_INVITATION_DELIVERY_TOKEN: "i".repeat(32),
        INKSHADOW_TEAM_INVITATION_DELIVERY_URL: "https://mailer.example.test/team-invitations",
        INKSHADOW_TEAM_INVITATION_OUTBOX_KEY: secret(0xb6),
        INKSHADOW_TEAM_INVITATION_OUTBOX_KEY_ID: "team-invitations-v1",
        INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON: JSON.stringify([
          { key: secret(0xb7), keyId: "team-invitations-v1" },
        ]),
      }),
    ).toThrow("duplicated");
    expect(() =>
      loadCloudApiConfiguration({
        ...validEnvironment(),
        INKSHADOW_TEAM_INVITATION_DELIVERY_TOKEN: "i".repeat(32),
        INKSHADOW_TEAM_INVITATION_DELIVERY_URL: "https://mailer.example.test/team-invitations",
        INKSHADOW_TEAM_INVITATION_OUTBOX_KEY: secret(0xb6),
        INKSHADOW_TEAM_INVITATION_OUTBOX_KEY_ID: "team-invitations-v1",
        INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON: JSON.stringify(
          [0xb7, 0xb8, 0xb9, 0xba].map((byte, index) => ({
            key: secret(byte),
            keyId: `team-invitations-v${String(index - 3)}`,
          })),
        ),
      }),
    ).toThrow("at most 3");
  });

  it("decrypts pending invitations with bounded previous keys while encrypting with primary", () => {
    const configuration = loadCloudApiConfiguration({
      ...validEnvironment(),
      INKSHADOW_TEAM_INVITATION_DELIVERY_TOKEN: "i".repeat(32),
      INKSHADOW_TEAM_INVITATION_DELIVERY_URL: "https://mailer.example.test/team-invitations",
      INKSHADOW_TEAM_INVITATION_OUTBOX_KEY: secret(0xb6),
      INKSHADOW_TEAM_INVITATION_OUTBOX_KEY_ID: "team-invitations-v1",
      INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON: JSON.stringify([
        { key: secret(0xb7), keyId: "team-invitations-v0" },
      ]),
    }).teamInvitationDelivery;
    if (configuration === null) {
      throw new Error("The rotating team-invitation configuration was not loaded.");
    }
    const context = {
      deliveryId: "018f0d7a-3b2c-7abc-8def-000000000001",
      invitationId: "018f0d7a-3b2c-7abc-8def-000000000001",
      teamId: "018f0d7a-3b2c-7abc-8def-000000000002",
      tenantId: "018f0d7a-3b2c-7abc-8def-000000000003",
    };
    const previousProtector = new Aes256GcmTeamInvitationTokenProtector({
      keys: { "team-invitations-v0": Buffer.alloc(32, 0xb7) },
      primaryKeyId: "team-invitations-v0",
    });
    const rotatingProtector = new Aes256GcmTeamInvitationTokenProtector({
      keys: configuration.encryptionKeys,
      primaryKeyId: configuration.encryptionKeyId,
    });
    const previousToken = previousProtector.protect("P".repeat(43), context);
    expect(rotatingProtector.unprotect(previousToken, context)).toBe("P".repeat(43));
    expect(rotatingProtector.protect("N".repeat(43), context).encryptionKeyId).toBe(
      "team-invitations-v1",
    );
  });

  it("does not read or retain the migration URL in production runtime configuration", () => {
    const configuration = loadCloudApiConfiguration({
      ...validEnvironment(),
      INKSHADOW_ALLOW_INSECURE_LOCAL_DATABASE: "false",
      INKSHADOW_ALLOW_INSECURE_LOCAL_HTTP: "false",
      INKSHADOW_APP_ENV: "production",
      INKSHADOW_CLOUD_DATABASE_URL:
        "postgresql://inkshadow_runtime@db.example.test/inkshadow_cloud?sslmode=verify-full",
      INKSHADOW_CLOUD_MIGRATION_DATABASE_ROLE: "inkshadow_migration",
      INKSHADOW_CLOUD_MIGRATION_DATABASE_URL: "this value must remain unread",
      INKSHADOW_CLOUD_RUNTIME_DATABASE_ROLE: "inkshadow_runtime",
    });
    expect(configuration.databaseRuntimeRole).toBe("inkshadow_runtime");
    expect(configuration).not.toHaveProperty("databaseMigrationUrl");
  });

  it("delivers one-time codes only to a credential-free HTTPS endpoint", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const notifier = new HttpChallengeNotifier({
      endpoint: "https://mailer.example.test/v1/deliver",
      fetchImplementation,
      token: "t".repeat(32),
    });
    await notifier.deliver({
      challengeId: "018f0d7a-3b2c-7abc-8def-000000000001",
      code: "123456",
      email: "writer@example.test",
      expiresAt: "2026-07-27T13:15:00.000Z",
      kind: "registration",
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const call = fetchImplementation.mock.calls[0];
    expect(call?.[0]).toBe("https://mailer.example.test/v1/deliver");
    expect(call?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    expect(call?.[1]?.headers).toMatchObject({
      "Idempotency-Key": "018f0d7a-3b2c-7abc-8def-000000000001",
      "X-Delivery-Id": "018f0d7a-3b2c-7abc-8def-000000000001",
    });
    const body = call?.[1]?.body;
    expect(typeof body).toBe("string");
    expect(typeof body === "string" ? body : "").toContain("123456");
    expect(
      () =>
        new HttpChallengeNotifier({
          endpoint: "https://user:password@mailer.example.test/deliver",
          token: "t".repeat(32),
        }),
    ).toThrow("credential-free");
  });

  it("delivers invitation material only through the dedicated delivery adapter", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const notifier = new HttpTeamInvitationNotifier({
      endpoint: "https://mailer.example.test/v1/team-invitations",
      fetchImplementation,
      token: "i".repeat(32),
    });
    await notifier.deliver({
      deliveryId: "018f0d7a-3b2c-7abc-8def-000000000001",
      expiresAt: "2026-07-29T13:15:00.000Z",
      invitationId: "018f0d7a-3b2c-7abc-8def-000000000001",
      invitationToken: "T".repeat(43),
      inviteeEmail: "reviewer@example.test",
      role: "reviewer",
      teamDisplayName: "InkShadow Studio",
      teamId: "018f0d7a-3b2c-7abc-8def-000000000002",
    });

    const call = fetchImplementation.mock.calls[0];
    expect(call?.[0]).toBe("https://mailer.example.test/v1/team-invitations");
    expect(call?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    expect(call?.[1]?.headers).toMatchObject({
      "Idempotency-Key": "018f0d7a-3b2c-7abc-8def-000000000001",
      "X-Delivery-Id": "018f0d7a-3b2c-7abc-8def-000000000001",
    });
    const body = call?.[1]?.body;
    expect(typeof body === "string" ? body : "").toContain("T".repeat(43));
    expect(() =>
      new UnavailableTeamInvitationTokenProtector().protect("T".repeat(43), {
        deliveryId: "018f0d7a-3b2c-7abc-8def-000000000001",
        invitationId: "018f0d7a-3b2c-7abc-8def-000000000001",
        teamId: "018f0d7a-3b2c-7abc-8def-000000000002",
        tenantId: "018f0d7a-3b2c-7abc-8def-000000000003",
      }),
    ).toThrow();
  });
});

function validEnvironment(): Readonly<Record<string, string>> {
  return {
    INKSHADOW_ALLOW_INSECURE_LOCAL_DATABASE: "true",
    INKSHADOW_ALLOW_INSECURE_LOCAL_HTTP: "true",
    INKSHADOW_CHALLENGE_CODE_KEY: secret(0x91),
    INKSHADOW_CHALLENGE_DELIVERY_TOKEN: "d".repeat(32),
    INKSHADOW_CHALLENGE_DELIVERY_URL: "https://mailer.example.test/deliver",
    INKSHADOW_CHALLENGE_HASH_KEY: secret(0x92),
    INKSHADOW_CLOUD_DATABASE_URL: "postgresql://inkshadow_test@127.0.0.1:55439/inkshadow_test",
    INKSHADOW_PAGE_CURSOR_KEY: secret(0x93),
    INKSHADOW_SESSION_TOKEN_KEY: secret(0x94),
    INKSHADOW_SYNC_CURSOR_KEY: secret(0x95),
  };
}

function secret(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}
