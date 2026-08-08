import { modelHubNativeEndpointConfig } from "./model-hub-native-config";
import type {
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelProviderConnection,
  NovelTaskRoute,
} from "./model-hub-store";

export class ModelHubFinalDispatchError extends Error {
  public readonly code = "MODEL_HUB_CONFIGURATION_CHANGED_BEFORE_DISPATCH";
  public readonly retryable = true;

  public constructor() {
    super(
      "The Model Hub route, connection, credential, endpoint, model, or policy changed before dispatch.",
    );
    this.name = "ModelHubFinalDispatchError";
  }
}

/**
 * Produces the non-secret identity that must remain stable from preflight to
 * the native gateway call. Revisions catch authoritative mutations while the
 * explicit credential reference and endpoint fields make the security
 * boundary reviewable instead of relying on an incidental object shape.
 */
export function modelHubFinalDispatchIdentity(
  input: Readonly<{
    route?: NovelTaskRoute;
    connection: ModelProviderConnection;
    catalogEntry: ModelCatalogEntry;
    costPrivacy?: ModelCostPrivacyProfile;
  }>,
): string {
  const config = modelHubNativeEndpointConfig(input.connection);
  return JSON.stringify([
    input.route?.task ?? null,
    input.route?.revision ?? null,
    input.route?.enabled ?? null,
    input.route?.primaryCatalogEntryId ?? null,
    input.route?.fallbackCatalogEntryId ?? null,
    input.route?.privacyPolicy ?? null,
    input.route?.failurePolicy ?? null,
    input.connection.id,
    input.connection.revision,
    input.connection.enabled,
    input.connection.providerKind,
    input.connection.protocol,
    input.connection.baseUrl,
    input.connection.credentialRef,
    input.connection.credentialState,
    input.catalogEntry.id,
    input.catalogEntry.revision,
    input.catalogEntry.connectionId,
    input.catalogEntry.providerModelId,
    input.catalogEntry.availability,
    input.catalogEntry.lifecycle,
    input.catalogEntry.staleAfter,
    input.costPrivacy?.revision ?? null,
    config.providerId,
    config.provider,
    config.baseUrl,
    config.authentication,
    config.credentialHeaderName ?? null,
    config.modelDiscoveryPath ?? null,
    config.textGenerationPath ?? null,
    config.embeddingPath ?? null,
    config.requestTimeoutMs ?? null,
    config.retryLimit ?? null,
  ]);
}

export function assertModelHubFinalDispatchUnchanged(expected: string, current: string): void {
  if (expected !== current) {
    throw new ModelHubFinalDispatchError();
  }
}
