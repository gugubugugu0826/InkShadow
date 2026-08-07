import type { StoryValue } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ContinuousStoryStateExtractionService,
  type ContinuousStoryStateModelCandidate,
  type ContinuousStoryStateModelInput,
  type ContinuousStoryStateModelOutput,
  type ContinuousStoryStateModelPort,
  type ContinuousStoryStateProjection,
} from "./continuous-story-state-extraction";
import { createDevelopmentRuntime, type DesktopRuntime } from "./runtime";

const CHARACTER_NAME = "Aria";
const IDENTITY_TEXT = "Aria was a careful courier.";
const HISTORY_LIFE_TEXT = "Aria was alive before the observatory fire.";
const CURRENT_LIFE_TEXT = "Aria is dead after the observatory fire.";
const HISTORY_KNOWLEDGE_TEXT = "Aria had never learned where the observatory key was hidden.";
const CURRENT_KNOWLEDGE_TEXT =
  "Aria now knew the observatory key was hidden under the northern stair.";
const HISTORY_DIALOGUES = [
  "Aria says, Captain, please wait. Perhaps we should take the quiet road before dawn.",
  "Aria says, Captain, please listen. Perhaps the northern road will be safer for everyone.",
  "Aria says, Captain, please consider this. Maybe we can leave by the quiet eastern road.",
  "Aria says, Captain, thank you for waiting. Perhaps we should avoid the crowded road.",
  "Aria says, Captain, please give me a moment. Maybe the quiet road is still our safest choice.",
  "Aria says, Captain, thank you for hearing me. Perhaps we can choose another quiet road.",
] as const;
const CURRENT_DIALOGUE =
  "Aria shouts, Hey, Captain, act now! Stop waiting and open the iron gate before anyone follows us.";
const HISTORY_WORLD_RULE = "Aether law forbids every form of resurrection.";
const CURRENT_WORLD_SETTING = "Aether now permits resurrection after the observatory fire.";
const CURRENT_SCENE_TEXT =
  "The revelation ends the scene without advancing a plotline or changing a character.";

const HISTORY_CONTENT = [
  IDENTITY_TEXT,
  HISTORY_LIFE_TEXT,
  HISTORY_KNOWLEDGE_TEXT,
  ...HISTORY_DIALOGUES,
  HISTORY_WORLD_RULE,
].join("\n");
const CURRENT_CONTENT = [
  CURRENT_LIFE_TEXT,
  CURRENT_KNOWLEDGE_TEXT,
  CURRENT_DIALOGUE,
  CURRENT_WORLD_SETTING,
  CURRENT_SCENE_TEXT,
].join("\n");

