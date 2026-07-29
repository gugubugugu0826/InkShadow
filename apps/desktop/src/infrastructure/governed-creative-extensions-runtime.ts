import {
  parseCreativeExtensionCandidate,
  serializeCreativeExtensionCandidate,
  type CreativeExtensionCandidatePayload,
} from "@inkshadow/ai-core";
import {
  calculateMaximumCostMicros,
  computeGovernedExtensionRequestFingerprint,
  inspectGovernedExtensionProviderUrl,
  type AcceptGovernedExtensionCandidateResult,
  type GovernedCreativeExtensionSqliteStore,
  type GovernedExtensionCandidate,
  type GovernedExtensionConsentScope,
  type GovernedExtensionKind,
  type GovernedExtensionRequest,
  type GovernedExtensionRequestSnapshot,
  type IssuedGovernedExtensionConsent,
  type ProviderReportedExtensionUsage,
  type ShortDramaRequestSettings,
  type TranslationRequestSettings,
} from "@inkshadow/data";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";

export interface GovernedCreativeExtensionFlags {
  readonly translation: boolean;
  readonly shortDrama: boolean;
}

export const DEFAULT_GOVERNED_CREATIVE_EXTENSION_FLAGS: GovernedCreativeExtensionFlags =
  Object.freeze({
    translation: false,
    shortDrama: false,
  });

export interface GovernedCreativeExtensionSource {
  readonly projectId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceChecksum: string;
  readonly chapterTitle: string;
  readonly sourceText: string;
}

export interface GovernedCreativeExtensionRoute {
  readonly location: "loopback" | "remote";
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  /** Immutable application pricing snapshot, not a provider invoice. */
  readonly pricing: {
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
    readonly currency: string;
    readonly priceVersion: string;
    readonly priceUpdatedAt: string;
  };
  readonly limits: {
    readonly maximumInputTokens: number;
    readonly maximumOutputTokens: number;
    readonly timeoutMs: number;
  };
}

export interface GovernedCreativeExtensionEnvironment {
  readonly online: boolean;
  readonly readOnly: boolean;
}

export interface TranslationExtensionDraft {
  readonly kind: "translation";
  readonly source: GovernedCreativeExtensionSource;
  readonly settings: TranslationRequestSettings;
}

export interface ShortDramaExtensionDraft {
  readonly kind: "short_drama";
  readonly source: GovernedCreativeExtensionSource;
  readonly settings: ShortDramaRequestSettings;
}

export type GovernedCreativeExtensionDraft = TranslationExtensionDraft | ShortDramaExtensionDraft;

export type GovernedExtensionPreflightCheckLevel = "blocking" | "action" | "notice";

export interface GovernedExtensionPreflightCheck {
  readonly code: string;
  readonly level: GovernedExtensionPreflightCheckLevel;
  readonly title: string;
  readonly detail: string;
}

export interface GovernedExtensionParagraphAuthority {
  readonly index: number;
  readonly text: string;
  readonly checksum: string;
}

export interface GovernedCreativeExtensionPreflight {
  readonly snapshot: GovernedExtensionRequestSnapshot;
  readonly requestFingerprint: string;
  readonly paragraphAuthorities: readonly GovernedExtensionParagraphAuthority[];
  readonly checks: readonly GovernedExtensionPreflightCheck[];
  readonly ready: boolean;
  readonly requiresRemoteConsent: boolean;
  readonly destination: {
    readonly location: "loopback" | "remote";
    readonly providerId: string;
    readonly baseUrl: string;
    readonly modelId: string;
    readonly dataCategories: readonly string[];
  };
  readonly estimate: {
    readonly estimatedInputTokens: number;
    readonly estimatedOutputTokens: number;
    readonly estimatedCostMicros: number;
    readonly maximumCostMicros: number;
    readonly currency: string;
    readonly semantics: "internal_estimate";
  };
  readonly retry: {
    readonly previousRequestId: string;
    readonly attempt: number;
  } | null;
}

export interface GovernedExtensionGatewayRequest {
  readonly snapshot: GovernedExtensionRequestSnapshot;
  readonly requestFingerprint: string;
  readonly paragraphAuthorities: readonly GovernedExtensionParagraphAuthority[];
  readonly rangeChecksumAlgorithm: "sha256-utf8-double-newline-v1";
}

export interface GovernedExtensionGatewayResult {
  readonly serializedCandidate: string;
  /**
   * Providers must report both token counts. Optionality exists so the runtime
   * can persist a fail-closed terminal outcome for non-conforming gateways.
   */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number | null;
    readonly providerReceipt?: string | null;
  };
}

