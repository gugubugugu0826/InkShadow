import type { UuidV7 } from "@inkshadow/domain";

import { GuestWorkspaceError } from "../domain/guest-workspace-error";

export class SessionProjectKeyring {
  readonly #keys = new Map<UuidV7, CryptoKey>();

  public set(projectId: UuidV7, key: CryptoKey): void {
    if (
      key.extractable ||
      key.type !== "secret" ||
      key.algorithm.name !== "AES-GCM" ||
      Reflect.get(key.algorithm, "length") !== 256 ||
      !key.usages.includes("encrypt") ||
      !key.usages.includes("decrypt")
    ) {
      throw new GuestWorkspaceError(
        "WEB_CRYPTO_UNAVAILABLE",
        "拒绝保存可导出或用途不完整的项目密钥。",
      );
    }
    this.#keys.set(projectId, key);
  }

  public get(projectId: UuidV7): CryptoKey {
    const key = this.#keys.get(projectId);
    if (key === undefined) {
      throw new GuestWorkspaceError(
        "WEB_PROJECT_LOCKED",
        "项目密钥不在当前内存会话中。请使用恢复材料重新解锁。",
      );
    }
    return key;
  }

  public has(projectId: UuidV7): boolean {
    return this.#keys.has(projectId);
  }

  public delete(projectId: UuidV7): void {
    this.#keys.delete(projectId);
  }

  public clear(): void {
    this.#keys.clear();
  }
}
