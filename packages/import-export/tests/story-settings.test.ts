import { describe, expect, it } from "vitest";

import {
  createStorySettingsTemplate,
  preflightStorySettings,
  preflightStorySettingsJson,
  serializeStorySettings,
} from "../src/index.js";

describe("InkShadow Story Settings JSON", () => {
  it("round-trips the documented template through strict preflight", () => {
    const template = createStorySettingsTemplate();
    const serialized = serializeStorySettings(template);
    const report = preflightStorySettingsJson(serialized);

    expect(report.status).toBe("ready");
    expect(report.summary).toEqual({
      importableCount: 5,
      confirmationCount: 0,
      errorCount: 0,
      skippedCount: 0,
    });
    expect(report.candidate).toEqual(template);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("reasoning_content");
  });

  it("blocks a relationship whose two character endpoints cannot be resolved", () => {
    const template = createStorySettingsTemplate();
    const report = preflightStorySettings({
      ...template,
      relationships: [
        {
          ...template.relationships[0],
          toCharacterRef: "character.missing",
        },
      ],
    });

    expect(report.status).toBe("blocked");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "RELATIONSHIP_ENDPOINT_MISSING",
        path: "$.relationships[0].toCharacterRef",
      }),
    );
    expect(report.candidate).toBeUndefined();
  });

  it("requires conflict confirmation without treating an existing name as corrupt input", () => {
    const report = preflightStorySettings(createStorySettingsTemplate(), {
      characterNames: ["顾顾"],
      worldRuleTitles: ["魔法的记忆代价"],
    });

    expect(report.status).toBe("ready");
    expect(report.summary.confirmationCount).toBe(2);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "CHARACTER_NAME_CONFLICT" }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "WORLD_RULE_TITLE_CONFLICT" }),
    );
  });

  it("blocks unknown fields at their exact path instead of silently dropping them", () => {
    const template = createStorySettingsTemplate();
    const report = preflightStorySettings({ ...template, hiddenPrompt: "do not import" });

    expect(report.status).toBe("blocked");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        severity: "blocking",
        code: "UNKNOWN_FIELD",
        path: "$.hiddenPrompt",
      }),
    );
    expect(report.candidate).toBeUndefined();
  });

  it("blocks malformed JSON with an actionable format issue", () => {
    const report = preflightStorySettingsJson('{"schemaVersion":1');

    expect(report.status).toBe("blocked");
    expect(report.issues[0]).toMatchObject({ code: "INVALID_JSON", path: "$" });
  });

  it("blocks ambiguous duplicate people and self relationships before commit", () => {
    const template = createStorySettingsTemplate();
    const [firstCharacter, secondCharacter] = template.characters;
    const [firstRelationship] = template.relationships;
    if (
      firstCharacter === undefined ||
      secondCharacter === undefined ||
      firstRelationship === undefined
    ) {
      throw new Error("Story Settings template fixture is incomplete.");
    }
    const duplicate = preflightStorySettings({
      ...template,
      characters: [firstCharacter, { ...secondCharacter, name: firstCharacter.name }],
    });
    const selfRelation = preflightStorySettings({
      ...template,
      relationships: [
        {
          ...firstRelationship,
          toCharacterRef: firstRelationship.fromCharacterRef,
        },
      ],
    });

    expect(duplicate.status).toBe("blocked");
    expect(duplicate.issues).toContainEqual(
      expect.objectContaining({ severity: "blocking", code: "DUPLICATE_CHARACTER_NAME" }),
    );
    expect(selfRelation.status).toBe("blocked");
    expect(selfRelation.issues).toContainEqual(
      expect.objectContaining({ severity: "blocking", code: "SELF_RELATIONSHIP" }),
    );
  });

  it("blocks duplicate world-rule titles inside one import package at the exact path", () => {
    const template = createStorySettingsTemplate();
    const [firstWorldRule] = template.worldRules;
    if (firstWorldRule === undefined) {
      throw new Error("Story Settings template fixture has no world rule.");
    }
    const report = preflightStorySettings({
      ...template,
      worldRules: [
        firstWorldRule,
        {
          ...firstWorldRule,
          id: "rule.memory-cost-copy",
          title: ` ${firstWorldRule.title} `,
        },
      ],
    });

    expect(report.status).toBe("blocked");
    expect(report.candidate).toBeUndefined();
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        severity: "blocking",
        code: "DUPLICATE_WORLD_RULE_TITLE",
        path: "$.worldRules[1].title",
      }),
    );
  });
});
