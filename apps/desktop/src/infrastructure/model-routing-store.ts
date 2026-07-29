import { isModelRouteRole, type ModelRouteRole } from "@inkshadow/ai-core";
import type { SqlExecutor } from "@inkshadow/data";
import type { Clock } from "@inkshadow/domain";

import type { ModelCenterStore, ModelProfile } from "./model-center-store";

export const DEVELOPMENT_MODEL_ROUTING_KEY = "inkshadow.development.model-routing.v1";

export interface ModelRoleRoute {
  readonly role: ModelRouteRole;
  readonly primaryProviderId: string;
  readonly primaryModelId: string;
  readonly fallbackProviderId: string | null;
  readonly fallbackModelId: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveModelRoleRouteInput {
  readonly role: ModelRouteRole;
  readonly primaryProviderId: string;
  readonly fallbackProviderId: string | null;
  readonly expectedRevision: number | null;
}

export interface ModelRoutingStore {
  listRoutes(): Promise<readonly ModelRoleRoute[]>;
  findRoute(role: ModelRouteRole): Promise<ModelRoleRoute | null>;
  saveRoute(input: SaveModelRoleRouteInput): Promise<ModelRoleRoute>;
}

interface ModelRoleRouteRow {
  role: string;
  primary_provider_id: string;
  primary_model_id: string;
  fallback_provider_id: string | null;
  fallback_model_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SelectedModelRow {
  provider_id: string;
  selected_model: string | null;
}

export class TauriModelRoutingStore implements ModelRoutingStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public async listRoutes(): Promise<readonly ModelRoleRoute[]> {
    const rows = await this.executor.select<ModelRoleRouteRow>(
      `${MODEL_ROUTE_SELECT} ORDER BY role ASC`,
    );
    return Object.freeze(rows.map(hydrateRoute));
  }

  public async findRoute(roleValue: ModelRouteRole): Promise<ModelRoleRoute | null> {
    const role = validateRole(roleValue);
    const rows = await this.executor.select<ModelRoleRouteRow>(
      `${MODEL_ROUTE_SELECT} WHERE role = ?`,
      [role],
    );
    return rows[0] === undefined ? null : hydrateRoute(rows[0]);
  }

