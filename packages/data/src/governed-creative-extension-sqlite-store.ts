import type { Clock } from "@inkshadow/domain";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";
import { inspectGovernedExtensionProviderUrl } from "./governed-extension-provider-url.js";

export const GOVERNED_EXTENSION_KINDS = ["translation", "short_drama"] as const;
export type GovernedExtensionKind = (typeof GOVERNED_EXTENSION_KINDS)[number];

export const GOVERNED_EXTENSION_DATA_CATEGORIES = [
  "chapter_text",
  "glossary",
  "translation_settings",
  "short_drama_settings",
] as const;
export type GovernedExtensionDataCategory = (typeof GOVERNED_EXTENSION_DATA_CATEGORIES)[number];

export type GovernedExtensionProviderLocation = "loopback" | "remote";
export type GovernedExtensionRequestStatus =
  "running" | "candidate_ready" | "cancelled" | "failed_retryable" | "failed_final";
export type GovernedExtensionCandidateStatus = "ready" | "accepted" | "rejected" | "expired";

export interface TranslationRequestSettings {
  readonly targetLanguage: {
    readonly code: string;
    readonly label: string;
  };
  readonly tone: string;
  readonly glossaryVersion: string;
  readonly glossary: readonly {
    readonly source: string;
    readonly target: string;
    readonly note: string | null;
  }[];
}

export interface ShortDramaRequestSettings {
  readonly format: "vertical_micro_drama" | "standard_short_drama";
  readonly targetEpisodeCount: number;
  readonly targetEpisodeDurationSeconds: number;
  readonly tone: string;
}

export type GovernedExtensionRequestSnapshot =
  | GovernedExtensionRequestSnapshotBase<"translation", TranslationRequestSettings>
  | GovernedExtensionRequestSnapshotBase<"short_drama", ShortDramaRequestSettings>;

interface GovernedExtensionRequestSnapshotBase<Kind extends GovernedExtensionKind, Settings> {
  readonly schemaVersion: 1;
  readonly kind: Kind;
  readonly projectId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceChecksum: string;
  readonly sourceText: string;
  readonly settings: Settings;
  readonly provider: {
    readonly location: GovernedExtensionProviderLocation;
    readonly providerId: string;
    readonly baseUrl: string;
    readonly modelId: string;
  };
  readonly dataCategories: readonly GovernedExtensionDataCategory[];
  readonly pricing: {
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
    readonly currency: string;
    readonly priceVersion: string;
    readonly priceUpdatedAt: string;
  };
  readonly limits: {
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
    readonly timeoutMs: number;
  };
}

export interface GovernedExtensionBudget {
  readonly projectId: string;
  readonly monthKey: string;
  readonly currency: string;
  readonly limitMicros: number;
  readonly spentMicros: number;
  readonly reservedMicros: number;
  readonly activeRequests: number;
  readonly maximumConcurrent: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernedExtensionRequest {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceChecksum: string;
  readonly kind: GovernedExtensionKind;
  readonly attempt: number;
  readonly retryOfRequestId: string | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly requestSnapshotJson: string;
  readonly providerLocation: GovernedExtensionProviderLocation;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly dataCategories: readonly GovernedExtensionDataCategory[];
  readonly pricing: GovernedExtensionRequestSnapshot["pricing"];
  readonly limits: GovernedExtensionRequestSnapshot["limits"];
  readonly reservedCostMicros: number;
  readonly status: GovernedExtensionRequestStatus;
  readonly revision: number;
  readonly candidateId: string | null;
  readonly usage:
    | {
        readonly source: "provider_reported";
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cachedInputTokens: number | null;
        readonly calculatedCostMicros: number;
        readonly providerReceiptDigest: string | null;
      }
    | {
        readonly source: "provider_unavailable";
        readonly inputTokens: null;
        readonly outputTokens: null;
        readonly cachedInputTokens: null;
        /** Conservative internal settlement at the immutable maximum reservation. */
        readonly calculatedCostMicros: number;
        readonly providerReceiptDigest: string | null;
      }
    | null;
  readonly cancellationRequested: boolean;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernedExtensionCandidate {
  readonly id: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceChecksum: string;
  readonly kind: GovernedExtensionKind;
  readonly payloadJson: string;
  readonly payloadChecksum: string;
  readonly status: GovernedExtensionCandidateStatus;
  readonly revision: number;
  readonly formalOutputId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

export interface GovernedExtensionConsentScope {
  readonly kind: GovernedExtensionKind;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly dataCategories: readonly GovernedExtensionDataCategory[];
  readonly projectId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly priceVersion: string;
  readonly requestFingerprint: string;
}

export interface IssuedGovernedExtensionConsent {
  /** The one-time secret is caller-held only and is never written to SQLite. */
  readonly token: string;
  readonly receiptDigest: string;
  readonly scopeFingerprint: string;
  readonly expiresAt: string;
}

export interface StartGovernedExtensionRequestInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly snapshot: GovernedExtensionRequestSnapshot;
  readonly reservedCostMicros: number;
  readonly monthKey: string;
  readonly consentToken?: string;
  readonly retryOfRequestId?: string | null;
  readonly attempt?: number;
  readonly auditEventId: string;
  readonly correlationId: string;
}

export interface ProviderReportedExtensionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly providerReceipt?: string | null;
}

export interface CompleteGovernedExtensionRequestInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly candidateId: string;
  readonly payloadJson: string;
  readonly payloadChecksum: string;
  readonly usage: ProviderReportedExtensionUsage;
  readonly auditEventId: string;
  readonly correlationId: string;
}

export interface FailGovernedExtensionRequestInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly outcome: "failed_retryable" | "failed_final";
  readonly errorCode: string;
  readonly usage?: ProviderReportedExtensionUsage | null;
  readonly auditEventId: string;
  readonly correlationId: string;
}

export interface DecideGovernedExtensionCandidateInput {
  readonly candidateId: string;
  readonly expectedRevision: number;
  readonly auditEventId: string;
  readonly correlationId: string;
  readonly decidedAt?: string;
}

export interface AcceptGovernedExtensionCandidateInput extends DecideGovernedExtensionCandidateInput {
  readonly formalOutputId: string;
}

export interface AcceptedGovernedExtensionCandidate {
  readonly outcome: "accepted";
  readonly candidate: GovernedExtensionCandidate;
  readonly formalOutputId: string;
}

export interface ExpiredGovernedExtensionCandidate {
  readonly outcome: "expired";
  readonly candidate: GovernedExtensionCandidate;
  readonly errorCode: "CANDIDATE_STALE";
}

export type AcceptGovernedExtensionCandidateResult =
  AcceptedGovernedExtensionCandidate | ExpiredGovernedExtensionCandidate;

export type GovernedExtensionStoreErrorCode =
  | "EXTENSION_VALIDATION_FAILED"
  | "EXTENSION_NOT_FOUND"
  | "EXTENSION_IDEMPOTENCY_CONFLICT"
  | "EXTENSION_REVISION_CONFLICT"
  | "EXTENSION_RECEIPT_REQUIRED"
  | "EXTENSION_RECEIPT_INVALID"
  | "EXTENSION_RECEIPT_EXPIRED"
  | "EXTENSION_RECEIPT_REPLAYED"
  | "EXTENSION_RECEIPT_PURPOSE_MISMATCH"
  | "EXTENSION_BUDGET_NOT_CONFIGURED"
  | "EXTENSION_BUDGET_EXCEEDED"
  | "EXTENSION_CONCURRENCY_EXCEEDED"
  | "EXTENSION_USAGE_UNAVAILABLE"
  | "EXTENSION_USAGE_OVER_RESERVATION"
  | "EXTENSION_CANDIDATE_STALE"
  | "EXTENSION_REPOSITORY_ERROR";

export class GovernedExtensionStoreError extends Error {
  public constructor(
    readonly code: GovernedExtensionStoreErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = "GovernedExtensionStoreError";
  }
}

