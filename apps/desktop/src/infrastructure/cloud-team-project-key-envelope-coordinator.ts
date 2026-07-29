import { isCloudClientError } from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  CloudTeamProjectKeyEligibleRecipientListResponseSchema,
  CloudTeamProjectKeyEnvelopePublishRequestSchema,
  CloudTeamProjectKeyEnvelopeResponseSchema,
  UuidV7Schema,
  type CloudTeamProjectKeyEligibleRecipient,
  type CloudTeamProjectKeyEligibleRecipientListResponse,
  type CloudTeamProjectKeyEnvelope,
  type CloudTeamProjectKeyEnvelopePublishRequest,
  type CloudTeamProjectKeyEnvelopeResponse,
} from "@inkshadow/contracts";
import { AppError, type UuidV7Generator } from "@inkshadow/domain";

import type { ConfiguredCloudSessionStatus } from "./cloud-session-coordinator";
import type {
  ProjectKeyEnvelopeDeviceIdentity,
  ProjectKeyLifecycleService,
  TeamProjectKeyEnvelopeRecipientTarget,
  VerifiedTeamProjectKeyEnvelope,
} from "./project-key-lifecycle";

const CONFLICT_CODES = new Set([
  "ACCESS_FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "REVISION_CONFLICT",
  "VALIDATION_FAILED",
]);

export interface CloudTeamProjectKeyEnvelopeApi {
  listEligibleTeamProjectKeyRecipients(
    teamId: string,
    projectId: string,
    keyVersion: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CloudTeamProjectKeyEligibleRecipientListResponse>;
  publishTeamProjectKeyEnvelope(
    teamId: string,
    projectId: string,
    keyVersion: number,
    request: CloudTeamProjectKeyEnvelopePublishRequest,
    options: { readonly idempotencyKey: string; readonly signal?: AbortSignal },
  ): Promise<CloudTeamProjectKeyEnvelopeResponse>;
}

export interface CloudTeamProjectKeyEnvelopeSessionPort {
  runWithSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Value>;
}

export type CloudTeamProjectKeyEnvelopeLifecyclePort = Pick<
  ProjectKeyLifecycleService,
  "createTeamProjectKeyEnvelopesForActiveKey" | "verifyTeamProjectKeyEnvelopeForCurrentDevice"
>;

export interface CloudTeamProjectKeyEnvelopeOperationOptions {
  readonly signal?: AbortSignal;
}

export type CloudTeamProjectKeyRecipientPublicationStatus =
  "conflicted" | "pending" | "published" | "publishing" | "sealed";

export type CloudTeamProjectKeyPublicationPhase =
  "conflicted" | "partial" | "preparing" | "published" | "publishing" | "retryable";

export interface CloudTeamProjectKeyRecipientPublicationState {
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly envelopeId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly recipientDeviceId: string;
  readonly status: CloudTeamProjectKeyRecipientPublicationStatus;
}

export interface CloudTeamProjectKeyPublicationState {
  readonly teamId: string;
  readonly projectId: string;
  readonly keyVersion: number;
  readonly senderDeviceId: string;
  readonly phase: CloudTeamProjectKeyPublicationPhase;
  readonly recipientCount: number;
  readonly publishedCount: number;
  readonly recipients: readonly CloudTeamProjectKeyRecipientPublicationState[];
}

export interface CloudTeamProjectKeyEnvelopePort {
  publishAllEligibleRecipients(
    teamId: string,
    projectId: string,
    keyVersion: number,
    options?: CloudTeamProjectKeyEnvelopeOperationOptions,
  ): Promise<CloudTeamProjectKeyPublicationState>;
  publishEligibleRecipient(
    teamId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
    options?: CloudTeamProjectKeyEnvelopeOperationOptions,
  ): Promise<CloudTeamProjectKeyPublicationState>;
  verifyCurrentDeviceEnvelope(
    teamId: string,
    projectId: string,
    options?: CloudTeamProjectKeyEnvelopeOperationOptions,
  ): Promise<VerifiedTeamProjectKeyEnvelope>;
  getPublicationState(
    teamId: string,
    projectId: string,
    keyVersion: number,
  ): CloudTeamProjectKeyPublicationState | null;
}

interface FrozenSenderAuthority extends ProjectKeyEnvelopeDeviceIdentity {
  readonly accountId: string;
}

interface CachedRecipientPublication {
  readonly cacheKey: string;
  readonly envelopeId: string;
  readonly idempotencyKey: string;
  readonly recipient: CloudTeamProjectKeyEligibleRecipient;
  request: CloudTeamProjectKeyEnvelopePublishRequest | null;
  status: CloudTeamProjectKeyRecipientPublicationStatus;
}

type RecipientSelection =
  Readonly<{ kind: "all" }> | Readonly<{ kind: "device"; recipientDeviceId: string }>;

/**
 * Coordinates one-recipient cloud mutations around an exact recipient
 * snapshot. Plaintext project keys and device private keys remain behind the
 * ProjectKeyLifecycleService/native-vault boundary.
 *
 * Stable ciphertext and idempotency keys are retained for the lifetime of
 * this coordinator, allowing a failed batch or a session-refresh replay to
 * resume each recipient without creating a second envelope.
 */
export class CloudTeamProjectKeyEnvelopeCoordinator implements CloudTeamProjectKeyEnvelopePort {
  private readonly publications = new Map<string, CachedRecipientPublication>();
  private readonly latestState = new Map<string, CloudTeamProjectKeyPublicationState>();
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly api: CloudTeamProjectKeyEnvelopeApi,
    private readonly session: CloudTeamProjectKeyEnvelopeSessionPort,
    private readonly lifecycle: CloudTeamProjectKeyEnvelopeLifecyclePort,
    private readonly ids: UuidV7Generator,
  ) {}

