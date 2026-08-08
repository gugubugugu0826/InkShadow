import { recoverModelHubCredentialCommitForConnection } from "./model-hub-credential-commit-recovery";
import {
  ModelHubCredentialReferenceError,
  modelHubCredentialProviderId,
  modelHubCredentialRef,
} from "./model-hub-native-config";
import {
  ModelHubStoreError,
  type ModelProviderConnection,
  type SaveModelProviderConnectionInput,
} from "./model-hub-store";
import { clearLegacyModelProfileSelection } from "./model-profile-gateway-config";
import type { DesktopRuntime, SecretSummary } from "./runtime";

export interface SaveModelHubCredentialResult {
  readonly connection: ModelProviderConnection;
  readonly credential: SecretSummary;
  readonly oldCredentialCleanupPending: boolean;
}

export interface DeleteModelHubCredentialResult {
  readonly connection: ModelProviderConnection;
  readonly credential: SecretSummary;
  readonly credentialCleanup: "deleted" | "not_applicable" | "skipped_unowned_reference";
}

/** Saves a secret to a versioned slot and publishes only non-ready metadata. */
export async function saveModelHubCredential(
  runtime: DesktopRuntime,
  input: Readonly<{
    connection: SaveModelProviderConnectionInput;
    secret: string;
  }>,
): Promise<SaveModelHubCredentialResult> {
  const connectionId = input.connection.id;
  await requireRecovered(runtime, connectionId);
  const previous = await runtime.modelHub.findConnection(connectionId);
  const commitId = runtime.ids.next();
  const credentialProviderId = `model-key-${runtime.ids.next()}`;
  await runtime.modelHub.prepareConnectionCommit({
    id: commitId,
    connectionId,
    credentialProviderId,
  });
  let published = false;
  try {
    const credential = await runtime.credentials.save(credentialProviderId, input.secret);
    if (!credential.configured) {
      throw new ModelHubStoreError(
        "MODEL_HUB_CREDENTIAL_SAVE_FAILED",
        "Windows 凭据管理器没有确认新密钥已保存。原有连接保持不变。",
        true,
      );
    }
    const cleanupCredentialProviderId = supersededCredentialProviderId(
      previous,
      credentialProviderId,
    );
    const result = await runtime.modelHub.publishCredentialCommit({
      id: commitId,
      credentialProviderId,
      cleanupCredentialProviderId,
      connection: {
        ...input.connection,
        credentialRef: modelHubCredentialRef(credentialProviderId),
        credentialState: "present",
        enabled: true,
      },
    });
    published = true;
    const cleaned = await recoverModelHubCredentialCommitForConnection(runtime, connectionId);
    return Object.freeze({
      connection: result.connection,
      credential,
      oldCredentialCleanupPending: !cleaned,
    });
  } catch (cause: unknown) {
    if (!published) await requireRecovered(runtime, connectionId, false);
    throw cause;
  }
}

/** Disables the connection atomically before deleting its current vault slot. */
export async function deleteModelHubCredential(
  runtime: DesktopRuntime,
  input: Readonly<{ connection: SaveModelProviderConnectionInput }>,
): Promise<DeleteModelHubCredentialResult> {
  const connectionId = input.connection.id;
  await requireRecovered(runtime, connectionId);
  const previous = await runtime.modelHub.findConnection(connectionId);
  if (
    previous !== null &&
    previous.credentialRef === null &&
    !previous.enabled &&
    previous.credentialState === "missing"
  ) {
    await clearLegacySelectionOrThrow(runtime, connectionId);
    return Object.freeze({
      connection: previous,
      credential: Object.freeze({ configured: false, lastFour: null }),
      credentialCleanup: "not_applicable",
    });
  }
  if (previous === null) {
    throw new ModelHubStoreError(
      "MODEL_HUB_CREDENTIAL_TARGET_MISMATCH",
      "只能删除当前已加载配置的密钥。请先重新选择这项配置。",
      false,
    );
  }
  if (previous.credentialRef === null) {
    throw new ModelHubStoreError(
      "MODEL_HUB_CREDENTIAL_TARGET_MISMATCH",
      "只能删除当前已加载配置的密钥。请先重新选择这项配置。",
      false,
    );
  }
  const cleanupTarget = credentialCleanupTarget(previous);
  const cleanupCredentialProviderId = cleanupTarget.providerId;
  const commitId = runtime.ids.next();
  await runtime.modelHub.prepareConnectionCommit({ id: commitId, connectionId });
  const result = await runtime.modelHub.publishCredentialCommit({
    id: commitId,
    credentialProviderId: null,
    cleanupCredentialProviderId,
    connection: {
      ...input.connection,
      credentialRef: null,
      credentialState: "missing",
      enabled: false,
    },
  });
  if (!(await recoverModelHubCredentialCommitForConnection(runtime, connectionId))) {
    throw new ModelHubStoreError(
      "MODEL_HUB_CREDENTIAL_DELETE_INCOMPLETE",
      "连接已经安全停用，但旧密钥尚未从 Windows 凭据管理器清理。请重试删除。",
      true,
    );
  }
  await clearLegacySelectionOrThrow(runtime, connectionId);
  return Object.freeze({
    connection: result.connection,
    credential: Object.freeze({ configured: false, lastFour: null }),
    credentialCleanup: cleanupTarget.outcome,
  });
}

async function clearLegacySelectionOrThrow(
  runtime: DesktopRuntime,
  connectionId: string,
): Promise<void> {
  try {
    await clearLegacyModelProfileSelection(runtime.modelCenter, connectionId);
  } catch {
    throw new ModelHubStoreError(
      "MODEL_HUB_LEGACY_PROFILE_CLEANUP_FAILED",
      "连接已安全停用且密钥已清理，但旧模型选择尚未清除。请重试删除密钥。",
      true,
    );
  }
}

function supersededCredentialProviderId(
  previous: ModelProviderConnection | null,
  nextCredentialProviderId: string,
): string | null {
  if (
    previous === null ||
    previous.authenticationMode === "none" ||
    previous.credentialRef === null
  ) {
    return null;
  }
  try {
    const previousProviderId = modelHubCredentialProviderId(previous);
    return previousProviderId === nextCredentialProviderId ? null : previousProviderId;
  } catch (cause: unknown) {
    if (cause instanceof ModelHubCredentialReferenceError) return null;
    throw cause;
  }
}

function credentialCleanupTarget(connection: ModelProviderConnection): Readonly<{
  providerId: string | null;
  outcome: DeleteModelHubCredentialResult["credentialCleanup"];
}> {
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
      return Object.freeze({ providerId: null, outcome: "skipped_unowned_reference" });
    }
    throw cause;
  }
}

async function requireRecovered(
  runtime: DesktopRuntime,
  connectionId: string,
  throwWhenPending = true,
): Promise<void> {
  if (await recoverModelHubCredentialCommitForConnection(runtime, connectionId)) return;
  if (!throwWhenPending) {
    throw new ModelHubStoreError(
      "MODEL_HUB_CREDENTIAL_COMMIT_CLEANUP_FAILED",
      "新密钥没有发布，待验证凭据仍需清理。原有连接保持不变，请重试。",
      true,
    );
  }
  throw new ModelHubStoreError(
    "MODEL_HUB_CREDENTIAL_COMMIT_RECOVERY_PENDING",
    "上一次密钥操作仍需安全清理。当前已发布连接保持不变，请稍后重试。",
    true,
  );
}
