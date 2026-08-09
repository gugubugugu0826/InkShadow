import type { Clock } from "@inkshadow/domain";
import type { SqlExecutor, TransactionExecutor } from "@inkshadow/data";

export type NativeProviderKind = "open_ai_compatible" | "ollama";
export type NativeAuthenticationMode = "none" | "bearer_keyring";

export interface ModelPricingProfile {
  readonly contextWindowTokens: number;
  readonly currency: string;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly cachedInputMicrosPerMillionTokens: number | null;
  readonly pricingVersion: string;
  readonly priceUpdatedAt: string;
}

export interface ModelProfile {
  readonly providerId: string;
  readonly provider: NativeProviderKind;
  readonly baseUrl: string;
  readonly authentication: NativeAuthenticationMode;
  readonly selectedModel: string | null;
  readonly pricing: ModelPricingProfile | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveModelProfileInput {
  readonly providerId: string;
  readonly provider: NativeProviderKind;
  readonly baseUrl: string;
  readonly authentication: NativeAuthenticationMode;
  readonly selectedModel: string | null;
  readonly pricing?: ModelPricingProfile | null;
  readonly expectedRevision: number | null;
}

export interface ModelCenterStore {
  listProfiles(): Promise<readonly ModelProfile[]>;
  findByProviderId(providerId: string): Promise<ModelProfile | null>;
  save(input: SaveModelProfileInput): Promise<ModelProfile>;
}

interface ModelProfileRow {
  provider_id: string;
  provider: string;
  base_url: string;
  authentication: string;
  selected_model: string | null;
  context_window_tokens: number | null;
  currency: string | null;
  input_micros_per_million_tokens: number | null;
  output_micros_per_million_tokens: number | null;
  cached_input_micros_per_million_tokens: number | null;
  pricing_version: string | null;
  price_updated_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export class TauriModelCenterStore implements ModelCenterStore {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: Clock,
  ) {}

  public async listProfiles(): Promise<readonly ModelProfile[]> {
    const rows = await this.executor.select<ModelProfileRow>(
      `${MODEL_PROFILE_SELECT}
       ORDER BY model_profile.updated_at DESC, model_profile.provider_id ASC`,
    );
    return Object.freeze(rows.map(hydrateRow));
  }

  public async findByProviderId(providerIdValue: string): Promise<ModelProfile | null> {
    const providerId = validateProviderId(providerIdValue);
    const rows = await this.executor.select<ModelProfileRow>(
      `${MODEL_PROFILE_SELECT}
       WHERE model_profile.provider_id = ?`,
      [providerId],
    );
    return rows[0] === undefined ? null : hydrateRow(rows[0]);
  }