export interface GovernedCreativeExtensionGateway {
  generate(
    request: GovernedExtensionGatewayRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<GovernedExtensionGatewayResult>;
}

export class GovernedCreativeExtensionGatewayError extends Error {
  public constructor(
    message: string,
    readonly retryable = true,
    readonly usage?: ProviderReportedExtensionUsage,
  ) {
    super(message);
    this.name = "GovernedCreativeExtensionGatewayError";
  }
}

export type GovernedCreativeExtensionRuntimeErrorCode =
  | "EXTENSION_FEATURE_DISABLED"
  | "EXTENSION_READ_ONLY"
  | "EXTENSION_ROUTE_MISSING"
  | "EXTENSION_REMOTE_OFFLINE"
  | "EXTENSION_PREFLIGHT_BLOCKED"
  | "EXTENSION_CONSENT_REQUIRED"
  | "EXTENSION_PROVIDER_TIMEOUT"
  | "EXTENSION_PROVIDER_FAILED"
  | "EXTENSION_USAGE_UNAVAILABLE"
  | "EXTENSION_RESPONSE_AUTHORITY_MISMATCH"
  | "EXTENSION_RETRY_NOT_ALLOWED"
  | "EXTENSION_NOT_FOUND";

export class GovernedCreativeExtensionRuntimeError extends Error {
  public constructor(
    readonly code: GovernedCreativeExtensionRuntimeErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GovernedCreativeExtensionRuntimeError";
  }
}

export interface GovernedExtensionRunResult {
  readonly request: GovernedExtensionRequest;
  readonly candidate: GovernedExtensionCandidate | null;
  readonly replayed: boolean;
}

export interface GovernedExtensionHistory {
  readonly requests: readonly GovernedExtensionRequest[];
  readonly candidates: readonly GovernedExtensionCandidate[];
}

type GovernedExtensionStorePort = Pick<
  GovernedCreativeExtensionSqliteStore,
  | "acceptCandidate"
  | "cancelRequest"
  | "completeRequest"
  | "expireCandidate"
  | "failRequest"
  | "getCandidate"
  | "getRequest"
  | "issueRemoteConsent"
  | "listCandidates"
  | "listRequests"
  | "recoverOrphanedReservations"
  | "rejectCandidate"
  | "startRequest"
>;

interface RuntimeDependencies {
  readonly store: GovernedExtensionStorePort;
  readonly gateway: GovernedCreativeExtensionGateway;
  readonly ids: UuidV7Generator;
  readonly clock: Clock;
  readonly resolveRoute: (
    kind: GovernedExtensionKind,
  ) => GovernedCreativeExtensionRoute | null | Promise<GovernedCreativeExtensionRoute | null>;
  readonly readEnvironment: () => GovernedCreativeExtensionEnvironment;
  readonly isSourceReadOnly?: (projectId: string, chapterId: string) => Promise<boolean>;
  readonly readFeatureFlags?: () => GovernedCreativeExtensionFlags;
}

interface ActiveGeneration {
  readonly controller: AbortController;
  cancelRequested: boolean;
}

export class GovernedCreativeExtensionsRuntime {
  private readonly active = new Map<string, ActiveGeneration>();

  public constructor(private readonly dependencies: RuntimeDependencies) {}

  public getCapabilities(): {
    readonly flags: GovernedCreativeExtensionFlags;
    readonly environment: GovernedCreativeExtensionEnvironment;
  } {
    return Object.freeze({
      flags: this.readFlags(),
      environment: this.dependencies.readEnvironment(),
    });
  }

  public async preflight(
    draft: GovernedCreativeExtensionDraft,
  ): Promise<GovernedCreativeExtensionPreflight> {
    const route = await this.dependencies.resolveRoute(draft.kind);
    return this.buildPreflight(draft, route, null);
  }

  /**
   * This is the only method that issues remote consent. It is intentionally
   * separate from run(), so a visible user confirmation must invoke it.
   * The returned plaintext token remains in caller memory and is never stored.
   */
  public async confirmRemoteEgress(
    preflight: GovernedCreativeExtensionPreflight,
    ttlMs = 60_000,
  ): Promise<IssuedGovernedExtensionConsent> {
    await this.assertCurrentExecutionAllowed(preflight);
    if (!preflight.ready) {
      throw runtimeError(
        "EXTENSION_PREFLIGHT_BLOCKED",
        "Resolve the blocking preflight checks before confirming data egress.",
      );
    }
    if (!preflight.requiresRemoteConsent) {
      throw runtimeError(
        "EXTENSION_PREFLIGHT_BLOCKED",
        "Loopback execution does not create a remote-egress consent receipt.",
      );
    }
    await this.assertFingerprint(preflight);
    return this.dependencies.store.issueRemoteConsent(consentScope(preflight), {
      auditEventId: this.dependencies.ids.next(),
      correlationId: this.dependencies.ids.next(),
      ttlMs,
    });
  }

