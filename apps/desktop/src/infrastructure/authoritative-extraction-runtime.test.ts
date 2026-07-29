import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ContentHasher } from "@inkshadow/application";
import {
  parseContentChecksum,
  parseIsoUtcTimestamp as parseDomainTimestamp,
} from "@inkshadow/domain";
import type { SqlExecutor } from "@inkshadow/data";
import {
  FormalStoryRecord,
  SqliteFormalStoryRecordRepository,
  ok,
  parseAuthoritativeExtractionOutput,
  parseSafeIdentifier,
  parseUuidV7,
  type AuthoritativeExtractionGoldenSuite,
  type AuthoritativeExtractionProvider,
  type AuthoritativeExtractionProviderRequest,
  type Result,
} from "@inkshadow/story-core";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { createAuthoritativeExtractionDesktopRuntime } from "./authoritative-extraction-runtime";
import { createSqliteStoryGraphRuntime, type StoryGraphRuntimePort } from "./story-graph-runtime";

const migration = [
  readWorkspaceFile("packages", "data", "migrations", "0001_core.sql"),
  readWorkspaceFile("packages", "story-core", "migrations", "0001_story_core.sql"),
  readWorkspaceFile("packages", "data", "migrations", "0020_graph_rag_projection.sql"),
  readWorkspaceFile("packages", "data", "migrations", "0023_authoritative_story_graph_epoch.sql"),
  readWorkspaceFile("packages", "data", "migrations", "0027_authoritative_extraction.sql"),
].join("\n");

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const RECORD_ID = uuid(4);
const ACTOR_ID = uuid(5);
const NOW = "2026-07-28T03:00:00.000Z";
const CONTENT = "Lin Zhou left South City and reached North Tower before sunrise.";
const EXCERPT = "reached North Tower";
const PROMPT_CHECKSUM = "b".repeat(64);

