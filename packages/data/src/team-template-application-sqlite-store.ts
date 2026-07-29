import { CloudIdempotencyKeySchema, UuidV7Schema } from "@inkshadow/contracts";
import type { Clock } from "@inkshadow/domain";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_PENDING_LIMIT = 100;

export interface TeamTemplateProjectSetting {
  readonly key: string;
  readonly value: string | number | boolean;
}

export interface TeamTemplatePromptReference {
  readonly registryId: string;
  readonly revision: number;
}

export interface TeamTemplatePromptRule {
  readonly ruleId: string;
  readonly label: string;
  readonly instruction: string;
}

export interface TeamTemplateChecklistItem {
  readonly itemId: string;
  readonly label: string;
  readonly required: boolean;
}

export interface TeamTemplateApplicationPayload {
  readonly projectSettings: readonly TeamTemplateProjectSetting[];
  readonly promptRegistryRefs: readonly TeamTemplatePromptReference[];
  readonly promptRules: readonly TeamTemplatePromptRule[];
  readonly reviewChecklist: readonly TeamTemplateChecklistItem[];
}

export interface ApplyTeamTemplateAtomicallyInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly templateRevision: number;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly expectedProjectRevision: number;
  readonly cloudIdempotencyKey: string;
  readonly requestedByMembershipId: string;
  readonly payload: TeamTemplateApplicationPayload;
}

export interface TeamTemplateApplicationReceipt {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly templateRevision: number;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly projectRevisionBefore: number;
  readonly projectRevisionAfter: number;
  readonly cloudIdempotencyKey: string;
  readonly requestedByMembershipId: string;
  readonly appliedAt: string;
  readonly cloudRecordedAt: string | null;
  readonly result: "applied" | "already_applied";
}

export interface TeamTemplateApplicationScope {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
}

export type TeamTemplateApplicationStoreErrorCode =
  | "TEAM_TEMPLATE_APPLICATION_CORRUPT"
  | "TEAM_TEMPLATE_APPLICATION_IDEMPOTENCY_CONFLICT"
  | "TEAM_TEMPLATE_APPLICATION_INVALID"
  | "TEAM_TEMPLATE_APPLICATION_PROJECT_NOT_FOUND"
  | "TEAM_TEMPLATE_APPLICATION_REVISION_CONFLICT";

export class TeamTemplateApplicationStoreError extends Error {
  public constructor(
    public readonly code: TeamTemplateApplicationStoreErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "TeamTemplateApplicationStoreError";
  }
}

interface ReceiptRow {
  readonly application_id: string;
  readonly tenant_id: string;
  readonly team_id: string;
  readonly project_id: string;
  readonly template_id: string;
  readonly template_revision: number;
  readonly version_id: string;
  readonly version_number: number;
  readonly content_digest: string;
  readonly project_revision_before: number;
  readonly project_revision_after: number;
  readonly cloud_idempotency_key: string;
  readonly requested_by_membership_id: string;
  readonly applied_at: string;
  readonly cloud_recorded_at: string | null;
}

interface ProjectRow {
  readonly revision: number;
  readonly status: string;
}

const RECEIPT_SELECT = `
  SELECT application_id, tenant_id, team_id, project_id, template_id,
         template_revision, version_id, version_number, content_digest,
         project_revision_before, project_revision_after,
         cloud_idempotency_key, requested_by_membership_id,
         applied_at, cloud_recorded_at
  FROM team_template_application_receipts`;

/**
 * SQLite authority for applying one decrypted team-template payload.
 *
 * The project revision CAS, replacement of all template-managed project
 * settings, prompt references, prompt rules and checklist items, and insertion
 * of the immutable receipt all run in one BEGIN IMMEDIATE transaction.
 */
export class TeamTemplateApplicationSqliteStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public async applyAtomically(
    inputValue: ApplyTeamTemplateAtomicallyInput,
  ): Promise<TeamTemplateApplicationReceipt> {
    const input = validateApplication(inputValue);
    const appliedAt = nowIso(this.clock);
    return this.executor.transaction(async (transaction) => {
      const byApplication = await selectReceiptByApplication(transaction, input.applicationId);
      if (byApplication !== null) {
        requireExactApplicationReplay(byApplication, input);
        return mapReceipt(byApplication, "already_applied");
      }

      const byVersion = await selectReceiptByVersion(transaction, input);
      if (byVersion !== null) {
        requireSameAppliedVersion(byVersion, input);
        return mapReceipt(byVersion, "already_applied");
      }

      const project = await selectProject(transaction, input.projectId);
      if (project?.status !== "active") {
        throw new TeamTemplateApplicationStoreError(
          "TEAM_TEMPLATE_APPLICATION_PROJECT_NOT_FOUND",
          "The local active project required by this template application was not found.",
        );
      }
      if (project.revision !== input.expectedProjectRevision) {
        throw revisionConflict();
      }
      const advanced = await transaction.execute(
        `UPDATE projects
         SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'active' AND revision = ?`,
        [appliedAt, input.projectId, input.expectedProjectRevision],
      );
      if (advanced.rowsAffected !== 1) {
        throw revisionConflict();
      }

      await insertReceipt(transaction, input, appliedAt);
      await replaceTemplateManagedProjectState(transaction, input, appliedAt);
      const committed = await selectReceiptByApplication(transaction, input.applicationId);
      if (committed === null) {
        throw corrupt("The committed team-template receipt could not be read back.");
      }
      return mapReceipt(committed, "applied");
    });
  }

  public async findCommitted(
    scopeValue: TeamTemplateApplicationScope & Readonly<{ applicationId: string }>,
  ): Promise<TeamTemplateApplicationReceipt | null> {
    const scope = validateScope(scopeValue);
    const applicationId = requireUuid(scopeValue.applicationId, "applicationId");
    const row = await selectReceiptByApplication(this.executor, applicationId);
    if (row === null) {
      return null;
    }
    requireReceiptScope(row, scope);
    return mapReceipt(row, "applied");
  }

  public async findAppliedVersion(
    scopeValue: TeamTemplateApplicationScope & Readonly<{ templateId: string; versionId: string }>,
  ): Promise<TeamTemplateApplicationReceipt | null> {
    const scope = validateScope(scopeValue);
    const templateId = requireUuid(scopeValue.templateId, "templateId");
    const versionId = requireUuid(scopeValue.versionId, "versionId");
    const rows = await this.executor.select<ReceiptRow>(
      `${RECEIPT_SELECT}
       WHERE tenant_id = ? AND team_id = ? AND project_id = ?
         AND template_id = ? AND version_id = ?
       LIMIT 2`,
      [scope.tenantId, scope.teamId, scope.projectId, templateId, versionId],
    );
    if (rows.length > 1) {
      throw corrupt("The same team-template version has more than one local receipt.");
    }
    const row = rows[0];
    return row === undefined ? null : mapReceipt(row, "already_applied");
  }

  public async listPendingCloudRecords(
    input: TeamTemplateApplicationScope & Readonly<{ limit?: number }>,
  ): Promise<readonly TeamTemplateApplicationReceipt[]> {
    const limit = input.limit ?? 50;
    requireSafeInteger(limit, 1, MAX_PENDING_LIMIT, "limit");
    const scope = validateScope(input);
    const rows = await this.executor.select<ReceiptRow>(
      `${RECEIPT_SELECT}
       WHERE tenant_id = ? AND team_id = ? AND project_id = ?
         AND cloud_recorded_at IS NULL
       ORDER BY applied_at ASC, application_id ASC
       LIMIT ?`,
      [scope.tenantId, scope.teamId, scope.projectId, limit],
    );
    return Object.freeze(rows.map((row) => mapReceipt(row, "applied")));
  }

  public async markCloudRecorded(
    input: Readonly<{
      applicationId: string;
      cloudRecordedAt: string;
    }>,
  ): Promise<TeamTemplateApplicationReceipt> {
    const applicationId = requireUuid(input.applicationId, "applicationId");
    const cloudRecordedAt = requireTimestamp(input.cloudRecordedAt, "cloudRecordedAt");
    return this.executor.transaction(async (transaction) => {
      const existing = await selectReceiptByApplication(transaction, applicationId);
      if (existing === null) {
        throw new TeamTemplateApplicationStoreError(
          "TEAM_TEMPLATE_APPLICATION_PROJECT_NOT_FOUND",
          "The local team-template application receipt was not found.",
        );
      }
      if (existing.cloud_recorded_at !== null) {
        if (existing.cloud_recorded_at !== cloudRecordedAt) {
          throw new TeamTemplateApplicationStoreError(
            "TEAM_TEMPLATE_APPLICATION_IDEMPOTENCY_CONFLICT",
            "The cloud-recorded timestamp conflicts with the immutable local receipt.",
          );
        }
        return mapReceipt(existing, "already_applied");
      }
      const updated = await transaction.execute(
        `UPDATE team_template_application_receipts
         SET cloud_recorded_at = ?
         WHERE application_id = ? AND cloud_recorded_at IS NULL`,
        [cloudRecordedAt, applicationId],
      );
      if (updated.rowsAffected !== 1) {
        throw new TeamTemplateApplicationStoreError(
          "TEAM_TEMPLATE_APPLICATION_IDEMPOTENCY_CONFLICT",
          "The local team-template cloud checkpoint changed concurrently.",
          true,
        );
      }
      const checkpointed = await selectReceiptByApplication(transaction, applicationId);
      if (checkpointed === null) {
        throw corrupt("The checkpointed team-template receipt could not be read back.");
      }
      return mapReceipt(checkpointed, "applied");
    });
  }
}

