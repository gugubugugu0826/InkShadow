import { invoke } from "@tauri-apps/api/core";
import {
  CloudAccountContractSchema,
  CloudDeviceContractSchema,
  CloudSessionContractSchema,
  IsoUtcTimestampSchema,
  type CloudAccountContract,
  type CloudDeviceContract,
  type CloudSessionContract,
} from "@inkshadow/contracts";
import { z } from "zod";

export interface CloudEndpoint {
  readonly baseUrl: string;
  readonly allowInsecureLoopback?: boolean;
}

export interface CloudSessionDeviceInput {
  readonly deviceId: string;
  readonly displayName: string;
}

export interface CloudLoginInput extends CloudSessionDeviceInput {
  readonly email: string;
  readonly password: string;
}

export interface CloudEmailVerificationInput extends CloudSessionDeviceInput {
  readonly challengeId: string;
  readonly code: string;
}

export interface CloudSessionExpirySummary {
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
}

export interface CloudSessionVaultStatus {
  readonly configured: boolean;
  readonly account: CloudAccountContract | null;
  readonly device: CloudDeviceContract | null;
  readonly session: CloudSessionContract | null;
  readonly expiry: CloudSessionExpirySummary | null;
}

export interface CloudSessionVault {
  readonly available: boolean;
  login(input: CloudLoginInput): Promise<CloudSessionVaultStatus>;
  verifyEmail(input: CloudEmailVerificationInput): Promise<CloudSessionVaultStatus>;
  refresh(expectedSessionId: string): Promise<CloudSessionVaultStatus>;
  getStatus(): Promise<CloudSessionVaultStatus>;
  logout(expectedSessionId: string): Promise<CloudSessionVaultStatus>;
  clear(expectedSessionId?: string): Promise<CloudSessionVaultStatus>;
}

const CloudSessionVaultStatusSchema = z
  .object({
    configured: z.boolean(),
    account: CloudAccountContractSchema.nullable(),
    device: CloudDeviceContractSchema.nullable(),
    session: CloudSessionContractSchema.nullable(),
    expiry: z
      .object({
        accessExpiresAt: IsoUtcTimestampSchema,
        refreshExpiresAt: IsoUtcTimestampSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((status, context) => {
    const populated =
      status.account !== null &&
      status.device !== null &&
      status.session !== null &&
      status.expiry !== null;
    const empty =
      status.account === null &&
      status.device === null &&
      status.session === null &&
      status.expiry === null;
    if ((status.configured && !populated) || (!status.configured && !empty)) {
      context.addIssue({
        code: "custom",
        message: "Cloud session status must be either fully configured or fully empty.",
      });
      return;
    }
    if (
      status.account === null ||
      status.device === null ||
      status.session === null ||
      status.expiry === null
    ) {
      return;
    }
    if (
      status.account.accountId !== status.device.device.accountId ||
      status.account.accountId !== status.session.accountId ||
      status.device.device.deviceId !== status.session.deviceId ||
      status.account.state !== "active" ||
      status.device.device.state !== "trusted" ||
      status.device.device.revokedAt !== null ||
      status.device.publicKey.revokedAt !== null ||
      status.device.device.createdAt !== status.device.publicKey.createdAt ||
      status.session.revokedAt !== null ||
      compareSemanticVersions(status.session.clientVersion, status.session.minimumClientVersion) <
        0 ||
      status.expiry.accessExpiresAt !== status.session.expiresAt ||
      Date.parse(status.expiry.refreshExpiresAt) <= Date.parse(status.expiry.accessExpiresAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cloud session status identities or expiry metadata do not agree.",
      });
    }
  });

export class TauriCloudSessionVault implements CloudSessionVault {
  public readonly available = true;

  public constructor(private readonly endpoint: CloudEndpoint) {}

  public async login(input: CloudLoginInput): Promise<CloudSessionVaultStatus> {
    return parseStatus(
      await invoke<unknown>("login_cloud_identity", {
        input: {
          endpoint: this.nativeEndpoint(),
          email: input.email,
          password: input.password,
          device: {
            deviceId: input.deviceId,
            displayName: input.displayName,
          },
        },
      }),
    );
  }

  public async verifyEmail(input: CloudEmailVerificationInput): Promise<CloudSessionVaultStatus> {
    return parseStatus(
      await invoke<unknown>("verify_cloud_identity_email", {
        input: {
          endpoint: this.nativeEndpoint(),
          challengeId: input.challengeId,
          code: input.code,
          device: {
            deviceId: input.deviceId,
            displayName: input.displayName,
          },
        },
      }),
    );
  }

  public async refresh(expectedSessionId: string): Promise<CloudSessionVaultStatus> {
    return parseStatus(
      await invoke<unknown>("refresh_cloud_session", {
        input: { expectedSessionId },
      }),
    );
  }

  public async getStatus(): Promise<CloudSessionVaultStatus> {
    return parseStatus(await invoke<unknown>("get_cloud_session_status"));
  }

  public async logout(expectedSessionId: string): Promise<CloudSessionVaultStatus> {
    return parseStatus(
      await invoke<unknown>("logout_cloud_session", {
        input: { expectedSessionId },
      }),
    );
  }

  public async clear(expectedSessionId?: string): Promise<CloudSessionVaultStatus> {
    return parseStatus(
      await invoke<unknown>("clear_cloud_session", {
        expectedSessionId: expectedSessionId ?? null,
      }),
    );
  }

  private nativeEndpoint(): { readonly baseUrl: string; readonly allowInsecureLoopback: boolean } {
    return {
      baseUrl: this.endpoint.baseUrl,
      allowInsecureLoopback: this.endpoint.allowInsecureLoopback === true,
    };
  }
}

export class BrowserDevelopmentCloudSessionVault implements CloudSessionVault {
  public readonly available = false;

  public login(input: CloudLoginInput): Promise<CloudSessionVaultStatus> {
    void input;
    return unavailable();
  }

  public verifyEmail(input: CloudEmailVerificationInput): Promise<CloudSessionVaultStatus> {
    void input;
    return unavailable();
  }

  public refresh(expectedSessionId: string): Promise<CloudSessionVaultStatus> {
    void expectedSessionId;
    return unavailable();
  }

  public getStatus(): Promise<CloudSessionVaultStatus> {
    return Promise.resolve(emptyStatus());
  }

  public logout(expectedSessionId: string): Promise<CloudSessionVaultStatus> {
    void expectedSessionId;
    return unavailable();
  }

  public clear(expectedSessionId?: string): Promise<CloudSessionVaultStatus> {
    void expectedSessionId;
    return Promise.resolve(emptyStatus());
  }
}

function parseStatus(value: unknown): CloudSessionVaultStatus {
  return Object.freeze(CloudSessionVaultStatusSchema.parse(value));
}

function emptyStatus(): CloudSessionVaultStatus {
  return Object.freeze({
    configured: false,
    account: null,
    device: null,
    session: null,
    expiry: null,
  });
}

function unavailable<Value>(): Promise<Value> {
  return Promise.reject(
    new Error("Cloud identity requires the native desktop credential boundary."),
  );
}

function compareSemanticVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