  public async run(
    preflight: GovernedCreativeExtensionPreflight,
    options: {
      readonly consentToken?: string;
      readonly onRequestStarted?: (request: GovernedExtensionRequest) => void;
    } = {},
  ): Promise<GovernedExtensionRunResult> {
    await this.assertCurrentExecutionAllowed(preflight);
    if (!preflight.ready) {
      throw runtimeError(
        "EXTENSION_PREFLIGHT_BLOCKED",
        "Resolve the blocking preflight checks before starting provider execution.",
      );
    }
    if (preflight.requiresRemoteConsent && options.consentToken === undefined) {
      throw runtimeError(
        "EXTENSION_CONSENT_REQUIRED",
        "Remote execution requires a fresh, exact-purpose, one-time confirmation.",
      );
    }
    await this.assertFingerprint(preflight);

    const requestId = this.dependencies.ids.next();
    const correlationId = this.dependencies.ids.next();
    const start = await this.dependencies.store.startRequest({
      id: requestId,
      idempotencyKey: this.dependencies.ids.next(),
      requestFingerprint: preflight.requestFingerprint,
      snapshot: preflight.snapshot,
      reservedCostMicros: preflight.estimate.maximumCostMicros,
      monthKey: this.dependencies.clock.now().slice(0, 7),
      ...(options.consentToken === undefined ? {} : { consentToken: options.consentToken }),
      ...(preflight.retry === null
        ? {}
        : {
            retryOfRequestId: preflight.retry.previousRequestId,
            attempt: preflight.retry.attempt,
          }),
      auditEventId: this.dependencies.ids.next(),
      correlationId,
    });

    if (!start.created) {
      return this.hydrateRunResult(start.request, true);
    }

    const controller = new AbortController();
    this.active.set(start.request.id, {
      controller,
      cancelRequested: false,
    });
    try {
      options.onRequestStarted?.(start.request);
    } catch {
      // UI observers cannot interrupt the persisted execution lifecycle.
    }
    let gatewayResult: GovernedExtensionGatewayResult | undefined;
    try {
      if (isAbortRequested(controller.signal)) {
        const cancelled = await this.cancel(start.request.id);
        return await this.hydrateRunResult(cancelled, false);
      }
      gatewayResult = await invokeWithTimeout(
        this.dependencies.gateway,
        {
          snapshot: preflight.snapshot,
          requestFingerprint: preflight.requestFingerprint,
          paragraphAuthorities: preflight.paragraphAuthorities,
          rangeChecksumAlgorithm: "sha256-utf8-double-newline-v1",
        },
        controller,
        preflight.snapshot.limits.timeoutMs,
      );
      if (isAbortRequested(controller.signal)) {
        const cancelled = await this.cancel(start.request.id);
        return await this.hydrateRunResult(cancelled, false);
      }
      if (gatewayResult.usage === undefined) {
        await this.failIfRunning(start.request.id, {
          outcome: "failed_final",
          errorCode: "EXTENSION_USAGE_UNAVAILABLE",
          correlationId,
        });
        throw runtimeError(
          "EXTENSION_USAGE_UNAVAILABLE",
          "The provider did not report input and output tokens; the attempt was closed without a candidate.",
        );
      }

      const usage = normalizeUsage(gatewayResult.usage);
      const parsed = parseCreativeExtensionCandidate(gatewayResult.serializedCandidate);
      await assertCandidateAuthority(parsed, preflight);
      const payloadJson = serializeCreativeExtensionCandidate(parsed);
      const payloadChecksum = await sha256Hex(payloadJson);

      try {
        const completed = await this.dependencies.store.completeRequest({
          requestId: start.request.id,
          expectedRevision: start.request.revision,
          candidateId: this.dependencies.ids.next(),
          payloadJson,
          payloadChecksum,
          usage,
          auditEventId: this.dependencies.ids.next(),
          correlationId,
        });
        return await this.hydrateRunResult(completed, false);
      } catch (error: unknown) {
        const current = await this.dependencies.store.getRequest(start.request.id);
        if (current !== null && current.status !== "running") {
          if (current.status === "cancelled" || current.status === "candidate_ready") {
            return await this.hydrateRunResult(current, false);
          }
          throw error;
        }
        throw error;
      }
    } catch (error: unknown) {
      if (
        isAbortRequested(controller.signal) &&
        this.active.get(start.request.id)?.cancelRequested === true
      ) {
        const cancelled = await this.cancel(start.request.id);
        return await this.hydrateRunResult(cancelled, false);
      }
      const current = await this.dependencies.store.getRequest(start.request.id);
      if (current !== null && current.status !== "running") {
        if (current.status === "cancelled") {
          return await this.hydrateRunResult(current, false);
        }
        throw error;
      }

      if (error instanceof GovernedExtensionTimeoutSignal) {
        await this.failIfRunning(start.request.id, {
          outcome: "failed_retryable",
          errorCode: "EXTENSION_PROVIDER_TIMEOUT",
          correlationId,
        });
        throw runtimeError(
          "EXTENSION_PROVIDER_TIMEOUT",
          "The provider exceeded the fixed attempt timeout.",
          true,
        );
      }

      const protocolCode = readProtocolErrorCode(error);
      if (protocolCode !== null) {
        await this.failIfRunning(start.request.id, {
          outcome: "failed_retryable",
          errorCode: protocolCode,
          correlationId,
          ...(gatewayResult?.usage === undefined
            ? {}
            : { usage: normalizeUsage(gatewayResult.usage) }),
        });
        throw error;
      }
      if (
        error instanceof GovernedCreativeExtensionRuntimeError &&
        (error.code === "EXTENSION_USAGE_UNAVAILABLE" ||
          error.code === "EXTENSION_RESPONSE_AUTHORITY_MISMATCH")
      ) {
        if (error.code === "EXTENSION_RESPONSE_AUTHORITY_MISMATCH") {
          await this.failIfRunning(start.request.id, {
            outcome: "failed_retryable",
            errorCode: error.code,
            correlationId,
            ...(gatewayResult?.usage === undefined
              ? {}
              : { usage: normalizeUsage(gatewayResult.usage) }),
          });
        }
        throw error;
      }

      const gatewayError = error instanceof GovernedCreativeExtensionGatewayError ? error : null;
      await this.failIfRunning(start.request.id, {
        outcome: gatewayError?.retryable === false ? "failed_final" : "failed_retryable",
        errorCode: "EXTENSION_PROVIDER_FAILED",
        correlationId,
        ...(gatewayError?.usage === undefined ? {} : { usage: gatewayError.usage }),
      });
      throw runtimeError(
        "EXTENSION_PROVIDER_FAILED",
        "The provider attempt failed before a valid isolated candidate was published.",
        gatewayError?.retryable ?? true,
      );
    } finally {
      this.active.delete(start.request.id);
    }
  }