interface RequestRow {
  readonly id: string;
  readonly project_id: string;
  readonly chapter_id: string;
  readonly source_version_id: string;
  readonly source_checksum: string;
  readonly kind: string;
  readonly attempt: number;
  readonly retry_of_request_id: string | null;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly request_snapshot_json: string;
  readonly provider_location: string;
  readonly provider_id: string;
  readonly base_url: string;
  readonly model_id: string;
  readonly data_categories_json: string;
  readonly input_micros_per_million_tokens: number;
  readonly output_micros_per_million_tokens: number;
  readonly currency: string;
  readonly price_version: string;
  readonly price_updated_at: string;
  readonly maximum_input_tokens: number;
  readonly maximum_output_tokens: number;
  readonly reserved_cost_micros: number;
  readonly timeout_ms: number;
  readonly status: string;
  readonly revision: number;
  readonly candidate_id: string | null;
  readonly usage_source: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly calculated_cost_micros: number | null;
  readonly provider_receipt_digest: string | null;
  readonly cancellation_requested: number;
  readonly error_code: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CandidateRow {
  readonly id: string;
  readonly request_id: string;
  readonly project_id: string;
  readonly chapter_id: string;
  readonly source_version_id: string;
  readonly source_checksum: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly payload_checksum: string;
  readonly status: string;
  readonly revision: number;
  readonly formal_output_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly decided_at: string | null;
}

interface BudgetRow {
  readonly project_id: string;
  readonly month_key: string;
  readonly currency: string;
  readonly limit_micros: number;
  readonly spent_micros: number;
  readonly reserved_micros: number;
  readonly active_requests: number;
  readonly maximum_concurrent: number;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ReceiptRow {
  readonly receipt_digest: string;
  readonly kind: string;
  readonly provider_id: string;
  readonly base_url: string;
  readonly model_id: string;
  readonly data_categories_json: string;
  readonly project_id: string;
  readonly chapter_id: string;
  readonly source_version_id: string;
  readonly price_version: string;
  readonly request_fingerprint: string;
  readonly scope_fingerprint: string;
  readonly request_id: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

interface CurrentChapterAuthorityRow {
  readonly current_version_id: string;
  readonly content_checksum: string;
}

const REQUEST_SELECT = `
  SELECT id, project_id, chapter_id, source_version_id, source_checksum,
         kind, attempt, retry_of_request_id, idempotency_key,
         request_fingerprint, request_snapshot_json, provider_location,
         provider_id, base_url, model_id, data_categories_json,
         input_micros_per_million_tokens, output_micros_per_million_tokens,
         currency, price_version, price_updated_at, maximum_input_tokens,
         maximum_output_tokens, reserved_cost_micros, timeout_ms, status,
         revision, candidate_id, usage_source, input_tokens, output_tokens,
         cached_input_tokens, calculated_cost_micros,
         provider_receipt_digest, cancellation_requested, error_code,
         started_at, completed_at, created_at, updated_at
  FROM governed_extension_requests`;

const CANDIDATE_SELECT = `
  SELECT id, request_id, project_id, chapter_id, source_version_id,
         source_checksum, kind, payload_json, payload_checksum, status,
         revision, formal_output_id, created_at, updated_at, decided_at
  FROM governed_extension_candidates`;

const MAX_RECEIPT_TTL_MS = 5 * 60 * 1_000;
const MIN_RECEIPT_TTL_MS = 10 * 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const UNSAFE_TEXT_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const MEANINGFUL_TEXT_PATTERN = /[^\p{White_Space}\u200B\u200C\u200D\u2060\uFEFF]/u;

export class GovernedCreativeExtensionSqliteStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public async configureBudget(input: {
    readonly projectId: string;
    readonly monthKey: string;
    readonly currency: string;
    readonly limitMicros: number;
    readonly maximumConcurrent: number;
    readonly expectedRevision?: number | null;
  }): Promise<GovernedExtensionBudget> {
    validateIdentifier(input.projectId, "projectId");
    validateMonthKey(input.monthKey);
    validateCurrency(input.currency);
    validateSafeInteger(input.limitMicros, 0, Number.MAX_SAFE_INTEGER, "limitMicros");
    validateSafeInteger(input.maximumConcurrent, 1, 1_000, "maximumConcurrent");
    const at = nowIso(this.clock);

    return this.executor.transaction(async (transaction) => {
      const existing = await selectBudget(transaction, input.projectId, input.monthKey);
      if (existing === null) {
        if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
          throw revisionConflict(input.expectedRevision, 0);
        }
        await transaction.execute(
          `INSERT INTO governed_extension_budgets (
             project_id, month_key, currency, limit_micros, spent_micros,
             reserved_micros, active_requests, maximum_concurrent, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, 1, ?, ?)`,
          [
            input.projectId,
            input.monthKey,
            input.currency,
            input.limitMicros,
            input.maximumConcurrent,
            at,
            at,
          ],
        );
      } else {
        if (
          input.expectedRevision === undefined ||
          input.expectedRevision === null ||
          input.expectedRevision !== existing.revision
        ) {
          throw revisionConflict(input.expectedRevision ?? -1, existing.revision);
        }
        if (existing.currency !== input.currency) {
          throw invalid("A live budget currency cannot be changed.");
        }
        const result = await transaction.execute(
          `UPDATE governed_extension_budgets
           SET limit_micros = ?, maximum_concurrent = ?, revision = revision + 1,
               updated_at = ?
           WHERE project_id = ? AND month_key = ? AND revision = ?`,
          [
            input.limitMicros,
            input.maximumConcurrent,
            at,
            input.projectId,
            input.monthKey,
            existing.revision,
          ],
        );
        if (result.rowsAffected !== 1) {
          throw revisionConflict(existing.revision, existing.revision + 1);
        }
      }
      return mapBudget(await requireBudget(transaction, input.projectId, input.monthKey));
    });
  }

