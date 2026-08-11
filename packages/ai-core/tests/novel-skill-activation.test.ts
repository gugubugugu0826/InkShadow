import { describe, expect, it } from "vitest";

import {
  compileNovelSkills,
  createGenreNovelSkillDefinitions,
  projectNovelSkillRecommendationsFromSeed,
  type NovelSkillProjectSeedFieldView,
  type NovelSkillProjectSeedView,
} from "../src/index.js";

const PROJECT_ID = "019f9f4a-b3c-7350-9226-000000000001";

describe("Novel Skill genre definitions", () => {
  it("ships five original genre methods as experimental and disabled by default", async () => {
    const definitions = await createGenreNovelSkillDefinitions();

    expect(definitions.map(({ skillId }) => skillId)).toEqual([
      "genre.campus_romance",
      "genre.light_novel",
      "genre.mystery",
      "genre.fantasy",
      "genre.web_serial",
    ]);
    expect(
      definitions.every(
        ({ kind, ownerScope, status, defaultEnabled }) =>
          kind === "genre" &&
          ownerScope === "builtin" &&
          status === "experimental" &&
          defaultEnabled === false,
      ),
    ).toBe(true);
    expect(new Set(definitions.map(({ definitionHash }) => definitionHash)).size).toBe(5);
    expect(
      definitions.map(({ skillId, activation }) => [skillId, activation.genreTags[0]]),
    ).toEqual([
      ["genre.campus_romance", "campus_romance"],
      ["genre.light_novel", "light_novel"],
      ["genre.mystery", "mystery"],
      ["genre.fantasy", "fantasy"],
      ["genre.web_serial", "web_serial"],
    ]);
  });

  it("does not activate a matching genre method without an explicit binding or choice", async () => {
    const definitions = await createGenreNovelSkillDefinitions();
    const compiled = await compileNovelSkills({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 4_000,
      genreTags: ["mystery"],
      explicitSkillIds: [],
      availableContextLayers: ["current_task", "pov_known_information", "recent_events"],
      allowExperimental: true,
      definitions,
      bindings: [],
    });

    expect(compiled.selectedDefinitions).toEqual([]);
    expect(compiled.usedSkillTokens).toBe(0);
    expect(compiled.items.find(({ skillId }) => skillId === "genre.mystery")).toMatchObject({
      included: false,
      selectionReason: "not_enabled",
    });
  });
});

describe("ProjectSeed Novel Skill recommendation projection", () => {
  it("explains multiple recommendations without producing a binding or enabled state", () => {
    const projection = projectNovelSkillRecommendationsFromSeed(
      seed({ genre: confirmedField(["校园恋爱轻小说"]) }),
    );

    expect(projection.automaticBindingAllowed).toBe(false);
    expect(projection.recommendations.map(({ skillId }) => skillId)).toEqual([
      "genre.campus_romance",
      "genre.light_novel",
    ]);
    expect(
      projection.recommendations.every(
        ({ effect, confidence, requiresAuthorConfirmation, evidence }) =>
          effect === "recommendation_only" &&
          confidence === "confirmed_signal" &&
          requiresAuthorConfirmation &&
          evidence.length > 0,
      ),
    ).toBe(true);
    expect(projection.recommendations[0]?.evidence[0]).toMatchObject({
      field: "genre",
      value: "校园恋爱轻小说",
      source: "user_input",
      confirmation: "confirmed",
    });
    expect(JSON.stringify(projection)).not.toMatch(/"(?:enabled|binding|defaultEnabled)":/u);
  });

  it("combines explainable signals across ProjectSeed fields", () => {
    const projection = projectNovelSkillRecommendationsFromSeed(
      seed({
        genre: confirmedField(["校园群像"]),
        tone: confirmedField(["慢热恋爱喜剧"]),
      }),
    );
    const recommendation = projection.recommendations.find(
      ({ skillId }) => skillId === "genre.campus_romance",
    );

    expect(recommendation?.evidence.map(({ field }) => field)).toEqual(["genre", "tone"]);
    expect(recommendation?.reason).toContain("题材、基调");
  });

  it("marks an unconfirmed AI inference as tentative and still requires the author", () => {
    const projection = projectNovelSkillRecommendationsFromSeed(
      seed({ genre: inferredField(["悬疑推理"]) }),
    );

    expect(projection.recommendations).toEqual([
      expect.objectContaining({
        skillId: "genre.mystery",
        confidence: "tentative_signal",
        requiresAuthorConfirmation: true,
        effect: "recommendation_only",
      }),
    ]);
  });

  it("returns no recommendation when ProjectSeed has no supported genre signal", () => {
    const projection = projectNovelSkillRecommendationsFromSeed(
      seed({ genre: confirmedField(["现实主义家庭故事"]) }),
    );

    expect(projection).toMatchObject({
      source: "project_seed",
      automaticBindingAllowed: false,
      recommendations: [],
    });
  });

  it("fails closed on malformed ProjectSeed field containers", () => {
    expect(() =>
      projectNovelSkillRecommendationsFromSeed(
        seed({ genre: { ...confirmedField(["奇幻"]), values: "奇幻" } as never }),
      ),
    ).toThrow(expect.objectContaining({ code: "NOVEL_SKILL_INVALID" }));
  });
});

function seed(
  overrides: Partial<Record<keyof NovelSkillProjectSeedView, NovelSkillProjectSeedFieldView>>,
): NovelSkillProjectSeedView {
  const empty = unconfirmedField([]);
  return {
    premise: overrides.premise ?? empty,
    genre: overrides.genre ?? empty,
    tone: overrides.tone ?? empty,
    style: overrides.style ?? empty,
    currentDirection: overrides.currentDirection ?? empty,
  };
}

function confirmedField(values: readonly string[]): NovelSkillProjectSeedFieldView {
  return { values, source: "user_input", confirmation: "confirmed" };
}

function inferredField(values: readonly string[]): NovelSkillProjectSeedFieldView {
  return { values, source: "ai_inference", confirmation: "unconfirmed" };
}

function unconfirmedField(values: readonly string[]): NovelSkillProjectSeedFieldView {
  return {
    values,
    source: values.length === 0 ? null : "user_input",
    confirmation: "unconfirmed",
  };
}
