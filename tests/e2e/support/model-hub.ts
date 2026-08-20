import type { Page } from "@playwright/test";

const DEVELOPMENT_MODEL_HUB_KEY = "inkshadow.development.model-hub.v1";
const FIXTURE_TIME = "2026-08-20T00:00:00.000Z";

export const LONG_MODEL_HUB_CONNECTION_ID = "long-responsive-provider";
export const LONG_MODEL_HUB_RETIRED_CONNECTION_ID = "retired-responsive-provider";
export const LONG_MODEL_HUB_PROVIDER_NAME =
  "极长供应商名称 · 用于验证窄窗口、深色模式、长地址和退役历史不会撑破普通卡片";
export const LONG_MODEL_HUB_RETIRED_PROVIDER_NAME =
  "已退役的极长历史供应商名称 · 不应恢复为可调用连接";
export const LONG_MODEL_HUB_BASE_URL =
  "https://api.responsive-fixture.example/very/long/tenant/path/with/many/segments/openai-compatible/v1";
export const LONG_MODEL_HUB_MODEL_ID =
  "publisher/fiction-reasoning-model-with-an-intentionally-long-version-and-context-window-2026-08-20";

/** A validated BrowserDevelopmentModelHubStore schema-v7 snapshot. */
export async function seedLongModelHubFixture(page: Page): Promise<void> {
  const fixture = {
    key: DEVELOPMENT_MODEL_HUB_KEY,
    value: {
      schemaVersion: 7,
      state: {
        connectionCommits: {},
        connections: {
          [LONG_MODEL_HUB_CONNECTION_ID]: {
            id: LONG_MODEL_HUB_CONNECTION_ID,
            providerKind: "custom_openai_compatible",
            displayName: LONG_MODEL_HUB_PROVIDER_NAME,
            protocol: "openai_compatible",
            region: null,
            workspaceId: null,
            endpointId: null,
            baseUrl: LONG_MODEL_HUB_BASE_URL,
            credentialRef: null,
            credentialState: "missing",
            authenticationMode: "none",
            credentialHeaderName: null,
            modelDiscoveryPath: null,
            textGenerationPath: null,
            embeddingPath: null,
            requestTimeoutMs: 30_000,
            retryLimit: 0,
            connectionStatus: "not_tested",
            catalogSyncStatus: "succeeded",
            lastTestedAt: null,
            lastCatalogSyncedAt: FIXTURE_TIME,
            lastErrorCode: null,
            lastErrorSummary: null,
            legacyProviderId: null,
            enabled: true,
            revision: 2,
            createdAt: FIXTURE_TIME,
            updatedAt: FIXTURE_TIME,
          },
          [LONG_MODEL_HUB_RETIRED_CONNECTION_ID]: {
            id: LONG_MODEL_HUB_RETIRED_CONNECTION_ID,
            providerKind: "custom_openai_compatible",
            displayName: LONG_MODEL_HUB_RETIRED_PROVIDER_NAME,
            protocol: "openai_compatible",
            region: null,
            workspaceId: null,
            endpointId: null,
            baseUrl:
              "https://retired.responsive-fixture.example/archive/long/provider/base/path/v1",
            credentialRef: null,
            credentialState: "missing",
            authenticationMode: "none",
            credentialHeaderName: null,
            modelDiscoveryPath: null,
            textGenerationPath: null,
            embeddingPath: null,
            requestTimeoutMs: 30_000,
            retryLimit: 0,
            connectionStatus: "disabled",
            catalogSyncStatus: "never",
            lastTestedAt: null,
            lastCatalogSyncedAt: null,
            lastErrorCode: "MODEL_HUB_CONNECTION_RETIRED",
            lastErrorSummary:
              "The connection was retired. Its credential reference was cleared while immutable invocation history was retained.",
            legacyProviderId: null,
            enabled: false,
            revision: 2,
            createdAt: FIXTURE_TIME,
            updatedAt: FIXTURE_TIME,
          },
        },
        catalog: {
          "long-responsive-model-entry": {
            id: "long-responsive-model-entry",
            connectionId: LONG_MODEL_HUB_CONNECTION_ID,
            providerModelId: LONG_MODEL_HUB_MODEL_ID,
            displayName: LONG_MODEL_HUB_MODEL_ID,
            ownedBy: null,
            catalogSource: "manual",
            availability: "available",
            lifecycle: "unknown",
            inputTokenLimit: null,
            outputTokenLimit: null,
            firstDiscoveredAt: FIXTURE_TIME,
            lastSeenAt: FIXTURE_TIME,
            staleAfter: null,
            lastSyncId: "long-responsive-provider-sync",
            revision: 1,
          },
        },
        catalogSyncs: {
          "long-responsive-provider-sync": {
            id: "long-responsive-provider-sync",
            connectionId: LONG_MODEL_HUB_CONNECTION_ID,
            source: "manual",
            status: "succeeded",
            discoveredModelCount: 1,
            nextPageTokenPresent: false,
            errorCode: null,
            errorSummary: null,
            startedAt: FIXTURE_TIME,
            completedAt: FIXTURE_TIME,
          },
        },
        capabilityEvidence: {},
        capabilityScans: {},
        costPrivacyProfiles: {},
        evaluationResults: {},
        presets: {},
        routes: {
          continuation: {
            task: "continuation",
            primaryCatalogEntryId: "long-responsive-model-entry",
            fallbackCatalogEntryId: null,
            presetId: null,
            parameterPolicy: {},
            maximumCostMicros: "123456789",
            currency: "USD",
            privacyPolicy: "cloud_allowed",
            failurePolicy: "stop",
            routeOrigin: "user",
            enabled: true,
            revision: 1,
            createdAt: FIXTURE_TIME,
            updatedAt: FIXTURE_TIME,
          },
        },
        invocations: {},
      },
    },
  };
  const install = ({ key, value }: typeof fixture) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  };
  // Keep the authority fixture deterministic across real document reloads
  // (including the CDP 200%-equivalent viewport transition), not only across
  // same-document hash navigation.
  await page.addInitScript(install, fixture);
  await page.evaluate(install, fixture);
  // The desktop runtime hydrates Model Hub once during application startup.
  // A storage mutation followed only by hash navigation would leave that
  // already-created in-memory store empty, so reload after installing the
  // pre-document seed and let production startup consume the fixture.
  await page.reload();
}
