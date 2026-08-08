import type {
  NarrativeAnalysisField,
  NarrativeEvidenceReference,
  NarrativeQualityFinding,
} from "@inkshadow/story-core";

import type {
  ChapterCharacterVoicePovIssue,
  ChapterCharacterVoicePovRuntime,
  ChapterCharacterVoicePovRuntimeResult,
} from "./chapter-character-voice-pov-runtime";
import type {
  ChapterNarrativeAnalysisResult,
  ChapterNarrativeAnalysisRuntime,
} from "./narrative-analysis-runtime";
import type {
  ChapterSupplementalFindingCategory,
  ChapterSupplementalFindingResolutionSummary,
  ChapterSupplementalFindingVerificationPort,
  ChapterSupplementalFindingVerificationRequest,
} from "./novel-validation-runtime";

export interface SupplementalFindingEvidenceIdentity {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

export interface SupplementalFindingDescriptor {
  readonly id: string;
  readonly category: ChapterSupplementalFindingCategory;
  readonly evidence: readonly SupplementalFindingEvidenceIdentity[];
}

type EvidenceSignaturePart = Pick<
  SupplementalFindingEvidenceIdentity,
  "sourceVersionId" | "contentHash" | "startOffset" | "endOffset"
>;

export class RecomputedChapterSupplementalFindingVerifier implements ChapterSupplementalFindingVerificationPort {
  public constructor(
    private readonly dependencies: Readonly<{
      readonly characterVoicePov: Pick<ChapterCharacterVoicePovRuntime, "check">;
      readonly narrativeAnalysis: Pick<ChapterNarrativeAnalysisRuntime, "analyzeChapter">;
    }>,
  ) {}

