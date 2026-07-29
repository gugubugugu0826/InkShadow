import { describe, expect, it } from "vitest";

import { GuestWorkspaceError } from "../src/domain/guest-workspace-error";
import { toIndexedDbWriteError } from "../src/infrastructure/indexed-db-encrypted-project-store";

describe("IndexedDB encrypted store error mapping", () => {
  it("maps browser quota exhaustion to a stable retryable fail-closed error", () => {
    const mapped = toIndexedDbWriteError(
      new DOMException("quota reached", "QuotaExceededError"),
      "fallback",
    );

    expect(mapped).toMatchObject({
      code: "WEB_STORAGE_QUOTA_EXCEEDED",
      retryable: true,
    });
    expect(mapped.message).toContain("未提交本次密文");
  });

  it("preserves an authoritative revision conflict instead of masking it", () => {
    const conflict = new GuestWorkspaceError("WEB_REVISION_CONFLICT", "conflict", true);

    expect(toIndexedDbWriteError(conflict, "fallback")).toBe(conflict);
  });

  it("maps unknown transaction failures without leaking the browser error", () => {
    const mapped = toIndexedDbWriteError(
      new Error("sensitive vendor-specific details"),
      "浏览器未能提交加密章节，原密文版本保持不变。",
    );

    expect(mapped).toMatchObject({
      code: "WEB_STORAGE_FAILED",
      retryable: true,
      message: "浏览器未能提交加密章节，原密文版本保持不变。",
    });
    expect(mapped.message).not.toContain("vendor-specific");
  });
});
