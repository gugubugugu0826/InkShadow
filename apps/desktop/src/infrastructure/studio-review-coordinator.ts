import type { CloudQueryOptions } from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  CloudIdempotencyKeySchema,
  UuidV7Schema,
  type CloudReview,
  type CloudReviewDecision,
  type CloudReviewListResponse,
  type CloudReviewResponse,
  type CloudReviewSuggestionDecisionResponse,
  type CloudReviewSummary,
  type CloudReviewThread,
  type CloudReviewThreadItem,
  type CloudReviewThreadItemResponse,
  type CloudReviewThreadItemType,
  type CloudReviewThreadListResponse,
  type CloudReviewThreadResponse,
} from "@inkshadow/contracts";

import {
  STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
  type StudioReviewCrypto,
  StudioReviewCryptoError,
  StudioReviewSourceBindingSchema,
  StudioReviewSubmissionPayloadSchema,
  StudioReviewSuggestionPayloadSchema,
  StudioReviewThreadItemPayloadSchema,
  createStudioReviewAad,
  type OpenedStudioReviewProjectKey,
  type StudioReviewSourceBinding,
  type StudioReviewSubmissionPayload,
  type StudioReviewSuggestionCandidate,
  type StudioReviewTextAnchor,
  type StudioReviewThreadItemPayload,
} from "./studio-review-crypto";
import {
  type StudioReviewService,
  type StudioReviewAction,
  type StudioReviewCapabilities,
  type StudioReviewSessionContext,
} from "./studio-review-service";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_THREAD_ITEM_PAGES = 100;

export interface StableEncryptedReviewSource {
  readonly authority: "saved_stable_encrypted_projection";
  readonly projectionState: "settled";
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly sourceVersionId: string;
  readonly sourceVersionRevision: number;
  /**
   * SHA-256 over the authoritative encrypted projection. Implementations must
   * never populate this field with a plaintext digest.
   */
  readonly authoritativeCiphertextSha256: string;
  readonly projectKeyVersion: number;
}

export interface StudioReviewStableSourcePort {
  loadStableEncryptedSource(
    scope: Readonly<{ tenantId: string; teamId: string; projectId: string }>,
    signal?: AbortSignal,
  ): Promise<StableEncryptedReviewSource | null>;
}

export interface StudioReviewProjectKeyAccessPort {
  openReviewProjectKey(
    request: Readonly<{ projectId: string; keyVersion: number }>,
    signal?: AbortSignal,
  ): Promise<OpenedStudioReviewProjectKey>;
}

export interface StudioReviewIdPort {
  next(): string;
}

export interface StudioReviewIdempotencyPort {
  next(purpose: string): string;
}

export interface VerifiedStudioReviewSuggestionApplication {
  readonly authority: "verified_encrypted_review_suggestion";
  readonly applicationId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly threadId: string;
  readonly itemId: string;
  readonly anchor: StudioReviewTextAnchor;
  readonly candidate: StudioReviewSuggestionCandidate;
  readonly expectedBase: StudioReviewSourceBinding;
  readonly requestedByMembershipId: string;
}

export interface StudioReviewSuggestionApplicationReceipt {
  readonly authority: "local_review_suggestion_version";
  readonly applicationId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly threadId: string;
  readonly itemId: string;
  readonly candidateId: string;
  readonly baseSourceVersionId: string;
  readonly baseSourceVersionRevision: number;
  readonly baseSourceCiphertextSha256: string;
  readonly newVersionId: string;
  readonly newVersionRevision: number;
  readonly result: "created" | "already_applied";
}

export interface StudioReviewCandidateVersionPort {
  applyVerifiedSuggestion(
    application: VerifiedStudioReviewSuggestionApplication,
    signal?: AbortSignal,
  ): Promise<StudioReviewSuggestionApplicationReceipt>;
  loadAppliedSuggestion(
    scope: Readonly<{
      tenantId: string;
      teamId: string;
      projectId: string;
      reviewId: string;
      threadId: string;
      itemId: string;
    }>,
    expected: StudioReviewSuggestionApplicationReceipt,
    signal?: AbortSignal,
  ): Promise<StudioReviewSuggestionApplicationReceipt | null>;
}

export interface StudioReviewCoordinatorOptions {
  readonly service: StudioReviewService;
  readonly crypto: StudioReviewCrypto;
  readonly stableSources: StudioReviewStableSourcePort;
  readonly projectKeys: StudioReviewProjectKeyAccessPort;
  readonly candidates: StudioReviewCandidateVersionPort;
  readonly ids: StudioReviewIdPort;
  readonly idempotencyKeys: StudioReviewIdempotencyPort;
}

export interface DecryptedStudioReview {
  readonly review: CloudReview;
  readonly payload: StudioReviewSubmissionPayload;
}

export type DecryptedStudioReviewThreadItem =
  | Readonly<{
      state: "ready";
      item: CloudReviewThreadItem;
      payload: StudioReviewThreadItemPayload;
    }>
  | Readonly<{
      state: "corrupt";
      item: CloudReviewThreadItem;
      errorCode: string;
    }>;

