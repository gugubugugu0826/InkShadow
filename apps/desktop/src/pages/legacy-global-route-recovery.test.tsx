// @vitest-environment jsdom

import { ToastProvider } from "@inkshadow/ui";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  CreativeJourneyRecord,
  CreativeJourneyTurnRecord,
} from "../infrastructure/creative-journey-store";
import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { ProjectsPage } from "./projects-page";
import { StartPage } from "./start-page";

describe("旧数据全局页面恢复边界", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("三槽仍待处理但调用已全部失败时，作品首页和项目列表仍可读取空章节版本", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const projectResult = await runtime.useCases.createProject.execute({
      name: "终态漂移恢复夹具",
    });
    if (!projectResult.ok) throw projectResult.error;
    const chapterResult = await runtime.useCases.createChapter.execute({
      projectId: projectResult.value.id,
      title: "第一章",
      content: "",
    });
    if (!chapterResult.ok) throw chapterResult.error;

    await runtime.modelHub.saveConnection({
      id: "terminal-drift-local",
      providerKind: "ollama",
      displayName: "本地恢复夹具",
      credentialState: "missing",
      expectedRevision: null,
    });
    const requestIds = [runtime.ids.next(), runtime.ids.next(), runtime.ids.next()] as const;
    const terminalCodes = [
      "OPENING_NOT_DISPATCHED",
      "OPENING_NOT_DISPATCHED",
      "IDEA_OPERATION_SUPERSEDED",
    ] as const;
    for (const [index, requestId] of requestIds.entries()) {
      const errorCode = terminalCodes[index];
      if (errorCode === undefined) throw new Error("终态漂移夹具缺少调用错误码。");
      const started = await runtime.modelHub.startInvocation({
        id: requestId,
        task: "book_start_guidance",
        connectionId: "terminal-drift-local",
        providerKindSnapshot: "ollama",
        modelIdSnapshot: "local-novel",
        routeReason: "user_override",
        attempt: 1,
        privacyPolicy: "cloud_allowed",
        dataDestination: "local",
      });
      await runtime.modelHub.finishInvocation({
        id: requestId,
        status: "failed",
        errorCode,
        expectedRevision: started.revision,
      });
    }

    const now = runtime.clock.now();
    const journeyId = runtime.ids.next();
    const batchId = runtime.ids.next();
    const snapshot = Object.freeze({
      version: 1,
      idea: "终态漂移夹具",
      preview: "",
      answers: Object.freeze({}),
      skippedQuestionKeys: Object.freeze([]),
      questionHistory: Object.freeze([]),
      pendingRequestId: requestIds[0],
      openingBatchId: batchId,
      openingSuggestions: Object.freeze(
        requestIds.map((id, index) =>
          Object.freeze({
            id,
            requestId: id,
            batchId,
            slotNumber: index + 1,
            openingAngle: `slot_${String(index + 1)}`,
            text: "",
            status: "pending",
            dispatchState: "planned",
          }),
        ),
      ),
    });
    const journey: CreativeJourneyRecord = Object.freeze({
      id: journeyId,
      kind: "idea",
      status: "active",
      currentState: "generation_pending",
      projectId: projectResult.value.id,
      chapterId: chapterResult.value.chapter.id,
      candidateId: null,
      revision: 1,
      snapshot,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const turn: CreativeJourneyTurnRecord = Object.freeze({
      id: runtime.ids.next(),
      journeyId,
      sequence: 1,
      kind: "idea",
      questionKey: null,
      generationSource: null,
      providerId: null,
      modelId: null,
      taskKey: "opening_guidance",
      requestId: requestIds[0],
      snapshot: Object.freeze({ status: "pending", batchId }),
      createdAt: now,
    });
    await runtime.creativeJourneys.create(journey, turn);

    const start = renderPage(<StartPage />, "/start", runtime);
    expect(await screen.findByRole("heading", { name: "回到刚才停下的地方" })).toBeVisible();
    expect(screen.getByText("终态漂移恢复夹具")).toBeVisible();
    start.unmount();

    renderPage(<ProjectsPage />, "/projects", runtime);
    expect(
      await screen.findByRole("heading", { name: "终态漂移恢复夹具", level: 2 }),
    ).toBeVisible();

    const versions = await runtime.repositories.chapterVersions.listByChapterId(
      chapterResult.value.chapter.id,
    );
    expect(versions.ok && versions.value).toHaveLength(1);
    expect(versions.ok ? versions.value[0]?.toSnapshot().content : null).toBe("");
    const invocations = await Promise.all(
      requestIds.map((id) => runtime.modelHub.findInvocation(id)),
    );
    for (const [index, errorCode] of terminalCodes.entries()) {
      expect(invocations[index]).toMatchObject({ status: "failed", errorCode });
    }
  });
});

function renderPage(
  page: ReactElement,
  route: string,
  runtime: ReturnType<typeof createDevelopmentRuntime>,
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>{page}</ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
