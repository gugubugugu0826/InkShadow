import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Clock, IsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import {
  GovernedCreativeExtensionSqliteStore,
  calculateMaximumCostMicros,
  computeGovernedExtensionRequestFingerprint,
  type GovernedExtensionRequestSnapshot,
} from "../src/index.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0025_governed_creative_extensions.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const ids = {
  project: "019fa025-0000-7000-8000-000000000001",
  chapter: "019fa025-0000-7000-8000-000000000002",
  version: "019fa025-0000-7000-8000-000000000003",
  version2: "019fa025-0000-7000-8000-000000000004",
} as const;
const checksum = "a".repeat(64);
const now = "2026-07-28T10:00:00.000Z";

class FakeClock implements Clock {
  public value = now;

  public now(): IsoUtcTimestamp {
    return this.value as IsoUtcTimestamp;
  }
}

describe("0025 governed translation and short-drama SQLite vertical", () => {
  it("migrates fresh and existing databases idempotently with authority and rollback guards", () => {
    const executor = new NodeSqliteExecutor(
      readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
    );
    seedAuthorities(executor);
    executor.database.exec(migration);
    expect(() => executor.database.exec(migration)).not.toThrow();

    const tables = executor.database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND (
             name LIKE 'governed_extension_%'
             OR name IN ('chapter_translations', 'short_drama_scripts')
           )
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map(({ name }) => name)).toEqual([
      "chapter_translations",
      "governed_extension_audit_events",
      "governed_extension_budgets",
      "governed_extension_candidates",
      "governed_extension_egress_receipts",
      "governed_extension_requests",
      "short_drama_scripts",
    ]);
    expect(
      executor.database.prepare("SELECT name FROM projects WHERE id = ?").get(ids.project),
    ).toEqual({ name: "青云志" });

    executor.database.exec("BEGIN IMMEDIATE");
    try {
      executor.database
        .prepare(
          `INSERT INTO governed_extension_budgets (
             project_id, month_key, currency, limit_micros, spent_micros,
             reserved_micros, active_requests, maximum_concurrent, revision,
             created_at, updated_at
           ) VALUES (?, '2026-07', 'USD', 1000, 0, 0, 0, 1, 1, ?, ?)`,
        )
        .run(ids.project, now, now);
      executor.database
        .prepare(
          `INSERT INTO governed_extension_budgets (
             project_id, month_key, currency, limit_micros, spent_micros,
             reserved_micros, active_requests, maximum_concurrent, revision,
             created_at, updated_at
           ) VALUES ('missing', '2026-07', 'USD', 1000, 0, 0, 0, 1, 1, ?, ?)`,
        )
        .run(now, now);
      executor.database.exec("COMMIT");
    } catch {
      executor.database.exec("ROLLBACK");
    }
    expect(
      executor.database.prepare("SELECT count(*) AS count FROM governed_extension_budgets").get(),
    ).toEqual({ count: 0 });
    expect(executor.database.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(executor.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("binds remote consent to one exact purpose, persists only its digest and rejects replay", async () => {
    const { executor, store, clock } = await createHarness();
    const prepared = await prepareStart(store, translationSnapshot(), "remote-once");
    const consent = await store.issueRemoteConsent(prepared.scope, {
      auditEventId: "audit-receipt-1",
      correlationId: "correlation-1",
      ttlMs: 10_000,
    });

    const textRows = executor.database
      .prepare(
        `SELECT receipt_digest, scope_fingerprint, provider_id, model_id
         FROM governed_extension_egress_receipts`,
      )
      .all() as Record<string, unknown>[];
    expect(JSON.stringify(textRows)).not.toContain(consent.token);
    expect(textRows[0]).toMatchObject({
      receipt_digest: consent.receiptDigest,
      scope_fingerprint: consent.scopeFingerprint,
      provider_id: "remote-provider",
      model_id: "translation-model",
    });

    const mismatched = {
      ...prepared.input,
      id: "request-purpose-mismatch",
      consentToken: consent.token,
      snapshot: {
        ...prepared.input.snapshot,
        provider: { ...prepared.input.snapshot.provider, modelId: "other-model" },
      },
    } as const;
    const mismatchFingerprint = await computeGovernedExtensionRequestFingerprint(
      mismatched.snapshot,
    );
    await expect(
      store.startRequest({
        ...mismatched,
        requestFingerprint: mismatchFingerprint,
        reservedCostMicros: calculateMaximumCostMicros(mismatched.snapshot),
      }),
    ).rejects.toMatchObject({ code: "EXTENSION_RECEIPT_PURPOSE_MISMATCH" });

    const started = await store.startRequest({
      ...prepared.input,
      consentToken: consent.token,
    });
    expect(started.created).toBe(true);
    expect(started.request.providerLocation).toBe("remote");
    const replay = await store.startRequest(prepared.input);
    expect(replay).toMatchObject({ created: false, request: { id: started.request.id } });

    await expect(
      store.startRequest({
        ...prepared.input,
        id: "request-replayed-consent",
        idempotencyKey: "remote-second-use",
        consentToken: consent.token,
      }),
    ).rejects.toMatchObject({ code: "EXTENSION_RECEIPT_REPLAYED" });

    clock.value = "2026-07-28T10:01:00.000Z";
    const expiredPrepared = await prepareStart(store, translationSnapshot(), "remote-expired");
    const expired = await store.issueRemoteConsent(expiredPrepared.scope, {
      auditEventId: "audit-receipt-expired",
      correlationId: "correlation-expired",
      ttlMs: 10_000,
    });
    clock.value = "2026-07-28T10:01:11.000Z";
    await expect(
      store.startRequest({ ...expiredPrepared.input, consentToken: expired.token }),
    ).rejects.toMatchObject({ code: "EXTENSION_RECEIPT_EXPIRED" });
  });

  it("keeps provider work behind atomic budget/concurrency gates and recovers crash reservations", async () => {
    const { executor, store, clock } = await createHarness({ maximumConcurrent: 1 });
    const first = await prepareStart(store, localDramaSnapshot(), "local-first");
    const started = await store.startRequest(first.input);
    expect(started.request.providerLocation).toBe("loopback");

    const second = await prepareStart(store, localDramaSnapshot(), "local-second");
    await expect(store.startRequest(second.input)).rejects.toMatchObject({
      code: "EXTENSION_CONCURRENCY_EXCEEDED",
    });

    clock.value = "2026-07-28T10:05:00.000Z";
    const recovered = await store.recoverOrphanedReservations({
      staleBefore: "2026-07-28T10:04:59.000Z",
      auditIdForRequest: () => "audit-recovery-1",
      correlationId: "correlation-recovery",
    });
    expect(recovered).toBe(1);
    expect(await store.getRequest(started.request.id)).toMatchObject({
      status: "failed_retryable",
      errorCode: "EXTENSION_PROCESS_RESTARTED",
      usage: {
        source: "provider_unavailable",
        calculatedCostMicros: started.request.reservedCostMicros,
      },
    });
    expect(
      executor.database
        .prepare(
          `SELECT reserved_micros, active_requests, spent_micros
           FROM governed_extension_budgets
           WHERE project_id = ? AND month_key = '2026-07'`,
        )
        .get(ids.project),
    ).toEqual({
      reserved_micros: 0,
      active_requests: 0,
      spent_micros: started.request.reservedCostMicros,
    });

    const retry = await prepareStart(store, localDramaSnapshot(), "local-retry", {
      id: "request-retry-2",
      retryOfRequestId: started.request.id,
      attempt: 2,
    });
    await expect(store.startRequest(retry.input)).resolves.toMatchObject({
      created: true,
      request: { attempt: 2, retryOfRequestId: started.request.id },
    });
  });

  it("publishes only an isolated candidate, requires provider token usage and accepts explicitly", async () => {
    const { executor, store } = await createHarness();
    const prepared = await prepareStart(store, localDramaSnapshot(), "drama-complete");
    const started = await store.startRequest(prepared.input);
    const payloadJson = JSON.stringify(shortDramaPayload());
    const completed = await store.completeRequest({
      requestId: started.request.id,
      expectedRevision: started.request.revision,
      candidateId: "candidate-drama-1",
      payloadJson,
      payloadChecksum: sha256(payloadJson),
      usage: {
        inputTokens: 500,
        outputTokens: 800,
        cachedInputTokens: 0,
        providerReceipt: "provider-request-reference",
      },
      auditEventId: "audit-candidate-published",
      correlationId: "correlation-drama",
    });
    expect(completed).toMatchObject({
      status: "candidate_ready",
      usage: {
        source: "provider_reported",
        inputTokens: 500,
        outputTokens: 800,
        calculatedCostMicros: 21,
      },
    });
    expect(
      executor.database.prepare("SELECT content FROM chapters WHERE id = ?").get(ids.chapter),
    ).toEqual({ content: "源章节正文" });
    expect(
      executor.database.prepare("SELECT count(*) AS count FROM short_drama_scripts").get(),
    ).toEqual({ count: 0 });

    const accepted = await store.acceptCandidate({
      candidateId: "candidate-drama-1",
      expectedRevision: 1,
      formalOutputId: "formal-drama-1",
      auditEventId: "audit-candidate-accept",
      correlationId: "correlation-drama-accept",
    });
    expect(accepted).toMatchObject({
      outcome: "accepted",
      candidate: { status: "accepted", formalOutputId: "formal-drama-1" },
    });
    expect(
      executor.database
        .prepare("SELECT title, format FROM short_drama_scripts WHERE id = ?")
        .get("formal-drama-1"),
    ).toEqual({ title: "雨夜", format: "vertical_micro_drama" });
    expect(
      executor.database.prepare("SELECT content FROM chapters WHERE id = ?").get(ids.chapter),
    ).toEqual({ content: "源章节正文" });
  });

  it("fails closed on unavailable or over-reservation usage while charging honest reported usage", async () => {
    const { executor, store } = await createHarness();
    const unavailablePrepared = await prepareStart(
      store,
      localDramaSnapshot(),
      "usage-unavailable",
    );
    const unavailable = await store.startRequest(unavailablePrepared.input);
    await store.failRequest({
      requestId: unavailable.request.id,
      expectedRevision: 1,
      outcome: "failed_retryable",
      errorCode: "EXTENSION_USAGE_UNAVAILABLE",
      usage: null,
      auditEventId: "audit-usage-unavailable",
      correlationId: "correlation-usage-unavailable",
    });
    expect(await store.getRequest(unavailable.request.id)).toMatchObject({
      status: "failed_retryable",
      usage: {
        source: "provider_unavailable",
        calculatedCostMicros: unavailable.request.reservedCostMicros,
      },
    });

    const tinySnapshot: GovernedExtensionRequestSnapshot = {
      ...localDramaSnapshot(),
      limits: { maximumInputTokens: 10, maximumOutputTokens: 10, timeoutMs: 30_000 },
    };
    const overPrepared = await prepareStart(store, tinySnapshot, "usage-overage");
    const over = await store.startRequest(overPrepared.input);
    const payloadJson = JSON.stringify(shortDramaPayload());
    await expect(
      store.completeRequest({
        requestId: over.request.id,
        expectedRevision: 1,
        candidateId: "candidate-overage",
        payloadJson,
        payloadChecksum: sha256(payloadJson),
        usage: {
          inputTokens: 11,
          outputTokens: 10,
          cachedInputTokens: null,
        },
        auditEventId: "audit-overage",
        correlationId: "correlation-overage",
      }),
    ).rejects.toMatchObject({ code: "EXTENSION_USAGE_OVER_RESERVATION" });
    expect(await store.getRequest(over.request.id)).toMatchObject({
      status: "failed_final",
      errorCode: "EXTENSION_USAGE_OVER_RESERVATION",
      usage: { source: "provider_reported", inputTokens: 11, outputTokens: 10 },
    });
    expect(await store.getCandidate("candidate-overage")).toBeNull();
    expect(
      executor.database
        .prepare(
          `SELECT reserved_micros, active_requests, spent_micros
           FROM governed_extension_budgets
           WHERE project_id = ? AND month_key = '2026-07'`,
        )
        .get(ids.project),
    ).toMatchObject({
      reserved_micros: 0,
      active_requests: 0,
      spent_micros: unavailable.request.reservedCostMicros + 1,
    });
  });

  it("cannot bypass the hard monthly budget by repeatedly withholding provider usage", async () => {
    const reservation = calculateMaximumCostMicros(localDramaSnapshot());
    const { executor, store } = await createHarness({ limitMicros: reservation * 2 });
    for (const suffix of ["one", "two"]) {
      const prepared = await prepareStart(store, localDramaSnapshot(), `unknown-${suffix}`);
      const started = await store.startRequest(prepared.input);
      await store.failRequest({
        requestId: started.request.id,
        expectedRevision: started.request.revision,
        outcome: "failed_retryable",
        errorCode: "EXTENSION_PROVIDER_FAILED",
        auditEventId: `audit-unknown-${suffix}`,
        correlationId: `correlation-unknown-${suffix}`,
      });
    }
    const blocked = await prepareStart(store, localDramaSnapshot(), "unknown-three");
    await expect(store.startRequest(blocked.input)).rejects.toMatchObject({
      code: "EXTENSION_BUDGET_EXCEEDED",
    });
    expect(
      executor.database
        .prepare(
          `SELECT spent_micros, reserved_micros, active_requests
           FROM governed_extension_budgets
           WHERE project_id = ? AND month_key = '2026-07'`,
        )
        .get(ids.project),
    ).toEqual({
      spent_micros: reservation * 2,
      reserved_micros: 0,
      active_requests: 0,
    });
  });

  it("makes cancellation win its CAS race and expires a candidate when its source changes", async () => {
    const { executor, store } = await createHarness();
    const cancelPrepared = await prepareStart(store, localTranslationSnapshot(), "cancel-race");
    const cancelledStart = await store.startRequest(cancelPrepared.input);
    const cancelled = await store.cancelRequest({
      requestId: cancelledStart.request.id,
      expectedRevision: 1,
      auditEventId: "audit-cancel",
      correlationId: "correlation-cancel",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      usage: {
        source: "provider_unavailable",
        calculatedCostMicros: cancelledStart.request.reservedCostMicros,
      },
    });
    const translationJson = JSON.stringify(translationPayload());
    await expect(
      store.completeRequest({
        requestId: cancelledStart.request.id,
        expectedRevision: 1,
        candidateId: "candidate-cancelled",
        payloadJson: translationJson,
        payloadChecksum: sha256(translationJson),
        usage: { inputTokens: 50, outputTokens: 60, cachedInputTokens: null },
        auditEventId: "audit-late-complete",
        correlationId: "correlation-late-complete",
      }),
    ).rejects.toMatchObject({ code: "EXTENSION_REVISION_CONFLICT" });
    expect(await store.getCandidate("candidate-cancelled")).toBeNull();

    const stalePrepared = await prepareStart(store, localTranslationSnapshot(), "stale-source");
    const staleStart = await store.startRequest(stalePrepared.input);
    const candidateRequest = await store.completeRequest({
      requestId: staleStart.request.id,
      expectedRevision: 1,
      candidateId: "candidate-stale",
      payloadJson: translationJson,
      payloadChecksum: sha256(translationJson),
      usage: { inputTokens: 50, outputTokens: 60, cachedInputTokens: null },
      auditEventId: "audit-stale-published",
      correlationId: "correlation-stale",
    });
    expect(candidateRequest.candidateId).toBe("candidate-stale");

    replaceCurrentVersion(executor);
    const decision = await store.acceptCandidate({
      candidateId: "candidate-stale",
      expectedRevision: 1,
      formalOutputId: "formal-translation-stale",
      auditEventId: "audit-stale-expired",
      correlationId: "correlation-stale-expired",
    });
    expect(decision).toMatchObject({
      outcome: "expired",
      candidate: { status: "expired", formalOutputId: null },
      errorCode: "CANDIDATE_STALE",
    });
    expect(
      executor.database.prepare("SELECT count(*) AS count FROM chapter_translations").get(),
    ).toEqual({ count: 0 });
  });

  it("keeps audit records content-free and rejects request idempotency fingerprint drift", async () => {
    const { executor, store } = await createHarness();
    const prepared = await prepareStart(store, localDramaSnapshot(), "same-idempotency");
    await store.startRequest(prepared.input);
    const changedSnapshot: GovernedExtensionRequestSnapshot = {
      ...prepared.input.snapshot,
      limits: { ...prepared.input.snapshot.limits, maximumOutputTokens: 2_001 },
    };
    await expect(
      store.startRequest({
        ...prepared.input,
        snapshot: changedSnapshot,
        requestFingerprint: await computeGovernedExtensionRequestFingerprint(changedSnapshot),
        reservedCostMicros: calculateMaximumCostMicros(changedSnapshot),
      }),
    ).rejects.toMatchObject({ code: "EXTENSION_IDEMPOTENCY_CONFLICT" });

    const auditText = JSON.stringify(
      executor.database
        .prepare(
          `SELECT provider_id, model_id, base_url_digest,
                  request_fingerprint, error_code, metadata_json
           FROM governed_extension_audit_events`,
        )
        .all(),
    );
    expect(auditText).not.toContain("源章节正文");
    expect(auditText.toLowerCase()).not.toContain("prompt");
    expect(auditText.toLowerCase()).not.toContain("bearer");
    expect(auditText.toLowerCase()).not.toContain('"key"');
    expect(auditText).not.toContain("http://127.0.0.1:11434/v1");
  });
});

async function createHarness(
  options: {
    readonly maximumConcurrent?: number;
    readonly limitMicros?: number;
  } = {},
) {
  const executor = new NodeSqliteExecutor(migration);
  seedAuthorities(executor);
  const clock = new FakeClock();
  const store = new GovernedCreativeExtensionSqliteStore(executor, clock);
  await store.configureBudget({
    projectId: ids.project,
    monthKey: "2026-07",
    currency: "USD",
    limitMicros: options.limitMicros ?? 1_000_000,
    maximumConcurrent: options.maximumConcurrent ?? 4,
  });
  return { executor, store, clock };
}

async function prepareStart(
  _store: GovernedCreativeExtensionSqliteStore,
  snapshot: GovernedExtensionRequestSnapshot,
  idempotencyKey: string,
  overrides: {
    readonly id?: string;
    readonly retryOfRequestId?: string;
    readonly attempt?: number;
  } = {},
) {
  const fingerprint = await computeGovernedExtensionRequestFingerprint(snapshot);
  return {
    scope: {
      kind: snapshot.kind,
      providerId: snapshot.provider.providerId,
      baseUrl: snapshot.provider.baseUrl,
      modelId: snapshot.provider.modelId,
      dataCategories: snapshot.dataCategories,
      projectId: snapshot.projectId,
      chapterId: snapshot.chapterId,
      sourceVersionId: snapshot.sourceVersionId,
      priceVersion: snapshot.pricing.priceVersion,
      requestFingerprint: fingerprint,
    } as const,
    input: {
      id: overrides.id ?? `request-${idempotencyKey}`,
      idempotencyKey,
      requestFingerprint: fingerprint,
      snapshot,
      reservedCostMicros: calculateMaximumCostMicros(snapshot),
      monthKey: "2026-07",
      ...(overrides.retryOfRequestId === undefined
        ? {}
        : { retryOfRequestId: overrides.retryOfRequestId }),
      ...(overrides.attempt === undefined ? {} : { attempt: overrides.attempt }),
      auditEventId: `audit-start-${idempotencyKey}`,
      correlationId: `correlation-${idempotencyKey}`,
    },
  };
}

function translationSnapshot(): GovernedExtensionRequestSnapshot {
  return {
    schemaVersion: 1,
    kind: "translation",
    projectId: ids.project,
    chapterId: ids.chapter,
    sourceVersionId: ids.version,
    sourceChecksum: checksum,
    sourceText: "源章节正文",
    settings: {
      targetLanguage: { code: "en-US", label: "English (US)" },
      tone: "literary",
      glossaryVersion: "glossary-1",
      glossary: [{ source: "青石板", target: "bluestone path", note: null }],
    },
    provider: {
      location: "remote",
      providerId: "remote-provider",
      baseUrl: "https://provider.example/v1",
      modelId: "translation-model",
    },
    dataCategories: ["chapter_text", "glossary", "translation_settings"],
    pricing: {
      inputMicrosPerMillionTokens: 10_000,
      outputMicrosPerMillionTokens: 20_000,
      currency: "USD",
      priceVersion: "price-2026-07",
      priceUpdatedAt: now,
    },
    limits: {
      maximumInputTokens: 2_000,
      maximumOutputTokens: 2_000,
      timeoutMs: 30_000,
    },
  };
}

function localDramaSnapshot(): GovernedExtensionRequestSnapshot {
  return {
    schemaVersion: 1,
    kind: "short_drama",
    projectId: ids.project,
    chapterId: ids.chapter,
    sourceVersionId: ids.version,
    sourceChecksum: checksum,
    sourceText: "源章节正文",
    settings: {
      format: "vertical_micro_drama",
      targetEpisodeCount: 1,
      targetEpisodeDurationSeconds: 90,
      tone: "suspense",
    },
    provider: {
      location: "loopback",
      providerId: "ollama-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "local-screenplay",
    },
    dataCategories: ["chapter_text", "short_drama_settings"],
    pricing: {
      inputMicrosPerMillionTokens: 10_000,
      outputMicrosPerMillionTokens: 20_000,
      currency: "USD",
      priceVersion: "local-estimate-1",
      priceUpdatedAt: now,
    },
    limits: {
      maximumInputTokens: 2_000,
      maximumOutputTokens: 2_000,
      timeoutMs: 30_000,
    },
  };
}

function localTranslationSnapshot(): GovernedExtensionRequestSnapshot {
  return {
    ...translationSnapshot(),
    provider: {
      location: "loopback",
      providerId: "ollama-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "local-translation",
    },
  };
}

function translationPayload() {
  return {
    schemaVersion: 1,
    kind: "translation",
    source: {
      chapterId: ids.chapter,
      sourceVersionId: ids.version,
      sourceChecksum: checksum,
    },
    targetLanguage: { code: "en-US", label: "English (US)" },
    tone: "literary",
    glossaryVersion: "glossary-1",
    paragraphs: [
      {
        sourceParagraph: 0,
        sourceChecksum: "b".repeat(64),
        translatedText: "Source chapter.",
        glossaryTerms: ["青石板"],
      },
    ],
  } as const;
}

function shortDramaPayload() {
  return {
    schemaVersion: 1,
    kind: "short_drama",
    source: {
      chapterId: ids.chapter,
      sourceVersionId: ids.version,
      sourceChecksum: checksum,
    },
    title: "雨夜",
    format: "vertical_micro_drama",
    episodes: [
      {
        number: 1,
        title: "不归路",
        durationSeconds: 12,
        scenes: [
          {
            number: 1,
            slugline: "外景·雨夜",
            location: "青云山脚",
            timeOfDay: "雨夜",
            durationSeconds: 12,
            characters: ["林青云"],
            sourceReferences: [
              {
                paragraphStart: 0,
                paragraphEnd: 0,
                sourceChecksum: "b".repeat(64),
              },
            ],
            shots: [
              {
                number: 1,
                shotType: "中景",
                action: "林青云握紧剑。",
                durationSeconds: 12,
                dialogue: [],
              },
            ],
          },
        ],
      },
    ],
  } as const;
}

function seedAuthorities(executor: NodeSqliteExecutor): void {
  executor.database.exec("BEGIN IMMEDIATE");
  executor.database
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(ids.project, "青云志", now, now);
  executor.database
    .prepare(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id,
         created_at, updated_at, trashed_at
       ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)`,
    )
    .run(ids.chapter, ids.project, "第一章", "源章节正文", ids.version, now, now);
  executor.database
    .prepare(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
    )
    .run(ids.version, ids.project, ids.chapter, "源章节正文", checksum, now);
  executor.database.exec("COMMIT");
}

function replaceCurrentVersion(executor: NodeSqliteExecutor): void {
  const secondChecksum = "c".repeat(64);
  executor.database
    .prepare(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, ?, 2, ?, ?, 'manual', NULL, ?)`,
    )
    .run(
      ids.version2,
      ids.project,
      ids.chapter,
      ids.version,
      "已变化正文",
      secondChecksum,
      "2026-07-28T10:10:00.000Z",
    );
  executor.database
    .prepare(
      `UPDATE chapters
       SET content = '已变化正文', current_version_id = ?, revision = revision + 1,
           updated_at = '2026-07-28T10:10:00.000Z'
       WHERE id = ?`,
    )
    .run(ids.version2, ids.chapter);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
