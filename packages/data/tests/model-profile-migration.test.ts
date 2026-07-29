import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = readFileSync(
  new URL("../migrations/0004_model_profiles.sql", import.meta.url),
  "utf8",
);

describe("model profile migration", () => {
  it("creates a repeatable non-secret profile store with bounded fields", async () => {
    const executor = new NodeSqliteExecutor(`${migration}\n${migration}`);
    const columns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('model_profiles') ORDER BY cid",
    );

    expect(columns.map(({ name }) => name)).toEqual([
      "provider_id",
      "provider",
      "base_url",
      "authentication",
      "selected_model",
      "revision",
      "created_at",
      "updated_at",
    ]);
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["secret", "token", "credential", "api_key"]),
    );

    await executor.execute(
      `INSERT INTO model_profiles (
        provider_id,
        provider,
        base_url,
        authentication,
        selected_model,
        revision,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
      [
        "ollama-local",
        "ollama",
        "http://127.0.0.1:11434",
        "none",
        "2026-07-27T00:00:00.000Z",
        "2026-07-27T00:00:00.000Z",
      ],
    );
    await expect(
      executor.execute(
        `INSERT INTO model_profiles (
          provider_id,
          provider,
          base_url,
          authentication,
          selected_model,
          revision,
          created_at,
          updated_at
        ) VALUES ('bad', 'unsupported', 'https://example.test', 'none', NULL, 1, ?, ?)`,
        ["2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"],
      ),
    ).rejects.toThrow();
    await executor.close();
  });
});
