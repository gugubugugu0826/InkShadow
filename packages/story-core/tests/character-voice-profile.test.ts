import { describe, expect, it } from "vitest";

import {
  buildCharacterVoiceProfile,
  detectCharacterVoiceDeviation,
  type BuildCharacterVoiceProfileInput,
  type CharacterDialogueSample,
  type CharacterVoiceFeatureCatalog,
  type CharacterVoiceTextEvidence,
} from "../src/character-voice-profile.js";

const HASH = "b".repeat(64);
const PROJECT_ID = "project-one";
const BRANCH_ID = "main";
const CHARACTER_ID = "character-aria";
const CAPTAIN_ID = "character-captain";

describe("evidence-backed character voice profile", () => {
  it("builds every required voice dimension from cited historical dialogue", () => {
    const profile = buildCharacterVoiceProfile(profileInput());

    expect(profile).toMatchObject({
      kind: "evidence_backed_character_voice_profile",
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      characterId: CHARACTER_ID,
      evidenceReadiness: {
        suppliedSampleCount: 6,
        evidenceBackedSampleCount: 6,
        status: "ready",
      },
    });
    expect(profile.commonTerms.map(({ term }) => term)).toEqual(
      expect.arrayContaining(["Captain", "Perhaps", "please"]),
    );
    expect(profile.sentenceLength).toMatchObject({
      metricKey: "average_sentence_characters",
      unit: "characters",
      sampleCount: 6,
    });
    expect(profile.emotionalExpression).toMatchObject({
      markers: ["furious"],
      rate: { metricKey: "emotion_marker_rate_per_100_characters" },
    });
    expect(profile.politeness).toMatchObject({
      positiveMarkers: ["please", "thank you"],
      negativeMarkers: ["hey", "shut up"],
      score: { metricKey: "politeness_score", mean: 1 },
    });
    expect(profile.directness).toMatchObject({
      positiveMarkers: ["must", "now"],
      negativeMarkers: ["maybe", "perhaps"],
      score: { metricKey: "directness_score", mean: -1 },
    });
    expect(profile.metaphorUsage).toMatchObject({
      markers: ["as if", "like"],
      rate: { metricKey: "metaphor_marker_rate_per_100_characters", mean: 0 },
    });
    expect(profile.dialectUsage).toMatchObject({
      markers: ["ain't", "y'all"],
      rate: { metricKey: "dialect_marker_rate_per_100_characters", mean: 0 },
    });
    expect(profile.addresseeVariants).toEqual([
      expect.objectContaining({
        addresseeCharacterId: CAPTAIN_ID,
        sampleCount: 6,
        preferredAddressTerms: ["Captain"],
        addressTermRate: expect.objectContaining({
          metricKey: "address_term_rate_per_100_characters",
        }),
        politenessScore: expect.objectContaining({ mean: 1 }),
        directnessScore: expect.objectContaining({ mean: -1 }),
      }),
    ]);
    expect(profile.typicalQuotes[0]).toMatchObject({
      sampleId: "historical-1",
      addresseeCharacterId: CAPTAIN_ID,
      evidence: { id: "evidence-historical-1" },
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.typicalQuotes)).toBe(true);
    expect(Object.isFrozen(profile.sentenceLength?.historicalEvidence)).toBe(true);
  });

  it("reports explainable deviations with current and historical dialogue evidence", () => {
    const profile = buildCharacterVoiceProfile(profileInput());
    const current = sample(
      "current-deviation",
      "Hey shut up, you must act now, y'all ain't, y'all ain't, y'all ain't going anywhere because my furious furious furious order is like an iron wall, like a locked gate, like a storm, and no one in this city or kingdom is allowed to question it!",
      CAPTAIN_ID,
      false,
    );
    const result = detectCharacterVoiceDeviation({ profile, currentDialogue: [current] });
    const categories = new Set(result.issues.map(({ category }) => category));

    expect(categories).toEqual(
      new Set([
        "addressee_voice",
        "address_habit",
        "common_terms",
        "dialect_usage",
        "directness",
        "emotional_expression",
        "metaphor_usage",
        "politeness",
        "sentence_length",
      ]),
    );
    expect(result.issues.every(({ detector }) => detector === "deterministic_statistics")).toBe(
      true,
    );
    expect(result.issues.every(({ severity }) => ["warning", "error"].includes(severity))).toBe(
      true,
    );
    for (const issue of result.issues) {
      expect(issue.currentDialogueEvidence).toEqual([
        expect.objectContaining({ id: "evidence-current-deviation" }),
      ]);
      expect(issue.historicalDialogueEvidence.length).toBeGreaterThan(0);
      expect(issue.metric).toMatchObject({
        historicalMean: expect.any(Number),
        currentValue: expect.any(Number),
        expectedLowerBound: expect.any(Number),
        expectedUpperBound: expect.any(Number),
        normalizedDeviation: expect.any(Number),
      });
      expect(issue.explanation).toMatch(/historical range/iu);
      expect(issue.suggestion.actions.length).toBeGreaterThan(0);
    }
    expect(result.issues.find(({ category }) => category === "address_habit")).toMatchObject({
      addresseeCharacterId: CAPTAIN_ID,
      expectedMarkers: ["Captain"],
      observedMarkers: [],
    });
    expect(result.capabilities).toEqual({
      deterministicStatisticalReview: "ready",
      ambiguousSemanticReview: "separate_read_only_ai_review",
      modelInvocation: "not_used",
    });
  });

  it("does not report when historical dialogue evidence is insufficient", () => {
    const input = profileInput();
    const profile = buildCharacterVoiceProfile({
      ...input,
      historicalDialogue: input.historicalDialogue.slice(0, 2),
    });
    const result = detectCharacterVoiceDeviation({
      profile,
      currentDialogue: [
        sample(
          "current-long",
          "Hey shut up, you must act now, and this intentionally long line should never become an unsupported voice deviation.",
          CAPTAIN_ID,
          false,
        ),
      ],
    });

    expect(profile.evidenceReadiness.status).toBe("insufficient_evidence");
    expect(result.issues).toEqual([]);
    expect(result.skippedChecks).toEqual([
      {
        scope: "profile",
        metricKey: null,
        addresseeCharacterId: null,
        reason: "insufficient_historical_evidence",
      },
    ]);
  });

  it("does not report when current dialogue is too short or lacks evidence", () => {
    const profile = buildCharacterVoiceProfile(profileInput());
    const tooShort = sample("current-short", "Please wait.", CAPTAIN_ID, false);
    const missingEvidence = {
      ...sample(
        "current-no-evidence",
        "Hey shut up, you must act now, and this line has enough text but no immutable citation.",
        CAPTAIN_ID,
        false,
      ),
      evidence: null,
    };

    for (const currentDialogue of [[tooShort], [missingEvidence]]) {
      const result = detectCharacterVoiceDeviation({ profile, currentDialogue });
      expect(result.issues).toEqual([]);
      expect(result.skippedChecks).toEqual([
        {
          scope: "current_dialogue",
          metricKey: null,
          addresseeCharacterId: null,
          reason: "insufficient_current_evidence",
        },
      ]);
    }
  });

  it("does not flag a sufficiently evidenced passage inside historical ranges", () => {
    const input = profileInput();
    const profile = buildCharacterVoiceProfile(input);
    const historical = input.historicalDialogue[1];
    if (historical === undefined) {
      throw new Error("Expected historical fixture.");
    }
    const matching = sample(
      "current-matching",
      historical.text,
      historical.addresseeCharacterId,
      false,
    );
    const result = detectCharacterVoiceDeviation({ profile, currentDialogue: [matching] });

    expect(result.issues).toEqual([]);
  });

  it("measures separate unpunctuated dialogue samples as separate sentences", () => {
    const profile = buildCharacterVoiceProfile(profileInput());
    const historicalMean = profile.sentenceLength?.mean;
    if (historicalMean === undefined) {
      throw new Error("Expected a sentence-length profile.");
    }
    const text = "x".repeat(Math.max(12, Math.round(historicalMean)));
    const result = detectCharacterVoiceDeviation({
      profile,
      currentDialogue: [
        sample("current-fragment-a", text, null, false),
        sample("current-fragment-b", text, null, false),
      ],
    });

    expect(result.issues.some(({ category }) => category === "sentence_length")).toBe(false);
  });

  it("keeps addressee-specific voice differences separate", () => {
    const input = profileInput();
    const friendDialogue = [
      "Mira, hey, move now. We must take the direct road before dawn.",
      "Mira, shut up and move now. We must finish this before dawn.",
      "Mira, hey, decide now. We must cross the bridge before dawn.",
    ].map((text, index) => sample(`friend-${String(index + 1)}`, text, "character-friend", false));
    const profile = buildCharacterVoiceProfile({
      ...input,
      historicalDialogue: [...input.historicalDialogue, ...friendDialogue],
      featureCatalog: {
        ...input.featureCatalog,
        addressTerms: [
          ...input.featureCatalog.addressTerms,
          { addresseeCharacterId: "character-friend", terms: ["Mira"] },
        ],
      },
    });

    expect(
      profile.addresseeVariants.map(
        ({ addresseeCharacterId, politenessScore, directnessScore }) => ({
          addresseeCharacterId,
          politeness: politenessScore?.mean,
          directness: directnessScore?.mean,
        }),
      ),
    ).toEqual([
      { addresseeCharacterId: CAPTAIN_ID, politeness: 1, directness: -1 },
      { addresseeCharacterId: "character-friend", politeness: -1, directness: 1 },
    ]);

    const result = detectCharacterVoiceDeviation({
      profile,
      currentDialogue: [
        sample(
          "current-to-captain",
          "Mira, hey, move now. We must take the direct road before dawn and nobody should question it.",
          CAPTAIN_ID,
          false,
        ),
      ],
    });
    expect(
      result.issues.filter(
        ({ category, addresseeCharacterId }) =>
          category === "addressee_voice" && addresseeCharacterId === CAPTAIN_ID,
      ),
    ).toHaveLength(2);
  });

  it("rejects altered citations, duplicate ids, and cross-scope dialogue", () => {
    const input = profileInput();
    const first = input.historicalDialogue[0];
    if (first === undefined || first.evidence === null) {
      throw new Error("Expected evidenced fixture.");
    }
    const firstEvidence = first.evidence;
    expect(() =>
      buildCharacterVoiceProfile({
        ...input,
        historicalDialogue: [
          {
            ...first,
            evidence: { ...firstEvidence, excerpt: `${first.text} changed` },
          },
          ...input.historicalDialogue.slice(1),
        ],
      }),
    ).toThrow(/exactly cite/iu);
    expect(() =>
      buildCharacterVoiceProfile({
        ...input,
        historicalDialogue: [first, first],
      }),
    ).toThrow(expect.objectContaining({ code: "CHARACTER_VOICE_INPUT_INVALID" }));

    const profile = buildCharacterVoiceProfile(input);
    expect(() =>
      detectCharacterVoiceDeviation({
        profile,
        currentDialogue: [
          {
            ...sample(
              "wrong-branch",
              "Captain, please wait. Perhaps we should take the quiet road before dawn.",
              CAPTAIN_ID,
              false,
            ),
            branchId: "alternate",
          },
        ],
      }),
    ).toThrow(/crosses its profile scope/iu);
  });

  it("is deterministic regardless of historical input order", () => {
    const input = profileInput();
    const forward = buildCharacterVoiceProfile(input);
    const reversed = buildCharacterVoiceProfile({
      ...input,
      historicalDialogue: [...input.historicalDialogue].reverse(),
    });
    const current = [
      sample(
        "current-deterministic",
        "Hey shut up, you must act now, y'all ain't going anywhere because this furious order is like iron and nobody may question it.",
        CAPTAIN_ID,
        false,
      ),
    ];

    expect(reversed).toEqual(forward);
    expect(detectCharacterVoiceDeviation({ profile: reversed, currentDialogue: current })).toEqual(
      detectCharacterVoiceDeviation({ profile: forward, currentDialogue: current }),
    );
  });
});

