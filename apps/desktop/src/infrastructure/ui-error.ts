import { AppError } from "@inkshadow/domain";

export interface NormalizedUiError {
  readonly title: string;
  readonly description: string;
  readonly code: string;
}

export type OrdinaryUiError = Pick<NormalizedUiError, "title" | "description">;

/** A source-authored recovery message that is explicitly safe to show verbatim. */
export class UiActionError extends Error {
  public constructor(
    public readonly code: string,
    description: string,
    public readonly title = "操作未完成",
  ) {
    super(description);
    this.name = "UiActionError";
  }
}

export function normalizeUiError(error: unknown): NormalizedUiError {
  if (error instanceof UiActionError) {
    return { title: error.title, description: error.message, code: error.code };
  }
  if (error instanceof AppError) {
    const databasePresentation = databaseErrorPresentation(error);
    return {
      title:
        databasePresentation?.title ??
        (error.code === "VERSION_CONFLICT" ? "检测到版本冲突" : "操作未完成"),
      description: databasePresentation?.description ?? chineseErrorDescription(error.code),
      code: error.code,
    };
  }
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : "UNEXPECTED_ERROR";
    return {
      title: "操作未完成",
      description: nativeDatabaseBootstrapDescription(code) ?? recordErrorDescription(code),
      code,
    };
  }
  return {
    title: "操作未完成",
    description:
      "发生了未预期的本地错误。请先重试；若问题持续，请保留当前窗口中的内容，并在设置中下载脱敏诊断包后联系支持。",
    code: "UNEXPECTED_ERROR",
  };
}

/**
 * Projects an error into the fields that are safe for ordinary product surfaces.
 * The diagnostic code remains available through `normalizeUiError` for expert and
 * diagnostic views, but is deliberately absent from this projection.
 */
export function projectOrdinaryUiError(error: unknown): OrdinaryUiError {
  const { title, description } = normalizeUiError(error);
  return { title, description };
}

function databaseErrorPresentation(error: AppError): OrdinaryUiError | null {
  if (
    error.details.databaseCode === "SQLITE_WRITE_OUTCOME_UNKNOWN" ||
    error.details.databaseCode === "SQLITE_COMMIT_OUTCOME_UNKNOWN"
  ) {
    return {
      title: "写入结果需要核对",
      description:
        "本机暂时无法确认这次写入是否已经完成。请重新打开当前页面，核对正文、版本和 AI 建议草稿状态；系统不会自动再次提交。",
    };
  }
  if (error.details.databaseCode === "SQLITE_OPERATION_TIMEOUT") {
    return {
      title: "本地操作等待超时",
      description:
        "本地数据操作等待超时，本次操作没有被报告为成功。请重新打开当前页面核对内容；系统不会自动重试。",
    };
  }
  if (error.details.databaseCode === "SQLITE_BUSY") {
    return {
      title: "操作未完成",
      description: "本地数据库正忙，本次写入未被报告为成功。编辑器会保留当前文字，请稍后重试保存。",
    };
  }
  if (error.details.databaseCode === "SQLITE_DISK_FULL") {
    return {
      title: "操作未完成",
      description:
        "本地磁盘空间不足，本次写入未提交。请保持窗口打开，释放空间后重试，或将草稿导出到其他磁盘。",
    };
  }
  return null;
}