  public publishAllEligibleRecipients(
    teamId: string,
    projectId: string,
    keyVersion: number,
    options: CloudTeamProjectKeyEnvelopeOperationOptions = {},
  ): Promise<CloudTeamProjectKeyPublicationState> {
    return this.enqueue(() =>
      this.publishRecipients(teamId, projectId, keyVersion, { kind: "all" }, options),
    );
  }

  public publishEligibleRecipient(
    teamId: string,
    projectId: string,
    keyVersion: number,
    recipientDeviceId: string,
    options: CloudTeamProjectKeyEnvelopeOperationOptions = {},
  ): Promise<CloudTeamProjectKeyPublicationState> {
    return this.enqueue(() =>
      this.publishRecipients(
        teamId,
        projectId,
        keyVersion,
        { kind: "device", recipientDeviceId },
        options,
      ),
    );
  }

  public async verifyCurrentDeviceEnvelope(
    teamId: string,
    projectId: string,
    options: CloudTeamProjectKeyEnvelopeOperationOptions = {},
  ): Promise<VerifiedTeamProjectKeyEnvelope> {
    throwIfAborted(options.signal);
    return this.session.runWithSession(async (current) => {
      const authority = freezeSenderAuthority(current);
      const verification = await this.lifecycle.verifyTeamProjectKeyEnvelopeForCurrentDevice(
        {
          teamId,
          projectId,
          expectedSessionId: current.session.sessionId,
          expectedAccountId: current.account.accountId,
        },
        authority,
      );
      if (
        verification.receipt.teamId !== teamId ||
        verification.receipt.projectId !== projectId ||
        verification.receipt.deviceId !== authority.deviceId ||
        verification.receipt.recipientPublicKeyFingerprint !== authority.publicKeyFingerprint
      ) {
        throw protocolError(
          "The native current-device team project-key verification crossed its authenticated scope.",
        );
      }
      throwIfAborted(options.signal);
      return verification;
    }, options);
  }

  public getPublicationState(
    teamId: string,
    projectId: string,
    keyVersion: number,
  ): CloudTeamProjectKeyPublicationState | null {
    return this.latestState.get(scopeKey(teamId, projectId, keyVersion)) ?? null;
  }

