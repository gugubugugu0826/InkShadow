import { AppError, err, type Project, type Result, type UuidV7 } from "@inkshadow/domain";

import type { ProjectRepository } from "../ports/project-repository.js";

export async function findProject(
  repository: ProjectRepository,
  projectId: UuidV7,
): Promise<Result<Project, AppError>> {
  const found = await repository.findById(projectId);
  if (!found.ok) {
    return found;
  }

  if (found.value === null) {
    return err(
      new AppError({
        code: "PROJECT_NOT_FOUND",
        message: "The project does not exist.",
      }),
    );
  }

  return { ok: true, value: found.value };
}

export function ensureProjectAcceptsContent(project: Project): Result<true, AppError> {
  if (project.status === "trashed") {
    return err(
      new AppError({
        code: "PROJECT_DELETED",
        message: "Restore the project before changing its content.",
        actions: ["RESTORE"],
      }),
    );
  }

  if (project.status === "archived") {
    return err(
      new AppError({
        code: "PROJECT_ARCHIVED",
        message: "Unarchive the project before changing its content.",
      }),
    );
  }

  return { ok: true, value: true };
}
