import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";
import type { Clock } from "@inkshadow/domain";

export const DEVELOPMENT_WRITING_EXPERIENCE_KEY = "inkshadow.development.writing-experience.v1";
export const MAX_WRITING_DISCLOSURE_GRANTS = 128;

const GLOBAL_SCOPE = "global";
const SHA_256_PATTERN = /^[0-9a-f]{64}$/u;
const UNSIGNED_DECIMAL_PATTERN = /^[0-9]{1,19}$/u;

const LEGACY_BROWSER_KEYS = Object.freeze({
  database: "inkshadow.development.database.v1",
  creativeJourneys: "inkshadow.development.creative-journeys.v1",
  projectSeeds: "inkshadow.development.project-seeds.v1",
  professionalRecovery: "inkshadow.professional-create-recovery.v1",
  modelCenter: "inkshadow.development.model-center.v1",
  modelRouting: "inkshadow.development.model-routing.v1",
  modelHub: "inkshadow.development.model-hub.v1",
});

export type WritingExperienceMode = "direct" | "professional";
export type WritingExperienceInitializationSource = "new_install" | "upgrade_existing" | "user";

export interface WritingExperiencePreference {
  readonly mode: WritingExperienceMode;
  readonly initializationSource: WritingExperienceInitializationSource;
  /**
   * Compatibility timestamp for when direct-mode background organization became
   * active. Direct mode itself is the product-policy authority; this is not a
   * second confirmation gate and never grants an unrelated remote call.
   */
  readonly directLocalOrganizationAuthorizedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WritingDisclosureSentScope =
  "chapter_text" | "selected_context_only" | "chapter_and_selected_context";
export type WritingDisclosureCostStatus = "estimated" | "unknown";
export type WritingDisclosureGrantState = "active" | "consumed" | "revoked";

export interface WritingProviderDisclosureGrant {
  readonly fingerprint: string;
  readonly task: "continuation";
  readonly providerId: string;
  readonly modelId: string;
  readonly sentScope: WritingDisclosureSentScope;
  readonly sentScopeHash: string;
  readonly callCount: number;
  readonly retryLimit: number;
  readonly costStatus: WritingDisclosureCostStatus;
  readonly estimatedCostMicros: string | null;
  readonly currency: string | null;
  readonly privacyPolicy: "cloud_allowed";
  readonly state: WritingDisclosureGrantState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
}

export interface RecordWritingProviderDisclosureGrantInput {
  readonly fingerprint: string;
  readonly task: "continuation";
  readonly providerId: string;
  readonly modelId: string;
  readonly sentScope: WritingDisclosureSentScope;
  readonly sentScopeHash: string;
  readonly callCount: number;
  readonly retryLimit: number;
  readonly costStatus: WritingDisclosureCostStatus;
  readonly estimatedCostMicros: string | null;
  readonly currency: string | null;
  readonly privacyPolicy: "cloud_allowed";
}

export interface WritingExperienceStore {
  getOrInitialize(): Promise<WritingExperiencePreference>;
  switchMode(
    mode: WritingExperienceMode,
    expectedRevision: number,
  ): Promise<WritingExperiencePreference>;
  authorizeDirectMode(expectedRevision: number): Promise<WritingExperiencePreference>;
  revokeDirectModeAuthorization(expectedRevision: number): Promise<WritingExperiencePreference>;
  recordDisclosureGrant(
    input: RecordWritingProviderDisclosureGrantInput,
  ): Promise<Readonly<{ grant: WritingProviderDisclosureGrant; created: boolean }>>;
  findDisclosureGrant(fingerprint: string): Promise<WritingProviderDisclosureGrant | null>;
  listActiveDisclosureGrants(): Promise<readonly WritingProviderDisclosureGrant[]>;
  consumeDisclosureGrant(
    fingerprint: string,
    expectedRevision: number,
  ): Promise<WritingProviderDisclosureGrant>;
  revokeDisclosureGrant(
    fingerprint: string,
    expectedRevision: number,
  ): Promise<WritingProviderDisclosureGrant>;
}

interface PreferenceRow {
  readonly mode: string;
  readonly initialization_source: string;
  readonly direct_local_organization_authorized_at: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface DisclosureGrantRow {
  readonly fingerprint: string;
  readonly task: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly sent_scope: string;
  readonly sent_scope_hash: string;
  readonly call_count: number;
  readonly retry_limit: number;
  readonly cost_status: string;
  readonly estimated_cost_micros: string | null;
  readonly currency: string | null;
  readonly privacy_policy: string;
  readonly state: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
}

interface ExistingWritingDataRow {
  readonly has_existing: number;
}

interface AuditCountRow {
  readonly count: number;
}

export class WritingExperienceStoreError extends Error {
  public constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WritingExperienceStoreError";
  }
}

export class TauriWritingExperienceStore implements WritingExperienceStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public getOrInitialize(): Promise<WritingExperiencePreference> {
    return this.executor.transaction((transaction) =>
      readOrInitializeSqlitePreference(transaction, this.clock),
    );
  }

