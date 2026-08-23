import {
  Chapter,
  Project,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "@inkshadow/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRepositories, DEVELOPMENT_DATABASE_KEY } from "./development-storage";

const AUTHOR_PROJECT_ID = uuid(1);
const TEST_PROJECT_ID = uuid(2);
const BUILTIN_PROJECT_ID = uuid(3);
const SYSTEM_PROJECT_ID = uuid(4);
const IMPORT_PROJECT_ID = uuid(5);
const CHAPTER_ID = uuid(6);
const VERSION_ID = uuid(7);
const CREATED_AT = atMinute(0);
const TESTED_AT = atMinute(1);
const RESTORED_AT = atMinute(2);

describe("browser development project display identities", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([
    [AUTHOR_PROJECT_ID, "author_work", "explicit_creation"],
    [TEST_PROJECT_ID, "test_work", "explicit_test"],
    [BUILTIN_PROJECT_ID, "builtin_example", "builtin_example"],
  ] as const)(
    "atomically creates a project with %s display identity",
    async (projectId, kind, provenance) => {
      const storage = new CountingStorage(window.localStorage);
      const repositories = createDevelopmentRepositories(storage);
      const project = expectOk(
        Project.create({ id: projectId, name: "名称不参与分类", now: CREATED_AT }),
      );

      expectOk(await repositories.projects.create(project, kind));
      expect(storage.writeCount).toBe(1);

      expect(
        expectOk(await repositories.projectDisplayIdentities.resolveByProjectId(projectId)),
      ).toEqual({
        projectId,
        displayKind: kind,
        provenance,
        recordedAt: CREATED_AT,
        revision: 1,
      });
      expect(
        expectOk(await repositories.projectDisplayIdentities.listRevisions(projectId)),
      ).toEqual([
        {
          projectId,
          revision: 1,
          previousDisplayKind: null,
          displayKind: kind,
          provenance,
          recordedAt: CREATED_AT,
        },
      ]);
    },
  );

  it("reads an old schemaVersion 2 project without identity fields as legacy author work", async () => {
    const repositories = createDevelopmentRepositories(window.localStorage);
    const project = expectOk(
      Project.create({ id: AUTHOR_PROJECT_ID, name: "系统评测测试示例", now: CREATED_AT }),
    );
    expectOk(await repositories.projects.create(project));
    const chapter = expectOk(
      Chapter.create({
        id: CHAPTER_ID,
        projectId: project.id,
        title: "测试章节",
        content: "这段正文包含系统评测、测试和示例等词，但不得用于分类。",
        initialVersionId: VERSION_ID,
        now: CREATED_AT,
      }),
    );
    const database = readDatabase();
    database.chapters.push(chapter.toSnapshot());
    delete database.projectDisplayIdentities;
    delete database.projectDisplayIdentityRevisions;
    writeDatabase(database);

    const restarted = createDevelopmentRepositories(window.localStorage);

    expect(
      expectOk(await restarted.projectDisplayIdentities.resolveByProjectId(project.id)),
    ).toEqual({
      projectId: project.id,
      displayKind: "author_work",
      provenance: "legacy_unknown",
      recordedAt: null,
      revision: null,
    });
    expect(expectOk(await restarted.projectDisplayIdentities.listRevisions(project.id))).toEqual(
      [],
    );
  });

  it("switches author and test work reversibly, idempotently, and across restart", async () => {
    const repositories = createDevelopmentRepositories(window.localStorage);
    const projectName = "不可进入身份记录的测试作品名称";
    const bodyText = "不可进入身份记录的正文分类诱导";
    const project = expectOk(
      Project.create({ id: AUTHOR_PROJECT_ID, name: projectName, now: CREATED_AT }),
    );
    expectOk(await repositories.projects.create(project));
    const chapter = expectOk(
      Chapter.create({
        id: CHAPTER_ID,
        projectId: project.id,
        title: "正文分类隔离",
        content: bodyText,
        initialVersionId: VERSION_ID,
        now: CREATED_AT,
      }),
    );
    const withChapter = readDatabase();
    withChapter.chapters.push(chapter.toSnapshot());
    writeDatabase(withChapter);

    expect(
      expectOk(await repositories.projectDisplayIdentities.recordTestWork(project.id, TESTED_AT)),
    ).toMatchObject({
      displayKind: "test_work",
      provenance: "explicit_test",
      recordedAt: TESTED_AT,
      revision: 2,
    });
    const afterTestSwitch = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
    expect(afterTestSwitch).not.toBeNull();
    expect(
      expectOk(await repositories.projectDisplayIdentities.recordTestWork(project.id, RESTORED_AT)),
    ).toMatchObject({
      displayKind: "test_work",
      recordedAt: TESTED_AT,
      revision: 2,
    });
    expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).toBe(afterTestSwitch);

    const restarted = createDevelopmentRepositories(window.localStorage);
    expect(
      expectOk(await restarted.projectDisplayIdentities.recordAuthorWork(project.id, RESTORED_AT)),
    ).toMatchObject({
      displayKind: "author_work",
      provenance: "explicit_creation",
      recordedAt: RESTORED_AT,
      revision: 3,
    });
    expectOk(await restarted.projectDisplayIdentities.recordAuthorWork(project.id, atMinute(3)));
    const verifiedAfterRestart = createDevelopmentRepositories(window.localStorage);
    expect(
      expectOk(await verifiedAfterRestart.projectDisplayIdentities.listRevisions(project.id)),
    ).toEqual([
      {
        projectId: project.id,
        revision: 1,
        previousDisplayKind: null,
        displayKind: "author_work",
        provenance: "explicit_creation",
        recordedAt: CREATED_AT,
      },
      {
        projectId: project.id,
        revision: 2,
        previousDisplayKind: "author_work",
        displayKind: "test_work",
        provenance: "explicit_test",
        recordedAt: TESTED_AT,
      },
      {
        projectId: project.id,
        revision: 3,
        previousDisplayKind: "test_work",
        displayKind: "author_work",
        provenance: "explicit_creation",
        recordedAt: RESTORED_AT,
      },
    ]);

    const persisted = readDatabase();
    expect(Object.keys(persisted.projectDisplayIdentities?.[0] ?? {}).sort()).toEqual([
      "displayKind",
      "projectId",
      "provenance",
      "recordedAt",
      "revision",
    ]);
    const classificationPayload = JSON.stringify({
      identities: persisted.projectDisplayIdentities,
      revisions: persisted.projectDisplayIdentityRevisions,
    });
    expect(classificationPayload).not.toContain(projectName);
    expect(classificationPayload).not.toContain(bodyText);
  });

  it("protects built-in and system identities from later author or test recording", async () => {
    const repositories = createDevelopmentRepositories(window.localStorage);
    const builtin = expectOk(
      Project.create({ id: BUILTIN_PROJECT_ID, name: "内置示例", now: CREATED_AT }),
    );
    const system = expectOk(
      Project.create({ id: SYSTEM_PROJECT_ID, name: "普通名字", now: CREATED_AT }),
    );
    expectOk(await repositories.projects.create(builtin, "builtin_example"));
    expectOk(await repositories.projects.create(system));
    const database = readDatabase();
    database.projectDisplayIdentities = [
      ...(database.projectDisplayIdentities ?? []).filter(
        (identity) => identity.projectId !== system.id,
      ),
      {
        projectId: system.id,
        displayKind: "system_evaluation",
        provenance: "evaluation_project_id",
        recordedAt: CREATED_AT,
        revision: 1,
      },
    ];
    database.projectDisplayIdentityRevisions = [
      ...(database.projectDisplayIdentityRevisions ?? []).filter(
        (revision) => revision.projectId !== system.id,
      ),
      {
        projectId: system.id,
        revision: 1,
        previousDisplayKind: null,
        displayKind: "system_evaluation",
        provenance: "evaluation_project_id",
        recordedAt: CREATED_AT,
      },
    ];
    writeDatabase(database);

    const restarted = createDevelopmentRepositories(window.localStorage);
    expect(
      (await restarted.projectDisplayIdentities.recordTestWork(builtin.id, TESTED_AT)).ok,
    ).toBe(false);
    expect(
      (await restarted.projectDisplayIdentities.recordAuthorWork(builtin.id, RESTORED_AT)).ok,
    ).toBe(false);
    expectOk(
      await restarted.projectDisplayIdentities.recordBuiltinExampleOnCreation(
        builtin.id,
        RESTORED_AT,
      ),
    );
    expect((await restarted.projectDisplayIdentities.recordTestWork(system.id, TESTED_AT)).ok).toBe(
      false,
    );
    expect(
      (await restarted.projectDisplayIdentities.recordAuthorWork(system.id, RESTORED_AT)).ok,
    ).toBe(false);
    expect(
      (
        await restarted.projectDisplayIdentities.recordBuiltinExampleOnCreation(
          system.id,
          RESTORED_AT,
        )
      ).ok,
    ).toBe(false);
    expect(
      expectOk(await restarted.projectDisplayIdentities.listRevisions(builtin.id)),
    ).toHaveLength(1);
    expect(
      expectOk(await restarted.projectDisplayIdentities.listRevisions(system.id)),
    ).toHaveLength(1);
    expect(
      expectOk(await restarted.projectDisplayIdentities.resolveByProjectId(builtin.id)),
    ).toMatchObject({
      displayKind: "builtin_example",
      provenance: "builtin_example",
      recordedAt: CREATED_AT,
      revision: 1,
    });
    expect(
      expectOk(await restarted.projectDisplayIdentities.resolveByProjectId(system.id)),
    ).toMatchObject({
      displayKind: "system_evaluation",
      provenance: "evaluation_project_id",
      recordedAt: CREATED_AT,
      revision: 1,
    });
  });

  it.each(["projectDisplayIdentities", "projectDisplayIdentityRevisions"] as const)(
    "fails closed when only %s is missing from the audit chain",
    async (missingField) => {
      const repositories = createDevelopmentRepositories(window.localStorage);
      const project = expectOk(
        Project.create({ id: AUTHOR_PROJECT_ID, name: "审计链不完整", now: CREATED_AT }),
      );
      expectOk(await repositories.projects.create(project));
      const database = readDatabase();
      if (missingField === "projectDisplayIdentities") {
        delete database.projectDisplayIdentities;
      } else {
        delete database.projectDisplayIdentityRevisions;
      }
      writeDatabase(database);

      const restarted = createDevelopmentRepositories(window.localStorage);
      const projectRead = await restarted.projects.findById(project.id);
      const identityRead = await restarted.projectDisplayIdentities.resolveByProjectId(project.id);

      expect(projectRead.ok && projectRead.value?.name).toBe("审计链不完整");
      expect(identityRead.ok).toBe(false);
    },
  );

  it("isolates malformed optional identity metadata without blocking the project or chapter", async () => {
    const repositories = createDevelopmentRepositories(window.localStorage);
    const project = expectOk(
      Project.create({ id: AUTHOR_PROJECT_ID, name: "正文仍须可读", now: CREATED_AT }),
    );
    expectOk(await repositories.projects.create(project));
    const chapter = expectOk(
      Chapter.create({
        id: CHAPTER_ID,
        projectId: project.id,
        title: "安全正文",
        content: "这段正文不能被可选显示身份损坏拖垮。",
        initialVersionId: VERSION_ID,
        now: CREATED_AT,
      }),
    );
    const database = readDatabase();
    database.chapters.push(chapter.toSnapshot());
    database.projectDisplayIdentities = [
      {
        ...database.projectDisplayIdentities?.[0],
        displayKind: "damaged_optional_value",
      },
    ] as unknown as StoredIdentitySeed[];
    writeDatabase(database);

    const restarted = createDevelopmentRepositories(window.localStorage);
    const projectRead = await restarted.projects.findById(project.id);
    const chaptersRead = await restarted.chapters.listByProjectId(project.id);
    const identityRead = await restarted.projectDisplayIdentities.resolveByProjectId(project.id);

    expect(projectRead.ok && projectRead.value?.name).toBe(project.name);
    expect(chaptersRead.ok && chaptersRead.value[0]?.content).toBe(chapter.content);
    expect(identityRead.ok).toBe(false);
  });

  it("records imported projects as author work in the same development mutation", async () => {
    const storage = new CountingStorage(window.localStorage);
    const repositories = createDevelopmentRepositories(storage);
    const project = expectOk(
      Project.create({ id: IMPORT_PROJECT_ID, name: "导入作品", now: CREATED_AT }),
    );

    expectOk(await repositories.projectImports.commitImport({ project, chapters: [] }));
    expect(storage.writeCount).toBe(1);

    expect(
      expectOk(await repositories.projectDisplayIdentities.resolveByProjectId(project.id)),
    ).toMatchObject({
      displayKind: "author_work",
      provenance: "explicit_creation",
      recordedAt: CREATED_AT,
      revision: 1,
    });
  });
});