function profileInput(): BuildCharacterVoiceProfileInput {
  const lines = [
    "Captain, please wait. Perhaps we should take the quiet road before dawn.",
    "Captain, please listen. Perhaps the northern road will be safer for everyone.",
    "Captain, please consider this. Maybe we can leave by the quiet eastern road.",
    "Captain, thank you for waiting. Perhaps we should avoid the crowded road.",
    "Captain, please give me a moment. Maybe the quiet road is still our safest choice.",
    "Captain, thank you for hearing me. Perhaps we can choose another quiet road.",
  ];
  return {
    id: "voice-profile-aria",
    projectId: PROJECT_ID,
    branchId: BRANCH_ID,
    characterId: CHARACTER_ID,
    historicalDialogue: lines.map((text, index) =>
      sample(`historical-${String(index + 1)}`, text, CAPTAIN_ID, index === 0),
    ),
    featureCatalog: featureCatalog(),
  };
}

function featureCatalog(): CharacterVoiceFeatureCatalog {
  return {
    commonTermCandidates: ["Captain", "please", "Perhaps", "quiet", "road", "never"],
    emotionMarkers: ["furious"],
    politeMarkers: ["please", "thank you"],
    casualMarkers: ["hey", "shut up"],
    directMarkers: ["must", "now"],
    indirectMarkers: ["perhaps", "maybe"],
    metaphorMarkers: ["like", "as if"],
    dialectMarkers: ["y'all", "ain't"],
    addressTerms: [{ addresseeCharacterId: CAPTAIN_ID, terms: ["Captain", "Commander"] }],
  };
}

function sample(
  id: string,
  text: string,
  addresseeCharacterId: string | null,
  typical: boolean,
): CharacterDialogueSample {
  return {
    id,
    projectId: PROJECT_ID,
    branchId: BRANCH_ID,
    characterId: CHARACTER_ID,
    addresseeCharacterId,
    text,
    typical,
    evidence: evidence(id, text),
  };
}

function evidence(id: string, excerpt: string): CharacterVoiceTextEvidence {
  return {
    id: `evidence-${id}`,
    chapterId: `chapter-${id}`,
    chapterVersionId: `version-${id}`,
    contentHash: HASH,
    locator: `dialogue:${id}`,
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: excerpt.length,
  };
}