export interface StudioReviewThreadView {
  readonly thread: CloudReviewThread;
  readonly items: readonly DecryptedStudioReviewThreadItem[];
  readonly nextCursor: string | null;
}

export interface SubmitStudioReviewInput {
  readonly title: string;
  readonly note: string;
}

export type AppendStudioReviewThreadItemInput =
  | Readonly<{
      itemType: "comment" | "question" | "rewrite_request";
      body: string;
      anchor: StudioReviewTextAnchor | null;
    }>
  | Readonly<{
      itemType: "suggestion";
      body: string;
      anchor: StudioReviewTextAnchor;
      replacementText: string;
    }>
  | Readonly<{
      itemType: "reply";
      body: string;
      anchor: StudioReviewTextAnchor | null;
      threadId: string;
      parentItemId: string;
      expectedThreadRevision: number;
    }>;

export interface AppendedStudioReviewThreadItem {
  readonly thread: CloudReviewThread;
  readonly item: CloudReviewThreadItem;
  readonly payload: StudioReviewThreadItemPayload;
}

export interface AcceptStudioReviewSuggestionInput {
  readonly reviewId: string;
  readonly threadId: string;
  readonly itemId: string;
  readonly expectedItemRevision: number;
}

export interface StudioReviewAcceptedSuggestion {
  readonly status: "accepted";
  readonly application: StudioReviewSuggestionApplicationReceipt;
  readonly decision: CloudReviewSuggestionDecisionResponse;
}

export interface StudioReviewSuggestionPartialRetry {
  readonly status: "partial_retry";
  readonly application: StudioReviewSuggestionApplicationReceipt;
  readonly retry: Readonly<{
    tenantId: string;
    teamId: string;
    projectId: string;
    reviewId: string;
    threadId: string;
    itemId: string;
    expectedItemRevision: number;
    idempotencyKey: string;
  }>;
  readonly failureCode: string;
}

export type AcceptStudioReviewSuggestionOutcome =
  StudioReviewAcceptedSuggestion | StudioReviewSuggestionPartialRetry;

export type StudioReviewCoordinatorErrorCode =
  | "REVIEW_KEY_MISSING"
  | "REVIEW_REMOTE_RESPONSE_INVALID"
  | "REVIEW_REVISION_CONFLICT"
  | "REVIEW_SOURCE_CHANGED"
  | "REVIEW_SOURCE_INVALID"
  | "REVIEW_SOURCE_UNAVAILABLE"
  | "REVIEW_SUGGESTION_INVALID"
  | "REVIEW_SUGGESTION_NOT_FOUND";

export class StudioReviewCoordinatorError extends Error {
  public constructor(
    public readonly code: StudioReviewCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioReviewCoordinatorError";
  }
}

/**
 * Coordinates encrypted review transport with authoritative local versions.
 *
 * The coordinator cannot write正文. Accepted suggestions are handed to the
 * author-side candidate/version port under an exact base-version CAS. Only
 * after that port reports a durable local version does cloud metadata advance.
 */
export class StudioReviewCoordinator {
  public constructor(private readonly options: StudioReviewCoordinatorOptions) {}

  public capabilities(context: StudioReviewSessionContext): StudioReviewCapabilities {
    return this.options.service.capabilities(context);
  }