  public async prepareRetry(requestId: string): Promise<GovernedCreativeExtensionPreflight> {
    const previous = await this.dependencies.store.getRequest(requestId);
    if (previous === null) {
      throw runtimeError("EXTENSION_NOT_FOUND", "The previous attempt no longer exists.");
    }
    if (
      previous.status !== "cancelled" &&
      previous.status !== "failed_retryable" &&
      previous.status !== "failed_final"
    ) {
      throw runtimeError(
        "EXTENSION_RETRY_NOT_ALLOWED",
        "Only cancelled or failed attempts can start a new billed retry.",
      );
    }
    const snapshot = parseStoredSnapshot(previous.requestSnapshotJson);
    const draft = draftFromSnapshot(snapshot);
    return this.buildPreflight(draft, routeFromSnapshot(snapshot), {
      previousRequestId: previous.id,
      attempt: previous.attempt + 1,
    });
  }

  public async cancel(requestId: string): Promise<GovernedExtensionRequest> {
    const active = this.active.get(requestId);
    if (active !== undefined) {
      active.cancelRequested = true;
      active.controller.abort();
    }
    const current = await this.dependencies.store.getRequest(requestId);
    if (current === null) {
      throw runtimeError("EXTENSION_NOT_FOUND", "The running attempt no longer exists.");
    }
    if (current.status !== "running") {
      return current;
    }
    try {
      return await this.dependencies.store.cancelRequest({
        requestId,
        expectedRevision: current.revision,
        auditEventId: this.dependencies.ids.next(),
        correlationId: this.dependencies.ids.next(),
      });
    } catch {
      const settled = await this.dependencies.store.getRequest(requestId);
      if (settled !== null && settled.status !== "running") {
        return settled;
      }
      throw runtimeError(
        "EXTENSION_PROVIDER_FAILED",
        "The cancellation could not win the terminal state transition.",
        true,
      );
    }
  }

  public async acceptCandidate(
    candidateId: string,
    expectedRevision: number,
  ): Promise<AcceptGovernedExtensionCandidateResult> {
    await this.assertCandidateMutationAllowed(candidateId);
    return this.dependencies.store.acceptCandidate({
      candidateId,
      expectedRevision,
      formalOutputId: this.dependencies.ids.next(),
      auditEventId: this.dependencies.ids.next(),
      correlationId: this.dependencies.ids.next(),
    });
  }

  public async rejectCandidate(
    candidateId: string,
    expectedRevision: number,
  ): Promise<GovernedExtensionCandidate> {
    await this.assertCandidateMutationAllowed(candidateId);
    return this.dependencies.store.rejectCandidate({
      candidateId,
      expectedRevision,
      auditEventId: this.dependencies.ids.next(),
      correlationId: this.dependencies.ids.next(),
    });
  }

  public async expireCandidate(
    candidateId: string,
    expectedRevision: number,
  ): Promise<GovernedExtensionCandidate> {
    await this.assertCandidateMutationAllowed(candidateId);
    return this.dependencies.store.expireCandidate({
      candidateId,
      expectedRevision,
      auditEventId: this.dependencies.ids.next(),
      correlationId: this.dependencies.ids.next(),
    });
  }

  /** Historical reads stay available when either execution flag is disabled. */
  public async listHistory(
    projectId: string,
    kind?: GovernedExtensionKind,
    limit = 100,
  ): Promise<GovernedExtensionHistory> {
    const [requests, candidates] = await Promise.all([
      this.dependencies.store.listRequests({
        projectId,
        ...(kind === undefined ? {} : { kind }),
        limit,
      }),
      this.dependencies.store.listCandidates({
        projectId,
        ...(kind === undefined ? {} : { kind }),
        limit,
      }),
    ]);
    return Object.freeze({ requests, candidates });
  }

