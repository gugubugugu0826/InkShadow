import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEATURE_FLAGS,
  FeatureFlagDependencyError,
  FeatureFlagPolicyError,
  parseRuntimeEnvironment,
  parseUserSettings,
  resolveFeatureFlags,
} from "../src/index.js";

describe("runtime environment", () => {
  it("parses explicit false without JavaScript truthiness surprises", () => {
    const environment = parseRuntimeEnvironment({
      INKSHADOW_TELEMETRY_ENABLED: "false",
      INKSHADOW_LOCAL_SERVICE_HOST: "127.0.0.1",
    });

    expect(environment.telemetryEnabled).toBe(false);
    expect(environment.localServiceHost).toBe("127.0.0.1");
  });

  it("rejects non-loopback local service hosts", () => {
    expect(() =>
      parseRuntimeEnvironment({
        INKSHADOW_LOCAL_SERVICE_HOST: "0.0.0.0",
      }),
    ).toThrow();
  });

  it("requires HTTPS for non-loopback sync endpoints", () => {
    expect(() =>
      parseRuntimeEnvironment({
        INKSHADOW_SYNC_API_URL: "http://sync.example.com",
      }),
    ).toThrow();

    expect(
      parseRuntimeEnvironment({
        INKSHADOW_SYNC_API_URL: "http://localhost:8080",
      }).syncApiUrl,
    ).toBe("http://localhost:8080");
  });
});

describe("user settings", () => {
  it("defaults sync, telemetry, and automatic memory learning to off", () => {
    const settings = parseUserSettings({});

    expect(settings.syncEnabled).toBe(false);
    expect(settings.telemetryEnabled).toBe(false);
    expect(settings.automaticMemoryLearning).toBe(false);
    expect(settings.diagnosticsRedaction).toBe(true);
    expect(settings.autosaveDebounceMs).toBe(800);
  });

  it("keeps autosave debounce inside the supported safety range", () => {
    expect(parseUserSettings({ autosaveDebounceMs: 250 }).autosaveDebounceMs).toBe(250);
    expect(parseUserSettings({ autosaveDebounceMs: 5_000 }).autosaveDebounceMs).toBe(5_000);
    expect(() => parseUserSettings({ autosaveDebounceMs: 249 })).toThrow();
    expect(() => parseUserSettings({ autosaveDebounceMs: 5_001 })).toThrow();
  });

  it("rejects unknown settings, including accidental secret fields", () => {
    expect(() =>
      parseUserSettings({
        apiKey: "must-not-enter-user-settings",
      }),
    ).toThrow();
  });
});

describe("feature flags", () => {
  it("keeps cloud and advanced capabilities disabled by default", () => {
    expect(DEFAULT_FEATURE_FLAGS.cloudIdentity).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.cloudSync).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.teamCollaboration).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.authoritativeExtraction).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.multiAgent).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.communityMarketplace).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.operationsAdmin).toBe(false);
  });

  it("allows explicit non-safety overrides", () => {
    const flags = resolveFeatureFlags({
      cloudIdentity: true,
      cloudSync: true,
    });

    expect(flags.cloudIdentity).toBe(true);
    expect(flags.cloudSync).toBe(true);
    expect(flags.aiCandidateIsolation).toBe(true);
  });

  it("requires the cloud identity gate before cloud synchronization", () => {
    expect(() =>
      resolveFeatureFlags({
        cloudSync: true,
      }),
    ).toThrow(FeatureFlagDependencyError);
  });

  it("requires the cloud identity gate before team collaboration", () => {
    expect(() =>
      resolveFeatureFlags({
        teamCollaboration: true,
      }),
    ).toThrow(FeatureFlagDependencyError);
  });

  it("requires the cloud identity gate before the remote community marketplace", () => {
    expect(() =>
      resolveFeatureFlags({
        communityMarketplace: true,
      }),
    ).toThrow(FeatureFlagDependencyError);
    expect(
      resolveFeatureFlags({
        cloudIdentity: true,
        communityMarketplace: true,
      }).communityMarketplace,
    ).toBe(true);
  });

  it("requires GraphRAG before authoritative extraction", () => {
    expect(() =>
      resolveFeatureFlags({
        authoritativeExtraction: true,
      }),
    ).toThrow(FeatureFlagDependencyError);

    expect(
      resolveFeatureFlags({
        graphRag: true,
        authoritativeExtraction: true,
      }).authoritativeExtraction,
    ).toBe(true);
  });

  it("refuses to disable candidate isolation", () => {
    expect(() =>
      resolveFeatureFlags({
        aiCandidateIsolation: false,
      }),
    ).toThrow(FeatureFlagPolicyError);
  });
});
