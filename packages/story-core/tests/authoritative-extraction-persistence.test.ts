import { readFileSync } from "node:fs";

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FormalStoryRecord,
  SqliteAuthoritativeExtractionRepository,
  SqliteFormalStoryRecordRepository,
  createAuthoritativeExtractionJob,
  parseAuthoritativeExtractionOutput,
  parseIsoUtcTimestamp,
  parseSafeIdentifier,
  parseUuidV7,
  type AuthoritativeExtractionCandidateRecord,
  type AuthoritativeExtractionEvaluationRecord,
  type AuthoritativeExtractionJob,
  type AuthoritativeExtractionProvenance,
  type AuthoritativeExtractionSource,
  type IsoUtcTimestamp,
  type SafeIdentifier,
  type UuidV7,
} from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";
import { NodeStorySqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(
  new URL("../../data/migrations/0001_core.sql", import.meta.url),
  "utf8",
);
const storyMigration = readFileSync(
  new URL("../migrations/0001_story_core.sql", import.meta.url),
  "utf8",
);
const extractionMigration = readFileSync(
  new URL("../../data/migrations/0027_authoritative_extraction.sql", import.meta.url),
  "utf8",
);
const migration = [coreMigration, storyMigration, extractionMigration].join("\n");

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const RECORD_ID = uuid(4);
const ACTOR_ID = uuid(5);
const JOB_ID = uuid(6);
const REVIEW_ID = uuid(7);
const DECISION_ID = uuid(8);
const EVALUATION_ID = uuid(9);
const NOW = "2026-07-28T01:00:00.000Z";
const LEASE_END = "2026-07-28T01:01:00.000Z";
const AFTER_LEASE = "2026-07-28T01:02:00.000Z";
const CONTENT = "林舟从南城抵达北塔。";
const CHECKSUM = "a".repeat(64);
const PROMPT_CHECKSUM = "b".repeat(64);

describe("authoritative extraction SQLite repository", () => {
  let executor: NodeStorySqliteExecutor;
  let repository: SqliteAuthoritativeExtractionRepository;

  beforeEach(async () => {
    executor = new NodeStorySqliteExecutor(migration);
    repository = new SqliteAuthoritativeExtractionRepository(executor);
    await seedAuthority(executor);
  });

  afterEach(() => {
    executor.close();
  });

  it("idempotently queues metadata only and recovers provider/materialization leases", async () => {
    const first = await repository.enqueue(job(JOB_ID));
    const duplicate = await repository.enqueue(job(uuid(20)));
    if (!first.ok) {
      throw first.error;
    }

    expect(first.value.created).toBe(true);
    expect(duplicate).toMatchObject({
      ok: true,
      value: { created: false, job: { id: JOB_ID } },
    });
    const columns = executor.database
      .prepare("PRAGMA table_info(authoritative_extraction_jobs)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "content",
        "chapter_content",
        "prompt_body",
        "raw_response",
        "messages",
        "credential",
      ]),
    );

    const claimed = unwrap(
      await repository.claimNext({
        projectId: asUuid(PROJECT_ID),
        workerId: asIdentifier("worker.one"),
        now: asTime(NOW),
        leaseExpiresAt: asTime(LEASE_END),
      }),
    );
    expect(claimed).toMatchObject({ state: "running", attemptCount: 1, revision: 2 });

    const recoveredProvider = unwrap(await repository.recoverExpiredLeases(asTime(AFTER_LEASE)));
    expect(recoveredProvider).toMatchObject([
      {
        id: JOB_ID,
        state: "failed_retryable",
        failure: { code: "worker_lease_expired", retryable: true },
      },
    ]);

    const retried = unwrap(
      await repository.claimNext({
        projectId: asUuid(PROJECT_ID),
        workerId: asIdentifier("worker.one"),
        now: asTime(AFTER_LEASE),
        leaseExpiresAt: asTime("2026-07-28T01:03:00.000Z"),
      }),
    );
    if (retried === null) {
      throw new Error("retry claim missing");
    }
    const candidate = candidateRecord(retried);
    const completed = unwrap(
      await repository.completeAttempt({
        job: retried,
        expectedRevision: retried.revision,
        workerId: asIdentifier("worker.one"),
        candidates: [candidate],
        now: asTime(AFTER_LEASE),
      }),
    );
    expect(completed.state).toBe("materialization_pending");

    const materializing = unwrap(
      await repository.claimMaterialization({
        projectId: asUuid(PROJECT_ID),
        workerId: asIdentifier("worker.one"),
        now: asTime(AFTER_LEASE),
        leaseExpiresAt: asTime("2026-07-28T01:03:00.000Z"),
      }),
    );
    expect(materializing).toMatchObject({ state: "materializing" });
    const recoveredMaterialization = unwrap(
      await repository.recoverExpiredLeases(asTime("2026-07-28T01:04:00.000Z")),
    );
    expect(recoveredMaterialization).toMatchObject([
      { id: JOB_ID, state: "materialization_pending", attemptCount: 2 },
    ]);

    expect(await repository.listCandidatesByJob(asUuid(JOB_ID))).toMatchObject({
      ok: true,
      value: [
        {
          reviewItemId: REVIEW_ID,
          source: {
            chapterId: CHAPTER_ID,
            versionId: VERSION_ID,
            checksumSha256: CHECKSUM,
          },
          provenance: {
            prompt: { version: 4, checksumSha256: PROMPT_CHECKSUM },
            model: { provider: "fixture", id: "extractor", revision: "r1" },
            evaluationVersion: "golden.v1",
          },
        },
      ],
    });
  });

  it("persists exact golden metrics and gates only the matching prompt/model/eval tuple", async () => {
    const evaluation: AuthoritativeExtractionEvaluationRecord = {
      id: asUuid(EVALUATION_ID),
      suiteId: asIdentifier("authoritative.v1"),
      provenance: provenance(),
      thresholds: { minimumPrecision: 0.9, minimumRecall: 0.8 },
      metrics: {
        truePositiveCount: 9,
        falsePositiveCount: 1,
        falseNegativeCount: 1,
        predictedCount: 10,
        expectedCount: 10,
        precision: 0.9,
        recall: 0.9,
        passed: true,
      },
      fixtureCount: 3,
      protocolFailureCount: 0,
      createdAt: asTime(NOW),
    };

    await expect(repository.recordEvaluation(evaluation)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(repository.recordEvaluation(evaluation)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      repository.findLatestPassingEvaluation(asIdentifier("authoritative.v1"), provenance()),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        id: EVALUATION_ID,
        metrics: { precision: 0.9, recall: 0.9, passed: true },
      },
    });
    await expect(
      repository.findLatestPassingEvaluation(asIdentifier("authoritative.v1"), {
        ...provenance(),
        evaluationVersion: asIdentifier("golden.v2"),
      }),
    ).resolves.toEqual({ ok: true, value: null });
  });

  it("keeps a stable decision ID across crash retries and rejects payload reuse", async () => {
    await repository.enqueue(job(JOB_ID));
    const claimed = unwrap(
      await repository.claimNext({
        projectId: asUuid(PROJECT_ID),
        workerId: asIdentifier("worker.one"),
        now: asTime(NOW),
        leaseExpiresAt: asTime(LEASE_END),
      }),
    );
    if (claimed === null) {
      throw new Error("claim missing");
    }
    await repository.completeAttempt({
      job: claimed,
      expectedRevision: claimed.revision,
      workerId: asIdentifier("worker.one"),
      candidates: [candidateRecord(claimed)],
      now: asTime(NOW),
    });
    const input = {
      idempotencyKey: `formal:${JOB_ID}:linzhou.location`,
      jobId: asUuid(JOB_ID),
      candidateKey: asIdentifier("linzhou.location"),
      decisionId: asUuid(DECISION_ID),
      kind: "accept" as const,
      payloadChecksumSha256: "c".repeat(64),
      now: asTime(NOW),
    };

    const first = await repository.claimDecision(input);
    const retry = await repository.claimDecision({ ...input, decisionId: asUuid(uuid(99)) });
    expect(first).toMatchObject({ ok: true, value: { decisionId: DECISION_ID } });
    expect(retry).toMatchObject({ ok: true, value: { decisionId: DECISION_ID } });
    await expect(
      repository.claimDecision({
        ...input,
        payloadChecksumSha256: "d".repeat(64),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EXTRACTION_INVALID_TRANSITION" },
    });
  });
});