  public async listReviews(
    context: StudioReviewSessionContext,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewListResponse> {
    const response = await this.options.service.listReviews(context, {
      limit: options.limit ?? 100,
      ...options,
    });
    requireReviewListScope(response, context);
    return response;
  }

  public async listThreads(
    context: StudioReviewSessionContext,
    reviewId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewThreadListResponse> {
    const normalizedReviewId = requireUuid(reviewId);
    const response = await this.options.service.listThreads(context, normalizedReviewId, {
      limit: options.limit ?? 100,
      ...options,
    });
    requireUniqueRemoteIds(
      response.threads.map((thread) => thread.threadId),
      "review thread",
    );
    for (const thread of response.threads) {
      requireThreadScope(thread, context, normalizedReviewId, thread.threadId);
    }
    return response;
  }

  public async readReview(
    context: StudioReviewSessionContext,
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<DecryptedStudioReview> {
    const verified = await this.loadVerifiedReview(context, reviewId, signal);
    return Object.freeze({ review: verified.review, payload: verified.payload });
  }

  public async submitReview(
    context: StudioReviewSessionContext,
    input: SubmitStudioReviewInput,
    signal?: AbortSignal,
  ): Promise<DecryptedStudioReview> {
    this.options.service.assertAvailable(context, "submit", signal);
    const source = await this.loadStableSource(context, signal);
    const reviewId = nextUuid(this.options.ids);
    const key = await this.openKey(context.projectId, source.projectKeyVersion, signal);
    const sourceBinding = toSourceBinding(source);
    const payload = StudioReviewSubmissionPayloadSchema.parse({
      schemaVersion: STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
      kind: "submission",
      title: input.title,
      note: input.note,
      source: sourceBinding,
    });
    const aad = createStudioReviewAad({
      payloadKind: "submission",
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      reviewId,
      threadId: null,
      itemId: null,
      parentItemId: null,
      source: sourceBinding,
      projectKeyVersion: source.projectKeyVersion,
    });
    const encrypted = await this.options.crypto.encrypt(payload, aad, key, signal);
    const response = await this.options.service.submitReview(
      context,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        reviewId,
        teamId: context.teamId,
        projectId: context.projectId,
        sourceVersionId: source.sourceVersionId,
        sourceVersionRevision: source.sourceVersionRevision,
        sourceCiphertextSha256: source.authoritativeCiphertextSha256,
        projectKeyVersion: source.projectKeyVersion,
        payload: encrypted,
      },
      mutationOptions(this.options.idempotencyKeys, "review.submit", signal),
    );
    const review = requireReviewResponseScope(response, context, reviewId);
    requireReviewSource(review, sourceBinding, source.projectKeyVersion);
    const returnedPayload = await this.decryptSubmission(review, key, signal);
    return Object.freeze({ review, payload: returnedPayload });
  }

  public async appendThreadItem(
    context: StudioReviewSessionContext,
    reviewId: string,
    input: AppendStudioReviewThreadItemInput,
    signal?: AbortSignal,
  ): Promise<AppendedStudioReviewThreadItem> {
    const action = actionForItem(input.itemType);
    this.options.service.assertAvailable(context, action, signal);
    const verified = await this.loadVerifiedReview(context, reviewId, signal);
    const threadId =
      input.itemType === "reply" ? requireUuid(input.threadId) : nextUuid(this.options.ids);
    const itemId = nextUuid(this.options.ids);
    const parentItemId = input.itemType === "reply" ? requireUuid(input.parentItemId) : null;
    const source = sourceBindingFromReview(verified.review);
    const payload = this.buildThreadItemPayload(input, source, itemId);
    const aad = createStudioReviewAad({
      payloadKind: input.itemType,
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      reviewId: verified.review.reviewId,
      threadId,
      itemId,
      parentItemId,
      source,
      projectKeyVersion: verified.review.projectKeyVersion,
    });
    const encrypted = await this.options.crypto.encrypt(payload, aad, verified.key, signal);
    const response = await this.options.service.appendThreadItem(
      context,
      verified.review.reviewId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        threadId,
        itemId,
        itemType: input.itemType,
        parentItemId,
        expectedThreadRevision:
          input.itemType === "reply" ? requirePositiveInteger(input.expectedThreadRevision) : null,
        payload: encrypted,
      },
      mutationOptions(this.options.idempotencyKeys, `review.${input.itemType}`, signal),
    );
    const item = requireThreadItemResponseScope(
      response,
      context,
      verified.review.reviewId,
      threadId,
      itemId,
    );
    const returnedPayload = await this.decryptThreadItem(
      verified.review,
      item,
      verified.key,
      signal,
    );
    return Object.freeze({ thread: response.thread, item, payload: returnedPayload });
  }

  public async readThread(
    context: StudioReviewSessionContext,
    reviewId: string,
    threadId: string,
    options: CloudQueryOptions = {},
  ): Promise<StudioReviewThreadView> {
    const verified = await this.loadVerifiedReview(context, reviewId, options.signal);
    const response = await this.options.service.listThreadItems(
      context,
      verified.review.reviewId,
      threadId,
      { limit: options.limit ?? 100, ...options },
    );
    requireThreadScope(response.thread, context, verified.review.reviewId, threadId);
    requireUniqueRemoteIds(
      response.items.map((item) => item.itemId),
      "review thread item",
    );
    const items: DecryptedStudioReviewThreadItem[] = [];
    for (const item of response.items) {
      requireListedItemScope(verified.review, item, threadId);
      try {
        const payload = await this.decryptThreadItem(
          verified.review,
          item,
          verified.key,
          options.signal,
        );
        items.push(Object.freeze({ state: "ready", item, payload }));
      } catch (error: unknown) {
        if (!isIsolatedItemCorruption(error)) {
          throw error;
        }
        items.push(Object.freeze({ state: "corrupt", item, errorCode: error.code }));
      }
    }
    return Object.freeze({
      thread: response.thread,
      items: Object.freeze(items),
      nextCursor: response.nextCursor,
    });
  }

  public async decideReview(
    context: StudioReviewSessionContext,
    review: Pick<CloudReviewSummary, "reviewId" | "revision">,
    decision: CloudReviewDecision,
    signal?: AbortSignal,
  ): Promise<CloudReviewResponse> {
    const reviewId = requireUuid(review.reviewId);
    const response = await this.options.service.decideReview(
      context,
      reviewId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: requirePositiveInteger(review.revision),
        decision,
      },
      mutationOptions(this.options.idempotencyKeys, `review.${decision}`, signal),
    );
    requireReviewResponseScope(response, context, reviewId);
    return response;
  }

