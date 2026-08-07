import { AppError } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { isUiErrorRetryable, normalizeUiError, UiActionError } from "./ui-error";

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
});
