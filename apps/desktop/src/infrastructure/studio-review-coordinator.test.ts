/* eslint-disable @typescript-eslint/require-await */

import {
  CONTRACT_SCHEMA_VERSION,
  type CloudReview,
  type CloudReviewListResponse,
  type CloudReviewResponse,
  type CloudReviewSuggestionDecisionResponse,
  type CloudReviewSummary,
  type CloudReviewThread,
  type CloudReviewThreadItem,
  type CloudReviewThreadItemListResponse,
  type CloudReviewThreadItemResponse,
  type CloudReviewThreadResponse,
} from "@inkshadow/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  StudioReviewCoordinator,
  type StableEncryptedReviewSource,
  type StudioReviewCandidateVersionPort,
  type StudioReviewIdPort,
  type StudioReviewIdempotencyPort,
  type StudioReviewProjectKeyAccessPort,
  type StudioReviewStableSourcePort,
  type StudioReviewSuggestionApplicationReceipt,
  type VerifiedStudioReviewSuggestionApplication,
} from "./studio-review-coordinator";
import { StudioReviewCrypto, type StudioReviewTextAnchor } from "./studio-review-crypto";
import {
  StudioReviewService,
  type StudioReviewRemotePort,
  type StudioReviewSessionContext,
} from "./studio-review-service";