function chineseErrorDescription(code: AppError["code"]): string {
  const descriptions: Record<AppError["code"], string> = {
    VALIDATION_FAILED: "请检查输入内容后重试。",
    INVALID_UUID: "页面地址中的标识无效。请返回项目列表后重新打开。",
    INVALID_TIMESTAMP: "本地时间格式无效。请检查系统日期和时区后重试。",
    INVALID_CHECKSUM: "内容校验失败。请停止覆盖，并从版本历史或已验证备份恢复。",
    INVALID_STATE_TRANSITION: "当前状态不允许执行此操作。请刷新页面并按当前可用操作继续。",
    PROJECT_NOT_FOUND: "找不到这个项目。请返回项目列表，或从备份恢复。",
    PROJECT_DELETED: "项目位于回收站，请先恢复后再继续。",
    PROJECT_ARCHIVED: "项目已归档，请先恢复为进行中项目再写入。",
    PROJECT_NAME_CONFLICT: "已有同名项目，请换一个名称。",
    PROJECT_RETENTION_EXPIRED: "项目恢复期限已过。请从已有备份或导出文件重新导入。",
    CHAPTER_NOT_FOUND: "找不到这个章节。请返回章节列表后重新选择。",
    CHAPTER_DELETED: "章节已删除，请先从回收站恢复后再编辑。",
    VERSION_CONFLICT: "内容已在其他操作中变化，请重新加载并比较版本。",
    BASE_VERSION_CHANGED: "恢复草稿或候选基于旧版本，请先解决冲突。",
    RECOVERY_DRAFT_NOT_FOUND: "没有找到可保存的恢复草稿。请返回当前章节检查最新保存版本。",
    CANDIDATE_NOT_FOUND: "找不到这个 AI 建议版本。请刷新候选列表后重试。",
    CANDIDATE_NOT_READY: "AI 建议版本尚未准备完成。请稍后刷新，或重新生成。",
    CANDIDATE_ALREADY_DECIDED: "AI 建议版本已经处理。请刷新页面查看当前正文与版本历史。",
    CANDIDATE_TARGET_MISSING: "AI 建议版本没有关联章节。请返回章节后重新生成。",
    READONLY_RESOURCE: "当前内容为只读。请另存为新版本或返回可编辑章节。",
    SAVE_FAILED: "本地保存失败，请重试或导出草稿。",
    REPOSITORY_ERROR: "本地数据暂时无法访问，请重试；若问题持续，请先备份并下载脱敏诊断包。",
    NO_CHANGES: "内容没有变化，无需保存；如要保留另一方案，请先修改或另存版本。",
  };
  return descriptions[code];
}

