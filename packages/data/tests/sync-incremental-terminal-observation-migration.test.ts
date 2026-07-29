import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0018_sync_incremental_terminal_observations.sql", import.meta.url),
  "utf8",
);
const PROJECT_ID = "019fa103-0000-7000-8000-000000000001";
const NOW = "2026-07-28T03:00:00.000Z";

describe("0018 incremental terminal observation migration", () => {
  let executor: NodeSqliteExecutor;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor([coreMigration, migration].join("\n"));
    await executor.execute("PRAGMA foreign_keys = ON");
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Project', ?, ?)",
      [PROJECT_ID, NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("binds one terminal observation to an exact project cursor and checkpoint revision", async () => {
    await insertObservation("cursor_1", 1);

    await expect(
      executor.select<{
        project_id: string;
        signed_remote_cursor: string;
        downloaded_checkpoint_revision: number;
      }>(
        `SELECT project_id, signed_remote_cursor, downloaded_checkpoint_revision
         FROM sync_incremental_terminal_observations`,
      ),
    ).resolves.toEqual([
      {
        project_id: PROJECT_ID,
        signed_remote_cursor: "cursor_1",
        downloaded_checkpoint_revision: 1,
      },
    ]);
    await expect(insertObservation("cursor_2", 1)).rejects.toThrow();
  });

  it("enforces authority-field checks and cascades project deletion", async () => {
    await expect(insertObservation("bad cursor", 1)).rejects.toThrow();
    await expect(insertObservation("cursor_1", 0)).rejects.toThrow();
    await insertObservation("cursor_1", 1);

    await executor.execute("DELETE FROM projects WHERE id = ?", [PROJECT_ID]);

    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_incremental_terminal_observations",
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  async function insertObservation(cursor: string, revision: number): Promise<void> {
    await executor.execute(
      `INSERT INTO sync_incremental_terminal_observations (
         project_id,
         signed_remote_cursor,
         downloaded_checkpoint_revision,
         response_digest,
         request_id,
         observed_at
       ) VALUES (?, ?, ?, ?, 'request-1', ?)`,
      [PROJECT_ID, cursor, revision, "a".repeat(64), NOW],
    );
  }
});
