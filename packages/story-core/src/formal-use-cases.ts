import { StoryCoreError } from "./errors.js";
import { FormalStoryRecord, type FormalRecordKind } from "./formal-record.js";
import type { FormalStoryRecordRepository } from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type Clock, type UuidV7Generator } from "./value-objects.js";

export interface FormalRecordApplicationOptions {
  readonly records: FormalStoryRecordRepository;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export interface CreateFormalRecordCommand {
  readonly projectId: string;
  readonly kind: FormalRecordKind;
  readonly recordKey: string;
  readonly value: unknown;
  readonly actorId: string;
  readonly humanConfirmed: boolean;
}

export interface EditFormalRecordCommand {
  readonly recordId: string;
  readonly value: unknown;
  readonly actorId: string;
  readonly humanConfirmed: boolean;
  readonly expectedRevision: number;
}

export interface UndoFormalRecordCommand {
  readonly recordId: string;
  readonly targetVersion: number;
  readonly actorId: string;
  readonly humanConfirmed: boolean;
  readonly expectedRevision: number;
}

export class FormalRecordApplicationService {
  public constructor(private readonly options: FormalRecordApplicationOptions) {}

  public async create(
    command: CreateFormalRecordCommand,
  ): Promise<Result<FormalStoryRecord, StoryCoreError>> {
    const record = FormalStoryRecord.create({
      id: this.options.ids.next(),
      projectId: command.projectId,
      kind: command.kind,
      recordKey: command.recordKey,
      value: command.value,
      actorId: command.actorId,
      humanConfirmed: command.humanConfirmed,
      now: this.options.clock.now(),
    });
    if (!record.ok) {
      return record;
    }
    const saved = await this.options.records.create(record.value);
    return saved.ok ? ok(record.value) : saved;
  }

  public async edit(
    command: EditFormalRecordCommand,
  ): Promise<Result<FormalStoryRecord, StoryCoreError>> {
    return this.mutate(command.recordId, (record) =>
      record.editManually({
        value: command.value,
        actorId: command.actorId,
        humanConfirmed: command.humanConfirmed,
        expectedRevision: command.expectedRevision,
        now: this.options.clock.now(),
      }),
    );
  }

  public async undo(
    command: UndoFormalRecordCommand,
  ): Promise<Result<FormalStoryRecord, StoryCoreError>> {
    return this.mutate(command.recordId, (record) =>
      record.undo({
        targetVersion: command.targetVersion,
        actorId: command.actorId,
        humanConfirmed: command.humanConfirmed,
        expectedRevision: command.expectedRevision,
        now: this.options.clock.now(),
      }),
    );
  }

  private async mutate(
    recordIdValue: string,
    mutation: (record: FormalStoryRecord) => Result<FormalStoryRecord, StoryCoreError>,
  ): Promise<Result<FormalStoryRecord, StoryCoreError>> {
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
          code: "FORMAL_RECORD_NOT_FOUND",
          message: "Formal story record was not found.",
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
