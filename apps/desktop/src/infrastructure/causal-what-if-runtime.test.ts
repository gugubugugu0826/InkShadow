import type { CausalEventGraphInput } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it } from "vitest";

import { CausalWhatIfSimulationService } from "./causal-what-if-simulation-service";
import type { CausalWhatIfModelHubError } from "./model-hub-causal-what-if-model";
import { createDevelopmentRuntime } from "./runtime";

describe("causal What-if runtime wiring", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("exposes a callable service and fails explicitly instead of faking a browser model result", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect(runtime.story.causalWhatIf).toBeInstanceOf(CausalWhatIfSimulationService);

    const project = await runtime.useCases.createProject.execute({ name: "剧情试演 runtime" });
    if (!project.ok) throw project.error;
    const content = "主角在旧屋拿到钥匙。";
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content,
    });
    if (!chapter.ok) throw chapter.error;
    const chapterSnapshot = chapter.value.chapter.toSnapshot();
    const version = await runtime.repositories.chapterVersions.findVersionById(
      chapterSnapshot.currentVersionId,
    );
    if (!version.ok) throw version.error;
    if (version.value === null) throw new Error("Expected the current chapter version.");
    const versionSnapshot = version.value.toSnapshot();
    const sourceEventId = runtime.ids.next();

    const graph: CausalEventGraphInput = {
      events: [
        {
          id: sourceEventId,
          projectId: project.value.id,
          branchId: "main",
          status: "confirmed",
          participantCharacterIds: [],
          narrativeTime: { order: 1, label: "第一天" },
          location: { locationId: "old-house", label: "旧屋" },
          prerequisites: [],
          eventText: "主角拿到钥匙",
          resultText: "主角可以尝试打开密室",
          characterStateChanges: [],
          relationshipChanges: [],
          itemChanges: [],
          informedCharacterIds: [],
          foreshadowProgress: [],
          downstreamEventIds: [],
          evidence: {
            id: runtime.ids.next(),
            chapterId: chapterSnapshot.id,
            chapterVersionId: versionSnapshot.id,
            contentHash: versionSnapshot.contentChecksum,
            locator: `chapter:0-${String(content.length)}`,
            excerpt: content,
            startOffset: 0,
            endOffset: content.length,
            sourceLength: content.length,
          },
        },
      ],
      relations: [],
    };
    await runtime.story.causalGraph.replace({
      projectId: project.value.id,
      branchId: "main",
      graph,
    });

    await expect(
      runtime.story.causalWhatIf.simulate({
        projectId: project.value.id,
        sourceEventId,
        hypothesis: "如果主角没有拿到钥匙？",
      }),
    ).rejects.toMatchObject({
      code: "CAUSAL_WHAT_IF_MODEL_UNAVAILABLE",
      sourceCode: "MODEL_HUB_GATEWAY_UNAVAILABLE",
      dispatched: false,
    } satisfies Partial<CausalWhatIfModelHubError>);
    await expect(runtime.story.causalWhatIf.list(project.value.id)).resolves.toHaveLength(0);
  });
});
