import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StudioReviewPage, type StudioReviewPageCoordinator } from "./studio-review-page";
import type { StudioReviewSessionContext } from "../infrastructure/studio-review-service";

describe("Studio review standalone page", () => {
  it("shows loading, empty and honest offline states without fake remote success", async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const coordinator = fakeCoordinator({
      listReviews: vi.fn(() => pending) as StudioReviewPageCoordinator["listReviews"],
    });
    const view = render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);
    expect(screen.getByText("正在加载团队审阅")).toBeVisible();
    release?.(reviewList([]));
    expect(await screen.findByText("还没有审阅")).toBeVisible();

    view.rerender(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online={false} />);
    expect(await screen.findByText("当前离线")).toBeVisible();
    expect(screen.getByText(/不会伪造远程成功/u)).toBeVisible();
  });

  it.each([
    ["REVIEW_KEY_MISSING", "缺少项目密钥"],
    ["REVIEW_CIPHERTEXT_CORRUPT", "审阅密文损坏"],
    ["REVISION_CONFLICT", "审阅版本冲突"],
  ])("renders the %s fail-closed state", async (code, label) => {
    const coordinator = fakeCoordinator({
      listReviews: vi.fn(() => Promise.reject(Object.assign(new Error(code), { code }))),
    });
    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);
    expect(await screen.findByText(label)).toBeVisible();
  });

  it("keeps an unknown technical failure out of the visible review error", async () => {
    const rawMessage = "Candidate invocation metadata is invalid";
    const coordinator = fakeCoordinator({
      listReviews: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error(rawMessage), {
            code: "REVIEW_SOURCE_INVALID",
          }),
        ),
      ),
    });

    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);

    expect(await screen.findByText("团队审阅暂不可用")).toBeVisible();
    expect(screen.getByText(/系统不会自动重复提交/u)).toBeVisible();
    expect(screen.queryByText("REVIEW_SOURCE_INVALID")).not.toBeInTheDocument();
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
  });

  it("shows a no-capability state without issuing a remote review read", async () => {
    const coordinator = fakeCoordinator({
      capabilities: vi.fn(() => ({
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
      })),
    });
    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);

    expect(await screen.findByText("没有审阅权限")).toBeVisible();
    expect(coordinator.listReviews).not.toHaveBeenCalled();
  });

  it("discovers threads, isolates a corrupt item and exposes reply only when authorized", async () => {
    const user = userEvent.setup();
    const coordinator = fakeCoordinator();
    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);

    await user.click(await screen.findByRole("button", { name: /开放线程 · 2 条/u }));
    expect(await screen.findByText("此条密文损坏")).toBeVisible();
    expect(screen.getByText("healthy reply")).toBeVisible();
    expect(screen.getByRole("button", { name: "回复" })).toBeVisible();
    expect(screen.queryByLabelText("线程 ID")).not.toBeInTheDocument();
  });

  it("updates the thread directory summary after resolving the selected thread", async () => {
    const user = userEvent.setup();
    const resolvedThread = {
      ...thread(),
      state: "resolved" as const,
      revision: 3,
      resolvedByMembershipId: AUTHOR.membershipId,
      resolvedAt: NOW,
    };
    const coordinator = fakeCoordinator({
      resolveThread: vi.fn(() =>
        Promise.resolve({
          schemaVersion: 1,
          requestId: uuid(93),
          thread: resolvedThread,
        }),
      ) as unknown as StudioReviewPageCoordinator["resolveThread"],
    });
    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);

    await user.click(await screen.findByRole("button", { name: /开放线程 · 2 条/u }));
    await user.click(screen.getByRole("button", { name: "标记线程已解决" }));

    expect(await screen.findByRole("button", { name: /已解决线程 · 2 条/u })).toBeVisible();
    expect(screen.getByText(/已解决 · 修订 3/u)).toBeVisible();
  });

  it("shows and retries partial suggestion acceptance without a second正文 action", async () => {
    const user = userEvent.setup();
    const coordinator = fakeCoordinator({
      readThread: vi.fn(() =>
        Promise.resolve(suggestionThreadView()),
      ) as unknown as StudioReviewPageCoordinator["readThread"],
      acceptSuggestion: vi.fn(() => Promise.resolve(partialOutcome())),
      retryAcceptedSuggestionDecision: vi.fn(() =>
        Promise.resolve({
          status: "accepted",
          application: partialOutcome().application,
          decision: {},
        }),
      ) as unknown as StudioReviewPageCoordinator["retryAcceptedSuggestionDecision"],
    });
    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);

    await user.click(await screen.findByRole("button", { name: /开放线程 · 2 条/u }));
    await user.click(await screen.findByRole("button", { name: "接受并创建本地版本" }));
    expect(await screen.findByText("本地版本已创建，云端标记待重试")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试云端标记" }));
    expect(coordinator.acceptSuggestion).toHaveBeenCalledTimes(1);
    expect(coordinator.retryAcceptedSuggestionDecision).toHaveBeenCalledTimes(1);
  });

  it("detects a multi-step thread cursor loop instead of cycling A to B to A", async () => {
    const user = userEvent.setup();
    const second = { ...thread(), threadId: uuid(33), rootItemId: uuid(34) };
    const listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        requestId: uuid(90),
        threads: [thread()],
        nextCursor: "cursor-A",
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        requestId: uuid(91),
        threads: [second],
        nextCursor: "cursor-B",
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        requestId: uuid(92),
        threads: [],
        nextCursor: "cursor-A",
      });
    const coordinator = fakeCoordinator({
      listThreads: listThreads as unknown as StudioReviewPageCoordinator["listThreads"],
    });
    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);

    await user.click(await screen.findByRole("button", { name: "加载更多线程" }));
    expect(screen.getAllByRole("button", { name: /开放线程/u })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "加载更多线程" }));
    expect(await screen.findByText("团队审阅暂不可用")).toBeVisible();
  });

  it("keeps the newer operation busy when an aborted predecessor settles later", async () => {
    const user = userEvent.setup();
    let rejectSubmission: ((reason: unknown) => void) | undefined;
    let releaseItem: ((value: unknown) => void) | undefined;
    const submitReview = vi.fn(
      (_context: unknown, _input: unknown, signal?: AbortSignal) =>
        new Promise((_, reject) => {
          rejectSubmission = reject;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const appendThreadItem = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseItem = resolve;
        }),
    );
    const coordinator = fakeCoordinator({
      submitReview: submitReview as unknown as StudioReviewPageCoordinator["submitReview"],
      appendThreadItem:
        appendThreadItem as unknown as StudioReviewPageCoordinator["appendThreadItem"],
    });
    render(<StudioReviewPage coordinator={coordinator} context={AUTHOR} online />);

    await user.type(await screen.findByLabelText("审阅标题"), "overlap");
    await user.type(screen.getByLabelText("内容"), "second operation");
    const submissionForm = screen.getByRole("button", { name: "加密并提交" }).closest("form");
    const itemForm = screen.getByRole("button", { name: "加密并发送" }).closest("form");
    if (submissionForm === null || itemForm === null) {
      throw new Error("Expected both Studio review forms.");
    }

    fireEvent.submit(submissionForm);
    await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
    fireEvent.submit(itemForm);
    await waitFor(() => expect(appendThreadItem).toHaveBeenCalledTimes(1));
    rejectSubmission?.(new DOMException("cancelled", "AbortError"));

    expect(await screen.findByRole("button", { name: "取消当前操作" })).toBeVisible();
    expect(screen.getByRole("button", { name: "加密并发送" })).toBeDisabled();

    releaseItem?.(appendedComment());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "取消当前操作" })).not.toBeInTheDocument(),
    );
  });
});