  private async publishRecipients(
    teamId: string,
    projectId: string,
    keyVersion: number,
    selection: RecipientSelection,
    options: CloudTeamProjectKeyEnvelopeOperationOptions,
  ): Promise<CloudTeamProjectKeyPublicationState> {
    throwIfAborted(options.signal);
    const discovered = await this.session.runWithSession(async (current) => {
      const authority = freezeSenderAuthority(current);
      const response = await this.api.listEligibleTeamProjectKeyRecipients(
        teamId,
        projectId,
        keyVersion,
        signalOptions(options.signal),
      );
      return {
        authority,
        recipients: parseRecipientSnapshot(response, teamId, projectId, keyVersion),
      };
    }, options);
    const recipients = selectRecipients(discovered.recipients, selection);
    const scope = scopeKey(teamId, projectId, keyVersion);
    if (recipients.length === 0) {
      const state = freezeState({
        teamId,
        projectId,
        keyVersion,
        senderDeviceId: discovered.authority.deviceId,
        phase: "published",
        recipientCount: 0,
        publishedCount: 0,
        recipients: [],
      });
      this.latestState.set(scope, state);
      return state;
    }

    const entries = recipients.map((recipient) =>
      this.loadOrCreatePublication(teamId, projectId, keyVersion, discovered.authority, recipient),
    );
    this.updateState(scope, teamId, projectId, keyVersion, discovered.authority, entries);
    const conflicted = entries.find(({ status }) => status === "conflicted");
    if (conflicted !== undefined) {
      throw stateError(
        "A team project-key publication is conflicted and cannot be replaced with new ciphertext.",
      );
    }

    const unsealed = entries.filter(({ request }) => request === null);
    if (unsealed.length > 0) {
      await this.assertSenderAuthority(discovered.authority, options);
      const targets: readonly TeamProjectKeyEnvelopeRecipientTarget[] = unsealed.map((entry) => ({
        envelopeId: entry.envelopeId,
        membershipId: entry.recipient.membershipId,
        membershipRevision: entry.recipient.membershipRevision,
        assignmentId: entry.recipient.assignmentId,
        assignmentRevision: entry.recipient.assignmentRevision,
        deviceId: entry.recipient.deviceId,
        algorithm: entry.recipient.algorithm,
        publicKey: entry.recipient.publicKey,
        publicKeyFingerprint: entry.recipient.publicKeyFingerprint,
      }));
      const cryptograms = await this.lifecycle.createTeamProjectKeyEnvelopesForActiveKey(
        teamId,
        projectId,
        keyVersion,
        discovered.authority,
        targets,
      );
      const requests = buildPublishRequests(
        teamId,
        projectId,
        keyVersion,
        discovered.authority,
        unsealed,
        cryptograms,
      );
      await this.assertSenderAuthority(discovered.authority, options);
      for (const [index, entry] of unsealed.entries()) {
        entry.request = requests[index] ?? null;
        entry.status = "sealed";
      }
    }

    this.updateState(
      scope,
      teamId,
      projectId,
      keyVersion,
      discovered.authority,
      entries,
      "publishing",
    );
    for (const entry of entries) {
      if (entry.status === "published") {
        continue;
      }
      if (entry.request === null) {
        throw protocolError("A native team project-key envelope was not prepared.");
      }
      const request = entry.request;
      entry.status = "publishing";
      this.updateState(
        scope,
        teamId,
        projectId,
        keyVersion,
        discovered.authority,
        entries,
        "publishing",
      );
      try {
        const response = await this.session.runWithSession((current) => {
          requireSenderAuthority(current, discovered.authority);
          return this.api.publishTeamProjectKeyEnvelope(teamId, projectId, keyVersion, request, {
            idempotencyKey: entry.idempotencyKey,
            ...signalOptions(options.signal),
          });
        }, options);
        assertPublishedEnvelopeEcho(response, request);
        entry.status = "published";
      } catch (cause: unknown) {
        entry.status =
          isCloudClientError(cause) && CONFLICT_CODES.has(cause.code) ? "conflicted" : "sealed";
        this.updateState(scope, teamId, projectId, keyVersion, discovered.authority, entries);
        throw cause;
      }
    }
    return this.updateState(scope, teamId, projectId, keyVersion, discovered.authority, entries);
  }

