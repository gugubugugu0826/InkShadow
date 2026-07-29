import { describe, expect, it } from "vitest";

import {
  Project,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "../src/index.js";

function uuid(value: string): UuidV7 {
  const result = parseUuidV7(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function timestamp(value: string): IsoUtcTimestamp {
  const result = parseIsoUtcTimestamp(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

const PROJECT_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000001");
const CREATED_AT = timestamp("2026-07-27T00:00:00.000Z");
const TRASHED_AT = timestamp("2026-07-28T00:00:00.000Z");
const RETENTION_UNTIL = timestamp("2026-08-27T00:00:00.000Z");

function createProject(): Project {
  const result = Project.create({
    id: PROJECT_ID,
    name: "  Long Novel  ",
    now: CREATED_AT,
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

describe("Project", () => {
  it("normalizes names and starts as a stable active entity", () => {
    const project = createProject();
    expect(project.name).toBe("Long Novel");
    expect(project.status).toBe("active");
    expect(project.revision).toBe(1);
  });

  it("soft deletes and restores with a new deletion generation", () => {
    const trashed = createProject().trash({
      now: TRASHED_AT,
      retentionUntil: RETENTION_UNTIL,
    });
    expect(trashed.ok).toBe(true);
    if (!trashed.ok) {
      return;
    }

    expect(trashed.value.status).toBe("trashed");
    expect(trashed.value.toSnapshot().deletionGeneration).toBe(1);

    const restored = trashed.value.restore(timestamp("2026-08-01T00:00:00.000Z"));
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    expect(restored.value.status).toBe("active");
    expect(restored.value.toSnapshot().deletionGeneration).toBe(2);
  });

  it("does not rename a trashed project", () => {
    const trashed = createProject().trash({
      now: TRASHED_AT,
      retentionUntil: RETENTION_UNTIL,
    });
    if (!trashed.ok) {
      throw trashed.error;
    }

    const renamed = trashed.value.rename("Hidden overwrite", TRASHED_AT);
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) {
      expect(renamed.error.code).toBe("PROJECT_DELETED");
    }
  });

  it("returns an archived project to active work", () => {
    const archived = createProject().archive(TRASHED_AT);
    expect(archived.ok).toBe(true);
    if (!archived.ok) {
      return;
    }

    const active = archived.value.unarchive(timestamp("2026-07-29T00:00:00.000Z"));
    expect(active.ok).toBe(true);
    if (!active.ok) {
      return;
    }

    expect(active.value.status).toBe("active");
    expect(active.value.toSnapshot().archivedAt).toBeNull();
    expect(active.value.revision).toBe(3);
  });

  it("refuses recovery after the retention window", () => {
    const trashed = createProject().trash({
      now: TRASHED_AT,
      retentionUntil: RETENTION_UNTIL,
    });
    if (!trashed.ok) {
      throw trashed.error;
    }

    const restored = trashed.value.restore(timestamp("2026-08-28T00:00:00.000Z"));
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error.code).toBe("PROJECT_RETENTION_EXPIRED");
    }
  });
});
