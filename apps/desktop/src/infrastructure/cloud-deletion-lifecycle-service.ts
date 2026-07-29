import { CloudEmailAddressSchema, type CloudDeletionRequestResponse } from "@inkshadow/contracts";
import {
  CloudDeletionJournalError,
  type CloudDeletionJournal,
  type CloudDeletionMutation,
  type CloudDeletionJournalSqliteStore,
} from "@inkshadow/data/cloud-deletion-journal-sqlite-store";
import { CloudClientError, type InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";
import type { ContentHasher } from "@inkshadow/application";

import type {
  CloudSessionCoordinator,
  ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import type { CloudSessionVaultStatus } from "./cloud-session-vault";

type CloudDeletionApi = Pick<
  InkShadowCloudApiClient,
  | "cancelAccountDeletion"
  | "cancelProjectDeletion"
  | "getProjectDeletionRequest"
  | "getProjectState"
  | "lookupAccountDeletion"
  | "requestAccountDeletion"
  | "requestProjectDeletion"
>;

export interface CloudDeletionIdentityPort {
  getStatus(): Promise<CloudSessionVaultStatus>;
  clearLocalSession(expectedSessionId: string): Promise<CloudSessionVaultStatus>;
  disableAfterReconciliationFailure(): void;
}

export interface CloudDeletionPasswordInput {
  readonly password: string;
  /**
   * Must synchronously remove the password from React/form state. The service
   * invokes this before its first await and never stores or logs the secret.
   */
  readonly clearPassword: () => void;
  readonly signal?: AbortSignal;
}

export interface RequestProjectCloudDeletionInput extends CloudDeletionPasswordInput {
  readonly projectId: string;
}

export interface RequestAccountCloudDeletionInput extends CloudDeletionPasswordInput {
  readonly email: string;
}

export interface LookupAccountCloudDeletionInput extends CloudDeletionPasswordInput {
  readonly journalId: string;
  readonly email: string;
}

export interface CancelAccountCloudDeletionInput extends CloudDeletionPasswordInput {
  readonly journalId: string;
  readonly email: string;
}

export interface CloudDeletionLifecycleResult {
  readonly journal: CloudDeletionJournal;
  readonly receipt: CloudDeletionRequestResponse;
}

export class CloudDeletionLifecycleError extends Error {
  public constructor(
    public readonly code:
      | "CLOUD_DELETION_ACCOUNT_EMAIL_MISMATCH"
      | "CLOUD_DELETION_LOCAL_SESSION_CLEAR_FAILED"
      | "CLOUD_DELETION_PASSWORD_CLEAR_FAILED"
      | "CLOUD_DELETION_REQUEST_BODY_MISMATCH"
      | "CLOUD_DELETION_REQUEST_NOT_FOUND"
      | "CLOUD_DELETION_UNAVAILABLE",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "CloudDeletionLifecycleError";
  }
}

/**
 * Coordinates L3 cloud deletion while preserving a crash-safe, password-free
 * journal. Project cloud deletion never touches local project repositories.
 */
export class CloudDeletionLifecycleService {
  public constructor(
    private readonly api: CloudDeletionApi,
    private readonly session: CloudSessionCoordinator,
    private readonly identity: CloudDeletionIdentityPort,
    private readonly journal: CloudDeletionJournalSqliteStore,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
  ) {}

  public findProject(projectId: string): Promise<CloudDeletionJournal | null> {
    return this.journal.findByTarget("project", projectId);
  }

  public findAccount(accountId: string): Promise<CloudDeletionJournal | null> {
    return this.journal.findByTarget("account", accountId);
  }

  public listRecoverable(): Promise<readonly CloudDeletionJournal[]> {
    return this.journal.listRecoverable();
  }

  public async requestProjectDeletion(
    input: RequestProjectCloudDeletionInput,
  ): Promise<CloudDeletionLifecycleResult> {
    const password = consumePassword(input);
    let prepared: CloudDeletionJournal | null = null;
    try {
      const outcome = await this.session.runWithSession(async () => {
        const existing = await this.journal.findByTarget("project", input.projectId);
        prepared =
          reusableSubmission(existing) ??
          (await this.prepareProjectSubmission(input.projectId, input.signal));
        const mutation = requireActiveMutation(prepared, "submission");
        const body = {
          schemaVersion: 1 as const,
          expectedRevision: mutation.expectedRevision,
          confirmationId: requireConfirmationId(mutation),
          password,
        };
        await this.requirePasswordFreeHash(mutation, {
          schemaVersion: body.schemaVersion,
          expectedRevision: body.expectedRevision,
          confirmationId: body.confirmationId,
        });
        const response = await this.api.requestProjectDeletion(input.projectId, body, {
          idempotencyKey: mutation.idempotencyKey,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return { mutation, response };
      }, signalOptions(input.signal));
      const saved = await this.journal.recordMutationReceipt(
        outcome.mutation.mutationId,
        outcome.response,
        this.clock.now(),
      );
      return { journal: saved, receipt: outcome.response };
    } catch (cause: unknown) {
      await this.recordFailureBestEffort(prepared, cause);
      throw cause;
    }
  }

  public async refreshProjectDeletion(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<CloudDeletionLifecycleResult> {
    const existing = await this.requireTargetJournal("project", projectId);
    const response = await this.session.runWithSession(
      () => this.api.getProjectDeletionRequest(projectId, signal === undefined ? {} : { signal }),
      signalOptions(signal),
    );
    const saved = await this.journal.recordObservedReceipt(
      existing.journalId,
      response,
      this.clock.now(),
    );
    return { journal: saved, receipt: response };
  }

  public async cancelProjectDeletion(
    journalId: string,
    signal?: AbortSignal,
  ): Promise<CloudDeletionLifecycleResult> {
    let prepared: CloudDeletionJournal | null = null;
    try {
      const existing = await this.requireJournal(journalId);
      prepared =
        reusableCancellation(existing) ?? (await this.prepareCancellation(existing, signal));
      const mutation = requireActiveMutation(prepared, "cancellation");
      const targetId = prepared.targetId;
      const deletionRequestId = requireDeletionRequestId(prepared);
      const body = {
        schemaVersion: 1 as const,
        deletionRequestId,
        expectedDeletionRevision: mutation.expectedRevision,
      };
      await this.requirePasswordFreeHash(mutation, body);
      const response = await this.session.runWithSession(
        () =>
          this.api.cancelProjectDeletion(targetId, body, {
            idempotencyKey: mutation.idempotencyKey,
            ...(signal === undefined ? {} : { signal }),
          }),
        signalOptions(signal),
      );
      const saved = await this.journal.recordMutationReceipt(
        mutation.mutationId,
        response,
        this.clock.now(),
      );
      return { journal: saved, receipt: response };
    } catch (cause: unknown) {
      await this.recordFailureBestEffort(prepared, cause);
      throw cause;
    }
  }

  public async requestAccountDeletion(
    input: RequestAccountCloudDeletionInput,
  ): Promise<CloudDeletionLifecycleResult> {
    const password = consumePassword(input);
    const email = CloudEmailAddressSchema.parse(input.email);
    let prepared: CloudDeletionJournal | null = null;
    let acceptedSessionId: string | undefined;
    try {
      const outcome = await this.session.runWithSession(async (active) => {
        const existing = await this.journal.findByTarget("account", active.account.accountId);
        requireJournalEmail(existing, email);
        prepared =
          reusableSubmission(existing) ?? (await this.prepareAccountSubmission(active, email));
        const mutation = requireActiveMutation(prepared, "submission");
        const body = {
          schemaVersion: 1 as const,
          expectedRevision: mutation.expectedRevision,
          confirmationId: requireConfirmationId(mutation),
          email,
          password,
        };
        await this.requirePasswordFreeHash(mutation, {
          schemaVersion: body.schemaVersion,
          expectedRevision: body.expectedRevision,
          confirmationId: body.confirmationId,
          email: body.email,
        });
        const response = await this.api.requestAccountDeletion(body, {
          idempotencyKey: mutation.idempotencyKey,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return { mutation, response, sessionId: active.session.sessionId };
      }, signalOptions(input.signal));
      acceptedSessionId = outcome.sessionId;
      const saved = await this.journal.recordMutationReceipt(
        outcome.mutation.mutationId,
        outcome.response,
        this.clock.now(),
      );
      return { journal: saved, receipt: outcome.response };
    } catch (cause: unknown) {
      await this.recordFailureBestEffort(prepared, cause);
      throw cause;
    } finally {
      if (acceptedSessionId !== undefined) {
        await this.clearAcceptedAccountSession(acceptedSessionId);
      }
    }
  }

  public async lookupAccountDeletion(
    input: LookupAccountCloudDeletionInput,
  ): Promise<CloudDeletionLifecycleResult> {
    const password = consumePassword(input);
    const journal = await this.requireJournal(input.journalId);
    requireTargetKind(journal, "account");
    const email = requireMatchingEmail(journal, input.email);
    const submissionMutation =
      journal.deletionRequestId === null ? requireActiveMutation(journal, "submission") : null;
    const proof =
      submissionMutation === null
        ? { deletionRequestId: requireDeletionRequestId(journal) }
        : { confirmationId: requireConfirmationId(submissionMutation) };
    const response = await this.api.lookupAccountDeletion(
      {
        schemaVersion: 1,
        email,
        password,
        ...proof,
      },
      signalOptions(input.signal),
    );
    const saved =
      submissionMutation === null
        ? await this.journal.recordObservedReceipt(journal.journalId, response, this.clock.now())
        : await this.journal.recordMutationReceipt(
            submissionMutation.mutationId,
            response,
            this.clock.now(),
          );
    await this.clearRecoveredAccountSession(journal.targetId);
    return { journal: saved, receipt: response };
  }

  public async cancelAccountDeletion(
    input: CancelAccountCloudDeletionInput,
  ): Promise<CloudDeletionLifecycleResult> {
    const password = consumePassword(input);
    let prepared: CloudDeletionJournal | null = null;
    try {
      const existing = await this.requireJournal(input.journalId);
      requireTargetKind(existing, "account");
      const email = requireMatchingEmail(existing, input.email);
      prepared =
        reusableCancellation(existing) ?? (await this.prepareCancellation(existing, input.signal));
      const mutation = requireActiveMutation(prepared, "cancellation");
      const deletionRequestId = requireDeletionRequestId(prepared);
      const body = {
        schemaVersion: 1 as const,
        email,
        password,
        deletionRequestId,
        expectedDeletionRevision: mutation.expectedRevision,
      };
      await this.requirePasswordFreeHash(mutation, {
        schemaVersion: body.schemaVersion,
        email: body.email,
        deletionRequestId: body.deletionRequestId,
        expectedDeletionRevision: body.expectedDeletionRevision,
      });
      const response = await this.api.cancelAccountDeletion(body, {
        idempotencyKey: mutation.idempotencyKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const saved = await this.journal.recordMutationReceipt(
        mutation.mutationId,
        response,
        this.clock.now(),
      );
      return { journal: saved, receipt: response };
    } catch (cause: unknown) {
      await this.recordFailureBestEffort(prepared, cause);
      throw cause;
    }
  }

  private async prepareProjectSubmission(
    projectId: string,
    signal: AbortSignal | undefined,
  ): Promise<CloudDeletionJournal> {
    const state = await this.api.getProjectState(projectId, signal === undefined ? {} : { signal });
    const confirmationId = this.ids.next();
    const secretFreeBody = {
      schemaVersion: 1 as const,
      expectedRevision: state.project.serverRevision,
      confirmationId,
    };
    return this.journal.prepareSubmission({
      journalId: this.ids.next(),
      mutationId: this.ids.next(),
      targetKind: "project",
      targetId: projectId,
      accountEmail: null,
      confirmationId,
      idempotencyKey: this.ids.next(),
      expectedRevision: state.project.serverRevision,
      requestBodySha256: await this.hashPasswordFreeBody(secretFreeBody),
      preparedAt: this.clock.now(),
    });
  }

  private async prepareAccountSubmission(
    active: ConfiguredCloudSessionStatus,
    email: string,
  ): Promise<CloudDeletionJournal> {
    const confirmationId = this.ids.next();
    const secretFreeBody = {
      schemaVersion: 1 as const,
      expectedRevision: active.account.revision,
      confirmationId,
      email,
    };
    return this.journal.prepareSubmission({
      journalId: this.ids.next(),
      mutationId: this.ids.next(),
      targetKind: "account",
      targetId: active.account.accountId,
      accountEmail: email,
      confirmationId,
      idempotencyKey: this.ids.next(),
      expectedRevision: active.account.revision,
      requestBodySha256: await this.hashPasswordFreeBody(secretFreeBody),
      preparedAt: this.clock.now(),
    });
  }

  private async prepareCancellation(
    existing: CloudDeletionJournal,
    signal: AbortSignal | undefined,
  ): Promise<CloudDeletionJournal> {
    throwIfAborted(signal);
    const receipt = requireReceipt(existing);
    const deletionRequestId = receipt.deletionRequest.deletionRequestId;
    const expectedDeletionRevision = receipt.deletionRequest.revision;
    const secretFreeBody =
      existing.targetKind === "account"
        ? {
            schemaVersion: 1 as const,
            email: requireAccountEmail(existing),
            deletionRequestId,
            expectedDeletionRevision,
          }
        : {
            schemaVersion: 1 as const,
            deletionRequestId,
            expectedDeletionRevision,
          };
    return this.journal.prepareCancellation({
      mutationId: this.ids.next(),
      journalId: existing.journalId,
      idempotencyKey: this.ids.next(),
      expectedDeletionRevision,
      requestBodySha256: await this.hashPasswordFreeBody(secretFreeBody),
      preparedAt: this.clock.now(),
    });
  }

  private async requirePasswordFreeHash(
    mutation: CloudDeletionMutation,
    secretFreeBody: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if ((await this.hashPasswordFreeBody(secretFreeBody)) !== mutation.requestBodySha256) {
      throw new CloudDeletionLifecycleError(
        "CLOUD_DELETION_REQUEST_BODY_MISMATCH",
        "The durable cloud deletion request body no longer matches.",
      );
    }
  }

  private async hashPasswordFreeBody(body: Readonly<Record<string, unknown>>): Promise<string> {
    const result = await this.hasher.sha256(JSON.stringify(body));
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  private async requireJournal(journalId: string): Promise<CloudDeletionJournal> {
    const journal = await this.journal.findByJournalId(journalId);
    if (journal === null) {
      throw new CloudDeletionLifecycleError(
        "CLOUD_DELETION_REQUEST_NOT_FOUND",
        "The durable cloud deletion request was not found.",
      );
    }
    return journal;
  }

  private async requireTargetJournal(
    targetKind: "account" | "project",
    targetId: string,
  ): Promise<CloudDeletionJournal> {
    const journal = await this.journal.findByTarget(targetKind, targetId);
    if (journal === null) {
      throw new CloudDeletionLifecycleError(
        "CLOUD_DELETION_REQUEST_NOT_FOUND",
        "The durable cloud deletion request was not found.",
      );
    }
    return journal;
  }

  private async recordFailureBestEffort(
    prepared: CloudDeletionJournal | null,
    cause: unknown,
  ): Promise<void> {
    const mutation = prepared?.activeMutation;
    if (
      mutation === null ||
      mutation === undefined ||
      mutation.state === "accepted" ||
      isAbort(cause)
    ) {
      return;
    }
    const failure = classifyFailure(cause);
    await this.journal
      .recordMutationFailure({
        mutationId: mutation.mutationId,
        errorCode: failure.code,
        retryable: failure.retryable,
        failedAt: this.clock.now(),
      })
      .catch(() => undefined);
  }

  private async clearAcceptedAccountSession(expectedSessionId: string): Promise<void> {
    try {
      const cleared = await this.identity.clearLocalSession(expectedSessionId);
      if (!cleared.configured) {
        return;
      }
    } catch {
      try {
        const status = await this.identity.getStatus();
        if (!status.configured) {
          return;
        }
      } catch {
        // Fall through and disable cloud use in this process.
      }
    }
    this.identity.disableAfterReconciliationFailure();
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_LOCAL_SESSION_CLEAR_FAILED",
      "The accepted account deletion could not prove the local cloud session absent.",
    );
  }

  private async clearRecoveredAccountSession(accountId: string): Promise<void> {
    let status: CloudSessionVaultStatus;
    try {
      status = await this.identity.getStatus();
    } catch {
      this.identity.disableAfterReconciliationFailure();
      throw new CloudDeletionLifecycleError(
        "CLOUD_DELETION_LOCAL_SESSION_CLEAR_FAILED",
        "The recovered account deletion could not inspect the local cloud session.",
      );
    }
    if (!status.configured || status.account?.accountId !== accountId) {
      return;
    }
    if (status.session === null) {
      this.identity.disableAfterReconciliationFailure();
      throw new CloudDeletionLifecycleError(
        "CLOUD_DELETION_LOCAL_SESSION_CLEAR_FAILED",
        "The recovered account deletion found an incomplete local cloud session.",
      );
    }
    await this.clearAcceptedAccountSession(status.session.sessionId);
  }
}

export function matchesProjectDeletionConfirmation(
  projectName: string,
  typedConfirmation: string,
): boolean {
  return projectName.length > 0 && typedConfirmation === projectName;
}

export function matchesAccountDeletionConfirmation(
  email: string,
  typedConfirmation: string,
): boolean {
  const normalized = CloudEmailAddressSchema.safeParse(email);
  return normalized.success && typedConfirmation === normalized.data;
}

function consumePassword(input: CloudDeletionPasswordInput): string {
  const password = input.password;
  try {
    input.clearPassword();
  } catch {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_PASSWORD_CLEAR_FAILED",
      "The password could not be removed from the form before cloud deletion.",
    );
  }
  return password;
}

function reusableSubmission(journal: CloudDeletionJournal | null): CloudDeletionJournal | null {
  return journal?.activeMutation?.requestType === "submission" &&
    ["prepared", "retryable_error"].includes(journal.activeMutation.state)
    ? journal
    : null;
}

function reusableCancellation(journal: CloudDeletionJournal): CloudDeletionJournal | null {
  return journal.activeMutation?.requestType === "cancellation" &&
    ["prepared", "retryable_error"].includes(journal.activeMutation.state)
    ? journal
    : null;
}

function requireActiveMutation(
  journal: CloudDeletionJournal,
  requestType: "submission" | "cancellation",
): CloudDeletionMutation {
  const mutation = journal.activeMutation;
  if (mutation?.requestType !== requestType) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_REQUEST_BODY_MISMATCH",
      "The durable cloud deletion mutation is unavailable.",
    );
  }
  return mutation;
}

function requireConfirmationId(mutation: CloudDeletionMutation): string {
  if (mutation.confirmationId === null) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_REQUEST_BODY_MISMATCH",
      "The durable cloud deletion confirmation is unavailable.",
    );
  }
  return mutation.confirmationId;
}

function requireDeletionRequestId(journal: CloudDeletionJournal): string {
  if (journal.deletionRequestId === null) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_REQUEST_NOT_FOUND",
      "The cloud deletion request identity is unavailable.",
    );
  }
  return journal.deletionRequestId;
}

function requireReceipt(journal: CloudDeletionJournal): CloudDeletionRequestResponse {
  if (journal.latestReceipt === null) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_REQUEST_NOT_FOUND",
      "The cloud deletion receipt is unavailable.",
    );
  }
  return journal.latestReceipt;
}

