import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { MultiAgentReviewSession } from "@inkshadow/data";

import { buildMessages, SqliteMultiAgentReviewContextReader } from "./multi-agent-review-runtime";
import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";

const migration = [
  readMigration("data", "0001_core.sql"),
  readMigration("story-core", "0001_story_core.sql"),
  readMigration("data", "0032_unified_story_facts.sql"),
  readMigration("data", "0033_causal_event_graph.sql"),
].join("\n");

const ids = {
  project: "019fa100-0000-7000-8000-000000000001",
  chapter: "019fa100-0000-7000-8000-000000000002",
  version: "019fa100-0000-7000-8000-000000000003",
  formalFact: "019fa100-0000-7000-8000-000000000004",
  unconfirmedFact: "019fa100-0000-7000-8000-000000000005",
  branchFact: "019fa100-0000-7000-8000-000000000006",
  invalidFact: "019fa100-0000-7000-8000-000000000007",
  actor: "019fa100-0000-7000-8000-000000000008",
  branch: "019fa100-0000-7000-8000-000000000009",
  evidence: "causal-evidence-main",
  event: "causal-event-main",
  alternateEvent: "causal-event-alternate",
} as const;

const NOW = "2026-08-01T02:00:00.000Z";
const CHAPTER_CONTENT = "甲在雨夜交出钥匙，乙因此得知真相。";
const EVIDENCE_EXCERPT = "交出钥匙";

describe("multi-agent unified story context", () => {
  it("admits only confirmed main StoryFacts and main causal events with exact chapter evidence", async () => {
    const executor = createExecutor();
    await seedBaseAuthorities(executor);
    await insertChapterFact(executor, {
      id: ids.formalFact,
      status: "formal",
      origin: "user",
      userConfirmed: 1,
      branchId: null,
      needsReview: 0,
    });
    await insertStatementFact(executor, {
      id: ids.unconfirmedFact,
      status: "unconfirmed",
      origin: "ai_extraction",
      userConfirmed: 0,
      branchId: null,
      needsReview: 1,
    });
    await insertStatementFact(executor, {
      id: ids.branchFact,
      status: "branch",
      origin: "user",
      userConfirmed: 0,
      branchId: ids.branch,
      needsReview: 0,
    });
    await insertCausalEvidenceAndEvent(executor, {
      contentHash: checksum(CHAPTER_CONTENT),
      branchId: "main",
      eventId: ids.event,
    });
    await insertCausalEvent(executor, ids.alternateEvent, ids.branch, ids.evidence);

    try {
      const context = await new SqliteMultiAgentReviewContextReader(executor).load(
        await outlineSession(),
      );
      const authority = asRecord(JSON.parse(requireStoryContext(context.unifiedStoryContextJson)));
      const storyFacts = asRecord(authority.storyFacts);
      const facts = asArray(storyFacts.items).map(asRecord);
      expect(storyFacts.status).toBe("available");
      expect(facts.map(({ id }) => id)).toEqual([ids.formalFact]);
      expect(asRecord(facts[0]?.source).contentChecksum).toBe(checksum(CHAPTER_CONTENT));

      const causalGraph = asRecord(authority.causalGraph);
      const events = asArray(causalGraph.events).map(asRecord);
      expect(causalGraph.status).toBe("available");
      expect(events.map(({ id }) => id)).toEqual([ids.event]);
      const evidence = asRecord(asArray(causalGraph.evidenceSources)[0]);
      expect(evidence).toMatchObject({
        chapterVersionId: ids.version,
        contentHash: checksum(CHAPTER_CONTENT),
        startOffset: CHAPTER_CONTENT.indexOf(EVIDENCE_EXCERPT),
        endOffset: CHAPTER_CONTENT.indexOf(EVIDENCE_EXCERPT) + EVIDENCE_EXCERPT.length,
        sourceLength: CHAPTER_CONTENT.length,
        excerpt: EVIDENCE_EXCERPT,
      });

      const receipts = asArray(JSON.parse(context.citationReceiptsJson)).map(asRecord);
      expect(receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "project_rule", sourceId: ids.formalFact }),
          expect.objectContaining({
            kind: "chapter",
            sourceId: ids.chapter,
            sourceVersionId: ids.version,
            sourceChecksum: checksum(CHAPTER_CONTENT),
            excerpt: EVIDENCE_EXCERPT,
          }),
        ]),
      );
      expect(receipts.some(({ sourceId }) => sourceId === ids.unconfirmedFact)).toBe(false);
      expect(receipts.some(({ sourceId }) => sourceId === ids.branchFact)).toBe(false);

      const messages = buildMessages(await outlineSession(), "continuity_reviewer", context, true);
      expect(messages[0]?.content).toContain("formal user-confirmed main-branch StoryFacts");
      expect(messages[0]?.content).toContain("evidence is insufficient");
      const prompt = asRecord(JSON.parse(messages[1]?.content ?? "{}"));
      expect(asRecord(prompt.unifiedStoryContext).truthPolicy).toMatchObject({
        branchId: "main",
        missingEvidenceMeans: "unknown",
      });
    } finally {
      await executor.close();
    }
  });

  it("skips stale StoryFact spans and an unverified causal graph instead of inventing context", async () => {
    const executor = createExecutor();
    await seedBaseAuthorities(executor);
    await insertChapterFact(executor, {
      id: ids.invalidFact,
      status: "formal",
      origin: "user",
      userConfirmed: 1,
      branchId: null,
      needsReview: 0,
      excerpt: "并不存在的原文",
    });
    await insertCausalEvidenceAndEvent(executor, {
      contentHash: "f".repeat(64),
      branchId: "main",
      eventId: ids.event,
    });

    try {
      const context = await new SqliteMultiAgentReviewContextReader(executor).load(
        await outlineSession(),
      );
      const authority = asRecord(JSON.parse(requireStoryContext(context.unifiedStoryContextJson)));
      const storyFacts = asRecord(authority.storyFacts);
      expect(storyFacts.status).toBe("insufficient");
      expect(storyFacts.items).toEqual([]);
      expect(storyFacts.skipped).toEqual([expect.objectContaining({ sourceId: ids.invalidFact })]);
      const causalGraph = asRecord(authority.causalGraph);
      expect(causalGraph.status).toBe("unavailable");
      expect(causalGraph.events).toEqual([]);
      expect(causalGraph.evidenceSources).toEqual([]);
      const receipts = asArray(JSON.parse(context.citationReceiptsJson)).map(asRecord);
      expect(receipts.some(({ kind }) => kind === "project_rule")).toBe(false);
      expect(receipts.some(({ kind }) => kind === "chapter")).toBe(false);
    } finally {
      await executor.close();
    }
  });
});

