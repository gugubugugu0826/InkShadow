import type {
  CloudMutationOptions,
  CloudQueryOptions,
  InkShadowCloudApiClient,
} from "@inkshadow/cloud-client";
import {
  UuidV7Schema,
  type CloudProjectAssignment,
  type CloudReviewDecisionRequest,
  type CloudReviewListResponse,
  type CloudReviewResponse,
  type CloudReviewSubmissionRequest,
  type CloudReviewSuggestionDecisionRequest,
  type CloudReviewSuggestionDecisionResponse,
  type CloudReviewThreadItemAppendRequest,
  type CloudReviewThreadItemListResponse,
  type CloudReviewThreadItemResponse,
  type CloudReviewThreadListResponse,
  type CloudReviewThreadResolutionRequest,
  type CloudReviewThreadResponse,
  type CloudTeamMembership,
} from "@inkshadow/contracts";

export type StudioReviewRole = CloudTeamMembership["role"];

export interface StudioReviewSessionContext {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly role: StudioReviewRole;
  readonly membershipState: CloudTeamMembership["state"];
  readonly assignmentState: CloudProjectAssignment["state"] | "missing";
}

export type StudioReviewAction =
  | "read"
  | "submit"
  | "comment"
  | "suggest"
  | "question"
  | "request_rewrite"
  | "reply"
  | "approve"
  | "reject"
  | "resolve"
  | "decide_suggestion";

export interface StudioReviewCapabilities {
  readonly read: boolean;
  readonly submit: boolean;
  readonly comment: boolean;
  readonly suggest: boolean;
  readonly question: boolean;
  readonly requestRewrite: boolean;
  readonly reply: boolean;
  readonly approve: boolean;
  readonly reject: boolean;
  readonly resolve: boolean;
  readonly decideSuggestion: boolean;
}

export interface StudioReviewConnectivityPort {
  isOnline(): boolean;
}

export type StudioReviewRemotePort = Pick<
  InkShadowCloudApiClient,
  | "appendReviewThreadItem"
  | "decideReview"
  | "decideReviewSuggestion"
  | "getReview"
  | "listReviews"
  | "listReviewThreadItems"
  | "listReviewThreads"
  | "resolveReviewThread"
  | "submitReview"
>;

export type StudioReviewServiceErrorCode =
  "REVIEW_OFFLINE" | "REVIEW_PERMISSION_DENIED" | "REVIEW_SCOPE_INVALID";

export class StudioReviewServiceError extends Error {
  public constructor(
    public readonly code: StudioReviewServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioReviewServiceError";
  }
}

/**
 * Fail-closed desktop boundary around the cloud review API.
 *
 * The service owns online and role/assignment gates. It never accepts content
 * plaintext; encrypted payload construction and decryption stay in the
 * coordinator/crypto layer.
 */
export class StudioReviewService {
  public constructor(
    private readonly remote: StudioReviewRemotePort,
    private readonly connectivity: StudioReviewConnectivityPort,
  ) {}

  public capabilities(contextValue: StudioReviewSessionContext): StudioReviewCapabilities {
    const context = normalizeContext(contextValue);
    if (context.membershipState !== "active" || context.assignmentState !== "active") {
      return NO_CAPABILITIES;
    }
    const actions = ROLE_ACTIONS[context.role];
    return Object.freeze({
      read: actions.has("read"),
      submit: actions.has("submit"),
      comment: actions.has("comment"),
      suggest: actions.has("suggest"),
      question: actions.has("question"),
      requestRewrite: actions.has("request_rewrite"),
      reply: actions.has("reply"),
      approve: actions.has("approve"),
      reject: actions.has("reject"),
      resolve: actions.has("resolve"),
      decideSuggestion: actions.has("decide_suggestion"),
    });
  }

  public authorize(contextValue: StudioReviewSessionContext, action: StudioReviewAction): void {
    const context = normalizeContext(contextValue);
    if (
      context.membershipState !== "active" ||
      context.assignmentState !== "active" ||
      !ROLE_ACTIONS[context.role].has(action)
    ) {
      throw new StudioReviewServiceError(
        "REVIEW_PERMISSION_DENIED",
        "The active team role and exact project assignment do not authorize this review action.",
      );
    }
  }

  public assertAvailable(
    contextValue: StudioReviewSessionContext,
    action: StudioReviewAction,
    signal?: AbortSignal,
  ): void {
    this.requireRemote(contextValue, action, signal);
  }