describe("authoritative extraction desktop runtime", () => {
  const executors: NodeSqliteExecutor[] = [];

  afterEach(async () => {
    await Promise.all(executors.splice(0).map((executor) => executor.close()));
  });

  it("is default-off and refuses browser development persistence or a missing provider", async () => {
    const neverExecutor = {} as SqlExecutor;
    const common = {
      executor: neverExecutor,
      graph: neverGraph(),
      contentHasher: new CryptoContentHasher(),
      clock: fixedClock(),
      ids: new SequenceIds(100),
      provenance: provenance(),
      evaluationSuiteId: "authoritative.v1",
      executionMode: "local" as const,
    };

    const disabled = createAuthoritativeExtractionDesktopRuntime({
      ...common,
      persistence: "native_sqlite",
      provider: new FixtureProvider(),
    });
    expect(disabled.availability).toEqual({
      available: false,
      reason: "feature_disabled",
      persistence: "native_sqlite",
      providerConfigured: true,
    });
    await expect(disabled.inspect(PROJECT_ID)).resolves.toMatchObject({
      ok: false,
      error: { code: "EXTRACTION_DISABLED" },
    });

    const browser = createAuthoritativeExtractionDesktopRuntime({
      ...common,
      featureEnabled: true,
      persistence: "browser_development",
      provider: new FixtureProvider(),
    });
    expect(browser.availability).toMatchObject({
      available: false,
      reason: "native_sqlite_required",
    });
    await expect(browser.runCycle(PROJECT_ID, { online: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "EXTRACTION_PROVIDER_UNAVAILABLE" },
    });

    const providerMissing = createAuthoritativeExtractionDesktopRuntime({
      ...common,
      featureEnabled: true,
      persistence: "native_sqlite",
    });
    expect(providerMissing.availability).toMatchObject({
      available: false,
      reason: "provider_not_configured",
    });
  });

  it("keeps provider output pending until a human atomically accepts it, rebuilds GraphRAG, and undoes it idempotently", async () => {
    const executor = new NodeSqliteExecutor(migration);
    executors.push(executor);
    await seedAuthority(executor);
    const contentHasher = new CryptoContentHasher();
    const clock = fixedClock();
    const graph = createSqliteStoryGraphRuntime({ executor, hasher: contentHasher, clock });
    const runtime = createAuthoritativeExtractionDesktopRuntime({
      featureEnabled: true,
      persistence: "native_sqlite",
      executor,
      provider: new FixtureProvider(),
      graph,
      contentHasher,
      clock,
      ids: new SequenceIds(100),
      provenance: provenance(),
      evaluationSuiteId: "authoritative.v1",
      executionMode: "local",
    });

    expect(runtime.availability).toMatchObject({ available: true });
    await expect(runtime.runEvaluation(goldenSuite())).resolves.toMatchObject({
      ok: true,
      value: {
        evaluation: {
          metrics: { precision: 1, recall: 1, passed: true },
          protocolFailureCount: 0,
        },
      },
    });
    await expect(runtime.runCycle(PROJECT_ID, { online: true })).resolves.toMatchObject({
      ok: true,
      value: {
        discoveredCount: 1,
        processedCount: 1,
        materializedCount: 1,
      },
    });

    const before = unwrap(await runtime.inspect(PROJECT_ID));
    expect(before.evaluationPassed).toBe(true);
    expect(before.candidates).toHaveLength(1);
    expect(before.candidates[0]).toMatchObject({
      extraction: {
        source: {
          chapterId: CHAPTER_ID,
          versionId: VERSION_ID,
          checksumSha256: sha256(CONTENT),
        },
        provenance: {
          prompt: { version: 5, checksumSha256: PROMPT_CHECKSUM },
          model: { provider: "fixture", id: "strict-extractor", revision: "r1" },
          evaluationVersion: "golden.v1",
        },
      },
      review: { status: "pending", revision: 1 },
      target: {
        revision: 1,
        versions: [expect.objectContaining({ value: { location: "South City" } })],
      },
    });

    const candidate = before.candidates[0];
    if (candidate === undefined) {
      throw new Error("Expected one extraction candidate.");
    }
    const decision = {
      jobId: candidate.extraction.jobId,
      candidateKey: candidate.extraction.candidate.key,
      kind: "accept" as const,
      actorId: ACTOR_ID,
      humanConfirmed: true,
    };
    const accepted = unwrap(await runtime.decideFormal(decision));
    expect(accepted).toMatchObject({
      review: { status: "accepted", revision: 2 },
      target: {
        revision: 2,
      },
      idempotent: false,
      projection: "rebuilt",
      projectionErrorCode: null,
    });
    expect(accepted.target?.versions.at(-1)?.value).toEqual({ location: "North Tower" });

    const projected = unwrap(await graph.inspectProject(PROJECT_ID));
    expect(projected.freshness).toBe("fresh");
    expect(projected.projection?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `extraction-review:${candidate.extraction.reviewItemId}`,
        }),
      ]),
    );

    await expect(runtime.decideFormal(decision)).resolves.toMatchObject({
      ok: true,
      value: {
        target: { revision: 2 },
        idempotent: true,
        projection: "rebuilt",
      },
    });

    const undone = unwrap(
      await runtime.undoAcceptance({
        jobId: candidate.extraction.jobId,
        candidateKey: candidate.extraction.candidate.key,
        actorId: ACTOR_ID,
        humanConfirmed: true,
      }),
    );
    expect(undone).toMatchObject({
      target: {
        revision: 3,
      },
      idempotent: false,
      projection: "rebuilt",
    });
    expect(undone.target.versions.at(-1)).toMatchObject({
      reason: "undo",
      value: { location: "South City" },
    });
    await expect(
      runtime.undoAcceptance({
        jobId: candidate.extraction.jobId,
        candidateKey: candidate.extraction.candidate.key,
        actorId: ACTOR_ID,
        humanConfirmed: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { target: { revision: 3 }, idempotent: true },
    });
    const afterUndo = unwrap(await graph.inspectProject(PROJECT_ID));
    expect(afterUndo.freshness).toBe("fresh");
    expect(
      afterUndo.projection?.relations.some(
        ({ id }) => id === `extraction-review:${candidate.extraction.reviewItemId}`,
      ),
    ).toBe(false);
  });
});