describe("0027 authoritative extraction migration", () => {
  it("supports fresh, reused, and prior-schema upgrade paths", () => {
    const fresh = new DatabaseSync(":memory:");
    expect(() => fresh.exec(migration)).not.toThrow();
    expect(() => fresh.exec(extractionMigration)).not.toThrow();
    expect(
      fresh
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name LIKE 'authoritative_extraction_%'",
        )
        .get(),
    ).toEqual({ count: 4 });
    fresh.close();

    const upgraded = new DatabaseSync(":memory:");
    upgraded.exec([coreMigration, storyMigration].join("\n"));
    expect(() => upgraded.exec(extractionMigration)).not.toThrow();
    expect(() => upgraded.exec(extractionMigration)).not.toThrow();
    expect(
      upgraded
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'authoritative_extraction_jobs'",
        )
        .get(),
    ).toEqual({ count: 1 });
    upgraded.close();
  });
});

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
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, CONTENT, CHECKSUM, NOW],
    );
  });
  const formal = unwrap(
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
  unwrap(await new SqliteFormalStoryRecordRepository(executor).create(formal));
}

function job(id: string): AuthoritativeExtractionJob {
  return unwrap(
    createAuthoritativeExtractionJob({
      id,
      source: source(),
      provenance: provenance(),
      evaluationSuiteId: "authoritative.v1",
      executionMode: "remote",
      now: NOW,
    }),
  );
}

