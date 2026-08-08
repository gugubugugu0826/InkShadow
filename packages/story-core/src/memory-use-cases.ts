import { StoryCoreError } from "./errors.js";
import {
  MemoryPolicy,
  MemoryRecord,
  type AutomaticMemoryAuthorization,
  type CreateMemoryRecordInput,
} from "./memory.js";
import type {
  MemoryGovernanceReceipt,
  MemoryGovernanceUnitOfWork,
  MemoryPolicyRepository,
  MemoryRecordCreationUnitOfWork,
  MemoryRecordListReader,
  MemoryRecordRepository,
} from "./ports.js";
import { err, ok, type Result } from "./result.js";
import {
  parseIsoUtcTimestamp,
  parseUuidV7,
  type Clock,
  type UuidV7,
  type UuidV7Generator,
} from "./value-objects.js";

export interface MemoryApplicationOptions {
  readonly policies: MemoryPolicyRepository;
  readonly records: MemoryRecordRepository & MemoryRecordListReader;
  readonly creation: MemoryRecordCreationUnitOfWork;
  readonly governance: MemoryGovernanceUnitOfWork;
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

export interface ForgetProjectMemoryCommand {
  readonly operationId: string;
  readonly projectId: string;
  readonly expectedPolicyRevision: number;
  readonly expectedRecords: readonly Readonly<{
    id: string;
    revision: number;
  }>[];
  readonly humanConfirmed: boolean;
}

export interface MergeMemoryRecordsCommand {
  readonly operationId: string;
  readonly projectId: string;
  readonly targetRecordId: string;
  readonly sourceRecordId: string;
  readonly expectedTargetRevision: number;
  readonly expectedSourceRevision: number;
  readonly content: string;
  readonly humanConfirmed: boolean;
}

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

  public async forgetProjectMemory(
    command: ForgetProjectMemoryCommand,
  ): Promise<Result<MemoryGovernanceReceipt, StoryCoreError>> {
    if (!command.humanConfirmed) {
      return humanDecisionRequired();
    }
    const authority = parseGovernanceAuthority(command.operationId, command.projectId);
    if (!authority.ok) {
      return authority;
    }
    const expectedRecords = parseExpectedRecords(command.expectedRecords);
    if (!expectedRecords.ok) {
      return expectedRecords;
    }
    if (
      !Number.isSafeInteger(command.expectedPolicyRevision) ||
      command.expectedPolicyRevision < 1
    ) {
      return invalidGovernance("The expected memory policy revision is invalid.");
    }

    const [loadedPolicy, loadedRecords] = await Promise.all([
      this.options.policies.findByProjectId(authority.value.projectId),
      this.options.records.listByProjectId(authority.value.projectId),
    ]);
    if (!loadedPolicy.ok) {
      return loadedPolicy;
    }
    if (!loadedRecords.ok) {
      return loadedRecords;
    }
    if (loadedPolicy.value === null) {
      return invalidGovernance("The project memory policy was not found.");
    }
    if (loadedPolicy.value.revision !== command.expectedPolicyRevision) {
      return memoryRevisionConflict(
        "Memory policy",
        command.expectedPolicyRevision,
        loadedPolicy.value.revision,
      );
    }
    const scopeMatch = compareExpectedRecordScope(expectedRecords.value, loadedRecords.value);
    if (!scopeMatch.ok) {
      return scopeMatch;
    }

    const now = parseIsoUtcTimestamp(this.options.clock.now());
    if (!now.ok) {
      return now;
    }
    const nextPolicy = loadedPolicy.value.setAutomaticLearning({
      enabled: false,
      humanConfirmed: true,
      expectedRevision: loadedPolicy.value.revision,
      now: now.value,
    });
    if (!nextPolicy.ok) {
      return nextPolicy;
    }
    const transitions = [];
    for (const record of loadedRecords.value) {
      const next = record.exclude({
        humanConfirmed: true,
        expectedRevision: record.revision,
        now: now.value,
      });
      if (!next.ok) {
        return next;
      }
      transitions.push({ role: "forgotten" as const, previous: record, next: next.value });
    }

    return this.options.governance.commit({
      operationId: authority.value.operationId,
      projectId: authority.value.projectId,
      operation: "forget_project",
      targetRecordId: null,
      previousPolicy: loadedPolicy.value,
      nextPolicy: nextPolicy.value,
      records: Object.freeze(transitions),
      requestJson: canonicalGovernanceRequest({
        operation: "forget_project",
        projectId: authority.value.projectId,
        expectedPolicyRevision: command.expectedPolicyRevision,
        records: expectedRecords.value,
      }),
      now: now.value,
    });
  }

