import {
  appendChapterEnvelope,
  parseEncryptedGuestProjectRecord,
  type CipherEnvelopeV1,
  type EncryptedGuestProjectRecordV1,
} from "../contracts/encrypted-guest-project";
import { GuestWorkspaceError, toGuestWorkspaceError } from "../domain/guest-workspace-error";
import type { EncryptedProjectStore } from "../ports/encrypted-project-store";

export const WEB_GUEST_DATABASE_NAME = "inkshadow-web-guest-v1";
export const WEB_GUEST_OBJECT_STORE_NAME = "encrypted-projects";
const DATABASE_VERSION = 1;

export class IndexedDbEncryptedProjectStore implements EncryptedProjectStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  public constructor(private readonly indexedDbFactory: IDBFactory | null = null) {}

  public async list(): Promise<readonly EncryptedGuestProjectRecordV1[]> {
    const database = await this.openDatabase();
    const transaction = database.transaction(WEB_GUEST_OBJECT_STORE_NAME, "readonly");
    const request = transaction.objectStore(WEB_GUEST_OBJECT_STORE_NAME).getAll();
    const values = await requestResult<unknown[]>(request);
    await transactionComplete(transaction);
    return values.map(parseEncryptedGuestProjectRecord);
  }

  public async get(projectId: string): Promise<EncryptedGuestProjectRecordV1 | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction(WEB_GUEST_OBJECT_STORE_NAME, "readonly");
    const request = transaction.objectStore(WEB_GUEST_OBJECT_STORE_NAME).get(projectId);
    const value = await requestResult<unknown>(request);
    await transactionComplete(transaction);
    return value === undefined ? null : parseEncryptedGuestProjectRecord(value);
  }

  public async create(record: EncryptedGuestProjectRecordV1): Promise<void> {
    const validated = parseEncryptedGuestProjectRecord(record);
    const database = await this.openDatabase();
    let transaction: IDBTransaction | null = null;
    try {
      transaction = database.transaction(WEB_GUEST_OBJECT_STORE_NAME, "readwrite");
      transaction.objectStore(WEB_GUEST_OBJECT_STORE_NAME).add(validated);
      await transactionComplete(transaction);
    } catch (error) {
      if (transaction !== null) {
        abortTransaction(transaction);
      }
      if (isConstraintError(error)) {
        throw new GuestWorkspaceError(
          "WEB_PROJECT_ALREADY_EXISTS",
          "这个加密项目已存在于当前浏览器。",
        );
      }
      throw toIndexedDbWriteError(error, "浏览器未能保存加密项目，未保留不完整记录。");
    }
  }

  public async appendChapter(
    projectId: string,
    expectedContentVersion: number,
    envelope: CipherEnvelopeV1,
  ): Promise<void> {
    const database = await this.openDatabase();
    let transaction: IDBTransaction | null = null;

    try {
      transaction = database.transaction(WEB_GUEST_OBJECT_STORE_NAME, "readwrite");
      const objectStore = transaction.objectStore(WEB_GUEST_OBJECT_STORE_NAME);
      const stored = await requestResult<unknown>(objectStore.get(projectId));
      if (stored === undefined) {
        abortTransaction(transaction);
        throw new GuestWorkspaceError("WEB_PROJECT_NOT_FOUND", "当前浏览器中没有这个加密项目。");
      }
      const record = parseEncryptedGuestProjectRecord(stored);
      const updated = appendChapterEnvelope(record, expectedContentVersion, envelope);
      objectStore.put(updated);
      await transactionComplete(transaction);
    } catch (error) {
      if (transaction !== null) {
        abortTransaction(transaction);
      }
      throw toIndexedDbWriteError(error, "浏览器未能提交加密章节，原密文版本保持不变。");
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise !== null) {
      return this.databasePromise;
    }

    const factory = this.indexedDbFactory ?? globalIndexedDbFactory();
    if (factory === null) {
      throw new GuestWorkspaceError(
        "WEB_STORAGE_UNAVAILABLE",
        "当前浏览器未提供 IndexedDB，无法建立加密 Guest 工作区。",
      );
    }

    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = factory.open(WEB_GUEST_DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(WEB_GUEST_OBJECT_STORE_NAME)) {
          database.createObjectStore(WEB_GUEST_OBJECT_STORE_NAME, {
            keyPath: "projectId",
          });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          this.databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.databasePromise = null;
        reject(
          new GuestWorkspaceError(
            "WEB_STORAGE_UNAVAILABLE",
            "无法打开浏览器加密数据库。请检查站点存储权限后重试。",
            true,
          ),
        );
      };
      request.onblocked = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.databasePromise = null;
        reject(
          new GuestWorkspaceError(
            "WEB_STORAGE_UNAVAILABLE",
            "浏览器中另一个页面阻止了加密数据库升级。请关闭旧页面后重试。",
            true,
          ),
        );
      };
    });
    return this.databasePromise;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        request.error ??
          new GuestWorkspaceError("WEB_STORAGE_FAILED", "浏览器加密数据库操作失败。", true),
      );
    };
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(
        transaction.error ??
          new GuestWorkspaceError("WEB_STORAGE_FAILED", "浏览器加密数据库事务已中止。", true),
      );
    };
    transaction.onerror = () => {
      reject(
        transaction.error ??
          new GuestWorkspaceError("WEB_STORAGE_FAILED", "浏览器加密数据库事务失败。", true),
      );
    };
  });
}

function isConstraintError(error: unknown): boolean {
  return hasErrorName(error, "ConstraintError");
}

export function toIndexedDbWriteError(
  error: unknown,
  fallbackMessage: string,
): GuestWorkspaceError {
  if (hasErrorName(error, "QuotaExceededError")) {
    return new GuestWorkspaceError(
      "WEB_STORAGE_QUOTA_EXCEEDED",
      "浏览器站点存储空间不足。未提交本次密文；请先下载已有密文副本，再释放站点空间后重试。",
      true,
    );
  }
  return toGuestWorkspaceError(error, "WEB_STORAGE_FAILED", fallbackMessage, true);
}

function hasErrorName(error: unknown, expectedName: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    Reflect.get(error, "name") === expectedName
  );
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // A completed/aborted transaction is already fail-closed and needs no second abort.
  }
}

function globalIndexedDbFactory(): IDBFactory | null {
  const candidate: unknown = Reflect.get(globalThis, "indexedDB");
  return typeof candidate === "object" &&
    candidate !== null &&
    "open" in candidate &&
    typeof candidate.open === "function"
    ? (candidate as IDBFactory)
    : null;
}