function source(): AuthoritativeExtractionSource {
  return {
    projectId: asUuid(PROJECT_ID),
    chapterId: asUuid(CHAPTER_ID),
    versionId: asUuid(VERSION_ID),
    checksumSha256: CHECKSUM,
    scope: { start: 0, end: CONTENT.length, sourceLength: CONTENT.length },
  };
}

function provenance(): AuthoritativeExtractionProvenance {
  return {
    prompt: {
      registryId: asIdentifier("story.authoritative.extract"),
      version: 4,
      checksumSha256: PROMPT_CHECKSUM,
    },
    model: { provider: "fixture", id: "extractor", revision: "r1" },
    evaluationVersion: asIdentifier("golden.v1"),
  };
}

function candidateRecord(
  jobValue: AuthoritativeExtractionJob,
): AuthoritativeExtractionCandidateRecord {
  const excerpt = "抵达北塔";
  const start = CONTENT.indexOf(excerpt);
  const parsed = unwrap(
    parseAuthoritativeExtractionOutput(
      JSON.stringify({
        schemaVersion: "inkshadow.authoritative-extraction.v1",
        source: source(),
        prompt: provenance().prompt,
        model: provenance().model,
        evaluationVersion: provenance().evaluationVersion,
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
            confidence: 0.96,
            originalValue: { location: "南城" },
            suggestedValue: { location: "北塔" },
            evidence: {
              start,
              end: start + excerpt.length,
              excerpt,
            },
          },
        ],
      }),
      {
        source: source(),
        chapterContent: CONTENT,
        provenance: provenance(),
        targets: [
          {
            recordId: asUuid(RECORD_ID),
            kind: "character",
            expectedRevision: 1,
            value: { location: "南城" },
          },
        ],
      },
    ),
  );
  const candidate = parsed.candidates[0];
  if (candidate === undefined) {
    throw new Error("candidate fixture missing");
  }
  return {
    jobId: jobValue.id,
    reviewItemId: asUuid(REVIEW_ID),
    source: jobValue.source,
    provenance: jobValue.provenance,
    candidate,
    createdAt: asTime(NOW),
  };
}

function asUuid(value: string): UuidV7 {
  return unwrap(parseUuidV7(value));
}

function asIdentifier(value: string): SafeIdentifier {
  return unwrap(parseSafeIdentifier(value));
}

function asTime(value: string): IsoUtcTimestamp {
  return unwrap(parseIsoUtcTimestamp(value));
}
