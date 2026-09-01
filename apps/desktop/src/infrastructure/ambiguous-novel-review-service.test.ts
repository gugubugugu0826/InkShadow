import type { UuidV7 } from "@inkshadow/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AmbiguousNovelReviewService,
  parseAmbiguousNovelReviewResponse,
  type AmbiguousNovelReviewEvidence,
  type AmbiguousNovelReviewTask,
} from "./ambiguous-novel-review-service";
import {
  CharacterVoicePovEvidenceAdapter,
  type CharacterVoicePovEvidencePreparation,
} from "./character-voice-pov-evidence-adapter";
import type { ModelHubStore } from "./model-hub-store";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";

const CONTENT = "林遥知道密门密码。林遥不知道密门密码。林遥说我绝不会迟到。林遥说我一定准时到。";

describe("AmbiguousNovelReviewService", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("routes fuzzy and content-quality reviews through Model Hub, records metadata-only invocations, and never mutates the chapter", async () => {
    const fixture = await seedEvidenceFixture();
    const fakeCharacterEvidence = characterPreparation(fixture);
    const harness = createHarness(fixture.runtime, fakeCharacterEvidence);
    await seedRoutes(fixture.runtime.modelHub, [
      "contradiction_check",
      "pov_check",
      "character_voice_check",
      "content_quality_check",
    ]);
    harness.generate.mockImplementation((input) => {
      const payload = JSON.parse(input.messages[1]?.content ?? "{}") as {
        task: AmbiguousNovelReviewTask;
        allowedEvidence: AmbiguousNovelReviewEvidence[];
      };
      const roles = requiredRoles(payload.task);
      const evidenceIds = roles.map(
        (role) =>
          payload.allowedEvidence.find((evidence) => evidence.role === role)?.id ?? "missing",
      );
      return Promise.resolve({
        text: JSON.stringify({
          schemaVersion: 1,
          findings: [
            {
              kind: findingKind(payload.task),
              severity: "warning",
              title: `${payload.task} 需要判断`,
              explanation: "两条精确证据之间存在需要作者判断的语义差异。",
              suggestion: "请对照证据后决定保留哪一种表达。",
              evidenceIds,
            },
          ],
        }),
        usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 0 },
      });
    });
    const startInvocation = vi.spyOn(fixture.runtime.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(fixture.runtime.modelHub, "finishInvocation");
    const before = unwrap(
      await fixture.runtime.repositories.chapters.findById(fixture.chapterId),
    )?.toSnapshot();

    const result = await harness.service.review({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
      expectedChapterVersionId: fixture.chapterVersionId,
    });

    expect(result.status).toBe("reviewed");
    expect(result.findings).toHaveLength(4);
    expect(result.tasks.map(({ task, status }) => [task, status])).toEqual([
      ["contradiction_check", "reviewed"],
      ["pov_check", "reviewed"],
      ["character_voice_check", "reviewed"],
      ["content_quality_check", "reviewed"],
    ]);
    expect(result.findings.map(({ requiresHumanReview }) => requiresHumanReview)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(harness.generate).toHaveBeenCalledTimes(4);
    expect(startInvocation.mock.calls.map(([input]) => input.task).sort()).toEqual([
      "character_voice_check",
      "content_quality_check",
      "contradiction_check",
      "pov_check",
    ]);
    expect(finishInvocation).toHaveBeenCalledTimes(4);
    expect(finishInvocation.mock.calls.every(([input]) => input.status === "succeeded")).toBe(true);
    expect(JSON.stringify(startInvocation.mock.calls)).not.toContain(CONTENT);
    const qualityCall = harness.generate.mock.calls.find(([input]) => {
      const payload = JSON.parse(input.messages[1]?.content ?? "{}") as { task?: string };
      return payload.task === "content_quality_check";
    });
    const qualityPrompt = JSON.parse(qualityCall?.[0].messages[1]?.content ?? "{}") as {
      analysisContext?: { reviewAreas?: string[] };
    };
    expect(qualityPrompt.analysisContext?.reviewAreas).toEqual(
      expect.arrayContaining([
        "scene_goal_and_causality",
        "pacing_and_tension_change",
        "dialogue_description_interiority_balance",
        "repeated_function_scenes",
        "climax_setup",
        "chapter_goal_completion",
      ]),
    );
    const after = unwrap(
      await fixture.runtime.repositories.chapters.findById(fixture.chapterId),
    )?.toSnapshot();
    expect(after).toEqual(before);
  });

  it("skips before invocation when structured-output capability evidence is missing", async () => {
    const fixture = await seedEvidenceFixture();
    const harness = createHarness(fixture.runtime, characterPreparation(fixture));
    await seedRoutes(fixture.runtime.modelHub, ["contradiction_check"], false);
    const startInvocation = vi.spyOn(fixture.runtime.modelHub, "startInvocation");

    const result = await harness.service.review({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
      expectedChapterVersionId: fixture.chapterVersionId,
    });

    expect(result.tasks.find(({ task }) => task === "contradiction_check")).toMatchObject({
      status: "skipped",
      code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      invocation: null,
    });
    expect(harness.generate).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
  });

  it("skips quality review without dispatch when privacy metadata is unavailable", async () => {
    const fixture = await seedEvidenceFixture();
    const harness = createHarness(fixture.runtime, characterPreparation(fixture));
    await seedRoutes(fixture.runtime.modelHub, ["content_quality_check"]);
    const profile = await fixture.runtime.modelHub.findCostPrivacyProfile(
      "ambiguous-review-catalog",
    );
    if (profile === null) {
      throw new Error("Expected a quality-review privacy profile.");
    }
    await fixture.runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: profile.catalogEntryId,
      dataDestination: "unknown",
      retentionPolicy: "unknown",
      trainingPolicy: "unknown",
      evidenceSource: "unknown",
      expectedRevision: profile.revision,
    });
    const startInvocation = vi.spyOn(fixture.runtime.modelHub, "startInvocation");

    const result = await harness.service.review({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
    });

    expect(result.tasks.find(({ task }) => task === "content_quality_check")).toMatchObject({
      status: "skipped",
      code: "MODEL_HUB_DATA_DESTINATION_UNKNOWN",
      invocation: null,
    });
    expect(harness.generate).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
  });

  it("keeps every remote review task at zero sends after the chapter becomes private", async () => {
    const fixture = await seedEvidenceFixture();
    const chapter = unwrap(await fixture.runtime.repositories.chapters.findById(fixture.chapterId));
    if (chapter === null) throw new Error("Expected the review chapter.");
    unwrap(
      await fixture.runtime.useCases.setChapterPrivacy.execute({
        chapterId: chapter.id,
        privacyMode: "local_only",
        expectedPrivacyRevision: chapter.privacyRevision,
      }),
    );
    const harness = createHarness(fixture.runtime, characterPreparation(fixture));
    await seedRoutes(fixture.runtime.modelHub, [
      "contradiction_check",
      "pov_check",
      "character_voice_check",
      "content_quality_check",
    ]);
    const startInvocation = vi.spyOn(fixture.runtime.modelHub, "startInvocation");

    const result = await harness.service.review({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
      expectedChapterVersionId: fixture.chapterVersionId,
    });

    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.every(({ status }) => status === "skipped")).toBe(true);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
  });

  it("rejects invalid provider JSON after recording the real invocation", async () => {
    const fixture = await seedEvidenceFixture();
    const harness = createHarness(fixture.runtime, characterPreparation(fixture));
    await seedRoutes(fixture.runtime.modelHub, ["contradiction_check"]);
    harness.generate.mockResolvedValue({
      text: '```json\n{"schemaVersion":1,"findings":[]}\n```',
      usage: null,
    });
    const finishInvocation = vi.spyOn(fixture.runtime.modelHub, "finishInvocation");

    const result = await harness.service.review({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
    });
    const contradiction = result.tasks.find(({ task }) => task === "contradiction_check");

    expect(contradiction).toMatchObject({
      status: "failed",
      code: "AMBIGUOUS_REVIEW_RESPONSE_INVALID",
    });
    expect(contradiction?.invocation).not.toBeNull();
    expect(finishInvocation.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "failed",
      errorCode: "AMBIGUOUS_REVIEW_RESPONSE_INVALID",
      failure: { stage: "response_normalization" },
    });
  });

  it("skips every model task when exact confirmed evidence is absent", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = unwrap(await runtime.useCases.createProject.execute({ name: "无证据项目" }));
    const chapter = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "第一章",
        content: "只有正文，没有已确认故事事实。",
      }),
    );
    const harness = createHarness(runtime);
    const startInvocation = vi.spyOn(runtime.modelHub, "startInvocation");

    const result = await harness.service.review({
      projectId: project.id,
      chapterId: chapter.chapter.id,
    });

    expect(result.status).toBe("skipped");
    expect(result.tasks.every(({ status }) => status === "skipped")).toBe(true);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
  });

  it("discards a returned quality suggestion when the route fingerprint changes after dispatch", async () => {
    const fixture = await seedEvidenceFixture();
    const harness = createHarness(fixture.runtime, characterPreparation(fixture));
    await seedRoutes(fixture.runtime.modelHub, ["content_quality_check"]);
    harness.generate.mockImplementation(async (input) => {
      const route = await fixture.runtime.modelHub.findTaskRoute("content_quality_check");
      if (route === null) {
        throw new Error("Expected a quality-review route.");
      }
      await fixture.runtime.modelHub.saveTaskRoute({
        task: route.task,
        primaryCatalogEntryId: route.primaryCatalogEntryId,
        fallbackCatalogEntryId: route.fallbackCatalogEntryId,
        presetId: route.presetId,
        parameterPolicy: { ...route.parameterPolicy, postDispatchChange: true },
        maximumCostMicros: route.maximumCostMicros,
        currency: route.currency,
        privacyPolicy: route.privacyPolicy,
        failurePolicy: route.failurePolicy,
        routeOrigin: route.routeOrigin,
        enabled: route.enabled,
        expectedRevision: route.revision,
      });
      const payload = JSON.parse(input.messages[1]?.content ?? "{}") as {
        allowedEvidence: AmbiguousNovelReviewEvidence[];
      };
      const current = payload.allowedEvidence.find(({ role }) => role === "current_chapter");
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          findings: [
            {
              kind: "content_quality",
              severity: "warning",
              title: "高潮铺垫可能不足",
              explanation: "当前章节在冲突升级前的铺垫较少。",
              suggestion: "请由作者判断是否需要提前埋下阻力。",
              evidenceIds: [current?.id ?? "missing"],
            },
          ],
        }),
        usage: null,
      };
    });

    const result = await harness.service.review({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
      expectedChapterVersionId: fixture.chapterVersionId,
    });

    const quality = result.tasks.find(({ task }) => task === "content_quality_check");
    expect(quality).toMatchObject({
      status: "failed",
      code: "MODEL_HUB_PLAN_CHANGED_AFTER_RESPONSE",
      findings: [],
    });
    expect(quality?.invocation?.modelId).toBe("ambiguous-review-model");
  });

  it("discards a returned quality suggestion when verified story evidence changes after dispatch", async () => {
    const fixture = await seedEvidenceFixture();
    const harness = createHarness(fixture.runtime, characterPreparation(fixture));
    await seedRoutes(fixture.runtime.modelHub, ["content_quality_check"]);
    harness.generate.mockImplementation(async () => {
      const excerpt = "林遥不知道密门密码";
      const startOffset = CONTENT.indexOf(excerpt);
      unwrap(
        await fixture.runtime.story.factService.createFormalUserFact({
          projectId: fixture.projectId,
          factType: "narrative_analysis",
          contentText: "用户补充确认的章节目标资料。",
          structuredValue: {
            schemaVersion: "inkshadow.narrative-analysis-fact.v1",
            kind: "scene_metric",
            sceneId: "scene-late-update",
          },
          source: {
            kind: "chapter_span",
            reference: `chapter:${fixture.chapterId}:late-quality-evidence`,
            chapterId: fixture.chapterId,
            versionId: fixture.chapterVersionId,
            startOffset,
            endOffset: startOffset + excerpt.length,
            sourceLength: CONTENT.length,
            excerpt,
          },
          actorId: fixture.runtime.story.actorId,
          humanConfirmed: true,
        }),
      );
      return {
        text: JSON.stringify({ schemaVersion: 1, findings: [] }),
        usage: null,
      };
    });

    const result = await harness.service.review({
      projectId: fixture.projectId,
      chapterId: fixture.chapterId,
      expectedChapterVersionId: fixture.chapterVersionId,
    });

    const quality = result.tasks.find(({ task }) => task === "content_quality_check");
    expect(quality).toMatchObject({
      status: "failed",
      code: "AMBIGUOUS_REVIEW_EVIDENCE_CHANGED_AFTER_RESPONSE",
      findings: [],
    });
    expect(quality?.invocation?.modelId).toBe("ambiguous-review-model");
  });
});