  public async mergeRecords(
    command: MergeMemoryRecordsCommand,
  ): Promise<Result<MemoryGovernanceReceipt, StoryCoreError>> {
    if (!command.humanConfirmed) {
      return humanDecisionRequired();
    }
    const authority = parseGovernanceAuthority(command.operationId, command.projectId);
    if (!authority.ok) {
      return authority;
    }
    const targetId = parseUuidV7(command.targetRecordId);
    if (!targetId.ok) {
      return targetId;
    }
    const sourceId = parseUuidV7(command.sourceRecordId);
    if (!sourceId.ok) {
      return sourceId;
    }
    if (targetId.value === sourceId.value) {
      return invalidGovernance("A memory cannot be merged into itself.");
    }
    if (
      !Number.isSafeInteger(command.expectedTargetRevision) ||
      command.expectedTargetRevision < 1 ||
      !Number.isSafeInteger(command.expectedSourceRevision) ||
      command.expectedSourceRevision < 1
    ) {
      return invalidGovernance("The expected memory revisions are invalid.");
    }

    const [loadedTarget, loadedSource] = await Promise.all([
      this.options.records.findById(targetId.value),
      this.options.records.findById(sourceId.value),
    ]);
    if (!loadedTarget.ok) {
      return loadedTarget;
    }
    if (!loadedSource.ok) {
      return loadedSource;
    }
    if (loadedTarget.value === null || loadedSource.value === null) {
      return err(
        new StoryCoreError({
          code: "MEMORY_RECORD_NOT_FOUND",
          message: "One of the selected memory records was not found.",
        }),
      );
    }
    const target = loadedTarget.value;
    const source = loadedSource.value;
    if (
      target.projectId !== authority.value.projectId ||
      source.projectId !== authority.value.projectId
    ) {
      return invalidGovernance("Selected memories must belong to the chosen project.");
    }
    if (target.revision !== command.expectedTargetRevision) {
      return memoryRevisionConflict(
        "Merge target",
        command.expectedTargetRevision,
        target.revision,
      );
    }
    if (source.revision !== command.expectedSourceRevision) {
      return memoryRevisionConflict(
        "Merge source",
        command.expectedSourceRevision,
        source.revision,
      );
    }
    if (target.toSnapshot().excluded || source.toSnapshot().excluded) {
      return invalidGovernance("Forgotten memory cannot participate in a merge.");
    }

    const now = parseIsoUtcTimestamp(this.options.clock.now());
    if (!now.ok) {
      return now;
    }
    const nextTarget = target.edit({
      content: command.content,
      humanConfirmed: true,
      expectedRevision: target.revision,
      now: now.value,
    });
    if (!nextTarget.ok) {
      return nextTarget;
    }
    const nextSource = source.exclude({
      humanConfirmed: true,
      expectedRevision: source.revision,
      now: now.value,
    });
    if (!nextSource.ok) {
      return nextSource;
    }

    return this.options.governance.commit({
      operationId: authority.value.operationId,
      projectId: authority.value.projectId,
      operation: "merge",
      targetRecordId: target.id,
      previousPolicy: null,
      nextPolicy: null,
      records: Object.freeze([
        { role: "merge_target", previous: target, next: nextTarget.value },
        { role: "merge_source", previous: source, next: nextSource.value },
      ]),
      requestJson: canonicalGovernanceRequest({
        operation: "merge",
        projectId: authority.value.projectId,
        targetRecordId: target.id,
        targetRevision: command.expectedTargetRevision,
        sourceRecordId: source.id,
        sourceRevision: command.expectedSourceRevision,
        content: nextTarget.value.toSnapshot().content,
      }),
      now: now.value,
    });
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

function parseGovernanceAuthority(
  operationIdValue: string,
  projectIdValue: string,
): Result<Readonly<{ operationId: UuidV7; projectId: UuidV7 }>, StoryCoreError> {
  const operationId = parseUuidV7(operationIdValue);
  if (!operationId.ok) {
    return operationId;
  }
  const projectId = parseUuidV7(projectIdValue);
  return projectId.ok
    ? ok({ operationId: operationId.value, projectId: projectId.value })
    : projectId;
}

function parseExpectedRecords(
  records: readonly Readonly<{ id: string; revision: number }>[],
): Result<readonly Readonly<{ id: UuidV7; revision: number }>[], StoryCoreError> {
  const parsed: { id: UuidV7; revision: number }[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const id = parseUuidV7(record.id);
    if (!id.ok) {
      return id;
    }
    if (seen.has(id.value) || !Number.isSafeInteger(record.revision) || record.revision < 1) {
      return invalidGovernance("Confirmed memory scope contains duplicate or invalid revisions.");
    }
    seen.add(id.value);
    parsed.push({ id: id.value, revision: record.revision });
  }
  return ok(Object.freeze(parsed.sort((left, right) => left.id.localeCompare(right.id))));
}

function compareExpectedRecordScope(
  expected: readonly Readonly<{ id: UuidV7; revision: number }>[],
  actual: readonly MemoryRecord[],
): Result<void, StoryCoreError> {
  const actualScope = [...actual]
    .map((record) => ({ id: record.id, revision: record.revision }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedFingerprint = expected
    .map(({ id, revision }) => `${id}:${String(revision)}`)
    .join("|");
  const actualFingerprint = actualScope
    .map(({ id, revision }) => `${id}:${String(revision)}`)
    .join("|");
  const matches =
    expected.length === actualScope.length && expectedFingerprint === actualFingerprint;
  return matches
    ? ok(undefined)
    : memoryRevisionConflict("Project memory scope", expected.length, actualScope.length);
}

function canonicalGovernanceRequest(value: unknown): string {
  return JSON.stringify(value);
}

function humanDecisionRequired(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "HUMAN_DECISION_REQUIRED",
      message: "Memory governance changes require explicit user action.",
    }),
  );
}

function invalidGovernance(message: string): Result<never, StoryCoreError> {
  return err(new StoryCoreError({ code: "MEMORY_INVALID_GOVERNANCE", message }));
}

function memoryRevisionConflict(
  entity: string,
  expectedRevision: number,
  actualRevision: number,
): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_REVISION_CONFLICT",
      message: `${entity} changed before this operation.`,
      retryable: true,
      actions: ["RECOMPARE", "RETRY"],
      details: { expectedRevision, actualRevision },
    }),
  );
}
