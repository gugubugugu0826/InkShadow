import { invoke } from "@tauri-apps/api/core";

export type SecureUpdatePlanState =
  "up_to_date" | "update_available" | "rollback_available" | "manual_update_required";

export interface SecureUpdateConfiguration {
  readonly enabled: boolean;
  readonly currentVersion: string;
  readonly channel: "stable" | "beta" | "invalid";
  readonly disabledReason: string | null;
  readonly executesInstaller: false;
}

export interface SignedUpdateCheck {
  readonly planId: string | null;
  readonly state: SecureUpdatePlanState;
  readonly currentVersion: string;
  readonly releaseVersion: string;
  readonly publishedAt: number;
  readonly expiresAt: number;
  readonly manifestSequence: number;
  readonly signingKeyId: string;
  readonly mandatory: boolean;
  readonly artifactSizeBytes: number;
  readonly artifactSha256: string;
  readonly releaseNotesUrl: string | null;
  readonly installerExecutionAllowed: false;
}

export interface StagedUpdateReceipt {
  readonly planId: string;
  readonly releaseVersion: string;
  readonly manifestSequence: number;
  readonly signingKeyId: string;
  readonly artifactSizeBytes: number;
  readonly artifactSha256: string;
  readonly packageState: "digest_verified_inert_staging";
  readonly authenticodeStatus: "not_verified";
  readonly installationAllowed: false;
  readonly nextRequiredAction: "VERIFY_AUTHENTICODE_PUBLISHER_IN_RELEASE_PIPELINE";
}

export interface SecureUpdaterPort {
  inspectConfiguration(): Promise<SecureUpdateConfiguration>;
  check(): Promise<SignedUpdateCheck>;
  stage(planId: string): Promise<StagedUpdateReceipt>;
}

export class TauriSecureUpdater implements SecureUpdaterPort {
  public inspectConfiguration(): Promise<SecureUpdateConfiguration> {
    return invoke<SecureUpdateConfiguration>("inspect_secure_update_configuration");
  }

  public check(): Promise<SignedUpdateCheck> {
    return invoke<SignedUpdateCheck>("check_for_signed_update");
  }

  public stage(planId: string): Promise<StagedUpdateReceipt> {
    if (!/^[0-9a-f]{64}$/u.test(planId)) {
      return Promise.reject(nativeUpdateError("UPDATE_PLAN_MISSING", false));
    }
    return invoke<StagedUpdateReceipt>("stage_signed_update", {
      planId,
    });
  }
}

export class BrowserDevelopmentSecureUpdater implements SecureUpdaterPort {
  public inspectConfiguration(): Promise<SecureUpdateConfiguration> {
    return Promise.resolve({
      enabled: false,
      currentVersion: "browser-development",
      channel: "stable",
      disabledReason: "UPDATE_NATIVE_RUNTIME_REQUIRED",
      executesInstaller: false,
    });
  }

  public check(): Promise<SignedUpdateCheck> {
    return Promise.reject(nativeUpdateError("UPDATE_NATIVE_RUNTIME_REQUIRED", false));
  }

  public stage(): Promise<StagedUpdateReceipt> {
    return Promise.reject(nativeUpdateError("UPDATE_NATIVE_RUNTIME_REQUIRED", false));
  }
}

function nativeUpdateError(
  code: string,
  retryable: boolean,
): Readonly<{
  name: string;
  code: string;
  message: string;
  retryable: boolean;
  actions: readonly string[];
}> &
  Error {
  return Object.assign(new Error("安全更新只在已配置的桌面发行版本中可用。"), {
    name: "SecureUpdaterUnavailableError",
    code,
    retryable,
    actions: ["USE_MANUAL_DOWNLOAD"] as const,
  });
}
