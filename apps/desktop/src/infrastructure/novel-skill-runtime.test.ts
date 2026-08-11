import { describe, expect, it, vi } from "vitest";
import type { NovelSkillDefinition, ProjectNovelSkillBinding } from "@inkshadow/ai-core";
import { parseIsoUtcTimestamp } from "@inkshadow/domain";

import {
  BrowserUnavailableNovelSkillRuntime,
  DEFAULT_NOVEL_SKILL_TOKEN_BUDGET,
  TauriNovelSkillRuntime,
  type NovelSkillRuntimePersistence,
} from "./novel-skill-runtime";
import type {
  CommitNovelSkillInvocationInput,
  NovelSkillInvocationSnapshotRecord,
} from "./novel-skill-sqlite-store";

const parsedNow = parseIsoUtcTimestamp("2026-08-10T01:02:03.000Z");
if (!parsedNow.ok) throw parsedNow.error;
const NOW = parsedNow.value;
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const TRACE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const INVOCATION_ID = "019f9f4a-b3c7-7350-9226-000000000003";

describe("Novel Skill desktop runtime", () => {
  it("bootstraps idempotently, keeps every method off, and applies only explicit author opt-in", async () => {
    const persistence = new MemoryNovelSkillPersistence();
    const runtime = new TauriNovelSkillRuntime(persistence, { now: () => NOW });

    await expect(runtime.initialize()).resolves.toEqual({ status: "ready", reason: null });
    await expect(runtime.initialize()).resolves.toEqual({ status: "ready", reason: null });
    expect(persistence.definitions.size).toBe(12);

    const initial = await runtime.listProjectState(PROJECT_ID);
    expect(initial.evaluationStatus).toBe("not_evaluated");
    expect(initial.methods.every(({ enabled }) => !enabled)).toBe(true);
    await expect(
      runtime.getReservedTokens({ projectId: PROJECT_ID, taskType: "continuation" }),
    ).resolves.toBe(0);

    const scene = initial.methods.find(({ displayName }) => displayName === "场景推进");
    if (scene === undefined) throw new Error("Missing scene method fixture.");
    const enabled = await runtime.setMethodEnabled(PROJECT_ID, scene.skillId, true);
    expect(enabled.methods.find(({ skillId }) => skillId === scene.skillId)?.enabled).toBe(true);
    await expect(
      runtime.getReservedTokens({ projectId: PROJECT_ID, taskType: "continuation" }),
    ).resolves.toBe(DEFAULT_NOVEL_SKILL_TOKEN_BUDGET);

    const prepared = await runtime.prepareInvocation({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      availableContextLayers: ["current_task", "scene_goal"],
    });
    expect(prepared.status).toBe("prepared_applied");
    expect(prepared.promptSection).toContain("<novel_method>");
    expect(prepared.methods.find(({ displayName }) => displayName === "场景推进")).toMatchObject({
      included: true,
      version: "1.0.0",
    });

    const first = await runtime.commitBeforeDispatch({
      snapshotId: "019f9f4a-b3c7-7350-9226-000000000004",
      projectId: PROJECT_ID,
      contextTraceId: TRACE_ID,
      modelInvocationId: INVOCATION_ID,
      taskType: "continuation",
      invocationMode: "draft",
      preparation: prepared,
      createdAt: NOW,
    });
    const second = await runtime.commitBeforeDispatch({
      snapshotId: "019f9f4a-b3c7-7350-9226-000000000005",
      projectId: PROJECT_ID,
      contextTraceId: "019f9f4a-b3c7-7350-9226-000000000006",
      modelInvocationId: "019f9f4a-b3c7-7350-9226-000000000007",
      taskType: "continuation",
      invocationMode: "draft",
      preparation: prepared,
      createdAt: NOW,
    });
    expect(first?.methods.find(({ displayName }) => displayName === "场景推进")?.included).toBe(
      true,
    );
    expect(second).not.toBeNull();
    expect(persistence.commits.map(({ snapshotId }) => snapshotId)).toEqual([
      "019f9f4a-b3c7-7350-9226-000000000004",
      "019f9f4a-b3c7-7350-9226-000000000005",
    ]);

    const disabled = await runtime.setMethodEnabled(PROJECT_ID, scene.skillId, false);
    expect(disabled.methods.find(({ skillId }) => skillId === scene.skillId)?.enabled).toBe(false);
    expect(persistence.bindings.get(scene.skillId)?.revision).toBe(2);
  });

  it("uses lossless semantic-version ordering for very large version components", async () => {
    const persistence = new MemoryNovelSkillPersistence();
    const runtime = new TauriNovelSkillRuntime(persistence, { now: () => NOW });
    await runtime.initialize();
    const scene = [...persistence.definitions.values()].find(
      ({ skillId }) => skillId === "core.scene_craft",
    );
    if (scene === undefined) throw new Error("Missing scene method fixture.");
    persistence.putDefinition({
      ...scene,
      version: "9007199254740992.0.0",
      definitionHash: "a".repeat(64),
    });
    persistence.putDefinition({
      ...scene,
      version: "9007199254740993.0.0",
      definitionHash: "b".repeat(64),
    });

    const state = await runtime.listProjectState(PROJECT_ID);
    expect(state.methods.find(({ skillId }) => skillId === scene.skillId)?.version).toBe(
      "9007199254740993.0.0",
    );
  });

  it("keeps browser development explicitly unavailable without prompt or receipt fabrication", async () => {
    const runtime = new BrowserUnavailableNovelSkillRuntime();
    const commit = vi.spyOn(runtime, "commitBeforeDispatch");

    const prepared = await runtime.prepareInvocation({
      projectId: PROJECT_ID,
      taskType: "continuation",
      invocationMode: "draft",
      availableContextLayers: ["current_task"],
    });
    expect(prepared).toMatchObject({
      status: "not_applied",
      notAppliedReason: "browser_demo",
      promptSection: null,
      compiled: null,
    });
    await expect(
      runtime.getReservedTokens({ projectId: PROJECT_ID, taskType: "continuation" }),
    ).resolves.toBe(0);
    await expect(runtime.findInvocationByContextTrace(TRACE_ID)).resolves.toMatchObject({
      status: "unavailable",
      invocation: null,
    });
    expect(commit).not.toHaveBeenCalled();
  });
});