  public async saveRoute(input: SaveModelRoleRouteInput): Promise<ModelRoleRoute> {
    const validated = validateSaveInput(input);
    return this.executor.transaction(async (transaction) => {
      const providerIds = [
        validated.primaryProviderId,
        ...(validated.fallbackProviderId === null ? [] : [validated.fallbackProviderId]),
      ];
      const profileRows = await transaction.select<SelectedModelRow>(
        `SELECT provider_id, selected_model
         FROM model_profiles
         WHERE provider_id IN (${providerIds.map(() => "?").join(", ")})`,
        providerIds,
      );
      const primary = requireSelectedModel(profileRows, validated.primaryProviderId);
      const fallback =
        validated.fallbackProviderId === null
          ? null
          : requireSelectedModel(profileRows, validated.fallbackProviderId);
      const existingRows = await transaction.select<ModelRoleRouteRow>(
        `${MODEL_ROUTE_SELECT} WHERE role = ?`,
        [validated.role],
      );
      const existing = existingRows[0] === undefined ? null : hydrateRoute(existingRows[0]);
      assertExpectedRevision(existing, validated.expectedRevision);
      const now = this.clock.now();
      const route = validateRoute({
        role: validated.role,
        primaryProviderId: validated.primaryProviderId,
        primaryModelId: primary,
        fallbackProviderId: validated.fallbackProviderId,
        fallbackModelId: fallback,
        revision: existing === null ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      if (existing === null) {
        await transaction.execute(
          `INSERT INTO model_role_routes (
             role, primary_provider_id, primary_model_id,
             fallback_provider_id, fallback_model_id,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            route.role,
            route.primaryProviderId,
            route.primaryModelId,
            route.fallbackProviderId,
            route.fallbackModelId,
            route.createdAt,
            route.updatedAt,
          ],
        );
      } else {
        const result = await transaction.execute(
          `UPDATE model_role_routes
           SET primary_provider_id = ?, primary_model_id = ?,
               fallback_provider_id = ?, fallback_model_id = ?,
               revision = ?, updated_at = ?
           WHERE role = ? AND revision = ?`,
          [
            route.primaryProviderId,
            route.primaryModelId,
            route.fallbackProviderId,
            route.fallbackModelId,
            route.revision,
            route.updatedAt,
            route.role,
            existing.revision,
          ],
        );
        if (result.rowsAffected !== 1) {
          throw routingConflict();
        }
      }
      return route;
    });
  }
}

interface BrowserModelRoutingDatabase {
  readonly schemaVersion: 1;
  routes: Record<string, ModelRoleRoute>;
}

export class BrowserDevelopmentModelRoutingStore implements ModelRoutingStore {
  public constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
    private readonly modelCenter: ModelCenterStore,
  ) {}

  public listRoutes(): Promise<readonly ModelRoleRoute[]> {
    return Promise.resolve().then(() =>
      Object.freeze(
        Object.values(this.read().routes)
          .map(validateRoute)
          .sort((left, right) => left.role.localeCompare(right.role)),
      ),
    );
  }

  public findRoute(roleValue: ModelRouteRole): Promise<ModelRoleRoute | null> {
    return Promise.resolve().then(() => {
      const role = validateRole(roleValue);
      const route = this.read().routes[role];
      return route === undefined ? null : validateRoute(route);
    });
  }

  public async saveRoute(input: SaveModelRoleRouteInput): Promise<ModelRoleRoute> {
    const validated = validateSaveInput(input);
    const [primaryProfile, fallbackProfile] = await Promise.all([
      this.modelCenter.findByProviderId(validated.primaryProviderId),
      validated.fallbackProviderId === null
        ? Promise.resolve(null)
        : this.modelCenter.findByProviderId(validated.fallbackProviderId),
    ]);
    const primaryModel = requireProfileModel(primaryProfile, validated.primaryProviderId);
    const fallbackModel =
      validated.fallbackProviderId === null
        ? null
        : requireProfileModel(fallbackProfile, validated.fallbackProviderId);
    const database = this.read();
    const existingSnapshot = database.routes[validated.role];
    const existing = existingSnapshot === undefined ? null : validateRoute(existingSnapshot);
    assertExpectedRevision(existing, validated.expectedRevision);
    const now = this.clock.now();
    const route = validateRoute({
      role: validated.role,
      primaryProviderId: validated.primaryProviderId,
      primaryModelId: primaryModel,
      fallbackProviderId: validated.fallbackProviderId,
      fallbackModelId: fallbackModel,
      revision: existing === null ? 1 : existing.revision + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    database.routes[route.role] = route;
    this.storage.setItem(DEVELOPMENT_MODEL_ROUTING_KEY, JSON.stringify(database));
    return route;
  }

  private read(): BrowserModelRoutingDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_MODEL_ROUTING_KEY);
    if (serialized === null) {
      return { schemaVersion: 1, routes: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isObject(parsed) ||
        parsed.schemaVersion !== 1 ||
        !isObject(parsed.routes) ||
        containsProhibitedRoutingKey(parsed)
      ) {
        throw new Error("Invalid model routing store shape.");
      }
      const database = structuredClone(parsed) as unknown as BrowserModelRoutingDatabase;
      for (const [role, route] of Object.entries(database.routes)) {
        if (validateRoute(route).role !== role) {
          throw new Error("Stored model route key does not match its payload.");
        }
      }
      return database;
    } catch (cause: unknown) {
      throw cause instanceof ModelRoutingStoreError
        ? cause
        : routingError(
            "MODEL_ROUTING_STORE_CORRUPT",
            "Stored model role routes failed integrity validation.",
          );
    }
  }
}

export class ModelRoutingStoreError extends Error {
  public constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ModelRoutingStoreError";
  }
}

function validateSaveInput(input: SaveModelRoleRouteInput): SaveModelRoleRouteInput {
  const role = validateRole(input.role);
  const primaryProviderId = validateProviderId(input.primaryProviderId);
  const fallbackProviderId =
    input.fallbackProviderId === null ? null : validateProviderId(input.fallbackProviderId);
  if (
    fallbackProviderId === primaryProviderId ||
    (input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))
  ) {
    throw routingError(
      "MODEL_ROUTING_INVALID",
      "Fallback provider or expected revision is invalid.",
    );
  }
  return Object.freeze({
    role,
    primaryProviderId,
    fallbackProviderId,
    expectedRevision: input.expectedRevision,
  });
}

function validateRoute(route: ModelRoleRoute): ModelRoleRoute {
  if (
    !Number.isSafeInteger(route.revision) ||
    route.revision < 1 ||
    !isIsoTimestamp(route.createdAt) ||
    !isIsoTimestamp(route.updatedAt) ||
    route.updatedAt < route.createdAt ||
    (route.fallbackProviderId === null) !== (route.fallbackModelId === null)
  ) {
    throw routingError("MODEL_ROUTING_STORE_CORRUPT", "Stored model role route is invalid.");
  }
  const primaryProviderId = validateProviderId(route.primaryProviderId);
  const primaryModelId = validateModelId(route.primaryModelId);
  const fallbackProviderId =
    route.fallbackProviderId === null ? null : validateProviderId(route.fallbackProviderId);
  const fallbackModelId =
    route.fallbackModelId === null ? null : validateModelId(route.fallbackModelId);
  if (fallbackProviderId === primaryProviderId && fallbackModelId === primaryModelId) {
    throw routingError("MODEL_ROUTING_STORE_CORRUPT", "Stored fallback duplicates the primary.");
  }
  return Object.freeze({
    role: validateRole(route.role),
    primaryProviderId,
    primaryModelId,
    fallbackProviderId,
    fallbackModelId,
    revision: route.revision,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  });
}

function hydrateRoute(row: ModelRoleRouteRow): ModelRoleRoute {
  return validateRoute({
    role: row.role as ModelRouteRole,
    primaryProviderId: row.primary_provider_id,
    primaryModelId: row.primary_model_id,
    fallbackProviderId: row.fallback_provider_id,
    fallbackModelId: row.fallback_model_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function requireSelectedModel(rows: readonly SelectedModelRow[], providerId: string): string {
  const row = rows.find((candidate) => candidate.provider_id === providerId);
  if (row?.selected_model === null || row?.selected_model === undefined) {
    throw routingError(
      "MODEL_ROUTING_PROFILE_NOT_READY",
      "Every route target must reference a saved profile with a selected model.",
    );
  }
  return validateModelId(row.selected_model);
}

function requireProfileModel(profile: ModelProfile | null, providerId: string): string {
  if (profile?.providerId !== providerId || profile.selectedModel === null) {
    throw routingError(
      "MODEL_ROUTING_PROFILE_NOT_READY",
      "Every route target must reference a saved profile with a selected model.",
    );
  }
  return validateModelId(profile.selectedModel);
}

function assertExpectedRevision(
  existing: ModelRoleRoute | null,
  expectedRevision: number | null,
): void {
  if (
    (existing === null && expectedRevision !== null) ||
    (existing !== null && (expectedRevision === null || existing.revision !== expectedRevision))
  ) {
    throw routingConflict();
  }
}

function validateRole(value: unknown): ModelRouteRole {
  if (!isModelRouteRole(value)) {
    throw routingError("MODEL_ROUTING_INVALID", "Model route role is invalid.");
  }
  return value;
}

function validateProviderId(value: string): string {
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(value)) {
    throw routingError("MODEL_ROUTING_INVALID", "Model route provider identifier is invalid.");
  }
  return value;
}

function validateModelId(value: string): string {
  if (
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw routingError("MODEL_ROUTING_INVALID", "Model route model identifier is invalid.");
  }
  return value;
}

function isIsoTimestamp(value: string): boolean {
  return value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function routingConflict(): ModelRoutingStoreError {
  return routingError(
    "MODEL_ROUTING_REVISION_CONFLICT",
    "The model role route changed before it could be saved.",
    true,
  );
}

function routingError(code: string, message: string, retryable = false): ModelRoutingStoreError {
  return new ModelRoutingStoreError(code, message, retryable);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsProhibitedRoutingKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsProhibitedRoutingKey);
  }
  if (!isObject(value)) {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/^(content|prompt|messages|secret|credential|api[_-]?key)$/iu.test(key)) {
      return true;
    }
    if (containsProhibitedRoutingKey(nested)) {
      return true;
    }
  }
  return false;
}

const MODEL_ROUTE_SELECT = `SELECT
  role,
  primary_provider_id,
  primary_model_id,
  fallback_provider_id,
  fallback_model_id,
  revision,
  created_at,
  updated_at
FROM model_role_routes`;