  /** Export is metadata/result-only and never includes a plaintext consent token. */
  public async exportHistory(
    projectId: string,
    kind?: GovernedExtensionKind,
  ): Promise<{ readonly filename: string; readonly content: string }> {
    const history = await this.listHistory(projectId, kind, 500);
    const requests = history.requests.map(({ requestSnapshotJson, ...request }) => {
      void requestSnapshotJson;
      return request;
    });
    const content = JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: this.dependencies.clock.now(),
        projectId,
        kind: kind ?? "all",
        costSemantics: "internal_estimate",
        requests,
        candidates: history.candidates,
      },
      null,
      2,
    );
    return {
      filename: `inkshadow-${kind ?? "creative-extensions"}-${projectId}.json`,
      content,
    };
  }

  /** Startup wiring should invoke this before enabling new provider attempts. */
  public recoverAfterCrash(staleBefore: string): Promise<number> {
    return this.dependencies.store.recoverOrphanedReservations({
      staleBefore,
      auditIdForRequest: () => this.dependencies.ids.next(),
      correlationId: this.dependencies.ids.next(),
    });
  }

  private async buildPreflight(
    draft: GovernedCreativeExtensionDraft,
    route: GovernedCreativeExtensionRoute | null,
    retry: GovernedCreativeExtensionPreflight["retry"],
  ): Promise<GovernedCreativeExtensionPreflight> {
    const baseEnvironment = this.dependencies.readEnvironment();
    const environment = Object.freeze({
      ...baseEnvironment,
      readOnly:
        baseEnvironment.readOnly ||
        (await this.readSourceOnlyState(draft.source.projectId, draft.source.chapterId)),
    });
    const checks: GovernedExtensionPreflightCheck[] = [];
    const flags = this.readFlags();
    const enabled = draft.kind === "translation" ? flags.translation : flags.shortDrama;
    if (!enabled) {
      checks.push(
        blocking(
          "EXTENSION_FEATURE_DISABLED",
          "功能尚未启用",
          "可继续查看与导出历史记录，但不会执行任何模型调用。",
        ),
      );
    }
    if (environment.readOnly) {
      checks.push(
        blocking(
          "EXTENSION_READ_ONLY",
          "当前为只读状态",
          "只读项目不允许创建、重试或采纳候选结果。",
        ),
      );
    }
    if (draft.source.sourceText.trim().length === 0) {
      checks.push(blocking("EXTENSION_SOURCE_EMPTY", "章节内容为空", "请先补充章节正文。"));
    }
    if (!SHA256_PATTERN.test(draft.source.sourceChecksum)) {
      checks.push(
        blocking(
          "EXTENSION_SOURCE_INVALID",
          "来源校验值无效",
          "当前章节版本没有可验证的 SHA-256 权威校验值。",
        ),
      );
    }
    if (route === null) {
      checks.push(
        blocking(
          "EXTENSION_ROUTE_MISSING",
          "缺少模型路由",
          "请先为此服务配置模型、地址与固定价格快照。",
        ),
      );
    }

    const effectiveRoute = route ?? PLACEHOLDER_ROUTE;
    if (effectiveRoute.location === "remote" && !environment.online) {
      checks.push(
        blocking(
          "EXTENSION_REMOTE_OFFLINE",
          "远程服务不可用",
          "当前离线；可改用明确的本机回环地址，或联网后重试。",
        ),
      );
    }
    const routeIssue = validateRoute(effectiveRoute);
    if (route !== null && routeIssue !== null) {
      checks.push(blocking("EXTENSION_ROUTE_INVALID", "模型路由无效", routeIssue));
    }
    const draftIssue = validateDraftSettings(draft);
    if (draftIssue !== null) {
      checks.push(blocking("EXTENSION_SETTINGS_INVALID", "服务参数无效", draftIssue));
    }

    const dataCategories =
      draft.kind === "translation"
        ? (["chapter_text", "glossary", "translation_settings"] as const)
        : (["chapter_text", "short_drama_settings"] as const);
    const snapshot = makeSnapshot(draft, effectiveRoute, dataCategories);
    const requestFingerprint = await computeGovernedExtensionRequestFingerprint(snapshot);
    const paragraphAuthorities = await buildParagraphAuthorities(draft.source.sourceText);
    const estimatedInputTokens = estimateTokens(
      draft.source.sourceText.length + JSON.stringify(draft.settings).length,
    );
    const estimatedOutputTokens =
      draft.kind === "translation"
        ? Math.min(
            effectiveRoute.limits.maximumOutputTokens,
            Math.max(1, Math.ceil(draft.source.sourceText.length / 2.5)),
          )
        : Math.min(
            effectiveRoute.limits.maximumOutputTokens,
            Math.max(
              1,
              Math.ceil(
                (draft.settings.targetEpisodeCount *
                  draft.settings.targetEpisodeDurationSeconds *
                  18) /
                  4,
              ),
            ),
          );
    if (estimatedInputTokens > effectiveRoute.limits.maximumInputTokens) {
      checks.push(
        blocking(
          "EXTENSION_INPUT_LIMIT_EXCEEDED",
          "输入超出模型上限",
          `内部预估需要 ${String(estimatedInputTokens)} 个输入 token，但固定路由上限为 ${String(effectiveRoute.limits.maximumInputTokens)}。`,
        ),
      );
    }
    const estimatedCostMicros = calculateUsageEstimateMicros(
      estimatedInputTokens,
      estimatedOutputTokens,
      effectiveRoute,
    );
    const maximumCostMicros = calculateMaximumCostMicros(snapshot);

    if (effectiveRoute.location === "remote") {
      checks.push({
        code: "EXTENSION_REMOTE_CONSENT_REQUIRED",
        level: "action",
        title: "需要一次性远程发送确认",
        detail: `正文与所列设置将发送到 ${effectiveRoute.baseUrl}；确认仅绑定本次项目、版本、模型、价格快照和请求指纹。`,
      });
    } else if (route !== null) {
      checks.push({
        code: "EXTENSION_LOOPBACK_DESTINATION",
        level: "notice",
        title: "仅发送到本机回环服务",
        detail: `${effectiveRoute.baseUrl} 是可见的本机目的地，不创建远程发送同意凭据。`,
      });
    }
    checks.push({
      code: "EXTENSION_COST_ESTIMATE",
      level: "notice",
      title: "费用为内部估算台账",
      detail: `本次最多预留 ${String(maximumCostMicros)} 微单位 ${effectiveRoute.pricing.currency}；有可靠用量时按服务方报告的输入/输出 token 与固定价格快照计算，用量未知时按最大预留保守结算。两者都是内部台账，不代表服务方账单。`,
    });
    if (effectiveRoute.location === "remote") {
      checks.push({
        code: "EXTENSION_NATIVE_NETWORK_ENFORCEMENT",
        level: "notice",
        title: "连接时仍执行网络地址校验",
        detail:
          "URL 预检不是完整 SSRF 防护；原生网络网关必须在连接和每次重定向时校验解析后的地址，拒绝私网、链路本地与回环目标，以抵御 DNS 重绑定。",
      });
    }
    if (retry !== null) {
      checks.push({
        code: "EXTENSION_RETRY_NEW_CHARGE",
        level: "notice",
        title: "重试是新的计费尝试",
        detail: `这是第 ${String(retry.attempt)} 次尝试，将使用新的幂等键、预算预留和（远程时）一次性确认。`,
      });
    }

    return deepFreeze({
      snapshot,
      requestFingerprint,
      paragraphAuthorities,
      checks,
      ready: !checks.some(({ level }) => level === "blocking"),
      requiresRemoteConsent: effectiveRoute.location === "remote",
      destination: {
        location: effectiveRoute.location,
        providerId: effectiveRoute.providerId,
        baseUrl: effectiveRoute.baseUrl,
        modelId: effectiveRoute.modelId,
        dataCategories,
      },
      estimate: {
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedCostMicros,
        maximumCostMicros,
        currency: effectiveRoute.pricing.currency,
        semantics: "internal_estimate",
      },
      retry,
    });
  }

  private readFlags(): GovernedCreativeExtensionFlags {
    return this.dependencies.readFeatureFlags?.() ?? DEFAULT_GOVERNED_CREATIVE_EXTENSION_FLAGS;
  }

  private async assertCurrentExecutionAllowed(
    preflight: GovernedCreativeExtensionPreflight,
  ): Promise<void> {
    const flags = this.readFlags();
    const enabled =
      preflight.snapshot.kind === "translation" ? flags.translation : flags.shortDrama;
    if (!enabled) {
      throw runtimeError(
        "EXTENSION_FEATURE_DISABLED",
        "This creative-extension provider execution is disabled.",
      );
    }
    const environment = this.dependencies.readEnvironment();
    if (
      environment.readOnly ||
      (await this.readSourceOnlyState(preflight.snapshot.projectId, preflight.snapshot.chapterId))
    ) {
      throw runtimeError("EXTENSION_READ_ONLY", "The current project is read-only.");
    }
    if (preflight.snapshot.provider.location === "remote" && !environment.online) {
      throw runtimeError(
        "EXTENSION_REMOTE_OFFLINE",
        "Remote provider execution is blocked while offline.",
        true,
      );
    }
  }

  private async assertFingerprint(preflight: GovernedCreativeExtensionPreflight): Promise<void> {
    const fingerprint = await computeGovernedExtensionRequestFingerprint(preflight.snapshot);
    if (fingerprint !== preflight.requestFingerprint) {
      throw runtimeError(
        "EXTENSION_PREFLIGHT_BLOCKED",
        "The prepared request changed after preflight.",
      );
    }
  }

  private async assertCandidateMutationAllowed(candidateId: string): Promise<void> {
    const candidate = await this.dependencies.store.getCandidate(candidateId);
    if (candidate === null) {
      throw runtimeError("EXTENSION_NOT_FOUND", "The candidate no longer exists.");
    }
    const flags = this.readFlags();
    const enabled = candidate.kind === "translation" ? flags.translation : flags.shortDrama;
    if (!enabled) {
      throw runtimeError(
        "EXTENSION_FEATURE_DISABLED",
        "Candidate history remains readable, but decisions are disabled with the feature.",
      );
    }
    if (
      this.dependencies.readEnvironment().readOnly ||
      (await this.readSourceOnlyState(candidate.projectId, candidate.chapterId))
    ) {
      throw runtimeError("EXTENSION_READ_ONLY", "The current project is read-only.");
    }
  }

  private async readSourceOnlyState(projectId: string, chapterId: string): Promise<boolean> {
    try {
      return (await this.dependencies.isSourceReadOnly?.(projectId, chapterId)) ?? false;
    } catch {
      // Authority lookup failures fail closed for all provider and decision mutations.
      return true;
    }
  }

  private async hydrateRunResult(
    request: GovernedExtensionRequest,
    replayed: boolean,
  ): Promise<GovernedExtensionRunResult> {
    const candidate =
      request.candidateId === null
        ? null
        : await this.dependencies.store.getCandidate(request.candidateId);
    return Object.freeze({ request, candidate, replayed });
  }

  private async failIfRunning(
    requestId: string,
    input: {
      readonly outcome: "failed_retryable" | "failed_final";
      readonly errorCode: string;
      readonly correlationId: string;
      readonly usage?: ProviderReportedExtensionUsage;
    },
  ): Promise<GovernedExtensionRequest | null> {
    const current = await this.dependencies.store.getRequest(requestId);
    if (current?.status !== "running") {
      return current;
    }
    try {
      return await this.dependencies.store.failRequest({
        requestId,
        expectedRevision: current.revision,
        outcome: input.outcome,
        errorCode: input.errorCode,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        auditEventId: this.dependencies.ids.next(),
        correlationId: input.correlationId,
      });
    } catch {
      return this.dependencies.store.getRequest(requestId);
    }
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PLACEHOLDER_ROUTE: GovernedCreativeExtensionRoute = Object.freeze({
  location: "loopback",
  providerId: "route-missing",
  baseUrl: "http://127.0.0.1:1",
  modelId: "route-missing",
  pricing: {
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
    currency: "USD",
    priceVersion: "route-missing",
    priceUpdatedAt: "1970-01-01T00:00:00.000Z",
  },
  limits: {
    maximumInputTokens: 1,
    maximumOutputTokens: 1,
    timeoutMs: 1_000,
  },
});

function makeSnapshot(
  draft: GovernedCreativeExtensionDraft,
  route: GovernedCreativeExtensionRoute,
  dataCategories: GovernedExtensionRequestSnapshot["dataCategories"],
): GovernedExtensionRequestSnapshot {
  const common = {
    schemaVersion: 1 as const,
    projectId: draft.source.projectId,
    chapterId: draft.source.chapterId,
    sourceVersionId: draft.source.sourceVersionId,
    sourceChecksum: draft.source.sourceChecksum,
    sourceText: draft.source.sourceText,
    provider: {
      location: route.location,
      providerId: route.providerId,
      baseUrl: canonicalProviderUrl(route.baseUrl),
      modelId: route.modelId,
    },
    dataCategories,
    pricing: route.pricing,
    limits: route.limits,
  };
  return draft.kind === "translation"
    ? { ...common, kind: "translation", settings: draft.settings }
    : { ...common, kind: "short_drama", settings: draft.settings };
}

function consentScope(
  preflight: GovernedCreativeExtensionPreflight,
): GovernedExtensionConsentScope {
  const { snapshot } = preflight;
  return {
    kind: snapshot.kind,
    providerId: snapshot.provider.providerId,
    baseUrl: snapshot.provider.baseUrl,
    modelId: snapshot.provider.modelId,
    dataCategories: snapshot.dataCategories,
    projectId: snapshot.projectId,
    chapterId: snapshot.chapterId,
    sourceVersionId: snapshot.sourceVersionId,
    priceVersion: snapshot.pricing.priceVersion,
    requestFingerprint: preflight.requestFingerprint,
  };
}

function routeFromSnapshot(
  snapshot: GovernedExtensionRequestSnapshot,
): GovernedCreativeExtensionRoute {
  return {
    location: snapshot.provider.location,
    providerId: snapshot.provider.providerId,
    baseUrl: snapshot.provider.baseUrl,
    modelId: snapshot.provider.modelId,
    pricing: snapshot.pricing,
    limits: snapshot.limits,
  };
}

function draftFromSnapshot(
  snapshot: GovernedExtensionRequestSnapshot,
): GovernedCreativeExtensionDraft {
  const source: GovernedCreativeExtensionSource = {
    projectId: snapshot.projectId,
    chapterId: snapshot.chapterId,
    sourceVersionId: snapshot.sourceVersionId,
    sourceChecksum: snapshot.sourceChecksum,
    chapterTitle: snapshot.chapterId,
    sourceText: snapshot.sourceText,
  };
  return snapshot.kind === "translation"
    ? { kind: "translation", source, settings: snapshot.settings }
    : { kind: "short_drama", source, settings: snapshot.settings };
}

function parseStoredSnapshot(value: string): GovernedExtensionRequestSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw runtimeError(
      "EXTENSION_RETRY_NOT_ALLOWED",
      "The previous immutable request snapshot is unreadable.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== 1 ||
    !("kind" in parsed) ||
    (parsed.kind !== "translation" && parsed.kind !== "short_drama")
  ) {
    throw runtimeError(
      "EXTENSION_RETRY_NOT_ALLOWED",
      "The previous immutable request snapshot is unsupported.",
    );
  }
  return parsed as GovernedExtensionRequestSnapshot;
}

