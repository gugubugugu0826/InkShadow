import { describe, expect, it } from "vitest";

import {
  IDEATION_STEP_KEYS,
  IdeationApplicationService,
  IdeationDraft,
  StoryCoreError,
  err,
  ok,
  type CommitIdeationProjectInput,
  type IdeationDraftRepository,
  type IdeationProjectCommitUnitOfWork,
  type ProjectSeed,
  type Result,
} from "../src/index.js";
import { ManualClock, SequenceUuidV7Generator, unwrap, uuid } from "./helpers.js";

const T0 = "2026-07-27T00:00:00.000Z";
const T1 = "2026-07-27T00:01:00.000Z";
const T2 = "2026-07-27T00:02:00.000Z";

describe("ideation aggregate", () => {
  it("maps the quick-book contract into canonical steps without inventing hidden values", () => {
    const draft = unwrap(
      IdeationDraft.create({
        id: uuid(1),
        mode: "quick",
        projectName: "雾港来信",
        now: T0,
        quickSeed: {
          idea: "失忆邮差每天收到未来寄来的信。",
          genre: "悬疑幻想",
          targetWords: 320_000,
          protagonistType: "谨慎但执拗的普通人",
          style: "克制、带黑色幽默",
        },
      }),
    );

    const steps = new Map(draft.toSnapshot().steps.map((step) => [step.key, step]));
    expect(steps.get("premise")).toMatchObject({
      state: "completed",
      origin: "quick_seed",
      value: "失忆邮差每天收到未来寄来的信。",
    });
    expect(steps.get("target_audience")).toMatchObject({
      state: "pending",
      value: "",
    });
    expect(steps.get("output_spec")?.value).toBe("目标字数：320,000；风格：克制、带黑色幽默");

    const unfinished = draft.buildProjectSeed();
    expect(unfinished.ok).toBe(false);
    if (!unfinished.ok) {
      expect(unfinished.error.code).toBe("HUMAN_DECISION_REQUIRED");
    }
  });

  it("keeps suggestions isolated and prevents regeneration from changing a locked answer", () => {
    const draft = unwrap(
      IdeationDraft.create({
        id: uuid(10),
        mode: "guided",
        projectName: "城门之外",
        now: T0,
      }),
    );
    const suggested = unwrap(
      draft.offerSuggestion({
        step: "genre",
        suggestionId: uuid(11),
        content: "东方奇幻",
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect(suggested.toSnapshot().steps[0]).toMatchObject({
      state: "pending",
      value: "",
      suggestion: { id: uuid(11), content: "东方奇幻" },
    });

    const accepted = unwrap(
      suggested.acceptSuggestion({
        step: "genre",
        suggestionId: uuid(11),
        expectedRevision: 2,
        now: T1,
      }),
    );
    const locked = unwrap(
      accepted.lockStep({
        step: "genre",
        expectedRevision: 3,
        now: T2,
      }),
    );
    const regenerated = locked.offerSuggestion({
      step: "genre",
      suggestionId: uuid(12),
      content: "覆盖锁定内容",
      expectedRevision: 4,
      now: T2,
    });
    expect(regenerated.ok).toBe(false);
    if (!regenerated.ok) {
      expect(regenerated.error.code).toBe("IDEATION_STEP_LOCKED");
    }
    expect(locked.toSnapshot().steps[0]).toMatchObject({
      value: "东方奇幻",
      locked: true,
      suggestion: null,
    });
  });

  it("supports back navigation, manual edits, skip, unlock, and stale revision rejection", () => {
    const initial = unwrap(
      IdeationDraft.create({
        id: uuid(20),
        mode: "guided",
        projectName: "回声",
        now: T0,
      }),
    );
    const moved = unwrap(
      initial.goToStep({
        step: "premise",
        expectedRevision: 1,
        now: T1,
      }),
    );
    const edited = unwrap(
      moved.updateStep({
        step: "premise",
        value: "所有回声都会在七年后成为事实。",
        expectedRevision: 2,
        now: T1,
      }),
    );
    const skipped = unwrap(
      edited.skipStep({
        step: "target_audience",
        expectedRevision: 3,
        now: T2,
      }),
    );
    const returned = unwrap(
      skipped.goToStep({
        step: "genre",
        expectedRevision: 4,
        now: T2,
      }),
    );
    expect(returned.toSnapshot()).toMatchObject({
      currentStep: "genre",
      revision: 5,
    });
    expect(
      returned.updateStep({
        step: "genre",
        value: "都市幻想",
        expectedRevision: 4,
        now: T2,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "STORY_REVISION_CONFLICT" },
    });
  });
});

describe("ideation application service", () => {
  it("autosaves each decision and finalizes all project seed outputs atomically", async () => {
    const store = new InMemoryIdeationStore();
    const clock = new ManualClock(T0);
    const service = new IdeationApplicationService({
      drafts: store.drafts,
      projects: store.projects,
      clock,
      ids: new SequenceUuidV7Generator(100),
    });
    let draft = unwrap(await service.createGuided({ projectName: "纸月" }));

    clock.set(T1);
    for (const [index, step] of IDEATION_STEP_KEYS.entries()) {
      const result = await service.apply({
        draftId: draft.id,
        expectedRevision: draft.revision,
        change:
          index % 3 === 0
            ? { kind: "skip", step }
            : { kind: "update", step, value: `${step} 的人工决定` },
      });
      draft = unwrap(result);
    }
    expect(unwrap(await service.listActive())).toHaveLength(1);

    clock.set(T2);
    const completed = unwrap(
      await service.finalize({
        draftId: draft.id,
        expectedRevision: draft.revision,
      }),
    );
    expect(completed.draft.status).toBe("finalized");
    expect(completed.seed).toMatchObject({
      sourceDraftId: draft.id,
      projectName: "纸月",
      targetAudience: "target_audience 的人工决定",
      protagonistDrive: "",
      worldSkeleton: "world_skeleton 的人工决定",
    });
    expect(store.createdProjects.get(completed.projectId)).toEqual(completed.seed);
    expect(unwrap(await service.listActive())).toHaveLength(0);
    expect(unwrap(await service.findById(draft.id))?.projectId).toBe(completed.projectId);
  });

  it("leaves the active draft and project set untouched when atomic creation fails", async () => {
    const store = new InMemoryIdeationStore();
    const service = new IdeationApplicationService({
      drafts: store.drafts,
      projects: store.projects,
      clock: new ManualClock(T0),
      ids: new SequenceUuidV7Generator(300),
    });
    let draft = unwrap(await service.createGuided({ projectName: "不完整事务" }));
    for (const step of IDEATION_STEP_KEYS) {
      draft = unwrap(
        await service.apply({
          draftId: draft.id,
          expectedRevision: draft.revision,
          change: { kind: "skip", step },
        }),
      );
    }
    store.failNextProjectCommit = true;

    const failed = await service.finalize({
      draftId: draft.id,
      expectedRevision: draft.revision,
    });
    expect(failed.ok).toBe(false);
    expect(store.createdProjects.size).toBe(0);
    expect(unwrap(await service.findById(draft.id))?.status).toBe("active");
  });
});

class InMemoryIdeationStore {
  private readonly stored = new Map<string, IdeationDraft>();

  public readonly createdProjects = new Map<string, ProjectSeed>();

  public failNextProjectCommit = false;

  public readonly drafts: IdeationDraftRepository = {
    create: (draft) => {
      if (this.stored.has(draft.id)) {
        return Promise.resolve(repositoryError("Ideation draft already exists."));
      }
      this.stored.set(draft.id, cloneDraft(draft));
      return Promise.resolve(ok(undefined));
    },
    findById: (id) => {
      const draft = this.stored.get(id);
      return Promise.resolve(ok(draft === undefined ? null : cloneDraft(draft)));
    },
    listActive: () =>
      Promise.resolve(
        ok(
          Object.freeze(
            [...this.stored.values()]
              .filter(({ status }) => status === "active")
              .sort((left, right) =>
                right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt),
              )
              .map(cloneDraft),
          ),
        ),
      ),
    save: (draft, expectedRevision) => {
      const current = this.stored.get(draft.id);
      if (current === undefined) {
        return Promise.resolve(repositoryError("Ideation draft is missing."));
      }
      if (current.revision !== expectedRevision) {
        return Promise.resolve(revisionConflict(expectedRevision, current.revision));
      }
      this.stored.set(draft.id, cloneDraft(draft));
      return Promise.resolve(ok(undefined));
    },
  };

  public readonly projects: IdeationProjectCommitUnitOfWork = {
    commit: (input) => this.commitProject(input),
  };

  private commitProject(input: CommitIdeationProjectInput): Promise<Result<void, StoryCoreError>> {
    if (this.failNextProjectCommit) {
      this.failNextProjectCommit = false;
      return Promise.resolve(repositoryError("Injected project creation failure."));
    }
    const current = this.stored.get(input.draft.id);
    if (current === undefined) {
      return Promise.resolve(repositoryError("Ideation draft is missing."));
    }
    if (current.revision !== input.expectedDraftRevision) {
      return Promise.resolve(revisionConflict(input.expectedDraftRevision, current.revision));
    }
    if (
      input.draft.status !== "finalized" ||
      input.draft.projectId !== input.projectId ||
      input.seed.sourceDraftId !== input.draft.id ||
      this.createdProjects.has(input.projectId)
    ) {
      return Promise.resolve(repositoryError("Atomic ideation project input is inconsistent."));
    }
    this.stored.set(input.draft.id, cloneDraft(input.draft));
    this.createdProjects.set(input.projectId, input.seed);
    return Promise.resolve(ok(undefined));
  }
}

function cloneDraft(draft: IdeationDraft): IdeationDraft {
  return unwrap(IdeationDraft.rehydrate(draft.toSnapshot()));
}

function revisionConflict(
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: "Stored ideation draft changed.",
      details: { expectedRevision, actualRevision },
    }),
  );
}

function repositoryError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REPOSITORY_ERROR",
      message,
      retryable: true,
      actions: ["RETRY"],
    }),
  );
}
