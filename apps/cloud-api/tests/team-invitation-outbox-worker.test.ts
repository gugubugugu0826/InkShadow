import { describe, expect, it, vi } from "vitest";

import type { ClaimedTeamInvitationOutboxRecord } from "../src/domain/team-invitation-outbox-record.js";
import type {
  CancelTeamInvitationOutboxOptions,
  ClaimTeamInvitationOutboxOptions,
  CompleteTeamInvitationOutboxOptions,
  ExecuteTeamInvitationOutboxOptions,
  RetryTeamInvitationOutboxOptions,
  TeamInvitationOutboxExecutionDecision,
  TeamInvitationOutboxExecutionResult,
  TeamInvitationOutboxStore,
} from "../src/repository/team-invitation-outbox-store.js";
import { Aes256GcmTeamInvitationTokenProtector } from "../src/security/team-invitation-token-protector.js";
import {
  TeamInvitationOutboxWorker,
  type TeamInvitationOutboxDelivery,
  type TeamInvitationOutboxDeliveryPort,
} from "../src/service/team-invitation-outbox-worker.js";

const workerId = "018f0d7a-3b2c-7abc-8def-000000000010";
const now = new Date("2026-07-28T01:00:00.000Z");

describe("team invitation outbox worker", () => {
  it("decrypts only inside the execution fence and delivers with a stable idempotency id", async () => {
    const fixture = createFixture();
    const store = new MemoryOutboxStore([fixture.claim]);
    const delivered: TeamInvitationOutboxDelivery[] = [];
    const deliveryMock = vi.fn((value: TeamInvitationOutboxDelivery): Promise<void> => {
      delivered.push(value);
      return Promise.resolve();
    });
    const delivery: TeamInvitationOutboxDeliveryPort = {
      deliver: deliveryMock,
    };
    const worker = createWorker(store, fixture.protector, delivery);

    await expect(worker.runOnce()).resolves.toEqual({
      cancelled: 0,
      claimLost: 0,
      claimed: 1,
      deadLettered: 0,
      delivered: 1,
      retried: 0,
    });
    expect(delivered).toEqual([
      expect.objectContaining({
        deliveryId: fixture.claim.deliveryId,
        invitationId: fixture.claim.invitationId,
        invitationToken: fixture.token,
      }),
    ]);
    expect(store.decisions).toEqual([{ kind: "delivered" }]);
  });

  it("retries transient failures and reuses the same delivery id", async () => {
    const fixture = createFixture();
    const firstStore = new MemoryOutboxStore([fixture.claim]);
    const deliveryIds: string[] = [];
    const deliveryMock = vi.fn((value: TeamInvitationOutboxDelivery): Promise<void> => {
      deliveryIds.push(value.deliveryId);
      return deliveryIds.length === 1
        ? Promise.reject(new Error("provider details must not be persisted"))
        : Promise.resolve();
    });
    const delivery: TeamInvitationOutboxDeliveryPort = {
      deliver: deliveryMock,
    };
    const firstWorker = createWorker(firstStore, fixture.protector, delivery);

    await expect(firstWorker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      retried: 1,
    });
    expect(firstStore.decisions[0]).toEqual({
      availableAt: new Date("2026-07-28T01:00:30.000Z"),
      deadLetter: false,
      errorCode: "DELIVERY_FAILED",
      kind: "retry",
    });

    const secondStore = new MemoryOutboxStore([{ ...fixture.claim, attemptCount: 2, revision: 3 }]);
    const secondWorker = createWorker(secondStore, fixture.protector, delivery);
    await expect(secondWorker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    expect(deliveryIds).toEqual([fixture.claim.deliveryId, fixture.claim.deliveryId]);
  });

  it("revalidates after claim and cancels instead of sending after deletion wins the race", async () => {
    const fixture = createFixture();
    const store = new MemoryOutboxStore([fixture.claim]);
    store.beforeFence = (record) => ({
      ...record,
      invitationState: "revoked",
      inviteeEmail: "deleted-018f0d7a-3b2c-7abc-8def-000000000099@deleted.invalid",
    });
    const deliveryMock = vi.fn(() => Promise.resolve());
    const delivery: TeamInvitationOutboxDeliveryPort = {
      deliver: deliveryMock,
    };
    const worker = createWorker(store, fixture.protector, delivery);

    await expect(worker.runOnce()).resolves.toMatchObject({
      cancelled: 1,
      claimed: 1,
      delivered: 0,
    });
    expect(deliveryMock).not.toHaveBeenCalled();
    expect(store.decisions).toEqual([{ errorCode: "INVITATION_NOT_PENDING", kind: "cancel" }]);
  });

  it("dead-letters ciphertext that cannot be authenticated without calling delivery", async () => {
    const fixture = createFixture();
    const tampered = {
      ...fixture.claim,
      tokenAuthTag: Buffer.from(fixture.claim.tokenAuthTag),
    };
    tampered.tokenAuthTag[0] = (tampered.tokenAuthTag[0] ?? 0) ^ 1;
    const store = new MemoryOutboxStore([tampered]);
    const deliveryMock = vi.fn(() => Promise.resolve());
    const delivery: TeamInvitationOutboxDeliveryPort = {
      deliver: deliveryMock,
    };
    const worker = createWorker(store, fixture.protector, delivery);

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      deadLettered: 1,
      delivered: 0,
    });
    expect(deliveryMock).not.toHaveBeenCalled();
    expect(store.decisions).toEqual([
      {
        availableAt: now,
        deadLetter: true,
        errorCode: "TOKEN_DECRYPTION_FAILED",
        kind: "retry",
      },
    ]);
  });
});

