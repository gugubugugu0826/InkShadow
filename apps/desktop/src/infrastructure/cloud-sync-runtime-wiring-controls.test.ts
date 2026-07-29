import type { SqlExecutor } from "@inkshadow/data";
import type { SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import {
  parseIsoUtcTimestamp,
  parseUuidV7,
  type Clock,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import type { CloudProjectKeyCoordinator } from "./cloud-project-key-coordinator";
import type { CloudProjectSyncEnrollmentService } from "./cloud-project-sync-enrollment-service";
import {
  createCloudSyncControlService,
  createSyncConflictResolutionCoordinator,
  type CloudSyncControlWiringDependencies,
  type SyncConflictResolutionWiringDependencies,
} from "./cloud-sync-runtime-wiring";
import type { CloudSessionCoordinator } from "./cloud-session-coordinator";
import { CloudSyncControlService } from "./cloud-sync-control-service";
import type { CloudSyncRuntimeService } from "./cloud-sync-runtime-service";
import type { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import { SyncConflictResolutionCoordinator } from "./sync-conflict-resolution-coordinator";

const NOW = expectDomain(parseIsoUtcTimestamp("2026-07-28T05:00:00.000Z"));
const GENERATED_ID = expectDomain(parseUuidV7("019fa302-5000-7000-8000-000000000001"));
const clock: Clock = { now: () => NOW };
const ids: UuidV7Generator = { next: () => GENERATED_ID };
const executor = {} as SqlExecutor;
const syncStore = {} as SyncSqliteStore;
const cloudSync = {} as CloudSyncRuntimeService;
const enrollment = {} as CloudProjectSyncEnrollmentService;
const session = {} as CloudSessionCoordinator;
const projectSecurity = {} as ProjectKeyLifecycleService;
const cloudProjectKeys = {} as CloudProjectKeyCoordinator;

describe("cloud sync user-control wiring", () => {
  it.each([
    ["browser development", { mode: "browser-development" as const }],
    ["disabled feature", { enabled: false }],
    ["missing SQLite", { executor: null }],
    ["missing runtime", { cloudSync: null }],
    ["missing enrollment", { enrollment: null }],
  ])("fails closed for %s", (_label, override) => {
    expect(
      createCloudSyncControlService({
        ...controlDependencies(),
        ...override,
      }),
    ).toBeNull();
  });

  it("creates controls only around a complete production authority", () => {
    const created = createCloudSyncControlService(controlDependencies());
    expect(created).toBeInstanceOf(CloudSyncControlService);
    expect(created?.isEnabled).toBe(true);
  });
});

describe("sync conflict-resolution wiring", () => {
  it.each([
    ["browser development", { mode: "browser-development" as const }],
    ["disabled feature", { enabled: false }],
    ["missing SQLite", { executor: null }],
    ["missing encrypted inbox", { syncStore: null }],
    ["missing session", { session: null }],
    ["missing local key lifecycle", { projectSecurity: null }],
    ["missing cloud key coordinator", { cloudProjectKeys: null }],
  ])("fails closed for %s", (_label, override) => {
    expect(
      createSyncConflictResolutionCoordinator({
        ...conflictDependencies(),
        ...override,
      }),
    ).toBeNull();
  });

  it("creates a coordinator only with the session-bound key authority", () => {
    expect(createSyncConflictResolutionCoordinator(conflictDependencies())).toBeInstanceOf(
      SyncConflictResolutionCoordinator,
    );
  });
});

function controlDependencies(): CloudSyncControlWiringDependencies {
  return {
    mode: "tauri",
    enabled: true,
    executor,
    cloudSync,
    enrollment,
    clock,
  };
}

function conflictDependencies(): SyncConflictResolutionWiringDependencies {
  return {
    mode: "tauri",
    enabled: true,
    executor,
    syncStore,
    session,
    projectSecurity,
    cloudProjectKeys,
    ids,
    clock,
  };
}

function expectDomain<Value>(
  result: Readonly<{ ok: true; value: Value } | { ok: false; error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
