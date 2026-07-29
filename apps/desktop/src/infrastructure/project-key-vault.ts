import { invoke } from "@tauri-apps/api/core";
import type {
  CloudTeamProjectKeyEnvelopePublishRequest,
  DeviceProjectKeyEnvelopeContract,
  RecoveryProjectKeyEnvelopeContract,
} from "@inkshadow/contracts";
import type { TeamProjectKeyReceiptMetadata } from "@inkshadow/data/project-key-sqlite-store";

import { normalizeNativeCloudCommandError } from "./tauri-cloud-transport";

export interface DeviceIdentitySummary {
  readonly schemaVersion: 1;
  readonly deviceId: string;
  readonly algorithm: "DHKEM-P256-HKDF-SHA256";
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly privateKeyStorage: "os_credential_store";
}

export interface DeviceIdentityStatus {
  readonly configured: boolean;
  readonly identity: DeviceIdentitySummary | null;
}

export interface ProjectDataKeyMaterial {
  readonly rawProjectDataKey: string;
  readonly projectKeyFingerprint: string;
}

export type NativeDeviceProjectKeyEnvelope = Omit<
  DeviceProjectKeyEnvelopeContract,
  "createdAt" | "revokedAt"
>;

export type NativeTeamProjectKeyEnvelope = CloudTeamProjectKeyEnvelopePublishRequest;

export type NativeRecoveryProjectKeyEnvelope = Omit<
  RecoveryProjectKeyEnvelopeContract,
  "createdAt" | "confirmedAt" | "revokedAt"
>;

export interface WrapProjectDataKeyInput {
  readonly envelopeId: string;
  readonly projectId: string;
  readonly keyVersion: number;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  readonly recipientPublicKey: string;
  readonly recipientPublicKeyFingerprint: string;
  readonly rawProjectDataKey: string;
}

export interface TeamProjectKeyRecipientInput {
  readonly envelopeId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly recipientDeviceId: string;
  readonly recipientPublicKey: string;
  readonly recipientPublicKeyFingerprint: string;
}

export interface RewrapProjectDataKeyForTeamRecipientsInput {
  readonly teamId: string;
  readonly projectId: string;
  readonly keyVersion: number;
  readonly senderDeviceId: string;
  readonly sourceEnvelope: NativeDeviceProjectKeyEnvelope;
  readonly recipients: readonly TeamProjectKeyRecipientInput[];
}

export type NativeTeamProjectKeyReceiptBinding = Omit<
  TeamProjectKeyReceiptMetadata,
  "state" | "receivedAt" | "lastVerifiedAt" | "stateUpdatedAt"
>;

export type NativeTeamProjectKeyReceiptCommit = NativeTeamProjectKeyReceiptBinding & {
  readonly nativeWriteState: "created" | "already_present" | "updated";
};

export interface NativeTeamProjectKeyReceiptStatus {
  readonly configured: boolean;
  readonly nativeReceiptFingerprint: string | null;
}

export interface NativeTeamProjectKeyReceiptRemoval {
  readonly removed: boolean;
}

export interface AcceptCurrentDeviceTeamProjectKeyEnvelopeInput {
  readonly teamId: string;
  readonly projectId: string;
  readonly expectedSessionId: string;
  readonly expectedAccountId: string;
  readonly expectedDeviceId: string;
  readonly expectedRecipientPublicKey: string;
  readonly expectedRecipientPublicKeyFingerprint: string;
}

export interface TeamProjectKeyReceiptAccessInput {
  readonly expectedSessionId: string | null;
  readonly receipt: NativeTeamProjectKeyReceiptBinding;
}

export interface CreateRecoveryKitInput {
  readonly recoveryId: string;
  readonly projectId: string;
  readonly keyVersion: number;
  readonly rawProjectDataKey: string;
}

export interface RecoveryKit {
  readonly recoveryCode: string;
  readonly envelope: NativeRecoveryProjectKeyEnvelope;
}

export interface RecoveryVerification {
  readonly valid: true;
  readonly projectKeyFingerprint: string;
}

