import { describe, expect, it } from "vitest";

import {
  ArchiveProject,
  CreateProject,
  ListProjects,
  RenameProject,
  RestoreProject,
  TrashProject,
  UnarchiveProject,
} from "../src/index.js";
import { FixedClock, InMemoryProjectRepository, PROJECT_ID, SequenceIds } from "./fakes.js";

describe("project use cases", () => {
  it("runs create, rename, archive, trash, restore, and list through the repository", async () => {
    const repository = new InMemoryProjectRepository();
    const clock = new FixedClock();
    const created = await new CreateProject(
      repository,
      new SequenceIds([PROJECT_ID]),
      clock,
    ).execute({ name: "  Novel  " });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const renamed = await new RenameProject(repository, clock).execute({
      projectId: created.value.id,
      name: "Novel Two",
    });
    expect(renamed.ok).toBe(true);

    const archived = await new ArchiveProject(repository, clock).execute({
      projectId: created.value.id,
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) {
      return;
    }

    const trashed = await new TrashProject(repository, clock).execute({
      projectId: archived.value.id,
    });
    expect(trashed.ok).toBe(true);
    if (!trashed.ok) {
      return;
    }

    const restored = await new RestoreProject(repository, clock).execute({
      projectId: trashed.value.id,
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }
    expect(restored.value.status).toBe("archived");

    const unarchived = await new UnarchiveProject(repository, clock).execute({
      projectId: restored.value.id,
    });
    expect(unarchived.ok).toBe(true);
    if (!unarchived.ok) {
      return;
    }
    expect(unarchived.value.status).toBe("active");

    const listed = await new ListProjects(repository).execute({
      statuses: ["active"],
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((project) => project.name)).toEqual(["Novel Two"]);
    }
  });

  it("rejects duplicate visible project names", async () => {
    const repository = new InMemoryProjectRepository();
    const clock = new FixedClock();
    const create = new CreateProject(repository, new SequenceIds([PROJECT_ID]), clock);
    const first = await create.execute({ name: "Same Name" });
    expect(first.ok).toBe(true);

    const second = await new CreateProject(
      repository,
      new SequenceIds([PROJECT_ID]),
      clock,
    ).execute({ name: "same name" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("PROJECT_NAME_CONFLICT");
    }
  });

  it("passes an explicit display identity into the atomic project create", async () => {
    const repository = new InMemoryProjectRepository();
    const created = await new CreateProject(
      repository,
      new SequenceIds([PROJECT_ID]),
      new FixedClock(),
    ).execute({
      name: "测试作品",
      displayKind: "test_work",
    });

    expect(created.ok).toBe(true);
    expect(repository.createdDisplayKinds).toEqual(["test_work"]);
  });

  it("recovers an exact planned project id without allocating or guessing another project", async () => {
    const repository = new InMemoryProjectRepository();
    const clock = new FixedClock();
    const first = await new CreateProject(repository, new SequenceIds([]), clock).execute({
      name: "Crash-safe Novel",
      plannedId: PROJECT_ID,
    });
    expect(first.ok).toBe(true);

    const retried = await new CreateProject(repository, new SequenceIds([]), clock).execute({
      name: "Crash-safe Novel",
      plannedId: PROJECT_ID,
    });
    expect(retried.ok && retried.value.id).toBe(PROJECT_ID);
    const listed = await repository.list({ statuses: ["active"], search: null });
    expect(listed.ok && listed.value).toHaveLength(1);
  });

  it("fails closed when a planned project id belongs to different content", async () => {
    const repository = new InMemoryProjectRepository();
    const clock = new FixedClock();
    await new CreateProject(repository, new SequenceIds([]), clock).execute({
      name: "Original",
      plannedId: PROJECT_ID,
    });

    const mismatched = await new CreateProject(repository, new SequenceIds([]), clock).execute({
      name: "Different",
      plannedId: PROJECT_ID,
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.error.details.reason).toBe("PLANNED_PROJECT_SCOPE_MISMATCH");
    }
  });
});