class FixtureProvider implements AuthoritativeExtractionProvider {
  public generate(
    request: AuthoritativeExtractionProviderRequest,
  ): Promise<Result<string, { code: string; retryable: boolean; offline: boolean }>> {
    return Promise.resolve(ok(validProviderOutput(request)));
  }
}

class CryptoContentHasher implements ContentHasher {
  public sha256(content: string) {
    return Promise.resolve(parseContentChecksum(sha256(content)));
  }
}

class SequenceIds {
  public constructor(private nextSequence: number) {}

  public next(): string {
    const value = uuid(this.nextSequence);
    this.nextSequence += 1;
    return value;
  }
}

async function seedAuthority(executor: SqlExecutor): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO projects (id, name, status, revision, created_at, updated_at)
       VALUES (?, 'Extraction project', 'active', 1, ?, ?)`,
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
      value: { location: "South City" },
      actorId: ACTOR_ID,
      humanConfirmed: true,
      now: NOW,
    }),
  );
  unwrap(await new SqliteFormalStoryRecordRepository(executor).create(record));
}

function validProviderOutput(request: AuthoritativeExtractionProviderRequest): string {
  const start = request.chapterContent.indexOf(EXCERPT);
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
        originalValue: { location: "South City" },
        suggestedValue: { location: "North Tower" },
        evidence: {
          start,
          end: start + EXCERPT.length,
          excerpt: EXCERPT,
        },
      },
    ],
  });
}

function goldenSuite(): AuthoritativeExtractionGoldenSuite {
  const source = {
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    versionId: VERSION_ID,
    checksumSha256: sha256(CONTENT),
    content: CONTENT,
  };
  const targets = [
    {
      recordId: asUuid(RECORD_ID),
      kind: "character" as const,
      expectedRevision: 1,
      value: { location: "South City" },
    },
  ];
  const context = {
    source: {
      projectId: asUuid(PROJECT_ID),
      chapterId: asUuid(CHAPTER_ID),
      versionId: asUuid(VERSION_ID),
      checksumSha256: sha256(CONTENT),
      scope: { start: 0, end: CONTENT.length, sourceLength: CONTENT.length },
    },
    chapterContent: CONTENT,
    provenance: provenance(),
    targets,
  };
  return {
    id: asIdentifier("authoritative.v1"),
    thresholds: { minimumPrecision: 1, minimumRecall: 1 },
    fixtures: [
      {
        id: asIdentifier("fixture.chapter.location"),
        source,
        targets,
        expected: unwrap(
          parseAuthoritativeExtractionOutput(
            validProviderOutput({
              publicationBoundary: "candidate_only",
              formalWriteAllowed: false,
              instruction: "",
              ...context,
            }),
            context,
          ),
        ).candidates,
      },
    ],
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

function fixedClock() {
  const parsed = parseDomainTimestamp(NOW);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return { now: () => parsed.value };
}

function neverGraph(): StoryGraphRuntimePort {
  return {
    available: true,
    inspectProject: () => Promise.reject(new Error("Graph must not be read.")),
    rebuildProject: () => Promise.reject(new Error("Graph must not be rebuilt.")),
    queryContext: () => Promise.reject(new Error("Graph must not be queried.")),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function asUuid(value: string) {
  return unwrap(parseUuidV7(value));
}

function asIdentifier(value: string) {
  return unwrap(parseSafeIdentifier(value));
}

function unwrap<Value, Failure>(result: Result<Value, Failure>): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}

function readWorkspaceFile(...segments: string[]): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (
    !existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml")) &&
    path.dirname(workspaceRoot) !== workspaceRoot
  ) {
    workspaceRoot = path.dirname(workspaceRoot);
  }
  return readFileSync(path.join(workspaceRoot, ...segments), "utf8");
}