  public async issueRemoteConsent(
    scope: GovernedExtensionConsentScope,
    input: {
      readonly auditEventId: string;
      readonly correlationId: string;
      readonly ttlMs?: number;
    },
  ): Promise<IssuedGovernedExtensionConsent> {
    validateConsentScope(scope);
    validateIdentifier(input.auditEventId, "auditEventId");
    validateIdentifier(input.correlationId, "correlationId");
    assertProviderUrl(scope.baseUrl, "remote");
    const ttlMs = input.ttlMs ?? 60_000;
    validateSafeInteger(ttlMs, MIN_RECEIPT_TTL_MS, MAX_RECEIPT_TTL_MS, "ttlMs");

    const token = createOpaqueToken();
    const receiptDigest = await sha256Hex(token);
    const scopeFingerprint = await computeGovernedExtensionConsentScopeFingerprint(scope);
    const createdAt = nowIso(this.clock);
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const baseUrlDigest = await sha256Hex(scope.baseUrl);

    await this.executor.transaction(async (transaction) => {
      await requireCurrentAuthority(
        transaction,
        scope.projectId,
        scope.chapterId,
        scope.sourceVersionId,
      );
      await transaction.execute(
        `INSERT INTO governed_extension_egress_receipts (
           receipt_digest, kind, provider_id, base_url, model_id,
           data_categories_json, project_id, chapter_id, source_version_id,
           price_version, request_fingerprint, scope_fingerprint, request_id,
           created_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
        [
          receiptDigest,
          scope.kind,
          scope.providerId,
          scope.baseUrl,
          scope.modelId,
          canonicalJson([...scope.dataCategories]),
          scope.projectId,
          scope.chapterId,
          scope.sourceVersionId,
          scope.priceVersion,
          scope.requestFingerprint,
          scopeFingerprint,
          createdAt,
          expiresAt,
        ],
      );
      await insertAudit(transaction, {
        id: input.auditEventId,
        projectId: scope.projectId,
        entityType: "receipt",
        entityId: receiptDigest,
        action: "receipt_issued",
        correlationId: input.correlationId,
        providerId: scope.providerId,
        modelId: scope.modelId,
        baseUrlDigest,
        requestFingerprint: scope.requestFingerprint,
        errorCode: null,
        metadata: {
          kind: scope.kind,
          sourceVersionId: scope.sourceVersionId,
          priceVersion: scope.priceVersion,
          expiresAt,
          dataCategories: scope.dataCategories,
        },
        createdAt,
      });
    });

    return Object.freeze({ token, receiptDigest, scopeFingerprint, expiresAt });
  }

  public async startRequest(
    input: StartGovernedExtensionRequestInput,
  ): Promise<{ readonly created: boolean; readonly request: GovernedExtensionRequest }> {
    validateStartInput(input);
    const snapshot = normalizeSnapshot(input.snapshot);
    const computedFingerprint = await computeGovernedExtensionRequestFingerprint(snapshot);
    if (computedFingerprint !== input.requestFingerprint) {
      throw invalid("The request fingerprint does not bind the canonical request snapshot.");
    }
    const expectedReservation = calculateMaximumCostMicros(snapshot);
    if (expectedReservation !== input.reservedCostMicros) {
      throw invalid("The reserved cost does not equal the fixed pricing snapshot maximum.");
    }
    const requestSnapshotJson = canonicalJson(snapshot);
    const now = nowIso(this.clock);
    if (input.monthKey !== now.slice(0, 7)) {
      throw invalid("The request budget month must match the attempt start time.");
    }
    const baseUrlDigest = await sha256Hex(snapshot.provider.baseUrl);

    return this.executor.transaction(async (transaction) => {
      const existing = await selectRequestByIdempotency(
        transaction,
        snapshot.projectId,
        snapshot.kind,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          throw new GovernedExtensionStoreError(
            "EXTENSION_IDEMPOTENCY_CONFLICT",
            "The idempotency key is already bound to a different request.",
          );
        }
        return { created: false, request: mapRequest(existing) };
      }
      const receiptDigest =
        snapshot.provider.location === "remote"
          ? await requireConsentDigest(input.consentToken)
          : null;

      await requireCurrentAuthority(
        transaction,
        snapshot.projectId,
        snapshot.chapterId,
        snapshot.sourceVersionId,
        snapshot.sourceChecksum,
      );
      const budget = await requireBudget(transaction, snapshot.projectId, input.monthKey);
      if (budget.currency !== snapshot.pricing.currency) {
        throw invalid("The request pricing currency does not match the project budget.");
      }
      if (budget.active_requests >= budget.maximum_concurrent) {
        throw new GovernedExtensionStoreError(
          "EXTENSION_CONCURRENCY_EXCEEDED",
          "The project creative-extension concurrency limit has been reached.",
          true,
          {
            activeRequests: budget.active_requests,
            maximumConcurrent: budget.maximum_concurrent,
          },
        );
      }
      if (
        budget.spent_micros + budget.reserved_micros + input.reservedCostMicros >
        budget.limit_micros
      ) {
        throw new GovernedExtensionStoreError(
          "EXTENSION_BUDGET_EXCEEDED",
          "The project budget cannot reserve this creative-extension attempt.",
          false,
          {
            limitMicros: budget.limit_micros,
            spentMicros: budget.spent_micros,
            reservedMicros: budget.reserved_micros,
            requestedMicros: input.reservedCostMicros,
          },
        );
      }

      await transaction.execute(
        `INSERT INTO governed_extension_requests (
           id, project_id, chapter_id, source_version_id, source_checksum,
           kind, attempt, retry_of_request_id, idempotency_key,
           request_fingerprint, request_snapshot_json, provider_location,
           provider_id, base_url, model_id, data_categories_json,
           input_micros_per_million_tokens, output_micros_per_million_tokens,
           currency, price_version, price_updated_at, maximum_input_tokens,
           maximum_output_tokens, reserved_cost_micros, timeout_ms,
           receipt_digest, status, revision, candidate_id, usage_source,
           input_tokens, output_tokens, cached_input_tokens,
           calculated_cost_micros, provider_receipt_digest,
           cancellation_requested, error_code, started_at, completed_at,
           created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, 'running', 1, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, 0, NULL, ?, NULL, ?, ?
         )`,
        [
          input.id,
          snapshot.projectId,
          snapshot.chapterId,
          snapshot.sourceVersionId,
          snapshot.sourceChecksum,
          snapshot.kind,
          input.attempt ?? 1,
          input.retryOfRequestId ?? null,
          input.idempotencyKey,
          input.requestFingerprint,
          requestSnapshotJson,
          snapshot.provider.location,
          snapshot.provider.providerId,
          snapshot.provider.baseUrl,
          snapshot.provider.modelId,
          canonicalJson([...snapshot.dataCategories]),
          snapshot.pricing.inputMicrosPerMillionTokens,
          snapshot.pricing.outputMicrosPerMillionTokens,
          snapshot.pricing.currency,
          snapshot.pricing.priceVersion,
          snapshot.pricing.priceUpdatedAt,
          snapshot.limits.maximumInputTokens,
          snapshot.limits.maximumOutputTokens,
          input.reservedCostMicros,
          snapshot.limits.timeoutMs,
          receiptDigest,
          now,
          now,
          now,
        ],
      );
      if (receiptDigest !== null) {
        await consumeReceipt(
          transaction,
          receiptDigest,
          consentScopeFromSnapshot(snapshot, input.requestFingerprint),
          input.id,
          now,
        );
      }
      await updateBudgetReservation(transaction, budget, input.reservedCostMicros, 1, now);
      await insertAudit(transaction, {
        id: input.auditEventId,
        projectId: snapshot.projectId,
        entityType: "request",
        entityId: input.id,
        action: "request_started",
        correlationId: input.correlationId,
        providerId: snapshot.provider.providerId,
        modelId: snapshot.provider.modelId,
        baseUrlDigest,
        requestFingerprint: input.requestFingerprint,
        errorCode: null,
        metadata: {
          kind: snapshot.kind,
          providerLocation: snapshot.provider.location,
          dataCategories: snapshot.dataCategories,
          sourceVersionId: snapshot.sourceVersionId,
          priceVersion: snapshot.pricing.priceVersion,
          reservedCostMicros: input.reservedCostMicros,
          costSemantics: "internal_estimate",
        },
        createdAt: now,
      });
      return {
        created: true,
        request: mapRequest(await requireRequestRow(transaction, input.id)),
      };
    });
  }

  public async completeRequest(
    input: CompleteGovernedExtensionRequestInput,
  ): Promise<GovernedExtensionRequest> {
    validateIdentifier(input.requestId, "requestId");
    validateIdentifier(input.candidateId, "candidateId");
    validateIdentifier(input.auditEventId, "auditEventId");
    validateIdentifier(input.correlationId, "correlationId");
    validateSha256(input.payloadChecksum, "payloadChecksum");
    validateProviderUsage(input.usage);
    if ((await sha256Hex(input.payloadJson)) !== input.payloadChecksum) {
      throw invalid("The candidate payload checksum does not match its exact bytes.");
    }
    const completedAt = nowIso(this.clock);
    let overage:
      | {
          readonly request: RequestRow;
          readonly costMicros: number;
        }
      | undefined;
    const completed = await this.executor.transaction(async (transaction) => {
      const request = await requireRunningRequest(
        transaction,
        input.requestId,
        input.expectedRevision,
      );
      validateCandidateAuthorityJson(input.payloadJson, request);
      const costMicros = calculateUsageCostMicros(request, input.usage);
      const providerReceiptDigest =
        input.usage.providerReceipt === undefined ||
        input.usage.providerReceipt === null ||
        input.usage.providerReceipt.length === 0
          ? null
          : await sha256Hex(input.usage.providerReceipt);
      const overReservation =
        input.usage.inputTokens > request.maximum_input_tokens ||
        input.usage.outputTokens > request.maximum_output_tokens ||
        costMicros > request.reserved_cost_micros;

      if (overReservation) {
        await terminalizeRequest(transaction, {
          request,
          status: "failed_final",
          errorCode: "EXTENSION_USAGE_OVER_RESERVATION",
          completedAt,
          usage: {
            source: "provider_reported",
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            cachedInputTokens: input.usage.cachedInputTokens,
            calculatedCostMicros: costMicros,
            providerReceiptDigest,
          },
        });
        await releaseReservationAndCharge(transaction, request, costMicros, completedAt);
        await insertRequestFailureAudit(
          transaction,
          request,
          input.auditEventId,
          input.correlationId,
          "EXTENSION_USAGE_OVER_RESERVATION",
          completedAt,
          costMicros,
          "internal_estimate",
        );
        overage = { request, costMicros };
        return mapRequest(await requireRequestRow(transaction, request.id));
      }

      await transaction.execute(
        `INSERT INTO governed_extension_candidates (
           id, request_id, project_id, chapter_id, source_version_id,
           source_checksum, kind, payload_json, payload_checksum, status,
           revision, formal_output_id, created_at, updated_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, NULL, ?, ?, NULL)`,
        [
          input.candidateId,
          request.id,
          request.project_id,
          request.chapter_id,
          request.source_version_id,
          request.source_checksum,
          request.kind,
          input.payloadJson,
          input.payloadChecksum,
          completedAt,
          completedAt,
        ],
      );
      const updated = await transaction.execute(
        `UPDATE governed_extension_requests
         SET status = 'candidate_ready', revision = revision + 1,
             candidate_id = ?, usage_source = 'provider_reported',
             input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
             calculated_cost_micros = ?, provider_receipt_digest = ?,
             completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND revision = ?`,
        [
          input.candidateId,
          input.usage.inputTokens,
          input.usage.outputTokens,
          input.usage.cachedInputTokens,
          costMicros,
          providerReceiptDigest,
          completedAt,
          completedAt,
          request.id,
          request.revision,
        ],
      );
      if (updated.rowsAffected !== 1) {
        throw revisionConflict(request.revision, request.revision + 1);
      }
      await releaseReservationAndCharge(transaction, request, costMicros, completedAt);
      await insertAudit(transaction, {
        id: input.auditEventId,
        projectId: request.project_id,
        entityType: "candidate",
        entityId: input.candidateId,
        action: "candidate_published",
        correlationId: input.correlationId,
        providerId: request.provider_id,
        modelId: request.model_id,
        baseUrlDigest: await sha256Hex(request.base_url),
        requestFingerprint: request.request_fingerprint,
        errorCode: null,
        metadata: {
          kind: request.kind,
          requestId: request.id,
          sourceVersionId: request.source_version_id,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          calculatedCostMicros: costMicros,
          costSemantics: "internal_estimate",
        },
        createdAt: completedAt,
      });
      return mapRequest(await requireRequestRow(transaction, request.id));
    });
    if (overage !== undefined) {
      const { request, costMicros } = overage;
      throw new GovernedExtensionStoreError(
        "EXTENSION_USAGE_OVER_RESERVATION",
        "Provider-reported usage exceeded the fixed attempt reservation; no candidate was published.",
        false,
        {
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          calculatedCostMicros: costMicros,
          reservedCostMicros: request.reserved_cost_micros,
        },
      );
    }
    return completed;
  }

  public async failRequest(
    input: FailGovernedExtensionRequestInput,
  ): Promise<GovernedExtensionRequest> {
    validateIdentifier(input.requestId, "requestId");
    validateIdentifier(input.auditEventId, "auditEventId");
    validateIdentifier(input.correlationId, "correlationId");
    validateErrorCode(input.errorCode);
    if (input.usage !== undefined && input.usage !== null) {
      validateProviderUsage(input.usage);
    }
    const completedAt = nowIso(this.clock);
    return this.executor.transaction(async (transaction) => {
      const request = await requireRunningRequest(
        transaction,
        input.requestId,
        input.expectedRevision,
      );
      const costMicros =
        input.usage === undefined || input.usage === null
          ? request.reserved_cost_micros
          : calculateUsageCostMicros(request, input.usage);
      const providerReceiptDigest =
        input.usage?.providerReceipt === undefined ||
        input.usage.providerReceipt === null ||
        input.usage.providerReceipt.length === 0
          ? null
          : await sha256Hex(input.usage.providerReceipt);
      await terminalizeRequest(transaction, {
        request,
        status: input.outcome,
        errorCode: input.errorCode,
        completedAt,
        usage:
          input.usage === undefined || input.usage === null
            ? {
                source: "provider_unavailable",
                inputTokens: null,
                outputTokens: null,
                cachedInputTokens: null,
                calculatedCostMicros: request.reserved_cost_micros,
                providerReceiptDigest,
              }
            : {
                source: "provider_reported",
                inputTokens: input.usage.inputTokens,
                outputTokens: input.usage.outputTokens,
                cachedInputTokens: input.usage.cachedInputTokens,
                calculatedCostMicros: costMicros,
                providerReceiptDigest,
              },
      });
      await releaseReservationAndCharge(transaction, request, costMicros, completedAt);
      await insertRequestFailureAudit(
        transaction,
        request,
        input.auditEventId,
        input.correlationId,
        input.errorCode,
        completedAt,
        costMicros,
        input.usage === undefined || input.usage === null
          ? "maximum_reserved_estimate"
          : "internal_estimate",
      );
      return mapRequest(await requireRequestRow(transaction, request.id));
    });
  }

  public async cancelRequest(input: {
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly auditEventId: string;
    readonly correlationId: string;
  }): Promise<GovernedExtensionRequest> {
    validateIdentifier(input.requestId, "requestId");
    validateIdentifier(input.auditEventId, "auditEventId");
    validateIdentifier(input.correlationId, "correlationId");
    const completedAt = nowIso(this.clock);
    return this.executor.transaction(async (transaction) => {
      const request = await requireRunningRequest(
        transaction,
        input.requestId,
        input.expectedRevision,
      );
      const updated = await transaction.execute(
        `UPDATE governed_extension_requests
         SET status = 'cancelled', revision = revision + 1,
             cancellation_requested = 1,
             usage_source = 'provider_unavailable',
             calculated_cost_micros = ?,
             error_code = 'EXTENSION_CANCELLED',
             completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND revision = ?`,
        [request.reserved_cost_micros, completedAt, completedAt, request.id, request.revision],
      );
      if (updated.rowsAffected !== 1) {
        throw revisionConflict(request.revision, request.revision + 1);
      }
      await releaseReservationAndCharge(
        transaction,
        request,
        request.reserved_cost_micros,
        completedAt,
      );
      await insertAudit(transaction, {
        id: input.auditEventId,
        projectId: request.project_id,
        entityType: "request",
        entityId: request.id,
        action: "request_cancelled",
        correlationId: input.correlationId,
        providerId: request.provider_id,
        modelId: request.model_id,
        baseUrlDigest: await sha256Hex(request.base_url),
        requestFingerprint: request.request_fingerprint,
        errorCode: "EXTENSION_CANCELLED",
        metadata: {
          kind: request.kind,
          sourceVersionId: request.source_version_id,
          usageSource: "provider_unavailable",
          calculatedCostMicros: request.reserved_cost_micros,
          costSemantics: "maximum_reserved_estimate",
        },
        createdAt: completedAt,
      });
      return mapRequest(await requireRequestRow(transaction, request.id));
    });
  }

  public async acceptCandidate(
    input: AcceptGovernedExtensionCandidateInput,
  ): Promise<AcceptGovernedExtensionCandidateResult> {
    validateDecisionInput(input);
    validateIdentifier(input.formalOutputId, "formalOutputId");
    const decidedAt = input.decidedAt ?? nowIso(this.clock);
    validateCanonicalTimestamp(decidedAt, "decidedAt");

    return this.executor.transaction(async (transaction) => {
      const candidate = await requireReadyCandidate(
        transaction,
        input.candidateId,
        input.expectedRevision,
      );
      const current = await requireCurrentChapterAuthority(
        transaction,
        candidate.project_id,
        candidate.chapter_id,
      );
      if (
        current.current_version_id !== candidate.source_version_id ||
        current.content_checksum !== candidate.source_checksum
      ) {
        const expired = await decideCandidateRow(
          transaction,
          candidate,
          "expired",
          null,
          decidedAt,
        );
        await insertCandidateDecisionAudit(
          transaction,
          candidate,
          input.auditEventId,
          input.correlationId,
          "candidate_expire",
          "CANDIDATE_STALE",
          decidedAt,
        );
        return {
          outcome: "expired",
          candidate: mapCandidate(expired),
          errorCode: "CANDIDATE_STALE",
        };
      }

      const parsed = parseFormalCandidatePayload(candidate.payload_json, candidate.kind);
      await insertCandidateDecisionAudit(
        transaction,
        candidate,
        input.auditEventId,
        input.correlationId,
        "candidate_accept",
        null,
        decidedAt,
      );
      if (parsed.kind === "translation") {
        await transaction.execute(
          `INSERT INTO chapter_translations (
             id, candidate_id, accept_audit_event_id, project_id, chapter_id,
             source_version_id, source_checksum, target_language_code,
             target_language_label, tone, glossary_version, payload_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.formalOutputId,
            candidate.id,
            input.auditEventId,
            candidate.project_id,
            candidate.chapter_id,
            candidate.source_version_id,
            candidate.source_checksum,
            parsed.targetLanguageCode,
            parsed.targetLanguageLabel,
            parsed.tone,
            parsed.glossaryVersion,
            candidate.payload_json,
            decidedAt,
          ],
        );
      } else {
        await transaction.execute(
          `INSERT INTO short_drama_scripts (
             id, candidate_id, accept_audit_event_id, project_id, chapter_id,
             source_version_id, source_checksum, title, format, payload_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.formalOutputId,
            candidate.id,
            input.auditEventId,
            candidate.project_id,
            candidate.chapter_id,
            candidate.source_version_id,
            candidate.source_checksum,
            parsed.title,
            parsed.format,
            candidate.payload_json,
            decidedAt,
          ],
        );
      }
      const accepted = await decideCandidateRow(
        transaction,
        candidate,
        "accepted",
        input.formalOutputId,
        decidedAt,
      );
      return {
        outcome: "accepted",
        candidate: mapCandidate(accepted),
        formalOutputId: input.formalOutputId,
      };
    });
  }

  public async rejectCandidate(
    input: DecideGovernedExtensionCandidateInput,
  ): Promise<GovernedExtensionCandidate> {
    return this.decideCandidate(input, "rejected");
  }

  public async expireCandidate(
    input: DecideGovernedExtensionCandidateInput,
  ): Promise<GovernedExtensionCandidate> {
    return this.decideCandidate(input, "expired");
  }

  public async getRequest(requestId: string): Promise<GovernedExtensionRequest | null> {
    validateIdentifier(requestId, "requestId");
    const rows = await this.executor.select<RequestRow>(`${REQUEST_SELECT} WHERE id = ?`, [
      requestId,
    ]);
    return rows[0] === undefined ? null : mapRequest(rows[0]);
  }

  public async getCandidate(candidateId: string): Promise<GovernedExtensionCandidate | null> {
    validateIdentifier(candidateId, "candidateId");
    const rows = await this.executor.select<CandidateRow>(`${CANDIDATE_SELECT} WHERE id = ?`, [
      candidateId,
    ]);
    return rows[0] === undefined ? null : mapCandidate(rows[0]);
  }

  public async listRequests(input: {
    readonly projectId: string;
    readonly kind?: GovernedExtensionKind;
    readonly limit?: number;
  }): Promise<readonly GovernedExtensionRequest[]> {
    validateIdentifier(input.projectId, "projectId");
    const limit = input.limit ?? 100;
    validateSafeInteger(limit, 1, 500, "limit");
    const rows =
      input.kind === undefined
        ? await this.executor.select<RequestRow>(
            `${REQUEST_SELECT}
             WHERE project_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [input.projectId, limit],
          )
        : await this.executor.select<RequestRow>(
            `${REQUEST_SELECT}
             WHERE project_id = ? AND kind = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [input.projectId, input.kind, limit],
          );
    return Object.freeze(rows.map(mapRequest));
  }

  public async listCandidates(input: {
    readonly projectId: string;
    readonly kind?: GovernedExtensionKind;
    readonly limit?: number;
  }): Promise<readonly GovernedExtensionCandidate[]> {
    validateIdentifier(input.projectId, "projectId");
    const limit = input.limit ?? 100;
    validateSafeInteger(limit, 1, 500, "limit");
    const rows =
      input.kind === undefined
        ? await this.executor.select<CandidateRow>(
            `${CANDIDATE_SELECT}
             WHERE project_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [input.projectId, limit],
          )
        : await this.executor.select<CandidateRow>(
            `${CANDIDATE_SELECT}
             WHERE project_id = ? AND kind = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [input.projectId, input.kind, limit],
          );
    return Object.freeze(rows.map(mapCandidate));
  }

  /**
   * Releases reservations left by a process crash. No request is resumed with
   * an old plaintext scope or consent receipt; the user must retry explicitly.
   */
  public async recoverOrphanedReservations(input: {
    readonly staleBefore: string;
    readonly auditIdForRequest: (requestId: string) => string;
    readonly correlationId: string;
  }): Promise<number> {
    validateCanonicalTimestamp(input.staleBefore, "staleBefore");
    validateIdentifier(input.correlationId, "correlationId");
    const recoveredAt = nowIso(this.clock);
    return this.executor.transaction(async (transaction) => {
      const rows = await transaction.select<RequestRow>(
        `${REQUEST_SELECT}
         WHERE status = 'running' AND updated_at <= ?
         ORDER BY updated_at, id`,
        [input.staleBefore],
      );
      for (const request of rows) {
        const auditId = input.auditIdForRequest(request.id);
        validateIdentifier(auditId, "recovery audit id");
        await terminalizeRequest(transaction, {
          request,
          status: "failed_retryable",
          errorCode: "EXTENSION_PROCESS_RESTARTED",
          completedAt: recoveredAt,
          usage: {
            source: "provider_unavailable",
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            calculatedCostMicros: request.reserved_cost_micros,
            providerReceiptDigest: null,
          },
        });
        await releaseReservationAndCharge(
          transaction,
          request,
          request.reserved_cost_micros,
          recoveredAt,
        );
        await insertAudit(transaction, {
          id: auditId,
          projectId: request.project_id,
          entityType: "request",
          entityId: request.id,
          action: "reservation_recovered",
          correlationId: input.correlationId,
          providerId: request.provider_id,
          modelId: request.model_id,
          baseUrlDigest: await sha256Hex(request.base_url),
          requestFingerprint: request.request_fingerprint,
          errorCode: "EXTENSION_PROCESS_RESTARTED",
          metadata: {
            kind: request.kind,
            sourceVersionId: request.source_version_id,
            calculatedCostMicros: request.reserved_cost_micros,
            costSemantics: "maximum_reserved_estimate",
          },
          createdAt: recoveredAt,
        });
      }
      return rows.length;
    });
  }

  private async decideCandidate(
    input: DecideGovernedExtensionCandidateInput,
    status: "rejected" | "expired",
  ): Promise<GovernedExtensionCandidate> {
    validateDecisionInput(input);
    const decidedAt = input.decidedAt ?? nowIso(this.clock);
    validateCanonicalTimestamp(decidedAt, "decidedAt");
    return this.executor.transaction(async (transaction) => {
      const candidate = await requireReadyCandidate(
        transaction,
        input.candidateId,
        input.expectedRevision,
      );
      const decided = await decideCandidateRow(transaction, candidate, status, null, decidedAt);
      await insertCandidateDecisionAudit(
        transaction,
        candidate,
        input.auditEventId,
        input.correlationId,
        status === "rejected" ? "candidate_reject" : "candidate_expire",
        null,
        decidedAt,
      );
      return mapCandidate(decided);
    });
  }
}

export async function computeGovernedExtensionRequestFingerprint(
  snapshot: GovernedExtensionRequestSnapshot,
): Promise<string> {
  return sha256Hex(
    `inkshadow/governed-extension-request/v1\u0000${canonicalJson(normalizeSnapshot(snapshot))}`,
  );
}

export async function computeGovernedExtensionConsentScopeFingerprint(
  scope: GovernedExtensionConsentScope,
): Promise<string> {
  validateConsentScope(scope);
  return sha256Hex(
    `inkshadow/governed-extension-consent/v1\u0000${canonicalJson({
      ...scope,
      dataCategories: [...scope.dataCategories],
    })}`,
  );
}

export function calculateMaximumCostMicros(snapshot: GovernedExtensionRequestSnapshot): number {
  const normalized = normalizeSnapshot(snapshot);
  return calculateCost(
    normalized.limits.maximumInputTokens,
    normalized.limits.maximumOutputTokens,
    normalized.pricing.inputMicrosPerMillionTokens,
    normalized.pricing.outputMicrosPerMillionTokens,
  );
}

function normalizeSnapshot(
  snapshot: GovernedExtensionRequestSnapshot,
): GovernedExtensionRequestSnapshot {
  validateSnapshot(snapshot);
  const common = {
    schemaVersion: 1 as const,
    projectId: snapshot.projectId,
    chapterId: snapshot.chapterId,
    sourceVersionId: snapshot.sourceVersionId,
    sourceChecksum: snapshot.sourceChecksum,
    sourceText: snapshot.sourceText,
    provider: Object.freeze({ ...snapshot.provider }),
    dataCategories: Object.freeze([...snapshot.dataCategories]),
    pricing: Object.freeze({ ...snapshot.pricing }),
    limits: Object.freeze({ ...snapshot.limits }),
  };
  if (snapshot.kind === "translation") {
    return Object.freeze({
      ...common,
      kind: "translation",
      settings: Object.freeze({
        targetLanguage: Object.freeze({ ...snapshot.settings.targetLanguage }),
        tone: snapshot.settings.tone,
        glossaryVersion: snapshot.settings.glossaryVersion,
        glossary: Object.freeze(
          snapshot.settings.glossary.map((entry) => Object.freeze({ ...entry })),
        ),
      }),
    });
  }
  return Object.freeze({
    ...common,
    kind: "short_drama",
    settings: Object.freeze({ ...snapshot.settings }),
  });
}

function validateSnapshot(snapshot: GovernedExtensionRequestSnapshot): void {
  const untrustedHeader = snapshot as {
    readonly schemaVersion: unknown;
    readonly kind: unknown;
  };
  if (
    untrustedHeader.schemaVersion !== 1 ||
    typeof untrustedHeader.kind !== "string" ||
    !GOVERNED_EXTENSION_KINDS.includes(untrustedHeader.kind as GovernedExtensionKind)
  ) {
    throw invalid("The creative-extension request schema or kind is unsupported.");
  }
  validateIdentifier(snapshot.projectId, "projectId");
  validateIdentifier(snapshot.chapterId, "chapterId");
  validateIdentifier(snapshot.sourceVersionId, "sourceVersionId");
  validateSha256(snapshot.sourceChecksum, "sourceChecksum");
  validateText(snapshot.sourceText, 0, 5_000_000, "sourceText", {
    allowLineBreaks: true,
  });
  assertProviderUrl(snapshot.provider.baseUrl, snapshot.provider.location);
  validateText(snapshot.provider.providerId, 1, 128, "providerId");
  validateText(snapshot.provider.modelId, 1, 512, "modelId");
  validateDataCategories(snapshot.kind, snapshot.dataCategories);
  validateSafeInteger(
    snapshot.pricing.inputMicrosPerMillionTokens,
    0,
    9_000_000_000_000_000,
    "inputMicrosPerMillionTokens",
  );
  validateSafeInteger(
    snapshot.pricing.outputMicrosPerMillionTokens,
    0,
    9_000_000_000_000_000,
    "outputMicrosPerMillionTokens",
  );
  validateCurrency(snapshot.pricing.currency);
  validateText(snapshot.pricing.priceVersion, 1, 128, "priceVersion");
  validateCanonicalTimestamp(snapshot.pricing.priceUpdatedAt, "priceUpdatedAt");
  validateSafeInteger(snapshot.limits.maximumInputTokens, 1, 10_000_000, "maximumInputTokens");
  validateSafeInteger(snapshot.limits.maximumOutputTokens, 1, 10_000_000, "maximumOutputTokens");
  validateSafeInteger(snapshot.limits.timeoutMs, 1_000, 3_600_000, "timeoutMs");

  if (snapshot.kind === "translation") {
    validateText(snapshot.settings.targetLanguage.code, 2, 32, "targetLanguage.code");
    if (!LANGUAGE_CODE_PATTERN.test(snapshot.settings.targetLanguage.code)) {
      throw invalid("The target language code is not canonical BCP-47.");
    }
    validateText(snapshot.settings.targetLanguage.label, 1, 80, "targetLanguage.label");
    validateText(snapshot.settings.tone, 1, 120, "translation tone");
    validateIdentifier(snapshot.settings.glossaryVersion, "glossaryVersion");
    if (snapshot.settings.glossary.length > 2_000) {
      throw invalid("The translation glossary exceeds its entry boundary.");
    }
    const sources = new Set<string>();
    for (const entry of snapshot.settings.glossary) {
      validateText(entry.source, 1, 160, "glossary source");
      validateText(entry.target, 1, 160, "glossary target");
      if (entry.note !== null) {
        validateText(entry.note, 1, 1_000, "glossary note");
      }
      if (sources.has(entry.source)) {
        throw invalid("The translation glossary contains duplicate source terms.");
      }
      sources.add(entry.source);
    }
  } else {
    const untrustedFormat: unknown = snapshot.settings.format;
    if (untrustedFormat !== "vertical_micro_drama" && untrustedFormat !== "standard_short_drama") {
      throw invalid("The short-drama format is unsupported.");
    }
    validateSafeInteger(snapshot.settings.targetEpisodeCount, 1, 24, "targetEpisodeCount");
    validateSafeInteger(
      snapshot.settings.targetEpisodeDurationSeconds,
      30,
      7_200,
      "targetEpisodeDurationSeconds",
    );
    validateText(snapshot.settings.tone, 1, 120, "short-drama tone");
  }
}

function validateStartInput(input: StartGovernedExtensionRequestInput): void {
  validateIdentifier(input.id, "id");
  validateIdentifier(input.idempotencyKey, "idempotencyKey");
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
    throw invalid("The request idempotency key is outside its boundary.");
  }
  validateSha256(input.requestFingerprint, "requestFingerprint");
  validateSafeInteger(input.reservedCostMicros, 0, Number.MAX_SAFE_INTEGER, "reservedCostMicros");
  validateMonthKey(input.monthKey);
  validateIdentifier(input.auditEventId, "auditEventId");
  validateIdentifier(input.correlationId, "correlationId");
  const attempt = input.attempt ?? 1;
  validateSafeInteger(attempt, 1, 100, "attempt");
  if (
    (attempt === 1) !==
    (input.retryOfRequestId === undefined || input.retryOfRequestId === null)
  ) {
    throw invalid("Retry requests must bind the immediately preceding attempt.");
  }
  if (input.retryOfRequestId !== undefined && input.retryOfRequestId !== null) {
    validateIdentifier(input.retryOfRequestId, "retryOfRequestId");
  }
}

function validateConsentScope(scope: GovernedExtensionConsentScope): void {
  if (!GOVERNED_EXTENSION_KINDS.includes(scope.kind)) {
    throw invalid("The consent scope kind is unsupported.");
  }
  validateText(scope.providerId, 1, 128, "providerId");
  validateText(scope.modelId, 1, 512, "modelId");
  validateIdentifier(scope.projectId, "projectId");
  validateIdentifier(scope.chapterId, "chapterId");
  validateIdentifier(scope.sourceVersionId, "sourceVersionId");
  validateText(scope.priceVersion, 1, 128, "priceVersion");
  validateSha256(scope.requestFingerprint, "requestFingerprint");
  validateDataCategories(scope.kind, scope.dataCategories);
}

function validateDataCategories(
  kind: GovernedExtensionKind,
  categories: readonly GovernedExtensionDataCategory[],
): void {
  const expected =
    kind === "translation"
      ? ["chapter_text", "glossary", "translation_settings"]
      : ["chapter_text", "short_drama_settings"];
  if (
    categories.length !== expected.length ||
    categories.some((category, index) => category !== expected[index])
  ) {
    throw invalid("Data categories must be exact, sorted and purpose-bound.");
  }
}

function consentScopeFromSnapshot(
  snapshot: GovernedExtensionRequestSnapshot,
  requestFingerprint: string,
): GovernedExtensionConsentScope {
  return {
    kind: snapshot.kind,
    providerId: snapshot.provider.providerId,
    baseUrl: snapshot.provider.baseUrl,
    modelId: snapshot.provider.modelId,
    dataCategories: snapshot.dataCategories,
    projectId: snapshot.projectId,
    chapterId: snapshot.chapterId,
    sourceVersionId: snapshot.sourceVersionId,
    priceVersion: snapshot.pricing.priceVersion,
    requestFingerprint,
  };
}

async function consumeReceipt(
  transaction: TransactionExecutor,
  digest: string,
  scope: GovernedExtensionConsentScope,
  requestId: string,
  consumedAt: string,
): Promise<void> {
  const rows = await transaction.select<ReceiptRow>(
    `SELECT receipt_digest, kind, provider_id, base_url, model_id,
            data_categories_json, project_id, chapter_id, source_version_id,
            price_version, request_fingerprint, scope_fingerprint, request_id,
            created_at, expires_at, consumed_at
     FROM governed_extension_egress_receipts
     WHERE receipt_digest = ?`,
    [digest],
  );
  const receipt = rows[0];
  if (receipt === undefined) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_RECEIPT_INVALID",
      "The remote egress confirmation is invalid.",
    );
  }
  if (receipt.consumed_at !== null || receipt.request_id !== null) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_RECEIPT_REPLAYED",
      "The remote egress confirmation has already been consumed.",
    );
  }
  if (receipt.expires_at <= consumedAt) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_RECEIPT_EXPIRED",
      "The remote egress confirmation has expired.",
    );
  }
  const expectedScopeFingerprint = await computeGovernedExtensionConsentScopeFingerprint(scope);
  if (
    receipt.scope_fingerprint !== expectedScopeFingerprint ||
    receipt.kind !== scope.kind ||
    receipt.provider_id !== scope.providerId ||
    receipt.base_url !== scope.baseUrl ||
    receipt.model_id !== scope.modelId ||
    receipt.data_categories_json !== canonicalJson([...scope.dataCategories]) ||
    receipt.project_id !== scope.projectId ||
    receipt.chapter_id !== scope.chapterId ||
    receipt.source_version_id !== scope.sourceVersionId ||
    receipt.price_version !== scope.priceVersion ||
    receipt.request_fingerprint !== scope.requestFingerprint
  ) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_RECEIPT_PURPOSE_MISMATCH",
      "The remote egress confirmation does not match this exact destination and source snapshot.",
    );
  }
  const result = await transaction.execute(
    `UPDATE governed_extension_egress_receipts
     SET request_id = ?, consumed_at = ?
     WHERE receipt_digest = ? AND consumed_at IS NULL AND request_id IS NULL`,
    [requestId, consumedAt, digest],
  );
  if (result.rowsAffected !== 1) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_RECEIPT_REPLAYED",
      "The remote egress confirmation was consumed concurrently.",
    );
  }
}

async function requireConsentDigest(token: string | undefined): Promise<string> {
  if (token === undefined || token.length < 40 || token.length > 200) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_RECEIPT_REQUIRED",
      "A fresh explicit remote egress confirmation is required.",
    );
  }
  return sha256Hex(token);
}

async function requireCurrentAuthority(
  transaction: TransactionExecutor,
  projectId: string,
  chapterId: string,
  sourceVersionId: string,
  sourceChecksum?: string,
): Promise<CurrentChapterAuthorityRow> {
  const current = await requireCurrentChapterAuthority(transaction, projectId, chapterId);
  if (
    current.current_version_id !== sourceVersionId ||
    (sourceChecksum !== undefined && current.content_checksum !== sourceChecksum)
  ) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_CANDIDATE_STALE",
      "The source chapter version changed.",
      false,
      {
        expectedVersionId: sourceVersionId,
        actualVersionId: current.current_version_id,
      },
    );
  }
  return current;
}

async function requireCurrentChapterAuthority(
  transaction: TransactionExecutor,
  projectId: string,
  chapterId: string,
): Promise<CurrentChapterAuthorityRow> {
  const rows = await transaction.select<CurrentChapterAuthorityRow>(
    `SELECT chapter.current_version_id, version.content_checksum
     FROM chapters AS chapter
     INNER JOIN chapter_versions AS version
       ON version.id = chapter.current_version_id
      AND version.chapter_id = chapter.id
      AND version.project_id = chapter.project_id
     WHERE chapter.project_id = ? AND chapter.id = ?`,
    [projectId, chapterId],
  );
  const current = rows[0];
  if (current === undefined) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_NOT_FOUND",
      "The source chapter or current version does not exist.",
    );
  }
  return current;
}

async function selectRequestByIdempotency(
  transaction: TransactionExecutor,
  projectId: string,
  kind: GovernedExtensionKind,
  idempotencyKey: string,
): Promise<RequestRow | null> {
  const rows = await transaction.select<RequestRow>(
    `${REQUEST_SELECT}
     WHERE project_id = ? AND kind = ? AND idempotency_key = ?`,
    [projectId, kind, idempotencyKey],
  );
  return rows[0] ?? null;
}

async function requireRequestRow(
  transaction: TransactionExecutor,
  requestId: string,
): Promise<RequestRow> {
  const rows = await transaction.select<RequestRow>(`${REQUEST_SELECT} WHERE id = ?`, [requestId]);
  const row = rows[0];
  if (row === undefined) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_NOT_FOUND",
      "The creative-extension request does not exist.",
    );
  }
  return row;
}

async function requireRunningRequest(
  transaction: TransactionExecutor,
  requestId: string,
  expectedRevision: number,
): Promise<RequestRow> {
  validateSafeInteger(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1, "expectedRevision");
  const row = await requireRequestRow(transaction, requestId);
  if (row.revision !== expectedRevision || row.status !== "running") {
    throw revisionConflict(expectedRevision, row.revision);
  }
  return row;
}

async function requireReadyCandidate(
  transaction: TransactionExecutor,
  candidateId: string,
  expectedRevision: number,
): Promise<CandidateRow> {
  validateSafeInteger(expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1, "expectedRevision");
  const rows = await transaction.select<CandidateRow>(`${CANDIDATE_SELECT} WHERE id = ?`, [
    candidateId,
  ]);
  const row = rows[0];
  if (row === undefined) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_NOT_FOUND",
      "The creative-extension candidate does not exist.",
    );
  }
  if (row.revision !== expectedRevision || row.status !== "ready") {
    throw revisionConflict(expectedRevision, row.revision);
  }
  return row;
}

async function selectBudget(
  transaction: TransactionExecutor,
  projectId: string,
  monthKey: string,
): Promise<BudgetRow | null> {
  const rows = await transaction.select<BudgetRow>(
    `SELECT project_id, month_key, currency, limit_micros, spent_micros,
            reserved_micros, active_requests, maximum_concurrent, revision,
            created_at, updated_at
     FROM governed_extension_budgets
     WHERE project_id = ? AND month_key = ?`,
    [projectId, monthKey],
  );
  return rows[0] ?? null;
}

async function requireBudget(
  transaction: TransactionExecutor,
  projectId: string,
  monthKey: string,
): Promise<BudgetRow> {
  const budget = await selectBudget(transaction, projectId, monthKey);
  if (budget === null) {
    throw new GovernedExtensionStoreError(
      "EXTENSION_BUDGET_NOT_CONFIGURED",
      "A project budget must be configured before starting this provider request.",
    );
  }
  return budget;
}

async function updateBudgetReservation(
  transaction: TransactionExecutor,
  budget: BudgetRow,
  reservedDelta: number,
  activeDelta: number,
  updatedAt: string,
): Promise<void> {
  const reserved = budget.reserved_micros + reservedDelta;
  const active = budget.active_requests + activeDelta;
  if (reserved < 0 || active < 0 || !Number.isSafeInteger(reserved)) {
    throw repositoryError("The project reservation ledger is inconsistent.");
  }
  const result = await transaction.execute(
    `UPDATE governed_extension_budgets
     SET reserved_micros = ?, active_requests = ?, revision = revision + 1,
         updated_at = ?
     WHERE project_id = ? AND month_key = ? AND revision = ?`,
    [reserved, active, updatedAt, budget.project_id, budget.month_key, budget.revision],
  );
  if (result.rowsAffected !== 1) {
    throw revisionConflict(budget.revision, budget.revision + 1);
  }
}

async function releaseReservationAndCharge(
  transaction: TransactionExecutor,
  request: RequestRow,
  costMicros: number,
  updatedAt: string,
): Promise<void> {
  const monthKey = request.created_at.slice(0, 7);
  const budget = await requireBudget(transaction, request.project_id, monthKey);
  if (budget.reserved_micros < request.reserved_cost_micros || budget.active_requests < 1) {
    throw repositoryError("The project reservation ledger cannot release this attempt.");
  }
  const spent = budget.spent_micros + costMicros;
  if (!Number.isSafeInteger(spent) || spent > Number.MAX_SAFE_INTEGER) {
    throw repositoryError("The project usage ledger exceeded the portable integer boundary.");
  }
  const result = await transaction.execute(
    `UPDATE governed_extension_budgets
     SET spent_micros = ?, reserved_micros = reserved_micros - ?,
         active_requests = active_requests - 1, revision = revision + 1,
         updated_at = ?
     WHERE project_id = ? AND month_key = ? AND revision = ?
       AND reserved_micros >= ? AND active_requests >= 1`,
    [
      spent,
      request.reserved_cost_micros,
      updatedAt,
      budget.project_id,
      budget.month_key,
      budget.revision,
      request.reserved_cost_micros,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw repositoryError("The project reservation changed concurrently.");
  }
}

async function terminalizeRequest(
  transaction: TransactionExecutor,
  input: {
    readonly request: RequestRow;
    readonly status: "failed_retryable" | "failed_final";
    readonly errorCode: string;
    readonly completedAt: string;
    readonly usage:
      | {
          readonly source: "provider_reported";
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly cachedInputTokens: number | null;
          readonly calculatedCostMicros: number;
          readonly providerReceiptDigest: string | null;
        }
      | {
          readonly source: "provider_unavailable";
          readonly inputTokens: null;
          readonly outputTokens: null;
          readonly cachedInputTokens: null;
          readonly calculatedCostMicros: number;
          readonly providerReceiptDigest: string | null;
        };
  },
): Promise<void> {
  const result = await transaction.execute(
    `UPDATE governed_extension_requests
     SET status = ?, revision = revision + 1, usage_source = ?,
         input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
         calculated_cost_micros = ?, provider_receipt_digest = ?,
         error_code = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND revision = ?`,
    [
      input.status,
      input.usage.source,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.cachedInputTokens,
      input.usage.calculatedCostMicros,
      input.usage.providerReceiptDigest,
      input.errorCode,
      input.completedAt,
      input.completedAt,
      input.request.id,
      input.request.revision,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw revisionConflict(input.request.revision, input.request.revision + 1);
  }
}

async function decideCandidateRow(
  transaction: TransactionExecutor,
  candidate: CandidateRow,
  status: "accepted" | "rejected" | "expired",
  formalOutputId: string | null,
  decidedAt: string,
): Promise<CandidateRow> {
  const result = await transaction.execute(
    `UPDATE governed_extension_candidates
     SET status = ?, revision = revision + 1, formal_output_id = ?,
         decided_at = ?, updated_at = ?
     WHERE id = ? AND status = 'ready' AND revision = ?`,
    [status, formalOutputId, decidedAt, decidedAt, candidate.id, candidate.revision],
  );
  if (result.rowsAffected !== 1) {
    throw revisionConflict(candidate.revision, candidate.revision + 1);
  }
  const rows = await transaction.select<CandidateRow>(`${CANDIDATE_SELECT} WHERE id = ?`, [
    candidate.id,
  ]);
  const row = rows[0];
  if (row === undefined) {
    throw repositoryError("The decided candidate disappeared.");
  }
  return row;
}

function calculateUsageCostMicros(
  request: RequestRow,
  usage: ProviderReportedExtensionUsage,
): number {
  return calculateCost(
    usage.inputTokens,
    usage.outputTokens,
    request.input_micros_per_million_tokens,
    request.output_micros_per_million_tokens,
  );
}

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputMicrosPerMillion: number,
  outputMicrosPerMillion: number,
): number {
  const total =
    (BigInt(inputTokens) * BigInt(inputMicrosPerMillion) +
      BigInt(outputTokens) * BigInt(outputMicrosPerMillion) +
      999_999n) /
    1_000_000n;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid("The calculated internal cost exceeds the portable integer boundary.");
  }
  return Number(total);
}

function validateProviderUsage(usage: ProviderReportedExtensionUsage): void {
  validateSafeInteger(usage.inputTokens, 0, 100_000_000, "inputTokens");
  validateSafeInteger(usage.outputTokens, 0, 100_000_000, "outputTokens");
  if (usage.cachedInputTokens !== null) {
    validateSafeInteger(usage.cachedInputTokens, 0, usage.inputTokens, "cachedInputTokens");
  }
  if (usage.providerReceipt !== undefined && usage.providerReceipt !== null) {
    validateText(usage.providerReceipt, 1, 16_384, "providerReceipt");
  }
}

function validateCandidateAuthorityJson(payloadJson: string, request: RequestRow): void {
  validateText(payloadJson, 2, 1_000_000, "payloadJson", {
    allowLineBreaks: true,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw invalid("The candidate payload is not valid JSON.");
  }
  const root = requireRecord(parsed, "candidate payload");
  const source = requireRecord(root.source, "candidate source");
  if (
    root.schemaVersion !== 1 ||
    root.kind !== request.kind ||
    source.chapterId !== request.chapter_id ||
    source.sourceVersionId !== request.source_version_id ||
    source.sourceChecksum !== request.source_checksum
  ) {
    throw invalid("The candidate payload does not bind the request source authority.");
  }
}

function parseFormalCandidatePayload(
  payloadJson: string,
  kind: string,
):
  | {
      readonly kind: "translation";
      readonly targetLanguageCode: string;
      readonly targetLanguageLabel: string;
      readonly tone: string;
      readonly glossaryVersion: string;
    }
  | {
      readonly kind: "short_drama";
      readonly title: string;
      readonly format: "vertical_micro_drama" | "standard_short_drama";
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw repositoryError("The stored candidate payload is corrupt.");
  }
  const root = requireRecord(parsed, "stored candidate");
  if (kind === "translation" && root.kind === "translation") {
    const targetLanguage = requireRecord(root.targetLanguage, "stored target language");
    const code = requireStoredText(targetLanguage.code, 2, 32);
    const label = requireStoredText(targetLanguage.label, 1, 80);
    const tone = requireStoredText(root.tone, 1, 120);
    const glossaryVersion = requireStoredText(root.glossaryVersion, 1, 256);
    return {
      kind: "translation",
      targetLanguageCode: code,
      targetLanguageLabel: label,
      tone,
      glossaryVersion,
    };
  }
  if (
    kind === "short_drama" &&
    root.kind === "short_drama" &&
    (root.format === "vertical_micro_drama" || root.format === "standard_short_drama")
  ) {
    return {
      kind: "short_drama",
      title: requireStoredText(root.title, 1, 240),
      format: root.format,
    };
  }
  throw repositoryError("The stored candidate kind is inconsistent.");
}

function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${field} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireStoredText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw repositoryError("A stored candidate field is corrupt.");
  }
  return value;
}

function validateDecisionInput(input: DecideGovernedExtensionCandidateInput): void {
  validateIdentifier(input.candidateId, "candidateId");
  validateSafeInteger(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1, "expectedRevision");
  validateIdentifier(input.auditEventId, "auditEventId");
  validateIdentifier(input.correlationId, "correlationId");
}

function mapRequest(row: RequestRow): GovernedExtensionRequest {
  const location = parseEnum(
    row.provider_location,
    ["loopback", "remote"],
    "request provider location",
  );
  const kind = parseEnum(row.kind, GOVERNED_EXTENSION_KINDS, "request kind");
  const status = parseEnum(
    row.status,
    ["running", "candidate_ready", "cancelled", "failed_retryable", "failed_final"],
    "request status",
  );
  let usage: GovernedExtensionRequest["usage"] = null;
  if (row.usage_source === "provider_reported") {
    if (
      row.input_tokens === null ||
      row.output_tokens === null ||
      row.calculated_cost_micros === null
    ) {
      throw repositoryError("Provider-reported request usage is incomplete.");
    }
    usage = Object.freeze({
      source: "provider_reported",
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedInputTokens: row.cached_input_tokens,
      calculatedCostMicros: row.calculated_cost_micros,
      providerReceiptDigest: row.provider_receipt_digest,
    });
  } else if (row.usage_source === "provider_unavailable") {
    if (row.calculated_cost_micros === null) {
      throw repositoryError("Provider-unavailable request settlement is incomplete.");
    }
    usage = Object.freeze({
      source: "provider_unavailable",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      calculatedCostMicros: row.calculated_cost_micros,
      providerReceiptDigest: row.provider_receipt_digest,
    });
  } else if (row.usage_source !== null) {
    throw repositoryError("The stored request usage source is invalid.");
  }
  const dataCategories = parseDataCategories(row.data_categories_json, kind);
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    sourceVersionId: row.source_version_id,
    sourceChecksum: row.source_checksum,
    kind,
    attempt: row.attempt,
    retryOfRequestId: row.retry_of_request_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    requestSnapshotJson: row.request_snapshot_json,
    providerLocation: location,
    providerId: row.provider_id,
    baseUrl: row.base_url,
    modelId: row.model_id,
    dataCategories,
    pricing: Object.freeze({
      inputMicrosPerMillionTokens: row.input_micros_per_million_tokens,
      outputMicrosPerMillionTokens: row.output_micros_per_million_tokens,
      currency: row.currency,
      priceVersion: row.price_version,
      priceUpdatedAt: row.price_updated_at,
    }),
    limits: Object.freeze({
      maximumInputTokens: row.maximum_input_tokens,
      maximumOutputTokens: row.maximum_output_tokens,
      timeoutMs: row.timeout_ms,
    }),
    reservedCostMicros: row.reserved_cost_micros,
    status,
    revision: row.revision,
    candidateId: row.candidate_id,
    usage,
    cancellationRequested: row.cancellation_requested === 1,
    errorCode: row.error_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapCandidate(row: CandidateRow): GovernedExtensionCandidate {
  return Object.freeze({
    id: row.id,
    requestId: row.request_id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    sourceVersionId: row.source_version_id,
    sourceChecksum: row.source_checksum,
    kind: parseEnum(row.kind, GOVERNED_EXTENSION_KINDS, "candidate kind"),
    payloadJson: row.payload_json,
    payloadChecksum: row.payload_checksum,
    status: parseEnum(row.status, ["ready", "accepted", "rejected", "expired"], "candidate status"),
    revision: row.revision,
    formalOutputId: row.formal_output_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  });
}

function mapBudget(row: BudgetRow): GovernedExtensionBudget {
  return Object.freeze({
    projectId: row.project_id,
    monthKey: row.month_key,
    currency: row.currency,
    limitMicros: row.limit_micros,
    spentMicros: row.spent_micros,
    reservedMicros: row.reserved_micros,
    activeRequests: row.active_requests,
    maximumConcurrent: row.maximum_concurrent,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function insertCandidateDecisionAudit(
  transaction: TransactionExecutor,
  candidate: CandidateRow,
  auditEventId: string,
  correlationId: string,
  action: "candidate_accept" | "candidate_reject" | "candidate_expire",
  errorCode: string | null,
  createdAt: string,
): Promise<void> {
  await insertAudit(transaction, {
    id: auditEventId,
    projectId: candidate.project_id,
    entityType: "candidate",
    entityId: candidate.id,
    action,
    correlationId,
    providerId: null,
    modelId: null,
    baseUrlDigest: null,
    requestFingerprint: null,
    errorCode,
    metadata: {
      kind: candidate.kind,
      requestId: candidate.request_id,
      sourceVersionId: candidate.source_version_id,
      payloadChecksum: candidate.payload_checksum,
    },
    createdAt,
  });
}

async function insertRequestFailureAudit(
  transaction: TransactionExecutor,
  request: RequestRow,
  auditEventId: string,
  correlationId: string,
  errorCode: string,
  createdAt: string,
  calculatedCostMicros: number,
  costSemantics: "internal_estimate" | "maximum_reserved_estimate",
): Promise<void> {
  await insertAudit(transaction, {
    id: auditEventId,
    projectId: request.project_id,
    entityType: "request",
    entityId: request.id,
    action: "request_failed",
    correlationId,
    providerId: request.provider_id,
    modelId: request.model_id,
    baseUrlDigest: await sha256Hex(request.base_url),
    requestFingerprint: request.request_fingerprint,
    errorCode,
    metadata: {
      kind: request.kind,
      sourceVersionId: request.source_version_id,
      calculatedCostMicros,
      costSemantics,
    },
    createdAt,
  });
}

async function insertAudit(
  transaction: TransactionExecutor,
  event: {
    readonly id: string;
    readonly projectId: string;
    readonly entityType: "request" | "receipt" | "candidate" | "budget";
    readonly entityId: string;
    readonly action:
      | "receipt_issued"
      | "request_started"
      | "request_replayed"
      | "request_cancelled"
      | "request_failed"
      | "candidate_published"
      | "candidate_accept"
      | "candidate_reject"
      | "candidate_expire"
      | "reservation_recovered";
    readonly correlationId: string;
    readonly providerId: string | null;
    readonly modelId: string | null;
    readonly baseUrlDigest: string | null;
    readonly requestFingerprint: string | null;
    readonly errorCode: string | null;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  },
): Promise<void> {
  const metadataJson = canonicalJson(event.metadata);
  assertAuditMetadataSafe(metadataJson);
  await transaction.execute(
    `INSERT INTO governed_extension_audit_events (
       id, project_id, entity_type, entity_id, action, correlation_id,
       provider_id, model_id, base_url_digest, request_fingerprint,
       error_code, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.projectId,
      event.entityType,
      event.entityId,
      event.action,
      event.correlationId,
      event.providerId,
      event.modelId,
      event.baseUrlDigest,
      event.requestFingerprint,
      event.errorCode,
      metadataJson,
      event.createdAt,
    ],
  );
}

function assertAuditMetadataSafe(serialized: string): void {
  if (serialized.length > 16_384) {
    throw invalid("Audit metadata exceeds its privacy boundary.");
  }
  const lower = serialized.toLowerCase();
  for (const prohibited of [
    '"content":',
    '"prompt":',
    '"messages":',
    '"key":',
    '"secret":',
    '"credential":',
    "bearer ",
  ]) {
    if (lower.includes(prohibited)) {
      throw invalid("Audit metadata contains a prohibited secret or content field.");
    }
  }
}

function parseDataCategories(
  serialized: string,
  kind: GovernedExtensionKind,
): readonly GovernedExtensionDataCategory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw repositoryError("Stored data categories are invalid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (value) =>
        typeof value !== "string" ||
        !GOVERNED_EXTENSION_DATA_CATEGORIES.includes(value as GovernedExtensionDataCategory),
    )
  ) {
    throw repositoryError("Stored data categories are invalid.");
  }
  const categories = parsed as GovernedExtensionDataCategory[];
  validateDataCategories(kind, categories);
  return Object.freeze([...categories]);
}

function parseEnum<const Value extends string>(
  value: string,
  allowed: readonly Value[],
  field: string,
): Value {
  if (!allowed.includes(value as Value)) {
    throw repositoryError(`The stored ${field} is invalid.`);
  }
  return value as Value;
}

function validateIdentifier(value: string, field: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw invalid(`${field} is not a safe identifier.`);
  }
}

function validateSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw invalid(`${field} must be a lowercase SHA-256 digest.`);
  }
}