  public async resolveThread(
    context: StudioReviewSessionContext,
    reviewId: string,
    thread: Pick<CloudReviewThread, "threadId" | "revision">,
    signal?: AbortSignal,
  ): Promise<CloudReviewThreadResponse> {
    const normalizedReviewId = requireUuid(reviewId);
    const threadId = requireUuid(thread.threadId);
    const response = await this.options.service.resolveThread(
      context,
      normalizedReviewId,
      threadId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: requirePositiveInteger(thread.revision),
      },
      mutationOptions(this.options.idempotencyKeys, "review.thread.resolve", signal),
    );
    requireThreadScope(response.thread, context, normalizedReviewId, threadId);
    return response;
  }

  public async rejectSuggestion(
    context: StudioReviewSessionContext,
    input: AcceptStudioReviewSuggestionInput,
    signal?: AbortSignal,
  ): Promise<CloudReviewSuggestionDecisionResponse> {
    const normalized = normalizeSuggestionInput(input);
    const response = await this.options.service.decideSuggestion(
      context,
      normalized.reviewId,
      normalized.threadId,
      normalized.itemId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: normalized.expectedItemRevision,
        decision: "rejected",
      },
      mutationOptions(this.options.idempotencyKeys, "review.suggestion.reject", signal),
    );
    requireSuggestionDecisionScope(response, context, normalized, "rejected");
    return response;
  }

  public async acceptSuggestion(
    context: StudioReviewSessionContext,
    inputValue: AcceptStudioReviewSuggestionInput,
    signal?: AbortSignal,
  ): Promise<AcceptStudioReviewSuggestionOutcome> {
    this.options.service.assertAvailable(context, "decide_suggestion", signal);
    const input = normalizeSuggestionInput(inputValue);
    const verified = await this.loadVerifiedReview(context, input.reviewId, signal);
    const item = await this.findSuggestion(
      context,
      verified.review,
      input.threadId,
      input.itemId,
      signal,
    );
    if (item.revision !== input.expectedItemRevision) {
      throw revisionConflict();
    }
    const payload = await this.decryptThreadItem(verified.review, item, verified.key, signal);
    const suggestion = StudioReviewSuggestionPayloadSchema.safeParse(payload);
    if (!suggestion.success) {
      throw invalidSuggestion();
    }
    const stableSource = await this.loadStableSource(context, signal);
    requireStableSourceMatchesSuggestion(stableSource, suggestion.data.candidate);

    const application = Object.freeze({
      authority: "verified_encrypted_review_suggestion" as const,
      applicationId: item.itemId,
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      reviewId: verified.review.reviewId,
      threadId: item.threadId,
      itemId: item.itemId,
      anchor: suggestion.data.anchor,
      candidate: suggestion.data.candidate,
      expectedBase: suggestion.data.source,
      requestedByMembershipId: context.membershipId,
    });
    const idempotencyKey = nextIdempotency(
      this.options.idempotencyKeys,
      "review.suggestion.accept",
    );
    const receipt = requireApplicationReceipt(
      await this.options.candidates.applyVerifiedSuggestion(application, signal),
      application,
    );
    const retry = Object.freeze({
      tenantId: context.tenantId,
      teamId: context.teamId,
      projectId: context.projectId,
      reviewId: verified.review.reviewId,
      threadId: item.threadId,
      itemId: item.itemId,
      expectedItemRevision: item.revision,
      idempotencyKey,
    });
    if (signal?.aborted === true) {
      return partialRetry(receipt, retry, "CLOUD_REQUEST_ABORTED");
    }
    try {
      const decision = await this.options.service.decideSuggestion(
        context,
        verified.review.reviewId,
        item.threadId,
        item.itemId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: item.revision,
          decision: "accepted",
        },
        { idempotencyKey, ...(signal === undefined ? {} : { signal }) },
      );
      requireSuggestionDecisionScope(
        decision,
        context,
        {
          reviewId: verified.review.reviewId,
          threadId: item.threadId,
          itemId: item.itemId,
          expectedItemRevision: item.revision,
        },
        "accepted",
      );
      return Object.freeze({ status: "accepted", application: receipt, decision });
    } catch (error: unknown) {
      return partialRetry(receipt, retry, errorCode(error));
    }
  }

  public async retryAcceptedSuggestionDecision(
    context: StudioReviewSessionContext,
    partial: StudioReviewSuggestionPartialRetry,
    signal?: AbortSignal,
  ): Promise<AcceptStudioReviewSuggestionOutcome> {
    this.options.service.assertAvailable(context, "decide_suggestion", signal);
    requireRetryScope(context, partial);
    const receipt = await this.options.candidates.loadAppliedSuggestion(
      {
        tenantId: context.tenantId,
        teamId: context.teamId,
        projectId: context.projectId,
        reviewId: partial.retry.reviewId,
        threadId: partial.retry.threadId,
        itemId: partial.retry.itemId,
      },
      partial.application,
      signal,
    );
    if (receipt === null || !sameReceipt(receipt, partial.application)) {
      throw invalidSuggestion();
    }
    try {
      const decision = await this.options.service.decideSuggestion(
        context,
        partial.retry.reviewId,
        partial.retry.threadId,
        partial.retry.itemId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: partial.retry.expectedItemRevision,
          decision: "accepted",
        },
        {
          idempotencyKey: partial.retry.idempotencyKey,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      requireSuggestionDecisionScope(
        decision,
        context,
        {
          reviewId: partial.retry.reviewId,
          threadId: partial.retry.threadId,
          itemId: partial.retry.itemId,
          expectedItemRevision: partial.retry.expectedItemRevision,
        },
        "accepted",
      );
      return Object.freeze({ status: "accepted", application: receipt, decision });
    } catch (error: unknown) {
      return partialRetry(receipt, partial.retry, errorCode(error));
    }
  }

  private async loadVerifiedReview(
    context: StudioReviewSessionContext,
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<
    Readonly<{
      review: CloudReview;
      payload: StudioReviewSubmissionPayload;
      key: OpenedStudioReviewProjectKey;
    }>
  > {
    const response = await this.options.service.getReview(context, reviewId, signal);
    const review = requireReviewResponseScope(response, context, reviewId);
    const key = await this.openKey(context.projectId, review.projectKeyVersion, signal);
    let payload: StudioReviewSubmissionPayload;
    try {
      payload = await this.decryptSubmission(review, key, signal);
    } catch (error: unknown) {
      if (error instanceof StudioReviewCryptoError && error.code === "REVIEW_CRYPTO_KEY_INVALID") {
        throw keyMissing();
      }
      throw error;
    }
    return Object.freeze({ review, payload, key });
  }

  private async decryptSubmission(
    review: CloudReview,
    key: OpenedStudioReviewProjectKey,
    signal?: AbortSignal,
  ): Promise<StudioReviewSubmissionPayload> {
    const source = sourceBindingFromReview(review);
    const decrypted = await this.options.crypto.decrypt(
      review.payload,
      createStudioReviewAad({
        payloadKind: "submission",
        tenantId: review.tenantId,
        teamId: review.teamId,
        projectId: review.projectId,
        reviewId: review.reviewId,
        threadId: null,
        itemId: null,
        parentItemId: null,
        source,
        projectKeyVersion: review.projectKeyVersion,
      }),
      key,
      signal,
    );
    const payload = StudioReviewSubmissionPayloadSchema.safeParse(decrypted);
    if (!payload.success) {
      throw new StudioReviewCryptoError(
        "REVIEW_PAYLOAD_INVALID",
        "The encrypted review submission has an invalid payload kind.",
      );
    }
    return payload.data;
  }

  private async decryptThreadItem(
    review: CloudReview,
    item: CloudReviewThreadItem,
    key: OpenedStudioReviewProjectKey,
    signal?: AbortSignal,
  ): Promise<StudioReviewThreadItemPayload> {
    requireItemScope(review, item);
    const decrypted = await this.options.crypto.decrypt(
      item.payload,
      createStudioReviewAad({
        payloadKind: item.itemType,
        tenantId: item.tenantId,
        teamId: item.teamId,
        projectId: item.projectId,
        reviewId: item.reviewId,
        threadId: item.threadId,
        itemId: item.itemId,
        parentItemId: item.parentItemId,
        source: sourceBindingFromReview(review),
        projectKeyVersion: review.projectKeyVersion,
      }),
      key,
      signal,
    );
    const payload = StudioReviewThreadItemPayloadSchema.safeParse(decrypted);
    if (!payload.success) {
      throw new StudioReviewCryptoError(
        "REVIEW_PAYLOAD_INVALID",
        "The encrypted review thread item has an invalid payload kind.",
      );
    }
    return payload.data;
  }

  private buildThreadItemPayload(
    input: AppendStudioReviewThreadItemInput,
    source: StudioReviewSourceBinding,
    itemId: string,
  ): StudioReviewThreadItemPayload {
    if (input.itemType !== "suggestion") {
      return StudioReviewThreadItemPayloadSchema.parse({
        schemaVersion: STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
        kind: input.itemType,
        body: input.body,
        source,
        anchor: input.anchor,
      });
    }
    return StudioReviewSuggestionPayloadSchema.parse({
      schemaVersion: STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
      kind: "suggestion",
      body: input.body,
      source,
      anchor: input.anchor,
      candidate: {
        candidateId: itemId,
        baseSourceVersionId: source.sourceVersionId,
        baseSourceVersionRevision: source.sourceVersionRevision,
        baseSourceCiphertextSha256: source.sourceCiphertextSha256,
        replacement: {
          chapterId: input.anchor.chapterId,
          startUtf16: input.anchor.startUtf16,
          endUtf16: input.anchor.endUtf16,
          text: input.replacementText,
        },
      },
    });
  }

  private async loadStableSource(
    context: StudioReviewSessionContext,
    signal?: AbortSignal,
  ): Promise<StableEncryptedReviewSource> {
    throwIfAborted(signal);
    const source = await this.options.stableSources.loadStableEncryptedSource(
      {
        tenantId: context.tenantId,
        teamId: context.teamId,
        projectId: context.projectId,
      },
      signal,
    );
    throwIfAborted(signal);
    if (source === null) {
      throw new StudioReviewCoordinatorError(
        "REVIEW_SOURCE_UNAVAILABLE",
        "No saved stable encrypted source version is available for review.",
      );
    }
    return normalizeStableSource(source, context);
  }

  private async openKey(
    projectId: string,
    keyVersion: number,
    signal?: AbortSignal,
  ): Promise<OpenedStudioReviewProjectKey> {
    throwIfAborted(signal);
    try {
      const opened = await this.options.projectKeys.openReviewProjectKey(
        { projectId, keyVersion },
        signal,
      );
      throwIfAborted(signal);
      if (opened.projectId !== projectId || opened.keyVersion !== keyVersion) {
        throw keyMissing();
      }
      return opened;
    } catch (error: unknown) {
      if (isAbortError(error) || error instanceof StudioReviewCoordinatorError) {
        throw error;
      }
      throw keyMissing();
    }
  }

  private async findSuggestion(
    context: StudioReviewSessionContext,
    review: CloudReview,
    threadId: string,
    itemId: string,
    signal?: AbortSignal,
  ): Promise<CloudReviewThreadItem> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_THREAD_ITEM_PAGES; page += 1) {
      const response = await this.options.service.listThreadItems(
        context,
        review.reviewId,
        threadId,
        {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      requireThreadScope(response.thread, context, review.reviewId, threadId);
      requireUniqueRemoteIds(
        response.items.map((item) => item.itemId),
        "review thread item",
      );
      for (const item of response.items) {
        requireListedItemScope(review, item, threadId);
      }
      const found = response.items.find((item) => item.itemId === itemId);
      if (found !== undefined) {
        if (found.itemType !== "suggestion" || found.suggestionDecision !== "pending") {
          throw invalidSuggestion();
        }
        return found;
      }
      if (response.nextCursor === null) {
        break;
      }
      if (seenCursors.has(response.nextCursor)) {
        throw new StudioReviewCoordinatorError(
          "REVIEW_REMOTE_RESPONSE_INVALID",
          "Review pagination repeated an opaque cursor.",
        );
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new StudioReviewCoordinatorError(
      "REVIEW_SUGGESTION_NOT_FOUND",
      "The pending encrypted review suggestion was not found.",
    );
  }
}

function normalizeStableSource(
  value: StableEncryptedReviewSource,
  context: StudioReviewSessionContext,
): StableEncryptedReviewSource {
  if (
    (value as { readonly authority?: unknown }).authority !== "saved_stable_encrypted_projection" ||
    (value as { readonly projectionState?: unknown }).projectionState !== "settled" ||
    value.tenantId !== context.tenantId ||
    value.teamId !== context.teamId ||
    value.projectId !== context.projectId ||
    !SHA256_HEX_PATTERN.test(value.authoritativeCiphertextSha256) ||
    !Number.isSafeInteger(value.sourceVersionRevision) ||
    value.sourceVersionRevision < 1 ||
    !Number.isSafeInteger(value.projectKeyVersion) ||
    value.projectKeyVersion < 1 ||
    !UuidV7Schema.safeParse(value.sourceVersionId).success
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_SOURCE_INVALID",
      "The local source is not a settled encrypted projection in the requested scope.",
    );
  }
  return Object.freeze({
    ...value,
    sourceVersionId: value.sourceVersionId.toLowerCase(),
  });
}

function toSourceBinding(source: StableEncryptedReviewSource): StudioReviewSourceBinding {
  return StudioReviewSourceBindingSchema.parse({
    sourceVersionId: source.sourceVersionId,
    sourceVersionRevision: source.sourceVersionRevision,
    sourceCiphertextSha256: source.authoritativeCiphertextSha256,
  });
}

function sourceBindingFromReview(review: CloudReview): StudioReviewSourceBinding {
  return StudioReviewSourceBindingSchema.parse({
    sourceVersionId: review.sourceVersionId,
    sourceVersionRevision: review.sourceVersionRevision,
    sourceCiphertextSha256: review.sourceCiphertextSha256,
  });
}

function requireReviewSource(
  review: CloudReview,
  source: StudioReviewSourceBinding,
  projectKeyVersion: number,
): void {
  if (
    review.sourceVersionId !== source.sourceVersionId ||
    review.sourceVersionRevision !== source.sourceVersionRevision ||
    review.sourceCiphertextSha256 !== source.sourceCiphertextSha256 ||
    review.projectKeyVersion !== projectKeyVersion
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The cloud review response changed its authoritative encrypted source.",
    );
  }
}

function requireReviewResponseScope(
  response: CloudReviewResponse,
  context: StudioReviewSessionContext,
  reviewId: string,
): CloudReview {
  if (
    response.review.tenantId !== context.tenantId ||
    response.review.teamId !== context.teamId ||
    response.review.projectId !== context.projectId ||
    response.review.reviewId !== reviewId
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The cloud review response crossed its requested authority scope.",
    );
  }
  return response.review;
}