describe("Studio encrypted review coordinator", () => {
  it("coordinates submission, listing, reading, every thread item, review decisions and resolution", async () => {
    const harness = await createHarness();
    const submitted = await harness.coordinator.submitReview(AUTHOR, {
      title: "Confidential review",
      note: "Only devices may read this note.",
    });

    expect(submitted.payload.title).toBe("Confidential review");
    expect(JSON.stringify(harness.remote.lastSubmission)).not.toContain("Confidential review");
    expect(await harness.coordinator.listReviews(AUTHOR)).toMatchObject({
      reviews: [{ reviewId: submitted.review.reviewId }],
    });
    expect(
      (await harness.coordinator.readReview(REVIEWER, submitted.review.reviewId)).payload.note,
    ).toBe("Only devices may read this note.");

    const comment = await harness.coordinator.appendThreadItem(
      REVIEWER,
      submitted.review.reviewId,
      { itemType: "comment", body: "Tighten this paragraph.", anchor: null },
    );
    await harness.coordinator.appendThreadItem(REVIEWER, submitted.review.reviewId, {
      itemType: "question",
      body: "What motivates this turn?",
      anchor: null,
    });
    await harness.coordinator.appendThreadItem(REVIEWER, submitted.review.reviewId, {
      itemType: "rewrite_request",
      body: "Please rewrite the opening.",
      anchor: null,
    });
    const suggestion = await harness.coordinator.appendThreadItem(
      REVIEWER,
      submitted.review.reviewId,
      {
        itemType: "suggestion",
        body: "Use a more concrete sentence.",
        anchor: ANCHOR,
        replacementText: "The harbor bell rang once.",
      },
    );
    const reply = await harness.coordinator.appendThreadItem(AUTHOR, submitted.review.reviewId, {
      itemType: "reply",
      body: "I will preserve the image and adjust the cadence.",
      anchor: null,
      threadId: suggestion.thread.threadId,
      parentItemId: suggestion.item.itemId,
      expectedThreadRevision: suggestion.thread.revision,
    });

    const thread = await harness.coordinator.readThread(
      AUTHOR,
      submitted.review.reviewId,
      suggestion.thread.threadId,
    );
    expect(thread.items.map((entry) => entry.state)).toEqual(["ready", "ready"]);
    expect(
      thread.items.flatMap((entry) => (entry.state === "ready" ? [entry.payload.body] : [])),
    ).toEqual([
      "Use a more concrete sentence.",
      "I will preserve the image and adjust the cadence.",
    ]);
    expect(reply.item.parentItemId).toBe(suggestion.item.itemId);
    expect(comment.item.itemType).toBe("comment");

    const resolved = await harness.coordinator.resolveThread(
      REVIEWER,
      submitted.review.reviewId,
      thread.thread,
    );
    expect(resolved.thread.state).toBe("resolved");
    const approved = await harness.coordinator.decideReview(REVIEWER, submitted.review, "approved");
    expect(approved.review.state).toBe("approved");
    await expect(
      harness.coordinator.decideReview(AUTHOR, submitted.review, "approved"),
    ).rejects.toMatchObject({ code: "REVIEW_PERMISSION_DENIED" });
  });

  it("applies an accepted suggestion locally before metadata and safely retries partial success", async () => {
    const harness = await createHarness();
    const submitted = await harness.coordinator.submitReview(AUTHOR, {
      title: "Accept-order review",
      note: "",
    });
    const suggestion = await harness.coordinator.appendThreadItem(
      REVIEWER,
      submitted.review.reviewId,
      {
        itemType: "suggestion",
        body: "Candidate for the author.",
        anchor: ANCHOR,
        replacementText: "A locally versioned replacement.",
      },
    );
    harness.remote.failNextSuggestionDecision = true;

    const first = await harness.coordinator.acceptSuggestion(AUTHOR, {
      reviewId: submitted.review.reviewId,
      threadId: suggestion.thread.threadId,
      itemId: suggestion.item.itemId,
      expectedItemRevision: suggestion.item.revision,
    });

    expect(first.status).toBe("partial_retry");
    expect(harness.events.slice(-2)).toEqual(["candidate.apply", "remote.suggestion-decision"]);
    expect(harness.candidates.applications).toHaveLength(1);
    if (first.status !== "partial_retry") {
      throw new Error("Expected a recoverable partial outcome.");
    }
    const retried = await harness.coordinator.retryAcceptedSuggestionDecision(AUTHOR, first);
    expect(retried.status).toBe("accepted");
    expect(harness.candidates.applications).toHaveLength(1);
    expect(harness.candidates.loads).toBe(1);
    expect(harness.candidates.applications[0]?.candidate.replacement.text).toBe(
      "A locally versioned replacement.",
    );
  });

  it("never records accepted metadata when the author-side version port fails or the base changed", async () => {
    const harness = await createHarness();
    const submitted = await harness.coordinator.submitReview(AUTHOR, {
      title: "CAS review",
      note: "",
    });
    const suggestion = await harness.coordinator.appendThreadItem(
      REVIEWER,
      submitted.review.reviewId,
      {
        itemType: "suggestion",
        body: "Apply only against the reviewed base.",
        anchor: ANCHOR,
        replacementText: "Candidate text.",
      },
    );
    harness.candidates.failApply = true;

    await expect(
      harness.coordinator.acceptSuggestion(AUTHOR, {
        reviewId: submitted.review.reviewId,
        threadId: suggestion.thread.threadId,
        itemId: suggestion.item.itemId,
        expectedItemRevision: suggestion.item.revision,
      }),
    ).rejects.toThrow("local candidate port failed");
    expect(harness.remote.suggestionDecisionCalls).toBe(0);

    harness.candidates.failApply = false;
    harness.stable.source = {
      ...STABLE_SOURCE,
      sourceVersionId: uuid(901),
      sourceVersionRevision: 2,
      authoritativeCiphertextSha256: "9".repeat(64),
    };
    await expect(
      harness.coordinator.acceptSuggestion(AUTHOR, {
        reviewId: submitted.review.reviewId,
        threadId: suggestion.thread.threadId,
        itemId: suggestion.item.itemId,
        expectedItemRevision: suggestion.item.revision,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_SOURCE_CHANGED" });
    expect(harness.candidates.applications).toHaveLength(0);
    expect(harness.remote.suggestionDecisionCalls).toBe(0);
  });

  it("blocks reviewer正文 application and lets authors reject metadata without a local write", async () => {
    const harness = await createHarness();
    const submitted = await harness.coordinator.submitReview(AUTHOR, {
      title: "Role review",
      note: "",
    });
    const suggestion = await harness.coordinator.appendThreadItem(
      REVIEWER,
      submitted.review.reviewId,
      {
        itemType: "suggestion",
        body: "Reviewer suggestion.",
        anchor: ANCHOR,
        replacementText: "Candidate text.",
      },
    );
    const input = {
      reviewId: submitted.review.reviewId,
      threadId: suggestion.thread.threadId,
      itemId: suggestion.item.itemId,
      expectedItemRevision: suggestion.item.revision,
    };

    await expect(harness.coordinator.acceptSuggestion(REVIEWER, input)).rejects.toMatchObject({
      code: "REVIEW_PERMISSION_DENIED",
    });
    expect(harness.candidates.applications).toHaveLength(0);
    expect(harness.remote.suggestionDecisionCalls).toBe(0);

    const rejected = await harness.coordinator.rejectSuggestion(AUTHOR, input);
    expect(rejected.item.suggestionDecision).toBe("rejected");
    expect(harness.candidates.applications).toHaveLength(0);
  });

  it("isolates one corrupt item without hiding healthy entries in the same thread", async () => {
    const harness = await createHarness();
    const submitted = await harness.coordinator.submitReview(AUTHOR, {
      title: "Corruption isolation",
      note: "",
    });
    const root = await harness.coordinator.appendThreadItem(REVIEWER, submitted.review.reviewId, {
      itemType: "comment",
      body: "This item will be corrupted.",
      anchor: null,
    });
    await harness.coordinator.appendThreadItem(AUTHOR, submitted.review.reviewId, {
      itemType: "reply",
      body: "This reply remains readable.",
      anchor: null,
      threadId: root.thread.threadId,
      parentItemId: root.item.itemId,
      expectedThreadRevision: root.thread.revision,
    });
    harness.remote.corruptItem(root.item.itemId);

    const view = await harness.coordinator.readThread(
      AUTHOR,
      submitted.review.reviewId,
      root.thread.threadId,
    );
    expect(view.items[0]).toMatchObject({
      state: "corrupt",
      item: { itemId: root.item.itemId },
    });
    expect(view.items[1]).toMatchObject({
      state: "ready",
      payload: { body: "This reply remains readable." },
    });
  });

  it("fails closed when no authoritative settled encrypted source exists", async () => {
    const harness = await createHarness();
    harness.stable.source = null;

    await expect(
      harness.coordinator.submitReview(AUTHOR, { title: "Never sent", note: "plaintext" }),
    ).rejects.toMatchObject({ code: "REVIEW_SOURCE_UNAVAILABLE" });
    expect(harness.remote.submitCalls).toBe(0);

    harness.stable.source = {
      ...STABLE_SOURCE,
      authority: "forged_plaintext_digest" as StableEncryptedReviewSource["authority"],
    };
    await expect(
      harness.coordinator.submitReview(AUTHOR, { title: "Still never sent", note: "" }),
    ).rejects.toMatchObject({ code: "REVIEW_SOURCE_INVALID" });
    expect(harness.remote.submitCalls).toBe(0);
  });

  it("turns cancellation after local application into an explicit partial retry", async () => {
    const harness = await createHarness();
    const submitted = await harness.coordinator.submitReview(AUTHOR, {
      title: "Cancellation review",
      note: "",
    });
    const suggestion = await harness.coordinator.appendThreadItem(
      REVIEWER,
      submitted.review.reviewId,
      {
        itemType: "suggestion",
        body: "Cancel after local version.",
        anchor: ANCHOR,
        replacementText: "Durable candidate.",
      },
    );
    const abort = new AbortController();
    harness.candidates.abortAfterApply = abort;

    const outcome = await harness.coordinator.acceptSuggestion(
      AUTHOR,
      {
        reviewId: submitted.review.reviewId,
        threadId: suggestion.thread.threadId,
        itemId: suggestion.item.itemId,
        expectedItemRevision: suggestion.item.revision,
      },
      abort.signal,
    );
    expect(outcome).toMatchObject({
      status: "partial_retry",
      failureCode: "CLOUD_REQUEST_ABORTED",
    });
    expect(harness.remote.suggestionDecisionCalls).toBe(0);
  });

  it("rejects malicious cross-tenant/project responses on every coordinator path", async () => {
    const harness = await createHarness();
    const submitted = await harness.coordinator.submitReview(AUTHOR, {
      title: "Scope review",
      note: "",
    });
    const suggestion = await harness.coordinator.appendThreadItem(
      REVIEWER,
      submitted.review.reviewId,
      {
        itemType: "suggestion",
        body: "Scope-bound suggestion.",
        anchor: ANCHOR,
        replacementText: "Scoped candidate.",
      },
    );

    harness.remote.attack = "list";
    await expect(harness.coordinator.listReviews(AUTHOR)).rejects.toMatchObject({
      code: "REVIEW_REMOTE_RESPONSE_INVALID",
    });

    harness.remote.attack = "review_decision";
    await expect(
      harness.coordinator.decideReview(REVIEWER, submitted.review, "approved"),
    ).rejects.toMatchObject({ code: "REVIEW_REMOTE_RESPONSE_INVALID" });

    harness.remote.attack = "thread_list";
    await expect(
      harness.coordinator.readThread(AUTHOR, submitted.review.reviewId, suggestion.thread.threadId),
    ).rejects.toMatchObject({ code: "REVIEW_REMOTE_RESPONSE_INVALID" });

    harness.remote.attack = "thread_item";
    await expect(
      harness.coordinator.readThread(AUTHOR, submitted.review.reviewId, suggestion.thread.threadId),
    ).rejects.toMatchObject({ code: "REVIEW_REMOTE_RESPONSE_INVALID" });

    harness.remote.attack = "threads";
    await expect(
      harness.coordinator.listThreads(AUTHOR, submitted.review.reviewId),
    ).rejects.toMatchObject({ code: "REVIEW_REMOTE_RESPONSE_INVALID" });

    harness.remote.attack = "thread_resolution";
    await expect(
      harness.coordinator.resolveThread(REVIEWER, submitted.review.reviewId, suggestion.thread),
    ).rejects.toMatchObject({ code: "REVIEW_REMOTE_RESPONSE_INVALID" });

    harness.remote.attack = "suggestion_decision";
    await expect(
      harness.coordinator.rejectSuggestion(AUTHOR, {
        reviewId: submitted.review.reviewId,
        threadId: suggestion.thread.threadId,
        itemId: suggestion.item.itemId,
        expectedItemRevision: suggestion.item.revision,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_REMOTE_RESPONSE_INVALID" });

    harness.remote.attack = null;
    harness.remote.failNextSuggestionDecision = true;
    const partial = await harness.coordinator.acceptSuggestion(AUTHOR, {
      reviewId: submitted.review.reviewId,
      threadId: suggestion.thread.threadId,
      itemId: suggestion.item.itemId,
      expectedItemRevision: suggestion.item.revision,
    });
    if (partial.status !== "partial_retry") {
      throw new Error("Expected partial metadata retry.");
    }
    harness.remote.attack = "suggestion_decision";
    await expect(
      harness.coordinator.retryAcceptedSuggestionDecision(AUTHOR, partial),
    ).resolves.toMatchObject({
      status: "partial_retry",
      failureCode: "REVIEW_REMOTE_RESPONSE_INVALID",
    });
  });

  it("does not log plaintext during full encrypted coordination", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await createHarness();

    await harness.coordinator.submitReview(AUTHOR, {
      title: "never-print-title",
      note: "never-print-note",
    });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

type ScopeAttack =
  | "list"
  | "threads"
  | "review_decision"
  | "thread_list"
  | "thread_item"
  | "thread_resolution"
  | "suggestion_decision";

class MemoryReviewRemote implements StudioReviewRemotePort {
  public readonly events: string[];
  public readonly reviews = new Map<string, CloudReview>();
  public readonly threads = new Map<string, CloudReviewThread>();
  public readonly items = new Map<string, CloudReviewThreadItem[]>();
  public lastSubmission: unknown = null;
  public submitCalls = 0;
  public suggestionDecisionCalls = 0;
  public failNextSuggestionDecision = false;
  public attack: ScopeAttack | null = null;
  private requestSequence = 500;

  public constructor(events: string[]) {
    this.events = events;
  }

  public submitReview: StudioReviewRemotePort["submitReview"] = async (
    teamId,
    projectId,
    request,
    options,
  ) => {
    throwIfAborted(options.signal);
    this.submitCalls += 1;
    this.lastSubmission = request;
    const review: CloudReview = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      reviewId: request.reviewId,
      tenantId: AUTHOR.tenantId,
      teamId,
      projectId,
      sourceVersionId: request.sourceVersionId,
      sourceVersionRevision: request.sourceVersionRevision,
      sourceCiphertextSha256: request.sourceCiphertextSha256,
      projectKeyVersion: request.projectKeyVersion,
      submittedByMembershipId: AUTHOR.membershipId,
      state: "pending",
      revision: 1,
      decisionByMembershipId: null,
      decidedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      payload: request.payload,
    };
    this.reviews.set(review.reviewId, review);
    return this.reviewResponse(review);
  };

  public listReviews: StudioReviewRemotePort["listReviews"] = async (
    teamId,
    projectId,
    options,
  ) => {
    throwIfAborted(options?.signal);
    const summaries = [...this.reviews.values()]
      .filter((review) => review.teamId === teamId && review.projectId === projectId)
      .map((review) => summary(review));
    const reviews =
      this.attack === "list" && summaries[0] !== undefined
        ? [{ ...summaries[0], tenantId: uuid(999) }, ...summaries.slice(1)]
        : summaries;
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: this.requestId(),
      reviews,
      nextCursor: null,
    } satisfies CloudReviewListResponse;
  };

  public getReview: StudioReviewRemotePort["getReview"] = async (
    _teamId,
    _projectId,
    reviewId,
    options,
  ) => {
    throwIfAborted(options?.signal);
    return this.reviewResponse(requireMap(this.reviews, reviewId));
  };

  public decideReview: StudioReviewRemotePort["decideReview"] = async (
    _teamId,
    _projectId,
    reviewId,
    request,
    options,
  ) => {
    throwIfAborted(options.signal);
    const current = requireMap(this.reviews, reviewId);
    const next: CloudReview = {
      ...current,
      state: request.decision,
      revision: current.revision + 1,
      decisionByMembershipId: REVIEWER.membershipId,
      decidedAt: LATER,
      updatedAt: LATER,
    };
    this.reviews.set(reviewId, next);
    return this.reviewResponse(
      this.attack === "review_decision" ? { ...next, projectId: uuid(998) } : next,
    );
  };

  public appendReviewThreadItem: StudioReviewRemotePort["appendReviewThreadItem"] = async (
    _teamId,
    _projectId,
    reviewId,
    request,
    options,
  ) => {
    throwIfAborted(options.signal);
    const currentThread = this.threads.get(request.threadId);
    const thread: CloudReviewThread =
      currentThread === undefined
        ? {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            threadId: request.threadId,
            tenantId: AUTHOR.tenantId,
            teamId: AUTHOR.teamId,
            projectId: AUTHOR.projectId,
            reviewId,
            rootItemId: request.itemId,
            state: "open",
            revision: 1,
            itemCount: 1,
            createdByMembershipId: REVIEWER.membershipId,
            resolvedByMembershipId: null,
            resolvedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          }
        : {
            ...currentThread,
            revision: currentThread.revision + 1,
            itemCount: currentThread.itemCount + 1,
            updatedAt: LATER,
          };
    const item: CloudReviewThreadItem = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      itemId: request.itemId,
      threadId: request.threadId,
      tenantId: AUTHOR.tenantId,
      teamId: AUTHOR.teamId,
      projectId: AUTHOR.projectId,
      reviewId,
      itemType: request.itemType,
      parentItemId: request.parentItemId,
      payload: request.payload,
      createdByMembershipId: REVIEWER.membershipId,
      revision: 1,
      suggestionDecision: request.itemType === "suggestion" ? "pending" : null,
      suggestionDecidedByMembershipId: null,
      suggestionDecidedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.threads.set(thread.threadId, thread);
    this.items.set(thread.threadId, [...(this.items.get(thread.threadId) ?? []), item]);
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: this.requestId(),
      thread,
      item,
    } satisfies CloudReviewThreadItemResponse;
  };

  public listReviewThreadItems: StudioReviewRemotePort["listReviewThreadItems"] = async (
    _teamId,
    _projectId,
    _reviewId,
    threadId,
    options,
  ) => {
    throwIfAborted(options?.signal);
    const thread = requireMap(this.threads, threadId);
    const items = (this.items.get(threadId) ?? []).map((item, index) =>
      this.attack === "thread_item" && index === 0 ? { ...item, threadId: uuid(993) } : item,
    );
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: this.requestId(),
      thread: this.attack === "thread_list" ? { ...thread, tenantId: uuid(997) } : thread,
      items,
      nextCursor: null,
    } satisfies CloudReviewThreadItemListResponse;
  };

  public listReviewThreads: StudioReviewRemotePort["listReviewThreads"] = async (
    _teamId,
    _projectId,
    reviewId,
    options,
  ) => {
    throwIfAborted(options?.signal);
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: this.requestId(),
      threads: [...this.threads.values()]
        .filter((thread) => thread.reviewId === reviewId)
        .map((thread) => (this.attack === "threads" ? { ...thread, tenantId: uuid(994) } : thread)),
      nextCursor: null,
    };
  };

  public resolveReviewThread: StudioReviewRemotePort["resolveReviewThread"] = async (
    _teamId,
    _projectId,
    _reviewId,
    threadId,
    _request,
    options,
  ) => {
    throwIfAborted(options.signal);
    const current = requireMap(this.threads, threadId);
    const next: CloudReviewThread = {
      ...current,
      state: "resolved",
      revision: current.revision + 1,
      resolvedByMembershipId: REVIEWER.membershipId,
      resolvedAt: LATER,
      updatedAt: LATER,
    };
    this.threads.set(threadId, next);
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: this.requestId(),
      thread: this.attack === "thread_resolution" ? { ...next, projectId: uuid(996) } : next,
    } satisfies CloudReviewThreadResponse;
  };

  public decideReviewSuggestion: StudioReviewRemotePort["decideReviewSuggestion"] = async (
    _teamId,
    _projectId,
    _reviewId,
    threadId,
    itemId,
    request,
    options,
  ) => {
    throwIfAborted(options.signal);
    this.events.push("remote.suggestion-decision");
    this.suggestionDecisionCalls += 1;
    if (this.failNextSuggestionDecision) {
      this.failNextSuggestionDecision = false;
      throw Object.assign(new Error("offline"), { code: "CLOUD_NETWORK_UNAVAILABLE" });
    }
    const thread = requireMap(this.threads, threadId);
    const entries = this.items.get(threadId) ?? [];
    const current = entries.find((item) => item.itemId === itemId);
    if (current === undefined) {
      throw new Error("missing suggestion");
    }
    const item: CloudReviewThreadItem = {
      ...current,
      revision: current.revision + 1,
      suggestionDecision: request.decision,
      suggestionDecidedByMembershipId: AUTHOR.membershipId,
      suggestionDecidedAt: LATER,
      updatedAt: LATER,
    };
    if (this.attack !== "suggestion_decision") {
      this.items.set(
        threadId,
        entries.map((entry) => (entry.itemId === itemId ? item : entry)),
      );
    }
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: this.requestId(),
      effect: "metadata_only_no_content_mutation",
      thread,
      item: this.attack === "suggestion_decision" ? { ...item, teamId: uuid(995) } : item,
    } satisfies CloudReviewSuggestionDecisionResponse;
  };

  public corruptItem(itemId: string): void {
    for (const [threadId, entries] of this.items) {
      this.items.set(
        threadId,
        entries.map((item) => {
          if (item.itemId !== itemId) {
            return item;
          }
          const first = item.payload.ciphertext.startsWith("A") ? "B" : "A";
          return {
            ...item,
            payload: {
              ...item.payload,
              ciphertext: `${first}${item.payload.ciphertext.slice(1)}`,
            },
          };
        }),
      );
    }
  }

  private reviewResponse(review: CloudReview): CloudReviewResponse {
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: this.requestId(),
      review,
    };
  }

  private requestId(): string {
    this.requestSequence += 1;
    return uuid(this.requestSequence);
  }
}

class MemoryCandidates implements StudioReviewCandidateVersionPort {
  public readonly applications: VerifiedStudioReviewSuggestionApplication[] = [];
  public readonly receipts = new Map<string, StudioReviewSuggestionApplicationReceipt>();
  public loads = 0;
  public failApply = false;
  public abortAfterApply: AbortController | null = null;

  public constructor(private readonly events: string[]) {}

  public async applyVerifiedSuggestion(
    application: VerifiedStudioReviewSuggestionApplication,
    signal?: AbortSignal,
  ): Promise<StudioReviewSuggestionApplicationReceipt> {
    throwIfAborted(signal);
    this.events.push("candidate.apply");
    if (this.failApply) {
      throw new Error("local candidate port failed");
    }
    this.applications.push(application);
    const existing = this.receipts.get(application.itemId);
    if (existing !== undefined) {
      return { ...existing, result: "already_applied" };
    }
    const receipt: StudioReviewSuggestionApplicationReceipt = {
      authority: "local_review_suggestion_version",
      applicationId: application.applicationId,
      tenantId: application.tenantId,
      teamId: application.teamId,
      projectId: application.projectId,
      reviewId: application.reviewId,
      threadId: application.threadId,
      itemId: application.itemId,
      candidateId: application.candidate.candidateId,
      baseSourceVersionId: application.expectedBase.sourceVersionId,
      baseSourceVersionRevision: application.expectedBase.sourceVersionRevision,
      baseSourceCiphertextSha256: application.expectedBase.sourceCiphertextSha256,
      newVersionId: uuid(800),
      newVersionRevision: 2,
      result: "created",
    };
    this.receipts.set(application.itemId, receipt);
    this.abortAfterApply?.abort();
    return receipt;
  }

  public async loadAppliedSuggestion(
    scope: Readonly<{ itemId: string }>,
    expected: StudioReviewSuggestionApplicationReceipt,
  ): Promise<StudioReviewSuggestionApplicationReceipt | null> {
    this.loads += 1;
    const stored = this.receipts.get(scope.itemId) ?? null;
    return stored?.newVersionId === expected.newVersionId ? stored : null;
  }
}

class StableSource implements StudioReviewStableSourcePort {
  public source: StableEncryptedReviewSource | null = STABLE_SOURCE;

  public async loadStableEncryptedSource(): Promise<StableEncryptedReviewSource | null> {
    return this.source;
  }
}

class SequenceIds implements StudioReviewIdPort {
  private sequence = 100;

  public next(): string {
    this.sequence += 1;
    return uuid(this.sequence);
  }
}

class SequenceIdempotency implements StudioReviewIdempotencyPort {
  private sequence = 0;

  public next(purpose: string): string {
    this.sequence += 1;
    return `studio.review.${purpose}.${String(this.sequence).padStart(6, "0")}`;
  }
}

async function createHarness() {
  const events: string[] = [];
  const remote = new MemoryReviewRemote(events);
  const service = new StudioReviewService(remote, { isOnline: () => true });
  const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const openReviewProjectKey: StudioReviewProjectKeyAccessPort["openReviewProjectKey"] = (
    request,
  ) =>
    Promise.resolve({
      projectId: request.projectId,
      keyVersion: request.keyVersion,
      key,
    });
  const projectKeys: StudioReviewProjectKeyAccessPort = {
    openReviewProjectKey: vi.fn(openReviewProjectKey),
  };
  const stable = new StableSource();
  const candidates = new MemoryCandidates(events);
  const coordinator = new StudioReviewCoordinator({
    service,
    crypto: new StudioReviewCrypto(),
    stableSources: stable,
    projectKeys,
    candidates,
    ids: new SequenceIds(),
    idempotencyKeys: new SequenceIdempotency(),
  });
  return { coordinator, remote, stable, candidates, events, projectKeys };
}

const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T00:01:00.000Z";
const SOURCE_VERSION_ID = uuid(10);
const CHAPTER_ID = uuid(11);

const AUTHOR: StudioReviewSessionContext = {
  tenantId: uuid(1),
  teamId: uuid(2),
  projectId: uuid(3),
  membershipId: uuid(4),
  role: "author",
  membershipState: "active",
  assignmentState: "active",
};

const REVIEWER: StudioReviewSessionContext = {
  ...AUTHOR,
  membershipId: uuid(5),
  role: "reviewer",
};

const STABLE_SOURCE: StableEncryptedReviewSource = {
  authority: "saved_stable_encrypted_projection",
  projectionState: "settled",
  tenantId: AUTHOR.tenantId,
  teamId: AUTHOR.teamId,
  projectId: AUTHOR.projectId,
  sourceVersionId: SOURCE_VERSION_ID,
  sourceVersionRevision: 1,
  authoritativeCiphertextSha256: "a".repeat(64),
  projectKeyVersion: 1,
};

const ANCHOR: StudioReviewTextAnchor = {
  chapterId: CHAPTER_ID,
  startUtf16: 10,
  endUtf16: 20,
  selectedTextSha256: "b".repeat(64),
};

function summary(review: CloudReview): CloudReviewSummary {
  const { payload: _payload, ...result } = review;
  void _payload;
  return result;
}

function requireMap<T>(map: ReadonlyMap<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing memory review fixture ${key}`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("cancelled", "AbortError");
  }
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
