import { AppError } from "@inkshadow/domain";

export interface NormalizedUiError {
  readonly title: string;
  readonly description: string;
  readonly code: string;
}

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
    const databaseDescription = databaseErrorDescription(error);
    return {
      title: error.code === "VERSION_CONFLICT" ? "检测到版本冲突" : "操作未完成",
      description: databaseDescription ?? chineseErrorDescription(error.code),
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

function databaseErrorDescription(error: AppError): string | null {
  if (error.details.databaseCode === "SQLITE_BUSY") {
    return "本地数据库正忙，本次写入未被报告为成功。编辑器会保留当前文字，请稍后重试保存。";
  }
  if (error.details.databaseCode === "SQLITE_DISK_FULL") {
    return "本地磁盘空间不足，本次写入未提交。请保持窗口打开，释放空间后重试，或将草稿导出到其他磁盘。";
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