  public async switchMode(
    modeValue: WritingExperienceMode,
    expectedRevisionValue: number,
  ): Promise<WritingExperiencePreference> {
    const mode = validateMode(modeValue);
    const expectedRevision = validateRevision(expectedRevisionValue);
    return this.executor.transaction(async (transaction) => {
      const current = await readOrInitializeSqlitePreference(transaction, this.clock);
      if (current.revision !== expectedRevision) {
        throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
      }
      const updatedAt = this.clock.now();
      const organizationActivatedAt =
        mode === "direct"
          ? (current.directLocalOrganizationAuthorizedAt ?? updatedAt)
          : current.directLocalOrganizationAuthorizedAt;
      const result = await transaction.execute(
        `UPDATE writing_experience_preferences
         SET mode = ?, initialization_source = 'user',
             direct_local_organization_authorized_at = ?,
             revision = revision + 1, updated_at = ?
         WHERE scope = ? AND revision = ?`,
        [mode, organizationActivatedAt, updatedAt, GLOBAL_SCOPE, expectedRevision],
      );
      if (result.rowsAffected !== 1) {
        throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
      }
      return Object.freeze({
        mode,
        initializationSource: "user" as const,
        directLocalOrganizationAuthorizedAt: organizationActivatedAt,
        revision: expectedRevision + 1,
        createdAt: current.createdAt,
        updatedAt,
      });
    });
  }

  public async authorizeDirectMode(
    expectedRevisionValue: number,
  ): Promise<WritingExperiencePreference> {
    const expectedRevision = validateRevision(expectedRevisionValue);
    return this.executor.transaction(async (transaction) => {
      const current = await readOrInitializeSqlitePreference(transaction, this.clock);
      if (current.revision !== expectedRevision) {
        throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
      }
      if (current.directLocalOrganizationAuthorizedAt !== null && current.mode === "direct") {
        return current;
      }
      const updatedAt = this.clock.now();
      const authorizedAt = current.directLocalOrganizationAuthorizedAt ?? updatedAt;
      const result = await transaction.execute(
        `UPDATE writing_experience_preferences
         SET mode = 'direct', initialization_source = 'user',
             direct_local_organization_authorized_at = ?, revision = revision + 1, updated_at = ?
         WHERE scope = ? AND revision = ?`,
        [authorizedAt, updatedAt, GLOBAL_SCOPE, expectedRevision],
      );
      if (result.rowsAffected !== 1) {
        throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
      }
      return freezePreference({
        mode: "direct",
        initializationSource: "user",
        directLocalOrganizationAuthorizedAt: authorizedAt,
        revision: expectedRevision + 1,
        createdAt: current.createdAt,
        updatedAt,
      });
    });
  }

  public async revokeDirectModeAuthorization(
    expectedRevisionValue: number,
  ): Promise<WritingExperiencePreference> {
    const expectedRevision = validateRevision(expectedRevisionValue);
    return this.executor.transaction(async (transaction) => {
      const current = await readOrInitializeSqlitePreference(transaction, this.clock);
      if (current.revision !== expectedRevision) {
        throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
      }
      if (current.mode === "professional" && current.directLocalOrganizationAuthorizedAt === null) {
        return current;
      }
      const updatedAt = this.clock.now();
      const result = await transaction.execute(
        `UPDATE writing_experience_preferences
         SET mode = 'professional', initialization_source = 'user',
             direct_local_organization_authorized_at = NULL,
             revision = revision + 1, updated_at = ?
         WHERE scope = ? AND revision = ?`,
        [updatedAt, GLOBAL_SCOPE, expectedRevision],
      );
      if (result.rowsAffected !== 1) {
        throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
      }
      return freezePreference({
        mode: "professional",
        initializationSource: "user",
        directLocalOrganizationAuthorizedAt: null,
        revision: expectedRevision + 1,
        createdAt: current.createdAt,
        updatedAt,
      });
    });
  }

  public async recordDisclosureGrant(
    inputValue: RecordWritingProviderDisclosureGrantInput,
  ): Promise<Readonly<{ grant: WritingProviderDisclosureGrant; created: boolean }>> {
    const input = validateDisclosureInput(inputValue);
    return this.executor.transaction(async (transaction) => {
      const existing = await findSqliteDisclosureGrant(transaction, input.fingerprint);
      if (existing !== null) {
        assertGrantMatchesInput(existing, input);
      }
      const now = this.clock.now();
      const activeFamily = await listSqliteActiveDisclosureFamily(transaction, input);
      for (const previous of activeFamily) {
        if (previous.fingerprint === input.fingerprint) continue;
        await revokeSqliteDisclosureGrant(transaction, previous, now);
      }
      if (existing?.state === "active") {
        return Object.freeze({ grant: existing, created: false });
      }
      if (existing !== null) {
        await archiveAndDeleteTerminalSqliteGrant(transaction, existing);
      }
      await transaction.execute(
        `INSERT INTO writing_provider_disclosure_grants (
           fingerprint, task, provider_id, model_id, sent_scope, sent_scope_hash,
           call_count, retry_limit, cost_status, estimated_cost_micros, currency,
           privacy_policy, state, revision, created_at, updated_at, consumed_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL, NULL)`,
        [
          input.fingerprint,
          input.task,
          input.providerId,
          input.modelId,
          input.sentScope,
          input.sentScopeHash,
          input.callCount,
          input.retryLimit,
          input.costStatus,
          input.estimatedCostMicros,
          input.currency,
          input.privacyPolicy,
          now,
          now,
        ],
      );
      return Object.freeze({
        grant: disclosureGrantFromInput(input, now),
        created: true,
      });
    });
  }