async function replaceTemplateManagedProjectState(
  transaction: TransactionExecutor,
  input: ApplyTeamTemplateAtomicallyInput,
  appliedAt: string,
): Promise<void> {
  await transaction.execute("DELETE FROM project_team_template_settings WHERE project_id = ?", [
    input.projectId,
  ]);
  await transaction.execute("DELETE FROM project_team_template_prompt_refs WHERE project_id = ?", [
    input.projectId,
  ]);
  await transaction.execute("DELETE FROM project_team_template_prompt_rules WHERE project_id = ?", [
    input.projectId,
  ]);
  await transaction.execute(
    "DELETE FROM project_team_template_checklist_items WHERE project_id = ?",
    [input.projectId],
  );

  for (const setting of input.payload.projectSettings) {
    await transaction.execute(
      `INSERT INTO project_team_template_settings (
         project_id, setting_key, value_json, source_application_id, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      [input.projectId, setting.key, JSON.stringify(setting.value), input.applicationId, appliedAt],
    );
  }
  for (const [ordinal, reference] of input.payload.promptRegistryRefs.entries()) {
    await transaction.execute(
      `INSERT INTO project_team_template_prompt_refs (
         project_id, registry_id, registry_revision, ordinal,
         source_application_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        reference.registryId,
        reference.revision,
        ordinal,
        input.applicationId,
        appliedAt,
      ],
    );
  }
  for (const [ordinal, rule] of input.payload.promptRules.entries()) {
    await transaction.execute(
      `INSERT INTO project_team_template_prompt_rules (
         project_id, rule_id, label, instruction, ordinal,
         source_application_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        rule.ruleId,
        rule.label,
        rule.instruction,
        ordinal,
        input.applicationId,
        appliedAt,
      ],
    );
  }
  for (const [ordinal, item] of input.payload.reviewChecklist.entries()) {
    await transaction.execute(
      `INSERT INTO project_team_template_checklist_items (
         project_id, item_id, label, required, ordinal,
         source_application_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        item.itemId,
        item.label,
        item.required ? 1 : 0,
        ordinal,
        input.applicationId,
        appliedAt,
      ],
    );
  }
}