describe("parseAmbiguousNovelReviewResponse", () => {
  const current = evidence("current", "current_chapter", null);
  const confirmed = evidence("confirmed", "confirmed_fact", "character.lin-yao");

  it("accepts only exact whitelisted evidence ids with both required evidence roles", () => {
    const parsed = parseAmbiguousNovelReviewResponse(
      JSON.stringify({
        schemaVersion: 1,
        findings: [
          {
            kind: "contradiction",
            severity: "warning",
            title: "可能存在语义冲突",
            explanation: "当前原文与已确认设定的含义可能不一致。",
            suggestion: "请由作者确认角色此时是否知情。",
            evidenceIds: [current.id, confirmed.id],
          },
        ],
      }),
      "contradiction_check",
      [current, confirmed],
      "invocation-one",
    );

    expect(parsed[0]).toMatchObject({
      id: "ai-review:contradiction_check:invocation-one:1",
      requiresHumanReview: true,
      evidence: [current, confirmed],
    });
  });

  it("rejects Markdown, unknown evidence, extra fields, and one-sided findings", () => {
    expect(() =>
      parseAmbiguousNovelReviewResponse(
        '```json\n{"schemaVersion":1,"findings":[]}\n```',
        "contradiction_check",
        [current, confirmed],
        "invocation",
      ),
    ).toThrow("模型返回了 Markdown 代码块；AI 复核只接受纯结构化数据。");
    expect(() =>
      parseAmbiguousNovelReviewResponse(
        findingResponse([current.id, "outside-evidence"]),
        "contradiction_check",
        [current, confirmed],
        "invocation",
      ),
    ).toThrow("白名单之外");
    expect(() =>
      parseAmbiguousNovelReviewResponse(
        JSON.stringify({ schemaVersion: 1, findings: [], summary: "extra" }),
        "contradiction_check",
        [current, confirmed],
        "invocation",
      ),
    ).toThrow("额外字段");
    expect(() =>
      parseAmbiguousNovelReviewResponse(
        findingResponse([current.id]),
        "contradiction_check",
        [current, confirmed],
        "invocation",
      ),
    ).toThrow("同时引用");
  });

  it("accepts a subjective quality suggestion only when it cites current immutable chapter evidence", () => {
    const parsed = parseAmbiguousNovelReviewResponse(
      JSON.stringify({
        schemaVersion: 1,
        findings: [
          {
            kind: "content_quality",
            severity: "warning",
            title: "场景目标可能不够清晰",
            explanation: "当前段落的行动没有显式改变剧情或人物状态。",
            suggestion: "请由作者判断是否补强场景目标或结果。",
            evidenceIds: [current.id],
          },
        ],
      }),
      "content_quality_check",
      [current, confirmed],
      "quality-invocation",
    );

    expect(parsed[0]).toMatchObject({
      id: "ai-review:content_quality_check:quality-invocation:1",
      kind: "content_quality",
      requiresHumanReview: true,
      evidence: [current],
    });
    expect(() =>
      parseAmbiguousNovelReviewResponse(
        JSON.stringify({
          schemaVersion: 1,
          findings: [
            {
              kind: "content_quality",
              severity: "warning",
              title: "场景目标可能不够清晰",
              explanation: "缺少当前章节证据。",
              suggestion: "请人工判断。",
              evidenceIds: [confirmed.id],
            },
          ],
        }),
        "content_quality_check",
        [current, confirmed],
        "quality-invocation",
      ),
    ).toThrow("当前章节");
  });
});