function requireReviewListScope(
  response: CloudReviewListResponse,
  context: StudioReviewSessionContext,
): void {
  requireUniqueRemoteIds(
    response.reviews.map((review) => review.reviewId),
    "review",
  );
  if (
    response.reviews.some(
      (review) =>
        review.tenantId !== context.tenantId ||
        review.teamId !== context.teamId ||
        review.projectId !== context.projectId,
    )
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The cloud review list crossed its requested authority scope.",
    );
  }
}

function requireUniqueRemoteIds(ids: readonly string[], recordType: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      `The cloud ${recordType} page repeated a record identity.`,
    );
  }
}

function requireThreadScope(
  thread: CloudReviewThread,
  context: StudioReviewSessionContext,
  reviewId: string,
  threadId: string,
): void {
  if (
    thread.tenantId !== context.tenantId ||
    thread.teamId !== context.teamId ||
    thread.projectId !== context.projectId ||
    thread.reviewId !== reviewId ||
    thread.threadId !== threadId
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The cloud review thread crossed its requested authority scope.",
    );
  }
}

function requireSuggestionDecisionScope(
  response: CloudReviewSuggestionDecisionResponse,
  context: StudioReviewSessionContext,
  input: AcceptStudioReviewSuggestionInput,
  decision: "accepted" | "rejected",
): void {
  requireThreadScope(response.thread, context, input.reviewId, input.threadId);
  const item = response.item;
  if (
    item.tenantId !== context.tenantId ||
    item.teamId !== context.teamId ||
    item.projectId !== context.projectId ||
    item.reviewId !== input.reviewId ||
    item.threadId !== input.threadId ||
    item.itemId !== input.itemId ||
    item.itemType !== "suggestion" ||
    item.suggestionDecision !== decision
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The cloud suggestion decision crossed its requested authority scope.",
    );
  }
}

