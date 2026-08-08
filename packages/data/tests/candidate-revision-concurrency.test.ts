import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AiCandidate,
  Chapter,
  ChapterVersion,
  Project,
  ok,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AppError,
  type ContentChecksum,
  type IsoUtcTimestamp,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import { AcceptAiCandidate } from "@inkshadow/application";
import { describe, expect, it } from "vitest";

import { createSqliteRepositories, type SqliteRepositories } from "../src/sqlite-repositories.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  `ALTER TABLE chapters ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'standard'
     CHECK (privacy_mode IN ('standard', 'local_only'));
   ALTER TABLE chapters ADD COLUMN privacy_revision INTEGER NOT NULL DEFAULT 1
     CHECK (privacy_revision >= 1);`,
  readFileSync(
    new URL("../migrations/0048_candidate_application_intents.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0050_candidate_revision_authority.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const INITIAL_VERSION_ID = uuid(3);
const CANDIDATE_ID = uuid(4);
const STALE_ACCEPT_VERSION_ID = uuid(5);
const TAMPER_ACCEPT_VERSION_ID = uuid(6);
const NOW = iso("2026-08-08T00:00:00.000Z");
const LATER = iso("2026-08-08T00:01:00.000Z");

describe("SQLite Candidate revision authority", () => {
  it("rejects stale revise and accept writes across two real connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inkshadow-candidate-revision-"));
    const databasePath = join(directory, "candidate.sqlite");
    const first = new NodeSqliteExecutor(migration, databasePath);
    let second: NodeSqliteExecutor | null = null;
    try {
      const firstRepositories = createSqliteRepositories(first);
      const project = expectOk(Project.create({ id: PROJECT_ID, name: "Race", now: NOW }));
      expectOk(await firstRepositories.projects.create(project));
      const chapter = expectOk(
        Chapter.create({
          id: CHAPTER_ID,
          projectId: PROJECT_ID,
          title: "Chapter",
          content: "stable",
          initialVersionId: INITIAL_VERSION_ID,
          now: NOW,
        }),
      );
      const initialVersion = expectOk(
        ChapterVersion.create({
          id: INITIAL_VERSION_ID,
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          parentVersionId: null,
          sequence: 1,
          content: chapter.content,
          contentChecksum: checksum(chapter.content),
          reason: "created",
          sourceCandidateId: null,
          createdAt: NOW,
        }),
      );
      expectOk(await firstRepositories.contentCommits.createChapter({ chapter, initialVersion }));
      const streaming = expectOk(
        AiCandidate.createStreaming({
          id: CANDIDATE_ID,
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          source: "generate",
          baseVersionId: INITIAL_VERSION_ID,
          now: NOW,
        }),
      );
      const candidate = expectOk(
        streaming.markReady("original suggestion", checksum("original suggestion"), NOW),
      );
      expect(candidate.revision).toBe(1);
      expectOk(await firstRepositories.aiCandidates.create(candidate));

      second = new NodeSqliteExecutor("", databasePath);
      const secondRepositories = createSqliteRepositories(second);
      const firstView = expectPresent(
        expectOk(await firstRepositories.aiCandidates.findById(CANDIDATE_ID)),
      );
      const secondView = expectPresent(
        expectOk(await secondRepositories.aiCandidates.findById(CANDIDATE_ID)),
      );
      expect(firstView.revision).toBe(1);
      expect(secondView.revision).toBe(1);

      const winner = expectOk(
        firstView.reviseReadyContent("window A winner", checksum("window A winner"), LATER),
      );
      expectOk(await firstRepositories.aiCandidates.save(winner, { status: "ready", revision: 1 }));

      const staleRevision = expectOk(
        secondView.reviseReadyContent(
          "window B stale edit",
          checksum("window B stale edit"),
          LATER,
        ),
      );
      expectErrorCode(
        await secondRepositories.aiCandidates.save(staleRevision, {
          status: "ready",
          revision: 1,
        }),
        "VERSION_CONFLICT",
      );

      const staleAcceptedCandidate = expectOk(secondView.accept(LATER));
      const staleChapter = expectOk(
        chapter.saveContent({
          content: secondView.content,
          expectedRevision: 1,
          newVersionId: STALE_ACCEPT_VERSION_ID,
          now: LATER,
        }),
      );
      const staleVersion = expectOk(
        ChapterVersion.create({
          id: STALE_ACCEPT_VERSION_ID,
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          parentVersionId: INITIAL_VERSION_ID,
          sequence: 2,
          content: secondView.content,
          contentChecksum: checksum(secondView.content),
          reason: "candidate_accept",
          sourceCandidateId: CANDIDATE_ID,
          createdAt: LATER,
        }),
      );
      expectErrorCode(
        await secondRepositories.contentCommits.acceptCandidate({
          chapter: staleChapter,
          version: staleVersion,
          candidate: staleAcceptedCandidate,
          expectedChapterRevision: 1,
          expectedCandidateStatus: "ready",
          expectedCandidateRevision: 1,
        }),
        "VERSION_CONFLICT",
      );

      const persistedCandidate = expectPresent(
        expectOk(await secondRepositories.aiCandidates.findById(CANDIDATE_ID)),
      );
      const persistedChapter = expectPresent(
        expectOk(await secondRepositories.chapters.findById(CHAPTER_ID)),
      );
      const versions = expectOk(
        await secondRepositories.chapterVersions.listByChapterId(CHAPTER_ID),
      );
      expect(persistedCandidate.toSnapshot()).toMatchObject({
        content: "window A winner",
        status: "ready",
        revision: 2,
      });
      expect(persistedChapter.toSnapshot()).toMatchObject({ content: "stable", revision: 1 });
      expect(versions.map((version) => version.sequence)).toEqual([1]);
    } finally {
      await second?.close();
      await first.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects acceptance when the stored Candidate row content was tampered without its checksum", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inkshadow-candidate-checksum-"));
    const databasePath = join(directory, "candidate.sqlite");
    const executor = new NodeSqliteExecutor(migration, databasePath);
    try {
      const fixture = await seedFixture(executor);
      await executor.execute("UPDATE ai_candidates SET content = ? WHERE id = ?", [
        "tampered suggestion",
        CANDIDATE_ID,
      ]);
      const useCase = new AcceptAiCandidate(
        fixture.repositories.aiCandidates,
        fixture.repositories.chapters,
        fixture.repositories.contentCommits,
        { next: () => TAMPER_ACCEPT_VERSION_ID },
        { now: () => LATER },
        { sha256: (content: string) => Promise.resolve(ok(checksum(content))) },
        fixture.repositories.chapterVersions,
      );

      const outcome = await useCase.execute({
        candidateId: CANDIDATE_ID,
        expectedCandidateRevision: 1,
      });

      expectErrorCode(outcome, "REPOSITORY_ERROR");
      if (!outcome.ok) {
        expect(outcome.error.details.reason).toBe("CANDIDATE_CONTENT_CHECKSUM_MISMATCH");
      }
      const chapter = expectPresent(
        expectOk(await fixture.repositories.chapters.findById(CHAPTER_ID)),
      );
      const candidate = expectPresent(
        expectOk(await fixture.repositories.aiCandidates.findById(CANDIDATE_ID)),
      );
      const versions = expectOk(
        await fixture.repositories.chapterVersions.listByChapterId(CHAPTER_ID),
      );
      expect(chapter.toSnapshot()).toMatchObject({ content: "stable", revision: 1 });
      expect(candidate.toSnapshot()).toMatchObject({
        content: "tampered suggestion",
        status: "ready",
        revision: 1,
      });
      expect(versions.map((version) => version.sequence)).toEqual([1]);
    } finally {
      await executor.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function seedFixture(
  executor: NodeSqliteExecutor,
): Promise<
  Readonly<{ repositories: SqliteRepositories; chapter: Chapter; candidate: AiCandidate }>
> {
  const repositories = createSqliteRepositories(executor);
  const project = expectOk(Project.create({ id: PROJECT_ID, name: "Checksum", now: NOW }));
  expectOk(await repositories.projects.create(project));
  const chapter = expectOk(
    Chapter.create({
      id: CHAPTER_ID,
      projectId: PROJECT_ID,
      title: "Chapter",
      content: "stable",
      initialVersionId: INITIAL_VERSION_ID,
      now: NOW,
    }),
  );
  const initialVersion = expectOk(
    ChapterVersion.create({
      id: INITIAL_VERSION_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      parentVersionId: null,
      sequence: 1,
      content: chapter.content,
      contentChecksum: checksum(chapter.content),
      reason: "created",
      sourceCandidateId: null,
      createdAt: NOW,
    }),
  );
  expectOk(await repositories.contentCommits.createChapter({ chapter, initialVersion }));
  const streaming = expectOk(
    AiCandidate.createStreaming({
      id: CANDIDATE_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      source: "generate",
      baseVersionId: INITIAL_VERSION_ID,
      now: NOW,
    }),
  );
  const candidate = expectOk(
    streaming.markReady("original suggestion", checksum("original suggestion"), NOW),
  );
  expectOk(await repositories.aiCandidates.create(candidate));
  return { repositories, chapter, candidate };
}

function checksum(content: string): ContentChecksum {
  return expectOk(parseContentChecksum(createHash("sha256").update(content).digest("hex")));
}

function iso(value: string): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(value));
}

function uuid(sequence: number): UuidV7 {
  return expectOk(parseUuidV7(`019f9f4a-b3c7-7350-9226-${sequence.toString().padStart(12, "0")}`));
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function expectPresent<Value>(value: Value | null): Value {
  if (value === null) throw new Error("Expected a persisted value.");
  return value;
}

function expectErrorCode<Value>(result: Result<Value, AppError>, code: AppError["code"]): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}