async function assertCandidateAuthority(
  candidate: CreativeExtensionCandidatePayload,
  preflight: GovernedCreativeExtensionPreflight,
): Promise<void> {
  const { snapshot } = preflight;
  if (
    candidate.kind !== snapshot.kind ||
    candidate.source.chapterId !== snapshot.chapterId ||
    candidate.source.sourceVersionId !== snapshot.sourceVersionId ||
    candidate.source.sourceChecksum !== snapshot.sourceChecksum
  ) {
    throw authorityMismatch("The response does not cite the exact prepared source version.");
  }
  if (candidate.kind === "translation" && snapshot.kind === "translation") {
    if (
      candidate.targetLanguage.code !== snapshot.settings.targetLanguage.code ||
      candidate.targetLanguage.label !== snapshot.settings.targetLanguage.label ||
      candidate.tone !== snapshot.settings.tone ||
      candidate.glossaryVersion !== snapshot.settings.glossaryVersion
    ) {
      throw authorityMismatch("The translation response changed the confirmed settings.");
    }
    if (candidate.paragraphs.length !== preflight.paragraphAuthorities.length) {
      throw authorityMismatch("The translation response omitted or added source paragraphs.");
    }
    const allowedGlossaryTerms = new Set(
      snapshot.settings.glossary.flatMap(({ source, target }) => [source, target]),
    );
    for (const paragraph of candidate.paragraphs) {
      const authority = preflight.paragraphAuthorities[paragraph.sourceParagraph];
      if (paragraph.sourceChecksum !== authority?.checksum) {
        throw authorityMismatch("A translated paragraph cites the wrong source bytes.");
      }
      if (paragraph.glossaryTerms.some((term) => !allowedGlossaryTerms.has(term))) {
        throw authorityMismatch("A translated paragraph claims an unknown glossary term.");
      }
    }
    return;
  }
  if (candidate.kind === "short_drama" && snapshot.kind === "short_drama") {
    if (
      candidate.format !== snapshot.settings.format ||
      candidate.episodes.length !== snapshot.settings.targetEpisodeCount
    ) {
      throw authorityMismatch("The short-drama response changed the confirmed format or count.");
    }
    for (const episode of candidate.episodes) {
      if (episode.durationSeconds !== snapshot.settings.targetEpisodeDurationSeconds) {
        throw authorityMismatch("A short-drama episode changed the confirmed duration.");
      }
      for (const scene of episode.scenes) {
        for (const reference of scene.sourceReferences) {
          const sourceRange = preflight.paragraphAuthorities.slice(
            reference.paragraphStart,
            reference.paragraphEnd + 1,
          );
          if (
            sourceRange.length !== reference.paragraphEnd - reference.paragraphStart + 1 ||
            reference.sourceChecksum !==
              (await sha256Hex(sourceRange.map(({ text }) => text).join("\n\n")))
          ) {
            throw authorityMismatch("A scene cites a paragraph range with the wrong checksum.");
          }
        }
      }
    }
    return;
  }
  throw authorityMismatch("The response kind does not match the prepared service.");
}