function requireThreadItemResponseScope(
  response: CloudReviewThreadItemResponse,
  context: StudioReviewSessionContext,
  reviewId: string,
  threadId: string,
  itemId: string,
): CloudReviewThreadItem {
  const item = response.item;
  if (
    response.thread.tenantId !== context.tenantId ||
    response.thread.teamId !== context.teamId ||
    response.thread.projectId !== context.projectId ||
    response.thread.reviewId !== reviewId ||
    response.thread.threadId !== threadId ||
    item.tenantId !== context.tenantId ||
    item.teamId !== context.teamId ||
    item.projectId !== context.projectId ||
    item.reviewId !== reviewId ||
    item.threadId !== threadId ||
    item.itemId !== itemId
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The cloud review-thread response crossed its requested authority scope.",
    );
  }
  return item;
}

function requireItemScope(review: CloudReview, item: CloudReviewThreadItem): void {
  if (
    item.tenantId !== review.tenantId ||
    item.teamId !== review.teamId ||
    item.projectId !== review.projectId ||
    item.reviewId !== review.reviewId
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The encrypted review item crossed its parent review scope.",
    );
  }
}

function requireListedItemScope(
  review: CloudReview,
  item: CloudReviewThreadItem,
  threadId: string,
): void {
  requireItemScope(review, item);
  if (item.threadId !== threadId) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_REMOTE_RESPONSE_INVALID",
      "The encrypted review item crossed its requested thread scope.",
    );
  }
}