  public async isCurrentFinding(
    request: ChapterSupplementalFindingVerificationRequest,
  ): Promise<boolean> {
    const [voicePov, narrative] = await Promise.all([
      this.dependencies.characterVoicePov.check(request),
      this.dependencies.narrativeAnalysis.analyzeChapter(request),
    ]);
    if (
      narrative.projectId !== request.projectId ||
      narrative.chapterId !== request.chapterId ||
      voicePov.projectId !== request.projectId ||
      voicePov.chapterId !== request.chapterId
    ) {
      return false;
    }
    return collectTrustedSupplementalFindings(
      voicePov.chapterVersionId === request.expectedChapterVersionId ? voicePov : null,
      narrative,
    ).some(
      (finding) =>
        finding.id === request.findingId &&
        finding.category === request.category &&
        supplementalEvidenceSignature(finding.evidence) === request.evidenceSignature,
    );
  }
}

export function characterVoicePovSupplementalFinding(
  issue: ChapterCharacterVoicePovIssue,
): SupplementalFindingDescriptor {
  return Object.freeze({
    id: issue.id,
    category: issue.kind === "character_voice_deviation" ? "character_voice" : "pov_knowledge",
    evidence: Object.freeze(
      [...issue.currentEvidence, ...issue.referenceEvidence].map((source) =>
        Object.freeze({
          sourceKind: source.sourceKind,
          sourceId: source.id,
          sourceVersionId: source.chapterVersionId,
          contentHash: source.contentHash,
          locator: source.locator,
          excerpt: source.excerpt,
          startOffset: source.startOffset,
          endOffset: source.endOffset,
          sourceLength: source.sourceLength,
        }),
      ),
    ),
  });
}

export function narrativeQualityFindingId(finding: NarrativeQualityFinding): string {
  switch (finding.kind) {
    case "scene_changes_neither_plot_nor_character":
      return `narrative:quality:${finding.kind}:${finding.sceneId}`;
    case "repeated_scene_function":
      return `narrative:quality:${finding.kind}:${[...finding.sceneIds].sort().join(",")}`;
    case "climax_missing_required_setup":
      return `narrative:quality:${finding.kind}:${finding.sceneId}:${[
        ...finding.missingSetupBeatIds,
      ]
        .sort()
        .join(",")}`;
    case "consecutive_chapters_have_similar_pacing":
      return `narrative:quality:${finding.kind}:${[...finding.chapterIds].sort().join(",")}`;
  }
}

export function supplementalEvidenceSignature(evidence: readonly EvidenceSignaturePart[]): string {
  return `v2:${[
    ...new Set(
      evidence.map(
        (source) =>
          `${source.sourceVersionId}:${source.contentHash}:${String(source.startOffset)}-${String(source.endOffset)}`,
      ),
    ),
  ]
    .sort()
    .join("|")}`;
}

export function findSupplementalFindingResolution(
  resolutions: readonly ChapterSupplementalFindingResolutionSummary[],
  finding: SupplementalFindingDescriptor,
  expectedChapterVersionId: string | null,
): ChapterSupplementalFindingResolutionSummary | undefined {
  if (expectedChapterVersionId === null) return undefined;
  const evidenceSignature = supplementalEvidenceSignature(finding.evidence);
  return resolutions.find(
    (item) =>
      item.findingId === finding.id &&
      item.category === finding.category &&
      item.chapterVersionId === expectedChapterVersionId &&
      item.evidenceSignature === evidenceSignature,
  );
}

function collectTrustedSupplementalFindings(
  voicePov: ChapterCharacterVoicePovRuntimeResult | null,
  narrative: ChapterNarrativeAnalysisResult,
): readonly SupplementalFindingDescriptor[] {
  const findings: SupplementalFindingDescriptor[] = [];
  if (voicePov !== null) {
    voicePov.issues.forEach((issue) => findings.push(characterVoicePovSupplementalFinding(issue)));
  }
  const analysis = narrative.status === "analyzed" ? narrative.analysis : null;
  if (analysis !== null) {
    analysis.plotlines.forEach((plotline) => {
      const stagnation = analyzedValue(plotline.stagnation);
      if (stagnation?.state !== "stagnant") return;
      findings.push(
        descriptor(
          `narrative:plotline:${plotline.plotlineId}:stagnant`,
          "plotline",
          analyzedEvidence(
            plotline.goal,
            plotline.latestProgress,
            plotline.stagnation,
            plotline.dependencies,
            plotline.upcomingConvergences,
          ),
        ),
      );
    });
    if (analysis.timeLocationConflicts.status === "analyzed") {
      analysis.timeLocationConflicts.value.forEach((conflict) =>
        findings.push(
          descriptor(`narrative:time-location:${conflict.id}`, "time_location", conflict.evidence),
        ),
      );
    }
    analysis.foreshadows.forEach((foreshadow) => {
      if (foreshadow.progress.status !== "analyzed") return;
      const progress = foreshadow.progress.value;
      progress.sequenceIssues.forEach((issue) =>
        findings.push(
          descriptor(
            `narrative:foreshadow:${foreshadow.foreshadowId}:${issue.kind}:${issue.progressId}`,
            "foreshadow",
            issue.evidence,
          ),
        ),
      );
      if (progress.stagnant) {
        findings.push(
          descriptor(
            `narrative:foreshadow:${foreshadow.foreshadowId}:stagnant:${progress.latestProgress?.id ?? "none"}`,
            "foreshadow",
            foreshadow.progress.evidence,
          ),
        );
      }
    });
    analysis.qualityFindings.forEach((finding) =>
      findings.push(
        descriptor(narrativeQualityFindingId(finding), "pacing_quality", finding.evidence),
      ),
    );
  }
  return Object.freeze(findings.filter(hasCompleteEvidence));
}

function descriptor(
  id: string,
  category: ChapterSupplementalFindingCategory,
  evidence: readonly NarrativeEvidenceReference[],
): SupplementalFindingDescriptor {
  return Object.freeze({ id, category, evidence: Object.freeze([...evidence]) });
}

function hasCompleteEvidence(finding: SupplementalFindingDescriptor): boolean {
  return finding.evidence.length > 0 && finding.evidence.every(isCompleteEvidence);
}

function isCompleteEvidence(evidence: SupplementalFindingEvidenceIdentity): boolean {
  return (
    evidence.sourceKind.length > 0 &&
    evidence.sourceKind.length <= 100 &&
    evidence.sourceId.length > 0 &&
    evidence.sourceId.length <= 1_000 &&
    evidence.sourceVersionId.length > 0 &&
    evidence.sourceVersionId.length <= 1_000 &&
    /^[a-f0-9]{64}$/u.test(evidence.contentHash) &&
    evidence.locator.length > 0 &&
    evidence.locator.length <= 4_000 &&
    Number.isInteger(evidence.startOffset) &&
    Number.isInteger(evidence.endOffset) &&
    Number.isInteger(evidence.sourceLength) &&
    evidence.startOffset >= 0 &&
    evidence.endOffset > evidence.startOffset &&
    evidence.endOffset <= evidence.sourceLength &&
    evidence.excerpt.length === evidence.endOffset - evidence.startOffset
  );
}

function analyzedValue<Value>(field: NarrativeAnalysisField<Value>): Value | null {
  return field.status === "analyzed" ? field.value : null;
}

function analyzedEvidence(
  ...fields: readonly NarrativeAnalysisField<unknown>[]
): readonly NarrativeEvidenceReference[] {
  const evidence = new Map<string, NarrativeEvidenceReference>();
  fields.forEach((field) => {
    if (field.status !== "analyzed") return;
    field.evidence.forEach((source) =>
      evidence.set(
        `${source.sourceKind}:${source.sourceId}:${source.sourceVersionId}:${String(source.startOffset)}:${String(source.endOffset)}`,
        source,
      ),
    );
  });
  return Object.freeze([...evidence.values()]);
}
