import {
  AppError,
  Chapter,
  ChapterVersion,
  Project,
  err,
  ok,
  type Clock,
  type Result,
  type UuidV7Generator,
} from "@inkshadow/domain";

import type { ContentHasher } from "../ports/content-hasher.js";
import type {
  ImportedChapterCommit,
  ProjectImportCommitRepository,
} from "../ports/project-import-repository.js";
import type { ProjectRepository } from "../ports/project-repository.js";

const MAXIMUM_IMPORT_CHAPTERS = 10_000;

export interface ImportChapterCommand {
  readonly title: string;
  readonly content: string;
}

export interface ImportProjectCommand {
  readonly name: string;
  readonly chapters: readonly ImportChapterCommand[];
}

export interface ImportProjectOutcome {
  readonly project: Project;
  readonly chapters: readonly Chapter[];
}

export class ImportProject {
  public constructor(
    private readonly projects: ProjectRepository,
    private readonly imports: ProjectImportCommitRepository,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly hasher: ContentHasher,
  ) {}

  public async execute(
    command: ImportProjectCommand,
  ): Promise<Result<ImportProjectOutcome, AppError>> {
    if (command.chapters.length === 0 || command.chapters.length > MAXIMUM_IMPORT_CHAPTERS) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "An import must contain between 1 and 10,000 chapters.",
          details: { field: "chapters", chapterCount: command.chapters.length },
        }),
      );
    }

    const now = this.clock.now();
    const project = Project.create({
      id: this.ids.next(),
      name: command.name,
      now,
    });
    if (!project.ok) {
      return project;
    }

    const duplicate = await this.projects.nameExists(project.value.name, null);
    if (!duplicate.ok) {
      return duplicate;
    }
    if (duplicate.value) {
      return err(
        new AppError({
          code: "PROJECT_NAME_CONFLICT",
          message: "A visible project already uses this name.",
          details: { name: project.value.name },
        }),
      );
    }

    const importedChapters: ImportedChapterCommit[] = [];
    for (const input of command.chapters) {
      const chapterId = this.ids.next();
      const versionId = this.ids.next();
      const checksum = await this.hasher.sha256(input.content);
      if (!checksum.ok) {
        return checksum;
      }
      const chapter = Chapter.create({
        id: chapterId,
        projectId: project.value.id,
        title: input.title,
        content: input.content,
        initialVersionId: versionId,
        now,
      });
      if (!chapter.ok) {
        return chapter;
      }
      const version = ChapterVersion.create({
        id: versionId,
        projectId: project.value.id,
        chapterId,
        parentVersionId: null,
        sequence: 1,
        content: input.content,
        contentChecksum: checksum.value,
        reason: "import",
        sourceCandidateId: null,
        createdAt: now,
        organizeLocalStoryFacts: true,
      });
      if (!version.ok) {
        return version;
      }
      importedChapters.push({
        chapter: chapter.value,
        initialVersion: version.value,
      });
    }

    const committed = await this.imports.commitImport({
      project: project.value,
      chapters: importedChapters,
    });
    return committed.ok
      ? ok({
          project: project.value,
          chapters: Object.freeze(importedChapters.map(({ chapter }) => chapter)),
        })
      : committed;
  }
}