  private loadOrCreatePublication(
    teamId: string,
    projectId: string,
    keyVersion: number,
    authority: FrozenSenderAuthority,
    recipient: CloudTeamProjectKeyEligibleRecipient,
  ): CachedRecipientPublication {
    const cacheKey = recipientCacheKey(teamId, projectId, keyVersion, authority, recipient);
    const existing = this.publications.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }
    const publication: CachedRecipientPublication = {
      cacheKey,
      envelopeId: this.ids.next(),
      idempotencyKey: this.ids.next(),
      recipient,
      request: null,
      status: "pending",
    };
    this.publications.set(cacheKey, publication);
    return publication;
  }

  private assertSenderAuthority(
    authority: FrozenSenderAuthority,
    options: CloudTeamProjectKeyEnvelopeOperationOptions,
  ): Promise<void> {
    return this.session.runWithSession((current) => {
      requireSenderAuthority(current, authority);
      return Promise.resolve();
    }, options);
  }

  private updateState(
    scope: string,
    teamId: string,
    projectId: string,
    keyVersion: number,
    authority: FrozenSenderAuthority,
    entries: readonly CachedRecipientPublication[],
    phaseOverride?: CloudTeamProjectKeyPublicationPhase,
  ): CloudTeamProjectKeyPublicationState {
    const publishedCount = entries.filter(({ status }) => status === "published").length;
    const phase =
      phaseOverride ??
      (entries.some(({ status }) => status === "conflicted")
        ? "conflicted"
        : publishedCount === entries.length
          ? "published"
          : publishedCount > 0
            ? "partial"
            : entries.some(({ status }) => status === "sealed")
              ? "retryable"
              : entries.some(({ status }) => status === "publishing")
                ? "publishing"
                : "preparing");
    const state = freezeState({
      teamId,
      projectId,
      keyVersion,
      senderDeviceId: authority.deviceId,
      phase,
      recipientCount: entries.length,
      publishedCount,
      recipients: entries.map((entry) => ({
        assignmentId: entry.recipient.assignmentId,
        assignmentRevision: entry.recipient.assignmentRevision,
        envelopeId: entry.envelopeId,
        membershipId: entry.recipient.membershipId,
        membershipRevision: entry.recipient.membershipRevision,
        recipientDeviceId: entry.recipient.deviceId,
        status: entry.status,
      })),
    });
    this.latestState.set(scope, state);
    return state;
  }

  private enqueue<Value>(operation: () => Promise<Value>): Promise<Value> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function parseRecipientSnapshot(
  value: unknown,
  teamId: string,
  projectId: string,
  keyVersion: number,
): readonly CloudTeamProjectKeyEligibleRecipient[] {
  const parsed = CloudTeamProjectKeyEligibleRecipientListResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.teamId !== teamId ||
    parsed.data.projectId !== projectId ||
    parsed.data.keyVersion !== keyVersion
  ) {
    throw protocolError("The eligible team project-key recipient snapshot is invalid.");
  }
  return Object.freeze(
    [...parsed.data.recipients].sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
  );
}

function selectRecipients(
  recipients: readonly CloudTeamProjectKeyEligibleRecipient[],
  selection: RecipientSelection,
): readonly CloudTeamProjectKeyEligibleRecipient[] {
  if (selection.kind === "all") {
    return recipients;
  }
  if (!UuidV7Schema.safeParse(selection.recipientDeviceId).success) {
    throw validationError("The selected team project-key recipient device is invalid.");
  }
  const recipient = recipients.find(({ deviceId }) => deviceId === selection.recipientDeviceId);
  if (recipient === undefined) {
    throw stateError(
      "The selected device is not present in the current eligible-recipient snapshot.",
    );
  }
  return Object.freeze([recipient]);
}