async function buildParagraphAuthorities(
  sourceText: string,
): Promise<readonly GovernedExtensionParagraphAuthority[]> {
  const paragraphs = sourceText
    .split(/\r?\n(?:[ \t]*\r?\n)+/u)
    .filter((paragraph) => paragraph.trim().length > 0);
  const effective = paragraphs.length === 0 && sourceText.length > 0 ? [sourceText] : paragraphs;
  return Object.freeze(
    await Promise.all(
      effective.map(async (text, index) =>
        Object.freeze({ index, text, checksum: await sha256Hex(text) }),
      ),
    ),
  );
}

function validateRoute(route: GovernedCreativeExtensionRoute): string | null {
  const inspected = inspectGovernedExtensionProviderUrl(route.baseUrl, route.location);
  if (!inspected.ok) {
    return inspected.message;
  }
  if (
    route.providerId.trim().length === 0 ||
    route.modelId.trim().length === 0 ||
    !Number.isSafeInteger(route.limits.maximumInputTokens) ||
    !Number.isSafeInteger(route.limits.maximumOutputTokens) ||
    !Number.isSafeInteger(route.limits.timeoutMs) ||
    route.limits.maximumInputTokens < 1 ||
    route.limits.maximumOutputTokens < 1 ||
    route.limits.timeoutMs < 1_000
  ) {
    return "模型标识、token 上限或超时配置无效。";
  }
  if (
    !Number.isSafeInteger(route.pricing.inputMicrosPerMillionTokens) ||
    !Number.isSafeInteger(route.pricing.outputMicrosPerMillionTokens) ||
    route.pricing.inputMicrosPerMillionTokens < 0 ||
    route.pricing.outputMicrosPerMillionTokens < 0 ||
    !/^[A-Z]{3}$/u.test(route.pricing.currency)
  ) {
    return "固定价格快照无效。";
  }
  return null;
}

