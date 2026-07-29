import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashCloudProjectKeyPublication } from "@inkshadow/contracts";

import {
  ProjectKeySqliteStore,
  type DevicePublicKeyRecord,
  type PendingProjectKeySetup,
} from "../src/project-key-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0008_project_key_lifecycle.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0009_device_identity_names.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0011_cloud_project_key_checkpoints.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0012_cloud_project_key_publications.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const NOW = "2026-07-27T00:00:00.000Z";
const LATER = "2026-07-27T00:01:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const REMOTE_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const REMOTE_ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const IDEMPOTENCY_KEY = "019f9f4a-b3c7-7350-9226-000000000007";
const REBASED_IDEMPOTENCY_KEY = "019f9f4a-b3c7-7350-9226-000000000008";

describe("ProjectKeySqliteStore", () => {
  let executor: NodeSqliteExecutor;
  let store: ProjectKeySqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "加密项目", NOW, NOW],
    );
    store = new ProjectKeySqliteStore(executor);
    expect(await store.saveDevicePublicKey(deviceRecord())).toMatchObject({ ok: true });
  });

  afterEach(async () => {
    await executor.close();
  });

  it("persists an idempotent pending setup and activates it only after confirmation", async () => {
    const pending = setup();
    const first = await store.beginProjectKeySetup(pending);
    const replay = await store.beginProjectKeySetup(pending);
    expect(first).toEqual({ ok: true, value: pending });
    expect(replay).toEqual(first);

    const before = await store.loadProjectKeyBundle(PROJECT_ID, DEVICE_ID);
    expect(before).toMatchObject({
      ok: true,
      value: {
        version: { state: "pending_confirmation", revision: 1 },
        recoveryEnvelope: { confirmedAt: null },
      },
    });

    const confirmed = await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      value: {
        version: { state: "active", revision: 2 },
        recoveryEnvelope: { confirmedAt: LATER },
      },
    });
    expect(
      await store.confirmRecovery({
        projectId: PROJECT_ID,
        keyVersion: 1,
        recoveryId: RECOVERY_ID,
        expectedRevision: 1,
        confirmedAt: LATER,
      }),
    ).toEqual(confirmed);

    expect(await store.health()).toEqual({
      ok: true,
      value: {
        deviceKeysByState: { trusted: 1, revoked: 0, credential_missing: 0 },
        keyVersionsByState: {
          pending_confirmation: 0,
          active: 1,
          retiring: 0,
          retired: 0,
        },
        currentDeviceEnvelopeCount: 1,
        pendingRecoveryEnvelopeCount: 0,
        confirmedRecoveryEnvelopeCount: 1,
      },
    });
  });

  it("rejects key substitution and keeps immutable device identity metadata", async () => {
    const substituted = {
      ...deviceRecord(),
      publicKey: "B".repeat(87),
      updatedAt: LATER,
    };
    const result = await store.saveDevicePublicKey(substituted);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await store.findDevicePublicKey(DEVICE_ID)).toEqual({
      ok: true,
      value: deviceRecord(),
    });
  });

  it("atomically removes only an unchanged unconfirmed setup", async () => {
    expect(await store.beginProjectKeySetup(setup())).toMatchObject({ ok: true });

    expect(
      await store.abandonPendingProjectKeySetup({
        projectId: PROJECT_ID,
        keyVersion: 1,
        expectedRevision: 1,
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(await store.loadProjectKeyBundle(PROJECT_ID, DEVICE_ID)).toEqual({
      ok: true,
      value: null,
    });
    expect(await store.health()).toMatchObject({
      ok: true,
      value: {
        keyVersionsByState: {
          pending_confirmation: 0,
          active: 0,
          retiring: 0,
          retired: 0,
        },
        currentDeviceEnvelopeCount: 0,
        pendingRecoveryEnvelopeCount: 0,
      },
    });
  });

  it("atomically promotes a confirmed rotation and retires its predecessor", async () => {
    expect(await store.beginProjectKeySetup(setup())).toMatchObject({ ok: true });
    expect(
      await store.confirmRecovery({
        projectId: PROJECT_ID,
        keyVersion: 1,
        recoveryId: RECOVERY_ID,
        expectedRevision: 1,
        confirmedAt: LATER,
      }),
    ).toMatchObject({ ok: true });

    const second = setup({
      keyVersion: 2,
      envelopeId: "019f9f4a-b3c7-7350-9226-000000000005",
      recoveryId: "019f9f4a-b3c7-7350-9226-000000000006",
    });
    expect(
      await store.beginProjectKeyRotation({
        expectedCurrentKeyVersion: 1,
        version: second.version,
        deviceEnvelopes: [second.deviceEnvelope],
        recoveryEnvelope: second.recoveryEnvelope,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.confirmRecovery({
        projectId: PROJECT_ID,
        keyVersion: 2,
        recoveryId: second.recoveryEnvelope.recoveryId,
        expectedRevision: 1,
        confirmedAt: LATER,
      }),
    ).toMatchObject({ ok: true, value: { version: { state: "active" } } });

    const rows = await executor.select<{
      key_version: number;
      state: string;
      revision: number;
      status: string;
      confirmed_at: string | null;
    }>(
      `SELECT v.key_version, v.state, v.revision, r.status, r.confirmed_at
       FROM project_key_versions v
       JOIN project_recovery_key_envelopes r
         ON r.project_id = v.project_id AND r.key_version = v.key_version
       WHERE v.project_id = ?
       ORDER BY v.key_version`,
      [PROJECT_ID],
    );
    expect(rows).toEqual([
      {
        key_version: 1,
        state: "retiring",
        revision: 3,
        status: "confirmed",
        confirmed_at: LATER,
      },
      {
        key_version: 2,
        state: "active",
        revision: 2,
        status: "confirmed",
        confirmed_at: LATER,
      },
    ]);
  });

  it("keeps the predecessor active until a staged cloud rotation commits atomically", async () => {
    const first = setup();
    await store.beginProjectKeySetup(first);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    await store.saveCloudProjectKeySet({
      keySet: {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publication: receipt(1, 1),
        version: { ...first.version, state: "active", revision: 2 },
        recoveryEnvelope: { ...first.recoveryEnvelope, confirmedAt: LATER },
        deviceEnvelopes: [first.deviceEnvelope],
        updatedAt: LATER,
      },
      makeCurrent: true,
    });
    const second = setup({
      keyVersion: 2,
      envelopeId: "019f9f4a-b3c7-7350-9226-000000000005",
      recoveryId: "019f9f4a-b3c7-7350-9226-000000000006",
    });
    await store.beginProjectKeyRotation({
      expectedCurrentKeyVersion: 1,
      version: second.version,
      deviceEnvelopes: [second.deviceEnvelope],
      recoveryEnvelope: second.recoveryEnvelope,
    });
    const publicationConfirmedAt = "2026-07-27T00:02:00.000Z";
    expect(
      await store.confirmRecoveryForPublication({
        projectId: PROJECT_ID,
        keyVersion: 2,
        recoveryId: second.recoveryEnvelope.recoveryId,
        expectedRevision: 1,
        confirmedAt: publicationConfirmedAt,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        version: { keyVersion: 2, state: "pending_confirmation", revision: 1 },
        recoveryEnvelope: { confirmedAt: publicationConfirmedAt },
      },
    });
    expect(
      await store.abandonPendingProjectKeySetup({
        projectId: PROJECT_ID,
        keyVersion: 2,
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(
      await executor.select<{ key_version: number; state: string; revision: number }>(
        `SELECT key_version, state, revision
         FROM project_key_versions
         WHERE project_id = ?
         ORDER BY key_version`,
        [PROJECT_ID],
      ),
    ).toEqual([
      { key_version: 1, state: "active", revision: 2 },
      { key_version: 2, state: "pending_confirmation", revision: 1 },
    ]);

    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: 1,
      version: { ...second.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: {
        ...second.recoveryEnvelope,
        confirmedAt: publicationConfirmedAt,
      },
      deviceEnvelopes: [second.deviceEnvelope],
    };
    await store.beginCloudProjectKeyPublication({
      projectId: PROJECT_ID,
      keyVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
      request,
      createdAt: publicationConfirmedAt,
    });
    expect(
      await store.saveCloudProjectKeySet({
        keySet: {
          schemaVersion: 1,
          projectId: PROJECT_ID,
          keyVersion: 2,
          serverRevision: 2,
          publication: receipt(
            2,
            2,
            publicationConfirmedAt,
            await hashCloudProjectKeyPublication(PROJECT_ID, 2, request),
          ),
          version: request.version,
          recoveryEnvelope: request.recoveryEnvelope,
          deviceEnvelopes: request.deviceEnvelopes,
          updatedAt: publicationConfirmedAt,
        },
        makeCurrent: true,
        completedPublicationIdempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).toMatchObject({ ok: true, value: { currentKeyVersion: 2, serverRevision: 2 } });
    expect(
      await executor.select<{ key_version: number; state: string; revision: number }>(
        `SELECT key_version, state, revision
         FROM project_key_versions
         WHERE project_id = ?
         ORDER BY key_version`,
        [PROJECT_ID],
      ),
    ).toEqual([
      { key_version: 1, state: "retiring", revision: 3 },
      { key_version: 2, state: "active", revision: 2 },
    ]);
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 2)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("persists a monotonic cloud publication checkpoint and exact key set", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const keySet = {
      schemaVersion: 1 as const,
      projectId: PROJECT_ID,
      keyVersion: 1,
      serverRevision: 1,
      publication: receipt(1, 1),
      version: { ...pending.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: {
        ...pending.recoveryEnvelope,
        confirmedAt: LATER,
      },
      deviceEnvelopes: [pending.deviceEnvelope],
      updatedAt: LATER,
    };

    expect(await store.saveCloudProjectKeySet({ keySet, makeCurrent: true })).toEqual({
      ok: true,
      value: {
        projectId: PROJECT_ID,
        currentKeyVersion: 1,
        serverRevision: 1,
        updatedAt: LATER,
      },
    });
    expect(await store.loadCloudProjectKeyCheckpoint(PROJECT_ID)).toEqual({
      ok: true,
      value: {
        projectId: PROJECT_ID,
        currentKeyVersion: 1,
        serverRevision: 1,
        updatedAt: LATER,
      },
    });
    expect(
      await store.saveCloudProjectKeySet({
        keySet: {
          ...keySet,
          serverRevision: 0,
        },
        makeCurrent: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(
      await store.saveCloudProjectKeySet({
        keySet: {
          ...keySet,
          serverRevision: 2,
          publication: receipt(1, 2),
        },
        makeCurrent: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(
      await store.saveCloudProjectKeySet({
        keySet: {
          ...keySet,
          serverRevision: 2,
          publication: receipt(1, 2),
          version: {
            ...keySet.version,
            state: "retiring",
            revision: 3,
          },
        },
        makeCurrent: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("lists every current device envelope for one exact project-key version", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    await store.saveDevicePublicKey(
      deviceRecord({
        deviceId: REMOTE_DEVICE_ID,
        publicKey: "H".repeat(87),
        publicKeyFingerprint: "b".repeat(64),
      }),
    );
    const remoteEnvelope = {
      ...pending.deviceEnvelope,
      envelopeId: REMOTE_ENVELOPE_ID,
      recipientDeviceId: REMOTE_DEVICE_ID,
      recipientPublicKey: "H".repeat(87),
      recipientPublicKeyFingerprint: "b".repeat(64),
    };
    expect(await store.saveDeviceEnvelope(remoteEnvelope)).toEqual({
      ok: true,
      value: undefined,
    });

    expect(await store.listDeviceEnvelopes(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: [pending.deviceEnvelope, remoteEnvelope],
    });
    expect(await store.listDeviceEnvelopes(PROJECT_ID, 2)).toEqual({
      ok: true,
      value: [],
    });
  });

  it("reconciles historical cloud envelopes after their sender or recipient is revoked", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    await store.saveDevicePublicKey(
      deviceRecord({
        deviceId: REMOTE_DEVICE_ID,
        publicKey: "H".repeat(87),
        publicKeyFingerprint: "b".repeat(64),
      }),
    );
    await store.saveDevicePublicKey({
      ...deviceRecord(),
      state: "revoked",
      updatedAt: LATER,
      revokedAt: LATER,
    });
    const remoteEnvelope = {
      ...pending.deviceEnvelope,
      envelopeId: REMOTE_ENVELOPE_ID,
      recipientDeviceId: REMOTE_DEVICE_ID,
      recipientPublicKey: "H".repeat(87),
      recipientPublicKeyFingerprint: "b".repeat(64),
    };

    expect(
      await store.saveCloudProjectKeySet({
        keySet: {
          schemaVersion: 1,
          projectId: PROJECT_ID,
          keyVersion: 1,
          serverRevision: 1,
          publication: receipt(1, 1),
          version: { ...pending.version, state: "active", revision: 2 },
          recoveryEnvelope: { ...pending.recoveryEnvelope, confirmedAt: LATER },
          deviceEnvelopes: [{ ...pending.deviceEnvelope, revokedAt: LATER }, remoteEnvelope],
          updatedAt: LATER,
        },
        makeCurrent: false,
      }),
    ).toEqual({ ok: true, value: null });
    expect(await store.listDeviceEnvelopes(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: [remoteEnvelope],
    });
    expect(
      await executor.select<{ recipient_device_id: string; revoked_at: string | null }>(
        `SELECT recipient_device_id, revoked_at
         FROM project_device_key_envelopes
         WHERE project_id = ?
         ORDER BY recipient_device_id`,
        [PROJECT_ID],
      ),
    ).toEqual([
      { recipient_device_id: DEVICE_ID, revoked_at: LATER },
      { recipient_device_id: REMOTE_DEVICE_ID, revoked_at: null },
    ]);
  });

  it("does not let a non-current active cloud response replace the local active key", async () => {
    const first = setup();
    await store.beginProjectKeySetup(first);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const second = setup({
      keyVersion: 2,
      envelopeId: "019f9f4a-b3c7-7350-9226-000000000008",
      recoveryId: "019f9f4a-b3c7-7350-9226-000000000009",
    });

    expect(
      await store.saveCloudProjectKeySet({
        keySet: {
          schemaVersion: 1,
          projectId: PROJECT_ID,
          keyVersion: 2,
          serverRevision: 2,
          publication: receipt(2, 2),
          version: { ...second.version, state: "active", revision: 2 },
          recoveryEnvelope: {
            ...second.recoveryEnvelope,
            confirmedAt: LATER,
          },
          deviceEnvelopes: [second.deviceEnvelope],
          updatedAt: LATER,
        },
        makeCurrent: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(
      await executor.select<{ key_version: number; state: string; revision: number }>(
        `SELECT key_version, state, revision
         FROM project_key_versions
         WHERE project_id = ?
         ORDER BY key_version`,
        [PROJECT_ID],
      ),
    ).toEqual([{ key_version: 1, state: "active", revision: 2 }]);
  });

  it("keeps a crash-safe exact publication until the matching cloud response commits", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: null,
      version: { ...pending.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: { ...pending.recoveryEnvelope, confirmedAt: LATER },
      deviceEnvelopes: [pending.deviceEnvelope],
    };
    const publication = {
      projectId: PROJECT_ID,
      keyVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      request,
      createdAt: LATER,
    };

    const first = await store.beginCloudProjectKeyPublication(publication);
    expect(await store.beginCloudProjectKeyPublication(publication)).toEqual(first);
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toEqual(first);

    const keySet = {
      schemaVersion: 1 as const,
      projectId: PROJECT_ID,
      keyVersion: 1,
      serverRevision: 1,
      publication: receipt(
        1,
        1,
        LATER,
        await hashCloudProjectKeyPublication(PROJECT_ID, 1, request),
      ),
      version: request.version,
      recoveryEnvelope: request.recoveryEnvelope,
      deviceEnvelopes: request.deviceEnvelopes,
      updatedAt: LATER,
    };
    expect(
      await store.saveCloudProjectKeySet({
        keySet,
        makeCurrent: true,
        completedPublicationIdempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).toMatchObject({ ok: true, value: { serverRevision: 1 } });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("resolves a publication journal from only its immutable receipt and stored request", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: null,
      version: { ...pending.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: { ...pending.recoveryEnvelope, confirmedAt: LATER },
      deviceEnvelopes: [pending.deviceEnvelope],
    };
    await store.beginCloudProjectKeyPublication({
      projectId: PROJECT_ID,
      keyVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      request,
      createdAt: NOW,
    });
    const publicationReceipt = receipt(
      1,
      1,
      LATER,
      await hashCloudProjectKeyPublication(PROJECT_ID, 1, request),
    );

    expect(
      await store.resolveCloudProjectKeyPublication({
        projectId: PROJECT_ID,
        keyVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        receipt: publicationReceipt,
      }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publication: publicationReceipt,
        version: request.version,
        recoveryEnvelope: request.recoveryEnvelope,
        deviceEnvelopes: request.deviceEnvelopes,
        updatedAt: LATER,
      },
    });
    expect(await store.loadCloudProjectKeyCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { currentKeyVersion: 1, serverRevision: 1 },
    });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("does not resolve a publication journal from another request digest", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: null,
      version: { ...pending.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: { ...pending.recoveryEnvelope, confirmedAt: LATER },
      deviceEnvelopes: [pending.deviceEnvelope],
    };
    await store.beginCloudProjectKeyPublication({
      projectId: PROJECT_ID,
      keyVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      request,
      createdAt: NOW,
    });

    expect(
      await store.resolveCloudProjectKeyPublication({
        projectId: PROJECT_ID,
        keyVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        receipt: receipt(1, 1, LATER, "f".repeat(64)),
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toMatchObject({
      ok: true,
      value: { state: "pending", idempotencyKey: IDEMPOTENCY_KEY },
    });
    expect(await store.loadCloudProjectKeyCheckpoint(PROJECT_ID)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("clears a confirmed journal without rewriting an already committed checkpoint", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: null,
      version: { ...pending.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: { ...pending.recoveryEnvelope, confirmedAt: LATER },
      deviceEnvelopes: [pending.deviceEnvelope],
    };
    const publicationReceipt = receipt(
      1,
      1,
      LATER,
      await hashCloudProjectKeyPublication(PROJECT_ID, 1, request),
    );
    await store.beginCloudProjectKeyPublication({
      projectId: PROJECT_ID,
      keyVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      request,
      createdAt: NOW,
    });
    await store.saveCloudProjectKeySet({
      keySet: {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publication: publicationReceipt,
        version: request.version,
        recoveryEnvelope: request.recoveryEnvelope,
        deviceEnvelopes: [{ ...pending.deviceEnvelope, revokedAt: LATER }],
        updatedAt: LATER,
      },
      makeCurrent: true,
    });

    expect(
      await store.resolveCloudProjectKeyPublication({
        projectId: PROJECT_ID,
        keyVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        receipt: publicationReceipt,
      }),
    ).toMatchObject({
      ok: true,
      value: { deviceEnvelopes: [{ revokedAt: null }] },
    });
    expect(await store.listDeviceEnvelopes(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: [],
    });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("rebases the same encrypted request only against its immutable predecessor receipt", async () => {
    const first = setup();
    await store.beginProjectKeySetup(first);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    await store.saveCloudProjectKeySet({
      keySet: {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publication: receipt(1, 1),
        version: { ...first.version, state: "active", revision: 2 },
        recoveryEnvelope: { ...first.recoveryEnvelope, confirmedAt: LATER },
        deviceEnvelopes: [first.deviceEnvelope],
        updatedAt: LATER,
      },
      makeCurrent: true,
    });
    const second = setup({
      keyVersion: 2,
      envelopeId: "019f9f4a-b3c7-7350-9226-000000000009",
      recoveryId: "019f9f4a-b3c7-7350-9226-00000000000a",
    });
    await store.beginProjectKeyRotation({
      expectedCurrentKeyVersion: 1,
      version: second.version,
      deviceEnvelopes: [second.deviceEnvelope],
      recoveryEnvelope: second.recoveryEnvelope,
    });
    await store.confirmRecoveryForPublication({
      projectId: PROJECT_ID,
      keyVersion: 2,
      recoveryId: second.recoveryEnvelope.recoveryId,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: 1,
      version: { ...second.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: { ...second.recoveryEnvelope, confirmedAt: LATER },
      deviceEnvelopes: [second.deviceEnvelope],
    };
    await store.beginCloudProjectKeyPublication({
      projectId: PROJECT_ID,
      keyVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
      request,
      createdAt: NOW,
    });

    expect(
      await store.rebaseCloudProjectKeyPublication({
        projectId: PROJECT_ID,
        keyVersion: 2,
        idempotencyKey: IDEMPOTENCY_KEY,
        nextIdempotencyKey: REBASED_IDEMPOTENCY_KEY,
        observedCurrentPublication: receipt(1, 1),
        updatedAt: LATER,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        idempotencyKey: REBASED_IDEMPOTENCY_KEY,
        request,
        state: "pending",
        lastErrorCode: null,
      },
    });
    expect(
      await store.rebaseCloudProjectKeyPublication({
        projectId: PROJECT_ID,
        keyVersion: 2,
        idempotencyKey: REBASED_IDEMPOTENCY_KEY,
        nextIdempotencyKey: IDEMPOTENCY_KEY,
        observedCurrentPublication: receipt(2, 2),
        updatedAt: LATER,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 2)).toMatchObject({
      ok: true,
      value: { idempotencyKey: REBASED_IDEMPOTENCY_KEY, request },
    });
  });

  it("atomically rejects a publication that diverges from local ciphertext or checkpoint", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: null,
      version: { ...pending.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: { ...pending.recoveryEnvelope, confirmedAt: LATER },
      deviceEnvelopes: [pending.deviceEnvelope],
    };

    expect(
      await store.beginCloudProjectKeyPublication({
        projectId: PROJECT_ID,
        keyVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        request: {
          ...request,
          deviceEnvelopes: [
            {
              ...pending.deviceEnvelope,
              ciphertext: "Z".repeat(64),
            },
          ],
        },
        createdAt: LATER,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: null,
    });

    await store.saveCloudProjectKeySet({
      keySet: {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publication: receipt(1, 1),
        version: request.version,
        recoveryEnvelope: request.recoveryEnvelope,
        deviceEnvelopes: request.deviceEnvelopes,
        updatedAt: LATER,
      },
      makeCurrent: true,
    });
    expect(
      await store.beginCloudProjectKeyPublication({
        projectId: PROJECT_ID,
        keyVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        request,
        createdAt: LATER,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("parks a conflicting durable publication and rejects a mismatched response", async () => {
    const pending = setup();
    await store.beginProjectKeySetup(pending);
    await store.confirmRecovery({
      projectId: PROJECT_ID,
      keyVersion: 1,
      recoveryId: RECOVERY_ID,
      expectedRevision: 1,
      confirmedAt: LATER,
    });
    const request = {
      schemaVersion: 1 as const,
      expectedServerRevision: null,
      version: { ...pending.version, state: "active" as const, revision: 2 },
      recoveryEnvelope: { ...pending.recoveryEnvelope, confirmedAt: LATER },
      deviceEnvelopes: [pending.deviceEnvelope],
    };
    await store.beginCloudProjectKeyPublication({
      projectId: PROJECT_ID,
      keyVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      request,
      createdAt: NOW,
    });
    expect(
      await store.markCloudProjectKeyPublicationConflicted({
        projectId: PROJECT_ID,
        keyVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        errorCode: "REVISION_CONFLICT",
        updatedAt: LATER,
      }),
    ).toMatchObject({
      ok: true,
      value: { state: "conflicted", lastErrorCode: "REVISION_CONFLICT" },
    });
    expect(
      await store.saveCloudProjectKeySet({
        keySet: {
          schemaVersion: 1,
          projectId: PROJECT_ID,
          keyVersion: 1,
          serverRevision: 2,
          publication: receipt(
            1,
            2,
            LATER,
            await hashCloudProjectKeyPublication(PROJECT_ID, 1, request),
          ),
          version: request.version,
          recoveryEnvelope: request.recoveryEnvelope,
          deviceEnvelopes: request.deviceEnvelopes,
          updatedAt: LATER,
        },
        makeCurrent: true,
        completedPublicationIdempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await store.loadCloudProjectKeyPublication(PROJECT_ID, 1)).toMatchObject({
      ok: true,
      value: { state: "conflicted", lastErrorCode: "REVISION_CONFLICT" },
    });
  });
});

function receipt(
  keyVersion: number,
  serverRevision: number,
  publishedAt = LATER,
  publicationRequestSha256 = "0".repeat(64),
) {
  return {
    projectId: PROJECT_ID,
    keyVersion,
    serverRevision,
    publicationRequestSha256,
    publishedAt,
  };
}

function deviceRecord(
  overrides: Partial<
    Pick<DevicePublicKeyRecord, "deviceId" | "publicKey" | "publicKeyFingerprint">
  > = {},
): DevicePublicKeyRecord {
  return {
    schemaVersion: 1,
    deviceId: overrides.deviceId ?? DEVICE_ID,
    accountId: null,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: overrides.publicKey ?? "A".repeat(87),
    publicKeyFingerprint: overrides.publicKeyFingerprint ?? "a".repeat(64),
    displayName: "本机测试设备",
    keyOrigin: "local_os_credential",
    state: "trusted",
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function setup(
  overrides: {
    readonly keyVersion?: number;
    readonly envelopeId?: string;
    readonly recoveryId?: string;
  } = {},
): PendingProjectKeySetup {
  const keyVersion = overrides.keyVersion ?? 1;
  return {
    version: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      keyVersion,
      algorithm: "AES-256-GCM",
      state: "pending_confirmation",
      revision: 1,
      createdAt: NOW,
      retiredAt: null,
    },
    deviceEnvelope: {
      schemaVersion: 1,
      algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
      envelopeId: overrides.envelopeId ?? ENVELOPE_ID,
      projectId: PROJECT_ID,
      keyVersion,
      senderDeviceId: DEVICE_ID,
      senderPublicKey: "A".repeat(87),
      senderPublicKeyFingerprint: "a".repeat(64),
      recipientDeviceId: DEVICE_ID,
      recipientPublicKey: "A".repeat(87),
      recipientPublicKeyFingerprint: "a".repeat(64),
      encapsulatedKey: "B".repeat(87),
      ciphertext: "C".repeat(64),
      createdAt: NOW,
      revokedAt: null,
    },
    recoveryEnvelope: {
      schemaVersion: 1,
      algorithm: "ARGON2ID-AES256GCM",
      recoveryId: overrides.recoveryId ?? RECOVERY_ID,
      projectId: PROJECT_ID,
      keyVersion,
      kdf: {
        algorithm: "ARGON2ID",
        version: 19,
        memoryKib: 65_536,
        timeCost: 3,
        parallelism: 4,
        outputBytes: 64,
      },
      salt: "D".repeat(22),
      nonce: "E".repeat(16),
      ciphertext: "F".repeat(64),
      verifier: "G".repeat(43),
      createdAt: NOW,
      confirmedAt: null,
      revokedAt: null,
    },
  };
}