  public async findDisclosureGrant(
    fingerprintValue: string,
  ): Promise<WritingProviderDisclosureGrant | null> {
    const fingerprint = validateDigest(fingerprintValue, "fingerprint");
    return findSqliteDisclosureGrant(this.executor, fingerprint);
  }

  public async listActiveDisclosureGrants(): Promise<readonly WritingProviderDisclosureGrant[]> {
    const rows = await this.executor.select<DisclosureGrantRow>(
      `${DISCLOSURE_GRANT_SELECT}
       WHERE state = 'active'
       ORDER BY created_at, fingerprint`,
    );
    return Object.freeze(rows.map(disclosureGrantFromRow));
  }

  public consumeDisclosureGrant(
    fingerprintValue: string,
    expectedRevisionValue: number,
  ): Promise<WritingProviderDisclosureGrant> {
    return this.transitionDisclosureGrant(fingerprintValue, expectedRevisionValue, "consumed");
  }

  public revokeDisclosureGrant(
    fingerprintValue: string,
    expectedRevisionValue: number,
  ): Promise<WritingProviderDisclosureGrant> {
    return this.transitionDisclosureGrant(fingerprintValue, expectedRevisionValue, "revoked");
  }

  private async transitionDisclosureGrant(
    fingerprintValue: string,
    expectedRevisionValue: number,
    state: "consumed" | "revoked",
  ): Promise<WritingProviderDisclosureGrant> {
    const fingerprint = validateDigest(fingerprintValue, "fingerprint");
    const expectedRevision = validateRevision(expectedRevisionValue);
    return this.executor.transaction(async (transaction) => {
      const current = await findSqliteDisclosureGrant(transaction, fingerprint);
      if (current?.state !== "active" || current.revision !== expectedRevision) {
        throw revisionConflict("WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT");
      }
      const updatedAt = this.clock.now();
      const consumedAt = state === "consumed" ? updatedAt : null;
      const revokedAt = state === "revoked" ? updatedAt : null;
      const result = await transaction.execute(
        `UPDATE writing_provider_disclosure_grants
         SET state = ?, revision = revision + 1, updated_at = ?,
             consumed_at = ?, revoked_at = ?
         WHERE fingerprint = ? AND state = 'active' AND revision = ?`,
        [state, updatedAt, consumedAt, revokedAt, fingerprint, expectedRevision],
      );
      if (result.rowsAffected !== 1) {
        throw revisionConflict("WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT");
      }
      return Object.freeze({
        ...current,
        state,
        revision: expectedRevision + 1,
        updatedAt,
        consumedAt,
        revokedAt,
      });
    });
  }
}

interface BrowserWritingExperienceDatabase {
  readonly schemaVersion: 1;
  preference: WritingExperiencePreference | null;
  grants: Record<string, WritingProviderDisclosureGrant>;
  grantAudit: WritingProviderDisclosureGrant[];
}