function recordErrorDescription(code: string): string {
  if (code === "VERSION_CONFLICT") {
    return "内容已在其他操作中变化，请重新加载并比较版本；当前正文和已有建议均未被覆盖。";
  }
  if (code === "CANDIDATE_REVISION_MISSING") {
    return "这条 AI 建议的当前版本已缺失或发生变化。请重新加载后再生成；原文和已有版本没有改变。";
  }
  if (code === "FORMAL_RECORD_PLAN_MISMATCH") {
    return "这条建议依据的设定已经变化，请重新整理后再确认。";
  }
  if (code === "DIFF_COMPLEXITY_LIMIT_EXCEEDED") {
    return "这次改动较长，无法安全逐句比较；你仍可查看完整建议并整段采用、另存或放弃。";
  }
  if (code === "IMPORT_ANALYSIS_ROUTE_NOT_CONFIGURED") {
    return "作品分析还没有可用的 AI 分工。请前往模型设置验证写作能力并完成任务分工；已导入原文不会因此改变。";
  }
  if (code === "IMPORT_ANALYSIS_STRUCTURED_OUTPUT_UNVERIFIED") {
    return "当前模型尚未通过作品分析所需的结构化输出验证。请在模型设置中重新验证或改选模型。";
  }
  if (code === "IMPORT_ANALYSIS_SOURCE_CHANGED") {
    return "章节在分析期间发生了变化。请基于最新正式版本重新分析，已接受正文不会被回滚。";
  }
  if (code === "IMPORT_JOURNEY_PERSIST_FAILED") {
    return "本地导入进度没有安全保存。请保持当前页面打开，释放存储空间后重试；已有正文和建议版本不会被静默覆盖。";
  }
  if (code === "IMPORT_PENDING_REQUEST_CLEAR_FAILED") {
    return "模型结果已经处理，但本机未能清除请求恢复标记。墨影不会自动重复调用；请释放存储空间后重新打开页面。";
  }
  if (code === "IMPORT_PENDING_REQUEST_PERSIST_FAILED") {
    return "本机未能在发送前保存请求恢复标记，因此没有调用模型。请保持页面打开，释放存储空间后重试。";
  }
  if (code === "EXTENSION_USAGE_UNAVAILABLE") {
    return "这次扩展请求已经结束，但供应商没有返回可核对的用量。正文没有被覆盖；可先导出历史，确认供应商记录后再决定是否重试。";
  }
  if (code === "CREATIVE_OPENING_TIMEOUT_SCOPE_MISMATCH") {
    return "开头超时编号与已确认的固定位置不一致。为避免误操作，墨影没有结束或取消任何其他调用，也没有改写创作进度；请重新读取进度并核对调用记录。";
  }
  if (code === "GENERATION_ABANDONED_BY_AUTHOR") {
    return "确认前离开，未确认的生成批次已安全终止";
  }
  if (code === "OPENING_JOURNEY_TASK_SCOPE_MISMATCH") {
    return "已有开书任务与当前构思批次不一致。墨影已停止继续处理，不会复用、改写或自动重发。";
  }
  if (code.startsWith("UPDATE_")) {
    return "安全更新未完成。当前版本仍可离线使用；请检查网络并只按已验证的官方发行说明重试。";
  }
  if (code === "MODEL_TIMEOUT") {
    return "模型在 180 秒内没有返回，本次操作已停止且不会自动重试。正文和已有建议没有改变，可稍后明确重试。";
  }
  if (code === "MODEL_NOT_CONNECTED") {
    return "当前没有可用的 AI 连接，本次请求没有发送。请先连接并验证一个创作服务后再试。";
  }
  if (code === "MODEL_OUTPUT_TRUNCATED") {
    return "模型在返回可见文字前或返回过程中达到输出上限。能力验证会使用更充足的固定预算并为 DeepSeek 关闭推理；若仍失败，请重新同步模型后重试，或改选另一个文本模型。";
  }
  if (code === "MODEL_OUTPUT_EMPTY") {
    return "连接已建立，但模型没有返回可用于写作的可见文字。请确认所选模型支持文本生成；若它只返回推理内容，请改选普通文本模型后重试。";
  }
  if (code === "MODEL_HUB_ROUTE_NOT_CONFIGURED") {
    return "这项写作任务还没有可用的 AI 分工。请先验证至少一个模型的写作能力，再在模型中心应用智能推荐；缺少向量检索不会阻止基础文本写作。";
  }
  if (code === "MODEL_HUB_ROUTE_DISABLED") {
    return "这项写作任务的 AI 分工已明确停用。本次请求没有调用模型，也不会改用旧配置；请在模型中心重新启用或明确分配模型后再试。";
  }
  if (code === "MODEL_PROFILE_NOT_READY") {
    return "当前没有可用于这次写作的兼容模型。你仍可继续手动编辑和保存正文；如需 AI，请选择一个已连接模型，或前往模型中心完成任务分工。";
  }
  if (code === "CREATIVE_INPUT_INVALID_EMPTY") {
    return "请先写下一句话灵感；当前页面不会创建空项目，也不会调用 AI。";
  }
  if (code === "CREATIVE_INPUT_INVALID_WHITESPACE_ONLY") {
    return "输入中只有空白字符。请写下一句可读的故事想法，或返回选择空白写作。";
  }
  if (code === "CREATIVE_INPUT_INVALID_TOO_SHORT") {
    return "当前想法太短，暂时不足以生成可区分的开头方案。请再补充一个人物、动作或冲突，也可以改为直接空白写作。";
  }
  if (code === "CREATIVE_INPUT_INVALID_TOO_LARGE") {
    return "当前创作输入超过本步骤上限。内容仍保留在页面中；请精简后重试，或先保存到本地素材。";
  }
  if (code === "CREATIVE_INPUT_INVALID_CONTROL_CHARACTER") {
    return "输入中包含不可见控制字符。请删除异常字符后重试；普通中文、全角标点和换行仍然支持。";
  }
  if (code === "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED") {
    return "AI 分工没有完整写入，之前可用的分工仍保持不变。请直接重试“应用 AI 分工”；若问题持续，请下载脱敏诊断包后联系支持。";
  }
  if (code === "MODEL_HUB_MANUAL_ROUTE_PRIVACY_CONFLICT") {
    return "已有手动设置的云端任务与“本地隐私”冲突。系统没有覆盖这条手动设置；请在专家设置中将它改为本机模型或先停用，再重新应用本地隐私方案。";
  }
  if (code === "CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED") {
    return "本地存储空间不足，本次更改没有保存。请保持当前页面打开，释放设备或浏览器存储空间后，再次点击原来的创建或保存操作；当前输入仍保留在页面中。";
  }
  if (code === "CREATIVE_JOURNEY_STORAGE_ACCESS_DENIED") {
    return "浏览器阻止了本地存储，本次更改没有保存。请允许墨影使用本地存储，或退出隐私/受限模式后，再次点击原来的创建或保存操作；当前输入仍保留在页面中。";
  }
  if (
    code === "CREATIVE_JOURNEY_STORAGE_READ_FAILED" ||
    code === "CREATIVE_JOURNEY_STORAGE_WRITE_FAILED"
  ) {
    return "本地创作进度暂时无法读取或保存，本次更改没有被报告为成功。请保持当前页面打开，确认浏览器允许本地存储且设备仍有可用空间，然后重试原操作。";
  }
  if (code === "MATERIAL_DUPLICATE_FOUND") {
    return "已存在正文内容相同的有效素材。请取消本次录入并使用已有素材，或修改正文后再保存。";
  }
  if (/MODEL|PROVIDER|EMBEDDING|RERANK|IMAGE_GENERATION/u.test(code)) {
    return "AI 服务暂未完成本次操作。请到设置中的 AI 模型检查连接、能力确认和任务分工后重试；正文与已有版本不会因此被覆盖。";
  }
  if (/NETWORK|TIMEOUT|HTTP|DNS|TLS/u.test(code)) {
    return "网络请求未完成。请检查网络和供应商服务状态后重试；若已产生费用，请先查看供应商调用记录，避免重复提交。";
  }
  if (/SQLITE|DATABASE|REPOSITORY|STORAGE/u.test(code)) {
    return "本地数据访问失败。请保留当前窗口中的内容并重试；若问题持续，请先创建备份或导出草稿，再下载脱敏诊断包。";
  }
  if (/IMPORT|PARSE|FORMAT/u.test(code)) {
    return "文件处理未完成。请确认文件格式、大小和内容完整性后重新选择；原项目数据没有被静默覆盖。";
  }
  if (/EXPORT|WRITE_FILE|PATH_TICKET/u.test(code)) {
    return "文件尚未导出。请重新选择一个可写的新文件位置并重试，且不要覆盖唯一副本。";
  }
  if (/SYNC|CLOUD|SESSION|AUTH|ENTITLEMENT/u.test(code)) {
    return "云端操作未完成。本地正文仍可使用；请检查网络、登录状态和同步授权后重试。";
  }
  return "发生了未预期的本地错误。请先重试；若问题持续，请保留当前窗口中的内容，并在设置中下载脱敏诊断包后联系支持。";
}

