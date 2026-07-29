import { StoryCoreError } from "./errors.js";
import {
  MemoryPolicy,
  MemoryRecord,
  type AutomaticMemoryAuthorization,
  type CreateMemoryRecordInput,
} from "./memory.js";
import type {
  MemoryPolicyRepository,
  MemoryRecordCreationUnitOfWork,
  MemoryRecordRepository,
} from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";

export interface MemoryApplicationOptions {
  readonly policies: MemoryPolicyRepository;
  readonly records: MemoryRecordRepository;
  readonly creation: MemoryRecordCreationUnitOfWork;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export type CreateMemoryRecordCommand = Omit<
  CreateMemoryRecordInput,
  "id" | "automaticLearningAuthorization" | "now"
> &
  Readonly<{
    /**
     * Required for user-originated memory. Automatic memory is governed by the
     * project policy instead.
     */
    humanConfirmed?: boolean;
  }>;

interface GovernMemoryCommandBase {
  readonly recordId: string;
  readonly expectedRevision: number;
  readonly humanConfirmed: boolean;
}

export type GovernMemoryRecordCommand =
  | (GovernMemoryCommandBase & Readonly<{ kind: "set_enabled"; enabled: boolean }>)
  | (GovernMemoryCommandBase & Readonly<{ kind: "pin" }>)
  | (GovernMemoryCommandBase & Readonly<{ kind: "exclude" }>)
  | (GovernMemoryCommandBase & Readonly<{ kind: "downweight"; weight: number }>)
  | (GovernMemoryCommandBase & Readonly<{ kind: "reset_priority" }>)
  | (GovernMemoryCommandBase & Readonly<{ kind: "edit"; content: string }>);

export class MemoryApplicationService {
  public constructor(private readonly options: MemoryApplicationOptions) {}

  public async ensureDefaultPolicy(
    projectIdValue: string,
  ): Promise<Result<MemoryPolicy, StoryCoreError>> {
    const policy = MemoryPolicy.create(projectIdValue, this.options.clock.now());
    if (!policy.ok) {
      return policy;
    }
    const created = await this.options.policies.createIfAbsent(policy.value);
    return created.ok ? ok(created.value.policy) : created;
  }

  public async setAutomaticLearning(command: {
    readonly projectId: string;
    readonly enabled: boolean;
    readonly humanConfirmed: boolean;
    readonly expectedRevision: number;
  }): Promise<Result<MemoryPolicy, StoryCoreError>> {
    const projectId = parseUuidV7(command.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const loaded = await this.options.policies.findByProjectId(projectId.value);
    if (!loaded.ok) {
      return loaded;
    }
    const policyResult =
      loaded.value === null ? await this.ensureDefaultPolicy(command.projectId) : ok(loaded.value);
    if (!policyResult.ok) {
      return policyResult;
    }
    const policy = policyResult.value;
    const changed = policy.setAutomaticLearning({
      enabled: command.enabled,
      humanConfirmed: command.humanConfirmed,
      expectedRevision: command.expectedRevision,
      now: this.options.clock.now(),
    });
    if (!changed.ok) {
      return changed;
    }
    if (changed.value.revision === policy.revision) {
      return changed;
    }
    const saved = await this.options.policies.save(changed.value, policy.revision);
    return saved.ok ? changed : saved;
  }

  public async createRecord(
    command: CreateMemoryRecordCommand,
  ): Promise<Result<MemoryRecord, StoryCoreError>> {
    if (command.origin === "user" && command.humanConfirmed !== true) {
      return err(
        new StoryCoreError({
          code: "HUMAN_DECISION_REQUIRED",
          message: "User-authored memory requires an explicit human confirmation.",
        }),
      );
    }

    let automaticAuthorization: AutomaticMemoryAuthorization | undefined;
    let expectedPolicyRevision: number | null = null;
    if (command.origin === "automatic") {
      const projectId = parseUuidV7(command.projectId);
      if (!projectId.ok) {
        return projectId;
      }
      const policy = await this.options.policies.findByProjectId(projectId.value);
      if (!policy.ok) {
        return policy;
      }
      if (policy.value === null) {
        return err(
          new StoryCoreError({
            code: "MEMORY_AUTO_LEARNING_DISABLED",
            message: "Automatic memory learning is disabled until a user enables it.",
            actions: ["ENABLE_MEMORY"],
          }),
        );
      }
      const authorization = policy.value.authorizeAutomaticLearning();
      if (!authorization.ok) {
        return authorization;
      }
      automaticAuthorization = authorization.value;
      expectedPolicyRevision = policy.value.revision;
    }

    const record = MemoryRecord.create({
      id: this.options.ids.next(),
      projectId: command.projectId,
      level: command.level,
      content: command.content,
      source: command.source,
      origin: command.origin,
      now: this.options.clock.now(),
      ...(automaticAuthorization === undefined
        ? {}
        : {
            automaticLearningAuthorization: automaticAuthorization,
          }),
    });
    if (!record.ok) {
      return record;
    }
    const saved = await this.options.creation.create({
      record: record.value,
      expectedAutomaticLearningPolicyRevision: expectedPolicyRevision,
    });
    return saved.ok ? ok(record.value) : saved;
  }

  public async govern(
    command: GovernMemoryRecordCommand,
  ): Promise<Result<MemoryRecord, StoryCoreError>> {
    return this.mutate(command.recordId, (record) => {
      const common = {
        humanConfirmed: command.humanConfirmed,
        expectedRevision: command.expectedRevision,
        now: this.options.clock.now(),
      };
      switch (command.kind) {
        case "set_enabled":
          return record.setEnabled({
            ...common,
            enabled: command.enabled,
          });
        case "pin":
          return record.pin(common);
        case "exclude":
          return record.exclude(common);
        case "downweight":
          return record.downweight({
            ...common,
            weight: command.weight,
          });
        case "reset_priority":
          return record.resetContextPriority(common);
        case "edit":
          return record.edit({
            ...common,
            content: command.content,
          });
      }
    });
  }

  public async recordUse(command: {
    readonly recordId: string;
    readonly expectedRevision: number;
  }): Promise<Result<MemoryRecord, StoryCoreError>> {
    return this.mutate(command.recordId, (record) =>
      record.recordUse(command.expectedRevision, this.options.clock.now()),
    );
  }

  private async mutate(
    recordIdValue: string,
    mutation: (record: MemoryRecord) => Result<MemoryRecord, StoryCoreError>,
  ): Promise<Result<MemoryRecord, StoryCoreError>> {
    const recordId = parseUuidV7(recordIdValue);
    if (!recordId.ok) {
      return recordId;
    }
    const loaded = await this.options.records.findById(recordId.value);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      return err(
        new StoryCoreError({
          code: "MEMORY_RECORD_NOT_FOUND",
          message: "Memory record was not found.",
        }),
      );
    }
    const record = loaded.value;
    const changed = mutation(record);
    if (!changed.ok) {
      return changed;
    }
    if (changed.value.revision === record.revision) {
      return changed;
    }
    const saved = await this.options.records.save(changed.value, record.revision);
    return saved.ok ? changed : saved;
  }
}