class MemoryNovelSkillPersistence implements NovelSkillRuntimePersistence {
  readonly definitions = new Map<string, NovelSkillDefinition>();
  readonly bindings = new Map<string, ProjectNovelSkillBinding>();
  readonly commits: CommitNovelSkillInvocationInput[] = [];
  readonly snapshots = new Map<string, NovelSkillInvocationSnapshotRecord>();

  public insertDefinition(value: NovelSkillDefinition): Promise<NovelSkillDefinition> {
    this.putDefinition(value);
    return Promise.resolve(value);
  }

  public putDefinition(value: NovelSkillDefinition): void {
    this.definitions.set(`${value.skillId}@${value.version}`, value);
  }

  public listDefinitions(): Promise<readonly NovelSkillDefinition[]> {
    return Promise.resolve([...this.definitions.values()]);
  }

  public listBindings(projectId: string): Promise<readonly ProjectNovelSkillBinding[]> {
    return Promise.resolve(
      [...this.bindings.values()].filter((binding) => binding.projectId === projectId),
    );
  }

  public saveBinding(
    value: ProjectNovelSkillBinding,
    expectedRevision: number,
  ): Promise<ProjectNovelSkillBinding> {
    const current = this.bindings.get(value.skillId);
    expect(current?.revision ?? 0).toBe(expectedRevision);
    this.bindings.set(value.skillId, value);
    return Promise.resolve(value);
  }

  public commitInvocationBeforeDispatch(
    input: CommitNovelSkillInvocationInput,
  ): Promise<NovelSkillInvocationSnapshotRecord> {
    this.commits.push(input);
    const snapshot: NovelSkillInvocationSnapshotRecord = Object.freeze({
      id: input.snapshotId,
      projectId: input.projectId,
      contextTraceId: input.contextTraceId,
      modelInvocationId: input.modelInvocationId,
      taskType: input.taskType,
      invocationMode: input.invocationMode,
      compilerVersion: input.compiled.compilerVersion,
      maximumSkillTokens: input.compiled.configuration.maximumSkillTokens,
      usedSkillTokens: input.compiled.usedSkillTokens,
      discardedSkillTokens: input.compiled.discardedSkillTokens,
      selectionHash: input.compiled.selectionHash,
      configuration: input.compiled.configuration,
      items: input.compiled.items,
      createdAt: input.createdAt,
    });
    this.snapshots.set(input.contextTraceId, snapshot);
    return Promise.resolve(snapshot);
  }

  public findInvocationSnapshotByContextTrace(
    contextTraceId: string,
  ): Promise<NovelSkillInvocationSnapshotRecord | null> {
    return Promise.resolve(this.snapshots.get(contextTraceId) ?? null);
  }
}
