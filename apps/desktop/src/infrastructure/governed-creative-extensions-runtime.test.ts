import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { GovernedCreativeExtensionSqliteStore } from "@inkshadow/data";
import type { Clock, IsoUtcTimestamp, UuidV7, UuidV7Generator } from "@inkshadow/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  GovernedCreativeExtensionRuntimeError,
  GovernedCreativeExtensionsRuntime,
  type GovernedCreativeExtensionFlags,
  type GovernedCreativeExtensionGateway,
  type GovernedCreativeExtensionRoute,
  type GovernedCreativeExtensionSource,
  type GovernedExtensionGatewayRequest,
  type GovernedExtensionGatewayResult,
} from "./governed-creative-extensions-runtime";

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0025_governed_creative_extensions.sql"),
].join("\n");

const NOW = "2026-07-28T10:00:00.000Z";
const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const SOURCE_CHECKSUM = "a".repeat(64);
const SOURCE_TEXT = "雨落在青石路上。\n\n林青云抬头，看见远处的灯。";

afterEach(() => {
  vi.useRealTimers();
});

describe("GovernedCreativeExtensionsRuntime", () => {
  it("defaults both provider flags off while keeping history and export readable", async () => {
    const gateway = new DeterministicGateway(validTranslationResult);
    const harness = await createHarness({ gateway });
    const preflight = await harness.runtime.preflight(translationDraft());

    expect(preflight.ready).toBe(false);
    expect(preflight.checks).toContainEqual(
      expect.objectContaining({ code: "EXTENSION_FEATURE_DISABLED", level: "blocking" }),
    );
    await expect(harness.runtime.run(preflight)).rejects.toMatchObject({
      code: "EXTENSION_FEATURE_DISABLED",
    });
    expect(gateway.calls).toBe(0);
    await expect(harness.runtime.listHistory(PROJECT_ID)).resolves.toEqual({
      requests: [],
      candidates: [],
    });
    const exported = await harness.runtime.exportHistory(PROJECT_ID);
    expect(exported.content).toContain('"costSemantics": "internal_estimate"');
  });

  it("requires an explicit exact remote confirmation, publishes only a candidate, then accepts a derivative", async () => {
    const gateway = new DeterministicGateway(validTranslationResult);
    const harness = await createHarness({
      gateway,
      flags: { translation: true, shortDrama: false },
      route: remoteRoute(),
    });
    const preflight = await harness.runtime.preflight(translationDraft());

    expect(preflight.ready).toBe(true);
    expect(preflight.requiresRemoteConsent).toBe(true);
    expect(preflight.destination).toMatchObject({
      location: "remote",
      baseUrl: "https://provider.example/v1",
      modelId: "translation-v1",
    });
    await expect(harness.runtime.run(preflight)).rejects.toMatchObject({
      code: "EXTENSION_CONSENT_REQUIRED",
    });
    expect(gateway.calls).toBe(0);

    const consent = await harness.runtime.confirmRemoteEgress(preflight);
    expect(
      JSON.stringify(
        harness.executor.database.prepare("SELECT * FROM governed_extension_egress_receipts").all(),
      ),
    ).not.toContain(consent.token);

    const result = await harness.runtime.run(preflight, { consentToken: consent.token });
    expect(result).toMatchObject({
      replayed: false,
      request: {
        status: "candidate_ready",
        usage: {
          source: "provider_reported",
          inputTokens: 300,
          outputTokens: 450,
        },
      },
      candidate: { status: "ready", kind: "translation" },
    });
    expect(gateway.calls).toBe(1);
    expect(
      harness.executor.database.prepare("SELECT count(*) AS count FROM chapter_translations").get(),
    ).toEqual({ count: 0 });
    expect(
      harness.executor.database
        .prepare("SELECT content FROM chapters WHERE id = ?")
        .get(CHAPTER_ID),
    ).toEqual({ content: SOURCE_TEXT });

    const accepted = await harness.runtime.acceptCandidate(
      result.candidate?.id ?? "",
      result.candidate?.revision ?? 0,
    );
    expect(accepted.outcome).toBe("accepted");
    expect(
      harness.executor.database.prepare("SELECT count(*) AS count FROM chapter_translations").get(),
    ).toEqual({ count: 1 });
    expect(
      harness.executor.database
        .prepare("SELECT content FROM chapters WHERE id = ?")
        .get(CHAPTER_ID),
    ).toEqual({ content: SOURCE_TEXT });
  });

  it("fails closed when token usage is missing and prepares a new billed retry", async () => {
    const gateway = new DeterministicGateway(async (request) => {
      const valid = await validTranslationResult(request);
      return { serializedCandidate: valid.serializedCandidate };
    });
    const harness = await createHarness({
      gateway,
      flags: { translation: true, shortDrama: false },
    });
    const preflight = await harness.runtime.preflight(translationDraft());

    await expect(harness.runtime.run(preflight)).rejects.toMatchObject({
      code: "EXTENSION_USAGE_UNAVAILABLE",
    });
    const history = await harness.runtime.listHistory(PROJECT_ID, "translation");
    expect(history.requests).toHaveLength(1);
    expect(history.requests[0]).toMatchObject({
      status: "failed_final",
      errorCode: "EXTENSION_USAGE_UNAVAILABLE",
      usage: {
        source: "provider_unavailable",
        calculatedCostMicros: preflight.estimate.maximumCostMicros,
      },
    });
    expect(history.candidates).toHaveLength(0);

    const retry = await harness.runtime.prepareRetry(history.requests[0]?.id ?? "");
    expect(retry.retry).toEqual({
      previousRequestId: history.requests[0]?.id,
      attempt: 2,
    });
    expect(retry.checks).toContainEqual(
      expect.objectContaining({ code: "EXTENSION_RETRY_NEW_CHARGE" }),
    );
    expect(retry.estimate.semantics).toBe("internal_estimate");
  });

  it("lets cancellation win against a late gateway completion without publishing a candidate", async () => {
    let release: ((value: GovernedExtensionGatewayResult) => void) | undefined;
    const gateway: GovernedCreativeExtensionGateway = {
      generate: vi.fn(
        () =>
          new Promise<GovernedExtensionGatewayResult>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const harness = await createHarness({
      gateway,
      flags: { translation: true, shortDrama: false },
    });
    const preflight = await harness.runtime.preflight(translationDraft());
    let notifyStarted: ((requestId: string) => void) | undefined;
    const started = new Promise<string>((resolve) => {
      notifyStarted = resolve;
    });
    const running = harness.runtime.run(preflight, {
      onRequestStarted: (request) => notifyStarted?.(request.id),
    });
    const requestId = await started;

    const cancelled = await harness.runtime.cancel(requestId);
    expect(cancelled.status).toBe("cancelled");
    release?.(await validTranslationResult(gatewayRequestFrom(preflight)));
    await expect(running).resolves.toMatchObject({
      request: {
        status: "cancelled",
        candidateId: null,
        usage: {
          source: "provider_unavailable",
          calculatedCostMicros: preflight.estimate.maximumCostMicros,
        },
      },
      candidate: null,
    });
    const history = await harness.runtime.listHistory(PROJECT_ID);
    expect(history.candidates).toHaveLength(0);
  });

  it("enforces the attempt timeout and releases the persisted reservation", async () => {
    vi.useFakeTimers();
    const gateway: GovernedCreativeExtensionGateway = {
      generate: vi.fn(() => new Promise<GovernedExtensionGatewayResult>(() => undefined)),
    };
    const harness = await createHarness({
      gateway,
      flags: { translation: true, shortDrama: false },
      route: { ...localRoute(), limits: { ...localRoute().limits, timeoutMs: 1_000 } },
    });
    const preflight = await harness.runtime.preflight(translationDraft());
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const running = harness.runtime.run(preflight, {
      onRequestStarted: () => notifyStarted?.(),
    });
    const timeoutAssertion = expect(running).rejects.toMatchObject({
      code: "EXTENSION_PROVIDER_TIMEOUT",
    });
    await started;
    await vi.advanceTimersByTimeAsync(1_001);

    await timeoutAssertion;
    const history = await harness.runtime.listHistory(PROJECT_ID);
    expect(history.requests[0]).toMatchObject({
      status: "failed_retryable",
      errorCode: "EXTENSION_PROVIDER_TIMEOUT",
    });
    expect(
      harness.executor.database
        .prepare(
          "SELECT reserved_micros, active_requests, spent_micros FROM governed_extension_budgets WHERE project_id = ?",
        )
        .get(PROJECT_ID),
    ).toEqual({
      reserved_micros: 0,
      active_requests: 0,
      spent_micros: preflight.estimate.maximumCostMicros,
    });
  });

  it("rejects a structurally valid response that cites a different authority", async () => {
    const gateway = new DeterministicGateway(async (request) => {
      const result = await validTranslationResult(request);
      const payload = JSON.parse(result.serializedCandidate) as Record<string, unknown>;
      payload.source = {
        chapterId: CHAPTER_ID,
        sourceVersionId: uuid(999),
        sourceChecksum: SOURCE_CHECKSUM,
      };
      return { ...result, serializedCandidate: JSON.stringify(payload) };
    });
    const harness = await createHarness({
      gateway,
      flags: { translation: true, shortDrama: false },
    });
    const preflight = await harness.runtime.preflight(translationDraft());

    await expect(harness.runtime.run(preflight)).rejects.toBeInstanceOf(
      GovernedCreativeExtensionRuntimeError,
    );
    const history = await harness.runtime.listHistory(PROJECT_ID);
    expect(history.requests[0]).toMatchObject({
      status: "failed_retryable",
      errorCode: "EXTENSION_RESPONSE_AUTHORITY_MISMATCH",
    });
    expect(history.candidates).toHaveLength(0);
  });

  it("validates short-drama source ranges and accepts only an independent script artifact", async () => {
    const gateway = new DeterministicGateway(validShortDramaResult);
    const harness = await createHarness({
      gateway,
      flags: { translation: false, shortDrama: true },
    });
    const preflight = await harness.runtime.preflight(shortDramaDraft());
    const result = await harness.runtime.run(preflight);

    expect(result).toMatchObject({
      request: { status: "candidate_ready", kind: "short_drama" },
      candidate: { status: "ready", kind: "short_drama" },
    });
    expect(
      harness.executor.database.prepare("SELECT count(*) AS count FROM short_drama_scripts").get(),
    ).toEqual({ count: 0 });
    await harness.runtime.acceptCandidate(
      result.candidate?.id ?? "",
      result.candidate?.revision ?? 0,
    );
    expect(
      harness.executor.database.prepare("SELECT title FROM short_drama_scripts").get(),
    ).toEqual({ title: "Rain at Night" });
    expect(
      harness.executor.database
        .prepare("SELECT content FROM chapters WHERE id = ?")
        .get(CHAPTER_ID),
    ).toEqual({ content: SOURCE_TEXT });
  });
});

class DeterministicGateway implements GovernedCreativeExtensionGateway {
  public calls = 0;

  public constructor(
    private readonly result: (
      request: GovernedExtensionGatewayRequest,
    ) => Promise<GovernedExtensionGatewayResult>,
  ) {}

  public generate(
    request: GovernedExtensionGatewayRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<GovernedExtensionGatewayResult> {
    void options;
    this.calls += 1;
    return this.result(request);
  }
}

class FixedClock implements Clock {
  public now(): IsoUtcTimestamp {
    return NOW as IsoUtcTimestamp;
  }
}

class SequentialIds implements UuidV7Generator {
  private counter = 100;

  public next(): UuidV7 {
    this.counter += 1;
    return uuid(this.counter) as UuidV7;
  }
}

async function createHarness(options: {
  readonly gateway: GovernedCreativeExtensionGateway;
  readonly flags?: GovernedCreativeExtensionFlags;
  readonly route?: GovernedCreativeExtensionRoute;
}) {
  const executor = new NodeSqliteExecutor(migration);
  seedAuthorities(executor);
  const clock = new FixedClock();
  const store = new GovernedCreativeExtensionSqliteStore(executor, clock);
  await store.configureBudget({
    projectId: PROJECT_ID,
    monthKey: "2026-07",
    currency: "USD",
    limitMicros: 10_000_000,
    maximumConcurrent: 2,
  });
  const route = options.route ?? localRoute();
  const flags = options.flags;
  const runtime = new GovernedCreativeExtensionsRuntime({
    store,
    gateway: options.gateway,
    ids: new SequentialIds(),
    clock,
    resolveRoute: () => route,
    readEnvironment: () => ({ online: true, readOnly: false }),
    ...(flags === undefined ? {} : { readFeatureFlags: () => flags }),
  });
  return { executor, runtime, store };
}

function translationDraft() {
  return {
    kind: "translation",
    source: sourceAuthority(),
    settings: {
      targetLanguage: { code: "en-US", label: "English (US)" },
      tone: "literary",
      glossaryVersion: "glossary-v1",
      glossary: [{ source: "青石路", target: "bluestone road", note: null }],
    },
  } as const;
}

function shortDramaDraft() {
  return {
    kind: "short_drama",
    source: sourceAuthority(),
    settings: {
      format: "vertical_micro_drama",
      targetEpisodeCount: 1,
      targetEpisodeDurationSeconds: 90,
      tone: "suspense",
    },
  } as const;
}

function sourceAuthority(): GovernedCreativeExtensionSource {
  return {
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    sourceVersionId: VERSION_ID,
    sourceChecksum: SOURCE_CHECKSUM,
    chapterTitle: "雨夜",
    sourceText: SOURCE_TEXT,
  };
}

function localRoute(): GovernedCreativeExtensionRoute {
  return {
    location: "loopback",
    providerId: "local-test",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "translation-v1",
    pricing: {
      inputMicrosPerMillionTokens: 10_000,
      outputMicrosPerMillionTokens: 20_000,
      currency: "USD",
      priceVersion: "internal-price-2026-07",
      priceUpdatedAt: NOW,
    },
    limits: {
      maximumInputTokens: 4_000,
      maximumOutputTokens: 4_000,
      timeoutMs: 30_000,
    },
  };
}

function remoteRoute(): GovernedCreativeExtensionRoute {
  return {
    ...localRoute(),
    location: "remote",
    providerId: "remote-test",
    baseUrl: "https://provider.example/v1",
  };
}

function validTranslationResult(
  request: GovernedExtensionGatewayRequest,
): Promise<GovernedExtensionGatewayResult> {
  const snapshot = request.snapshot;
  if (snapshot.kind !== "translation") {
    throw new Error("translation test gateway received the wrong kind");
  }
  return Promise.resolve({
    serializedCandidate: JSON.stringify({
      schemaVersion: 1,
      kind: "translation",
      source: {
        chapterId: snapshot.chapterId,
        sourceVersionId: snapshot.sourceVersionId,
        sourceChecksum: snapshot.sourceChecksum,
      },
      targetLanguage: snapshot.settings.targetLanguage,
      tone: snapshot.settings.tone,
      glossaryVersion: snapshot.settings.glossaryVersion,
      paragraphs: request.paragraphAuthorities.map((paragraph) => ({
        sourceParagraph: paragraph.index,
        sourceChecksum: paragraph.checksum,
        translatedText:
          paragraph.index === 0
            ? "Rain fell on the bluestone road."
            : "Lin Qingyun looked up and saw a distant light.",
        glossaryTerms: paragraph.index === 0 ? ["青石路"] : [],
      })),
    }),
    usage: {
      inputTokens: 300,
      outputTokens: 450,
      cachedInputTokens: 0,
      providerReceipt: "provider-receipt-that-is-digested",
    },
  });
}

async function validShortDramaResult(
  request: GovernedExtensionGatewayRequest,
): Promise<GovernedExtensionGatewayResult> {
  const snapshot = request.snapshot;
  if (snapshot.kind !== "short_drama") {
    throw new Error("short-drama test gateway received the wrong kind");
  }
  const rangeChecksum = await digest(
    request.paragraphAuthorities.map(({ text }) => text).join("\n\n"),
  );
  return {
    serializedCandidate: JSON.stringify({
      schemaVersion: 1,
      kind: "short_drama",
      source: {
        chapterId: snapshot.chapterId,
        sourceVersionId: snapshot.sourceVersionId,
        sourceChecksum: snapshot.sourceChecksum,
      },
      title: "Rain at Night",
      format: snapshot.settings.format,
      episodes: [
        {
          number: 1,
          title: "The Distant Light",
          durationSeconds: 90,
          scenes: [
            {
              number: 1,
              slugline: "EXT. BLUESTONE ROAD - NIGHT",
              location: "Bluestone Road",
              timeOfDay: "Night",
              durationSeconds: 90,
              characters: ["Lin Qingyun"],
              sourceReferences: [
                {
                  paragraphStart: 0,
                  paragraphEnd: request.paragraphAuthorities.length - 1,
                  sourceChecksum: rangeChecksum,
                },
              ],
              shots: [
                {
                  number: 1,
                  shotType: "medium",
                  action: "Rain falls as Lin Qingyun looks toward a distant light.",
                  durationSeconds: 90,
                  dialogue: [
                    {
                      character: "Lin Qingyun",
                      line: "Who is there?",
                      stageDirection: null,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
    usage: {
      inputTokens: 320,
      outputTokens: 700,
      cachedInputTokens: null,
    },
  };
}

function gatewayRequestFrom(
  preflight: Awaited<ReturnType<GovernedCreativeExtensionsRuntime["preflight"]>>,
): GovernedExtensionGatewayRequest {
  return {
    snapshot: preflight.snapshot,
    requestFingerprint: preflight.requestFingerprint,
    paragraphAuthorities: preflight.paragraphAuthorities,
    rangeChecksumAlgorithm: "sha256-utf8-double-newline-v1",
  };
}

function seedAuthorities(executor: NodeSqliteExecutor): void {
  executor.database.exec("BEGIN IMMEDIATE");
  executor.database
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(PROJECT_ID, "InkShadow 测试项目", NOW, NOW);
  executor.database
    .prepare(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id,
         created_at, updated_at, trashed_at
       ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)`,
    )
    .run(CHAPTER_ID, PROJECT_ID, "雨夜", SOURCE_TEXT, VERSION_ID, NOW, NOW);
  executor.database
    .prepare(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
    )
    .run(VERSION_ID, PROJECT_ID, CHAPTER_ID, SOURCE_TEXT, SOURCE_CHECKSUM, NOW);
  executor.database.exec("COMMIT");
}

function uuid(seed: number): string {
  return `019fa025-0000-7${seed.toString(16).padStart(3, "0").slice(-3)}-8000-${seed
    .toString(16)
    .padStart(12, "0")
    .slice(-12)}`;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
