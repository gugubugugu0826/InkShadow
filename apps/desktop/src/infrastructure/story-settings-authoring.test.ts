import { describe, expect, it } from "vitest";
import { FormalStoryRecord, StoryFact } from "@inkshadow/story-core";

import {
  inspectLegacyGuidedOpeningRecords,
  parseNaturalLanguageSetting,
  projectStorySettingsForExport,
  readRelationship,
} from "./story-settings-authoring";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const ACTOR_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const NOW = "2026-08-09T00:00:00.000Z";

describe("story settings authoring", () => {
  it("parses a plain-language relationship into a two-ended candidate", () => {
    expect(parseNaturalLanguageSetting("顾顾和丹丹是情侣关系，在初中就认识了。")).toMatchObject({
      kind: "relationship",
      fromName: "顾顾",
      toName: "丹丹",
      relationshipType: "情侣",
      since: "初中",
    });
  });

  it("parses a world rule without promoting any suggested details", () => {
    const result = parseNaturalLanguageSetting("魔法每使用一次都会让施法者失去一天记忆。");

    expect(result).toMatchObject({
      kind: "world_rule",
      rule: "魔法每使用一次都会让施法者失去一天记忆",
    });
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("detects legacy guided-opening cards and incomplete relationship facts", () => {
    const character = unwrap(
      FormalStoryRecord.create({
        id: "019f9f4a-b3c7-7350-9226-000000000101",
        projectId: PROJECT_ID,
        kind: "character",
        recordKey: "guided_opening.characters",
        value: { protagonist: "普通但敏锐", relationship: "青梅竹马" },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        now: NOW,
      }),
    );
    const relationship = unwrap(
      StoryFact.create({
        id: "019f9f4a-b3c7-7350-9226-000000000102",
        projectId: PROJECT_ID,
        factType: "relationship",
        contentText: "人物关系：青梅竹马",
        source: { kind: "user_statement", reference: "guided-opening" },
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: NOW,
      }),
    );

    const repairs = inspectLegacyGuidedOpeningRecords([character], [relationship]);

    expect(repairs.map(({ kind }) => kind)).toEqual([
      "character_record",
      "incomplete_relationship",
      "incomplete_relationship",
    ]);
    expect(repairs.filter(({ needsUserInput }) => needsUserInput)).toHaveLength(2);
    expect(repairs.filter(({ kind }) => kind === "incomplete_relationship")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKind: "record",
          sourceId: character.id,
          expectedRevision: 1,
          relationshipType: "青梅竹马",
        }),
        expect.objectContaining({
          sourceKind: "fact",
          sourceId: relationship.id,
          expectedRevision: 1,
        }),
      ]),
    );
  });

  it("does not offer the same legacy repair again after a versioned normalization", () => {
    const legacy = characterRecord(
      "019f9f4a-b3c7-7350-9226-000000000111",
      "guided_opening.characters",
      "林舟",
    );
    const normalized = unwrap(
      legacy.editManually({
        value: {
          schemaVersion: "inkshadow.character-setting.v1",
          name: "林舟",
          shortDescription: "普通但敏锐",
          aliases: [],
          traits: [],
          knownInformation: [],
          source: "guided_opening_legacy_repair",
        },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: legacy.revision,
        now: "2026-08-09T00:00:01.000Z",
      }),
    );

    expect(inspectLegacyGuidedOpeningRecords([normalized], [])).toEqual([]);
    expect(normalized.toSnapshot().versions).toHaveLength(2);
  });

  it("keeps a mixed-record relationship repair visible after character normalization only", () => {
    const normalized = unwrap(
      FormalStoryRecord.create({
        id: "019f9f4a-b3c7-7350-9226-000000000112",
        projectId: PROJECT_ID,
        kind: "character",
        recordKey: "guided_opening.characters",
        value: {
          schemaVersion: "inkshadow.character-setting.v1",
          name: "林舟",
          aliases: [],
          traits: [],
          knownInformation: [],
          legacyRelationship: "青梅竹马",
        },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        now: NOW,
      }),
    );

    expect(inspectLegacyGuidedOpeningRecords([normalized], [])).toEqual([
      expect.objectContaining({
        kind: "incomplete_relationship",
        sourceKind: "record",
        sourceId: normalized.id,
        relationshipType: "青梅竹马",
      }),
    ]);
  });

  it("does not offer a deprecated endpointless relationship again", () => {
    const legacy = relationshipFact("019f9f4a-b3c7-7350-9226-000000000113", undefined);
    const deprecated = unwrap(
      legacy.deprecate({
        humanConfirmed: true,
        expectedRevision: legacy.revision,
        now: "2026-08-09T00:00:01.000Z",
      }),
    );

    expect(inspectLegacyGuidedOpeningRecords([], [deprecated])).toEqual([]);
  });

  it("exports only relationships with two stable character endpoints", () => {
    const characters = [
      characterRecord("019f9f4a-b3c7-7350-9226-000000000201", "character.gugu", "顾顾"),
      characterRecord("019f9f4a-b3c7-7350-9226-000000000202", "character.dandan", "丹丹"),
    ];
    const valid = relationshipFact("019f9f4a-b3c7-7350-9226-000000000203", {
      fromCharacterRef: "character.gugu",
      toCharacterRef: "character.dandan",
      relationshipType: "情侣",
      since: "初中相识",
    });
    const invalid = relationshipFact("019f9f4a-b3c7-7350-9226-000000000204", undefined);

    const projection = projectStorySettingsForExport({
      projectName: "测试作品",
      exportedAt: NOW,
      records: characters,
      facts: [valid, invalid],
      memories: [],
    });

    expect(projection.bundle.characters).toHaveLength(2);
    expect(projection.bundle.relationships).toHaveLength(1);
    expect(projection.bundle.relationships[0]).toMatchObject({
      relationshipType: "情侣",
      since: "初中相识",
    });
    expect(projection.warnings).toContainEqual(expect.stringContaining("缺少两端人物"));
    expect(readRelationship(invalid.toSnapshot())).toBeNull();
  });

  it("preserves portable lock, evidence and source metadata when exporting again", () => {
    const character = formalRecord(
      "019f9f4a-b3c7-7350-9226-000000000301",
      "character",
      "character.locked",
      { name: "Locked Character", locked: true },
    );
    const otherCharacter = formalRecord(
      "019f9f4a-b3c7-7350-9226-000000000302",
      "character",
      "character.other",
      { name: "Other Character", locked: false },
    );
    const worldRule = formalRecord(
      "019f9f4a-b3c7-7350-9226-000000000303",
      "world_rule",
      "rule.evidence",
      {
        title: "Evidence Rule",
        rule: "The rule remains stable.",
        evidence: "chapter-1:line-8",
        locked: true,
      },
    );
    const relationship = relationshipFact("019f9f4a-b3c7-7350-9226-000000000304", {
      fromCharacterRef: "character.locked",
      toCharacterRef: "character.other",
      relationshipType: "ally",
      evidence: "chapter-2:line-4",
    });
    const writingPreference = unwrap(
      StoryFact.create({
        id: "019f9f4a-b3c7-7350-9226-000000000305",
        projectId: PROJECT_ID,
        factType: "writing_rule",
        contentText: "Prefer short sentences.",
        structuredValue: { source: "imported-style-guide" },
        source: { kind: "user_statement", reference: "test:writing-preference" },
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: NOW,
      }),
    );

    const projection = projectStorySettingsForExport({
      projectName: "Round-trip metadata",
      exportedAt: NOW,
      records: [character, otherCharacter, worldRule],
      facts: [relationship, writingPreference],
      memories: [],
    });

    expect(projection.bundle.characters[0]?.locked).toBe(true);
    expect(projection.bundle.relationships[0]?.evidence).toBe("chapter-2:line-4");
    expect(projection.bundle.worldRules[0]).toMatchObject({
      evidence: "chapter-1:line-8",
      locked: true,
    });
    expect(projection.bundle.writingPreferences[0]?.source).toBe("imported-style-guide");
  });
});

function characterRecord(id: string, recordKey: string, name: string): FormalStoryRecord {
  return formalRecord(id, "character", recordKey, {
    name,
    title: name,
    description: `${name}的人物介绍`,
  });
}

function formalRecord(
  id: string,
  kind: "character" | "world_rule",
  recordKey: string,
  value: Readonly<Record<string, unknown>>,
): FormalStoryRecord {
  return unwrap(
    FormalStoryRecord.create({
      id,
      projectId: PROJECT_ID,
      kind,
      recordKey,
      value,
      actorId: ACTOR_ID,
      humanConfirmed: true,
      now: NOW,
    }),
  );
}

function relationshipFact(id: string, structuredValue: unknown): StoryFact {
  return unwrap(
    StoryFact.create({
      id,
      projectId: PROJECT_ID,
      factType: "core_relationship",
      contentText: structuredValue === undefined ? "人物关系：未知" : "顾顾与丹丹是情侣",
      ...(structuredValue === undefined ? {} : { structuredValue }),
      source: { kind: "user_statement", reference: `test:${id}` },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: NOW,
    }),
  );
}

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("test fixture failed");
  return result.value;
}