interface EvidenceFixture {
  readonly runtime: DesktopRuntime;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly chapterVersionId: UuidV7;
  readonly contentHash: string;
  readonly factIds: Readonly<{
    readonly contradiction: string;
    readonly povCurrent: string;
    readonly povReference: string;
    readonly voiceCurrent: string;
    readonly voiceHistorical: string;
    readonly quality: string;
  }>;
}

async function seedEvidenceFixture(): Promise<EvidenceFixture> {
  const runtime = createDevelopmentRuntime(window.localStorage);
  const project = unwrap(await runtime.useCases.createProject.execute({ name: "AI 复核测试" }));
  const created = unwrap(
    await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第一章",
      content: CONTENT,
    }),
  );
  const chapter = created.chapter.toSnapshot();
  const contentHash = String(unwrap(await runtime.hasher.sha256(chapter.content)));
  const createFact = async (
    label: string,
    excerpt: string,
    subjectId: string,
    factType = "review_evidence",
  ): Promise<string> => {
    const startOffset = CONTENT.indexOf(excerpt);
    const fact = unwrap(
      await runtime.story.factService.createFormalUserFact({
        projectId: project.id,
        factType,
        contentText: `${label}：${excerpt}`,
        structuredValue: { label, subjectId },
        source: {
          kind: "chapter_span",
          reference: `chapter:${chapter.id}:${label}`,
          chapterId: chapter.id,
          versionId: chapter.currentVersionId,
          startOffset,
          endOffset: startOffset + excerpt.length,
          sourceLength: CONTENT.length,
          excerpt,
        },
        actorId: runtime.story.actorId,
        humanConfirmed: true,
      }),
    );
    return fact.id;
  };
  const factIds = {
    contradiction: await createFact("contradiction", "林遥知道密门密码", "character.lin-yao"),
    povCurrent: await createFact("pov-current", "林遥不知道密门密码", "character.lin-yao"),
    povReference: await createFact("pov-reference", "林遥知道密门密码", "character.lin-yao"),
    voiceHistorical: await createFact("voice-history", "林遥说我绝不会迟到", "character.lin-yao"),
    voiceCurrent: await createFact("voice-current", "林遥说我一定准时到", "character.lin-yao"),
    quality: await createFact(
      "quality-goal",
      "林遥知道密门密码",
      "chapter.goal",
      "narrative_analysis",
    ),
  };
  return Object.freeze({
    runtime,
    projectId: project.id,
    chapterId: chapter.id,
    chapterVersionId: chapter.currentVersionId,
    contentHash,
    factIds: Object.freeze(factIds),
  });
}