function validateErrorCode(value: string): void {
  if (!ERROR_CODE_PATTERN.test(value)) {
    throw invalid("The stable error code is invalid.");
  }
}

function validateMonthKey(value: string): void {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    throw invalid("The budget month key must be canonical YYYY-MM.");
  }
}

function validateCurrency(value: string): void {
  if (!CURRENCY_PATTERN.test(value)) {
    throw invalid("The pricing currency must be a three-letter uppercase code.");
  }
}

function validateText(
  value: string,
  minimum: number,
  maximum: number,
  field: string,
  options: { readonly allowLineBreaks?: boolean } = {},
): void {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    (minimum > 0 && !MEANINGFUL_TEXT_PATTERN.test(value)) ||
    (options.allowLineBreaks !== true && (value.includes("\r") || value.includes("\n"))) ||
    UNSAFE_TEXT_PATTERN.test(value)
  ) {
    throw invalid(`${field} is outside its safe text boundary.`);
  }
}

function validateSafeInteger(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${field} must be a bounded safe integer.`);
  }
}

function validateCanonicalTimestamp(value: string, field: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalid(`${field} must be a canonical UTC timestamp.`);
  }
}

function assertProviderUrl(value: string, location: GovernedExtensionProviderLocation): void {
  const inspected = inspectGovernedExtensionProviderUrl(value, location);
  if (!inspected.ok) {
    throw invalid(inspected.message);
  }
}

function createOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 32) {
    throw invalid("The canonical request graph is too deep.");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, depth + 1));
  }
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw invalid("The canonical request graph contains a prohibited key.");
      }
      result[key] = canonicalize(source[key], depth + 1);
    }
    return result;
  }
  throw invalid("The canonical request graph contains an unsupported value.");
}

function nowIso(clock: Clock): string {
  const value: string = clock.now();
  validateCanonicalTimestamp(value, "clock");
  return value;
}

function invalid(message: string): GovernedExtensionStoreError {
  return new GovernedExtensionStoreError("EXTENSION_VALIDATION_FAILED", message);
}

function repositoryError(message: string): GovernedExtensionStoreError {
  return new GovernedExtensionStoreError("EXTENSION_REPOSITORY_ERROR", message, true);
}

function revisionConflict(expected: number, actual: number): GovernedExtensionStoreError {
  return new GovernedExtensionStoreError(
    "EXTENSION_REVISION_CONFLICT",
    "The creative-extension resource changed concurrently.",
    true,
    { expectedRevision: expected, actualRevision: actual },
  );
}
