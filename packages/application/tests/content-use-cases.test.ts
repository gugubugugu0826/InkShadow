import { describe, expect, it } from "vitest";

import { AiCandidate, Project, parseContentChecksum } from "@inkshadow/domain";

import {
  AcceptAiCandidate,
  CreateChapter,
  EditChapter,
  ListChapterVersions,
  RejectAiCandidate,
  SaveChapter,
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
} from "./fakes.js";

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

async function createStableChapter(
  projects: InMemoryProjectRepository,
  contentStore: InMemoryContentStore,
): Promise<void> {
  const created = await new CreateChapter(
    projects,
    contentStore,
    new SequenceIds([CHAPTER_ID, VERSION_ID]),
    new FixedClock(),
    new FixedHasher(),
  ).execute({
    projectId: PROJECT_ID,
    title: "Chapter One",
    content: "Stable text",
  });
  if (!created.ok) {
    throw created.error;
  }
  expect(created.value.saveState).toBe("saved_local");
}

function readyCandidate(baseVersionId = VERSION_ID): AiCandidate {
  const checksum = parseContentChecksum("a".repeat(64));
  if (!checksum.ok) {
    throw checksum.error;
  }

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

  const ready = streaming.value.markReady("Candidate text", checksum.value, NOW);
  if (!ready.ok) {
    throw ready.error;
  }
  return ready.value;
}

describe("chapter and candidate use cases", () => {
  it("reports a newly created chapter as pending only when the commit queued sync", async () => {
    const projects = new InMemoryProjectRepository();
    projects.seed(activeProject());
    const contentStore = new InMemoryContentStore(new InMemoryCandidateRepository());
    contentStore.syncQueued = true;

    const created = await new CreateChapter(
      projects,
      contentStore,
      new SequenceIds([CHAPTER_ID, VERSION_ID]),
      new FixedClock(),
      new FixedHasher(),
    ).execute({
      projectId: PROJECT_ID,
      title: "Chapter One",
      content: "Stable text",
    });

    expect(created.ok && created.value.saveState).toBe("pending_sync");
  });

  it("keeps edits in a recovery draft until an atomic save creates a version", async () => {
    const projects = new InMemoryProjectRepository();
    projects.seed(activeProject());
    const candidates = new InMemoryCandidateRepository();
    const contentStore = new InMemoryContentStore(candidates);
    await createStableChapter(projects, contentStore);

    const edited = await new EditChapter(
      contentStore,
      contentStore,
      new SequenceIds([DRAFT_ID]),
      new FixedClock(),
    ).execute({
      chapterId: CHAPTER_ID,
      expectedRevision: 1,
      content: "Edited draft",
      cursorOffset: 12,
    });
    expect(edited.ok).toBe(true);

    const beforeSave = await contentStore.findById(CHAPTER_ID);
    expect(beforeSave.ok && beforeSave.value?.content).toBe("Stable text");
    contentStore.syncQueued = true;

    const saved = await new SaveChapter(
      contentStore,
      contentStore,
      contentStore,
      new SequenceIds([NEXT_VERSION_ID]),
      new FixedClock(),
      new FixedHasher(),
    ).execute({
      chapterId: CHAPTER_ID,
      expectedRevision: 1,
      reason: "autosave",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    expect(saved.value.chapter.content).toBe("Edited draft");
    expect(saved.value.chapter.revision).toBe(2);
    expect(saved.value.version?.sequence).toBe(2);
    expect(saved.value.saveState).toBe("pending_sync");

    const versions = await new ListChapterVersions(contentStore).execute(CHAPTER_ID);
    expect(versions.ok && versions.value).toHaveLength(2);
    const draft = await contentStore.findByChapterId(CHAPTER_ID);
    expect(draft.ok && draft.value).toBeNull();
  });

  it("accepts a candidate only when its base version is current", async () => {
    const projects = new InMemoryProjectRepository();
    projects.seed(activeProject());
    const candidates = new InMemoryCandidateRepository();
    const contentStore = new InMemoryContentStore(candidates);
    await createStableChapter(projects, contentStore);
    candidates.seed(readyCandidate());
    contentStore.syncQueued = true;

    const accepted = await new AcceptAiCandidate(
      candidates,
      contentStore,
      contentStore,
      new SequenceIds([NEXT_VERSION_ID]),
      new FixedClock(),
      new FixedHasher(),
    ).execute({ candidateId: CANDIDATE_ID });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }
    expect(accepted.value.chapter.content).toBe("Candidate text");
    expect(accepted.value.candidate.status).toBe("accepted");
    expect(accepted.value.version.toSnapshot().sourceCandidateId).toBe(CANDIDATE_ID);
    expect(accepted.value.plan.strategy).toBe("accept_all");
    expect(accepted.value.plan.resultContent).toBe("Candidate text");
    expect(accepted.value.saveState).toBe("pending_sync");
  });

  it("leaves the ready candidate and stable chapter unchanged when the atomic commit fails", async () => {
    const projects = new InMemoryProjectRepository();
    projects.seed(activeProject());
    const candidates = new InMemoryCandidateRepository();
    const contentStore = new InMemoryContentStore(candidates);
    await createStableChapter(projects, contentStore);
    candidates.seed(readyCandidate());
    contentStore.failNextCandidateCommit = true;

    const accepted = await new AcceptAiCandidate(
      candidates,
      contentStore,
      contentStore,
      new SequenceIds([NEXT_VERSION_ID]),
      new FixedClock(),
      new FixedHasher(),
    ).execute({ candidateId: CANDIDATE_ID });
    expect(accepted.ok).toBe(false);

    const candidate = await candidates.findById(CANDIDATE_ID);
    expect(candidate.ok && candidate.value?.status).toBe("ready");
    const chapter = await contentStore.findById(CHAPTER_ID);
    expect(chapter.ok && chapter.value?.content).toBe("Stable text");
  });

  it("rejects a stale candidate without changing either entity", async () => {
    const projects = new InMemoryProjectRepository();
    projects.seed(activeProject());
    const candidates = new InMemoryCandidateRepository();
    const contentStore = new InMemoryContentStore(candidates);
    await createStableChapter(projects, contentStore);
    candidates.seed(readyCandidate(NEXT_VERSION_ID));

    const accepted = await new AcceptAiCandidate(
      candidates,
      contentStore,
      contentStore,
      new SequenceIds([NEXT_VERSION_ID]),
      new FixedClock(),
      new FixedHasher(),
    ).execute({ candidateId: CANDIDATE_ID });
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) {
      expect(accepted.error.code).toBe("BASE_VERSION_CHANGED");
    }

    const candidate = await candidates.findById(CANDIDATE_ID);
    expect(candidate.ok && candidate.value?.status).toBe("ready");
  });

  it("rejects a candidate without modifying the stable chapter", async () => {
    const projects = new InMemoryProjectRepository();
    projects.seed(activeProject());
    const candidates = new InMemoryCandidateRepository();
    const contentStore = new InMemoryContentStore(candidates);
    await createStableChapter(projects, contentStore);
    candidates.seed(readyCandidate());

    const rejected = await new RejectAiCandidate(candidates, new FixedClock()).execute({
      candidateId: CANDIDATE_ID,
    });
    expect(rejected.ok && rejected.value.status).toBe("rejected");

    const chapter = await contentStore.findById(CHAPTER_ID);
    expect(chapter.ok && chapter.value?.content).toBe("Stable text");
  });
});