export function isUiErrorRetryable(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.retryable;
  }
  return !isRecord(error) || typeof error.retryable !== "boolean" || error.retryable;
}

const DATABASE_REOPEN_CODES = new Set([
  "SQLITE_BRIDGE_UNAVAILABLE",
  "SQLITE_CONNECTION_INVALIDATED",
  "SQLITE_SESSION_INVALID",
  "SQLITE_OPERATION_TIMEOUT",
  "SQLITE_WRITE_OUTCOME_UNKNOWN",
  "SQLITE_COMMIT_OUTCOME_UNKNOWN",
]);

/** True only when the current renderer facade must be replaced before more database work. */
export function requiresRuntimeDatabaseReopen(error: unknown): boolean {
  const code =
    error instanceof AppError ? error.details.databaseCode : isRecord(error) ? error.code : null;
  return typeof code === "string" && DATABASE_REOPEN_CODES.has(code);
}

function nativeDatabaseBootstrapDescription(code: string): string | null {
  switch (code) {
    case "SQLITE_PATH_TICKET_INVALID":
      return "所选本地数据库文件授权已失效或不再匹配。请重新选择文件后再试。";
    case "SQLITE_DATABASE_CORRUPT":
      return "本地数据库文件已损坏。请不要反复重新加载；墨影保留了原文件，请从已验证的备份恢复。若没有可用备份，请联系支持。";
    case "SQLITE_MIGRATION_INTEGRITY_FAILED":
      return "本地数据库迁移记录与此版本不一致。为防止数据被覆盖，墨影没有修改或替换原数据库。请保留原文件，使用与其匹配的版本或已验证备份恢复，并联系支持。";
    case "SQLITE_MIGRATION_FAILED":
      return "本地数据库升级未能安全完成，原数据库未被替换。请保留原文件，使用已验证的备份恢复或联系支持。";
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