function validateDraftSettings(draft: GovernedCreativeExtensionDraft): string | null {
  if (draft.kind === "translation") {
    if (
      !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u.test(
        draft.settings.targetLanguage.code,
      ) ||
      draft.settings.targetLanguage.label.trim().length === 0 ||
      draft.settings.tone.trim().length === 0 ||
      draft.settings.glossaryVersion.trim().length === 0
    ) {
      return "目标语言、语气或术语表版本不完整。";
    }
    return null;
  }
  if (
    !Number.isInteger(draft.settings.targetEpisodeCount) ||
    draft.settings.targetEpisodeCount < 1 ||
    draft.settings.targetEpisodeCount > 24 ||
    !Number.isInteger(draft.settings.targetEpisodeDurationSeconds) ||
    draft.settings.targetEpisodeDurationSeconds < 15 ||
    draft.settings.targetEpisodeDurationSeconds > 7_200 ||
    draft.settings.tone.trim().length === 0
  ) {
    return "集数、单集时长或语气不在允许范围内。";
  }
  return null;
}

function normalizeUsage(
  usage: NonNullable<GovernedExtensionGatewayResult["usage"]>,
): ProviderReportedExtensionUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    ...(usage.providerReceipt === undefined ? {} : { providerReceipt: usage.providerReceipt }),
  };
}

async function invokeWithTimeout(
  gateway: GovernedCreativeExtensionGateway,
  request: GovernedExtensionGatewayRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<GovernedExtensionGatewayResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      gateway.generate(request, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new GovernedExtensionTimeoutSignal());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class GovernedExtensionTimeoutSignal extends Error {
  public constructor() {
    super("The governed creative-extension provider attempt timed out.");
    this.name = "GovernedExtensionTimeoutSignal";
  }
}

function isAbortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function calculateUsageEstimateMicros(
  inputTokens: number,
  outputTokens: number,
  route: GovernedCreativeExtensionRoute,
): number {
  return Math.ceil(
    (inputTokens * route.pricing.inputMicrosPerMillionTokens +
      outputTokens * route.pricing.outputMicrosPerMillionTokens) /
      1_000_000,
  );
}

function estimateTokens(codeUnits: number): number {
  return Math.max(1, Math.ceil(codeUnits / 4));
}

function canonicalProviderUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function blocking(code: string, title: string, detail: string): GovernedExtensionPreflightCheck {
  return { code, level: "blocking", title, detail };
}

function authorityMismatch(message: string): GovernedCreativeExtensionRuntimeError {
  return runtimeError("EXTENSION_RESPONSE_AUTHORITY_MISMATCH", message, true);
}

function runtimeError(
  code: GovernedCreativeExtensionRuntimeErrorCode,
  message: string,
  retryable = false,
): GovernedCreativeExtensionRuntimeError {
  return new GovernedCreativeExtensionRuntimeError(code, message, retryable);
}

function readProtocolErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^EXTENSION_RESPONSE_[A-Z_]+$/u.test(error.code)
  ) {
    return error.code;
  }
  return null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
