import {
  evaluateCandidateQuality,
  scoreCandidateRepetition,
  type CandidateQualityGateResult,
} from "@inkshadow/ai-core";
import type { AiCandidate } from "@inkshadow/domain";

export const LOCAL_CANDIDATE_QUALITY_POLICY = Object.freeze({
  policyId: "inkshadow.local-candidate-quality",
  version: 1,
  minimumOverallScore: 0.72,
  thresholds: Object.freeze([
    Object.freeze({
      metric: "repetition" as const,
      minimumScore: 0.72,
      weight: 1,
      required: true,
      allowedSources: Object.freeze(["deterministic_rule" as const]),
    }),
  ]),
});

/**
 * The synchronous generation gate intentionally claims only what it can prove
 * without a second model call: repeated sentence-level content. Consistency,
 * POV, voice and narrative checks live in the evidence-backed chapter checker
 * and are never represented here as fake passing scores.
 */
export function evaluateGeneratedCandidateQuality(input: {
  readonly candidate: AiCandidate;
  readonly baselineContent?: string;
  readonly promptTraceId: string;
  readonly promptContentHashSha256: string;
  readonly measuredAt: string;
}): CandidateQualityGateResult {
  const candidateContent = input.candidate.content;
  const baseline = input.baselineContent ?? "";
  const generatedPortion =
    baseline.length > 0 && candidateContent.startsWith(baseline.trimEnd())
      ? candidateContent.slice(baseline.trimEnd().length).trim()
      : candidateContent;
  return evaluateCandidateQuality({
    candidateId: input.candidate.id,
    promptTrace: {
      promptId: input.promptTraceId,
      promptVersion: 1,
      promptContentHashSha256: input.promptContentHashSha256,
    },
    observations: [scoreCandidateRepetition(generatedPortion, 12, input.measuredAt)],
    policy: LOCAL_CANDIDATE_QUALITY_POLICY,
  });
}