function createExecutor(): NodeSqliteExecutor {
  return new NodeSqliteExecutor(migration);
}

function readMigration(packageName: "data" | "story-core", fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(
    path.join(workspaceRoot, "packages", packageName, "migrations", fileName),
    "utf8",
  );
}

async function seedBaseAuthorities(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (id, name, status, revision, created_at, updated_at)
     VALUES (?, 'InkShadow', 'active', 1, ?, ?)`,
    [ids.project, NOW, NOW],
  );
  executor.database.exec("BEGIN");
  try {
    executor.database
      .prepare(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision,
           current_version_id, created_at, updated_at
         ) VALUES (?, ?, '第一章', ?, 'active', 1, ?, ?, ?)`,
      )
      .run(ids.chapter, ids.project, CHAPTER_CONTENT, ids.version, NOW, NOW);
    executor.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      )
      .run(ids.version, ids.project, ids.chapter, CHAPTER_CONTENT, checksum(CHAPTER_CONTENT), NOW);
    executor.database.exec("COMMIT");
  } catch (cause: unknown) {
    executor.database.exec("ROLLBACK");
    throw cause;
  }
  await executor.execute(
    `INSERT INTO story_outlines (project_id, revision, snapshot_json)
     VALUES (?, 1, ?)`,
    [ids.project, JSON.stringify(outlineSnapshot())],
  );
}