export class BrowserDevelopmentWritingExperienceStore implements WritingExperienceStore {
  public constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  public getOrInitialize(): Promise<WritingExperiencePreference> {
    return Promise.resolve().then(() => {
      const database = this.read();
      if (database.preference !== null) return database.preference;
      const now = this.clock.now();
      const hasExisting = inferExistingBrowserWritingData(this.storage);
      const preference = freezePreference({
        mode: hasExisting ? "professional" : "direct",
        initializationSource: hasExisting ? "upgrade_existing" : "new_install",
        directLocalOrganizationAuthorizedAt: hasExisting ? null : now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      database.preference = preference;
      this.write(database);
      return preference;
    });
  }

  public async switchMode(
    modeValue: WritingExperienceMode,
    expectedRevisionValue: number,
  ): Promise<WritingExperiencePreference> {
    const mode = validateMode(modeValue);
    const expectedRevision = validateRevision(expectedRevisionValue);
    await this.getOrInitialize();
    const database = this.read();
    const current = database.preference;
    if (current?.revision !== expectedRevision) {
      throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
    }
    const updatedAt = this.clock.now();
    const organizationActivatedAt =
      mode === "direct"
        ? (current.directLocalOrganizationAuthorizedAt ?? updatedAt)
        : current.directLocalOrganizationAuthorizedAt;
    const updated = freezePreference({
      mode,
      initializationSource: "user",
      directLocalOrganizationAuthorizedAt: organizationActivatedAt,
      revision: expectedRevision + 1,
      createdAt: current.createdAt,
      updatedAt,
    });
    database.preference = updated;
    this.write(database);
    return updated;
  }

  public async authorizeDirectMode(
    expectedRevisionValue: number,
  ): Promise<WritingExperiencePreference> {
    const expectedRevision = validateRevision(expectedRevisionValue);
    await this.getOrInitialize();
    const database = this.read();
    const current = database.preference;
    if (current?.revision !== expectedRevision) {
      throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
    }
    if (current.directLocalOrganizationAuthorizedAt !== null && current.mode === "direct") {
      return current;
    }
    const updatedAt = this.clock.now();
    const updated = freezePreference({
      mode: "direct",
      initializationSource: "user",
      directLocalOrganizationAuthorizedAt: current.directLocalOrganizationAuthorizedAt ?? updatedAt,
      revision: expectedRevision + 1,
      createdAt: current.createdAt,
      updatedAt,
    });
    database.preference = updated;
    this.write(database);
    return updated;
  }

  public async revokeDirectModeAuthorization(
    expectedRevisionValue: number,
  ): Promise<WritingExperiencePreference> {
    const expectedRevision = validateRevision(expectedRevisionValue);
    await this.getOrInitialize();
    const database = this.read();
    const current = database.preference;
    if (current?.revision !== expectedRevision) {
      throw revisionConflict("WRITING_EXPERIENCE_REVISION_CONFLICT");
    }
    if (current.mode === "professional" && current.directLocalOrganizationAuthorizedAt === null) {
      return current;
    }
    const updated = freezePreference({
      mode: "professional",
      initializationSource: "user",
      directLocalOrganizationAuthorizedAt: null,
      revision: expectedRevision + 1,
      createdAt: current.createdAt,
      updatedAt: this.clock.now(),
    });
    database.preference = updated;
    this.write(database);
    return updated;
  }

  public recordDisclosureGrant(
    inputValue: RecordWritingProviderDisclosureGrantInput,
  ): Promise<Readonly<{ grant: WritingProviderDisclosureGrant; created: boolean }>> {
    return Promise.resolve().then(() => {
      const input = validateDisclosureInput(inputValue);
      const database = this.read();
      const existing = database.grants[input.fingerprint];
      if (existing !== undefined) {
        assertGrantMatchesInput(existing, input);
      }
      const now = this.clock.now();
      for (const previous of Object.values(database.grants)) {
        if (
          previous.state !== "active" ||
          previous.fingerprint === input.fingerprint ||
          !disclosureAuthorityFamilyMatches(previous, input)
        ) {
          continue;
        }
        database.grants[previous.fingerprint] = revokeDisclosureGrantSnapshot(previous, now);
      }
      if (existing?.state === "active") {
        this.write(database);
        return Object.freeze({ grant: existing, created: false });
      }
      if (existing !== undefined) {
        database.grantAudit.push(existing);
        Reflect.deleteProperty(database.grants, existing.fingerprint);
      }
      if (
        Object.values(database.grants).filter(({ state }) => state === "active").length >=
        MAX_WRITING_DISCLOSURE_GRANTS
      ) {
        throw storeError(
          "WRITING_DISCLOSURE_GRANT_LIMIT_REACHED",
          "Too many active writing disclosure grants are retained.",
        );
      }
      const grant = disclosureGrantFromInput(input, now);
      database.grants[grant.fingerprint] = grant;
      this.write(database);
      return Object.freeze({ grant, created: true });
    });
  }

  public findDisclosureGrant(
    fingerprintValue: string,
  ): Promise<WritingProviderDisclosureGrant | null> {
    return Promise.resolve().then(() => {
      const fingerprint = validateDigest(fingerprintValue, "fingerprint");
      return this.read().grants[fingerprint] ?? null;
    });
  }

  public listActiveDisclosureGrants(): Promise<readonly WritingProviderDisclosureGrant[]> {
    return Promise.resolve().then(() =>
      Object.freeze(
        Object.values(this.read().grants)
          .filter(({ state }) => state === "active")
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.fingerprint.localeCompare(right.fingerprint),
          ),
      ),
    );
  }

  public consumeDisclosureGrant(
    fingerprintValue: string,
    expectedRevisionValue: number,
  ): Promise<WritingProviderDisclosureGrant> {
    return this.transitionDisclosureGrant(fingerprintValue, expectedRevisionValue, "consumed");
  }

  public revokeDisclosureGrant(
    fingerprintValue: string,
    expectedRevisionValue: number,
  ): Promise<WritingProviderDisclosureGrant> {
    return this.transitionDisclosureGrant(fingerprintValue, expectedRevisionValue, "revoked");
  }

  private transitionDisclosureGrant(
    fingerprintValue: string,
    expectedRevisionValue: number,
    state: "consumed" | "revoked",
  ): Promise<WritingProviderDisclosureGrant> {
    return Promise.resolve().then(() => {
      const fingerprint = validateDigest(fingerprintValue, "fingerprint");
      const expectedRevision = validateRevision(expectedRevisionValue);
      const database = this.read();
      const current = database.grants[fingerprint];
      if (current?.state !== "active" || current.revision !== expectedRevision) {
        throw revisionConflict("WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT");
      }
      const updatedAt = this.clock.now();
      const updated = freezeDisclosureGrant({
        ...current,
        state,
        revision: current.revision + 1,
        updatedAt,
        consumedAt: state === "consumed" ? updatedAt : null,
        revokedAt: state === "revoked" ? updatedAt : null,
      });
      database.grants[fingerprint] = updated;
      this.write(database);
      return updated;
    });
  }

  private read(): BrowserWritingExperienceDatabase {
    let serialized: string | null;
    try {
      serialized = this.storage.getItem(DEVELOPMENT_WRITING_EXPERIENCE_KEY);
    } catch {
      throw storeError(
        "WRITING_EXPERIENCE_STORE_UNAVAILABLE",
        "The local writing experience preference is unavailable.",
      );
    }
    if (serialized === null) {
      return { schemaVersion: 1, preference: null, grants: {}, grantAudit: [] };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== 1 ||
        !(parsed.preference === null || isRecord(parsed.preference)) ||
        !isRecord(parsed.grants) ||
        !(parsed.grantAudit === undefined || Array.isArray(parsed.grantAudit))
      ) {
        throw new Error("Invalid writing experience database shape.");
      }
      const preference =
        parsed.preference === null ? null : validateStoredPreference(parsed.preference);
      const grants: Record<string, WritingProviderDisclosureGrant> = {};
      for (const [fingerprint, value] of Object.entries(parsed.grants)) {
        const grant = validateStoredDisclosureGrant(value);
        if (grant.fingerprint !== fingerprint) {
          throw new Error("Writing disclosure grant key mismatch.");
        }
        grants[fingerprint] = grant;
      }
      if (
        Object.values(grants).filter(({ state }) => state === "active").length >
        MAX_WRITING_DISCLOSURE_GRANTS
      ) {
        throw new Error("Too many active writing disclosure grants are stored.");
      }
      const grantAudit = (parsed.grantAudit ?? []).map((value) =>
        validateStoredDisclosureGrant(value),
      );
      return { schemaVersion: 1, preference, grants, grantAudit };
    } catch (cause: unknown) {
      if (cause instanceof WritingExperienceStoreError) throw cause;
      throw storeError(
        "WRITING_EXPERIENCE_STORE_CORRUPT",
        "The local writing experience preference failed integrity validation.",
      );
    }
  }