export interface ProjectKeyVault {
  readonly available: boolean;
  createDeviceIdentity(deviceId: string): Promise<DeviceIdentitySummary>;
  getDeviceIdentityStatus(deviceId: string): Promise<DeviceIdentityStatus>;
  generateProjectDataKey(): Promise<ProjectDataKeyMaterial>;
  wrapProjectDataKeyForDevice(
    input: WrapProjectDataKeyInput,
  ): Promise<NativeDeviceProjectKeyEnvelope>;
  unwrapProjectDataKeyForDevice(
    envelope: NativeDeviceProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial>;
  rewrapProjectDataKeyForTeamRecipients(
    input: RewrapProjectDataKeyForTeamRecipientsInput,
  ): Promise<readonly NativeTeamProjectKeyEnvelope[]>;
  acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud(
    input: AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
  ): Promise<NativeTeamProjectKeyReceiptCommit>;
  inspectStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptStatus>;
  openStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<ProjectDataKeyMaterial>;
  removeStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptRemoval>;
  createProjectRecoveryKit(input: CreateRecoveryKitInput): Promise<RecoveryKit>;
  verifyProjectRecoveryKit(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<RecoveryVerification>;
  recoverProjectDataKey(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial>;
}

export class TauriProjectKeyVault implements ProjectKeyVault {
  public readonly available = true;

  public createDeviceIdentity(deviceId: string): Promise<DeviceIdentitySummary> {
    return invoke<DeviceIdentitySummary>("create_device_identity", { deviceId });
  }

  public getDeviceIdentityStatus(deviceId: string): Promise<DeviceIdentityStatus> {
    return invoke<DeviceIdentityStatus>("get_device_identity_status", { deviceId });
  }

  public generateProjectDataKey(): Promise<ProjectDataKeyMaterial> {
    return invoke<ProjectDataKeyMaterial>("generate_project_data_key");
  }

  public wrapProjectDataKeyForDevice(
    input: WrapProjectDataKeyInput,
  ): Promise<NativeDeviceProjectKeyEnvelope> {
    return invoke<NativeDeviceProjectKeyEnvelope>("wrap_project_data_key_for_device", { input });
  }

  public unwrapProjectDataKeyForDevice(
    envelope: NativeDeviceProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial> {
    return invoke<ProjectDataKeyMaterial>("unwrap_project_data_key_for_device", { envelope });
  }

  public rewrapProjectDataKeyForTeamRecipients(
    input: RewrapProjectDataKeyForTeamRecipientsInput,
  ): Promise<readonly NativeTeamProjectKeyEnvelope[]> {
    return invoke<readonly NativeTeamProjectKeyEnvelope[]>(
      "rewrap_project_data_key_for_team_recipients",
      { input },
    );
  }

  public async acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud(
    input: AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
  ): Promise<NativeTeamProjectKeyReceiptCommit> {
    try {
      return await invoke<NativeTeamProjectKeyReceiptCommit>(
        "accept_current_device_team_project_key_envelope_from_cloud",
        { input },
      );
    } catch (cause: unknown) {
      throw normalizeNativeCloudCommandError(cause, null);
    }
  }

  public async inspectStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptStatus> {
    try {
      return await invoke<NativeTeamProjectKeyReceiptStatus>(
        "inspect_stored_team_project_key_receipt",
        { input },
      );
    } catch (cause: unknown) {
      throw normalizeNativeCloudCommandError(cause, null);
    }
  }

  public async openStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<ProjectDataKeyMaterial> {
    try {
      return await invoke<ProjectDataKeyMaterial>("open_stored_team_project_key_receipt", {
        input,
      });
    } catch (cause: unknown) {
      throw normalizeNativeCloudCommandError(cause, null);
    }
  }

  public async removeStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptRemoval> {
    try {
      return await invoke<NativeTeamProjectKeyReceiptRemoval>(
        "remove_stored_team_project_key_receipt",
        { input },
      );
    } catch (cause: unknown) {
      throw normalizeNativeCloudCommandError(cause, null);
    }
  }

  public createProjectRecoveryKit(input: CreateRecoveryKitInput): Promise<RecoveryKit> {
    return invoke<RecoveryKit>("create_project_recovery_kit", { input });
  }

  public verifyProjectRecoveryKit(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<RecoveryVerification> {
    return invoke<RecoveryVerification>("verify_project_recovery_kit", {
      input: { recoveryCode, envelope },
    });
  }

  public recoverProjectDataKey(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial> {
    return invoke<ProjectDataKeyMaterial>("recover_project_data_key", {
      input: { recoveryCode, envelope },
    });
  }
}

export class BrowserDevelopmentProjectKeyVault implements ProjectKeyVault {
  public readonly available = false;

  public createDeviceIdentity(deviceId: string): Promise<DeviceIdentitySummary> {
    void deviceId;
    return unavailable();
  }

  public getDeviceIdentityStatus(deviceId: string): Promise<DeviceIdentityStatus> {
    void deviceId;
    return Promise.resolve({ configured: false, identity: null });
  }

  public generateProjectDataKey(): Promise<ProjectDataKeyMaterial> {
    return unavailable();
  }

  public wrapProjectDataKeyForDevice(
    input: WrapProjectDataKeyInput,
  ): Promise<NativeDeviceProjectKeyEnvelope> {
    void input;
    return unavailable();
  }

  public unwrapProjectDataKeyForDevice(
    envelope: NativeDeviceProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial> {
    void envelope;
    return unavailable();
  }

  public rewrapProjectDataKeyForTeamRecipients(
    input: RewrapProjectDataKeyForTeamRecipientsInput,
  ): Promise<readonly NativeTeamProjectKeyEnvelope[]> {
    void input;
    return unavailable();
  }

  public acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud(
    input: AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
  ): Promise<NativeTeamProjectKeyReceiptCommit> {
    void input;
    return unavailable();
  }

  public inspectStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptStatus> {
    void input;
    return unavailable();
  }

  public openStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<ProjectDataKeyMaterial> {
    void input;
    return unavailable();
  }

  public removeStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptRemoval> {
    void input;
    return unavailable();
  }

  public createProjectRecoveryKit(input: CreateRecoveryKitInput): Promise<RecoveryKit> {
    void input;
    return unavailable();
  }

  public verifyProjectRecoveryKit(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<RecoveryVerification> {
    void recoveryCode;
    void envelope;
    return unavailable();
  }

  public recoverProjectDataKey(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial> {
    void recoveryCode;
    void envelope;
    return unavailable();
  }
}

function unavailable<Value>(): Promise<Value> {
  return Promise.reject(new Error("浏览器开发模式不提供设备私钥、项目密钥或恢复码操作。"));
}