class MemoryOutboxStore implements TeamInvitationOutboxStore {
  public beforeFence:
    ((record: ClaimedTeamInvitationOutboxRecord) => ClaimedTeamInvitationOutboxRecord) | null =
    null;
  public readonly decisions: TeamInvitationOutboxExecutionDecision[] = [];
  private readonly initialClaims: readonly ClaimedTeamInvitationOutboxRecord[];

  public constructor(private claims: readonly ClaimedTeamInvitationOutboxRecord[]) {
    this.initialClaims = [...claims];
  }

  public claim(
    options: ClaimTeamInvitationOutboxOptions,
  ): Promise<readonly ClaimedTeamInvitationOutboxRecord[]> {
    void options;
    const result = this.claims;
    this.claims = [];
    return Promise.resolve(result);
  }

  public async executeWithFence(
    options: ExecuteTeamInvitationOutboxOptions,
  ): Promise<TeamInvitationOutboxExecutionResult> {
    const original = this.lastClaim;
    if (
      original?.deliveryId !== options.deliveryId ||
      original.revision !== options.expectedRevision
    ) {
      return { kind: "claim_lost" };
    }
    const current = this.beforeFence?.(original) ?? original;
    const decision = await options.operation(current);
    this.decisions.push(decision);
    return { decision, kind: "applied" };
  }

  private get lastClaim(): ClaimedTeamInvitationOutboxRecord | null {
    return this.initialClaims[0] ?? null;
  }

  public cancel(options: CancelTeamInvitationOutboxOptions): Promise<boolean> {
    void options;
    return Promise.resolve(false);
  }

  public enqueue(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }

  public markDelivered(options: CompleteTeamInvitationOutboxOptions): Promise<boolean> {
    void options;
    return Promise.resolve(false);
  }

  public retry(options: RetryTeamInvitationOutboxOptions): Promise<boolean> {
    void options;
    return Promise.resolve(false);
  }
}

function createWorker(
  store: TeamInvitationOutboxStore,
  protector: Aes256GcmTeamInvitationTokenProtector,
  delivery: TeamInvitationOutboxDeliveryPort,
): TeamInvitationOutboxWorker {
  return new TeamInvitationOutboxWorker({
    clock: () => now,
    delivery,
    protector,
    store,
    workerId,
  });
}

function createFixture(): {
  readonly claim: ClaimedTeamInvitationOutboxRecord;
  readonly protector: Aes256GcmTeamInvitationTokenProtector;
  readonly token: string;
} {
  const protector = new Aes256GcmTeamInvitationTokenProtector({
    keys: { current: Buffer.alloc(32, 0x94) },
    primaryKeyId: "current",
    randomBytesImplementation: (size) => Buffer.alloc(size, 0x51),
  });
  const token = "T".repeat(43);
  const identity = {
    deliveryId: "018f0d7a-3b2c-7abc-8def-000000000001",
    invitationId: "018f0d7a-3b2c-7abc-8def-000000000001",
    teamId: "018f0d7a-3b2c-7abc-8def-000000000002",
    tenantId: "018f0d7a-3b2c-7abc-8def-000000000003",
  };
  const protectedToken = protector.protect(token, identity);
  return {
    claim: {
      attemptCount: 1,
      availableAt: now,
      createdAt: now,
      deliveredAt: null,
      deliveryId: identity.deliveryId,
      encryptionKeyId: protectedToken.encryptionKeyId,
      invitationExpiresAt: new Date("2026-07-29T01:00:00.000Z"),
      invitationId: identity.invitationId,
      invitationRole: "reviewer",
      invitationState: "pending",
      inviteeEmail: "reviewer@example.test",
      lastErrorCode: null,
      leaseExpiresAt: new Date("2026-07-28T01:00:30.000Z"),
      leaseOwner: workerId,
      revision: 2,
      state: "leased",
      teamDisplayName: "InkShadow Studio",
      teamId: identity.teamId,
      teamState: "active",
      tenantId: identity.tenantId,
      tokenAuthTag: protectedToken.authTag,
      tokenCiphertext: protectedToken.ciphertext,
      tokenNonce: protectedToken.nonce,
      updatedAt: now,
    },
    protector,
    token,
  };
}
