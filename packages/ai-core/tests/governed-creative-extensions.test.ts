import { describe, expect, it } from "vitest";

import {
  CreativeExtensionProtocolError,
  parseCreativeExtensionCandidate,
  serializeCreativeExtensionCandidate,
} from "../src/index.js";

const source = {
  chapterId: "chapter-1",
  sourceVersionId: "version-1",
  sourceChecksum: "a".repeat(64),
} as const;

function translation() {
  return {
    schemaVersion: 1,
    kind: "translation",
    source,
    targetLanguage: { code: "en-US", label: "English (US)" },
    tone: "literary",
    glossaryVersion: "glossary-3",
    paragraphs: [
      {
        sourceParagraph: 0,
        sourceChecksum: "b".repeat(64),
        translatedText: "Rain struck the bluestone path.",
        glossaryTerms: ["青石板"],
      },
    ],
  } as const;
}

function shortDrama() {
  return {
    schemaVersion: 1,
    kind: "short_drama",
    source,
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
            slugline: "外景·青云山脚·雨夜",
            location: "青云山脚",
            timeOfDay: "雨夜",
            durationSeconds: 12,
            characters: ["林青云", "师父"],
            sourceReferences: [
              {
                paragraphStart: 0,
                paragraphEnd: 1,
                sourceChecksum: "c".repeat(64),
              },
            ],
            shots: [
              {
                number: 1,
                shotType: "中景",
                action: "林青云握紧剑。",
                durationSeconds: 12,
                dialogue: [
                  {
                    character: "师父",
                    line: "想好了？",
                    stageDirection: "画外音",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  } as const;
}

describe("governed creative extension provider protocol", () => {
  it("parses and canonically serializes translation and short-drama candidates", () => {
    expect(parseCreativeExtensionCandidate(JSON.stringify(translation()))).toEqual(translation());
    expect(parseCreativeExtensionCandidate(JSON.stringify(shortDrama()))).toEqual(shortDrama());
    expect(JSON.parse(serializeCreativeExtensionCandidate(shortDrama()))).toEqual(shortDrama());
  });

  it("rejects wrappers, unknown fields, prototype keys and dangerous Unicode", () => {
    expect(() =>
      parseCreativeExtensionCandidate(`\`\`\`json\n${JSON.stringify(translation())}\n\`\`\``),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_INVALID_JSON" }));
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({ ...translation(), hiddenReasoning: "do not persist" }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify(translation()).replace(
          '"schemaVersion":1',
          '"__proto__":{"polluted":true},"schemaVersion":1',
        ),
      ),
    ).toThrow(CreativeExtensionProtocolError);
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify(translation()).replace('"literary"', '"literary\\u202E"'),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_UNSAFE" }));
  });

  it("rejects excessive size, depth, malformed ordinals and duration mismatches", () => {
    expect(() => parseCreativeExtensionCandidate(`{"padding":"${"x".repeat(1_000_001)}"}`)).toThrow(
      expect.objectContaining({ code: "EXTENSION_RESPONSE_TOO_LARGE" }),
    );

    let nested = "{}";
    for (let depth = 0; depth < 20; depth += 1) {
      nested = `{"value":${nested}}`;
    }
    expect(() => parseCreativeExtensionCandidate(nested)).toThrow(
      expect.objectContaining({ code: "EXTENSION_RESPONSE_TOO_LARGE" }),
    );

    const drama = shortDrama();
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...drama,
          episodes: [{ ...drama.episodes[0], number: 2 }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...drama,
          episodes: [{ ...drama.episodes[0], durationSeconds: 13 }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
  });

  it("rejects duplicate translation authority and glossary entries", () => {
    const candidate = translation();
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...candidate,
          paragraphs: [candidate.paragraphs[0], candidate.paragraphs[0]],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...candidate,
          paragraphs: [
            {
              ...candidate.paragraphs[0],
              glossaryTerms: ["青石板", "青石板"],
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
  });

  it("rejects whitespace-only public fields and applies explicit line-break policy", () => {
    const candidate = translation();
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...candidate,
          paragraphs: [{ ...candidate.paragraphs[0], translatedText: " \t " }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...candidate,
          paragraphs: [{ ...candidate.paragraphs[0], translatedText: "\u200B\u2060" }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));

    const drama = shortDrama();
    expect(() =>
      parseCreativeExtensionCandidate(JSON.stringify({ ...drama, title: "   " })),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...drama,
          episodes: [
            {
              ...drama.episodes[0],
              scenes: [
                {
                  ...drama.episodes[0].scenes[0],
                  shots: [{ ...drama.episodes[0].scenes[0].shots[0], action: "\t " }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));

    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...candidate,
          paragraphs: [{ ...candidate.paragraphs[0], translatedText: "First line\nSecond line" }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...candidate,
          paragraphs: [{ ...candidate.paragraphs[0], translatedText: "First line\r\nSecond line" }],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...drama,
          episodes: [
            {
              ...drama.episodes[0],
              scenes: [
                {
                  ...drama.episodes[0].scenes[0],
                  shots: [
                    {
                      ...drama.episodes[0].scenes[0].shots[0],
                      action: "First beat\nSecond beat",
                      dialogue: [
                        {
                          ...drama.episodes[0].scenes[0].shots[0].dialogue[0],
                          line: "One line\nInjected line",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
  });

  it("requires dialogue characters to belong to the scene and source references not to overlap", () => {
    const drama = shortDrama();
    const scene = drama.episodes[0].scenes[0];
    const shot = scene.shots[0];
    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...drama,
          episodes: [
            {
              ...drama.episodes[0],
              scenes: [
                {
                  ...scene,
                  shots: [
                    {
                      ...shot,
                      dialogue: [{ ...shot.dialogue[0], character: "未声明角色" }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));

    expect(() =>
      parseCreativeExtensionCandidate(
        JSON.stringify({
          ...drama,
          episodes: [
            {
              ...drama.episodes[0],
              scenes: [
                {
                  ...scene,
                  sourceReferences: [
                    scene.sourceReferences[0],
                    {
                      paragraphStart: 1,
                      paragraphEnd: 2,
                      sourceChecksum: "d".repeat(64),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "EXTENSION_RESPONSE_SCHEMA_INVALID" }));
  });
});