function characterPreparation(fixture: EvidenceFixture) {
  const preparation = {
    status: "ready",
    projectId: fixture.projectId,
    chapterId: fixture.chapterId,
    chapterVersionId: fixture.chapterVersionId,
    chapterRevision: 0,
    currentContentHash: fixture.contentHash,
    voiceChecks: [
      {
        status: "ready",
        characterId: "character.lin-yao",
        profile: { kind: "evidence_backed_character_voice_profile" },
        input: { currentDialogue: [{ id: "current-dialogue" }] },
        sourceFactIds: {
          featureCatalog: fixture.factIds.voiceHistorical,
          historicalDialogue: [fixture.factIds.voiceHistorical],
          currentDialogue: [fixture.factIds.voiceCurrent],
        },
      },
    ],
    povCheck: {
      status: "ready",
      input: { currentClaims: [], referenceFacts: [], hardRules: [] },
      sourceFactIds: {
        currentClaims: [fixture.factIds.povCurrent],
        confirmedKnowledge: [fixture.factIds.povReference],
      },
    },
    diagnostics: [],
    missingRequirements: [],
    ignoredUnrelatedFactCount: 0,
    capabilities: {
      evidenceVerification: "immutable_chapter_version_sha256",
      authorityGate: "user_confirmed_formal_only",
      speakerInference: "disabled",
      freeTextFactInference: "disabled",
      modelInvocation: "not_used",
    },
  } as unknown as CharacterVoicePovEvidencePreparation;
  return Object.freeze({ prepare: vi.fn().mockResolvedValue(preparation) });
}

