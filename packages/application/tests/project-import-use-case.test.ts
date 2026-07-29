import { AppError, Project, err, ok, type Result } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import type { ImportProjectCommit, ProjectImportCommitRepository } from "../src/index.js";
import { ImportProject } from "../src/use-cases/project-import-use-case.js";
import {
  CANDIDATE_ID,
  CHAPTER_ID,
  FixedClock,
  FixedHasher,
  InMemoryProjectRepository,
  NEXT_VERSION_ID,
  NOW,
  PROJECT_ID,
  SequenceIds,
  VERSION_ID,
} from "./fakes.js";

describe("ImportProject", () => {
  it("builds project, chapter, and imported version aggregates before one commit", async () => {
    const projects = new InMemoryProjectRepository();
    const imports = new CapturingImportRepository();
    const useCase = new ImportProject(
      projects,
      imports,
      new SequenceIds([PROJECT_ID, CHAPTER_ID, VERSION_ID, NEXT_VERSION_ID, CANDIDATE_ID]),
      new FixedClock(),
      new FixedHasher(),
    );

    const result = await useCase.execute({
      name: "导入长篇",
      chapters: [
        { title: "第一章", content: "开篇正文" },
        { title: "第二章", content: "后续正文" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(imports.commits).toHaveLength(1);
    expect(imports.commits[0]?.project.name).toBe("导入长篇");
    expect(
      imports.commits[0]?.chapters.map(({ chapter, initialVersion }) => ({
        title: chapter.title,
        content: chapter.content,
        reason: initialVersion.toSnapshot().reason,
      })),
    ).toEqual([
      { title: "第一章", content: "开篇正文", reason: "import" },
      { title: "第二章", content: "后续正文", reason: "import" },
    ]);
  });

  it("rejects a visible project-name conflict before attempting the atomic commit", async () => {
    const projects = new InMemoryProjectRepository();
    projects.seed(
      expectOk(
        Project.create({
          id: PROJECT_ID,
          name: "已存在",
          now: NOW,
        }),
      ),
    );
    const imports = new CapturingImportRepository();
    const useCase = new ImportProject(
      projects,
      imports,
      new SequenceIds([CHAPTER_ID]),
      new FixedClock(),
      new FixedHasher(),
    );

    const result = await useCase.execute({
      name: "已存在",
      chapters: [{ title: "第一章", content: "" }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROJECT_NAME_CONFLICT" },
    });
    expect(imports.commits).toHaveLength(0);
  });

  it("surfaces an atomic commit failure without reporting a partial import", async () => {
    const projects = new InMemoryProjectRepository();
    const imports = new CapturingImportRepository(true);
    const useCase = new ImportProject(
      projects,
      imports,
      new SequenceIds([PROJECT_ID, CHAPTER_ID, VERSION_ID]),
      new FixedClock(),
      new FixedHasher(),
    );

    const result = await useCase.execute({
      name: "失败导入",
      chapters: [{ title: "第一章", content: "正文" }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SAVE_FAILED" },
    });
    expect(imports.commits).toHaveLength(1);
    await expect(
      projects.list({ statuses: ["active", "archived", "trashed"], search: null }),
    ).resolves.toMatchObject({ ok: true, value: [] });
  });
});

class CapturingImportRepository implements ProjectImportCommitRepository {
  public readonly commits: ImportProjectCommit[] = [];

  public constructor(private readonly fail = false) {}

  public commitImport(commit: ImportProjectCommit): Promise<Result<void, AppError>> {
    this.commits.push(commit);
    return Promise.resolve(
      this.fail
        ? err(
            new AppError({
              code: "SAVE_FAILED",
              message: "Injected import failure.",
            }),
          )
        : ok(undefined),
    );
  }
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
