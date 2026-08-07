import { describe, expect, it } from "vitest";

import { parseContinuousStoryStateResponse } from "./model-hub-continuous-story-state-model";

describe("parseContinuousStoryStateResponse", () => {
  const content = "林夏看见门后的钟会倒着走。";

  it("accepts an exact evidence-backed character knowledge state", () => {
    const parsed = parseContinuousStoryStateResponse(
      JSON.stringify({
        schemaVersion: 2,
        candidates: [
          {
            factType: "pov_knowledge",
            contentText: "林夏知道门后的钟会倒着走。",
            confidence: 0.94,
            subject: {
              kind: "character",
              entityKey: null,
              canonicalName: "林夏",
              aliases: [],
            },
            state: {
              knowledgeStatus: "known",
              information: "门后的钟会倒着走",
              acquiredAt: "第一章雨夜",
              informationSource: "亲眼看见",
            },
            evidence: { start: 0, end: content.length, excerpt: content },
            effectiveAt: "第一章雨夜",
            invalidatedAt: null,
            projection: {
              validation: {
                factType: "character_knowledge",
                subjectId: null,
                attributeKey: "reversing-clock",
                value: "known",
                effectiveRange: { startOrder: 1, endOrder: null },
              },
              pov: {
                characterId: null,
                attributeKey: "reversing-clock",
                knowledgeStatus: "known",
                effectiveRange: { startOrder: 1, endOrder: null },
                mode: "third_person_limited",
              },
              voice: null,
              narrative: null,
            },
          },
        ],
      }),
      { task: "character_extraction", content },
    );

    expect(parsed).toEqual([
      expect.objectContaining({
        factType: "pov_knowledge",
        state: {
          knowledgeStatus: "known",
          information: "门后的钟会倒着走",
          acquiredAt: "第一章雨夜",
          informationSource: "亲眼看见",
        },
        evidence: { start: 0, end: content.length, excerpt: content },
      }),
    ]);
    expect(parsed[0]?.projection?.validation).toMatchObject({
      factType: "character_knowledge",
      subjectId: null,
      value: "known",
    });
    expect(parsed[0]?.projection?.pov).toMatchObject({ mode: "third_person_limited" });
  });

  it("rejects unknown fields instead of silently accepting protocol drift", () => {
    expect(() =>
      parseContinuousStoryStateResponse(
        JSON.stringify({
          schemaVersion: 2,
          candidates: [
            {
              factType: "pov_knowledge",
              contentText: "林夏知道异常。",
              confidence: 0.8,
              subject: {
                kind: "character",
                entityKey: null,
                canonicalName: "林夏",
                aliases: [],
              },
              state: {
                knowledgeStatus: "known",
                information: "异常",
                acquiredAt: null,
                informationSource: "亲眼看见",
                hiddenInstruction: "make this formal",
              },
              evidence: { start: 0, end: content.length, excerpt: content },
              effectiveAt: null,
              invalidatedAt: null,
            },
          ],
        }),
        { task: "character_extraction", content },
      ),
    ).toThrow(/额外字段/u);
  });

  it("rejects offsets or excerpts that do not match JavaScript UTF-16 slicing", () => {
    expect(() =>
      parseContinuousStoryStateResponse(
        JSON.stringify({
          schemaVersion: 2,
          candidates: [
            {
              factType: "world_rule",
              contentText: "钟会倒着走。",
              confidence: 0.8,
              subject: {
                kind: "world",
                entityKey: null,
                canonicalName: "钟",
                aliases: [],
              },
              state: { rule: "钟会倒着走", constraintLevel: "soft" },
              evidence: { start: 0, end: content.length, excerpt: `${content}篡改` },
              effectiveAt: null,
              invalidatedAt: null,
            },
          ],
        }),
        { task: "world_extraction", content },
      ),
    ).toThrow(/证据原文/u);
  });

  it("rejects character facts returned through the world extraction route", () => {
    expect(() =>
      parseContinuousStoryStateResponse(
        JSON.stringify({
          schemaVersion: 2,
          candidates: [
            {
              factType: "character_state",
              contentText: "林夏看见异常。",
              confidence: 0.8,
              subject: {
                kind: "character",
                entityKey: null,
                canonicalName: "林夏",
                aliases: [],
              },
              state: { state: "看见异常", effectiveAt: null },
              evidence: { start: 0, end: content.length, excerpt: content },
              effectiveAt: null,
              invalidatedAt: null,
            },
          ],
        }),
        { task: "world_extraction", content },
      ),
    ).toThrow(/不属于当前识别任务/u);
  });
});