  public async save(input: SaveModelProfileInput): Promise<ModelProfile> {
    const validated = validateSaveInput(input);
    return this.executor.transaction(async (transaction) => {
      const existingRows = await transaction.select<ModelProfileRow>(
        `${MODEL_PROFILE_SELECT}
         WHERE model_profile.provider_id = ?`,
        [validated.providerId],
      );
      const existing = existingRows[0] === undefined ? null : hydrateRow(existingRows[0]);
      const now = this.clock.now();
      if (existing === null) {
        if (validated.expectedRevision !== null) {
          throw modelProfileConflict(validated.expectedRevision, null);
        }
        const created: ModelProfile = Object.freeze({
          providerId: validated.providerId,
          provider: validated.provider,
          baseUrl: validated.baseUrl,
          authentication: validated.authentication,
          selectedModel: validated.selectedModel,
          pricing: validated.pricing,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        await transaction.execute(
          `INSERT INTO model_profiles (
             provider_id, provider, base_url, authentication, selected_model,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            created.providerId,
            created.provider,
            created.baseUrl,
            created.authentication,
            created.selectedModel,
            created.createdAt,
            created.updatedAt,
          ],
        );
        await persistPricing(transaction, created, now);
        return created;
      }
      if (validated.expectedRevision === null || existing.revision !== validated.expectedRevision) {
        throw modelProfileConflict(validated.expectedRevision, existing.revision);
      }
      const updated: ModelProfile = Object.freeze({
        providerId: validated.providerId,
        provider: validated.provider,
        baseUrl: validated.baseUrl,
        authentication: validated.authentication,
        selectedModel: validated.selectedModel,
        pricing: validated.pricing,
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
      });
      const result = await transaction.execute(
        `UPDATE model_profiles
         SET provider = ?, base_url = ?, authentication = ?, selected_model = ?,
             revision = ?, updated_at = ?
         WHERE provider_id = ? AND revision = ?`,
        [
          updated.provider,
          updated.baseUrl,
          updated.authentication,
          updated.selectedModel,
          updated.revision,
          updated.updatedAt,
          updated.providerId,
          existing.revision,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw modelProfileConflict(existing.revision, null);
      }
      await persistPricing(transaction, updated, now);
      return updated;
    });
  }
}

export const DEVELOPMENT_MODEL_CENTER_KEY = "inkshadow.development.model-center.v1";

interface BrowserModelCenterDatabase {
  readonly schemaVersion: 2;
  readonly profiles: Record<string, ModelProfile>;
}

export class BrowserDevelopmentModelCenterStore implements ModelCenterStore {
  public constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  public listProfiles(): Promise<readonly ModelProfile[]> {
    const profiles = Object.values(this.read().profiles)
      .map(validateProfile)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.providerId.localeCompare(right.providerId),
      );
    return Promise.resolve(Object.freeze(profiles));
  }

  public findByProviderId(providerIdValue: string): Promise<ModelProfile | null> {
    const providerId = validateProviderId(providerIdValue);
    const profile = this.read().profiles[providerId];
    return Promise.resolve(profile === undefined ? null : validateProfile(profile));
  }

  public save(input: SaveModelProfileInput): Promise<ModelProfile> {
    return Promise.resolve().then(() => {
      const validated = validateSaveInput(input);
      const database = this.read();
      const existingSnapshot = database.profiles[validated.providerId];
      const existing = existingSnapshot === undefined ? null : validateProfile(existingSnapshot);
      if (existing === null && validated.expectedRevision !== null) {
        throw modelProfileConflict(validated.expectedRevision, null);
      }
      if (
        existing !== null &&
        (validated.expectedRevision === null || validated.expectedRevision !== existing.revision)
      ) {
        throw modelProfileConflict(validated.expectedRevision, existing.revision);
      }
      const now = this.clock.now();
      const profile: ModelProfile = Object.freeze({
        providerId: validated.providerId,
        provider: validated.provider,
        baseUrl: validated.baseUrl,
        authentication: validated.authentication,
        selectedModel: validated.selectedModel,
        pricing: validated.pricing,
        revision: existing === null ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      database.profiles[profile.providerId] = profile;
      this.storage.setItem(DEVELOPMENT_MODEL_CENTER_KEY, JSON.stringify(database));
      return profile;
    });
  }

  private read(): BrowserModelCenterDatabase {
    const serialized = this.storage.getItem(DEVELOPMENT_MODEL_CENTER_KEY);
    if (serialized === null) {
      return { schemaVersion: 2, profiles: {} };
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      const migrated = migrateBrowserDatabase(parsed);
      if (!isObject(migrated) || migrated.schemaVersion !== 2 || !isObject(migrated.profiles)) {
        throw modelCenterError(
          "MODEL_PROFILE_STORE_CORRUPT",
          "Stored model profiles failed integrity validation.",
        );
      }
      const database = migrated as unknown as BrowserModelCenterDatabase;
      for (const [providerId, profile] of Object.entries(database.profiles)) {
        if (validateProfile(profile).providerId !== providerId) {
          throw modelCenterError(
            "MODEL_PROFILE_STORE_CORRUPT",
            "Stored model profile key does not match its payload.",
          );
        }
      }
      return structuredClone(database);
    } catch (cause: unknown) {
      throw cause instanceof ModelCenterError
        ? cause
        : modelCenterError("MODEL_PROFILE_STORE_CORRUPT", "Unable to read stored model profiles.");
    }
  }
}

/**
 * Redacted transport facts that are safe to persist in diagnostics.  This
 * deliberately cannot carry request bodies, prompts, credentials or model
 * output.
 */
export interface ModelCenterFailureDiagnostics {
  readonly requestId: string | null;
  readonly httpStatus: number | null;
  readonly finishReason: string | null;
  readonly visibleContentLength: number | null;
  readonly reasoningPresent: boolean | null;
  readonly stream: boolean | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export class ModelCenterError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly diagnostics: ModelCenterFailureDiagnostics | null;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    diagnostics: ModelCenterFailureDiagnostics | null = null,
  ) {
    super(message);
    this.name = "ModelCenterError";
    this.code = code;
    this.retryable = retryable;
    this.diagnostics = diagnostics === null ? null : Object.freeze({ ...diagnostics });
  }
}

function validateSaveInput(input: SaveModelProfileInput): Omit<
  ModelProfile,
  "revision" | "createdAt" | "updatedAt"
> & {
  readonly expectedRevision: number | null;
} {
  if (
    !isNativeProviderKind(input.provider) ||
    !isNativeAuthenticationMode(input.authentication) ||
    (input.expectedRevision !== null &&
      (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))
  ) {
    throw modelCenterError(
      "MODEL_PROFILE_INVALID",
      "Model profile provider, authentication, or revision is invalid.",
    );
  }
  const selectedModel = validateSelectedModel(input.selectedModel);
  const pricing = validatePricingProfile(input.pricing ?? null);
  if (selectedModel === null && pricing !== null) {
    throw modelCenterError("MODEL_PRICING_INVALID", "Pricing metadata requires a selected model.");
  }
  return Object.freeze({
    providerId: validateProviderId(input.providerId),
    provider: input.provider,
    baseUrl: validateBaseUrl(input.baseUrl),
    authentication: input.authentication,
    selectedModel,
    pricing,
    expectedRevision: input.expectedRevision,
  });
}

function isNativeProviderKind(value: unknown): value is NativeProviderKind {
  return value === "open_ai_compatible" || value === "ollama";
}

function isNativeAuthenticationMode(value: unknown): value is NativeAuthenticationMode {
  return value === "none" || value === "bearer_keyring";
}

function validateProfile(profile: ModelProfile): ModelProfile {
  const input = validateSaveInput({
    providerId: profile.providerId,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    authentication: profile.authentication,
    selectedModel: profile.selectedModel,
    pricing: profile.pricing,
    expectedRevision: profile.revision,
  });
  if (
    !Number.isSafeInteger(profile.revision) ||
    profile.revision < 1 ||
    !isIsoTimestamp(profile.createdAt) ||
    !isIsoTimestamp(profile.updatedAt) ||
    profile.updatedAt < profile.createdAt
  ) {
    throw modelCenterError(
      "MODEL_PROFILE_STORE_CORRUPT",
      "Stored model profile metadata is invalid.",
    );
  }
  return Object.freeze({
    providerId: input.providerId,
    provider: input.provider,
    baseUrl: input.baseUrl,
    authentication: input.authentication,
    selectedModel: input.selectedModel,
    pricing: input.pricing,
    revision: profile.revision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

function hydrateRow(row: ModelProfileRow): ModelProfile {
  return validateProfile({
    providerId: row.provider_id,
    provider: row.provider as NativeProviderKind,
    baseUrl: row.base_url,
    authentication: row.authentication as NativeAuthenticationMode,
    selectedModel: row.selected_model,
    pricing: hydratePricingRow(row),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function validateProviderId(value: string): string {
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(value)) {
    throw modelCenterError(
      "MODEL_PROFILE_INVALID",
      "Provider identifier must use lowercase letters, digits, dots, underscores, or hyphens.",
    );
  }
  return value;
}

function validateSelectedModel(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw modelCenterError("MODEL_PROFILE_INVALID", "Selected model identifier is invalid.");
  }
  return value;
}

function validatePricingProfile(value: ModelPricingProfile | null): ModelPricingProfile | null {
  if (value === null) {
    return null;
  }
  if (
    !Number.isSafeInteger(value.contextWindowTokens) ||
    value.contextWindowTokens < 1 ||
    value.contextWindowTokens > 100_000_000 ||
    !isSafeMicros(value.inputMicrosPerMillionTokens) ||
    !isSafeMicros(value.outputMicrosPerMillionTokens) ||
    (value.cachedInputMicrosPerMillionTokens !== null &&
      !isSafeMicros(value.cachedInputMicrosPerMillionTokens)) ||
    !/^[A-Z]{3}$/u.test(value.currency) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(value.pricingVersion) ||
    !isIsoTimestamp(value.priceUpdatedAt)
  ) {
    throw modelCenterError(
      "MODEL_PRICING_INVALID",
      "Model pricing and context metadata is invalid.",
    );
  }
  return Object.freeze({ ...value });
}

function isSafeMicros(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9_000_000_000_000_000;
}

function hydratePricingRow(row: ModelProfileRow): ModelPricingProfile | null {
  const {
    context_window_tokens: contextWindowTokens,
    currency,
    input_micros_per_million_tokens: inputMicrosPerMillionTokens,
    output_micros_per_million_tokens: outputMicrosPerMillionTokens,
    pricing_version: pricingVersion,
    price_updated_at: priceUpdatedAt,
  } = row;
  const values = [
    contextWindowTokens,
    currency,
    inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens,
    pricingVersion,
    priceUpdatedAt,
  ];
  if (values.every((value) => value === null)) {
    return null;
  }
  if (
    contextWindowTokens === null ||
    currency === null ||
    inputMicrosPerMillionTokens === null ||
    outputMicrosPerMillionTokens === null ||
    pricingVersion === null ||
    priceUpdatedAt === null
  ) {
    throw modelCenterError(
      "MODEL_PROFILE_STORE_CORRUPT",
      "Stored model pricing metadata is incomplete.",
    );
  }
  return validatePricingProfile({
    contextWindowTokens,
    currency,
    inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens,
    cachedInputMicrosPerMillionTokens: row.cached_input_micros_per_million_tokens,
    pricingVersion,
    priceUpdatedAt,
  });
}

async function persistPricing(
  executor: TransactionExecutor,
  profile: ModelProfile,
  now: string,
): Promise<void> {
  if (profile.selectedModel === null) {
    return;
  }
  if (profile.pricing === null) {
    await executor.execute(
      `DELETE FROM model_pricing_profiles
       WHERE provider_id = ? AND model_id = ?`,
      [profile.providerId, profile.selectedModel],
    );
    return;
  }
  const pricing = profile.pricing;
  await executor.execute(
    `INSERT INTO model_pricing_profiles (
       provider_id, model_id, context_window_tokens, currency,
       input_micros_per_million_tokens, output_micros_per_million_tokens,
       cached_input_micros_per_million_tokens, pricing_version,
       price_updated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       context_window_tokens = excluded.context_window_tokens,
       currency = excluded.currency,
       input_micros_per_million_tokens = excluded.input_micros_per_million_tokens,
       output_micros_per_million_tokens = excluded.output_micros_per_million_tokens,
       cached_input_micros_per_million_tokens =
         excluded.cached_input_micros_per_million_tokens,
       pricing_version = excluded.pricing_version,
       price_updated_at = excluded.price_updated_at,
       updated_at = excluded.updated_at`,
    [
      profile.providerId,
      profile.selectedModel,
      pricing.contextWindowTokens,
      pricing.currency,
      pricing.inputMicrosPerMillionTokens,
      pricing.outputMicrosPerMillionTokens,
      pricing.cachedInputMicrosPerMillionTokens,
      pricing.pricingVersion,
      pricing.priceUpdatedAt,
      now,
      now,
    ],
  );
}

function validateBaseUrl(value: string): string {
  if (
    value.length < 1 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    value.includes("%") ||
    value.includes("\\") ||
    value.includes("/../") ||
    value.includes("/./") ||
    value.endsWith("/..") ||
    value.endsWith("/.")
  ) {
    throw modelCenterError(
      "MODEL_ENDPOINT_INVALID",
      "Model endpoint does not satisfy the network safety policy.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw modelCenterError("MODEL_ENDPOINT_INVALID", "Model endpoint must be an absolute URL.");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.port === "0"
  ) {
    throw modelCenterError(
      "MODEL_ENDPOINT_INVALID",
      "Remote model endpoints require HTTPS; HTTP is restricted to loopback hosts.",
    );
  }
  return value.endsWith("/") && url.pathname !== "/" ? value.slice(0, -1) : value;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/u.test(octet) &&
        Number.parseInt(octet, 10) >= 0 &&
        Number.parseInt(octet, 10) <= 255,
    )
  );
}

function isIsoTimestamp(value: string): boolean {
  return value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function modelProfileConflict(
  expectedRevision: number | null,
  actualRevision: number | null,
): ModelCenterError {
  return modelCenterError(
    "MODEL_PROFILE_REVISION_CONFLICT",
    `Model profile changed before it could be saved (expected ${String(expectedRevision)}, actual ${String(actualRevision)}).`,
    true,
  );
}

function modelCenterError(code: string, message: string, retryable = false): ModelCenterError {
  return new ModelCenterError(code, message, retryable);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateBrowserDatabase(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.profiles)) {
    return value;
  }
  if (value.schemaVersion === 2) {
    return value;
  }
  if (value.schemaVersion !== 1) {
    return value;
  }
  const profiles: Record<string, unknown> = {};
  for (const [providerId, profile] of Object.entries(value.profiles)) {
    profiles[providerId] = isObject(profile) ? { ...profile, pricing: null } : profile;
  }
  return { schemaVersion: 2, profiles };
}

const MODEL_PROFILE_SELECT = `SELECT
  model_profile.provider_id,
  model_profile.provider,
  model_profile.base_url,
  model_profile.authentication,
  model_profile.selected_model,
  model_pricing.context_window_tokens,
  model_pricing.currency,
  model_pricing.input_micros_per_million_tokens,
  model_pricing.output_micros_per_million_tokens,
  model_pricing.cached_input_micros_per_million_tokens,
  model_pricing.pricing_version,
  model_pricing.price_updated_at,
  model_profile.revision,
  model_profile.created_at,
  model_profile.updated_at
FROM model_profiles AS model_profile
LEFT JOIN model_pricing_profiles AS model_pricing
  ON model_pricing.provider_id = model_profile.provider_id
 AND model_pricing.model_id = model_profile.selected_model`;
