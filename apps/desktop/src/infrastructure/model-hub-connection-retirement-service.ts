import type { ModelCenterStore } from "./model-center-store";
import {
  ModelHubCredentialReferenceError,
  modelHubCredentialProviderId,
} from "./model-hub-native-config";
import {
  isRetiredModelProviderConnection,
  ModelHubStoreError,
  type ModelHubStore,
  type ModelProviderConnection,
} from "./model-hub-store";
import type { CredentialStore, SecretSummary } from "./runtime";

export interface RetireModelHubConnectionResult {
  readonly connection: ModelProviderConnection;
  readonly credential: SecretSummary;
  readonly credentialCleanup:
    "deleted" | "shared" | "not_applicable" | "already_retired" | "skipped_unowned_reference";
}

/**
 * Retires a connection without deleting its catalog or immutable invocation ledger.
 *
 * The Model Hub row is disabled first so every new production route fails closed.
 * Legacy profile selection and the operating-system credential are then cleared in
 * parallel. A partial failure is explicitly retryable; the store retirement itself
 * is idempotent, so retrying can safely finish the remaining cleanup.
 */
export async function retireModelHubConnection(
  dependencies: Readonly<{
    modelHub: Pick<
      ModelHubStore,
      "findConnection" | "listConnections" | "saveConnection" | "retireConnection"
    >;
    modelCenter: Pick<ModelCenterStore, "findByProviderId" | "save">;
    credentials: Pick<CredentialStore, "delete">;
  }>,
  input: Readonly<{ connectionId: string; expectedRevision: number }>,
): Promise<RetireModelHubConnectionResult> {
  const previous = await dependencies.modelHub.findConnection(input.connectionId);
  if (previous === null) {
    throw new ModelHubStoreError(
      "MODEL_HUB_CONNECTION_NOT_FOUND",
      "The provider connection does not exist.",
      false,
    );
  }
  if (!isRetiredModelProviderConnection(previous) && previous.revision !== input.expectedRevision) {
    throw new ModelHubStoreError(
      "MODEL_HUB_CONNECTION_CONFLICT",
      "The provider connection changed before it could be retired.",
      true,
    );
  }
  const credentialTarget = resolveCredentialCleanupTarget(previous);
  const disabled =
    isRetiredModelProviderConnection(previous) || !previous.enabled
      ? previous
      : await dependencies.modelHub.saveConnection({
          id: previous.id,
          providerKind: previous.providerKind,
          displayName: previous.displayName,
          region: previous.region,
          workspaceId: previous.workspaceId,
          endpointId: previous.endpointId,
          baseUrlOverride: previous.baseUrl,
          credentialRef: previous.credentialRef,
          credentialState: previous.credentialState,
          authenticationMode: previous.authenticationMode,
          credentialHeaderName: previous.credentialHeaderName,
          modelDiscoveryPath: previous.modelDiscoveryPath,
          textGenerationPath: previous.textGenerationPath,
          embeddingPath: previous.embeddingPath,
          requestTimeoutMs: previous.requestTimeoutMs,
          retryLimit: previous.retryLimit,
          legacyProviderId: previous.legacyProviderId,
          enabled: false,
          expectedRevision: previous.revision,
        });
  const sharedCredential =
    credentialTarget.providerId === null
      ? false
      : await credentialProviderUsedByAnotherConnection(
          dependencies.modelHub,
          credentialTarget.providerId,
          previous.id,
        );
  const [legacyResult, credentialResult] = await Promise.allSettled([
    clearLegacyProfileSelection(dependencies.modelCenter, previous.id),
    credentialTarget.providerId === null || sharedCredential
      ? Promise.resolve({ configured: false, lastFour: null })
      : dependencies.credentials.delete(credentialTarget.providerId),
  ]);
  if (legacyResult.status === "rejected" || credentialResult.status === "rejected") {
    throw new ModelHubStoreError(
      "MODEL_HUB_CONNECTION_RETIREMENT_INCOMPLETE",
      "连接已停止参与创作任务安排，但旧模型选择或系统凭据尚未完全清理。请重试“移除连接”；已生成内容和历史模型使用记录不会受影响。",
      true,
    );
  }
  if (credentialResult.value.configured) {
    throw new ModelHubStoreError(
      "MODEL_HUB_CREDENTIAL_DELETE_FAILED",
      "连接已停止参与创作任务安排，但系统凭据库仍报告密钥存在。请重试“移除连接”。",
      true,
    );
  }
  const connection = isRetiredModelProviderConnection(disabled)
    ? disabled
    : await dependencies.modelHub.retireConnection({
        connectionId: disabled.id,
        expectedRevision: disabled.revision,
      });
  return Object.freeze({
    connection,
    credential: credentialResult.value,
    credentialCleanup: sharedCredential ? "shared" : credentialTarget.outcome,
  });
}

function resolveCredentialCleanupTarget(connection: ModelProviderConnection): Readonly<{
  providerId: string | null;
  outcome: Exclude<RetireModelHubConnectionResult["credentialCleanup"], "shared">;
}> {
  if (isRetiredModelProviderConnection(connection)) {
    return Object.freeze({ providerId: null, outcome: "already_retired" });
  }
  if (
    connection.authenticationMode === "none" ||
    connection.credentialState !== "present" ||
    connection.credentialRef === null
  ) {
    return Object.freeze({ providerId: null, outcome: "not_applicable" });
  }
  try {
    return Object.freeze({
      providerId: modelHubCredentialProviderId(connection),
      outcome: "deleted",
    });
  } catch (cause: unknown) {
    if (cause instanceof ModelHubCredentialReferenceError) {
      // Never guess a vault slot from an unowned or malformed reference. The DB
      // row can still be disabled and retired safely so the bad connection is no
      // longer user-reachable or eligible for routing.
      return Object.freeze({ providerId: null, outcome: "skipped_unowned_reference" });
    }
    throw cause;
  }
}

async function credentialProviderUsedByAnotherConnection(
  modelHub: Pick<ModelHubStore, "listConnections">,
  credentialProviderId: string,
  excludedConnectionId: string,
): Promise<boolean> {
  for (const connection of await modelHub.listConnections()) {
    if (connection.id === excludedConnectionId || connection.authenticationMode === "none") {
      continue;
    }
    try {
      if (modelHubCredentialProviderId(connection) === credentialProviderId) return true;
    } catch {
      // Invalid references are unusable and cannot authorize deletion of this slot.
    }
  }
  return false;
}

async function clearLegacyProfileSelection(
  modelCenter: Pick<ModelCenterStore, "findByProviderId" | "save">,
  providerId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const profile = await modelCenter.findByProviderId(providerId);
    if (profile?.selectedModel == null) {
      return;
    }
    try {
      await modelCenter.save({
        providerId: profile.providerId,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        authentication: profile.authentication,
        selectedModel: null,
        pricing: profile.pricing,
        expectedRevision: profile.revision,
      });
      return;
    } catch (cause: unknown) {
      if (attempt === 1) {
        throw cause;
      }
    }
  }
  throw new ModelHubStoreError(
    "MODEL_HUB_LEGACY_PROFILE_RETIREMENT_FAILED",
    "The legacy model selection could not be cleared.",
    true,
  );
}