async function insertReceipt(
  transaction: TransactionExecutor,
  input: ApplyTeamTemplateAtomicallyInput,
  appliedAt: string,
): Promise<void> {
  await transaction.execute(
    `INSERT INTO team_template_application_receipts (
       application_id, tenant_id, team_id, project_id, template_id,
       template_revision, version_id, version_number, content_digest,
       project_revision_before, project_revision_after,
       cloud_idempotency_key, requested_by_membership_id,
       applied_at, cloud_recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      input.applicationId,
      input.tenantId,
      input.teamId,
      input.projectId,
      input.templateId,
      input.templateRevision,
      input.versionId,
      input.versionNumber,
      input.contentDigest,
      input.expectedProjectRevision,
      input.expectedProjectRevision + 1,
      input.cloudIdempotencyKey,
      input.requestedByMembershipId,
      appliedAt,
    ],
  );
}

async function selectProject(
  executor: TransactionExecutor,
  projectId: string,
): Promise<ProjectRow | null> {
  const rows = await executor.select<ProjectRow>(
    "SELECT revision, status FROM projects WHERE id = ? LIMIT 2",
    [projectId],
  );
  return rows[0] ?? null;
}

async function selectReceiptByApplication(
  executor: TransactionExecutor,
  applicationId: string,
): Promise<ReceiptRow | null> {
  const rows = await executor.select<ReceiptRow>(
    `${RECEIPT_SELECT} WHERE application_id = ? LIMIT 2`,
    [applicationId],
  );
  if (rows.length > 1) {
    throw corrupt("A team-template application ID is not unique.");
  }
  return rows[0] ?? null;
}

async function selectReceiptByVersion(
  executor: TransactionExecutor,
  input: ApplyTeamTemplateAtomicallyInput,
): Promise<ReceiptRow | null> {
  const rows = await executor.select<ReceiptRow>(
    `${RECEIPT_SELECT}
     WHERE tenant_id = ? AND team_id = ? AND project_id = ?
       AND template_id = ? AND version_id = ?
     LIMIT 2`,
    [input.tenantId, input.teamId, input.projectId, input.templateId, input.versionId],
  );
  if (rows.length > 1) {
    throw corrupt("A team-template version is not uniquely applied.");
  }
  return rows[0] ?? null;
}

function validateApplication(
  input: ApplyTeamTemplateAtomicallyInput,
): ApplyTeamTemplateAtomicallyInput {
  const normalized = {
    applicationId: requireUuid(input.applicationId, "applicationId"),
    tenantId: requireUuid(input.tenantId, "tenantId"),
    teamId: requireUuid(input.teamId, "teamId"),
    projectId: requireUuid(input.projectId, "projectId"),
    templateId: requireUuid(input.templateId, "templateId"),
    templateRevision: requireSafeInteger(
      input.templateRevision,
      1,
      Number.MAX_SAFE_INTEGER,
      "templateRevision",
    ),
    versionId: requireUuid(input.versionId, "versionId"),
    versionNumber: requireSafeInteger(
      input.versionNumber,
      1,
      Number.MAX_SAFE_INTEGER,
      "versionNumber",
    ),
    contentDigest: requireDigest(input.contentDigest),
    expectedProjectRevision: requireSafeInteger(
      input.expectedProjectRevision,
      1,
      Number.MAX_SAFE_INTEGER - 1,
      "expectedProjectRevision",
    ),
    cloudIdempotencyKey: requireIdempotency(input.cloudIdempotencyKey),
    requestedByMembershipId: requireUuid(input.requestedByMembershipId, "requestedByMembershipId"),
    payload: validatePayload(input.payload),
  };
  return Object.freeze(normalized);
}

function validatePayload(payload: TeamTemplateApplicationPayload): TeamTemplateApplicationPayload {
  if (
    !isRuntimeArray(payload.projectSettings) ||
    payload.projectSettings.length > 64 ||
    !isRuntimeArray(payload.promptRegistryRefs) ||
    payload.promptRegistryRefs.length > 64 ||
    !isRuntimeArray(payload.promptRules) ||
    payload.promptRules.length > 64 ||
    !isRuntimeArray(payload.reviewChecklist) ||
    payload.reviewChecklist.length > 100
  ) {
    throw invalid("The local team-template payload exceeds a collection bound.");
  }

  const projectSettings = payload.projectSettings.map((setting) => {
    if (!SETTING_KEY_PATTERN.test(setting.key)) {
      throw invalid("A local team-template project setting key is invalid.");
    }
    const value = setting.value;
    if (
      !(
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))
      ) ||
      (typeof value === "string" && value.length > 16 * 1024)
    ) {
      throw invalid("A local team-template project setting value is invalid.");
    }
    return Object.freeze({ key: setting.key, value });
  });
  requireUnique(
    projectSettings.map(({ key }) => key),
    "project setting key",
  );

  const promptRegistryRefs = payload.promptRegistryRefs.map((reference) =>
    Object.freeze({
      registryId: requireUuid(reference.registryId, "registryId"),
      revision: requireSafeInteger(
        reference.revision,
        1,
        Number.MAX_SAFE_INTEGER,
        "registryRevision",
      ),
    }),
  );
  requireUnique(
    promptRegistryRefs.map(({ registryId }) => registryId),
    "prompt registry ID",
  );

  const promptRules = payload.promptRules.map((rule) =>
    Object.freeze({
      ruleId: requireUuid(rule.ruleId, "ruleId"),
      label: requireBoundedText(rule.label, 160, "promptRuleLabel"),
      instruction: requireBoundedText(rule.instruction, 16 * 1024, "promptRuleInstruction"),
    }),
  );
  requireUnique(
    promptRules.map(({ ruleId }) => ruleId),
    "prompt rule ID",
  );

  const reviewChecklist = payload.reviewChecklist.map((item) => {
    if (typeof item.required !== "boolean") {
      throw invalid("A local team-template checklist required flag is invalid.");
    }
    return Object.freeze({
      itemId: requireUuid(item.itemId, "checklistItemId"),
      label: requireBoundedText(item.label, 500, "checklistLabel"),
      required: item.required,
    });
  });
  requireUnique(
    reviewChecklist.map(({ itemId }) => itemId),
    "checklist item ID",
  );

  return Object.freeze({
    projectSettings: Object.freeze(projectSettings),
    promptRegistryRefs: Object.freeze(promptRegistryRefs),
    promptRules: Object.freeze(promptRules),
    reviewChecklist: Object.freeze(reviewChecklist),
  });
}

function validateScope(scope: TeamTemplateApplicationScope): TeamTemplateApplicationScope {
  return Object.freeze({
    tenantId: requireUuid(scope.tenantId, "tenantId"),
    teamId: requireUuid(scope.teamId, "teamId"),
    projectId: requireUuid(scope.projectId, "projectId"),
  });
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function requireExactApplicationReplay(
  row: ReceiptRow,
  input: ApplyTeamTemplateAtomicallyInput,
): void {
  if (
    row.tenant_id !== input.tenantId ||
    row.team_id !== input.teamId ||
    row.project_id !== input.projectId ||
    row.template_id !== input.templateId ||
    row.template_revision !== input.templateRevision ||
    row.version_id !== input.versionId ||
    row.version_number !== input.versionNumber ||
    row.content_digest !== input.contentDigest ||
    row.project_revision_before !== input.expectedProjectRevision ||
    row.cloud_idempotency_key !== input.cloudIdempotencyKey ||
    row.requested_by_membership_id !== input.requestedByMembershipId
  ) {
    throw new TeamTemplateApplicationStoreError(
      "TEAM_TEMPLATE_APPLICATION_IDEMPOTENCY_CONFLICT",
      "The local team-template application ID was reused for different work.",
    );
  }
}

function requireSameAppliedVersion(row: ReceiptRow, input: ApplyTeamTemplateAtomicallyInput): void {
  if (
    row.template_revision !== input.templateRevision ||
    row.version_number !== input.versionNumber ||
    row.content_digest !== input.contentDigest
  ) {
    throw new TeamTemplateApplicationStoreError(
      "TEAM_TEMPLATE_APPLICATION_IDEMPOTENCY_CONFLICT",
      "The already-applied template version does not match the decrypted content.",
    );
  }
}

function requireReceiptScope(row: ReceiptRow, scope: TeamTemplateApplicationScope): void {
  if (
    row.tenant_id !== scope.tenantId ||
    row.team_id !== scope.teamId ||
    row.project_id !== scope.projectId
  ) {
    throw new TeamTemplateApplicationStoreError(
      "TEAM_TEMPLATE_APPLICATION_IDEMPOTENCY_CONFLICT",
      "The local team-template receipt crossed its tenant, team or project scope.",
    );
  }
}

function mapReceipt(
  row: ReceiptRow,
  result: TeamTemplateApplicationReceipt["result"],
): TeamTemplateApplicationReceipt {
  const mapped = {
    applicationId: requireUuid(row.application_id, "applicationId"),
    tenantId: requireUuid(row.tenant_id, "tenantId"),
    teamId: requireUuid(row.team_id, "teamId"),
    projectId: requireUuid(row.project_id, "projectId"),
    templateId: requireUuid(row.template_id, "templateId"),
    templateRevision: requireSafeInteger(
      row.template_revision,
      1,
      Number.MAX_SAFE_INTEGER,
      "templateRevision",
    ),
    versionId: requireUuid(row.version_id, "versionId"),
    versionNumber: requireSafeInteger(
      row.version_number,
      1,
      Number.MAX_SAFE_INTEGER,
      "versionNumber",
    ),
    contentDigest: requireDigest(row.content_digest),
    projectRevisionBefore: requireSafeInteger(
      row.project_revision_before,
      1,
      Number.MAX_SAFE_INTEGER - 1,
      "projectRevisionBefore",
    ),
    projectRevisionAfter: requireSafeInteger(
      row.project_revision_after,
      2,
      Number.MAX_SAFE_INTEGER,
      "projectRevisionAfter",
    ),
    cloudIdempotencyKey: requireIdempotency(row.cloud_idempotency_key),
    requestedByMembershipId: requireUuid(row.requested_by_membership_id, "requestedByMembershipId"),
    appliedAt: requireTimestamp(row.applied_at, "appliedAt"),
    cloudRecordedAt:
      row.cloud_recorded_at === null
        ? null
        : requireTimestamp(row.cloud_recorded_at, "cloudRecordedAt"),
    result,
  };
  if (mapped.projectRevisionAfter !== mapped.projectRevisionBefore + 1) {
    throw corrupt("A persisted team-template application receipt is inconsistent.");
  }
  return Object.freeze(mapped);
}

function requireUuid(value: unknown, label: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(`The local team-template ${label} is invalid.`);
  }
  return parsed.data.toLowerCase();
}

function requireIdempotency(value: unknown): string {
  const parsed = CloudIdempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw invalid("The local team-template cloud idempotency key is invalid.");
  }
  return parsed.data;
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalid("The local team-template content digest is invalid.");
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalid(`The local team-template ${label} is invalid.`);
  }
  return value;
}

function requireBoundedText(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    throw invalid(`The local team-template ${label} is invalid.`);
  }
  return value;
}

function requireSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(`The local team-template ${label} is invalid.`);
  }
  return value;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw invalid(`The local team-template repeats a ${label}.`);
  }
}

function nowIso(clock: Clock): string {
  const value: string = clock.now();
  return requireTimestamp(value, "clock");
}

function invalid(message: string): TeamTemplateApplicationStoreError {
  return new TeamTemplateApplicationStoreError("TEAM_TEMPLATE_APPLICATION_INVALID", message);
}

function corrupt(message: string): TeamTemplateApplicationStoreError {
  return new TeamTemplateApplicationStoreError("TEAM_TEMPLATE_APPLICATION_CORRUPT", message);
}

function revisionConflict(): TeamTemplateApplicationStoreError {
  return new TeamTemplateApplicationStoreError(
    "TEAM_TEMPLATE_APPLICATION_REVISION_CONFLICT",
    "The local project revision changed before the team template was applied.",
    true,
  );
}