describe("continuous story-state detector projections", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("runs extraction, confirmation, deterministic, POV, voice, and narrative paths end to end", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = unwrap(
      await runtime.useCases.createProject.execute({ name: "Continuous projection integration" }),
    );
    const history = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "History",
        content: HISTORY_CONTENT,
      }),
    ).chapter.toSnapshot();
    const current = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: project.id,
        title: "Current",
        content: CURRENT_CONTENT,
      }),
    ).chapter.toSnapshot();

    const model = new ScriptedContinuousModel(() => String(runtime.ids.next()));
    const extraction = new ContinuousStoryStateExtractionService({
      chapters: runtime.repositories.chapters,
      chapterVersions: runtime.repositories.chapterVersions,
      facts: runtime.story.facts,
      factService: runtime.story.factService,
      model,
      hasher: runtime.hasher,
      ids: runtime.ids,
      preferences: new DisabledPreferences(),
    });

    model.set(history.id, [identityCandidate()]);
    expect(
      await extraction.extractSavedVersion({
        projectId: project.id,
        chapterId: history.id,
        versionId: history.currentVersionId,
      }),
    ).toMatchObject({ status: "completed", detectedCount: 1, needsConfirmationCount: 1 });
    await confirmChapterFacts(
      runtime,
      extraction,
      project.id,
      history.id,
      new Set(["character_identity"]),
    );

    model.set(history.id, historyCandidates());
    expect(
      await extraction.extractSavedVersion({
        projectId: project.id,
        chapterId: history.id,
        versionId: history.currentVersionId,
        force: true,
      }),
    ).toMatchObject({ status: "completed", detectedCount: 4 });
    await confirmChapterFacts(
      runtime,
      extraction,
      project.id,
      history.id,
      new Set(["character_state", "pov_knowledge", "character_voice"]),
    );
    await confirmChapterFacts(
      runtime,
      extraction,
      project.id,
      history.id,
      new Set(["world_rule"]),
      true,
    );

    model.set(current.id, currentCandidates());
    expect(
      await extraction.extractSavedVersion({
        projectId: project.id,
        chapterId: current.id,
        versionId: current.currentVersionId,
      }),
    ).toMatchObject({ status: "completed", detectedCount: 5 });
    await confirmChapterFacts(
      runtime,
      extraction,
      project.id,
      current.id,
      new Set(["pov_knowledge", "character_voice"]),
    );

    const validation = await runtime.story.chapterValidation.checkChapter({
      projectId: project.id,
      chapterId: current.id,
    });
    expect(validation.status).toBe("checked");
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "character_life_status_conflict" }),
        expect.objectContaining({ type: "world_hard_rule_conflict" }),
      ]),
    );

    const character = await runtime.story.characterVoicePov.check({
      projectId: project.id,
      chapterId: current.id,
    });
    expect(character.status).toBe("ready");
    expect(character.summary).toMatchObject({ detectorRunCount: 2, checkedCharacterCount: 1 });
    expect(character.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "pov_boundary_violation" })]),
    );

    const narrative = await runtime.story.narrativeAnalysis.analyzeChapter({
      projectId: project.id,
      chapterId: current.id,
    });
    expect(narrative.status).toBe("analyzed");
    expect(narrative.capabilities.rebuildableSystemMetrics).toBe("verified_current_version_only");
    expect(narrative.analysis?.qualityFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "scene_changes_neither_plot_nor_character",
          sceneId: "scene-current",
        }),
      ]),
    );

    const facts = unwrap(await runtime.story.facts.listByProjectId(project.id as never));
    const currentState = facts.find((fact) => {
      const snapshot = fact.toSnapshot();
      return (
        String(snapshot.source.chapterId) === String(current.id) &&
        snapshot.factType === "character_state"
      );
    });
    const pacing = facts.find((fact) => {
      const snapshot = fact.toSnapshot();
      return (
        String(snapshot.source.chapterId) === String(current.id) &&
        snapshot.factType === "pacing_metric"
      );
    });
    expect(currentState?.toSnapshot()).toMatchObject({
      status: "temporary",
      origin: "system",
      userConfirmed: false,
    });
    expect(pacing?.toSnapshot()).toMatchObject({
      status: "temporary",
      origin: "system",
      needsReview: false,
      structuredValue: {
        schemaVersion: "inkshadow.rebuildable-system-fact.v1",
        payload: { schemaVersion: "inkshadow.continuous-story-state.v2" },
      },
    });
  });
});

class ScriptedContinuousModel implements ContinuousStoryStateModelPort {
  private readonly candidatesByChapter = new Map<
    string,
    readonly ContinuousStoryStateModelCandidate[]
  >();

  public constructor(private readonly nextId: () => string) {}

  public set(chapterId: string, candidates: readonly ContinuousStoryStateModelCandidate[]): void {
    this.candidatesByChapter.set(chapterId, Object.freeze([...candidates]));
  }

  public extract(input: ContinuousStoryStateModelInput): Promise<ContinuousStoryStateModelOutput> {
    const candidates = (this.candidatesByChapter.get(input.chapterId) ?? []).filter((candidate) =>
      input.task === "character_extraction"
        ? [
            "character_identity",
            "character_state",
            "relationship_change",
            "pov_knowledge",
            "character_voice",
          ].includes(candidate.factType)
        : ![
            "character_identity",
            "character_state",
            "relationship_change",
            "pov_knowledge",
            "character_voice",
          ].includes(candidate.factType),
    );
    return Promise.resolve({
      candidates: Object.freeze(candidates),
      providerKind: "ollama",
      modelId: "projection-test-model",
      invocationId: this.nextId(),
    });
  }
}

class DisabledPreferences {
  private enabled = false;

  public isContinuousStoryStateOnManualSaveEnabled(): boolean {
    return this.enabled;
  }

  public setContinuousStoryStateOnManualSaveEnabled(_projectId: string, enabled: boolean): void {
    this.enabled = enabled;
  }
}

function identityCandidate(): ContinuousStoryStateModelCandidate {
  return candidate({
    factType: "character_identity",
    contentText: IDENTITY_TEXT,
    content: HISTORY_CONTENT,
    evidenceText: IDENTITY_TEXT,
    state: { identity: "courier", attributes: {} },
    projection: projection({
      validation: {
        factType: "character_identity",
        subjectId: null,
        attributeKey: "occupation",
        value: "courier",
        effectiveRange: { startOrder: 1, endOrder: null },
      },
    }),
  });
}

