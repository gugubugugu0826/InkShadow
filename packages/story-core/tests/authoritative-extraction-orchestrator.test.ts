import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AuthoritativeExtractionCoordinator,
  FormalStoryRecord,
  SqliteAuthoritativeExtractionRepository,
  SqliteFormalStoryRecordRepository,
  SqliteReviewItemRepository,
  err,
  ok,
  parseAuthoritativeExtractionOutput,
  parseSafeIdentifier,
  parseUuidV7,
  type AuthoritativeExtractionChapterDocument,
  type AuthoritativeExtractionContentHasher,
  type AuthoritativeExtractionGoldenFixture,
  type AuthoritativeExtractionGoldenSuite,
  type AuthoritativeExtractionProvider,
  type AuthoritativeExtractionProviderRequest,
  type AuthoritativeExtractionSourceReader,
  type Result,
  type StoryCoreError,
  type UuidV7,
} from "../src/index.js";
import { ManualClock, SequenceUuidV7Generator, unwrap, uuid } from "./helpers.js";
import { NodeStorySqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../../data/migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0001_story_core.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../../data/migrations/0027_authoritative_extraction.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const RECORD_ID = uuid(4);
const ACTOR_ID = uuid(5);
const NOW = "2026-07-28T02:00:00.000Z";
const CONTENT = "林舟从南城抵达北塔。";
const PROMPT_CHECKSUM = "b".repeat(64);

describe("authoritative extraction durable coordinator", () => {
  let executor: NodeStorySqliteExecutor;
  let repository: SqliteAuthoritativeExtractionRepository;
  let sourceReader: MutableSourceReader;
  let provider: MutableProvider;
  let clock: ManualClock;
  let ids: SequenceUuidV7Generator;

  beforeEach(async () => {
    executor = new NodeStorySqliteExecutor(migration);
    repository = new SqliteAuthoritativeExtractionRepository(executor);
    sourceReader = new MutableSourceReader([document()]);
    provider = new MutableProvider();
    clock = new ManualClock(NOW);
    ids = new SequenceUuidV7Generator(100);
    await seedAuthority(executor);
  });

  afterEach(() => {
    executor.close();
  });

  it("automatically discovers a stable chapter and materializes only pending review candidates", async () => {
    provider.handler = (request) => Promise.resolve(ok(validProviderOutput(request)));
    const coordinator = createCoordinator(true);
    const suite = goldenSuite();

    const evaluated = await coordinator.runGoldenSuite(suite);
    expect(evaluated).toMatchObject({
      ok: true,
      value: {
        evaluation: {
          metrics: { precision: 1, recall: 1, passed: true },
          protocolFailureCount: 0,
        },
      },
    });
    const cycle = await coordinator.runCycle(PROJECT_ID, { online: true });

    expect(cycle).toMatchObject({
      ok: true,
      value: {
        discoveredCount: 1,
        processedCount: 1,
        materializedCount: 1,
        blockedCount: 0,
      },
    });
    const jobs = unwrap(await repository.listJobsByProject(asUuid(PROJECT_ID)));
    expect(jobs).toMatchObject([{ state: "awaiting_review", attemptCount: 1 }]);
    const candidates = unwrap(await repository.listCandidatesByProject(asUuid(PROJECT_ID)));
    expect(candidates).toMatchObject([
      {
        source: {
          chapterId: CHAPTER_ID,
          versionId: VERSION_ID,
          checksumSha256: sha256(CONTENT),
          scope: { start: 0, end: CONTENT.length, sourceLength: CONTENT.length },
        },
        provenance: {
          prompt: {
            registryId: "story.authoritative.extract",
            version: 5,
            checksumSha256: PROMPT_CHECKSUM,
          },
          model: { provider: "fixture", id: "strict-extractor", revision: "r1" },
          evaluationVersion: "golden.v1",
        },
      },
    ]);
    const reviewId = candidates[0]?.reviewItemId;
    if (reviewId === undefined) {
      throw new Error("review candidate missing");
    }
    await expect(
      new SqliteReviewItemRepository(executor, "extraction").findById(reviewId),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "pending", revision: 1 },
    });
    await expect(
      new SqliteFormalStoryRecordRepository(executor).findById(asUuid(RECORD_ID)),
    ).resolves.toMatchObject({
      ok: true,
      value: { revision: 1, currentValue: { location: "南城" } },
    });
  });

  it("stores a remote job without source text while offline and resumes it after a passing gate", async () => {
    provider.handler = (request) => Promise.resolve(ok(validProviderOutput(request)));
    const coordinator = createCoordinator(true);

    const offline = await coordinator.runCycle(PROJECT_ID, {
      online: false,
      maximumJobs: 1,
    });
    expect(offline).toMatchObject({
      ok: true,
      value: { discoveredCount: 1, blockedCount: 1 },
    });
    expect(unwrap(await repository.listJobsByProject(asUuid(PROJECT_ID)))).toMatchObject([
      {
        state: "waiting_for_network",
        failure: { code: "network_offline", retryable: false },
      },
    ]);
    expect(provider.calls).toBe(0);

    unwrap(await coordinator.runGoldenSuite(goldenSuite()));
    const online = unwrap(await coordinator.runCycle(PROJECT_ID, { online: true, maximumJobs: 3 }));
    expect(online).toMatchObject({ processedCount: 1, materializedCount: 1 });
    expect(provider.calls).toBe(2); // one golden fixture plus one production attempt
  });

  it("cooperatively cancels an in-flight provider and never persists its late output", async () => {
    provider.handler = (request) => Promise.resolve(ok(validProviderOutput(request)));
    const coordinator = createCoordinator(true);
    unwrap(await coordinator.runGoldenSuite(goldenSuite()));
    provider.calls = 0;

    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    provider.handler = async (request, signal) => {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return ok(validProviderOutput(request));
    };

    const cycle = coordinator.runCycle(PROJECT_ID, { online: true, maximumJobs: 1 });
    await didStart;
    const job = unwrap(await repository.listJobsByProject(asUuid(PROJECT_ID)))[0];
    if (job === undefined) {
      throw new Error("running job missing");
    }
    const cancelled = await coordinator.cancel(job.id);
    expect(cancelled).toMatchObject({
      ok: true,
      value: { state: "running", cancelRequested: true },
    });
    release?.();
    await expect(cycle).resolves.toMatchObject({
      ok: true,
      value: { cancelledCount: 1 },
    });
    expect(unwrap(await repository.listJobsByProject(asUuid(PROJECT_ID)))).toMatchObject([
      { state: "cancelled", cancelRequested: false },
    ]);
    expect(unwrap(await repository.listCandidatesByProject(asUuid(PROJECT_ID)))).toEqual([]);
  });

  it("fails closed behind the default-off flag without reading sources or invoking a provider", async () => {
    const coordinator = createCoordinator(false);

    await expect(coordinator.runCycle(PROJECT_ID, { online: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "EXTRACTION_DISABLED" },
    });
    expect(sourceReader.listCalls).toBe(0);
    expect(provider.calls).toBe(0);
  });

  function createCoordinator(enabled: boolean): AuthoritativeExtractionCoordinator {
    return new AuthoritativeExtractionCoordinator({
      enabled,
      executionMode: "remote",
      evaluationSuiteId: "authoritative.v1",
      provenance: provenance(),
      repository,
      sources: sourceReader,
      formalRecords: new SqliteFormalStoryRecordRepository(executor),
      reviewItems: new SqliteReviewItemRepository(executor, "extraction"),
      provider,
      hasher: new CryptoHasher(),
      clock,
      ids,
      workerId: "authoritative.worker",
      leaseDurationMs: 60_000,
      maximumAttempts: 2,
    });
  }
});

