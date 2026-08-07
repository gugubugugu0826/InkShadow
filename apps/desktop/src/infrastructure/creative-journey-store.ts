import type { SqlExecutor, SqlPrimitive } from "@inkshadow/data";

export const DEVELOPMENT_CREATIVE_JOURNEY_KEY = "inkshadow.development.creative-journeys.v1";

export type CreativeJourneyKind = "idea" | "import" | "professional";
export type CreativeJourneyStatus = "active" | "completed" | "abandoned";
export type CreativeJourneyTurnKind =
  "idea" | "question" | "answer" | "skip" | "back" | "regenerate" | "keep";
export type CreativeGenerationSource = "provider" | "local_fallback";

export interface CreativeJourneyRecord {
  readonly id: string;
  readonly kind: CreativeJourneyKind;
  readonly status: CreativeJourneyStatus;
  readonly currentState: string;
  readonly projectId: string | null;
  readonly chapterId: string | null;
  readonly candidateId: string | null;
  readonly revision: number;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface CreativeJourneyTurnRecord {
  readonly id: string;
  readonly journeyId: string;
  readonly sequence: number;
  readonly kind: CreativeJourneyTurnKind;
  readonly questionKey: string | null;
  readonly generationSource: CreativeGenerationSource | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly taskKey: string | null;
  readonly requestId: string | null;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface CreativeJourneyStore {
  findById(id: string): Promise<CreativeJourneyRecord | null>;
  listActive(kind?: CreativeJourneyKind): Promise<readonly CreativeJourneyRecord[]>;
  listTurns(journeyId: string): Promise<readonly CreativeJourneyTurnRecord[]>;
  create(record: CreativeJourneyRecord, initialTurn: CreativeJourneyTurnRecord): Promise<void>;
  update(
    record: CreativeJourneyRecord,
    expectedRevision: number,
    turn?: CreativeJourneyTurnRecord,
  ): Promise<void>;
}

interface CreativeJourneyRow {
  id: string;
  kind: string;
  status: string;
  current_state: string;
  project_id: string | null;
  chapter_id: string | null;
  candidate_id: string | null;
  revision: number;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CreativeJourneyTurnRow {
  id: string;
  journey_id: string;
  sequence: number;
  turn_kind: string;
  question_key: string | null;
  generation_source: string | null;
  provider_id: string | null;
  model_id: string | null;
  task_key: string | null;
  request_id: string | null;
  snapshot_json: string;
  created_at: string;
}

export class SqliteCreativeJourneyStore implements CreativeJourneyStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async findById(idValue: string): Promise<CreativeJourneyRecord | null> {
    const id = validateIdentifier(idValue, "journey id");
    const rows = await this.executor.select<CreativeJourneyRow>(`${JOURNEY_SELECT} WHERE id = ?`, [
      id,
    ]);
    return rows[0] === undefined ? null : hydrateJourney(rows[0]);
  }

  public async listActive(
    kindValue?: CreativeJourneyKind,
  ): Promise<readonly CreativeJourneyRecord[]> {
    const values: readonly SqlPrimitive[] =
      kindValue === undefined ? [] : [validateKind(kindValue)];
    const rows = await this.executor.select<CreativeJourneyRow>(
      `${JOURNEY_SELECT}
       WHERE status = 'active'${kindValue === undefined ? "" : " AND kind = ?"}
       ORDER BY updated_at DESC, id`,
      values,
    );
    return Object.freeze(rows.map(hydrateJourney));
  }

  public async listTurns(journeyIdValue: string): Promise<readonly CreativeJourneyTurnRecord[]> {
    const journeyId = validateIdentifier(journeyIdValue, "journey id");
    const rows = await this.executor.select<CreativeJourneyTurnRow>(
      `${TURN_SELECT} WHERE journey_id = ? ORDER BY sequence ASC`,
      [journeyId],
    );
    return Object.freeze(rows.map(hydrateTurn));
  }

  public async create(
    recordValue: CreativeJourneyRecord,
    initialTurnValue: CreativeJourneyTurnRecord,
  ): Promise<void> {
    const record = validateJourney(recordValue);
    const turn = validateTurn(initialTurnValue);
    if (record.revision !== 1 || turn.journeyId !== record.id || turn.sequence !== 1) {
      throw storeError("CREATIVE_JOURNEY_INVALID", "Initial creative journey state is invalid.");
    }
    await this.executor.transaction(async (transaction) => {
      await transaction.execute(INSERT_JOURNEY, journeyValues(record));
      await transaction.execute(INSERT_TURN, turnValues(turn));
    });
  }

  public async update(
    recordValue: CreativeJourneyRecord,
    expectedRevision: number,
    turnValue?: CreativeJourneyTurnRecord,
  ): Promise<void> {
    const record = validateJourney(recordValue);
    if (!Number.isSafeInteger(expectedRevision) || record.revision !== expectedRevision + 1) {
      throw storeError("CREATIVE_JOURNEY_INVALID", "Creative journey revision is invalid.");
    }
    const turn = turnValue === undefined ? null : validateTurn(turnValue);
    if (turn !== null && (turn.journeyId !== record.id || turn.sequence < 2)) {
      throw storeError("CREATIVE_JOURNEY_INVALID", "Creative journey turn is invalid.");
    }
    await this.executor.transaction(async (transaction) => {
      if (turn !== null) {
        const sequenceRows = await transaction.select<{ readonly next_sequence: number }>(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
           FROM creative_journey_turns
           WHERE journey_id = ?`,
          [record.id],
        );
        if (sequenceRows[0]?.next_sequence !== turn.sequence) {
          throw storeError(
            "CREATIVE_JOURNEY_REVISION_CONFLICT",
            "Creative journey turn sequence changed before it could be saved.",
            true,
          );
        }
      }
      const result = await transaction.execute(
        `UPDATE creative_journeys
         SET status = ?, current_state = ?, project_id = ?, chapter_id = ?, candidate_id = ?,
             revision = ?, snapshot_json = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND revision = ?`,
        [
          record.status,
          record.currentState,
          record.projectId,
          record.chapterId,
          record.candidateId,
          record.revision,
          JSON.stringify(record.snapshot),
          record.updatedAt,
          record.completedAt,
          record.id,
          expectedRevision,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw storeError(
          "CREATIVE_JOURNEY_REVISION_CONFLICT",
          "Creative journey changed before it could be saved.",
          true,
        );
      }
      if (turn !== null) {
        await transaction.execute(INSERT_TURN, turnValues(turn));
      }
    });
  }
}

interface BrowserCreativeJourneyDatabase {
  readonly schemaVersion: 1;
  journeys: Record<string, CreativeJourneyRecord>;
  turns: Record<string, readonly CreativeJourneyTurnRecord[]>;
}

export class BrowserCreativeJourneyStore implements CreativeJourneyStore {
  public constructor(private readonly storage: Storage) {}

  public findById(idValue: string): Promise<CreativeJourneyRecord | null> {
    return Promise.resolve().then(() => {
      const id = validateIdentifier(idValue, "journey id");
      const record = this.read().journeys[id];
      return record === undefined ? null : validateJourney(record);
    });
  }

  public listActive(kindValue?: CreativeJourneyKind): Promise<readonly CreativeJourneyRecord[]> {
    return Promise.resolve().then(() => {
      const kind = kindValue === undefined ? null : validateKind(kindValue);
      return Object.freeze(
        Object.values(this.read().journeys)
          .map(validateJourney)
          .filter((record) => record.status === "active" && (kind === null || record.kind === kind))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      );
    });
  }

  public listTurns(journeyIdValue: string): Promise<readonly CreativeJourneyTurnRecord[]> {
    return Promise.resolve().then(() => {
      const journeyId = validateIdentifier(journeyIdValue, "journey id");
      return Object.freeze((this.read().turns[journeyId] ?? []).map(validateTurn));
    });
  }

  public create(
    recordValue: CreativeJourneyRecord,
    initialTurnValue: CreativeJourneyTurnRecord,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const record = validateJourney(recordValue);
      const turn = validateTurn(initialTurnValue);
      const database = this.read();
      if (
        record.revision !== 1 ||
        turn.journeyId !== record.id ||
        turn.sequence !== 1 ||
        database.journeys[record.id] !== undefined
      ) {
        throw storeError("CREATIVE_JOURNEY_INVALID", "Initial creative journey state is invalid.");
      }
      database.journeys[record.id] = record;
      database.turns[record.id] = Object.freeze([turn]);
      this.write(database);
    });
  }

  public update(
    recordValue: CreativeJourneyRecord,
    expectedRevision: number,
    turnValue?: CreativeJourneyTurnRecord,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const record = validateJourney(recordValue);
      const turn = turnValue === undefined ? null : validateTurn(turnValue);
      const database = this.read();
      const existing = database.journeys[record.id];
      if (existing?.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
        throw storeError(
          "CREATIVE_JOURNEY_REVISION_CONFLICT",
          "Creative journey changed before it could be saved.",
          true,
        );
      }
      const turns = database.turns[record.id] ?? [];
      if (turn !== null && (turn.journeyId !== record.id || turn.sequence !== turns.length + 1)) {
        throw storeError("CREATIVE_JOURNEY_INVALID", "Creative journey turn is invalid.");
      }
      database.journeys[record.id] = record;
      database.turns[record.id] = Object.freeze(turn === null ? turns : [...turns, turn]);
      this.write(database);
    });
  }

  private read(): BrowserCreativeJourneyDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_CREATIVE_JOURNEY_KEY);
    if (serialized === null) {
      return { schemaVersion: 1, journeys: {}, turns: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isObject(parsed) ||
        parsed.schemaVersion !== 1 ||
        !isObject(parsed.journeys) ||
        !isObject(parsed.turns) ||
        containsProhibitedKey(parsed)
      ) {
        throw new Error("Invalid creative journey database.");
      }
      return structuredClone(parsed) as unknown as BrowserCreativeJourneyDatabase;
    } catch (cause: unknown) {
      throw cause instanceof CreativeJourneyStoreError
        ? cause
        : storeError("CREATIVE_JOURNEY_STORE_CORRUPT", "Creative journey data is not readable.");
    }
  }

  private write(database: BrowserCreativeJourneyDatabase): void {
    this.storage.setItem(DEVELOPMENT_CREATIVE_JOURNEY_KEY, JSON.stringify(database));
  }
}

export class CreativeJourneyStoreError extends Error {
  public constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CreativeJourneyStoreError";
  }
}

function validateJourney(value: CreativeJourneyRecord): CreativeJourneyRecord {
  const status = validateStatus(value.status);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    value.currentState.length < 1 ||
    value.currentState.length > 64 ||
    !/^[a-z][a-z0-9_]*$/u.test(value.currentState) ||
    !isObject(value.snapshot) ||
    containsProhibitedKey(value.snapshot) ||
    (status === "completed") !== (value.completedAt !== null) ||
    (value.completedAt !== null && !isIsoTimestamp(value.completedAt))
  ) {
    throw storeError("CREATIVE_JOURNEY_INVALID", "Creative journey data is invalid.");
  }
  return Object.freeze({
    ...value,
    id: validateIdentifier(value.id, "journey id"),
    kind: validateKind(value.kind),
    status,
    projectId: validateOptionalIdentifier(value.projectId, "project id"),
    chapterId: validateOptionalIdentifier(value.chapterId, "chapter id"),
    candidateId: validateOptionalIdentifier(value.candidateId, "candidate id"),
    snapshot: Object.freeze(structuredClone(value.snapshot)),
  });
}

function validateTurn(value: CreativeJourneyTurnRecord): CreativeJourneyTurnRecord {
  const generationSource: unknown = value.generationSource;
  if (
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !TURN_KINDS.includes(value.kind) ||
    !isIsoTimestamp(value.createdAt) ||
    !isObject(value.snapshot) ||
    containsProhibitedKey(value.snapshot)
  ) {
    throw storeError("CREATIVE_JOURNEY_INVALID", "Creative journey turn is invalid.");
  }
  return Object.freeze({
    ...value,
    id: validateIdentifier(value.id, "turn id"),
    journeyId: validateIdentifier(value.journeyId, "journey id"),
    questionKey: validateOptionalToken(value.questionKey, 64, "question key"),
    generationSource:
      generationSource === null
        ? null
        : generationSource === "provider" || generationSource === "local_fallback"
          ? generationSource
          : fail("Creative generation source is invalid."),
    providerId: validateOptionalToken(value.providerId, 128, "provider id"),
    modelId: validateOptionalToken(value.modelId, 512, "model id"),
    taskKey: validateOptionalToken(value.taskKey, 96, "task key"),
    requestId: validateOptionalToken(value.requestId, 128, "request id"),
    snapshot: Object.freeze(structuredClone(value.snapshot)),
  });
}

function hydrateJourney(row: CreativeJourneyRow): CreativeJourneyRecord {
  return validateJourney({
    id: row.id,
    kind: row.kind as CreativeJourneyKind,
    status: row.status as CreativeJourneyStatus,
    currentState: row.current_state,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    candidateId: row.candidate_id,
    revision: row.revision,
    snapshot: parseSnapshot(row.snapshot_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });
}

function hydrateTurn(row: CreativeJourneyTurnRow): CreativeJourneyTurnRecord {
  return validateTurn({
    id: row.id,
    journeyId: row.journey_id,
    sequence: row.sequence,
    kind: row.turn_kind as CreativeJourneyTurnKind,
    questionKey: row.question_key,
    generationSource: row.generation_source as CreativeGenerationSource | null,
    providerId: row.provider_id,
    modelId: row.model_id,
    taskKey: row.task_key,
    requestId: row.request_id,
    snapshot: parseSnapshot(row.snapshot_json),
    createdAt: row.created_at,
  });
}

function journeyValues(record: CreativeJourneyRecord): readonly SqlPrimitive[] {
  return [
    record.id,
    record.kind,
    record.status,
    record.currentState,
    record.projectId,
    record.chapterId,
    record.candidateId,
    record.revision,
    JSON.stringify(record.snapshot),
    record.createdAt,
    record.updatedAt,
    record.completedAt,
  ];
}

function turnValues(turn: CreativeJourneyTurnRecord): readonly SqlPrimitive[] {
  return [
    turn.id,
    turn.journeyId,
    turn.sequence,
    turn.kind,
    turn.questionKey,
    turn.generationSource,
    turn.providerId,
    turn.modelId,
    turn.taskKey,
    turn.requestId,
    JSON.stringify(turn.snapshot),
    turn.createdAt,
  ];
}

function parseSnapshot(serialized: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isObject(parsed) || containsProhibitedKey(parsed)) {
      throw new Error("Invalid snapshot.");
    }
    return parsed;
  } catch {
    throw storeError("CREATIVE_JOURNEY_STORE_CORRUPT", "Creative journey data is not readable.");
  }
}

function validateKind(value: CreativeJourneyKind): CreativeJourneyKind {
  return JOURNEY_KINDS.includes(value) ? value : fail("Creative journey kind is invalid.");
}

function validateStatus(value: CreativeJourneyStatus): CreativeJourneyStatus {
  return JOURNEY_STATUSES.includes(value) ? value : fail("Creative journey status is invalid.");
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw storeError("CREATIVE_JOURNEY_INVALID", `${label} is invalid.`);
  }
  return value;
}

function validateOptionalIdentifier(value: string | null, label: string): string | null {
  return value === null ? null : validateIdentifier(value, label);
}

function validateOptionalToken(
  value: string | null,
  maximum: number,
  label: string,
): string | null {
  if (
    value !== null &&
    (value.length < 1 ||
      value.length > maximum ||
      value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    throw storeError("CREATIVE_JOURNEY_INVALID", `${label} is invalid.`);
  }
  return value;
}

function isIsoTimestamp(value: string): boolean {
  return value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsProhibitedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsProhibitedKey);
  }
  if (!isObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      /^(api[_-]?key|secret|credential|password|authorization|access[_-]?token|refresh[_-]?token)$/iu.test(
        key,
      ) || containsProhibitedKey(nested),
  );
}

function storeError(code: string, message: string, retryable = false): CreativeJourneyStoreError {
  return new CreativeJourneyStoreError(code, message, retryable);
}

function fail(message: string): never {
  throw storeError("CREATIVE_JOURNEY_INVALID", message);
}

const JOURNEY_KINDS = ["idea", "import", "professional"] as const;
const JOURNEY_STATUSES = ["active", "completed", "abandoned"] as const;
const TURN_KINDS = ["idea", "question", "answer", "skip", "back", "regenerate", "keep"] as const;

const JOURNEY_SELECT = `SELECT
  id, kind, status, current_state, project_id, chapter_id, candidate_id,
  revision, snapshot_json, created_at, updated_at, completed_at
FROM creative_journeys`;

const TURN_SELECT = `SELECT
  id, journey_id, sequence, turn_kind, question_key, generation_source,
  provider_id, model_id, task_key, request_id, snapshot_json, created_at
FROM creative_journey_turns`;

const INSERT_JOURNEY = `INSERT INTO creative_journeys (
  id, kind, status, current_state, project_id, chapter_id, candidate_id,
  revision, snapshot_json, created_at, updated_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_TURN = `INSERT INTO creative_journey_turns (
  id, journey_id, sequence, turn_kind, question_key, generation_source,
  provider_id, model_id, task_key, request_id, snapshot_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