function buildPublishRequests(
  teamId: string,
  projectId: string,
  keyVersion: number,
  authority: FrozenSenderAuthority,
  entries: readonly CachedRecipientPublication[],
  cryptograms: Awaited<
    ReturnType<ProjectKeyLifecycleService["createTeamProjectKeyEnvelopesForActiveKey"]>
  >,
): readonly CloudTeamProjectKeyEnvelopePublishRequest[] {
  if (cryptograms.length !== entries.length) {
    throw protocolError("The native vault returned an incomplete team project-key envelope set.");
  }
  const requests = entries.map((entry, index) => {
    const cryptogram = cryptograms[index];
    if (cryptogram === undefined) {
      throw protocolError("The native vault returned an incomplete team project-key envelope set.");
    }
    const candidate = cryptogram as unknown as Record<string, unknown>;
    if (
      candidate.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
      candidate.envelopeKind !== "team_project_member_device" ||
      candidate.algorithm !== "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM" ||
      cryptogram.envelopeId !== entry.envelopeId ||
      cryptogram.teamId !== teamId ||
      cryptogram.projectId !== projectId ||
      cryptogram.keyVersion !== keyVersion ||
      cryptogram.membershipId !== entry.recipient.membershipId ||
      cryptogram.membershipRevision !== entry.recipient.membershipRevision ||
      cryptogram.assignmentId !== entry.recipient.assignmentId ||
      cryptogram.assignmentRevision !== entry.recipient.assignmentRevision ||
      cryptogram.senderDeviceId !== authority.deviceId ||
      cryptogram.senderPublicKey !== authority.publicKey ||
      cryptogram.senderPublicKeyFingerprint !== authority.publicKeyFingerprint ||
      cryptogram.recipientDeviceId !== entry.recipient.deviceId ||
      cryptogram.recipientPublicKey !== entry.recipient.publicKey ||
      cryptogram.recipientPublicKeyFingerprint !== entry.recipient.publicKeyFingerprint
    ) {
      throw protocolError("The native vault returned ciphertext for another recipient snapshot.");
    }
    const request = CloudTeamProjectKeyEnvelopePublishRequestSchema.safeParse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      envelopeKind: "team_project_member_device",
      envelopeId: cryptogram.envelopeId,
      teamId,
      projectId,
      keyVersion,
      membershipId: entry.recipient.membershipId,
      membershipRevision: entry.recipient.membershipRevision,
      assignmentId: entry.recipient.assignmentId,
      assignmentRevision: entry.recipient.assignmentRevision,
      algorithm: cryptogram.algorithm,
      senderDeviceId: cryptogram.senderDeviceId,
      senderPublicKey: cryptogram.senderPublicKey,
      senderPublicKeyFingerprint: cryptogram.senderPublicKeyFingerprint,
      recipientDeviceId: cryptogram.recipientDeviceId,
      recipientPublicKey: cryptogram.recipientPublicKey,
      recipientPublicKeyFingerprint: cryptogram.recipientPublicKeyFingerprint,
      encapsulatedKey: cryptogram.encapsulatedKey,
      ciphertext: cryptogram.ciphertext,
    });
    if (!request.success) {
      throw protocolError("The native vault returned an invalid team project-key envelope.");
    }
    return request.data;
  });
  return Object.freeze(requests);
}

function assertPublishedEnvelopeEcho(
  value: unknown,
  request: CloudTeamProjectKeyEnvelopePublishRequest,
): void {
  const parsed = CloudTeamProjectKeyEnvelopeResponseSchema.safeParse(value);
  if (!parsed.success || !samePublishedEnvelope(parsed.data.envelope, request)) {
    throw protocolError(
      "The published team project-key envelope did not match the exact local ciphertext.",
    );
  }
}