  public async listReviews(
    contextValue: StudioReviewSessionContext,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewListResponse> {
    const context = this.requireRemote(contextValue, "read", options.signal);
    return this.remote.listReviews(context.teamId, context.projectId, options);
  }

  public async getReview(
    contextValue: StudioReviewSessionContext,
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<CloudReviewResponse> {
    const context = this.requireRemote(contextValue, "read", signal);
    return this.remote.getReview(context.teamId, context.projectId, requireUuid(reviewId), {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async submitReview(
    contextValue: StudioReviewSessionContext,
    request: CloudReviewSubmissionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewResponse> {
    const context = this.requireRemote(contextValue, "submit", options.signal);
    return this.remote.submitReview(context.teamId, context.projectId, request, options);
  }

  public async appendThreadItem(
    contextValue: StudioReviewSessionContext,
    reviewId: string,
    request: CloudReviewThreadItemAppendRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewThreadItemResponse> {
    const context = this.requireRemote(
      contextValue,
      actionForThreadItem(request.itemType),
      options.signal,
    );
    return this.remote.appendReviewThreadItem(
      context.teamId,
      context.projectId,
      requireUuid(reviewId),
      request,
      options,
    );
  }

  public async listThreadItems(
    contextValue: StudioReviewSessionContext,
    reviewId: string,
    threadId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewThreadItemListResponse> {
    const context = this.requireRemote(contextValue, "read", options.signal);
    return this.remote.listReviewThreadItems(
      context.teamId,
      context.projectId,
      requireUuid(reviewId),
      requireUuid(threadId),
      options,
    );
  }

  public async listThreads(
    contextValue: StudioReviewSessionContext,
    reviewId: string,
    options: CloudQueryOptions = {},
  ): Promise<CloudReviewThreadListResponse> {
    const context = this.requireRemote(contextValue, "read", options.signal);
    return this.remote.listReviewThreads(
      context.teamId,
      context.projectId,
      requireUuid(reviewId),
      options,
    );
  }

  public async decideReview(
    contextValue: StudioReviewSessionContext,
    reviewId: string,
    request: CloudReviewDecisionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewResponse> {
    const context = this.requireRemote(
      contextValue,
      request.decision === "approved" ? "approve" : "reject",
      options.signal,
    );
    return this.remote.decideReview(
      context.teamId,
      context.projectId,
      requireUuid(reviewId),
      request,
      options,
    );
  }

  public async resolveThread(
    contextValue: StudioReviewSessionContext,
    reviewId: string,
    threadId: string,
    request: CloudReviewThreadResolutionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewThreadResponse> {
    const context = this.requireRemote(contextValue, "resolve", options.signal);
    return this.remote.resolveReviewThread(
      context.teamId,
      context.projectId,
      requireUuid(reviewId),
      requireUuid(threadId),
      request,
      options,
    );
  }

  public async decideSuggestion(
    contextValue: StudioReviewSessionContext,
    reviewId: string,
    threadId: string,
    itemId: string,
    request: CloudReviewSuggestionDecisionRequest,
    options: CloudMutationOptions,
  ): Promise<CloudReviewSuggestionDecisionResponse> {
    const context = this.requireRemote(contextValue, "decide_suggestion", options.signal);
    return this.remote.decideReviewSuggestion(
      context.teamId,
      context.projectId,
      requireUuid(reviewId),
      requireUuid(threadId),
      requireUuid(itemId),
      request,
      options,
    );
  }

  private requireRemote(
    contextValue: StudioReviewSessionContext,
    action: StudioReviewAction,
    signal?: AbortSignal,
  ): StudioReviewSessionContext {
    throwIfAborted(signal);
    const context = normalizeContext(contextValue);
    this.authorize(context, action);
    if (!this.connectivity.isOnline()) {
      throw new StudioReviewServiceError(
        "REVIEW_OFFLINE",
        "Studio review cloud operations require an online connection.",
      );
    }
    return context;
  }
}

const ROLE_ACTIONS: Readonly<Record<StudioReviewRole, ReadonlySet<StudioReviewAction>>> = {
  owner: new Set([
    "read",
    "submit",
    "comment",
    "suggest",
    "question",
    "request_rewrite",
    "reply",
    "approve",
    "reject",
    "resolve",
    "decide_suggestion",
  ]),
  admin: new Set([
    "read",
    "submit",
    "comment",
    "suggest",
    "question",
    "request_rewrite",
    "reply",
    "approve",
    "reject",
    "resolve",
    "decide_suggestion",
  ]),
  author: new Set([
    "read",
    "submit",
    "comment",
    "suggest",
    "question",
    "reply",
    "resolve",
    "decide_suggestion",
  ]),
  reviewer: new Set([
    "read",
    "comment",
    "suggest",
    "question",
    "request_rewrite",
    "reply",
    "approve",
    "reject",
    "resolve",
  ]),
  read_only: new Set(),
  finance_admin: new Set(),
};

const NO_CAPABILITIES: StudioReviewCapabilities = Object.freeze({
  read: false,
  submit: false,
  comment: false,
  suggest: false,
  question: false,
  requestRewrite: false,
  reply: false,
  approve: false,
  reject: false,
  resolve: false,
  decideSuggestion: false,
});

function actionForThreadItem(
  itemType: CloudReviewThreadItemAppendRequest["itemType"],
): StudioReviewAction {
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

function normalizeContext(value: StudioReviewSessionContext): StudioReviewSessionContext {
  const role = value.role;
  if (
    !Object.hasOwn(ROLE_ACTIONS, role) ||
    !["active", "revoked"].includes(value.membershipState) ||
    !["active", "revoked", "missing"].includes(value.assignmentState)
  ) {
    throw invalidScope();
  }
  return Object.freeze({
    tenantId: requireUuid(value.tenantId),
    teamId: requireUuid(value.teamId),
    projectId: requireUuid(value.projectId),
    membershipId: requireUuid(value.membershipId),
    role,
    membershipState: value.membershipState,
    assignmentState: value.assignmentState,
  });
}

function requireUuid(value: unknown): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw invalidScope();
  }
  return parsed.data.toLowerCase();
}

function invalidScope(): StudioReviewServiceError {
  return new StudioReviewServiceError(
    "REVIEW_SCOPE_INVALID",
    "The Studio review team/project authority scope is invalid.",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The Studio review operation was cancelled.", "AbortError");
  }
}