function historyCandidates(): readonly ContinuousStoryStateModelCandidate[] {
  return Object.freeze([
    characterStateCandidate(HISTORY_CONTENT, HISTORY_LIFE_TEXT, "alive", 1),
    povCandidate(HISTORY_CONTENT, HISTORY_KNOWLEDGE_TEXT, "unknown", 1),
    voiceCandidate(HISTORY_CONTENT, HISTORY_DIALOGUES, HISTORY_DIALOGUES.join("\n")),
    candidate({
      factType: "world_rule",
      contentText: HISTORY_WORLD_RULE,
      content: HISTORY_CONTENT,
      evidenceText: HISTORY_WORLD_RULE,
      subject: { kind: "world", entityKey: null, canonicalName: "Aether", aliases: [] },
      state: { rule: "resurrection is forbidden", constraintLevel: "hard" },
      projection: projection({
        validation: {
          factType: "world_property",
          subjectId: null,
          attributeKey: "resurrection-allowed",
          value: false,
          effectiveRange: { startOrder: 1, endOrder: null },
        },
      }),
    }),
  ]);
}

function currentCandidates(): readonly ContinuousStoryStateModelCandidate[] {
  return Object.freeze([
    characterStateCandidate(CURRENT_CONTENT, CURRENT_LIFE_TEXT, "dead", 2),
    povCandidate(CURRENT_CONTENT, CURRENT_KNOWLEDGE_TEXT, "known", 2),
    voiceCandidate(CURRENT_CONTENT, [CURRENT_DIALOGUE], CURRENT_DIALOGUE),
    candidate({
      factType: "world_setting",
      contentText: CURRENT_WORLD_SETTING,
      content: CURRENT_CONTENT,
      evidenceText: CURRENT_WORLD_SETTING,
      subject: { kind: "world", entityKey: null, canonicalName: "Aether", aliases: [] },
      state: { setting: "resurrection is permitted", scope: "global" },
      projection: projection({
        validation: {
          factType: "world_property",
          subjectId: null,
          attributeKey: "resurrection-allowed",
          value: true,
          effectiveRange: { startOrder: 2, endOrder: null },
        },
      }),
    }),
    candidate({
      factType: "pacing_metric",
      contentText: CURRENT_SCENE_TEXT,
      content: CURRENT_CONTENT,
      evidenceText: CURRENT_SCENE_TEXT,
      subject: null,
      state: {
        sceneGoal: "reveal the rule change",
        conflictIntensity: 0.6,
        tensionDirection: "rising",
        dialogueRatio: 0.25,
        descriptionRatio: 0.25,
        interiorityRatio: 0.25,
        movesPlot: false,
        changesCharacter: false,
      },
      projection: projection({
        narrative: {
          chapterOrder: 2,
          scene: {
            sceneId: "scene-current",
            sequence: 1,
            goal: "reveal the rule change",
            conflictIntensity: 0.6,
            tension: { start: 0.2, end: 0.6, peak: 0.8 },
            composition: {
              informationRatio: 0.25,
              dialogueRatio: 0.25,
              descriptionRatio: 0.25,
              innerActivityRatio: 0.25,
              measuredUnits: CURRENT_SCENE_TEXT.length,
            },
            plotlineIds: [],
            characterIds: [],
            movesPlot: false,
            changesCharacter: false,
            functionTags: ["revelation"],
            setupBeatIds: [],
            climax: { isClimax: false, requiredSetupBeatIds: [] },
          },
          plotline: null,
        },
      }),
    }),
  ]);
}

function characterStateCandidate(
  content: string,
  evidenceText: string,
  value: "alive" | "dead",
  order: number,
): ContinuousStoryStateModelCandidate {
  return candidate({
    factType: "character_state",
    contentText: evidenceText,
    content,
    evidenceText,
    state: { state: value, effectiveAt: null },
    projection: projection({
      validation: {
        factType: "character_life_status",
        subjectId: null,
        attributeKey: "life-status",
        value,
        effectiveRange: { startOrder: order, endOrder: null },
      },
    }),
  });
}

