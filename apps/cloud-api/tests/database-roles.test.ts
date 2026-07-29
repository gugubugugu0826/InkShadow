import { describe, expect, it } from "vitest";

import {
  CLOUD_RUNTIME_FUNCTIONS,
  CLOUD_RUNTIME_SEQUENCES,
  CLOUD_RUNTIME_TABLES,
  CLOUD_SECURITY_DEFINER_FUNCTIONS,
  validateCloudDatabaseRole,
} from "../src/postgres/database-roles.js";

describe("cloud database role identifiers", () => {
  it("accepts only bounded lowercase PostgreSQL identifiers", () => {
    expect(validateCloudDatabaseRole("inkshadow_runtime", "Runtime role")).toBe(
      "inkshadow_runtime",
    );
    for (const invalid of [
      "InkShadow_runtime",
      "1inkshadow",
      "inkshadow-runtime",
      'inkshadow"runtime',
      "inkshadow_runtime;drop_role",
      `i${"x".repeat(63)}`,
    ]) {
      expect(() => validateCloudDatabaseRole(invalid, "Runtime role")).toThrow(
        "lowercase PostgreSQL identifier",
      );
    }
  });

  it("keeps the schema v16 runtime grants explicit, unique and ledger-free", () => {
    expect(CLOUD_RUNTIME_TABLES).not.toContain("cloud_schema_migrations");
    expect(CLOUD_RUNTIME_TABLES).toHaveLength(51);
    expect(new Set(CLOUD_RUNTIME_TABLES).size).toBe(CLOUD_RUNTIME_TABLES.length);
    expect(CLOUD_RUNTIME_SEQUENCES).toEqual(["sync_operations_remote_sequence_seq"]);
    expect(CLOUD_RUNTIME_FUNCTIONS).toHaveLength(51);
    expect(new Set(CLOUD_RUNTIME_FUNCTIONS).size).toBe(CLOUD_RUNTIME_FUNCTIONS.length);
    expect(CLOUD_RUNTIME_FUNCTIONS.every((signature) => signature.includes("("))).toBe(true);
    expect(CLOUD_SECURITY_DEFINER_FUNCTIONS).toHaveLength(30);
    expect(new Set(CLOUD_SECURITY_DEFINER_FUNCTIONS).size).toBe(
      CLOUD_SECURITY_DEFINER_FUNCTIONS.length,
    );
    expect(
      CLOUD_SECURITY_DEFINER_FUNCTIONS.every((signature) =>
        CLOUD_RUNTIME_FUNCTIONS.includes(signature as (typeof CLOUD_RUNTIME_FUNCTIONS)[number]),
      ),
    ).toBe(true);
  });
});