async function insertChapterFact(
  executor: NodeSqliteExecutor,
  input: {
    readonly id: string;
    readonly status: "formal";
    readonly origin: "user";
    readonly userConfirmed: 1;
    readonly branchId: null;
    readonly needsReview: 0;
    readonly excerpt?: string;
  },
): Promise<void> {
  const start = CHAPTER_CONTENT.indexOf(EVIDENCE_EXCERPT);
  const excerpt = input.excerpt ?? EVIDENCE_EXCERPT;
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json,
       source_kind, evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       ?, ?, 'item.ownership', '钥匙已经交给乙', ?,
       'chapter_span', '第一章钥匙交接', ?, ?, ?, ?, ?, ?,
       NULL, NULL, ?, 1.0, ?, ?, ?, 1, 0, ?, ?, ?, 1, ?, ?
     )`,
    [
      input.id,
      ids.project,
      JSON.stringify({ itemId: "key", owner: "乙" }),
      ids.chapter,
      ids.version,
      start,
      start + excerpt.length,
      CHAPTER_CONTENT.length,
      excerpt,
      input.branchId,
      input.status,
      input.origin,
      input.userConfirmed,
      input.needsReview,
      ids.actor,
      NOW,
      NOW,
      NOW,
    ],
  );
}

async function insertStatementFact(
  executor: NodeSqliteExecutor,
  input: {
    readonly id: string;
    readonly status: "unconfirmed" | "branch";
    readonly origin: "ai_extraction" | "user";
    readonly userConfirmed: 0;
    readonly branchId: string | null;
    readonly needsReview: 0 | 1;
  },
): Promise<void> {
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json,
       source_kind, evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       ?, ?, 'character.claim', '未经确认的推测', NULL,
       'user_statement', '测试输入', NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, ?, 0.5, ?, ?, 0, 0, 0, ?, NULL, NULL, 1, ?, ?
     )`,
    [
      input.id,
      ids.project,
      input.branchId,
      input.status,
      input.origin,
      input.needsReview,
      NOW,
      NOW,
    ],
  );
}

async function insertCausalEvidenceAndEvent(
  executor: NodeSqliteExecutor,
  input: { readonly contentHash: string; readonly branchId: string; readonly eventId: string },
): Promise<void> {
  const start = CHAPTER_CONTENT.indexOf(EVIDENCE_EXCERPT);
  await executor.execute(
    `INSERT INTO causal_evidence_sources (
       id, project_id, chapter_id, chapter_version_id, content_hash,
       locator, excerpt, start_offset, end_offset, source_length, created_at
     ) VALUES (?, ?, ?, ?, ?, '第一章钥匙交接', ?, ?, ?, ?, ?)`,
    [
      ids.evidence,
      ids.project,
      ids.chapter,
      ids.version,
      input.contentHash,
      EVIDENCE_EXCERPT,
      start,
      start + EVIDENCE_EXCERPT.length,
      CHAPTER_CONTENT.length,
      NOW,
    ],
  );
  await insertCausalEvent(executor, input.eventId, input.branchId, ids.evidence);
}

async function insertCausalEvent(
  executor: NodeSqliteExecutor,
  eventId: string,
  branchId: string,
  evidenceId: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO causal_events (
       id, project_id, branch_id, status, narrative_order, narrative_label,
       location_id, location_label, event_text, result_text, evidence_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'confirmed', 1, '雨夜', 'station', '车站',
       '甲把钥匙交给乙', '乙得知真相', ?, ?, ?)`,
    [eventId, ids.project, branchId, evidenceId, NOW, NOW],
  );
}

async function outlineSession(): Promise<MultiAgentReviewSession> {
  const snapshotJson = JSON.stringify(outlineSnapshot());
  return {
    id: "review-unified-context",
    projectId: ids.project,
    idempotencyKey: "review-unified-context-request",
    requestFingerprint: "a".repeat(64),
    restartOfSessionId: null,
    mode: "outline_review",
    targetKind: "outline",
    chapterId: null,
    baseVersionId: null,
    baseOutlineRevision: 1,
    baseAuthorityChecksum: await sha256(snapshotJson),
    userRequest: "检查故事连续性",
    status: "running",
    revision: 1,
    attempt: 1,
    limits: {
      maximumRounds: 1,
      maximumTurns: 1,
      maximumInputTokens: 120_000,
      maximumOutputTokens: 16_000,
      maximumCostMicros: 1_000_000,
      maximumDurationMs: 600_000,
      currency: "USD",
    },
    cancellationRequested: false,
    failureCode: null,
    startedAt: NOW,
    deadlineAt: "2026-08-01T02:10:00.000Z",
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    participants: [],
    turns: [],
    candidate: null,
  };
}

function outlineSnapshot() {
  return {
    projectId: ids.project,
    revision: 1,
    nodes: [
      {
        id: "outline-node-1",
        revision: 1,
        title: "第一幕",
        synopsis: "钥匙完成交接。",
      },
    ],
  };
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireStoryContext(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Expected the SQLite reader to provide unified story context.");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object value.");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected an array value.");
  }
  return value;
}
