import { modelHubCredentialProviderId } from "./model-hub-native-config";
import type { ModelHubConnectionCommit, ModelHubStore } from "./model-hub-store";

interface CredentialCommitRecoveryDependencies {
  readonly modelHub: Pick<
    ModelHubStore,
    "listConnections" | "listConnectionCommits" | "findConnectionCommit" | "finishConnectionCommit"
  >;
  readonly credentials: Readonly<{
    delete(providerId: string): Promise<Readonly<{ configured: boolean }>>;
  }>;
}

export interface ModelHubCredentialCommitRecoveryResult {
  readonly recoveredCount: number;
  readonly remainingCount: number;
}

/**
 * Recovers every cross-vault/SQLite connection commit, including a prepared
 * commit for a connection row that was never published. Cleanup is best effort:
 * an unavailable vault leaves the journal for retry and never disables a fully
 * published connection.
 */
export async function recoverModelHubCredentialCommits(
  dependencies: CredentialCommitRecoveryDependencies,
): Promise<ModelHubCredentialCommitRecoveryResult> {
  const commits = await dependencies.modelHub.listConnectionCommits();
  const activeCredentialProviderIds = await listActiveCredentialProviderIds(dependencies);
  let recoveredCount = 0;
  for (const commit of commits) {
    if (await recoverCommit(dependencies, commit, activeCredentialProviderIds).catch(() => false)) {
      recoveredCount += 1;
    }
  }
  return Object.freeze({
    recoveredCount,
    remainingCount: commits.length - recoveredCount,
  });
}

export async function recoverModelHubCredentialCommitForConnection(
  dependencies: CredentialCommitRecoveryDependencies,
  connectionId: string,
): Promise<boolean> {
  const commit = await dependencies.modelHub.findConnectionCommit(connectionId);
  if (commit === null) return true;
  const activeCredentialProviderIds = await listActiveCredentialProviderIds(dependencies);
  return recoverCommit(dependencies, commit, activeCredentialProviderIds).catch(() => false);
}

async function recoverCommit(
  dependencies: CredentialCommitRecoveryDependencies,
  commit: ModelHubConnectionCommit,
  activeCredentialProviderIds: ReadonlySet<string>,
): Promise<boolean> {
  const cleanupProviderId =
    commit.phase === "prepared" ? commit.credentialProviderId : commit.cleanupCredentialProviderId;
  if (cleanupProviderId !== null) {
    // A malformed or stale journal must never delete the slot currently used
    // by any published connection. A prepared slot remains pending because an
    // active reference would make publication state ambiguous. A superseded
    // cleanup slot can simply be retained when another connection still owns
    // it; the journal itself is then complete and must not block future saves.
    if (activeCredentialProviderIds.has(cleanupProviderId)) {
      if (commit.phase === "prepared") return false;
      await dependencies.modelHub.finishConnectionCommit(commit.connectionId, commit.id);
      return true;
    }
    const summary = await dependencies.credentials.delete(cleanupProviderId);
    if (summary.configured) return false;
  }
  await dependencies.modelHub.finishConnectionCommit(commit.connectionId, commit.id);
  return true;
}

async function listActiveCredentialProviderIds(
  dependencies: CredentialCommitRecoveryDependencies,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const connection of await dependencies.modelHub.listConnections()) {
    if (connection.authenticationMode === "none" || connection.credentialRef === null) continue;
    try {
      ids.add(modelHubCredentialProviderId(connection));
    } catch {
      // Invalid references already fail closed in the native endpoint builder.
      // They cannot authorize deletion of an unrelated InkShadow-owned slot.
    }
  }
  return ids;
}