function fakeCoordinator(
  overrides: Partial<StudioReviewPageCoordinator> = {},
): StudioReviewPageCoordinator {
  return {
    capabilities: vi.fn(() => ({
      read: true,
      submit: true,
      comment: true,
      suggest: true,
      question: true,
      requestRewrite: false,
      reply: true,
      approve: false,
      reject: false,
      resolve: true,
      decideSuggestion: true,
    })),
    listReviews: vi.fn(() => Promise.resolve(reviewList([summary()]))),
    readReview: vi.fn(() => Promise.resolve(decryptedReview())),
    listThreads: vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        requestId: uuid(90),
        threads: [thread()],
        nextCursor: null,
      }),
    ),
    readThread: vi.fn(() => Promise.resolve(corruptThreadView())),
    submitReview: vi.fn(),
    appendThreadItem: vi.fn(),
    decideReview: vi.fn(),
    resolveThread: vi.fn(),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
    retryAcceptedSuggestionDecision: vi.fn(),
    ...overrides,
  } as unknown as StudioReviewPageCoordinator;
}

function reviewList(reviews: readonly ReturnType<typeof summary>[]) {
  return { schemaVersion: 1, requestId: uuid(91), reviews, nextCursor: null };
}

function decryptedReview() {
  return {
    review: review(),
    payload: {
      schemaVersion: 1,
      kind: "submission" as const,
      title: "Encrypted review",
      note: "Device-only note",
      source: {
        sourceVersionId: uuid(10),
        sourceVersionRevision: 1,
        sourceCiphertextSha256: "a".repeat(64),
      },
    },
  };
}

function review() {
  return {
    ...summary(),
    payload: envelope(),
  };
}

