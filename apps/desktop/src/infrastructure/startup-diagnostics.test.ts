import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectStartupDiagnosticArtifact,
  recordStartupFailure,
  resetStartupDiagnosticsForTests,
} from "./startup-diagnostics";

const FAILURE = Object.freeze({
  code: "SQLITE_MIGRATION_INTEGRITY_FAILED",
  stage: "migration_history_validation",
  reasonCode: "MIGRATION_CHECKSUM_UNKNOWN",
  expectedVersion: 80,
  actualVersion: 80,
  migrationVersion: 37,
  whitelistReasonCode: "NO_PUBLISHED_MIGRATION_MATCH",
  nativeErrorClass: "MIGRATE_VERSION_MISMATCH",
  sqlitePrimaryCode: null,
  sqliteExtendedCode: null,
  causeChain: [
    "LocalMigrationError",
    "MigrateError::VersionMismatch",
    "MIGRATION_CHECKSUM_UNKNOWN",
  ],
  componentStack: [
    "native_sqlite_open",
    "NativeSqliteBridge::open_file",
    "NativeSqliteBridge::open_options_and_migrate",
    "run_local_migrations",
    "audit_applied_migration_history",
  ],
  message: "C:\\Users\\author\\private\\inkshadow.db PRIVATE_PROSE_MARKER",
  credential: "PRIVATE_CREDENTIAL_MARKER",
});

describe("startup diagnostics", () => {
  beforeEach(() => {
    resetStartupDiagnosticsForTests();
  });

  it("keeps one support number stable for the same startup failure", () => {
    const first = recordStartupFailure(FAILURE, "2026-08-24T12:34:56.000Z");
    const second = recordStartupFailure(FAILURE, "2026-08-24T12:35:56.000Z");

    expect(first.supportId).toBe("墨影-20260824123456-001");
    expect(second.supportId).toBe(first.supportId);
    expect(second.occurredAt).toBe(first.occurredAt);
  });

  it("restores the same support number after the diagnostic module reloads", async () => {
    const first = recordStartupFailure(FAILURE, "2026-08-24T12:34:56.000Z");

    vi.resetModules();
    const reloaded = await import("./startup-diagnostics");
    const second = reloaded.recordStartupFailure(FAILURE, "2026-08-24T12:35:56.000Z");

    expect(second.supportId).toBe(first.supportId);
    expect(second.occurredAt).toBe(first.occurredAt);
    reloaded.resetStartupDiagnosticsForTests();
  });

  it("exports only whitelisted migration facts, cause names and component stack", () => {
    const incident = recordStartupFailure(FAILURE, "2026-08-24T12:34:56.000Z");
    const artifact = collectStartupDiagnosticArtifact(incident);
    const parsed = JSON.parse(artifact.content) as Record<string, unknown>;

    expect(artifact.fileName).toMatch(/^墨影-启动诊断-2026-08-24-墨影-/u);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "inkshadow-startup-diagnostic",
      privacy: {
        projectContentIncluded: false,
        projectIdeaIncluded: false,
        storyFactsIncluded: false,
        credentialsIncluded: false,
        modelOutputIncluded: false,
        fullPathIncluded: false,
      },
    });
    expect(artifact.content).toContain("MIGRATION_CHECKSUM_UNKNOWN");
    expect(artifact.content).toContain("migration_history_validation");
    expect(artifact.content).toContain("MIGRATE_VERSION_MISMATCH");
    expect(artifact.content).toContain("MigrateError::VersionMismatch");
    expect(artifact.content).toContain("audit_applied_migration_history");
    expect(artifact.content).toContain("NativeSqliteBridge::open_file");
    expect(artifact.content).not.toMatch(
      /PRIVATE_PROSE_MARKER|PRIVATE_CREDENTIAL_MARKER|author|inkshadow\.db/u,
    );
  });

  it("preserves only consistent whitelisted native SQLite codes and real cause variants", () => {
    const incident = recordStartupFailure(
      {
        ...FAILURE,
        code: "SQLITE_MIGRATION_FAILED",
        stage: "migration_apply",
        reasonCode: "MIGRATION_FORWARD_APPLY_FAILED",
        whitelistReasonCode: "PUBLISHED_HISTORY_ACCEPTED",
        nativeErrorClass: "SQLITE_FULL",
        sqlitePrimaryCode: 13,
        sqliteExtendedCode: 13,
        causeChain: [
          "LocalMigrationError",
          "MigrateError::ExecuteMigration",
          "SqlxError::Database",
          "SQLITE_FULL",
          "MIGRATION_FORWARD_APPLY_FAILED",
        ],
        componentStack: [
          "native_sqlite_open",
          "NativeSqliteBridge::open_file",
          "NativeSqliteBridge::open_options_and_migrate",
          "run_local_migrations",
          "Migrator::run_direct",
        ],
      },
      "2026-08-24T12:34:56.000Z",
    );

    expect(incident).toMatchObject({
      nativeErrorClass: "SQLITE_FULL",
      sqlitePrimaryCode: 13,
      sqliteExtendedCode: 13,
      causeChain: [
        "LocalMigrationError",
        "MigrateError::ExecuteMigration",
        "SqlxError::Database",
        "SQLITE_FULL",
        "MIGRATION_FORWARD_APPLY_FAILED",
      ],
    });
  });

  it("removes unknown or contradictory native diagnostic details", () => {
    const incident = recordStartupFailure({
      ...FAILURE,
      nativeErrorClass: "PRIVATE_NATIVE_ERROR",
      sqlitePrimaryCode: 13,
      sqliteExtendedCode: 8,
      causeChain: ["LocalMigrationError", "C:\\private\\novel.db", "PRIVATE_PROSE_MARKER"],
      componentStack: ["native_sqlite_open", "C:\\private\\source.rs"],
    });
    const artifact = collectStartupDiagnosticArtifact(incident);

    expect(incident.nativeErrorClass).toBe("MIGRATE_OTHER");
    expect(incident.sqlitePrimaryCode).toBeNull();
    expect(incident.sqliteExtendedCode).toBeNull();
    expect(incident.causeChain).toEqual(["LocalMigrationError"]);
    expect(incident.componentStack).toEqual(["native_sqlite_open"]);
    expect(artifact.content).not.toMatch(
      /PRIVATE_NATIVE_ERROR|PRIVATE_PROSE_MARKER|private|novel\.db/u,
    );
  });

  it("keeps the support number visible in memory when local storage cannot write", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota");
    });
    try {
      const incident = recordStartupFailure(FAILURE, "2026-08-24T12:34:56.000Z");
      expect(incident.supportId).toBe("墨影-20260824123456-001");
      expect(recordStartupFailure(FAILURE).supportId).toBe(incident.supportId);
      expect(collectStartupDiagnosticArtifact(incident).content).toContain(
        "export_redacted_diagnostic",
      );
      expect(collectStartupDiagnosticArtifact(incident).content).toContain(incident.supportId);
    } finally {
      write.mockRestore();
    }
  });
});
