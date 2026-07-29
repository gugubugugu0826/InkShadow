import {
  CloudDeletionRequestResponseSchema,
  CloudEmailAddressSchema,
  IsoUtcTimestampSchema,
  UuidV7Schema,
  type CloudDeletionRequestResponse,
  type CloudDeletionTargetKind,
} from "@inkshadow/contracts";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export type CloudDeletionMutationType = "submission" | "cancellation";
export type CloudDeletionMutationState =
  "prepared" | "accepted" | "retryable_error" | "terminal_error";
export type CloudDeletionRecoveryAction = "submit" | "lookup" | "refresh" | "cancel" | "none";

export interface CloudDeletionMutation {
  readonly mutationId: string;
  readonly journalId: string;
  readonly requestType: CloudDeletionMutationType;
  readonly confirmationId: string | null;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly requestBodySha256: string;
  readonly state: CloudDeletionMutationState;
  readonly responseRequestId: string | null;
  readonly responseRevision: number | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CloudDeletionJournal {
  readonly journalId: string;
  readonly targetKind: CloudDeletionTargetKind;
  readonly targetId: string;
  readonly accountEmail: string | null;
  readonly activeMutation: CloudDeletionMutation | null;
  readonly deletionRequestId: string | null;
  readonly latestReceipt: CloudDeletionRequestResponse | null;
  readonly recoveryAction: CloudDeletionRecoveryAction;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PrepareCloudDeletionSubmissionInput {
  readonly journalId: string;
  readonly mutationId: string;
  readonly targetKind: CloudDeletionTargetKind;
  readonly targetId: string;
  readonly accountEmail: string | null;
  readonly confirmationId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly requestBodySha256: string;
  readonly preparedAt: string;
}

export interface PrepareCloudDeletionCancellationInput {
  readonly mutationId: string;
  readonly journalId: string;
  readonly idempotencyKey: string;
  readonly expectedDeletionRevision: number;
  readonly requestBodySha256: string;
  readonly preparedAt: string;
}

export interface RecordCloudDeletionMutationFailureInput {
  readonly mutationId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly failedAt: string;
}

export class CloudDeletionJournalError extends Error {
  public constructor(
    public readonly code:
      | "CLOUD_DELETION_JOURNAL_CONFLICT"
      | "CLOUD_DELETION_JOURNAL_CORRUPT"
      | "CLOUD_DELETION_JOURNAL_INVALID"
      | "CLOUD_DELETION_JOURNAL_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "CloudDeletionJournalError";
  }
}

interface JournalDbRow {
  readonly journal_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly account_email: string | null;
  readonly active_mutation_id: string | null;
  readonly deletion_request_id: string | null;
  readonly latest_request_id: string | null;
  readonly latest_revision: number | null;
  readonly latest_receipt_json: string | null;
  readonly recovery_action: string;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MutationDbRow {
  readonly mutation_id: string;
  readonly journal_id: string;
  readonly request_type: string;
  readonly confirmation_id: string | null;
  readonly idempotency_key: string;
  readonly expected_revision: number;
  readonly request_body_sha256: string;
  readonly state: string;
  readonly response_request_id: string | null;
  readonly response_revision: number | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Stores only non-secret deletion recovery metadata. Passwords never cross
 * this boundary, and the persisted request hash is supplied from a canonical
 * password-free projection of the request.
 */
export class CloudDeletionJournalSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async findByTarget(
    targetKindValue: CloudDeletionTargetKind,
    targetIdValue: string,
  ): Promise<CloudDeletionJournal | null> {
    const targetKind = parseTargetKind(targetKindValue);
    const targetId = parseUuid(targetIdValue, "targetId");
    return readJournalByTarget(this.executor, targetKind, targetId);
  }

  public async findByJournalId(journalIdValue: string): Promise<CloudDeletionJournal | null> {
    return readJournalById(this.executor, parseUuid(journalIdValue, "journalId"));
  }

  public async listRecoverable(): Promise<readonly CloudDeletionJournal[]> {
    const rows = await this.executor.select<JournalDbRow>(
      `SELECT ${JOURNAL_COLUMNS}
       FROM cloud_deletion_journals
       WHERE recovery_action <> 'none'
       ORDER BY updated_at ASC, journal_id ASC`,
    );
    const journals: CloudDeletionJournal[] = [];
    for (const row of rows) {
      journals.push(await rehydrateJournal(this.executor, row));
    }
    return Object.freeze(journals);
  }

  public async prepareSubmission(
    inputValue: PrepareCloudDeletionSubmissionInput,
  ): Promise<CloudDeletionJournal> {
    const input = normalizeSubmissionInput(inputValue);
    return this.executor.transaction(async (transaction) => {
      let journal = await readJournalByTarget(transaction, input.targetKind, input.targetId);
      if (journal === null) {
        await transaction.execute(
          `INSERT INTO cloud_deletion_journals (
             journal_id, target_kind, target_id, account_email, active_mutation_id,
             deletion_request_id, latest_request_id, latest_revision, latest_receipt_json,
             recovery_action, last_error_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'submit', NULL, ?, ?)`,
          [
            input.journalId,
            input.targetKind,
            input.targetId,
            input.accountEmail,
            input.preparedAt,
            input.preparedAt,
          ],
        );
        journal = await requireJournalById(transaction, input.journalId);
      } else {
        requireAccountEmail(journal, input.accountEmail);
      }

      const reusable = reusableMutation(journal, "submission");
      if (reusable !== null) {
        return journal;
      }
      if (
        journal.latestReceipt !== null &&
        !["cancelled", "purged"].includes(journal.latestReceipt.deletionRequest.state)
      ) {
        throw conflict("A deletion request for this target is already active.");
      }
      if (journal.latestReceipt?.deletionRequest.state === "purged") {
        throw conflict("This target cannot start another cloud deletion request.");
      }
      if (journal.latestReceipt?.deletionRequest.state === "cancelled") {
        await transaction.execute(
          `UPDATE cloud_deletion_journals
           SET deletion_request_id = NULL, latest_request_id = NULL,
               latest_revision = NULL, latest_receipt_json = NULL,
               last_error_code = NULL, updated_at = ?
           WHERE journal_id = ?`,
          [input.preparedAt, journal.journalId],
        );
        journal = await requireJournalById(transaction, journal.journalId);
      }

      await insertMutation(transaction, {
        mutationId: input.mutationId,
        journalId: journal.journalId,
        requestType: "submission",
        confirmationId: input.confirmationId,
        idempotencyKey: input.idempotencyKey,
        expectedRevision: input.expectedRevision,
        requestBodySha256: input.requestBodySha256,
        preparedAt: input.preparedAt,
      });
      await transaction.execute(
        `UPDATE cloud_deletion_journals
         SET active_mutation_id = ?, recovery_action = 'submit',
             last_error_code = NULL, updated_at = ?
         WHERE journal_id = ?`,
        [input.mutationId, input.preparedAt, journal.journalId],
      );
      return requireJournalById(transaction, journal.journalId);
    });
  }

  public async prepareCancellation(
    inputValue: PrepareCloudDeletionCancellationInput,
  ): Promise<CloudDeletionJournal> {
    const input = normalizeCancellationInput(inputValue);
    return this.executor.transaction(async (transaction) => {
      const journal = await requireJournalById(transaction, input.journalId);
      const receipt = journal.latestReceipt;
      if (
        receipt === null ||
        journal.deletionRequestId === null ||
        !receipt.deletionRequest.canCancel
      ) {
        throw conflict("The cloud deletion request is no longer cancellable.");
      }
      const reusable = reusableMutation(journal, "cancellation");
      if (reusable !== null) {
        return journal;
      }
      if (receipt.deletionRequest.revision !== input.expectedDeletionRevision) {
        throw conflict("The cloud deletion revision changed before cancellation.");
      }
      await insertMutation(transaction, {
        mutationId: input.mutationId,
        journalId: journal.journalId,
        requestType: "cancellation",
        confirmationId: null,
        idempotencyKey: input.idempotencyKey,
        expectedRevision: input.expectedDeletionRevision,
        requestBodySha256: input.requestBodySha256,
        preparedAt: input.preparedAt,
      });
      await transaction.execute(
        `UPDATE cloud_deletion_journals
         SET active_mutation_id = ?, recovery_action = 'cancel',
             last_error_code = NULL, updated_at = ?
         WHERE journal_id = ?`,
        [input.mutationId, input.preparedAt, journal.journalId],
      );
      return requireJournalById(transaction, journal.journalId);
    });
  }

  public async recordMutationReceipt(
    mutationIdValue: string,
    responseValue: CloudDeletionRequestResponse,
    observedAtValue: string,
  ): Promise<CloudDeletionJournal> {
    const mutationId = parseUuid(mutationIdValue, "mutationId");
    const response = parseReceipt(responseValue);
    const observedAt = parseTimestamp(observedAtValue, "observedAt");
    return this.executor.transaction(async (transaction) => {
      const mutation = await requireMutationById(transaction, mutationId);
      const journal = await requireJournalById(transaction, mutation.journalId);
      requireResponseBinding(journal, mutation, response);
      requireNonRegressingReceipt(journal.latestReceipt, response);

      await transaction.execute(
        `UPDATE cloud_deletion_mutations
         SET state = 'accepted', response_request_id = ?, response_revision = ?,
             last_error_code = NULL, updated_at = ?
         WHERE mutation_id = ?`,
        [response.requestId, response.deletionRequest.revision, observedAt, mutation.mutationId],
      );
      await persistLatestReceipt(transaction, journal, response, observedAt);
      return requireJournalById(transaction, journal.journalId);
    });
  }

  public async recordObservedReceipt(
    journalIdValue: string,
    responseValue: CloudDeletionRequestResponse,
    observedAtValue: string,
  ): Promise<CloudDeletionJournal> {
    const journalId = parseUuid(journalIdValue, "journalId");
    const response = parseReceipt(responseValue);
    const observedAt = parseTimestamp(observedAtValue, "observedAt");
    return this.executor.transaction(async (transaction) => {
      const journal = await requireJournalById(transaction, journalId);
      requireResponseBinding(journal, null, response);
      requireNonRegressingReceipt(journal.latestReceipt, response);
      await persistLatestReceipt(transaction, journal, response, observedAt);
      return requireJournalById(transaction, journal.journalId);
    });
  }

  public async recordMutationFailure(
    inputValue: RecordCloudDeletionMutationFailureInput,
  ): Promise<CloudDeletionJournal> {
    const input = {
      mutationId: parseUuid(inputValue.mutationId, "mutationId"),
      errorCode: parseErrorCode(inputValue.errorCode),
      retryable: inputValue.retryable,
      failedAt: parseTimestamp(inputValue.failedAt, "failedAt"),
    };
    return this.executor.transaction(async (transaction) => {
      const mutation = await requireMutationById(transaction, input.mutationId);
      const journal = await requireJournalById(transaction, mutation.journalId);
      if (mutation.state === "accepted") {
        throw conflict("An accepted cloud deletion mutation cannot become failed.");
      }
      await transaction.execute(
        `UPDATE cloud_deletion_mutations
         SET state = ?, response_request_id = NULL, response_revision = NULL,
             last_error_code = ?, updated_at = ?
         WHERE mutation_id = ?`,
        [
          input.retryable ? "retryable_error" : "terminal_error",
          input.errorCode,
          input.failedAt,
          mutation.mutationId,
        ],
      );
      await transaction.execute(
        `UPDATE cloud_deletion_journals
         SET recovery_action = ?, last_error_code = ?, updated_at = ?
         WHERE journal_id = ?`,
        [
          mutation.requestType === "submission" ? "submit" : "cancel",
          input.errorCode,
          input.failedAt,
          journal.journalId,
        ],
      );
      return requireJournalById(transaction, journal.journalId);
    });
  }
}

const JOURNAL_COLUMNS = `journal_id, target_kind, target_id, account_email,
  active_mutation_id, deletion_request_id, latest_request_id, latest_revision,
  latest_receipt_json, recovery_action, last_error_code, created_at, updated_at`;
const MUTATION_COLUMNS = `mutation_id, journal_id, request_type, confirmation_id,
  idempotency_key, expected_revision, request_body_sha256, state,
  response_request_id, response_revision, last_error_code, created_at, updated_at`;

async function insertMutation(
  transaction: TransactionExecutor,
  input: {
    readonly mutationId: string;
    readonly journalId: string;
    readonly requestType: CloudDeletionMutationType;
    readonly confirmationId: string | null;
    readonly idempotencyKey: string;
    readonly expectedRevision: number;
    readonly requestBodySha256: string;
    readonly preparedAt: string;
  },
): Promise<void> {
  await transaction.execute(
    `INSERT INTO cloud_deletion_mutations (
       mutation_id, journal_id, request_type, confirmation_id, idempotency_key,
       expected_revision, request_body_sha256, state, response_request_id,
       response_revision, last_error_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, NULL, ?, ?)`,
    [
      input.mutationId,
      input.journalId,
      input.requestType,
      input.confirmationId,
      input.idempotencyKey,
      input.expectedRevision,
      input.requestBodySha256,
      input.preparedAt,
      input.preparedAt,
    ],
  );
}

async function persistLatestReceipt(
  transaction: TransactionExecutor,
  journal: CloudDeletionJournal,
  response: CloudDeletionRequestResponse,
  observedAt: string,
): Promise<void> {
  const deletion = response.deletionRequest;
  await transaction.execute(
    `UPDATE cloud_deletion_journals
     SET deletion_request_id = ?, latest_request_id = ?, latest_revision = ?,
         latest_receipt_json = ?, recovery_action = ?, last_error_code = NULL,
         updated_at = ?
     WHERE journal_id = ?`,
    [
      deletion.deletionRequestId,
      response.requestId,
      deletion.revision,
      JSON.stringify(response),
      recoveryActionFor(response),
      observedAt,
      journal.journalId,
    ],
  );
}

function recoveryActionFor(response: CloudDeletionRequestResponse): CloudDeletionRecoveryAction {
  const { targetKind, state } = response.deletionRequest;
  if (state === "cancelled" || state === "purged") {
    return "none";
  }
  return targetKind === "account" ? "lookup" : "refresh";
}

function reusableMutation(
  journal: CloudDeletionJournal,
  requestType: CloudDeletionMutationType,
): CloudDeletionMutation | null {
  const mutation = journal.activeMutation;
  if (
    mutation !== null &&
    mutation.requestType === requestType &&
    ["prepared", "retryable_error"].includes(mutation.state)
  ) {
    return mutation;
  }
  return null;
}

function requireResponseBinding(
  journal: CloudDeletionJournal,
  mutation: CloudDeletionMutation | null,
  response: CloudDeletionRequestResponse,
): void {
  const deletion = response.deletionRequest;
  if (deletion.targetKind !== journal.targetKind || deletion.targetId !== journal.targetId) {
    throw corrupt("The cloud deletion receipt is bound to another target.");
  }
  if (
    journal.deletionRequestId !== null &&
    deletion.deletionRequestId !== journal.deletionRequestId
  ) {
    throw conflict("The cloud deletion request identity changed.");
  }
  if (
    mutation?.requestType === "cancellation" &&
    (deletion.deletionRequestId !== journal.deletionRequestId ||
      deletion.state !== "cancelled" ||
      deletion.revision <= mutation.expectedRevision)
  ) {
    throw corrupt("A cloud deletion cancellation returned an inconsistent receipt.");
  }
}

function requireNonRegressingReceipt(
  previous: CloudDeletionRequestResponse | null,
  next: CloudDeletionRequestResponse,
): void {
  if (previous === null) {
    return;
  }
  const previousDeletion = previous.deletionRequest;
  const nextDeletion = next.deletionRequest;
  if (nextDeletion.revision < previousDeletion.revision) {
    throw conflict("The cloud deletion receipt revision regressed.");
  }
  if (
    nextDeletion.revision === previousDeletion.revision &&
    JSON.stringify(nextDeletion) !== JSON.stringify(previousDeletion)
  ) {
    throw corrupt("The same cloud deletion revision returned different lifecycle state.");
  }
  if (nextDeletion.revision === previousDeletion.revision) {
    return;
  }
  if (
    previousDeletion.deletionRequestId !== nextDeletion.deletionRequestId ||
    previousDeletion.targetKind !== nextDeletion.targetKind ||
    previousDeletion.targetId !== nextDeletion.targetId ||
    previousDeletion.requestedAt !== nextDeletion.requestedAt ||
    previousDeletion.scheduledFor !== nextDeletion.scheduledFor ||
    previousDeletion.cancellableUntil !== nextDeletion.cancellableUntil ||
    JSON.stringify(previousDeletion.impactSummary) !== JSON.stringify(nextDeletion.impactSummary)
  ) {
    throw corrupt("Immutable cloud deletion receipt facts changed across revisions.");
  }
  if (["cancelled", "purged"].includes(previousDeletion.state)) {
    throw conflict("A completed cloud deletion lifecycle cannot advance again.");
  }
  if (phaseRank(nextDeletion.phase) < phaseRank(previousDeletion.phase)) {
    throw conflict("The cloud deletion phase regressed.");
  }
  requireStickyTimestamp(
    previousDeletion.commitStartedAt,
    nextDeletion.commitStartedAt,
    "commitStartedAt",
  );
  requireStickyTimestamp(
    previousDeletion.liveDataPurgedAt,
    nextDeletion.liveDataPurgedAt,
    "liveDataPurgedAt",
  );
  requireStickyTimestamp(
    previousDeletion.backupRetainedUntil,
    nextDeletion.backupRetainedUntil,
    "backupRetainedUntil",
  );
  requireStickyTimestamp(previousDeletion.completedAt, nextDeletion.completedAt, "completedAt");
}

function requireStickyTimestamp(previous: string | null, next: string | null, label: string): void {
  if (previous !== null && next !== previous) {
    throw corrupt(`Cloud deletion ${label} changed after it was recorded.`);
  }
}

function phaseRank(
  phase:
    | "freeze"
    | "derived"
    | "ciphertext"
    | "keys"
    | "access"
    | "marker"
    | "verify"
    | "backup_wait"
    | "complete",
): number {
  return [
    "freeze",
    "derived",
    "ciphertext",
    "keys",
    "access",
    "marker",
    "verify",
    "backup_wait",
    "complete",
  ].indexOf(phase);
}

async function readJournalByTarget(
  executor: TransactionExecutor,
  targetKind: CloudDeletionTargetKind,
  targetId: string,
): Promise<CloudDeletionJournal | null> {
  const rows = await executor.select<JournalDbRow>(
    `SELECT ${JOURNAL_COLUMNS}
     FROM cloud_deletion_journals
     WHERE target_kind = ? AND target_id = ?`,
    [targetKind, targetId],
  );
  if (rows.length > 1) {
    throw corrupt("Cloud deletion journal target is duplicated.");
  }
  return rows[0] === undefined ? null : rehydrateJournal(executor, rows[0]);
}

async function readJournalById(
  executor: TransactionExecutor,
  journalId: string,
): Promise<CloudDeletionJournal | null> {
  const rows = await executor.select<JournalDbRow>(
    `SELECT ${JOURNAL_COLUMNS}
     FROM cloud_deletion_journals
     WHERE journal_id = ?`,
    [journalId],
  );
  if (rows.length > 1) {
    throw corrupt("Cloud deletion journal identity is duplicated.");
  }
  return rows[0] === undefined ? null : rehydrateJournal(executor, rows[0]);
}

async function requireJournalById(
  executor: TransactionExecutor,
  journalId: string,
): Promise<CloudDeletionJournal> {
  const journal = await readJournalById(executor, journalId);
  if (journal === null) {
    throw notFound("Cloud deletion journal was not found.");
  }
  return journal;
}

async function readMutationById(
  executor: TransactionExecutor,
  mutationId: string,
): Promise<CloudDeletionMutation | null> {
  const rows = await executor.select<MutationDbRow>(
    `SELECT ${MUTATION_COLUMNS}
     FROM cloud_deletion_mutations
     WHERE mutation_id = ?`,
    [mutationId],
  );
  if (rows.length > 1) {
    throw corrupt("Cloud deletion mutation identity is duplicated.");
  }
  return rows[0] === undefined ? null : rehydrateMutation(rows[0]);
}

async function requireMutationById(
  executor: TransactionExecutor,
  mutationId: string,
): Promise<CloudDeletionMutation> {
  const mutation = await readMutationById(executor, mutationId);
  if (mutation === null) {
    throw notFound("Cloud deletion mutation was not found.");
  }
  return mutation;
}

async function rehydrateJournal(
  executor: TransactionExecutor,
  row: JournalDbRow,
): Promise<CloudDeletionJournal> {
  const targetKind = parseTargetKind(row.target_kind);
  const targetId = parseUuid(row.target_id, "stored targetId");
  const accountEmail =
    row.account_email === null ? null : CloudEmailAddressSchema.parse(row.account_email);
  if ((targetKind === "account") !== (accountEmail !== null)) {
    throw corrupt("Cloud deletion journal account identity is inconsistent.");
  }
  const latestReceipt =
    row.latest_receipt_json === null ? null : parseReceiptJson(row.latest_receipt_json);
  const deletionRequestId =
    row.deletion_request_id === null
      ? null
      : parseUuid(row.deletion_request_id, "stored deletionRequestId");
  if (
    latestReceipt !== null &&
    (latestReceipt.requestId !== row.latest_request_id ||
      latestReceipt.deletionRequest.revision !== row.latest_revision ||
      latestReceipt.deletionRequest.deletionRequestId !== deletionRequestId ||
      latestReceipt.deletionRequest.targetKind !== targetKind ||
      latestReceipt.deletionRequest.targetId !== targetId)
  ) {
    throw corrupt("Cloud deletion journal receipt columns do not match its strict receipt.");
  }
  const activeMutation =
    row.active_mutation_id === null
      ? null
      : await requireMutationById(executor, parseUuid(row.active_mutation_id, "activeMutationId"));
  if (activeMutation !== null && activeMutation.journalId !== row.journal_id) {
    throw corrupt("Cloud deletion active mutation belongs to another journal.");
  }
  return Object.freeze({
    journalId: parseUuid(row.journal_id, "stored journalId"),
    targetKind,
    targetId,
    accountEmail,
    activeMutation,
    deletionRequestId,
    latestReceipt,
    recoveryAction: parseRecoveryAction(row.recovery_action),
    lastErrorCode: row.last_error_code === null ? null : parseErrorCode(row.last_error_code),
    createdAt: parseTimestamp(row.created_at, "stored createdAt"),
    updatedAt: parseTimestamp(row.updated_at, "stored updatedAt"),
  });
}

function rehydrateMutation(row: MutationDbRow): CloudDeletionMutation {
  const state = parseMutationState(row.state);
  const responseRequestId =
    row.response_request_id === null
      ? null
      : parseUuid(row.response_request_id, "responseRequestId");
  const responseRevision =
    row.response_revision === null
      ? null
      : parsePositiveInteger(row.response_revision, "responseRevision");
  if ((state === "accepted") !== (responseRequestId !== null && responseRevision !== null)) {
    throw corrupt("Cloud deletion mutation response columns are inconsistent.");
  }
  return Object.freeze({
    mutationId: parseUuid(row.mutation_id, "stored mutationId"),
    journalId: parseUuid(row.journal_id, "stored mutation journalId"),
    requestType: parseMutationType(row.request_type),
    confirmationId:
      row.confirmation_id === null ? null : parseUuid(row.confirmation_id, "stored confirmationId"),
    idempotencyKey: parseIdempotencyKey(row.idempotency_key),
    expectedRevision: parsePositiveInteger(row.expected_revision, "expectedRevision"),
    requestBodySha256: parseSha256(row.request_body_sha256),
    state,
    responseRequestId,
    responseRevision,
    lastErrorCode: row.last_error_code === null ? null : parseErrorCode(row.last_error_code),
    createdAt: parseTimestamp(row.created_at, "stored mutation createdAt"),
    updatedAt: parseTimestamp(row.updated_at, "stored mutation updatedAt"),
  });
}

function normalizeSubmissionInput(
  input: PrepareCloudDeletionSubmissionInput,
): PrepareCloudDeletionSubmissionInput {
  const targetKind = parseTargetKind(input.targetKind);
  const accountEmail =
    input.accountEmail === null ? null : CloudEmailAddressSchema.parse(input.accountEmail);
  if ((targetKind === "account") !== (accountEmail !== null)) {
    throw invalid("Only an account deletion journal may persist an account email.");
  }
  return Object.freeze({
    journalId: parseUuid(input.journalId, "journalId"),
    mutationId: parseUuid(input.mutationId, "mutationId"),
    targetKind,
    targetId: parseUuid(input.targetId, "targetId"),
    accountEmail,
    confirmationId: parseUuid(input.confirmationId, "confirmationId"),
    idempotencyKey: parseIdempotencyKey(input.idempotencyKey),
    expectedRevision: parsePositiveInteger(input.expectedRevision, "expectedRevision"),
    requestBodySha256: parseSha256(input.requestBodySha256),
    preparedAt: parseTimestamp(input.preparedAt, "preparedAt"),
  });
}

function normalizeCancellationInput(
  input: PrepareCloudDeletionCancellationInput,
): PrepareCloudDeletionCancellationInput {
  return Object.freeze({
    mutationId: parseUuid(input.mutationId, "mutationId"),
    journalId: parseUuid(input.journalId, "journalId"),
    idempotencyKey: parseIdempotencyKey(input.idempotencyKey),
    expectedDeletionRevision: parsePositiveInteger(
      input.expectedDeletionRevision,
      "expectedDeletionRevision",
    ),
    requestBodySha256: parseSha256(input.requestBodySha256),
    preparedAt: parseTimestamp(input.preparedAt, "preparedAt"),
  });
}

function requireAccountEmail(journal: CloudDeletionJournal, accountEmail: string | null): void {
  if (journal.accountEmail !== accountEmail) {
    throw conflict("The cloud deletion journal is bound to another account email.");
  }
}

function parseReceiptJson(value: string): CloudDeletionRequestResponse {
  try {
    return parseReceipt(JSON.parse(value));
  } catch (cause: unknown) {
    if (cause instanceof CloudDeletionJournalError) {
      throw cause;
    }
    throw corrupt("Cloud deletion journal receipt is not valid JSON.");
  }
}

function parseReceipt(value: unknown): CloudDeletionRequestResponse {
  const parsed = CloudDeletionRequestResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw corrupt("Cloud deletion journal receipt violates the strict contract.");
  }
  return Object.freeze(parsed.data);
}

function parseTargetKind(value: unknown): CloudDeletionTargetKind {
  if (value !== "project" && value !== "account") {
    throw invalid("Cloud deletion target kind is invalid.");
  }
  return value;
}

function parseMutationType(value: unknown): CloudDeletionMutationType {
  if (value !== "submission" && value !== "cancellation") {
    throw corrupt("Cloud deletion mutation type is invalid.");
  }
  return value;
}

function parseMutationState(value: unknown): CloudDeletionMutationState {
  if (
    value !== "prepared" &&
    value !== "accepted" &&
    value !== "retryable_error" &&
    value !== "terminal_error"
  ) {
    throw corrupt("Cloud deletion mutation state is invalid.");
  }
  return value;
}

function parseRecoveryAction(value: unknown): CloudDeletionRecoveryAction {
  if (
    value !== "submit" &&
    value !== "lookup" &&
    value !== "refresh" &&
    value !== "cancel" &&
    value !== "none"
  ) {
    throw corrupt("Cloud deletion recovery action is invalid.");
  }
  return value;
}

function parseUuid(value: unknown, label: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(`Cloud deletion ${label} must be a UUIDv7.`);
  }
  return parsed.data;
}

function parseTimestamp(value: unknown, label: string): string {
  const parsed = IsoUtcTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(`Cloud deletion ${label} must be an ISO UTC timestamp.`);
  }
  return parsed.data;
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invalid(`Cloud deletion ${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function parseSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalid("Cloud deletion password-free request hash must be SHA-256.");
  }
  return value;
}

function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
    throw invalid("Cloud deletion idempotency key is invalid.");
  }
  return value;
}

function parseErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9_]{3,80}$/u.test(value)) {
    throw invalid("Cloud deletion failure code is invalid.");
  }
  return value;
}

function invalid(message: string): CloudDeletionJournalError {
  return new CloudDeletionJournalError("CLOUD_DELETION_JOURNAL_INVALID", message);
}

function conflict(message: string): CloudDeletionJournalError {
  return new CloudDeletionJournalError("CLOUD_DELETION_JOURNAL_CONFLICT", message);
}

function corrupt(message: string): CloudDeletionJournalError {
  return new CloudDeletionJournalError("CLOUD_DELETION_JOURNAL_CORRUPT", message);
}

function notFound(message: string): CloudDeletionJournalError {
  return new CloudDeletionJournalError("CLOUD_DELETION_JOURNAL_NOT_FOUND", message);
}
