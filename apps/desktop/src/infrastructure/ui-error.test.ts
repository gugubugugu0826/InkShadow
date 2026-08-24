import { AppError } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import {
  isUiErrorRetryable,
  normalizeUiError,
  projectOrdinaryUiError,
  requiresRuntimeDatabaseReopen,
  UiActionError,
} from "./ui-error";

describe("normalizeUiError SQLite persistence failures", () => {
  it("shows only explicitly source-authored recovery messages verbatim", () => {
    expect(
      normalizeUiError(
        new UiActionError("SAFE_RECOVERY", "请返回作品库确认后重试。", "可以安全恢复"),
      ),
    ).toEqual({
      title: "可以安全恢复",
      description: "请返回作品库确认后重试。",
      code: "SAFE_RECOVERY",
    });
  });

  it("gives database-busy failures an actionable stable message", () => {
    expect(
      normalizeUiError(
        new AppError({
          code: "SAVE_FAILED",
          message: "internal",
          retryable: true,
          details: { databaseCode: "SQLITE_BUSY" },
        }),
      ),
    ).toEqual({
      title: "操作未完成",
      description: "本地数据库正忙，本次写入未被报告为成功。编辑器会保留当前文字，请稍后重试保存。",
      code: "SAVE_FAILED",
    });
  });

  it("does not claim a disk-full write was persisted", () => {
    expect(
      normalizeUiError(
        new AppError({
          code: "SAVE_FAILED",
          message: "internal",
          details: { databaseCode: "SQLITE_DISK_FULL" },
        }),
      ).description,
    ).toBe(
      "本地磁盘空间不足，本次写入未提交。请保持窗口打开，释放空间后重试，或将草稿导出到其他磁盘。",
    );
  });

  it.each(["SQLITE_WRITE_OUTCOME_UNKNOWN", "SQLITE_COMMIT_OUTCOME_UNKNOWN"])(
    "reports %s as unresolved and never suggests submitting the write again",
    (databaseCode) => {
      const privateDetail = "C:\\Users\\writer\\private.sqlite UPDATE chapters";
      const error = new AppError({
        code: "REPOSITORY_ERROR",
        message: privateDetail,
        retryable: false,
        actions: ["EXPORT_DRAFT"],
        details: { databaseCode, operation: privateDetail, outcome: "unknown" },
      });

      const ordinary = projectOrdinaryUiError(error);
      expect(ordinary).toEqual({
        title: "写入结果需要核对",
        description:
          "本机暂时无法确认这次写入是否已经完成。请重新打开当前页面，核对正文、版本和 AI 建议草稿状态；系统不会自动再次提交。",
      });
      expect(JSON.stringify(ordinary)).not.toContain(privateDetail);
      expect(ordinary.description).not.toContain(databaseCode);
      expect(isUiErrorRetryable(error)).toBe(false);
    },
  );

  it("reports a bounded local timeout without claiming success or exposing its stage", () => {
    const error = new AppError({
      code: "REPOSITORY_ERROR",
      message: "private native stage",
      retryable: true,
      actions: ["RETRY", "EXPORT_DRAFT"],
      details: {
        databaseCode: "SQLITE_OPERATION_TIMEOUT",
        operation: "private statement",
        outcome: "not_confirmed",
      },
    });

    const ordinary = projectOrdinaryUiError(error);
    expect(ordinary).toEqual({
      title: "本地操作等待超时",
      description:
        "本地数据操作等待超时，本次操作没有被报告为成功。请重新打开当前页面核对内容；系统不会自动重试。",
    });
    expect(JSON.stringify(ordinary)).not.toContain("private");
    expect(ordinary.description).not.toContain("SQLITE_OPERATION_TIMEOUT");
  });

  it("distinguishes errors that require a new native database session from safe same-session retries", () => {
    expect(
      requiresRuntimeDatabaseReopen(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "internal",
          details: { databaseCode: "SQLITE_OPERATION_TIMEOUT" },
        }),
      ),
    ).toBe(true);
    expect(requiresRuntimeDatabaseReopen({ code: "SQLITE_CONNECTION_INVALIDATED" })).toBe(true);
    expect(
      requiresRuntimeDatabaseReopen(
        new AppError({
          code: "SAVE_FAILED",
          message: "internal",
          details: { databaseCode: "SQLITE_BUSY" },
        }),
      ),
    ).toBe(false);
  });

  it.each([
    [
      "SQLITE_DATABASE_CORRUPT",
      "本地数据库文件已损坏。请不要反复重新加载；墨影保留了原文件，请从已验证的备份恢复。若没有可用备份，请联系支持。",
    ],
    [
      "SQLITE_MIGRATION_INTEGRITY_FAILED",
      "本地数据库迁移记录与此版本不一致。为防止数据被覆盖，墨影没有修改或替换原数据库。请保留原文件，使用与其匹配的版本或已验证备份恢复，并联系支持。",
    ],
  ])("renders terminal recovery guidance for %s", (code, description) => {
    const error = { code, message: "internal", retryable: false };
    expect(normalizeUiError(error)).toEqual({
      title: "操作未完成",
      description,
      code,
    });
    expect(isUiErrorRetryable(error)).toBe(false);
  });

  it("never renders a filesystem path from a native path-ticket diagnostic", () => {
    const rawPath = "C:\\Users\\writer\\private\\novel-backup.sqlite3";
    const normalized = normalizeUiError({
      code: "SQLITE_PATH_TICKET_INVALID",
      message: rawPath,
      retryable: false,
    });

    expect(normalized).toEqual({
      title: "操作未完成",
      description: "所选本地数据库文件授权已失效或不再匹配。请重新选择文件后再试。",
      code: "SQLITE_PATH_TICKET_INVALID",
    });
    expect(JSON.stringify(normalized)).not.toContain(rawPath);
  });

  it("preserves retry for transient native startup failures", () => {
    expect(
      isUiErrorRetryable({
        code: "SQLITE_BRIDGE_UNAVAILABLE",
        message: "temporarily unavailable",
        retryable: true,
      }),
    ).toBe(true);
  });

  it("redacts arbitrary native messages and always gives an actionable next step", () => {
    const privateDetail = "C:\\Users\\writer\\secret.txt Authorization: Bearer hidden";
    const normalized = normalizeUiError({
      code: "UNEXPECTED_NATIVE_FAILURE",
      message: privateDetail,
      retryable: false,
    });

    expect(normalized.description).toContain("请先重试");
    expect(normalized.description).toContain("脱敏诊断包");
    expect(JSON.stringify(normalized)).not.toContain(privateDetail);
  });

  it.each([
    ["FORMAL_RECORD_PLAN_MISMATCH", "这条建议依据的设定已经变化，请重新整理后再确认。"],
    [
      "DIFF_COMPLEXITY_LIMIT_EXCEEDED",
      "这次改动较长，无法安全逐句比较；你仍可查看完整建议并整段采用、另存或放弃。",
    ],
  ])("projects %s to ordinary UI without exposing its internal code", (code, description) => {
    const error = { code, message: "private implementation detail", retryable: false };

    expect(projectOrdinaryUiError(error)).toEqual({
      title: "操作未完成",
      description,
    });
    expect(projectOrdinaryUiError(error)).not.toHaveProperty("code");
    expect(normalizeUiError(error).code).toBe(code);
  });

  it.each([
    ["MODEL_OUTPUT_TRUNCATED", ["更充足的固定预算", "DeepSeek 关闭推理", "重新同步模型"]],
    ["MODEL_OUTPUT_EMPTY", ["可用于写作的可见文字", "支持文本生成", "普通文本模型"]],
    [
      "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      ["尚未选择负责这项写作的模型", "验证模型能力", "配置创作任务"],
    ],
    ["MODEL_HUB_ROUTE_DISABLED", ["创作任务已停用", "没有向模型发送内容", "不会改用旧设置"]],
    ["MODEL_PROFILE_NOT_READY", ["没有可用于这次写作", "继续手动编辑", "连接并验证一个文本模型"]],
    ["CREATIVE_INPUT_INVALID_CONTROL_CHARACTER", ["不可见控制字符", "全角标点", "换行仍然支持"]],
    [
      "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
      ["没有完整保存", "之前可用的选择仍保持不变", "重试“保存创作任务”"],
    ],
    [
      "MODEL_HUB_MANUAL_ROUTE_PRIVACY_CONFLICT",
      ["手动选择的云端模型", "没有覆盖", "本机模型或先停用"],
    ],
    ["IMPORT_ANALYSIS_ROUTE_NOT_CONFIGURED", ["作品分析", "模型中心", "已导入原文不会因此改变"]],
    ["IMPORT_JOURNEY_PERSIST_FAILED", ["本地导入进度", "保持当前页面打开", "不会被静默覆盖"]],
    [
      "IMPORT_PENDING_REQUEST_CLEAR_FAILED",
      ["未能清除请求恢复标记", "不会自动再次发送", "重新打开页面"],
    ],
    [
      "IMPORT_PENDING_REQUEST_PERSIST_FAILED",
      ["发送前保存请求恢复标记", "没有向模型发送内容", "释放存储空间"],
    ],
    ["EXTENSION_USAGE_UNAVAILABLE", ["没有返回可核对的用量", "正文没有被覆盖", "导出历史"]],
    [
      "CREATIVE_OPENING_TIMEOUT_SCOPE_MISMATCH",
      ["超时编号", "没有结束其他仍在进行的请求", "重新读取进度并核对本次发送信息"],
    ],
    ["UPDATE_MANIFEST_UNAVAILABLE", ["安全更新未完成", "仍可离线使用", "官方发行说明"]],
  ])("gives an actionable, redacted recovery path for %s", (code, expectedFragments) => {
    const privateDetail = "Authorization: Bearer hidden private provider response";
    const normalized = normalizeUiError({ code, message: privateDetail, retryable: true });

    for (const fragment of expectedFragments) {
      expect(normalized.description).toContain(fragment);
    }
    expect(normalized.description).not.toContain(privateDetail);
  });

  it.each([
    "MODEL_HUB_ROUTE_NOT_CONFIGURED",
    "MODEL_HUB_ROUTE_DISABLED",
    "MODEL_PROFILE_NOT_READY",
    "IMPORT_ANALYSIS_ROUTE_NOT_CONFIGURED",
  ])(
    "keeps ordinary recovery copy task-led and free of internal model-hub terms for %s",
    (code) => {
      const ordinary = projectOrdinaryUiError({
        code,
        message: "private route detail",
        retryable: true,
      });

      expect(ordinary.description).not.toMatch(/AI 分工|向量检索|路由|MODEL_|UUID|项目标识/u);
      expect(ordinary.description).not.toContain("private route detail");
    },
  );

  it("describes a model timeout without blaming credentials, accounts, or the network", () => {
    const ordinary = projectOrdinaryUiError({ code: "MODEL_TIMEOUT", message: "private" });
    expect(ordinary.description).toContain("模型");
    expect(ordinary.description).toContain("不会自动重试");
    expect(ordinary.description).not.toMatch(/网络|密钥|账号|权限/u);
  });

  it("explains how to recover from browser storage quota exhaustion", () => {
    const normalized = normalizeUiError({
      code: "CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED",
      message: "private browser detail",
      retryable: true,
    });

    expect(normalized.code).toBe("CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED");
    expect(normalized.description).toContain("释放设备或浏览器存储空间");
    expect(normalized.description).toContain("再次点击原来的创建或保存操作");
    expect(normalized.description).toContain("当前输入仍保留在页面中");
    expect(normalized.description).not.toContain("private browser detail");
  });

  it("explains how to recover when browser storage permission is denied", () => {
    const normalized = normalizeUiError({
      code: "CREATIVE_JOURNEY_STORAGE_ACCESS_DENIED",
      message: "private browser detail",
      retryable: true,
    });

    expect(normalized.code).toBe("CREATIVE_JOURNEY_STORAGE_ACCESS_DENIED");
    expect(normalized.description).toContain("允许墨影使用本地存储");
    expect(normalized.description).toContain("再次点击原来的创建或保存操作");
    expect(normalized.description).not.toContain("private browser detail");
  });
});
