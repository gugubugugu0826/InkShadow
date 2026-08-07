import { describe, expect, it } from "vitest";

import {
  validateNovelConsistency,
  type NovelCurrentClaim,
  type NovelEvidenceReference,
  type NovelHardRule,
  type NovelHardRuleOperator,
  type NovelReferenceFact,
  type NovelValidationInput,
  type DeterministicNovelFactType,
  type NovelFactValue,
} from "../src/novel-validator.js";

const HASH = "a".repeat(64);

describe("deterministic novel validator", () => {
  it("reports only structured fact conflicts with evidence from both sides", () => {
    const cases = [
      factCase("life", "character_life_status", "alive", "dead"),
      factCase("age", "character_age", 18, 19),
      factCase("identity", "character_identity", "heir", "merchant"),
      factCase("relationship", "relationship", "allies", "enemies"),
      factCase("time", "event_time", 100, 120),
      factCase("location", "entity_location", "north-gate", "south-gate"),
      factCase("item", "item_ownership", "character-a", "character-b"),
      factCase("ability", "ability_state", true, false),
      factCase("world", "world_property", "two-moons", "one-moon"),
      factCase("knowledge", "character_knowledge", "known", "unknown"),
    ] as const;

    const result = validateNovelConsistency({
      currentClaims: cases.map(({ current }) => current),
      referenceFacts: cases.map(({ reference }) => reference),
      hardRules: [],
    });

    expect(result.issues.map(({ issueType }) => issueType)).toEqual([
      "ability_conflict",
      "character_age_conflict",
      "character_identity_conflict",
      "character_life_status_conflict",
      "item_ownership_conflict",
      "knowledge_boundary_conflict",
      "location_conflict",
      "relationship_conflict",
      "timeline_conflict",
      "world_setting_conflict",
    ]);
    const lifeIssue = result.issues.find(
      ({ issueType }) => issueType === "character_life_status_conflict",
    );
    expect(lifeIssue).toMatchObject({
      detector: "deterministic",
      severity: "error",
      currentClaim: {
        id: "claim-life",
        text: "Current passage says life is alive.",
        value: "alive",
      },
      conflictingFact: {
        id: "fact-life",
        source: "confirmed_fact",
        operator: "equals",
        statement: "Confirmed fact says life is dead.",
        value: "dead",
      },
      overlap: { startOrder: 10, endOrder: 20 },
      suggestion: {
        actions: ["revise_current_text", "review_confirmed_fact"],
      },
    });
    expect(lifeIssue?.currentClaim.evidence).toEqual([evidence("claim-life")]);
    expect(lifeIssue?.conflictingFact.evidence).toEqual([evidence("fact-life")]);
    expect(result.skippedChecks).toEqual([]);
  });

  it("does not report when either side lacks evidence or is not authoritative", () => {
    const validClaim = claim("valid", "character_age", 20);
    const result = validateNovelConsistency({
      currentClaims: [
        { ...claim("missing-evidence", "character_age", 20), evidence: [] },
        { ...claim("inferred", "character_age", 20), basis: "inferred" },
        validClaim,
      ],
      referenceFacts: [
        { ...reference("candidate", validClaim, 21), status: "candidate" },
        { ...reference("missing-evidence", validClaim, 22), evidence: [] },
      ],
      hardRules: [
        {
          ...hardRule("missing-evidence", validClaim, "equals", 30),
          evidence: [],
        },
      ],
    });

    expect(result.issues).toEqual([]);
    expect(result.skippedChecks).toEqual(
      expect.arrayContaining([
        {
          source: "current_claim",
          sourceId: "claim-missing-evidence",
          reason: "current_claim_missing_evidence",
        },
        {
          source: "current_claim",
          sourceId: "claim-inferred",
          reason: "current_claim_not_explicit",
        },
        {
          source: "reference_fact",
          sourceId: "fact-candidate",
          reason: "reference_fact_not_confirmed",
        },
        {
          source: "reference_fact",
          sourceId: "fact-missing-evidence",
          reason: "reference_fact_missing_evidence",
        },
        {
          source: "hard_rule",
          sourceId: "rule-missing-evidence",
          reason: "hard_rule_missing_evidence",
        },
      ]),
    );
  });

  it("does not treat equal values or non-overlapping scopes as conflicts", () => {
    const current = claim("base", "entity_location", "harbor");
    const result = validateNovelConsistency({
      currentClaims: [current],
      referenceFacts: [
        reference("equal", current, "harbor"),
        {
          ...reference("later", current, "palace"),
          effectiveRange: { startOrder: 21, endOrder: 30 },
        },
        { ...reference("branch", current, "palace"), branchId: "alternate" },
        { ...reference("subject", current, "palace"), subjectId: "another-character" },
        { ...reference("attribute", current, "palace"), attributeKey: "home-location" },
      ],
      hardRules: [],
    });

    expect(result.issues).toEqual([]);
  });

  it("reports POV leakage only for knowledge asserted as known in a limited POV", () => {
    const leaked = {
      ...claim("leaked", "character_knowledge", "known"),
      povContext: { mode: "third_person_limited" as const, characterId: "subject-leaked" },
    };
    const ordinaryMismatch = {
      ...claim("ordinary", "character_knowledge", "unknown"),
      povContext: { mode: "first_person" as const, characterId: "subject-ordinary" },
    };
    const result = validateNovelConsistency({
      currentClaims: [leaked, ordinaryMismatch],
      referenceFacts: [
        reference("leaked", leaked, "unknown"),
        reference("ordinary", ordinaryMismatch, "known"),
      ],
      hardRules: [],
    });

    expect(result.issues.map(({ issueType }) => issueType)).toEqual([
      "knowledge_boundary_conflict",
      "pov_boundary_violation",
    ]);
    expect(
      result.issues.find(({ issueType }) => issueType === "pov_boundary_violation"),
    ).toMatchObject({
      currentClaim: { id: "claim-leaked", value: "known" },
      conflictingFact: { value: "unknown" },
      suggestion: {
        actions: ["revise_current_text", "add_information_acquisition", "change_pov"],
      },
    });
  });

  it("evaluates every hard-rule operator without model inference", () => {
    const definitions: readonly Readonly<{
      id: string;
      actual: NovelFactValue;
      operator: NovelHardRuleOperator;
      expected: NovelFactValue | readonly NovelFactValue[];
    }>[] = [
      { id: "equals", actual: "day", operator: "equals", expected: "night" },
      { id: "not-equals", actual: "red", operator: "not_equals", expected: "red" },
      { id: "one-of", actual: "winter", operator: "one_of", expected: ["spring", "summer"] },
      { id: "not-one-of", actual: "poison", operator: "not_one_of", expected: ["poison"] },
      { id: "minimum", actual: 5, operator: "minimum", expected: 10 },
      { id: "maximum", actual: 15, operator: "maximum", expected: 10 },
    ];
    const claims = definitions.map(({ id, actual }) => claim(id, "world_property", actual));
    const rules = definitions.map(({ id, operator, expected }, index) => {
      const current = claims[index];
      if (current === undefined) {
        throw new Error("Expected matching claim.");
      }
      return hardRule(id, current, operator, expected);
    });

    const result = validateNovelConsistency({
      currentClaims: claims,
      referenceFacts: [],
      hardRules: rules,
    });

    expect(result.issues).toHaveLength(6);
    expect(result.issues.every(({ issueType }) => issueType === "world_hard_rule_conflict")).toBe(
      true,
    );
    expect(
      result.issues.every(({ conflictingFact }) => conflictingFact.source === "locked_hard_rule"),
    ).toBe(true);
    expect(result.issues.map(({ conflictingFact }) => conflictingFact.operator).sort()).toEqual([
      "equals",
      "maximum",
      "minimum",
      "not_equals",
      "not_one_of",
      "one_of",
    ]);
  });

  it("allows compliant hard-rule values", () => {
    const values: readonly Readonly<{
      actual: NovelFactValue;
      operator: NovelHardRuleOperator;
      expected: NovelFactValue | readonly NovelFactValue[];
    }>[] = [
      { actual: "night", operator: "equals", expected: "night" },
      { actual: "blue", operator: "not_equals", expected: "red" },
      { actual: "spring", operator: "one_of", expected: ["spring", "summer"] },
      { actual: "water", operator: "not_one_of", expected: ["poison"] },
      { actual: 10, operator: "minimum", expected: 10 },
      { actual: 10, operator: "maximum", expected: 10 },
    ];
    const claims = values.map(({ actual }, index) =>
      claim(`allowed-${String(index)}`, "world_property", actual),
    );

    expect(
      validateNovelConsistency({
        currentClaims: claims,
        referenceFacts: [],
        hardRules: values.map(({ operator, expected }, index) => {
          const current = claims[index];
          if (current === undefined) {
            throw new Error("Expected matching claim.");
          }
          return hardRule(`allowed-${String(index)}`, current, operator, expected);
        }),
      }).issues,
    ).toEqual([]);
  });

  it("rejects imprecise evidence, invalid typed values, and duplicate source ids", () => {
    const current = claim("base", "character_age", 20);
    const invalidEvidence = {
      ...evidence("bad"),
      contentHash: "not-a-hash",
    };
    expect(() =>
      validateNovelConsistency({
        currentClaims: [{ ...current, evidence: [invalidEvidence] }],
        referenceFacts: [],
        hardRules: [],
      }),
    ).toThrow(expect.objectContaining({ code: "NOVEL_VALIDATOR_INPUT_INVALID" }));
    expect(() =>
      validateNovelConsistency({
        currentClaims: [
          {
            ...current,
            evidence: [{ ...evidence("bad-range"), endOffset: 2 }],
          },
        ],
        referenceFacts: [],
        hardRules: [],
      }),
    ).toThrow(expect.objectContaining({ code: "NOVEL_VALIDATOR_INPUT_INVALID" }));
    expect(() =>
      validateNovelConsistency({
        currentClaims: [{ ...current, value: -1 }],
        referenceFacts: [],
        hardRules: [],
      }),
    ).toThrow(expect.objectContaining({ code: "NOVEL_VALIDATOR_INPUT_INVALID" }));
    expect(() =>
      validateNovelConsistency({
        currentClaims: [current],
        referenceFacts: [{ ...reference("duplicate", current, 21), id: current.id }],
        hardRules: [],
      }),
    ).toThrow(expect.objectContaining({ code: "NOVEL_VALIDATOR_INPUT_INVALID" }));
  });

  it("produces deterministic ordering regardless of input order", () => {
    const first = factCase("life", "character_life_status", "alive", "dead");
    const second = factCase("age", "character_age", 18, 19);
    const forward: NovelValidationInput = {
      currentClaims: [first.current, second.current],
      referenceFacts: [first.reference, second.reference],
      hardRules: [],
    };
    const reversed: NovelValidationInput = {
      currentClaims: [...forward.currentClaims].reverse(),
      referenceFacts: [...forward.referenceFacts].reverse(),
      hardRules: [],
    };

    expect(validateNovelConsistency(reversed)).toEqual(validateNovelConsistency(forward));
  });

  it("reports ambiguous model review as a separate read-only service", () => {
    const result = validateNovelConsistency({
      currentClaims: [],
      referenceFacts: [],
      hardRules: [],
    });

    expect(result.capabilities).toEqual({
      deterministicValidation: "ready",
      ambiguousModelReview: "separate_read_only_service",
    });
    expect(result.issues).toEqual([]);
  });

  it("returns frozen issue and evidence collections", () => {
    const testCase = factCase("age", "character_age", 18, 19);
    const result = validateNovelConsistency({
      currentClaims: [testCase.current],
      referenceFacts: [testCase.reference],
      hardRules: [],
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(Object.isFrozen(result.issues[0]?.currentClaim.evidence)).toBe(true);
    expect(Object.isFrozen(result.issues[0]?.suggestion.actions)).toBe(true);
  });
});

function factCase(
  id: string,
  factType: DeterministicNovelFactType,
  currentValue: NovelFactValue,
  referenceValue: NovelFactValue,
) {
  const current = claim(id, factType, currentValue);
  return {
    current,
    reference: reference(id, current, referenceValue),
  };
}

function claim(
  id: string,
  factType: DeterministicNovelFactType,
  value: NovelFactValue,
): NovelCurrentClaim {
  return {
    id: `claim-${id}`,
    factType,
    subjectId: `subject-${id}`,
    attributeKey: `attribute-${id}`,
    branchId: "main",
    effectiveRange: { startOrder: 10, endOrder: 20 },
    value,
    basis: "explicit_text",
    claimText: `Current passage says ${id} is ${String(value)}.`,
    evidence: [evidence(`claim-${id}`)],
    povContext: null,
  };
}

function reference(
  id: string,
  current: NovelCurrentClaim,
  value: NovelFactValue,
): NovelReferenceFact {
  return {
    id: `fact-${id}`,
    factType: current.factType,
    subjectId: current.subjectId,
    attributeKey: current.attributeKey,
    branchId: current.branchId,
    effectiveRange: { ...current.effectiveRange },
    value,
    status: "confirmed",
    factText: `Confirmed fact says ${id} is ${String(value)}.`,
    evidence: [evidence(`fact-${id}`)],
  };
}

function hardRule(
  id: string,
  current: NovelCurrentClaim,
  operator: NovelHardRuleOperator,
  expectedValue: NovelFactValue | readonly NovelFactValue[],
): NovelHardRule {
  return {
    id: `rule-${id}`,
    locked: true,
    targetFactType: current.factType,
    subjectId: current.subjectId,
    attributeKey: current.attributeKey,
    branchId: current.branchId,
    effectiveRange: { ...current.effectiveRange },
    operator,
    expectedValue,
    ruleText: `Locked rule ${id}.`,
    evidence: [evidence(`rule-${id}`)],
  };
}

function evidence(id: string): NovelEvidenceReference {
  const excerpt = `Evidence-${id}`;
  return {
    sourceKind: id.startsWith("rule-") ? "world_rule" : "chapter",
    sourceId: `source-${id}`,
    sourceVersionId: `version-${id}`,
    contentHash: HASH,
    locator: `paragraph:${id}`,
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: excerpt.length,
  };
}