function povCandidate(
  content: string,
  evidenceText: string,
  knowledgeStatus: "known" | "unknown",
  order: number,
): ContinuousStoryStateModelCandidate {
  return candidate({
    factType: "pov_knowledge",
    contentText: evidenceText,
    content,
    evidenceText,
    state: {
      knowledgeStatus,
      information: "observatory key location",
      acquiredAt: null,
      informationSource: "explicit narration",
    },
    projection: projection({
      validation: {
        factType: "character_knowledge",
        subjectId: null,
        attributeKey: "observatory-key-location",
        value: knowledgeStatus,
        effectiveRange: { startOrder: order, endOrder: null },
      },
      pov: {
        characterId: null,
        attributeKey: "observatory-key-location",
        knowledgeStatus,
        effectiveRange: { startOrder: order, endOrder: null },
        mode: "third_person_limited",
      },
    }),
  });
}

function voiceCandidate(
  content: string,
  dialogues: readonly string[],
  evidenceText: string,
): ContinuousStoryStateModelCandidate {
  return candidate({
    factType: "character_voice",
    contentText: "Aria voice evidence",
    content,
    evidenceText,
    state: {
      commonWords: ["Captain", "please", "Perhaps", "quiet", "road"],
      sentenceLength: "mixed",
      addressHabits: ["Captain"],
      emotionExpression: "restrained",
      politeness: "high",
      directness: "indirect",
      usesMetaphor: false,
      dialect: null,
      sampleQuote: dialogues[0] ?? evidenceText,
    },
    projection: projection({
      voice: {
        characterId: null,
        featureCatalog: {
          commonTermCandidates: ["Captain", "please", "Perhaps", "quiet", "road"],
          emotionMarkers: ["furious"],
          politeMarkers: ["please", "thank you"],
          casualMarkers: ["Hey", "Stop"],
          directMarkers: ["act now", "open"],
          indirectMarkers: ["Perhaps", "Maybe"],
          metaphorMarkers: ["like", "as if"],
          dialectMarkers: ["y'all", "ain't"],
          addressTerms: [],
        },
        dialogues: dialogues.map((dialogue, index) => {
          const span = exactSpan(content, dialogue);
          return Object.freeze({
            ...span,
            addresseeCharacterId: null,
            typical: index === 0,
          });
        }),
      },
    }),
  });
}

function projection(
  partial: Partial<ContinuousStoryStateProjection>,
): ContinuousStoryStateProjection {
  return Object.freeze({
    validation: null,
    pov: null,
    voice: null,
    narrative: null,
    ...partial,
  });
}

function candidate(
  input: Readonly<{
    factType: ContinuousStoryStateModelCandidate["factType"];
    contentText: string;
    content: string;
    evidenceText: string;
    state: Readonly<Record<string, StoryValue>>;
    projection: ContinuousStoryStateProjection;
    subject?: ContinuousStoryStateModelCandidate["subject"];
  }>,
): ContinuousStoryStateModelCandidate {
  return Object.freeze({
    factType: input.factType,
    contentText: input.contentText,
    confidence: 0.96,
    subject:
      input.subject === undefined
        ? {
            kind: "character" as const,
            entityKey: null,
            canonicalName: CHARACTER_NAME,
            aliases: Object.freeze([]),
          }
        : input.subject,
    state: input.state,
    evidence: exactSpan(input.content, input.evidenceText),
    effectiveAt: null,
    invalidatedAt: null,
    projection: input.projection,
  });
}

function exactSpan(content: string, excerpt: string) {
  const start = content.indexOf(excerpt);
  if (start < 0) throw new Error(`Missing test evidence: ${excerpt}`);
  return Object.freeze({ start, end: start + excerpt.length, excerpt });
}

async function confirmChapterFacts(
  runtime: DesktopRuntime,
  extraction: ContinuousStoryStateExtractionService,
  projectId: string,
  chapterId: string,
  factTypes: ReadonlySet<string>,
  lock = false,
): Promise<void> {
  const facts = unwrap(await runtime.story.facts.listByProjectId(projectId as never));
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    if (
      snapshot.source.chapterId !== chapterId ||
      !factTypes.has(snapshot.factType) ||
      snapshot.status === "formal"
    ) {
      continue;
    }
    unwrap(
      await extraction.confirmChange({
        factId: snapshot.id,
        actorId: runtime.story.actorId,
        expectedRevision: snapshot.revision,
        ...(lock ? { lock: true } : {}),
        humanConfirmed: true,
      }),
    );
  }
}

function unwrap<Value>(
  result: Readonly<{ ok: true; value: Value } | { ok: false; error: unknown }>,
): Value {
  if (!result.ok) throw result.error;
  return result.value;
}
