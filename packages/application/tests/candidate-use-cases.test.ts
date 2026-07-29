import { describe, expect, it } from "vitest";

import {
  AiCandidate,
  AppError,
  Project,
  err,
  ok,
  parseContentChecksum,
  type ContentChecksum,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";

import {
  AcceptAiCandidate,
  CreateChapter,
  EditChapter,
  SaveChapter,
  diffCandidateContent,
  type CandidateApplicationStrategy,
  type ChapterVersionRepository,
  type ContentHasher,
} from "../src/index.js";
import {
  CANDIDATE_ID,
  CHAPTER_ID,
  DRAFT_ID,
  FixedClock,
  FixedHasher,
  InMemoryCandidateRepository,
  InMemoryContentStore,
  InMemoryProjectRepository,
  NEXT_VERSION_ID,
  NOW,
  PROJECT_ID,
  SequenceIds,
  VERSION_ID,
  uuid,
} from "./fakes.js";

const MERGE_VERSION_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000007");

function checksum(character = "a"): ContentChecksum {
  const parsed = parseContentChecksum(character.repeat(64));
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function activeProject(): Project {
  const project = Project.create({
    id: PROJECT_ID,
    name: "Novel",
    now: NOW,
  });
  if (!project.ok) {
    throw project.error;
  }
  return project.value;
}

function readyCandidate(content: string, baseVersionId: UuidV7 = VERSION_ID): AiCandidate {
  const streaming = AiCandidate.createStreaming({
    id: CANDIDATE_ID,
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    source: "generate",
    baseVersionId,
    now: NOW,
  });
  if (!streaming.ok) {
    throw streaming.error;
  }
  const ready = streaming.value.markReady(content, checksum(), NOW);
  if (!ready.ok) {
    throw ready.error;
  }
  return ready.value;
}

async function stableContentStore(content: string): Promise<
  Readonly<{
    candidates: InMemoryCandidateRepository;
    store: InMemoryContentStore;
  }>
> {
  const projects = new InMemoryProjectRepository();
  projects.seed(activeProject());
  const candidates = new InMemoryCandidateRepository();
  const store = new InMemoryContentStore(candidates);
  const created = await new CreateChapter(
    projects,
    store,
    new SequenceIds([CHAPTER_ID, VERSION_ID]),
    new FixedClock(),
    new FixedHasher(),
  ).execute({
    projectId: PROJECT_ID,
    title: "Chapter One",
    content,
  });
  if (!created.ok) {
    throw created.error;
  }
  return { candidates, store };
}

function acceptCandidate(
  candidates: InMemoryCandidateRepository,
  store: InMemoryContentStore,
  hasher: ContentHasher = new FixedHasher(),
  versions: ChapterVersionRepository = store,
  nextVersionId: UuidV7 = NEXT_VERSION_ID,
): AcceptAiCandidate {
  return new AcceptAiCandidate(
    candidates,
    store,
    store,
    new SequenceIds([nextVersionId]),
    new FixedClock(),
    hasher,
    versions,
  );
}

class FailingOnCallHasher implements ContentHasher {
  private calls = 0;

  constructor(private readonly failureCall: number) {}

  sha256(): Promise<Result<ContentChecksum, AppError>> {
    this.calls += 1;
    return Promise.resolve(
      this.calls === this.failureCall
        ? err(
            new AppError({
              code: "SAVE_FAILED",
              message: "Injected checksum failure.",
            }),
          )
        : ok(checksum()),
    );
  }
}

class ConstantHasher implements ContentHasher {
  constructor(private readonly value: ContentChecksum) {}

  sha256(): Promise<Result<ContentChecksum, AppError>> {
    return Promise.resolve(ok(this.value));
  }
}

class SequenceHasher implements ContentHasher {
  private call = 0;

  constructor(private readonly values: readonly ContentChecksum[]) {}

  sha256(): Promise<Result<ContentChecksum, AppError>> {
    const value = this.values[this.call];
    this.call += 1;
    return value === undefined
      ? Promise.resolve(
          err(
            new AppError({
              code: "SAVE_FAILED",
              message: "Checksum sequence exhausted.",
            }),
          ),
        )
      : Promise.resolve(ok(value));
  }
}

async function expectStableState(
  store: InMemoryContentStore,
  candidates: InMemoryCandidateRepository,
  expectedContent: string,
  expectedVersionCount = 1,
): Promise<void> {
  const chapter = await store.findById(CHAPTER_ID);
  expect(chapter.ok && chapter.value?.content).toBe(expectedContent);
  const candidate = await candidates.findById(CANDIDATE_ID);
  expect(candidate.ok && candidate.value?.status).toBe("ready");
  const versions = await store.listByChapterId(CHAPTER_ID);
  expect(versions.ok && versions.value).toHaveLength(expectedVersionCount);
}

describe("candidate application persistence", () => {
  it("persists a mixed per-change decision and returns the exact committed plan", async () => {
    const baseline = "one cat two.";
    const candidateContent = "one dog two!";
    const { candidates, store } = await stableContentStore(baseline);
    candidates.seed(readyCandidate(candidateContent));
    const diff = diffCandidateContent(baseline, candidateContent);
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") {
      return;
    }

    const outcome = await acceptCandidate(candidates, store).execute({
      candidateId: CANDIDATE_ID,
      strategy: {
        kind: "apply_changes",
        decisions: diff.diff.changes.map((change) => ({
          changeId: change.id,
          decision: change.insertedText === "dog" ? "accept" : "reject",
        })),
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.plan.resultContent).toBe("one dog two.");
    expect(outcome.value.plan.acceptedChangeIds).toEqual(["change-000001"]);
    expect(outcome.value.plan.rejectedChangeIds).toEqual(["change-000002"]);
    expect(outcome.value.chapter.content).toBe(outcome.value.plan.resultContent);
    expect(outcome.value.version.toSnapshot()).toMatchObject({
      content: "one dog two.",
      reason: "candidate_accept",
      sourceCandidateId: CANDIDATE_ID,
    });
    expect(outcome.value.candidate.status).toBe("accepted");
  });

  it("persists cursor insertion and selection replacement plans", async () => {
    const cases: readonly Readonly<{
      strategy: CandidateApplicationStrategy;
      expected: string;
    }>[] = [
      {
        strategy: { kind: "insert_at_cursor", cursorUtf16: 3 },
        expected: "A😀XB",
      },
      {
        strategy: {
          kind: "replace_selection",
          selection: { start: 1, end: 3 },
        },
        expected: "AXB",
      },
    ];

    for (const testCase of cases) {
      const { candidates, store } = await stableContentStore("A😀B");
      candidates.seed(readyCandidate("X"));
      const outcome = await acceptCandidate(candidates, store).execute({
        candidateId: CANDIDATE_ID,
        strategy: testCase.strategy,
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.value.plan.strategy).toBe(testCase.strategy.kind);
        expect(outcome.value.chapter.content).toBe(testCase.expected);
        expect(outcome.value.version.toSnapshot().content).toBe(testCase.expected);
      }
    }
  });

  it("rejects incomplete per-change decisions without changing formal state", async () => {
    const baseline = "abc";
    const candidateContent = "aXbYc";
    const { candidates, store } = await stableContentStore(baseline);
    candidates.seed(readyCandidate(candidateContent));
    const diff = diffCandidateContent(baseline, candidateContent);
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") {
      return;
    }

    const outcome = await acceptCandidate(candidates, store).execute({
      candidateId: CANDIDATE_ID,
      strategy: {
        kind: "apply_changes",
        decisions: [
          {
            changeId: diff.diff.changes[0]?.id ?? "",
            decision: "accept",
          },
        ],
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
      expect(outcome.error.details.candidatePlanningCode).toBe("INVALID_CHANGE_DECISIONS");
    }
    await expectStableState(store, candidates, baseline);
  });

  it("fails explicitly when the candidate baseline version is missing", async () => {
    const { candidates, store } = await stableContentStore("base");
    candidates.seed(readyCandidate("candidate"));
    const missingVersions: ChapterVersionRepository = {
      findVersionById: () => Promise.resolve(ok(null)),
      listByChapterId: () => Promise.resolve(ok([])),
    };

    const outcome = await acceptCandidate(
      candidates,
      store,
      new FixedHasher(),
      missingVersions,
    ).execute({ candidateId: CANDIDATE_ID });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("BASE_VERSION_CHANGED");
      expect(outcome.error.details.reason).toBe("BASE_VERSION_NOT_FOUND");
    }
    await expectStableState(store, candidates, "base");
  });

  it("returns a baseline conflict after the stable chapter advances", async () => {
    const { candidates, store } = await stableContentStore("base");
    candidates.seed(readyCandidate("candidate"));
    const edited = await new EditChapter(
      store,
      store,
      new SequenceIds([DRAFT_ID]),
      new FixedClock(),
    ).execute({
      chapterId: CHAPTER_ID,
      expectedRevision: 1,
      content: "local edit",
      cursorOffset: 10,
    });
    expect(edited.ok).toBe(true);
    const saved = await new SaveChapter(
      store,
      store,
      store,
      new SequenceIds([NEXT_VERSION_ID]),
      new FixedClock(),
      new FixedHasher(),
    ).execute({
      chapterId: CHAPTER_ID,
      expectedRevision: 1,
      reason: "manual",
    });
    expect(saved.ok).toBe(true);

    const outcome = await acceptCandidate(
      candidates,
      store,
      new FixedHasher(),
      store,
      MERGE_VERSION_ID,
    ).execute({ candidateId: CANDIDATE_ID });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("BASE_VERSION_CHANGED");
      expect(outcome.error.details.revisionChanged).toBe(true);
    }
    await expectStableState(store, candidates, "local edit", 2);
  });

  it("uses a freshly computed current digest to detect content identity drift", async () => {
    const { candidates, store } = await stableContentStore("base");
    candidates.seed(readyCandidate("candidate"));

    const outcome = await acceptCandidate(
      candidates,
      store,
      new SequenceHasher([checksum(), checksum("b")]),
    ).execute({ candidateId: CANDIDATE_ID });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("BASE_VERSION_CHANGED");
      expect(outcome.error.details.contentDigestChanged).toBe(true);
      expect(outcome.error.details.revisionChanged).toBe(false);
    }
    await expectStableState(store, candidates, "base");
  });

  it("fails closed when persisted baseline content does not match its checksum", async () => {
    const { candidates, store } = await stableContentStore("base");
    candidates.seed(readyCandidate("candidate"));

    const outcome = await acceptCandidate(
      candidates,
      store,
      new ConstantHasher(checksum("b")),
    ).execute({ candidateId: CANDIDATE_ID });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("REPOSITORY_ERROR");
      expect(outcome.error.details.reason).toBe("BASE_VERSION_CHECKSUM_MISMATCH");
    }
    await expectStableState(store, candidates, "base");
  });

  it.each([1, 2, 3])(
    "keeps all formal state unchanged when checksum call %i fails",
    async (failureCall) => {
      const { candidates, store } = await stableContentStore("base");
      candidates.seed(readyCandidate("candidate"));

      const outcome = await acceptCandidate(
        candidates,
        store,
        new FailingOnCallHasher(failureCall),
      ).execute({ candidateId: CANDIDATE_ID });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe("SAVE_FAILED");
      }
      await expectStableState(store, candidates, "base");
    },
  );

  it("keeps chapter, version history, and candidate unchanged when atomic commit fails", async () => {
    const { candidates, store } = await stableContentStore("base");
    candidates.seed(readyCandidate("candidate"));
    store.failNextCandidateCommit = true;

    const outcome = await acceptCandidate(candidates, store).execute({
      candidateId: CANDIDATE_ID,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("SAVE_FAILED");
    }
    await expectStableState(store, candidates, "base");
  });
});
