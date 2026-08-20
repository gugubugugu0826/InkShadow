import { AppError } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import {
  isUiErrorRetryable,
  normalizeUiError,
  projectOrdinaryUiError,
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
      ["验证至少一个模型的写作能力", "应用智能推荐", "缺少 Embedding 不会阻止"],
    ],
    ["MODEL_HUB_ROUTE_DISABLED", ["已明确停用", "没有调用模型", "不会改用旧配置"]],
    ["MODEL_PROFILE_NOT_READY", ["没有可用于这次写作", "继续手动编辑", "前往 Model Hub"]],
    ["CREATIVE_INPUT_INVALID_CONTROL_CHARACTER", ["不可见控制字符", "全角标点", "换行仍然支持"]],
    [
      "MODEL_HUB_ROUTING_PLAN_WRITE_FAILED",
      ["没有完整写入", "之前可用的分工仍保持不变", "重试“应用 AI 分工”"],
    ],
    [
      "MODEL_HUB_MANUAL_ROUTE_PRIVACY_CONFLICT",
      ["手动设置的云端任务", "没有覆盖", "本机模型或先停用"],
    ],
    ["IMPORT_ANALYSIS_ROUTE_NOT_CONFIGURED", ["作品分析", "模型设置", "已导入原文不会因此改变"]],
    ["IMPORT_JOURNEY_PERSIST_FAILED", ["本地导入进度", "保持当前页面打开", "不会被静默覆盖"]],
    [
      "IMPORT_PENDING_REQUEST_CLEAR_FAILED",
      ["未能清除请求恢复标记", "不会自动重复调用", "重新打开页面"],
    ],
    [
      "IMPORT_PENDING_REQUEST_PERSIST_FAILED",
      ["发送前保存请求恢复标记", "没有调用模型", "释放存储空间"],
    ],
    ["EXTENSION_USAGE_UNAVAILABLE", ["没有返回可核对的用量", "正文没有被覆盖", "导出历史"]],
    ["UPDATE_MANIFEST_UNAVAILABLE", ["安全更新未完成", "仍可离线使用", "官方发行说明"]],
  ])("gives an actionable, redacted recovery path for %s", (code, expectedFragments) => {
    const privateDetail = "Authorization: Bearer hidden private provider response";
    const normalized = normalizeUiError({ code, message: privateDetail, retryable: true });

    for (const fragment of expectedFragments) {
      expect(normalized.description).toContain(fragment);
    }
    expect(normalized.description).not.toContain(privateDetail);
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
    expect(normalized.description).toContain("允许 InkShadow 使用本地存储");
    expect(normalized.description).toContain("再次点击原来的创建或保存操作");
    expect(normalized.description).not.toContain("private browser detail");
  });
});
