import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StoryCoreError,
  err,
  ok,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type AuthoritativeExtractionCandidateRecord,
  type AuthoritativeExtractionJob,
  type FormalStoryRecordSnapshot,
  type StructuredReviewItemSnapshot,
} from "@inkshadow/story-core";
import { describe, expect, it, vi } from "vitest";

import {
  type AuthoritativeExtractionDashboard,
  type AuthoritativeExtractionDesktopPort,
} from "../infrastructure/authoritative-extraction-runtime";
import { AuthoritativeExtractionPage } from "./authoritative-extraction-page";

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const RECORD_ID = uuid(4);
const ACTOR_ID = uuid(5);
const JOB_ID = uuid(6);
const REVIEW_ID = uuid(7);
const DECISION_ID = uuid(8);
const NOW = "2026-07-28T04:00:00.000Z";
const EXCERPT = "reached North Tower";
const CHECKSUM = "a".repeat(64);
const PROMPT_CHECKSUM = "b".repeat(64);

describe("AuthoritativeExtractionPage", () => {
  it("does not touch persistence when browser development mode cannot provide native SQLite", () => {
    const inspect = vi.fn();
    const runCycle = vi.fn();
    const runtime = unavailableRuntime(inspect, runCycle);

    render(
      <AuthoritativeExtractionPage runtime={runtime} projectId={PROJECT_ID} actorId={ACTOR_ID} />,
    );

    expect(screen.getByRole("heading", { name: "权威事实抽取" })).toBeVisible();
    expect(screen.getByText("需要桌面原生持久化")).toBeVisible();
    expect(screen.getByText(/浏览器开发模式不会伪装生产级队列与评测存储/)).toBeVisible();
    expect(inspect).not.toHaveBeenCalled();
    expect(runCycle).not.toHaveBeenCalled();
  });

  it("shows the full authority trail offline and sends an explicit human accept before refreshing", async () => {
    const user = userEvent.setup();
    const fixture = readyRuntime();

    render(
      <AuthoritativeExtractionPage
        runtime={fixture.port}
        projectId={PROJECT_ID}
        actorId={ACTOR_ID}
        online={false}
      />,
    );

    expect(await screen.findByText(EXCERPT)).toBeVisible();
    expect(screen.getAllByText("离线").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "DD" &&
          element.textContent.includes("story.authoritative.extract v5"),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "DD" && element.textContent === "fixture/strict-extractor@r1",
      ),
    ).toBeVisible();
    expect(screen.getByText("golden.v1")).toBeVisible();
    expect(
      screen.getByText(
        (_content, element) => element?.tagName === "DD" && element.textContent === "0–63 / 63",
      ),
    ).toBeVisible();
    expect(screen.getByTitle(`${CHAPTER_ID} / ${VERSION_ID}`)).toBeVisible();
    expect(screen.getByTitle(CHECKSUM)).toBeVisible();
    expect(fixture.runCycle).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "扫描当前章节" }));
    await waitFor(() => {
      expect(fixture.runCycle).toHaveBeenCalledWith(PROJECT_ID, { online: false });
    });

    const decisionSurface = screen.getByLabelText("linzhou.location的正式设定候选决策");
    expect(decisionSurface).toHaveClass("candidate-decision-surface");
    expect(
      within(decisionSurface).getByLabelText("linzhou.location的正式设定候选内容"),
    ).toHaveAttribute("tabindex", "0");
    expect(decisionSurface.querySelector(":scope > .ink-card__footer")).toHaveClass(
      "candidate-decision-actions",
    );

    await user.click(screen.getByRole("button", { name: "接受候选" }));

    await waitFor(() => {
      expect(fixture.decideFormal).toHaveBeenCalledWith({
        jobId: JOB_ID,
        candidateKey: "linzhou.location",
        kind: "accept",
        actorId: ACTOR_ID,
        humanConfirmed: true,
      });
    });
    expect(await screen.findByText("操作已完成")).toBeVisible();
    expect(fixture.inspect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

function unavailableRuntime(
  inspect: ReturnType<typeof vi.fn>,
  runCycle: ReturnType<typeof vi.fn>,
): AuthoritativeExtractionDesktopPort {
  const unavailable = () =>
    Promise.resolve(
      err(
        new StoryCoreError({
          code: "EXTRACTION_PROVIDER_UNAVAILABLE",
          message: "Native SQLite required.",
        }),
      ),
    );
  return {
    availability: {
      available: false,
      reason: "native_sqlite_required",
      persistence: "browser_development",
      providerConfigured: true,
    },
    inspect,
    runCycle,
    runEvaluation: unavailable,
    cancel: unavailable,
    decideFormal: unavailable,
    decideReview: unavailable,
    undoAcceptance: unavailable,
    rebuildProjection: unavailable,
  } as AuthoritativeExtractionDesktopPort;
}

function readyRuntime() {
  let current = dashboard();
  const inspect = vi.fn(() => Promise.resolve(ok(current)));
  const runCycle = vi.fn(() =>
    Promise.resolve(
      ok({
        discoveredCount: 0,
        processedCount: 0,
        materializedCount: 0,
        blockedCount: 1,
        cancelledCount: 0,
      }),
    ),
  );
  const decideFormal = vi.fn(() => {
    const acceptedReview: StructuredReviewItemSnapshot<"extraction"> = {
      ...review(),
      status: "accepted",
      finalValue: { location: "North Tower" },
      revision: 2,
      decisions: [
        {
          id: asUuid(DECISION_ID),
          kind: "accepted",
          actorId: asUuid(ACTOR_ID),
          finalValue: { location: "North Tower" },
          decidedAt: asTimestamp(NOW),
          remindAt: null,
        },
      ],
    };
    const acceptedTarget: FormalStoryRecordSnapshot = {
      ...target(),
      revision: 2,
      currentVersion: 2,
      versions: [
        ...target().versions,
        {
          version: 2,
          value: { location: "North Tower" },
          previousVersion: 1,
          restoredFromVersion: null,
          reason: "suggestion_accepted",
          sourceReviewItemId: asUuid(REVIEW_ID),
          actorId: asUuid(ACTOR_ID),
          createdAt: asTimestamp(NOW),
        },
      ],
    };
    current = {
      ...current,
      candidates: [
        {
          extraction: extraction(),
          review: acceptedReview,
          target: acceptedTarget,
        },
      ],
      graphFreshness: "fresh",
    };
    return Promise.resolve(
      ok({
        review: acceptedReview,
        target: acceptedTarget,
        idempotent: false,
        projection: "rebuilt" as const,
        projectionErrorCode: null,
      }),
    );
  });
  const unused = () =>
    Promise.resolve(
      err(
        new StoryCoreError({
          code: "STORY_VALIDATION_FAILED",
          message: "Not used by this page test.",
        }),
      ),
    );
  const port: AuthoritativeExtractionDesktopPort = {
    availability: {
      available: true,
      persistence: "native_sqlite",
      providerConfigured: true,
    },
    inspect,
    runCycle,
    decideFormal,
    runEvaluation: unused,
    cancel: unused,
    decideReview: unused,
    undoAcceptance: unused,
    rebuildProjection: unused,
  };
  return { port, inspect, runCycle, decideFormal };
}

function dashboard(): AuthoritativeExtractionDashboard {
  return {
    projectId: PROJECT_ID,
    jobs: [job()],
    candidates: [{ extraction: extraction(), review: review(), target: target() }],
    evaluationPassed: true,
    graphFreshness: "missing",
  };
}

function job(): AuthoritativeExtractionJob {
  return {
    id: asUuid(JOB_ID),
    source: extraction().source,
    provenance: extraction().provenance,
    evaluationSuiteId: asIdentifier("authoritative.v1"),
    executionMode: "remote",
    state: "waiting_for_network",
    revision: 2,
    attemptCount: 0,
    cancelRequested: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    failure: {
      code: asIdentifier("network_offline"),
      retryable: false,
    },
    createdAt: asTimestamp(NOW),
    updatedAt: asTimestamp(NOW),
  };
}

function extraction(): AuthoritativeExtractionCandidateRecord {
  return {
    jobId: asUuid(JOB_ID),
    reviewItemId: asUuid(REVIEW_ID),
    source: {
      projectId: asUuid(PROJECT_ID),
      chapterId: asUuid(CHAPTER_ID),
      versionId: asUuid(VERSION_ID),
      checksumSha256: CHECKSUM,
      scope: { start: 0, end: 63, sourceLength: 63 },
    },
    provenance: {
      prompt: {
        registryId: asIdentifier("story.authoritative.extract"),
        version: 5,
        checksumSha256: PROMPT_CHECKSUM,
      },
      model: {
        provider: "fixture",
        id: "strict-extractor",
        revision: "r1",
      },
      evaluationVersion: asIdentifier("golden.v1"),
    },
    candidate: {
      key: asIdentifier("linzhou.location"),
      target: {
        recordId: asUuid(RECORD_ID),
        kind: "character",
        expectedRevision: 1,
      },
      category: asIdentifier("location"),
      severity: "info",
      confidence: 0.98,
      originalValue: { location: "South City" },
      suggestedValue: { location: "North Tower" },
      evidence: {
        excerpt: EXCERPT,
        range: { start: 0, end: 19, sourceLength: 63 },
      },
    },
    createdAt: asTimestamp(NOW),
  };
}

function review(): StructuredReviewItemSnapshot<"extraction"> {
  return {
    id: asUuid(REVIEW_ID),
    projectId: asUuid(PROJECT_ID),
    itemType: "extraction",
    category: asIdentifier("location"),
    severity: "info",
    targetRecordId: asUuid(RECORD_ID),
    targetRecordKind: "character",
    sourceChapterId: asUuid(CHAPTER_ID),
    sourceVersionId: asUuid(VERSION_ID),
    evidence: extraction().candidate.evidence,
    confidence: 0.98,
    originalValue: { location: "South City" },
    suggestedValue: { location: "North Tower" },
    finalValue: null,
    status: "pending",
    revision: 1,
    deferredUntil: null,
    decisions: [],
    createdAt: asTimestamp(NOW),
    updatedAt: asTimestamp(NOW),
  };
}

function target(): FormalStoryRecordSnapshot {
  return {
    id: asUuid(RECORD_ID),
    projectId: asUuid(PROJECT_ID),
    kind: "character",
    recordKey: asIdentifier("linzhou"),
    revision: 1,
    currentVersion: 1,
    versions: [
      {
        version: 1,
        value: { location: "South City" },
        previousVersion: null,
        restoredFromVersion: null,
        reason: "created",
        sourceReviewItemId: null,
        actorId: asUuid(ACTOR_ID),
        createdAt: asTimestamp(NOW),
      },
    ],
    createdAt: asTimestamp(NOW),
    updatedAt: asTimestamp(NOW),
  };
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function asUuid(value: string) {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function asIdentifier(value: string) {
  const parsed = parseSafeIdentifier(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function asTimestamp(value: string) {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}