function samePublishedEnvelope(
  envelope: CloudTeamProjectKeyEnvelope,
  request: CloudTeamProjectKeyEnvelopePublishRequest,
): boolean {
  return (
    envelope.envelopeId === request.envelopeId &&
    envelope.teamId === request.teamId &&
    envelope.projectId === request.projectId &&
    envelope.keyVersion === request.keyVersion &&
    envelope.membershipId === request.membershipId &&
    envelope.membershipRevision === request.membershipRevision &&
    envelope.assignmentId === request.assignmentId &&
    envelope.assignmentRevision === request.assignmentRevision &&
    envelope.senderDeviceId === request.senderDeviceId &&
    envelope.senderPublicKey === request.senderPublicKey &&
    envelope.senderPublicKeyFingerprint === request.senderPublicKeyFingerprint &&
    envelope.recipientDeviceId === request.recipientDeviceId &&
    envelope.recipientPublicKey === request.recipientPublicKey &&
    envelope.recipientPublicKeyFingerprint === request.recipientPublicKeyFingerprint &&
    envelope.encapsulatedKey === request.encapsulatedKey &&
    envelope.ciphertext === request.ciphertext
  );
}

function freezeSenderAuthority(current: ConfiguredCloudSessionStatus): FrozenSenderAuthority {
  const authority: FrozenSenderAuthority = {
    accountId: current.account.accountId,
    deviceId: current.device.device.deviceId,
    algorithm: current.device.publicKey.algorithm,
    publicKey: current.device.publicKey.publicKey,
    publicKeyFingerprint: current.device.publicKey.publicKeyFingerprint,
  };
  requireSenderAuthority(current, authority);
  return Object.freeze(authority);
}

function requireSenderAuthority(
  current: ConfiguredCloudSessionStatus,
  authority: FrozenSenderAuthority,
): void {
  if (
    current.account.accountId !== authority.accountId ||
    current.device.device.accountId !== authority.accountId ||
    current.device.publicKey.accountId !== authority.accountId ||
    current.device.device.deviceId !== authority.deviceId ||
    current.device.publicKey.deviceId !== authority.deviceId ||
    current.device.device.state !== "trusted" ||
    current.device.device.revokedAt !== null ||
    current.device.publicKey.revokedAt !== null ||
    runtimeString(current.device.publicKey.algorithm) !== authority.algorithm ||
    current.device.publicKey.publicKey !== authority.publicKey ||
    current.device.device.publicKeyFingerprint !== authority.publicKeyFingerprint ||
    current.device.publicKey.publicKeyFingerprint !== authority.publicKeyFingerprint
  ) {
    throw stateError(
      "The active cloud account, device, or public key changed during team envelope publication.",
    );
  }
}

function recipientCacheKey(
  teamId: string,
  projectId: string,
  keyVersion: number,
  authority: FrozenSenderAuthority,
  recipient: CloudTeamProjectKeyEligibleRecipient,
): string {
  return JSON.stringify([
    teamId,
    projectId,
    keyVersion,
    authority.accountId,
    authority.deviceId,
    authority.publicKey,
    authority.publicKeyFingerprint,
    recipient.membershipId,
    recipient.membershipRevision,
    recipient.assignmentId,
    recipient.assignmentRevision,
    recipient.deviceId,
    recipient.publicKey,
    recipient.publicKeyFingerprint,
  ]);
}

function scopeKey(teamId: string, projectId: string, keyVersion: number): string {
  return `${teamId}|${projectId}|${String(keyVersion)}`;
}

function runtimeString(value: string): string {
  return value;
}

function signalOptions(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? {} : { signal };
}

function freezeState(
  state: CloudTeamProjectKeyPublicationState,
): CloudTeamProjectKeyPublicationState {
  return Object.freeze({
    ...state,
    recipients: Object.freeze(state.recipients.map((recipient) => Object.freeze(recipient))),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The team project-key operation was aborted.", "AbortError");
  }
}

function stateError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "OPEN_SETTINGS", "CONTACT_SUPPORT"],
  });
}

function validationError(message: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}

function protocolError(message: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message,
    actions: ["RETRY", "CONTACT_SUPPORT"],
  });
}