class MutableSourceReader implements AuthoritativeExtractionSourceReader {
  public listCalls = 0;

  public constructor(public documents: AuthoritativeExtractionChapterDocument[]) {}

  public listCurrentByProject(
    projectId: UuidV7,
  ): Promise<Result<readonly AuthoritativeExtractionChapterDocument[], StoryCoreError>> {
    this.listCalls += 1;
    return Promise.resolve(
      ok(this.documents.filter((documentValue) => documentValue.projectId === projectId)),
    );
  }

  public loadCurrentByChapter(
    chapterId: UuidV7,
  ): Promise<Result<AuthoritativeExtractionChapterDocument | null, StoryCoreError>> {
    return Promise.resolve(
      ok(this.documents.find((documentValue) => documentValue.chapterId === chapterId) ?? null),
    );
  }
}

class MutableProvider implements AuthoritativeExtractionProvider {
  public calls = 0;

  public handler: (
    request: AuthoritativeExtractionProviderRequest,
    signal: AbortSignal,
  ) => Promise<Result<string, { code: string; retryable: boolean; offline: boolean }>> = () =>
    Promise.resolve(
      err({
        code: "not_configured",
        retryable: false,
        offline: false,
      }),
    );

  public generate(
    request: AuthoritativeExtractionProviderRequest,
    signal: AbortSignal,
  ): Promise<Result<string, { code: string; retryable: boolean; offline: boolean }>> {
    this.calls += 1;
    return this.handler(request, signal);
  }
}

