import {
  MAX_NOVEL_SKILLS_PER_INVOCATION,
  NOVEL_SKILL_COMPILER_VERSION,
  isFixedNovelSkillEvaluationConfiguration,
  listNovelSkillEvaluationFixtures,
  type NovelSkillEvaluationArm,
  type NovelSkillEvaluationFixture,
} from "@inkshadow/ai-core";
import { describe, expect, it } from "vitest";

import {
  compileNovelSkillPaidEvaluationPayload,
  createNovelSkillPaidEvaluationContextBaselineProjection,
  createNovelSkillPaidEvaluationPreferenceProjection,
  createNovelSkillPaidEvaluationPromptTemplateProjection,
  hashNovelSkillPaidEvaluationAuthorityManifest,
  resolveNovelSkillPaidEvaluationArmConfigurationHash,
  validateNovelSkillPaidEvaluationPayloadAuthority,
  type CompileNovelSkillPaidEvaluationPayloadInput,
  type NovelSkillPaidEvaluationAuthoritativePayload,
} from "./novel-skill-paid-evaluation-payload-authority";
import type { ContextCompilationTrace } from "./context-compilation-trace-store";
import { hashModelHubExactEvaluationMessages } from "./model-hub-exact-evaluation-target";
import { hashNovelSkillEvaluationPreferenceConfiguration } from "./novel-skill-evaluation-sqlite-store";
import { hashNovelSkillPaidEvaluationTraceBaseline } from "./novel-skill-paid-evaluation-sqlite-store";

const RUN_ID = "019f9f4a-b3c7-7350-8000-000000000001";
const SUITE_ID = "019f9f4a-b3c7-7350-8000-000000000002";
const BASELINE_TOKEN_BUDGET = 7_000;
const PREFERENCE_TEXT = "偏好短句、克制表达；不替角色直接告白，也不新增剧情事实。";

