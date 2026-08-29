import { afterEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

import {
  ExportArtifactSaveError,
  downloadBrowserExportArtifact,
  persistLastExportReceipt,
  readLastExportReceipt,
  saveExportArtifact,
} from "./export-artifact-download";

const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

afterEach(() => {
  restoreProperty("createObjectURL", originalCreate);
  restoreProperty("revokeObjectURL", originalRevoke);
  vi.useRealTimers();
  tauriMocks.invoke.mockReset();
  window.localStorage.clear();
});

describe("downloadBrowserExportArtifact", () => {
  it("downloads UTF-8 text and retains the object URL long enough for the browser", () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.fn((blob: Blob) => {
      void blob;
      return "blob:inkshadow-text";
    });
    const revokeObjectUrl = vi.fn();
    installUrlMethods(createObjectUrl, revokeObjectUrl);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const receipt = downloadBrowserExportArtifact({
      fileName: "墨影.md",
      mediaType: "text/markdown",
      content: "# 墨影\n",
    });

    expect(receipt).toMatchObject({
      fileName: "墨影.md",
      mediaType: "text/markdown",
    });
    expect(receipt.byteLength).toBe(new TextEncoder().encode("# 墨影\n").byteLength);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:inkshadow-text");
  });

  it("copies binary bytes into a Blob and rejects unsafe metadata", () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.fn((blob: Blob) => {
      void blob;
      return "blob:inkshadow-binary";
    });
    installUrlMethods(createObjectUrl, vi.fn());
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    expect(
      downloadBrowserExportArtifact({
        fileName: "墨影.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      }),
    ).toMatchObject({ byteLength: 4 });
    const blob = createObjectUrl.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(() =>
      downloadBrowserExportArtifact({
        fileName: "../secret.pdf",
        mediaType: "application/pdf",
        content: new Uint8Array([1]),
      }),
    ).toThrow("The export file name is unsafe.");
    expect(() =>
      downloadBrowserExportArtifact({
        fileName: "empty.pdf",
        mediaType: "application/pdf\r\nx-header: injected",
        content: new Uint8Array([1]),
      }),
    ).toThrow("The export media type is invalid.");
  });

  it("revokes immediately when the browser click path throws", () => {
    const revokeObjectUrl = vi.fn();
    installUrlMethods(
      vi.fn((blob: Blob) => {
        void blob;
        return "blob:inkshadow-failed";
      }),
      revokeObjectUrl,
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("download blocked");
    });

    expect(() =>
      downloadBrowserExportArtifact({
        fileName: "墨影.txt",
        mediaType: "text/plain",
        content: "正文",
      }),
    ).toThrow("download blocked");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:inkshadow-failed");
  });

  it("labels a browser download request without claiming a verified save path", async () => {
    vi.useFakeTimers();
    installUrlMethods(
      vi.fn(() => "blob:inkshadow-browser"),
      vi.fn(),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const receipt = await saveExportArtifact(
      {
        fileName: "墨影.md",
        mediaType: "text/markdown",
        content: "# 墨影\n",
      },
      { format: "markdown", mode: "browser-development" },
    );

    expect(receipt).toEqual({
      format: "markdown",
      fileName: "墨影.md",
      path: "浏览器下载位置（应用无法读取）",
      byteLength: new TextEncoder().encode("# 墨影\n").byteLength,
      mediaType: "text/markdown",
      status: "browser_download",
      verification: "path_not_available",
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("uses a one-time native destination and accepts only a verified write receipt", async () => {
    const destinationStates: string[] = [];
    tauriMocks.invoke
      .mockResolvedValueOnce({
        ticket: "a".repeat(64),
        fileName: "墨影定稿.md",
      })
      .mockResolvedValueOnce({
        format: "markdown",
        fileName: "墨影定稿.md",
        path: "D:\\作品\\墨影定稿.md",
        byteLength: 19,
        status: "success",
        verified: true,
      });

    const receipt = await saveExportArtifact(
      {
        fileName: "墨影.md",
        mediaType: "text/markdown",
        content: "第一章\n雨夜。",
      },
      {
        format: "markdown",
        mode: "tauri",
        onDestinationPromptChange: (open) => destinationStates.push(open ? "open" : "closed"),
      },
    );

    expect(receipt).toEqual({
      format: "markdown",
      fileName: "墨影定稿.md",
      path: "D:\\作品\\墨影定稿.md",
      byteLength: 19,
      mediaType: "text/markdown",
      status: "success",
      verification: "verified",
    });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "native_choose_export_destination", {
      request: {
        defaultFileName: "墨影.md",
        format: "markdown",
        mediaType: "text/markdown",
      },
    });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "native_write_export_artifact", {
      request: {
        destinationTicket: "a".repeat(64),
        format: "markdown",
        mediaType: "text/markdown",
        expectedByteLength: 19,
        contentBase64: "56ys5LiA56ugCumbqOWknOOAgg==",
      },
    });
    expect(destinationStates).toEqual(["open", "closed"]);
  });

  it("keeps cancellation at zero writes and marks a dispatched native write as unknown", async () => {
    tauriMocks.invoke.mockResolvedValueOnce(null);
    const cancelled = await saveExportArtifact(
      { fileName: "墨影.pdf", mediaType: "application/pdf", content: new Uint8Array([1, 2]) },
      { format: "pdf", mode: "tauri" },
    );
    expect(cancelled).toMatchObject({
      path: "未选择保存位置",
      byteLength: 0,
      status: "cancelled",
      verification: "not_written",
    });
    expect(tauriMocks.invoke).toHaveBeenCalledOnce();

    tauriMocks.invoke
      .mockReset()
      .mockResolvedValueOnce({ ticket: "b".repeat(64), fileName: "私人目录.pdf" })
      .mockRejectedValueOnce({
        code: "EXPORT_SAVE_FAILED",
        message: "D:\\private\\should-not-leak.pdf",
      });
    const failure = await saveExportArtifact(
      { fileName: "墨影.pdf", mediaType: "application/pdf", content: new Uint8Array([1, 2]) },
      { format: "pdf", mode: "tauri" },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExportArtifactSaveError);
    expect(failure).toMatchObject({
      receipt: {
        fileName: "私人目录.pdf",
        path: "保存位置已隐藏（写入结果不明确）",
        byteLength: 2,
        status: "failed",
        verification: "write_result_unknown",
      },
    });
    expect((failure as Error).message).toContain("文件可能已经写入");
    expect((failure as Error).message).not.toContain("private");
    expect(JSON.stringify((failure as ExportArtifactSaveError).receipt)).not.toContain("private");
  });

  it("persists only a strictly validated project-scoped receipt for reload", () => {
    const receipt = {
      format: "docx" as const,
      fileName: "墨影.docx",
      path: "D:\\作品\\墨影.docx",
      byteLength: 4096,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      status: "success" as const,
      verification: "verified" as const,
    };
    persistLastExportReceipt(window.localStorage, "project-one", receipt);
    expect(readLastExportReceipt(window.localStorage, "project-one")).toEqual(receipt);
    expect(readLastExportReceipt(window.localStorage, "project-two")).toBeNull();

    window.localStorage.setItem(
      "inkshadow.export.last-receipt.v1",
      JSON.stringify({
        projectId: "project-one",
        receipt: { ...receipt, path: "relative\\escape.docx" },
      }),
    );
    expect(readLastExportReceipt(window.localStorage, "project-one")).toBeNull();

    const unknownReceipt = {
      ...receipt,
      fileName: "墨影-待确认.docx",
      path: "保存位置已隐藏（写入结果不明确）",
      byteLength: 4096,
      status: "failed" as const,
      verification: "write_result_unknown" as const,
    };
    persistLastExportReceipt(window.localStorage, "project-one", unknownReceipt);
    expect(readLastExportReceipt(window.localStorage, "project-one")).toEqual(unknownReceipt);

    window.localStorage.setItem(
      "inkshadow.export.last-receipt.v1",
      JSON.stringify({
        projectId: "project-one",
        receipt: { ...unknownReceipt, byteLength: 0 },
      }),
    );
    expect(readLastExportReceipt(window.localStorage, "project-one")).toBeNull();
  });
});

function installUrlMethods(
  createObjectUrl: (blob: Blob) => string,
  revokeObjectUrl: (url: string) => void,
): void {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectUrl,
  });
}

function restoreProperty(
  property: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(URL, property);
  } else {
    Object.defineProperty(URL, property, descriptor);
  }
}
