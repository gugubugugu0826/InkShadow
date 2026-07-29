import { describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_EXTRACTION_SCHEMA_VERSION,
  evaluateAuthoritativeExtractionCandidates,
  parseAuthoritativeExtractionOutput,
  parseSafeIdentifier,
  parseUuidV7,
  type AuthoritativeExtractionValidationContext,
} from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";

const CONTENT = "清晨，林舟离开南城，走进北塔。";
const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const RECORD_ID = uuid(4);
const CHECKSUM = "a".repeat(64);
const PROMPT_CHECKSUM = "b".repeat(64);
const EVIDENCE = "走进北塔";
const EVIDENCE_START = CONTENT.indexOf(EVIDENCE);

function context(): AuthoritativeExtractionValidationContext {
  return {
    source: {
      projectId: unwrap(parseUuidV7(PROJECT_ID)),
      chapterId: unwrap(parseUuidV7(CHAPTER_ID)),
      versionId: unwrap(parseUuidV7(VERSION_ID)),
      checksumSha256: CHECKSUM,
      scope: {
        start: 0,
        end: CONTENT.length,
        sourceLength: CONTENT.length,
      },
    },
    chapterContent: CONTENT,
    provenance: {
      prompt: {
        registryId: unwrap(parseSafeIdentifier("story.authoritative.extract")),
        version: 7,
        checksumSha256: PROMPT_CHECKSUM,
      },
      model: {
        provider: "local-test-adapter",
        id: "fixture-model",
        revision: "2026-07-28",
      },
      evaluationVersion: unwrap(parseSafeIdentifier("golden.v3")),
    },
    targets: [
      {
        recordId: unwrap(parseUuidV7(RECORD_ID)),
        kind: "character",
        expectedRevision: 3,
        value: { location: "南城" },
      },
    ],
  };
}

function output(overrides: Record<string, unknown> = {}): string {
  const value = {
    schemaVersion: AUTHORITATIVE_EXTRACTION_SCHEMA_VERSION,
    source: context().source,
    prompt: context().provenance.prompt,
    model: context().provenance.model,
    evaluationVersion: context().provenance.evaluationVersion,
    candidates: [
      {
        key: "linzhou.location.1",
        target: {
          recordId: RECORD_ID,
          kind: "character",
          expectedRevision: 3,
        },
        category: "location",
        severity: "info",
        confidence: 0.97,
        originalValue: { location: "南城" },
        suggestedValue: { location: "北塔" },
        evidence: {
          start: EVIDENCE_START,
          end: EVIDENCE_START + EVIDENCE.length,
          excerpt: EVIDENCE,
        },
      },
    ],
    ...overrides,
  };
  return JSON.stringify(value);
}

describe("authoritative extraction output protocol", () => {
  it("accepts only an exact candidate-only envelope with complete authority metadata", () => {
    const parsed = parseAuthoritativeExtractionOutput(output(), context());

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        source: {
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          versionId: VERSION_ID,
          checksumSha256: CHECKSUM,
          scope: { start: 0, end: CONTENT.length, sourceLength: CONTENT.length },
        },
        prompt: {
          registryId: "story.authoritative.extract",
          version: 7,
          checksumSha256: PROMPT_CHECKSUM,
        },
        model: {
          provider: "local-test-adapter",
          id: "fixture-model",
          revision: "2026-07-28",
        },
        evaluationVersion: "golden.v3",
        candidates: [
          {
            key: "linzhou.location.1",
            target: {
              recordId: RECORD_ID,
              kind: "character",
              expectedRevision: 3,
            },
            evidence: {
              excerpt: EVIDENCE,
              range: {
                start: EVIDENCE_START,
                end: EVIDENCE_START + EVIDENCE.length,
                sourceLength: CONTENT.length,
              },
            },
          },
        ],
      },
    });
  });

  it.each([
    ["Markdown fence", `\`\`\`json\n${output()}\n\`\`\``],
    [
      "unknown root field",
      output({
        debugReasoning: "must never be accepted",
      }),
    ],
    [
      "mismatched source checksum",
      output({
        source: {
          ...context().source,
          checksumSha256: "c".repeat(64),
        },
      }),
    ],
  ])("rejects %s before review intake", (_name, raw) => {
    expect(parseAuthoritativeExtractionOutput(raw, context())).toMatchObject({
      ok: false,
      error: { code: "EXTRACTION_OUTPUT_INVALID" },
    });
  });

  it("rejects forged evidence and stale target revisions", () => {
    const forged = JSON.parse(output()) as {
      candidates: {
        evidence: { excerpt: string };
        target: { expectedRevision: number };
      }[];
    };
    const first = forged.candidates[0];
    if (first === undefined) {
      throw new Error("fixture candidate missing");
    }
    first.evidence.excerpt = "走进南塔";
    expect(parseAuthoritativeExtractionOutput(JSON.stringify(forged), context())).toMatchObject({
      ok: false,
      error: { code: "EXTRACTION_OUTPUT_INVALID" },
    });

    first.evidence.excerpt = EVIDENCE;
    first.target.expectedRevision = 2;
    expect(parseAuthoritativeExtractionOutput(JSON.stringify(forged), context())).toMatchObject({
      ok: false,
      error: { code: "EXTRACTION_OUTPUT_INVALID" },
    });
  });

  it("computes exact golden precision/recall and enforces both thresholds", () => {
    const parsed = unwrap(parseAuthoritativeExtractionOutput(output(), context()));
    const expectedCandidate = parsed.candidates[0];
    if (expectedCandidate === undefined) {
      throw new Error("fixture candidate missing");
    }
    const missed = {
      ...expectedCandidate,
      key: unwrap(parseSafeIdentifier("different.key")),
      suggestedValue: { location: "西塔" },
    };
    const metrics = evaluateAuthoritativeExtractionCandidates(
      [expectedCandidate, missed],
      parsed.candidates,
      { minimumPrecision: 0.75, minimumRecall: 1 },
    );

    expect(metrics).toEqual({
      ok: true,
      value: {
        truePositiveCount: 1,
        falsePositiveCount: 1,
        falseNegativeCount: 0,
        predictedCount: 2,
        expectedCount: 1,
        precision: 0.5,
        recall: 1,
        passed: false,
      },
    });
  });
});