describe("Novel Skill paid evaluation payload authority", () => {
  it("resolves all 12 real fixtures into unique immutable payloads and content-free manifests", async () => {
    const fixtures = listNovelSkillEvaluationFixtures();
    const results = await Promise.all(
      fixtures.map(async (fixture, index) => {
        const input = await authorityInput(fixture, "no_skill", index);
        const payload = await compileNovelSkillPaidEvaluationPayload(input);
        await expect(
          validateNovelSkillPaidEvaluationPayloadAuthority(payload, input),
        ).resolves.toEqual(payload);
        return { fixture, payload };
      }),
    );

    expect(results).toHaveLength(12);
    expect(new Set(results.map(({ payload }) => payload.manifest.messagePayloadHash)).size).toBe(
      12,
    );
    expect(
      new Set(results.map(({ payload }) => payload.manifest.baseMessagePayloadHash)).size,
    ).toBe(12);

    for (const { fixture, payload } of results) {
      expect(payload.messages).toHaveLength(2);
      expect(payload.messages[1]?.content).toContain(fixture.input);
      expect(payload.messages[1]?.content).toContain(fixture.requestedOutcome);
      expect(Object.isFrozen(payload)).toBe(true);
      expect(Object.isFrozen(payload.messages)).toBe(true);
      expect(payload.messages.every(Object.isFrozen)).toBe(true);
      expect(payload.compiledSkills).toBeNull();

      const manifestJson = JSON.stringify(payload.manifest);
      expect(manifestJson).not.toContain(fixture.input);
      expect(manifestJson).not.toContain(fixture.requestedOutcome);
      for (const value of [...fixture.lockedFacts, ...fixture.boundaries]) {
        expect(manifestJson).not.toContain(value);
      }
    }
  }, 30_000);

  it("keeps fixture, model and repetition payloads fixed while changing only arm-owned sections", async () => {
    const fixture = requiredFixture("zh.campus.first_person.continuation");
    const arms = ["no_skill", "core", "core_genre", "core_genre_preferences"] as const;
    const payloads = await Promise.all(
      arms.map(async (arm, index) =>
        compileNovelSkillPaidEvaluationPayload(await authorityInput(fixture, arm, index)),
      ),
    );
    const byArm = Object.fromEntries(
      payloads.map((payload) => [payload.manifest.arm, payload]),
    ) as Readonly<Record<NovelSkillEvaluationArm, NovelSkillPaidEvaluationAuthoritativePayload>>;

    expect(new Set(payloads.map(({ manifest }) => manifest.baseMessagePayloadHash)).size).toBe(1);
    expect(new Set(payloads.map(({ messages }) => messages[0]?.content)).size).toBe(1);
    expect(byArm.no_skill.messages[1]?.content).not.toContain("<novel_method>");
    expect(byArm.core.messages[1]?.content).toContain("<novel_method>");
    expect(byArm.core_genre.messages[1]?.content).toContain("<novel_method>");
    expect(byArm.core_genre.messages[1]?.content).not.toContain("<writing_preferences>");
    expect(byArm.core_genre_preferences.messages[1]?.content).toContain(PREFERENCE_TEXT);
    expect(byArm.core_genre.manifest.skillSelectionHash).toBe(
      byArm.core_genre_preferences.manifest.skillSelectionHash,
    );
    expect(byArm.core_genre.manifest.renderedSkillSectionHash).toBe(
      byArm.core_genre_preferences.manifest.renderedSkillSectionHash,
    );
    expect(byArm.core_genre.manifest.armConfigurationHash).toBe(
      byArm.core_genre_preferences.manifest.armConfigurationHash,
    );
    for (const payload of payloads.filter(({ compiledSkills }) => compiledSkills !== null)) {
      expect(payload.compiledSkills?.configuration.bindings).toEqual([]);
      expect(payload.compiledSkills?.configuration.compilerVersion).toBe(
        NOVEL_SKILL_COMPILER_VERSION,
      );
      expect(
        payload.compiledSkills === null
          ? false
          : isFixedNovelSkillEvaluationConfiguration(payload.compiledSkills.configuration),
      ).toBe(true);
      expect(payload.compiledSkills?.configuration.explicitSkillIds.length).toBeGreaterThan(0);
      expect(payload.compiledSkills?.configuration.explicitSkillIds).toHaveLength(
        payload.compiledSkills?.configuration.consideredDefinitions.length ?? 0,
      );
      expect(
        payload.compiledSkills?.items.every(
          ({ activationSource }) => activationSource === "explicit",
        ),
      ).toBe(true);
    }
    expect(byArm.core_genre.compiledSkills?.selectedDefinitions.length).toBeGreaterThan(
      MAX_NOVEL_SKILLS_PER_INVOCATION,
    );
    await expect(hashModelHubExactEvaluationMessages(byArm.core_genre.messages)).resolves.toBe(
      byArm.core_genre.manifest.messagePayloadHash,
    );
    const preferenceProjection = (await authorityInput(fixture, "core_genre_preferences", 89))
      .preferenceProjection;
    expect(preferenceProjection).not.toBeNull();
    if (preferenceProjection !== null) {
      await expect(
        hashNovelSkillEvaluationPreferenceConfiguration([
          {
            sourceId: preferenceProjection.sources[0]?.sourceId,
            sourceVersionId: preferenceProjection.sources[0]?.sourceVersionId,
            contentHash: await sha256Hex(PREFERENCE_TEXT),
          },
        ]),
      ).resolves.toBe(preferenceProjection.configurationHash);
    }

    const firstInput = await authorityInput(fixture, "no_skill", 90);
    const secondInput = {
      ...firstInput,
      cell: {
        ...firstInput.cell,
        cellId: uuid(91),
        modelSlotId: "text_tier_b" as const,
        repetition: 2 as const,
      },
    };
    const [first, second] = await Promise.all([
      compileNovelSkillPaidEvaluationPayload(firstInput),
      compileNovelSkillPaidEvaluationPayload(secondInput),
    ]);
    expect(second.manifest.messagePayloadHash).toBe(first.manifest.messagePayloadHash);
    expect(second.manifest.baseMessagePayloadHash).toBe(first.manifest.baseMessagePayloadHash);
    expect(second.manifestHash).not.toBe(first.manifestHash);
  }, 30_000);

  it("rejects cross-fixture baselines, cell metadata, arm hashes and extra keys", async () => {
    const firstFixture = requiredFixture("zh.campus.first_person.continuation");
    const secondFixture = requiredFixture("zh.mystery.third_limited.pov");
    const first = await authorityInput(firstFixture, "core", 101);
    const second = await authorityInput(secondFixture, "core", 102);

    await expect(
      compileNovelSkillPaidEvaluationPayload({
        ...second,
        contextBaseline: first.contextBaseline,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_HASH_MISMATCH" });
    await expect(
      compileNovelSkillPaidEvaluationPayload({
        ...first,
        cell: { ...first.cell, taskType: secondFixture.taskType },
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_FIXTURE_MISMATCH" });
    await expect(
      compileNovelSkillPaidEvaluationPayload({
        ...first,
        cell: { ...first.cell, armConfigurationHash: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_HASH_MISMATCH" });
    await expect(
      compileNovelSkillPaidEvaluationPayload({ ...first, unexpected: true }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_INVALID" });

    const manifest = (await compileNovelSkillPaidEvaluationPayload(first)).manifest;
    await expect(
      hashNovelSkillPaidEvaluationAuthorityManifest({ ...manifest, fixtureText: "not allowed" }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_INVALID" });
  });

  it("uses the Store's exact content-free trace-baseline hash contract", async () => {
    const fixture = requiredFixture("zh.mystery.third_limited.pov");
    const baseline = await createNovelSkillPaidEvaluationContextBaselineProjection(
      fixture.fixtureId,
      BASELINE_TOKEN_BUDGET,
    );
    const trace: ContextCompilationTrace = {
      id: uuid(120),
      projectId: uuid(121),
      chapterId: null,
      taskType: baseline.traceBaseline.taskType,
      maximumContextTokens: baseline.traceBaseline.maximumContextTokens,
      requiredTokens: baseline.traceBaseline.requiredTokens,
      usedTokens: baseline.traceBaseline.usedTokens,
      remainingTokens: baseline.traceBaseline.remainingTokens,
      discardedTokens: baseline.traceBaseline.discardedTokens,
      tokenEstimateSource: baseline.traceBaseline.tokenEstimateSource,
      createdAt: "2026-08-11T00:00:00.000Z",
      execution: {
        generationId: uuid(122),
        generationRunId: null,
        modelInvocationId: uuid(123),
      },
      outputCandidateId: null,
      entries: baseline.traceBaseline.entries.map(({ sources, ...entry }) => ({
        ...entry,
        sources: sources.map(({ sourceType, sourceId, sourceVersionId, locator, contentHash }) => ({
          sourceType,
          sourceId,
          sourceVersionId,
          locator,
          contentHash,
        })),
      })),
    };

    await expect(hashNovelSkillPaidEvaluationTraceBaseline(trace)).resolves.toBe(
      baseline.compiledBaselineHash,
    );
  });

  it("rejects tampered messages, preference hashes and constant cross-fixture payload replay", async () => {
    const firstFixture = requiredFixture("zh.campus.first_person.continuation");
    const secondFixture = requiredFixture("zh.mystery.third_limited.pov");
    const firstInput = await authorityInput(firstFixture, "core_genre_preferences", 110);
    const secondInput = await authorityInput(secondFixture, "core_genre_preferences", 111);
    const firstPayload = await compileNovelSkillPaidEvaluationPayload(firstInput);

    const tamperedMessagePayload = {
      ...firstPayload,
      messages: [
        firstPayload.messages[0],
        { role: "user" as const, content: `${firstPayload.messages[1]?.content ?? ""}\n篡改` },
      ],
    };
    await expect(
      validateNovelSkillPaidEvaluationPayloadAuthority(tamperedMessagePayload, firstInput),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_MISMATCH" });
    await expect(
      validateNovelSkillPaidEvaluationPayloadAuthority(firstPayload, secondInput),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_MISMATCH" });

    const preference = firstInput.preferenceProjection;
    expect(preference).not.toBeNull();
    await expect(
      compileNovelSkillPaidEvaluationPayload({
        ...firstInput,
        preferenceProjection:
          preference === null ? null : { ...preference, configurationHash: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_HASH_MISMATCH" });

    const noSkill = await authorityInput(firstFixture, "no_skill", 112);
    await expect(
      compileNovelSkillPaidEvaluationPayload({
        ...noSkill,
        preferenceProjection: firstInput.preferenceProjection,
      }),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_PAYLOAD_INVALID" });
  });
});

async function authorityInput(
  fixture: NovelSkillEvaluationFixture,
  arm: NovelSkillEvaluationArm,
  sequence: number,
): Promise<CompileNovelSkillPaidEvaluationPayloadInput> {
  const promptTemplate = await createNovelSkillPaidEvaluationPromptTemplateProjection();
  const contextBaseline = await createNovelSkillPaidEvaluationContextBaselineProjection(
    fixture.fixtureId,
    BASELINE_TOKEN_BUDGET,
  );
  const preferenceProjection =
    arm === "core_genre_preferences"
      ? await createNovelSkillPaidEvaluationPreferenceProjection([
          {
            sourceId: "evaluation.preference.concise_restraint",
            sourceVersionId: "1",
            preferenceText: PREFERENCE_TEXT,
          },
        ])
      : null;
  return {
    cell: {
      runId: RUN_ID,
      suiteId: SUITE_ID,
      cellId: uuid(sequence),
      fixtureId: fixture.fixtureId,
      fixtureInputContentHash: contextBaseline.availableContextLayers.includes("current_task")
        ? fixtureInputHash(fixture.fixtureId)
        : "0".repeat(64),
      taskType: fixture.taskType,
      invocationMode: fixture.invocationMode,
      arm,
      armConfigurationHash: await resolveNovelSkillPaidEvaluationArmConfigurationHash(arm),
      modelSlotId: "text_tier_a",
      repetition: 1,
    },
    promptTemplate,
    contextBaseline,
    preferenceProjection,
  };
}

function requiredFixture(fixtureId: string): NovelSkillEvaluationFixture {
  const fixture = listNovelSkillEvaluationFixtures().find((value) => value.fixtureId === fixtureId);
  if (fixture === undefined)
    throw new Error("Required fixture is missing from the built-in registry.");
  return fixture;
}

function fixtureInputHash(fixtureId: string): string {
  const pinned: Readonly<Record<string, string>> = Object.freeze({
    "zh.campus.first_person.continuation":
      "f4d8d15518baeb8cccd87cd8ff3c2ce93debc39344f409248001d0fa750fec5e",
    "zh.mystery.third_limited.pov":
      "e14e92d45909c9b0fe36bf7bdb6463da0d1e3a40e07f01435f8e3ce909549d9f",
    "zh.fantasy.causal.scene": "92725ae644838c39843967bfa8b71343be4c102ae7113b58e277b89795346f84",
    "zh.web_serial.action_specificity":
      "ab3bd2737c4072ea40d6330c48c3ef866a0be8d47fe6e0db1f4ce48f9b1f5186",
    "zh.family.rewrite_scope": "3abecd307076f06e134926b8186483f2f09907bcecb002ba768f7167ba6c0975",
    "zh.multiline.continuity": "3eba62d06bb18279108c83cfb335a139f80753151085e120bd47ba6c549c092f",
    "zh.historical.dialogue.voice":
      "bef7e56773825de181e7a4759b19b36a0adfbdf2fac430aa239e526819b68609",
    "zh.scifi.world_rule": "4925da136d658ce7e5dd94e15954e7569039daed450d04e77942ecd7aee14c22",
    "zh.xianxia.foreshadow": "023d7f4f3b890854f8c0086f0aa5a7edac23ca6326c45dd8884a2fd2152a9716",
    "zh.suspense.rewrite.dialogue":
      "9406a7df5aa1866f84f69dc0bdeb9e82e411d210549cdf507315cf2e3fb0d416",
    "zh.slice_of_life.summary": "4eefa3a64166d7cc46772f53e1ce12b682f5ee776b10edd8542bd8a80cffadc9",
    "zh.romance.preference.polish":
      "a4f0be7ee36d1c24237c21d61faa0efb067077916d4d74c30d519a828b72ef83",
  });
  const hash = pinned[fixtureId];
  if (hash === undefined) throw new Error("Fixture input hash is not pinned in the test.");
  return hash;
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-8000-${sequence.toString(16).padStart(12, "0")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