function summary() {
  return {
    schemaVersion: 1,
    reviewId: uuid(20),
    tenantId: AUTHOR.tenantId,
    teamId: AUTHOR.teamId,
    projectId: AUTHOR.projectId,
    sourceVersionId: uuid(10),
    sourceVersionRevision: 1,
    sourceCiphertextSha256: "a".repeat(64),
    projectKeyVersion: 1,
    submittedByMembershipId: AUTHOR.membershipId,
    state: "pending" as const,
    revision: 1,
    decisionByMembershipId: null,
    decidedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function thread() {
  return {
    schemaVersion: 1,
    threadId: uuid(30),
    tenantId: AUTHOR.tenantId,
    teamId: AUTHOR.teamId,
    projectId: AUTHOR.projectId,
    reviewId: uuid(20),
    rootItemId: uuid(31),
    state: "open" as const,
    revision: 2,
    itemCount: 2,
    createdByMembershipId: AUTHOR.membershipId,
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function corruptThreadView() {
  return {
    thread: thread(),
    items: [
      { state: "corrupt" as const, item: item(uuid(31), "comment"), errorCode: "CORRUPT" },
      {
        state: "ready" as const,
        item: item(uuid(32), "reply"),
        payload: {
          schemaVersion: 1,
          kind: "reply" as const,
          body: "healthy reply",
          source: decryptedReview().payload.source,
          anchor: null,
        },
      },
    ],
    nextCursor: null,
  };
}

function appendedComment() {
  return {
    thread: { ...thread(), itemCount: 3, revision: 3 },
    item: item(uuid(35), "comment"),
    payload: {
      schemaVersion: 1,
      kind: "comment" as const,
      body: "second operation",
      source: decryptedReview().payload.source,
      anchor: null,
    },
  };
}

function suggestionThreadView() {
  return {
    thread: thread(),
    items: [
      {
        state: "ready" as const,
        item: { ...item(uuid(31), "suggestion"), suggestionDecision: "pending" as const },
        payload: {
          schemaVersion: 1,
          kind: "suggestion" as const,
          body: "safe suggestion",
          source: decryptedReview().payload.source,
          anchor: {
            chapterId: uuid(40),
            startUtf16: 1,
            endUtf16: 2,
            selectedTextSha256: "b".repeat(64),
          },
          candidate: {
            candidateId: uuid(41),
            baseSourceVersionId: uuid(10),
            baseSourceVersionRevision: 1,
            baseSourceCiphertextSha256: "a".repeat(64),
            replacement: {
              chapterId: uuid(40),
              startUtf16: 1,
              endUtf16: 2,
              text: "candidate",
            },
          },
        },
      },
    ],
    nextCursor: null,
  };
}

function item(itemId: string, itemType: "comment" | "reply" | "suggestion") {
  return {
    schemaVersion: 1,
    itemId,
    threadId: uuid(30),
    tenantId: AUTHOR.tenantId,
    teamId: AUTHOR.teamId,
    projectId: AUTHOR.projectId,
    reviewId: uuid(20),
    itemType,
    parentItemId: itemType === "reply" ? uuid(31) : null,
    payload: envelope(),
    createdByMembershipId: AUTHOR.membershipId,
    revision: 1,
    suggestionDecision: itemType === "suggestion" ? ("pending" as const) : null,
    suggestionDecidedByMembershipId: null,
    suggestionDecidedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function partialOutcome() {
  const application = {
    authority: "local_review_suggestion_version" as const,
    applicationId: uuid(31),
    tenantId: AUTHOR.tenantId,
    teamId: AUTHOR.teamId,
    projectId: AUTHOR.projectId,
    reviewId: uuid(20),
    threadId: uuid(30),
    itemId: uuid(31),
    candidateId: uuid(41),
    baseSourceVersionId: uuid(10),
    baseSourceVersionRevision: 1,
    baseSourceCiphertextSha256: "a".repeat(64),
    newVersionId: uuid(50),
    newVersionRevision: 2,
    result: "created" as const,
  };
  return {
    status: "partial_retry" as const,
    application,
    retry: {
      tenantId: AUTHOR.tenantId,
      teamId: AUTHOR.teamId,
      projectId: AUTHOR.projectId,
      reviewId: uuid(20),
      threadId: uuid(30),
      itemId: uuid(31),
      expectedItemRevision: 1,
      idempotencyKey: "studio.review.accept.000001",
    },
    failureCode: "CLOUD_NETWORK_UNAVAILABLE",
  };
}

function envelope() {
  return {
    algorithm: "AES-256-GCM" as const,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    ciphertextSha256: "c".repeat(64),
  };
}

const NOW = "2026-07-28T00:00:00.000Z";
const AUTHOR: StudioReviewSessionContext = {
  tenantId: uuid(1),
  teamId: uuid(2),
  projectId: uuid(3),
  membershipId: uuid(4),
  role: "author",
  membershipState: "active",
  assignmentState: "active",
};

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