function requireTargetKind(journal: CloudDeletionJournal, targetKind: "account" | "project"): void {
  if (journal.targetKind !== targetKind) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_REQUEST_NOT_FOUND",
      "The cloud deletion request target kind does not match.",
    );
  }
}

function requireAccountEmail(journal: CloudDeletionJournal): string {
  if (journal.accountEmail === null) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_ACCOUNT_EMAIL_MISMATCH",
      "The account deletion email is unavailable.",
    );
  }
  return journal.accountEmail;
}

function requireMatchingEmail(journal: CloudDeletionJournal, emailValue: string): string {
  const email = CloudEmailAddressSchema.parse(emailValue);
  if (email !== journal.accountEmail) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_ACCOUNT_EMAIL_MISMATCH",
      "The account email does not match the durable deletion request.",
    );
  }
  return email;
}

function requireJournalEmail(journal: CloudDeletionJournal | null, email: string): void {
  if (journal !== null && journal.accountEmail !== email) {
    throw new CloudDeletionLifecycleError(
      "CLOUD_DELETION_ACCOUNT_EMAIL_MISMATCH",
      "The account email does not match the durable deletion request.",
    );
  }
}

function signalOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

function isAbort(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "CLOUD_REQUEST_ABORTED")
  );
}

function classifyFailure(cause: unknown): { readonly code: string; readonly retryable: boolean } {
  if (cause instanceof CloudClientError) {
    return { code: cause.code, retryable: cause.retryable };
  }
  if (cause instanceof CloudDeletionLifecycleError) {
    return { code: cause.code, retryable: cause.retryable };
  }
  if (cause instanceof CloudDeletionJournalError) {
    return { code: cause.code, retryable: false };
  }
  return { code: "CLOUD_DELETION_UNEXPECTED", retryable: true };
}
