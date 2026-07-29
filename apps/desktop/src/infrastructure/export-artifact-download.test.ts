import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadBrowserExportArtifact } from "./export-artifact-download";

const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

afterEach(() => {
  restoreProperty("createObjectURL", originalCreate);
  restoreProperty("revokeObjectURL", originalRevoke);
  vi.useRealTimers();
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