  private write(database: BrowserWritingExperienceDatabase): void {
    try {
      this.storage.setItem(DEVELOPMENT_WRITING_EXPERIENCE_KEY, JSON.stringify(database));
    } catch {
      throw storeError(
        "WRITING_EXPERIENCE_STORE_UNAVAILABLE",
        "The local writing experience preference could not be saved.",
      );
    }
  }
}

const DISCLOSURE_GRANT_SELECT = `SELECT
  fingerprint, task, provider_id, model_id, sent_scope, sent_scope_hash,
  call_count, retry_limit, cost_status, estimated_cost_micros, currency,
  privacy_policy, state, revision, created_at, updated_at, consumed_at, revoked_at
FROM writing_provider_disclosure_grants`;

async function readOrInitializeSqlitePreference(
  transaction: TransactionExecutor,
  clock: Clock,
): Promise<WritingExperiencePreference> {
  const rows = await transaction.select<PreferenceRow>(
    `SELECT mode, initialization_source, direct_local_organization_authorized_at,
            revision, created_at, updated_at
     FROM writing_experience_preferences WHERE scope = ?`,
    [GLOBAL_SCOPE],
  );
  if (rows.length > 0) return preferenceFromRow(requireOnly(rows));
  const existing = requireOnly(
    await transaction.select<ExistingWritingDataRow>(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM projects LIMIT 1)
         OR EXISTS (SELECT 1 FROM chapters LIMIT 1)
         OR EXISTS (SELECT 1 FROM creative_journeys WHERE kind = 'professional' LIMIT 1)
         OR EXISTS (SELECT 1 FROM project_seeds WHERE journey_kind = 'professional' LIMIT 1)
         OR EXISTS (SELECT 1 FROM model_role_routes LIMIT 1)
         OR EXISTS (
           SELECT 1 FROM novel_task_routes
           WHERE route_origin IN ('user', 'legacy') LIMIT 1
         )
         OR EXISTS (SELECT 1 FROM model_profiles LIMIT 1)
         OR EXISTS (SELECT 1 FROM model_provider_connections LIMIT 1)
       THEN 1 ELSE 0 END AS has_existing`,
    ),
  );
  const hasExisting = existing.has_existing === 1;
  const now = clock.now();
  const preference = freezePreference({
    mode: hasExisting ? "professional" : "direct",
    initializationSource: hasExisting ? "upgrade_existing" : "new_install",
    directLocalOrganizationAuthorizedAt: hasExisting ? null : now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await transaction.execute(
    `INSERT INTO writing_experience_preferences (
       scope, mode, initialization_source, direct_local_organization_authorized_at,
       revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [
      GLOBAL_SCOPE,
      preference.mode,
      preference.initializationSource,
      preference.directLocalOrganizationAuthorizedAt,
      preference.createdAt,
      preference.updatedAt,
    ],
  );
  return preference;
}

async function findSqliteDisclosureGrant(
  executor: Pick<TransactionExecutor, "select">,
  fingerprint: string,
): Promise<WritingProviderDisclosureGrant | null> {
  const rows = await executor.select<DisclosureGrantRow>(
    `${DISCLOSURE_GRANT_SELECT} WHERE fingerprint = ?`,
    [fingerprint],
  );
  return rows.length === 0 ? null : disclosureGrantFromRow(requireOnly(rows));
}

async function listSqliteActiveDisclosureFamily(
  transaction: TransactionExecutor,
  input: RecordWritingProviderDisclosureGrantInput,
): Promise<readonly WritingProviderDisclosureGrant[]> {
  const rows = await transaction.select<DisclosureGrantRow>(
    `${DISCLOSURE_GRANT_SELECT} WHERE state = 'active' ORDER BY created_at, fingerprint`,
  );
  return rows
    .map(disclosureGrantFromRow)
    .filter((grant) => disclosureAuthorityFamilyMatches(grant, input));
}

async function revokeSqliteDisclosureGrant(
  transaction: TransactionExecutor,
  grant: WritingProviderDisclosureGrant,
  now: string,
): Promise<void> {
  const result = await transaction.execute(
    `UPDATE writing_provider_disclosure_grants
     SET state = 'revoked', revision = revision + 1, updated_at = ?, revoked_at = ?
     WHERE fingerprint = ? AND state = 'active' AND revision = ?`,
    [now, now, grant.fingerprint, grant.revision],
  );
  if (result.rowsAffected !== 1) {
    throw revisionConflict("WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT");
  }
}

async function archiveAndDeleteTerminalSqliteGrant(
  transaction: TransactionExecutor,
  grant: WritingProviderDisclosureGrant,
): Promise<void> {
  const auditSequence =
    requireOnly(
      await transaction.select<AuditCountRow>(
        `SELECT COUNT(*) AS count FROM local_audit_events
         WHERE entity_type = 'writing_provider_disclosure_grant' AND entity_id = ?`,
        [grant.fingerprint],
      ),
    ).count + 1;
  await transaction.execute(
    `INSERT INTO local_audit_events (
       id, project_id, entity_type, entity_id, action, request_id, metadata_json, created_at
     ) VALUES (?, NULL, 'writing_provider_disclosure_grant', ?, ?, ?, ?, ?)`,
    [
      `writing-disclosure:${grant.fingerprint}:${String(auditSequence)}`,
      grant.fingerprint,
      `archive_${grant.state}`,
      grant.fingerprint,
      JSON.stringify(grant),
      grant.updatedAt,
    ],
  );
  const deleted = await transaction.execute(
    `DELETE FROM writing_provider_disclosure_grants
     WHERE fingerprint = ? AND state = ? AND revision = ?`,
    [grant.fingerprint, grant.state, grant.revision],
  );
  if (deleted.rowsAffected !== 1) {
    throw revisionConflict("WRITING_DISCLOSURE_GRANT_REVISION_CONFLICT");
  }
}

function inferExistingBrowserWritingData(storage: Storage): boolean {
  const database = readLegacyBrowserValue(storage, LEGACY_BROWSER_KEYS.database);
  if (database.unsafe) return true;
  if (
    isRecord(database.value) &&
    ((Array.isArray(database.value.projects) && database.value.projects.length > 0) ||
      (Array.isArray(database.value.chapters) && database.value.chapters.length > 0))
  ) {
    return true;
  }

  const journeys = readLegacyBrowserValue(storage, LEGACY_BROWSER_KEYS.creativeJourneys);
  if (journeys.unsafe) return true;
  if (
    isRecord(journeys.value) &&
    isRecord(journeys.value.journeys) &&
    Object.values(journeys.value.journeys).some(
      (journey) =>
        isRecord(journey) &&
        (journey.kind === "professional" ||
          (isRecord(journey.snapshot) &&
            isRecord(journey.snapshot.projectSeed) &&
            journey.snapshot.projectSeed.journeyKind === "professional")),
    )
  ) {
    return true;
  }

  const seeds = readLegacyBrowserValue(storage, LEGACY_BROWSER_KEYS.projectSeeds);
  if (seeds.unsafe) return true;
  if (
    isRecord(seeds.value) &&
    isRecord(seeds.value.records) &&
    Object.values(seeds.value.records).some(
      (record) =>
        isRecord(record) && isRecord(record.seed) && record.seed.journeyKind === "professional",
    )
  ) {
    return true;
  }

  const professionalRecovery = readLegacyBrowserValue(
    storage,
    LEGACY_BROWSER_KEYS.professionalRecovery,
  );
  if (professionalRecovery.present) return true;

  const modelCenter = readLegacyBrowserValue(storage, LEGACY_BROWSER_KEYS.modelCenter);
  if (modelCenter.unsafe) return true;
  if (
    isRecord(modelCenter.value) &&
    isRecord(modelCenter.value.profiles) &&
    Object.keys(modelCenter.value.profiles).length > 0
  ) {
    return true;
  }

  const modelRouting = readLegacyBrowserValue(storage, LEGACY_BROWSER_KEYS.modelRouting);
  if (modelRouting.unsafe) return true;
  if (
    isRecord(modelRouting.value) &&
    isRecord(modelRouting.value.routes) &&
    Object.keys(modelRouting.value.routes).length > 0
  ) {
    return true;
  }

  const modelHub = readLegacyBrowserValue(storage, LEGACY_BROWSER_KEYS.modelHub);
  if (modelHub.unsafe) return true;
  if (isRecord(modelHub.value) && isRecord(modelHub.value.state)) {
    if (
      isRecord(modelHub.value.state.connections) &&
      Object.keys(modelHub.value.state.connections).length > 0
    ) {
      return true;
    }
    if (
      isRecord(modelHub.value.state.routes) &&
      Object.values(modelHub.value.state.routes).some(
        (route) =>
          isRecord(route) && (route.routeOrigin === "user" || route.routeOrigin === "legacy"),
      )
    ) {
      return true;
    }
  }
  return false;
}

function readLegacyBrowserValue(
  storage: Storage,
  key: string,
): Readonly<{ present: boolean; unsafe: boolean; value: unknown }> {
  try {
    const serialized = storage.getItem(key);
    if (serialized === null) return { present: false, unsafe: false, value: null };
    try {
      return { present: true, unsafe: false, value: JSON.parse(serialized) as unknown };
    } catch {
      return { present: true, unsafe: true, value: null };
    }
  } catch {
    return { present: true, unsafe: true, value: null };
  }
}

function validateStoredPreference(value: Record<string, unknown>): WritingExperiencePreference {
  const mode = validateMode(value.mode);
  const initializationSource = validateInitializationSource(value.initializationSource);
  const directLocalOrganizationAuthorizedAt = validateOptionalTimestamp(
    value.directLocalOrganizationAuthorizedAt ?? null,
    "directLocalOrganizationAuthorizedAt",
  );
  const revision = validateRevision(value.revision);
  const createdAt = validateTimestamp(value.createdAt, "createdAt");
  const updatedAt = validateTimestamp(value.updatedAt, "updatedAt");
  if (
    updatedAt < createdAt ||
    (directLocalOrganizationAuthorizedAt !== null &&
      (directLocalOrganizationAuthorizedAt < createdAt ||
        directLocalOrganizationAuthorizedAt > updatedAt))
  ) {
    throw new Error("Writing experience timestamp order is invalid.");
  }
  return freezePreference({
    mode,
    initializationSource,
    directLocalOrganizationAuthorizedAt,
    revision,
    createdAt,
    updatedAt,
  });
}

function validateStoredDisclosureGrant(value: unknown): WritingProviderDisclosureGrant {
  if (!isRecord(value)) throw new Error("Writing disclosure grant is invalid.");
  const input = validateDisclosureInput({
    fingerprint: value.fingerprint as string,
    task: value.task as "continuation",
    providerId: value.providerId as string,
    modelId: value.modelId as string,
    sentScope: value.sentScope as WritingDisclosureSentScope,
    sentScopeHash: value.sentScopeHash as string,
    callCount: value.callCount as number,
    retryLimit: value.retryLimit as number,
    costStatus: value.costStatus as WritingDisclosureCostStatus,
    estimatedCostMicros: value.estimatedCostMicros as string | null,
    currency: value.currency as string | null,
    privacyPolicy: value.privacyPolicy as "cloud_allowed",
  });
  const state = validateGrantState(value.state);
  const revision = validateRevision(value.revision);
  const createdAt = validateTimestamp(value.createdAt, "createdAt");
  const updatedAt = validateTimestamp(value.updatedAt, "updatedAt");
  const consumedAt = validateOptionalTimestamp(value.consumedAt, "consumedAt");
  const revokedAt = validateOptionalTimestamp(value.revokedAt, "revokedAt");
  if (
    updatedAt < createdAt ||
    (state === "active" && (consumedAt !== null || revokedAt !== null)) ||
    (state === "consumed" && (consumedAt === null || revokedAt !== null)) ||
    (state === "revoked" && (consumedAt !== null || revokedAt === null))
  ) {
    throw new Error("Writing disclosure grant state is invalid.");
  }
  return freezeDisclosureGrant({
    ...input,
    state,
    revision,
    createdAt,
    updatedAt,
    consumedAt,
    revokedAt,
  });
}

function validateDisclosureInput(inputValue: unknown): RecordWritingProviderDisclosureGrantInput {
  if (!isRecord(inputValue)) throw new Error("Writing disclosure input is invalid.");
  const input = inputValue;
  const fingerprint = validateDigest(input.fingerprint, "fingerprint");
  if (input.task !== "continuation") throw new Error("Writing disclosure task is invalid.");
  const providerId = validateBoundedText(input.providerId, "providerId", 128);
  const modelId = validateBoundedText(input.modelId, "modelId", 512);
  const sentScope = validateSentScope(input.sentScope);
  const sentScopeHash = validateDigest(input.sentScopeHash, "sentScopeHash");
  const callCount = validateBoundedInteger(input.callCount, "callCount", 1, 3);
  const retryLimit = validateBoundedInteger(input.retryLimit, "retryLimit", 0, 3);
  const costStatus = validateCostStatus(input.costStatus);
  const estimatedCostMicros =
    input.estimatedCostMicros === null
      ? null
      : validateUnsignedDecimal(input.estimatedCostMicros, "estimatedCostMicros");
  const currency = input.currency === null ? null : validateCurrency(input.currency);
  if (
    (costStatus === "unknown" && (estimatedCostMicros !== null || currency !== null)) ||
    (costStatus === "estimated" && (estimatedCostMicros === null || currency === null))
  ) {
    throw new Error("Writing disclosure cost metadata is inconsistent.");
  }
  if (input.privacyPolicy !== "cloud_allowed") {
    throw storeError(
      "WRITING_DISCLOSURE_PRIVACY_BLOCKED",
      "Only an explicit cloud-allowed scope can receive remote disclosure authority.",
    );
  }
  return Object.freeze({
    fingerprint,
    task: "continuation",
    providerId,
    modelId,
    sentScope,
    sentScopeHash,
    callCount,
    retryLimit,
    costStatus,
    estimatedCostMicros,
    currency,
    privacyPolicy: "cloud_allowed",
  });
}

function assertGrantMatchesInput(
  grant: WritingProviderDisclosureGrant,
  input: RecordWritingProviderDisclosureGrantInput,
): void {
  if (
    grant.providerId !== input.providerId ||
    grant.modelId !== input.modelId ||
    grant.sentScope !== input.sentScope ||
    grant.sentScopeHash !== input.sentScopeHash ||
    grant.callCount !== input.callCount ||
    grant.retryLimit !== input.retryLimit ||
    grant.costStatus !== input.costStatus ||
    grant.estimatedCostMicros !== input.estimatedCostMicros ||
    grant.currency !== input.currency
  ) {
    throw storeError(
      "WRITING_DISCLOSURE_FINGERPRINT_CONFLICT",
      "The writing disclosure fingerprint is already bound to different authority metadata.",
    );
  }
}

/**
 * One reusable authority family. Every cost state, amount or currency drift
 * receives a new fingerprint and explicit authorization, then atomically
 * retires the superseded grant in this same non-cost authority family.
 */
function disclosureAuthorityFamilyMatches(
  grant: WritingProviderDisclosureGrant,
  input: RecordWritingProviderDisclosureGrantInput,
): boolean {
  // task and privacy are schema-fixed to continuation/cloud_allowed; if those
  // domains expand they must become explicit family keys here.
  return (
    grant.providerId === input.providerId &&
    grant.modelId === input.modelId &&
    grant.sentScope === input.sentScope &&
    grant.sentScopeHash === input.sentScopeHash &&
    grant.callCount === input.callCount &&
    grant.retryLimit === input.retryLimit
  );
}

function revokeDisclosureGrantSnapshot(
  grant: WritingProviderDisclosureGrant,
  now: string,
): WritingProviderDisclosureGrant {
  return freezeDisclosureGrant({
    ...grant,
    state: "revoked",
    revision: grant.revision + 1,
    updatedAt: now,
    consumedAt: null,
    revokedAt: now,
  });
}

function preferenceFromRow(row: PreferenceRow): WritingExperiencePreference {
  return validateStoredPreference({
    mode: row.mode,
    initializationSource: row.initialization_source,
    directLocalOrganizationAuthorizedAt: row.direct_local_organization_authorized_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function disclosureGrantFromRow(row: DisclosureGrantRow): WritingProviderDisclosureGrant {
  return validateStoredDisclosureGrant({
    fingerprint: row.fingerprint,
    task: row.task,
    providerId: row.provider_id,
    modelId: row.model_id,
    sentScope: row.sent_scope,
    sentScopeHash: row.sent_scope_hash,
    callCount: row.call_count,
    retryLimit: row.retry_limit,
    costStatus: row.cost_status,
    estimatedCostMicros: row.estimated_cost_micros,
    currency: row.currency,
    privacyPolicy: row.privacy_policy,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  });
}

function disclosureGrantFromInput(
  input: RecordWritingProviderDisclosureGrantInput,
  now: string,
): WritingProviderDisclosureGrant {
  return freezeDisclosureGrant({
    ...input,
    state: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    consumedAt: null,
    revokedAt: null,
  });
}

function validateMode(value: unknown): WritingExperienceMode {
  if (value !== "direct" && value !== "professional") {
    throw new Error("Writing experience mode is invalid.");
  }
  return value;
}

function validateInitializationSource(value: unknown): WritingExperienceInitializationSource {
  if (value !== "new_install" && value !== "upgrade_existing" && value !== "user") {
    throw new Error("Writing experience initialization source is invalid.");
  }
  return value;
}

function validateSentScope(value: unknown): WritingDisclosureSentScope {
  if (
    value !== "chapter_text" &&
    value !== "selected_context_only" &&
    value !== "chapter_and_selected_context"
  ) {
    throw new Error("Writing disclosure sent scope is invalid.");
  }
  return value;
}

function validateCostStatus(value: unknown): WritingDisclosureCostStatus {
  if (value !== "estimated" && value !== "unknown") {
    throw new Error("Writing disclosure cost status is invalid.");
  }
  return value;
}

function validateGrantState(value: unknown): WritingDisclosureGrantState {
  if (value !== "active" && value !== "consumed" && value !== "revoked") {
    throw new Error("Writing disclosure grant state is invalid.");
  }
  return value;
}

function validateDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_256_PATTERN.test(value)) {
    throw new Error(`Writing disclosure ${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function validateBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Writing disclosure ${label} is invalid.`);
  }
  return value;
}

function validateBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Writing disclosure ${label} is invalid.`);
  }
  return Number(value);
}

function validateRevision(value: unknown): number {
  return validateBoundedInteger(value, "revision", 1, Number.MAX_SAFE_INTEGER);
}

function validateUnsignedDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL_PATTERN.test(value)) {
    throw new Error(`Writing disclosure ${label} is invalid.`);
  }
  return value;
}

function validateCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) {
    throw new Error("Writing disclosure currency is invalid.");
  }
  return value;
}

function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new Error(`Writing disclosure ${label} is invalid.`);
  }
  return value;
}

function validateOptionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : validateTimestamp(value, label);
}

function freezePreference(preference: WritingExperiencePreference): WritingExperiencePreference {
  return Object.freeze({ ...preference });
}

function freezeDisclosureGrant(
  grant: WritingProviderDisclosureGrant,
): WritingProviderDisclosureGrant {
  return Object.freeze({ ...grant });
}

function requireOnly<Value>(values: readonly Value[]): Value {
  const value = values[0];
  if (values.length !== 1 || value === undefined) {
    throw storeError(
      "WRITING_EXPERIENCE_STORE_CORRUPT",
      "The writing experience authority returned an unexpected row count.",
    );
  }
  return value;
}

function revisionConflict(code: string): WritingExperienceStoreError {
  return storeError(code, "The writing experience authority changed concurrently.", true);
}

function storeError(code: string, message: string, retryable = false): WritingExperienceStoreError {
  return new WritingExperienceStoreError(code, message, retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
