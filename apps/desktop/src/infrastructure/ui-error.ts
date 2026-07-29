import { AppError } from "@inkshadow/domain";

export interface NormalizedUiError {
  readonly title: string;
  readonly description: string;
  readonly code: string;
}

export function normalizeUiError(error: unknown): NormalizedUiError {
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
    const message =
      nativeDatabaseBootstrapDescription(code) ??
      (typeof error.message === "string" ? error.message : "发生了未预期的本地错误。");
    return { title: "操作未完成", description: message, code };
  }
  return {
    title: "操作未完成",
    description: "发生了未预期的本地错误。",
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
    INVALID_UUID: "页面地址中的标识无效。",
    INVALID_TIMESTAMP: "本地时间格式无效。",
    INVALID_CHECKSUM: "内容校验失败。",
    INVALID_STATE_TRANSITION: "当前状态不允许执行此操作。",
    PROJECT_NOT_FOUND: "找不到这个项目。",
    PROJECT_DELETED: "项目位于回收站，请先恢复。",
    PROJECT_ARCHIVED: "项目已归档，不能继续写入。",
    PROJECT_NAME_CONFLICT: "已有同名项目，请换一个名称。",
    PROJECT_RETENTION_EXPIRED: "项目恢复期限已过。",
    CHAPTER_NOT_FOUND: "找不到这个章节。",
    CHAPTER_DELETED: "章节已删除，不能继续编辑。",
    VERSION_CONFLICT: "内容已在其他操作中变化，请重新加载并比较版本。",
    BASE_VERSION_CHANGED: "恢复草稿或候选基于旧版本，请先解决冲突。",
    RECOVERY_DRAFT_NOT_FOUND: "没有找到可保存的恢复草稿。",
    CANDIDATE_NOT_FOUND: "找不到这个候选。",
    CANDIDATE_NOT_READY: "候选尚未准备完成。",
    CANDIDATE_ALREADY_DECIDED: "候选已经接受或拒绝。",
    CANDIDATE_TARGET_MISSING: "候选没有关联章节。",
    READONLY_RESOURCE: "当前内容为只读。",
    SAVE_FAILED: "本地保存失败，请重试或导出草稿。",
    REPOSITORY_ERROR: "本地数据暂时无法访问，请重试。",
    NO_CHANGES: "内容没有变化。",
  };
  return descriptions[code];
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
