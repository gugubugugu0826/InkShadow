import {
  AuthorRecoveryConflictError,
  type AuthorRecoveryRecord,
  type AuthorRecoveryStore,
  type SaveAuthorRecoveryInput,
} from "@inkshadow/data";

interface StoredAuthorRecoveryEnvelope {
  readonly storageVersion: 1;
  readonly record: AuthorRecoveryRecord;
}

/** Persistent browser-development equivalent; production runtime never constructs this adapter. */
export class BrowserDevelopmentAuthorRecoveryStore implements AuthorRecoveryStore {
  public constructor(private readonly storage: Storage) {}

  public find(projectId: string, kind: string): Promise<AuthorRecoveryRecord | null> {
    return Promise.resolve().then(() => {
      const raw = this.storage.getItem(keyFor(projectId, kind));
      if (raw === null) return null;
      return parseEnvelope(raw, projectId, kind).record;
    });
  }

  public save(input: SaveAuthorRecoveryInput): Promise<AuthorRecoveryRecord> {
    return Promise.resolve().then(() => {
      const key = keyFor(input.projectId, input.kind);
      const existingRaw = this.storage.getItem(key);
      if (input.expectedRevision === null) {
        if (existingRaw !== null) throw new AuthorRecoveryConflictError();
        const created = freezeRecord({
          projectId: input.projectId,
          kind: input.kind,
          schemaVersion: input.schemaVersion,
          payloadJson: input.payloadJson,
          revision: 1,
          createdAt: input.now,
          updatedAt: input.now,
        });
        this.storage.setItem(key, JSON.stringify({ storageVersion: 1, record: created }));
        return created;
      }
      if (existingRaw === null) throw new AuthorRecoveryConflictError();
      const existing = parseEnvelope(existingRaw, input.projectId, input.kind).record;
      if (existing.revision !== input.expectedRevision) throw new AuthorRecoveryConflictError();
      const updated = freezeRecord({
        ...existing,
        schemaVersion: input.schemaVersion,
        payloadJson: input.payloadJson,
        revision: existing.revision + 1,
        updatedAt: input.now,
      });
      this.storage.setItem(key, JSON.stringify({ storageVersion: 1, record: updated }));
      return updated;
    });
  }

  public delete(projectId: string, kind: string, expectedRevision: number): Promise<boolean> {
    return Promise.resolve().then(() => {
      const key = keyFor(projectId, kind);
      const raw = this.storage.getItem(key);
      if (raw === null) return false;
      const existing = parseEnvelope(raw, projectId, kind).record;
      if (existing.revision !== expectedRevision) throw new AuthorRecoveryConflictError();
      this.storage.removeItem(key);
      return true;
    });
  }
}

function keyFor(projectId: string, kind: string): string {
  return `inkshadow:author-recovery:${kind}:${projectId}`;
}

function parseEnvelope(raw: string, projectId: string, kind: string): StoredAuthorRecoveryEnvelope {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const envelope = parsed as { readonly storageVersion?: unknown; readonly record?: unknown };
    const recordValue = envelope.record;
    if (
      envelope.storageVersion !== 1 ||
      typeof recordValue !== "object" ||
      recordValue === null ||
      Array.isArray(recordValue)
    ) {
      throw new Error();
    }
    const record = recordValue as Partial<Record<keyof AuthorRecoveryRecord, unknown>>;
    if (
      record.projectId !== projectId ||
      record.kind !== kind ||
      typeof record.schemaVersion !== "string" ||
      typeof record.payloadJson !== "string" ||
      typeof record.revision !== "number" ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string"
    ) {
      throw new Error();
    }
    return Object.freeze({
      storageVersion: 1,
      record: freezeRecord({
        projectId,
        kind,
        schemaVersion: record.schemaVersion,
        payloadJson: record.payloadJson,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }),
    });
  } catch {
    throw new Error("浏览器恢复记录暂时无法读取；原记录已保留。禁止覆盖或删除。 ");
  }
}

function freezeRecord(record: AuthorRecoveryRecord): AuthorRecoveryRecord {
  return Object.freeze({ ...record });
}
