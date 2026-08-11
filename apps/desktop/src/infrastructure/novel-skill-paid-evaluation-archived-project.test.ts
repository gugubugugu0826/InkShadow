import type { ProjectRepository, ProjectListQuery } from "@inkshadow/application";
import type { SqlExecutor, SqlPrimitive, TransactionExecutor } from "@inkshadow/data";
import {
  Project,
  ok,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AppError,
  type Clock,
  type IsoUtcTimestamp,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import {
  NovelSkillPaidEvaluationArchivedProjectError,
  SqliteArchivedEvaluationProjectPort,
} from "./novel-skill-paid-evaluation-archived-project";
import {
  NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE,
  type NovelSkillPaidEvaluationArchivedProjectIdentity,
} from "./novel-skill-paid-evaluation-preparation";

const NOW = timestamp("2026-08-11T01:02:03.000Z");
const LATER = timestamp("2026-08-11T01:03:03.000Z");
const RETENTION = timestamp("2026-09-11T01:02:03.000Z");
const PROJECT_ID = uuid("019f9f4a-b3c7-7350-9226-066f57e1e2a3");

const IDENTITY: NovelSkillPaidEvaluationArchivedProjectIdentity = Object.freeze({
  projectId: PROJECT_ID,
  ownerRunId: "019f9f4a-b3c7-7350-9226-066f57e1e2b4",
  displayName: "InkShadow Novel Skill paid evaluation · test run",
  purpose: NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE,
});

const EMPTY_COUNTS: ContentCountRow = Object.freeze({
  chapters: 0,
  story_facts: 0,
  project_seeds: 0,
  planning_candidates: 0,
  writing_preferences: 0,
  settings_receipts: 0,
  skill_bindings: 0,
});

describe("SqliteArchivedEvaluationProjectPort", () => {
  it("creates, verifies, and archives a dedicated empty project on first preparation", async () => {
    const projects = new FakeProjectRepository();
    const executor = new ContentCountExecutor();
    const port = createPort(projects, executor);

    const result = await port.ensureDedicatedArchivedEmptyProject(request());

    expect(result).toEqual({
      projectId: PROJECT_ID,
      displayName: IDENTITY.displayName,
      purpose: NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE,
      ownerRunId: IDENTITY.ownerRunId,
      status: "archived",
      archivedAt: NOW,
      trashedAt: null,
      contentCounts: {
        chapters: 0,
        storyFacts: 0,
        projectSeeds: 0,
        planningCandidates: 0,
        writingPreferences: 0,
        settingsReceipts: 0,
        skillBindings: 0,
      },
    });
    expect(projects.createCalls).toBe(1);
    expect(projects.saveCalls).toBe(1);
    expect(projects.stored(PROJECT_ID)?.status).toBe("archived");
    expect(executor.selectCalls).toBe(2);
  });

  it("resumes safely when a crash left the deterministic project active", async () => {
    const active = activeProject(IDENTITY.displayName);
    const projects = new FakeProjectRepository([active]);
    const port = createPort(projects, new ContentCountExecutor());

    const result = await port.ensureDedicatedArchivedEmptyProject(request());

    expect(result.status).toBe("archived");
    expect(result.archivedAt).toBe(NOW);
    expect(projects.createCalls).toBe(0);
    expect(projects.saveCalls).toBe(1);
    expect(projects.savedExpectedRevisions).toEqual([active.revision]);
  });

  it("re-reads and verifies an already archived project without another write", async () => {
    const archived = archive(activeProject(IDENTITY.displayName));
    const projects = new FakeProjectRepository([archived]);
    const executor = new ContentCountExecutor();
    const port = createPort(projects, executor);

    const first = await port.ensureDedicatedArchivedEmptyProject(request());
    const second = await port.ensureDedicatedArchivedEmptyProject(request());

    expect(first).toEqual(second);
    expect(first.archivedAt).toBe(NOW);
    expect(projects.createCalls).toBe(0);
    expect(projects.saveCalls).toBe(0);
    expect(projects.findCalls).toBe(2);
    expect(executor.selectCalls).toBe(4);
  });

  it("fails closed when the deterministic project is trashed", async () => {
    const trashed = trash(activeProject(IDENTITY.displayName));
    const projects = new FakeProjectRepository([trashed]);

    await expect(
      createPort(projects, new ContentCountExecutor()).ensureDedicatedArchivedEmptyProject(
        request(),
      ),
    ).rejects.toMatchObject({
      name: "NovelSkillPaidEvaluationArchivedProjectError",
      code: "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT",
    });
    expect(projects.saveCalls).toBe(0);
  });

  it("fails closed when the deterministic id is occupied by a differently named project", async () => {
    const projects = new FakeProjectRepository([activeProject("A real user project")]);

    await expect(
      createPort(projects, new ContentCountExecutor()).ensureDedicatedArchivedEmptyProject(
        request(),
      ),
    ).rejects.toBeInstanceOf(NovelSkillPaidEvaluationArchivedProjectError);
    await expect(
      createPort(projects, new ContentCountExecutor()).ensureDedicatedArchivedEmptyProject(
        request(),
      ),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT" });
    expect(projects.createCalls).toBe(0);
    expect(projects.saveCalls).toBe(0);
  });

  it("fails closed when the reserved name belongs to another project", async () => {
    const projects = new FakeProjectRepository([], true);

    await expect(
      createPort(projects, new ContentCountExecutor()).ensureDedicatedArchivedEmptyProject(
        request(),
      ),
    ).rejects.toMatchObject({ code: "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT" });
    expect(projects.createCalls).toBe(0);
    expect(projects.saveCalls).toBe(0);
  });

  it.each([
    "chapters",
    "story_facts",
    "project_seeds",
    "planning_candidates",
    "writing_preferences",
    "settings_receipts",
    "skill_bindings",
  ] as const)("fails closed when %s contains project data", async (field) => {
    const archived = archive(activeProject(IDENTITY.displayName));
    const projects = new FakeProjectRepository([archived]);
    const executor = new ContentCountExecutor({ ...EMPTY_COUNTS, [field]: 1 });

    await expect(
      createPort(projects, executor).ensureDedicatedArchivedEmptyProject(request()),
    ).rejects.toMatchObject({
      code: "NOVEL_SKILL_PAID_EVALUATION_PROJECT_NOT_EMPTY",
    });
    expect(projects.createCalls).toBe(0);
    expect(projects.saveCalls).toBe(0);
    expect(executor.selectCalls).toBe(1);
  });

  it("coalesces concurrent calls across port instances so the project is created once", async () => {
    const projects = new FakeProjectRepository();
    const executor = new ContentCountExecutor();
    const firstPort = createPort(projects, executor);
    const secondPort = createPort(projects, executor);

    const [first, second, third] = await Promise.all([
      firstPort.ensureDedicatedArchivedEmptyProject(request()),
      secondPort.ensureDedicatedArchivedEmptyProject(request()),
      firstPort.ensureDedicatedArchivedEmptyProject(request()),
    ]);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(projects.findCalls).toBe(1);
    expect(projects.createCalls).toBe(1);
    expect(projects.saveCalls).toBe(1);
    expect(executor.selectCalls).toBe(2);
  });
});

function request() {
  return Object.freeze({ ...IDENTITY, requestedAt: NOW });
}

function createPort(projects: ProjectRepository, executor: SqlExecutor) {
  return new SqliteArchivedEvaluationProjectPort({
    projects,
    executor,
    clock: Object.freeze<Clock>({ now: () => NOW }),
  });
}

function activeProject(name: string): Project {
  return expectOk(Project.create({ id: PROJECT_ID, name, now: NOW }));
}

function archive(project: Project): Project {
  return expectOk(project.archive(NOW));
}

function trash(project: Project): Project {
  return expectOk(project.trash({ now: LATER, retentionUntil: RETENTION }));
}

function expectOk<T>(result: Result<T, AppError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function timestamp(value: string): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(value));
}

function uuid(value: string): UuidV7 {
  return expectOk(parseUuidV7(value));
}

class FakeProjectRepository implements ProjectRepository {
  public findCalls = 0;
  public createCalls = 0;
  public saveCalls = 0;
  public readonly savedExpectedRevisions: number[] = [];
  private readonly projects = new Map<UuidV7, Project>();

  public constructor(
    initial: readonly Project[] = [],
    private readonly reservedName = false,
  ) {
    for (const project of initial) this.projects.set(project.id, project);
  }

  public stored(id: UuidV7): Project | undefined {
    return this.projects.get(id);
  }

  public async create(project: Project): Promise<Result<void, AppError>> {
    this.createCalls += 1;
    this.projects.set(project.id, project);
    return Promise.resolve(ok(undefined));
  }

  public async findById(id: UuidV7): Promise<Result<Project | null, AppError>> {
    this.findCalls += 1;
    return Promise.resolve(ok(this.projects.get(id) ?? null));
  }

  public async list(_query: ProjectListQuery): Promise<Result<readonly Project[], AppError>> {
    void _query;
    return Promise.resolve(ok([...this.projects.values()]));
  }

  public async nameExists(
    normalizedName: string,
    excludingProjectId: UuidV7 | null,
  ): Promise<Result<boolean, AppError>> {
    const storedMatch = [...this.projects.values()].some(
      (project) => project.id !== excludingProjectId && project.name === normalizedName,
    );
    return Promise.resolve(ok(this.reservedName || storedMatch));
  }

  public async save(project: Project, expectedRevision: number): Promise<Result<void, AppError>> {
    this.saveCalls += 1;
    this.savedExpectedRevisions.push(expectedRevision);
    this.projects.set(project.id, project);
    return Promise.resolve(ok(undefined));
  }
}

interface ContentCountRow {
  readonly chapters: number;
  readonly story_facts: number;
  readonly project_seeds: number;
  readonly planning_candidates: number;
  readonly writing_preferences: number;
  readonly settings_receipts: number;
  readonly skill_bindings: number;
}

class ContentCountExecutor implements SqlExecutor {
  public selectCalls = 0;

  public constructor(private readonly counts: ContentCountRow = EMPTY_COUNTS) {}

  public async select<Row extends object>(
    _query: string,
    _bindValues?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    void _query;
    void _bindValues;
    this.selectCalls += 1;
    return Promise.resolve([{ ...this.counts } as unknown as Row]);
  }

  public execute(
    _query: string,
    _bindValues?: readonly SqlPrimitive[],
  ): Promise<{ rowsAffected: number }> {
    void _query;
    void _bindValues;
    return Promise.reject(
      new Error("Archived-project verification must never execute raw SQL writes."),
    );
  }

  public transaction<Value>(
    _operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    void _operation;
    return Promise.reject(
      new Error("Archived-project verification must not open a SQL transaction."),
    );
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}