class CryptoHasher implements AuthoritativeExtractionContentHasher {
  public sha256(content: string): Promise<Result<string, StoryCoreError>> {
    return Promise.resolve(ok(sha256(content)));
  }
}

async function seedAuthority(executor: NodeStorySqliteExecutor): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO projects (id, name, status, revision, created_at, updated_at)
       VALUES (?, 'Project', 'active', 1, ?, ?)`,
      [PROJECT_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id, created_at, updated_at
       ) VALUES (?, ?, 'Chapter', ?, 'active', 1, ?, ?, ?)`,
      [CHAPTER_ID, PROJECT_ID, CONTENT, VERSION_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, CONTENT, sha256(CONTENT), NOW],
    );
  });
  const record = unwrap(
    FormalStoryRecord.create({
      id: RECORD_ID,
      projectId: PROJECT_ID,
      kind: "character",
      recordKey: "linzhou",
      value: { location: "南城" },
      actorId: ACTOR_ID,
      humanConfirmed: true,
      now: NOW,
    }),
  );
  unwrap(await new SqliteFormalStoryRecordRepository(executor).create(record));
}

function document(): AuthoritativeExtractionChapterDocument {
  return {
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    versionId: VERSION_ID,
    checksumSha256: sha256(CONTENT),
    content: CONTENT,
  };
}

function provenance() {
  return {
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
  };
}

function validProviderOutput(request: AuthoritativeExtractionProviderRequest): string {
  const excerpt = "抵达北塔";
  const start = request.chapterContent.indexOf(excerpt);
  return JSON.stringify({
    schemaVersion: "inkshadow.authoritative-extraction.v1",
    source: request.source,
    prompt: request.provenance.prompt,
    model: request.provenance.model,
    evaluationVersion: request.provenance.evaluationVersion,
    candidates: [
      {
        key: "linzhou.location",
        target: {
          recordId: RECORD_ID,
          kind: "character",
          expectedRevision: 1,
        },
        category: "location",
        severity: "info",
        confidence: 0.98,
        originalValue: { location: "南城" },
        suggestedValue: { location: "北塔" },
        evidence: {
          start,
          end: start + excerpt.length,
          excerpt,
        },
      },
    ],
  });
}

function goldenSuite(): AuthoritativeExtractionGoldenSuite {
  const fixtureContext = {
    source: {
      projectId: asUuid(PROJECT_ID),
      chapterId: asUuid(CHAPTER_ID),
      versionId: asUuid(VERSION_ID),
      checksumSha256: sha256(CONTENT),
      scope: { start: 0, end: CONTENT.length, sourceLength: CONTENT.length },
    },
    chapterContent: CONTENT,
    provenance: provenance(),
    targets: [
      {
        recordId: asUuid(RECORD_ID),
        kind: "character" as const,
        expectedRevision: 1,
        value: { location: "南城" },
      },
    ],
  };
  const request: AuthoritativeExtractionProviderRequest = {
    publicationBoundary: "candidate_only",
    formalWriteAllowed: false,
    instruction: "",
    ...fixtureContext,
  };
  const expected = unwrap(
    parseAuthoritativeExtractionOutput(validProviderOutput(request), fixtureContext),
  ).candidates;
  const fixture: AuthoritativeExtractionGoldenFixture = {
    id: asIdentifier("fixture.chapter.location"),
    source: document(),
    targets: fixtureContext.targets,
    expected,
  };
  return {
    id: asIdentifier("authoritative.v1"),
    thresholds: { minimumPrecision: 1, minimumRecall: 1 },
    fixtures: [fixture],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asUuid(value: string): UuidV7 {
  return unwrap(parseUuidV7(value));
}

function asIdentifier(value: string) {
  return unwrap(parseSafeIdentifier(value));
}