function createHarness(
  runtime: DesktopRuntime,
  characterEvidence: Pick<
    CharacterVoicePovEvidenceAdapter,
    "prepare"
  > = new CharacterVoicePovEvidenceAdapter({
    chapters: runtime.repositories.chapters,
    chapterVersions: runtime.repositories.chapterVersions,
    storyFacts: runtime.story.facts,
    hasher: runtime.hasher,
  }),
) {
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const modelGateway: Pick<NativeModelGatewayClient, "available" | "generate"> = {
    available: true,
    generate,
  };
  return Object.freeze({
    generate,
    service: new AmbiguousNovelReviewService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      storyFacts: runtime.story.facts,
      hasher: runtime.hasher,
      characterEvidence,
      projectContextPrivacy: runtime.projectContextPrivacy,
      modelHub: {
        modelHub: runtime.modelHub,
        modelGateway,
        credentials: { getSummary: () => Promise.resolve({ configured: true }) },
        clock: runtime.clock,
        ids: runtime.ids,
      },
    }),
  });
}

async function seedRoutes(
  modelHub: ModelHubStore,
  tasks: readonly AmbiguousNovelReviewTask[],
  includeStructuredOutput = true,
): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: "ambiguous-review-connection",
    providerKind: "google_gemini",
    displayName: "Ambiguous review connection",
    credentialRef: "keyring:model-hub:ambiguous-review",
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
    syncId: "ambiguous-review-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "ambiguous-review-catalog",
        providerModelId: "ambiguous-review-model",
        lifecycle: "stable",
        inputTokenLimit: 500_000,
        outputTokenLimit: 20_000,
        staleAfter: "2030-01-01T00:00:00.000Z",
      },
    ],
  });
  await modelHub.recordCapabilityScan({
    scanId: "ambiguous-review-scan",
    catalogEntryId: "ambiguous-review-catalog",
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "ambiguous-review-test-v1",
    evidence: [
      {
        id: "ambiguous-review-text",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
      ...(includeStructuredOutput
        ? [
            {
              id: "ambiguous-review-structured",
              capability: "structured_output" as const,
              verdict: "supported" as const,
              evidenceSource: "lightweight_probe" as const,
            },
          ]
        : []),
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: "ambiguous-review-catalog",
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "zero-cost-v1",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "ambiguous-review-test-v1",
    expectedRevision: null,
  });
  for (const task of tasks) {
    await modelHub.saveTaskRoute({
      task,
      primaryCatalogEntryId: "ambiguous-review-catalog",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
  }
}

function requiredRoles(
  task: AmbiguousNovelReviewTask,
): readonly AmbiguousNovelReviewEvidence["role"][] {
  return task === "contradiction_check"
    ? ["current_chapter", "confirmed_fact"]
    : task === "pov_check"
      ? ["current_pov_claim", "confirmed_knowledge"]
      : task === "character_voice_check"
        ? ["current_dialogue", "historical_dialogue"]
        : ["current_chapter"];
}

function findingKind(task: AmbiguousNovelReviewTask) {
  return task === "contradiction_check"
    ? "contradiction"
    : task === "pov_check"
      ? "pov_boundary"
      : task === "character_voice_check"
        ? "character_voice"
        : "content_quality";
}

function evidence(
  id: string,
  role: AmbiguousNovelReviewEvidence["role"],
  subjectId: string | null,
): AmbiguousNovelReviewEvidence {
  return Object.freeze({
    id,
    role,
    sourceFactId: id,
    subjectId,
    statement: id,
    chapterId: "chapter",
    chapterVersionId: "version",
    contentHash: "hash",
    locator: `${id}:0-4`,
    excerpt: id,
    startOffset: 0,
    endOffset: id.length,
    sourceLength: id.length,
  });
}

function findingResponse(evidenceIds: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    findings: [
      {
        kind: "contradiction",
        severity: "warning",
        title: "可能存在语义冲突",
        explanation: "两条内容可能不一致。",
        suggestion: "请人工确认。",
        evidenceIds,
      },
    ],
  });
}

function unwrap<Value>(
  result:
    | Readonly<{ readonly ok: true; readonly value: Value }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}