function requireStableSourceMatchesSuggestion(
  stable: StableEncryptedReviewSource,
  candidate: StudioReviewSuggestionCandidate,
): void {
  if (
    stable.sourceVersionId !== candidate.baseSourceVersionId ||
    stable.sourceVersionRevision !== candidate.baseSourceVersionRevision ||
    stable.authoritativeCiphertextSha256 !== candidate.baseSourceCiphertextSha256
  ) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_SOURCE_CHANGED",
      "The saved stable source changed after this encrypted suggestion was created.",
    );
  }
}

function requireApplicationReceipt(
  value: StudioReviewSuggestionApplicationReceipt,
  application: VerifiedStudioReviewSuggestionApplication,
): StudioReviewSuggestionApplicationReceipt {
  if (
    (value as { readonly authority?: unknown }).authority !== "local_review_suggestion_version" ||
    value.applicationId !== application.applicationId ||
    value.tenantId !== application.tenantId ||
    value.teamId !== application.teamId ||
    value.projectId !== application.projectId ||
    value.reviewId !== application.reviewId ||
    value.threadId !== application.threadId ||
    value.itemId !== application.itemId ||
    value.candidateId !== application.candidate.candidateId ||
    value.baseSourceVersionId !== application.expectedBase.sourceVersionId ||
    value.baseSourceVersionRevision !== application.expectedBase.sourceVersionRevision ||
    value.baseSourceCiphertextSha256 !== application.expectedBase.sourceCiphertextSha256 ||
    !UuidV7Schema.safeParse(value.newVersionId).success ||
    !Number.isSafeInteger(value.newVersionRevision) ||
    value.newVersionRevision < 1 ||
    !["created", "already_applied"].includes(value.result)
  ) {
    throw invalidSuggestion();
  }
  return Object.freeze({ ...value, newVersionId: value.newVersionId.toLowerCase() });
}