interface StoredIdentitySeed {
  readonly projectId: UuidV7;
  readonly displayKind: "author_work" | "test_work" | "builtin_example" | "system_evaluation";
  readonly provenance:
    "explicit_creation" | "explicit_test" | "builtin_example" | "evaluation_project_id";
  readonly recordedAt: IsoUtcTimestamp;
  readonly revision: number;
}

interface StoredIdentityRevisionSeed extends StoredIdentitySeed {
  readonly previousDisplayKind: StoredIdentitySeed["displayKind"] | null;
}

interface MutableDevelopmentDatabase {
  chapters: unknown[];
  projectDisplayIdentities?: StoredIdentitySeed[];
  projectDisplayIdentityRevisions?: StoredIdentityRevisionSeed[];
  [key: string]: unknown;
}

function readDatabase(): MutableDevelopmentDatabase {
  const serialized = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
  if (serialized === null) throw new Error("Expected development database state.");
  return JSON.parse(serialized) as MutableDevelopmentDatabase;
}

function writeDatabase(database: MutableDevelopmentDatabase): void {
  window.localStorage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));
}

class CountingStorage implements Storage {
  public writeCount = 0;

  public constructor(private readonly delegate: Storage) {}

  public get length(): number {
    return this.delegate.length;
  }

  public clear(): void {
    this.delegate.clear();
  }

  public getItem(key: string): string | null {
    return this.delegate.getItem(key);
  }

  public key(index: number): string | null {
    return this.delegate.key(index);
  }

  public removeItem(key: string): void {
    this.delegate.removeItem(key);
  }

  public setItem(key: string, value: string): void {
    this.writeCount += 1;
    this.delegate.setItem(key, value);
  }
}
function uuid(value: number): UuidV7 {
  return expectOk(parseUuidV7(`019fa760-0000-7000-8000-${value.toString(16).padStart(12, "0")}`));
}

function atMinute(minute: number): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(`2026-08-23T05:${String(minute).padStart(2, "0")}:00.000Z`));
}

function expectOk<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected an ok result.");
  return result.value;
}