function sameReceipt(
  left: StudioReviewSuggestionApplicationReceipt,
  right: StudioReviewSuggestionApplicationReceipt,
): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.tenantId === right.tenantId &&
    left.teamId === right.teamId &&
    left.projectId === right.projectId &&
    left.reviewId === right.reviewId &&
    left.threadId === right.threadId &&
    left.itemId === right.itemId &&
    left.candidateId === right.candidateId &&
    left.baseSourceVersionId === right.baseSourceVersionId &&
    left.baseSourceVersionRevision === right.baseSourceVersionRevision &&
    left.baseSourceCiphertextSha256 === right.baseSourceCiphertextSha256 &&
    left.newVersionId === right.newVersionId &&
    left.newVersionRevision === right.newVersionRevision
  );
}

function requireRetryScope(
  context: StudioReviewSessionContext,
  partial: StudioReviewSuggestionPartialRetry,
): void {
  if (
    (partial as { readonly status?: unknown }).status !== "partial_retry" ||
    partial.retry.tenantId !== context.tenantId ||
    partial.retry.teamId !== context.teamId ||
    partial.retry.projectId !== context.projectId ||
    !CloudIdempotencyKeySchema.safeParse(partial.retry.idempotencyKey).success
  ) {
    throw invalidSuggestion();
  }
}

function normalizeSuggestionInput(
  input: AcceptStudioReviewSuggestionInput,
): AcceptStudioReviewSuggestionInput {
  return Object.freeze({
    reviewId: requireUuid(input.reviewId),
    threadId: requireUuid(input.threadId),
    itemId: requireUuid(input.itemId),
    expectedItemRevision: requirePositiveInteger(input.expectedItemRevision),
  });
}

function actionForItem(itemType: CloudReviewThreadItemType): StudioReviewAction {
  switch (itemType) {
    case "comment":
      return "comment";
    case "suggestion":
      return "suggest";
    case "question":
      return "question";
    case "rewrite_request":
      return "request_rewrite";
    case "reply":
      return "reply";
  }
}

function mutationOptions(
  source: StudioReviewIdempotencyPort,
  purpose: string,
  signal?: AbortSignal,
): Readonly<{ idempotencyKey: string; signal?: AbortSignal }> {
  return {
    idempotencyKey: nextIdempotency(source, purpose),
    ...(signal === undefined ? {} : { signal }),
  };
}

function nextIdempotency(source: StudioReviewIdempotencyPort, purpose: string): string {
  const value = source.next(purpose);
  const parsed = CloudIdempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_SOURCE_INVALID",
      "The local review idempotency source returned an invalid key.",
    );
  }
  return parsed.data;
}

function nextUuid(source: StudioReviewIdPort): string {
  return requireUuid(source.next());
}

function requireUuid(value: unknown): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_SOURCE_INVALID",
      "A local Studio review identifier is invalid.",
    );
  }
  return parsed.data.toLowerCase();
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StudioReviewCoordinatorError(
      "REVIEW_SOURCE_INVALID",
      "A Studio review revision is invalid.",
    );
  }
  return value;
}

function partialRetry(
  application: StudioReviewSuggestionApplicationReceipt,
  retry: StudioReviewSuggestionPartialRetry["retry"],
  failureCode: string,
): StudioReviewSuggestionPartialRetry {
  return Object.freeze({
    status: "partial_retry",
    application,
    retry: Object.freeze({ ...retry }),
    failureCode,
  });
}

function invalidSuggestion(): StudioReviewCoordinatorError {
  return new StudioReviewCoordinatorError(
    "REVIEW_SUGGESTION_INVALID",
    "The encrypted suggestion or its local application receipt is invalid.",
  );
}

function revisionConflict(): StudioReviewCoordinatorError {
  return new StudioReviewCoordinatorError(
    "REVIEW_REVISION_CONFLICT",
    "The review item revision changed before this action completed.",
  );
}

function keyMissing(): StudioReviewCoordinatorError {
  return new StudioReviewCoordinatorError(
    "REVIEW_KEY_MISSING",
    "The exact non-exportable project key required for this review is unavailable.",
  );
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 120);
  }
  if (isAbortError(error)) {
    return "CLOUD_REQUEST_ABORTED";
  }
  return "REVIEW_REMOTE_DECISION_RETRY_REQUIRED";
}

function isIsolatedItemCorruption(error: unknown): error is StudioReviewCryptoError {
  return (
    error instanceof StudioReviewCryptoError &&
    error.code !== "REVIEW_CRYPTO_ABORTED" &&
    error.code !== "REVIEW_CRYPTO_KEY_INVALID"
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The Studio review operation was cancelled.", "AbortError");
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}
