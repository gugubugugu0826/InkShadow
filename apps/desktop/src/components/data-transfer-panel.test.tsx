import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { DataTransferPanel } from "./data-transfer-panel";

describe("DataTransferPanel import journey", () => {
  beforeEach(() => {
    window.localStorage.clear();
    tauriMocks.invoke.mockReset();
  });

  it("shows the five formats, previews bytes without writing, then commits edited candidates", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <RuntimeProvider runtime={runtime}>
          <DataTransferPanel />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "导入与导出", level: 2 })).toBeInTheDocument();
    for (const format of ["MD", "DOCX", "EPUB", "HTML", "PDF", "TXT"]) {
      expect(screen.getByText(format)).toBeInTheDocument();
    }
    expect(screen.getByText(/单文件与单次选择均不超过 50 兆字节/)).toBeInTheDocument();

    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) {
      throw new Error("Expected the import file input.");
    }
    const file = new File(
      [new TextEncoder().encode("<article><h1>雨夜</h1><p>门开了。</p></article>")],
      "opening.html",
      { type: "text/html" },
    );
    await user.upload(fileInput, file);

    await screen.findByText("预检通过，尚未写入项目");
    expect(screen.getByRole("list", { name: "预检提示" })).toHaveTextContent(
      "HTML 标签和属性已移除，仅保留本地文本。",
    );
    expect(screen.queryByText(/HTML_MARKUP_REMOVED/u)).not.toBeInTheDocument();
    await expect(
      runtime.useCases.listProjects.execute({ statuses: ["active"] }),
    ).resolves.toMatchObject({ ok: true, value: [] });

    const chapterTitle = screen.getByRole("textbox", { name: "章节标题" });
    await user.clear(chapterTitle);
    await user.type(chapterTitle, "第一章 雨夜");
    await user.clear(screen.getByRole("textbox", { name: "导入为项目名称" }));
    await user.type(screen.getByRole("textbox", { name: "导入为项目名称" }), "雨夜长篇");
    await user.click(screen.getByRole("button", { name: "确认导入" }));

    await screen.findByText(/雨夜长篇 已写入 1 个章节/);
    await waitFor(async () => {
      const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
      expect(projects).toMatchObject({ ok: true });
      if (!projects.ok) {
        return;
      }
      expect(projects.value.map(({ name }) => name)).toEqual(["雨夜长篇"]);
      const project = projects.value[0];
      if (project === undefined) {
        return;
      }
      const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
      expect(chapters).toMatchObject({ ok: true });
      if (chapters.ok) {
        expect(chapters.value[0]).toMatchObject({
          title: "第一章 雨夜",
        });
        expect(chapters.value[0]?.content).toContain("门开了");
      }
    });
  });

  it("requires every low-confidence chapter boundary to be reviewed across preview pages", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <RuntimeProvider runtime={runtime}>
          <DataTransferPanel />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) {
      throw new Error("Expected the import file input.");
    }
    const files = Array.from({ length: 6 }, (_, index) => {
      const bytes = createDocxFixture([`这是第 ${String(index + 1)} 个没有章节标题的正文。`]);
      return new File([new Uint8Array(bytes)], `part-${String(index + 1)}.docx`, {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    });
    await user.upload(fileInput, files);

    await screen.findByText("预检通过，尚未写入项目");
    const commitButton = screen.getByRole("button", { name: "确认导入" });
    expect(commitButton).toBeDisabled();
    expect(screen.getAllByRole("checkbox", { name: /我已检查此章节/ })).toHaveLength(5);

    for (const checkbox of screen.getAllByRole("checkbox", { name: /我已检查此章节/ })) {
      await user.click(checkbox);
    }
    expect(commitButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "下一组章节" }));
    expect(screen.getByText("第 2 / 2 组")).toBeInTheDocument();
    const finalCheckbox = screen.getByRole("checkbox", { name: /我已检查此章节/ });
    await user.click(finalCheckbox);
    expect(commitButton).toBeEnabled();

    await user.click(commitButton);
    await screen.findByText(/已写入 6 个章节/);
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects).toMatchObject({ ok: true });
    if (projects.ok) {
      const project = projects.value[0];
      if (project === undefined) {
        throw new Error("Expected an imported project.");
      }
      const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
      expect(chapters).toMatchObject({ ok: true });
      if (chapters.ok) {
        expect(chapters.value).toHaveLength(6);
        expect(chapters.value.some(({ content }) => content.includes("第 6 个"))).toBe(true);
      }
    }
  });

  it("keeps zero projects when import preflight rejects a file", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const executeImport = vi.spyOn(runtime.useCases.importProject, "execute");
    const user = userEvent.setup({ applyAccept: false });
    const view = render(
      <MemoryRouter>
        <RuntimeProvider runtime={runtime}>
          <DataTransferPanel />
        </RuntimeProvider>
      </MemoryRouter>,
    );
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) throw new Error("Expected the import file input.");

    await user.upload(
      fileInput,
      new File([new Uint8Array([0, 1, 2, 3])], "unsafe.exe", {
        type: "application/octet-stream",
      }),
    );

    expect(await screen.findByRole("list", { name: "预检提示" })).toHaveTextContent(
      "文件扩展名不受支持。",
    );
    expect(executeImport).not.toHaveBeenCalled();
    await expect(
      runtime.useCases.listProjects.execute({
        statuses: ["active", "archived", "trashed"],
      }),
    ).resolves.toMatchObject({ ok: true, value: [] });
  });

  it("cancels an in-progress preflight without calling the atomic import", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const executeImport = vi.spyOn(runtime.useCases.importProject, "execute");
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <RuntimeProvider runtime={runtime}>
          <DataTransferPanel />
        </RuntimeProvider>
      </MemoryRouter>,
    );
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) throw new Error("Expected the import file input.");
    let streamCancelled = false;
    const file = new File([new Uint8Array([65])], "pending.txt", {
      type: "text/plain",
    });
    Object.defineProperty(file, "stream", {
      configurable: true,
      value: () =>
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => undefined),
          cancel: () => {
            streamCancelled = true;
          },
        }),
    });

    await user.upload(fileInput, file);
    await user.click(await screen.findByRole("button", { name: "取消预检" }));

    await waitFor(() => expect(streamCancelled).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "取消预检" })).not.toBeInTheDocument(),
    );
    expect(executeImport).not.toHaveBeenCalled();
    expect(screen.queryByText("预检通过，尚未写入项目")).not.toBeInTheDocument();
    await expect(
      runtime.useCases.listProjects.execute({
        statuses: ["active", "archived", "trashed"],
      }),
    ).resolves.toMatchObject({ ok: true, value: [] });
  });

  it("downloads a selected project-scoped domain report", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "可导出项目" });
    if (!created.ok) {
      throw created.error;
    }
    const createObjectUrl = vi.fn(() => "blob:inkshadow-report");
    const revokeObjectUrl = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <RuntimeProvider runtime={runtime}>
            <DataTransferPanel />
          </RuntimeProvider>
        </MemoryRouter>,
      );

      await screen.findByRole("option", { name: "可导出项目" });
      await user.selectOptions(screen.getByRole("combobox", { name: /^领域报告/u }), "ai_usage");
      await user.click(screen.getByRole("button", { name: "下载领域报告" }));

      await screen.findByText(/文件：可导出项目-AI用量报告\.json.*内容：0 条记录/u);
      expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
      expect(click).toHaveBeenCalledOnce();
    } finally {
      restoreProperty(URL, "createObjectURL", originalCreate);
      restoreProperty(URL, "revokeObjectURL", originalRevoke);
    }
  });

  it("writes the running desktop version into exported Bundle metadata", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "版本一致性" });
    if (!created.ok) {
      throw created.error;
    }
    const createObjectUrl = vi.fn((artifact: Blob | MediaSource) => {
      void artifact;
      return "blob:inkshadow-bundle";
    });
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <RuntimeProvider runtime={runtime}>
            <DataTransferPanel />
          </RuntimeProvider>
        </MemoryRouter>,
      );

      await screen.findByRole("option", { name: "版本一致性" });
      expect(
        screen.getAllByText(/项目包.*项目、章节标识.*生成器信息.*不是本地数据库完整备份/u),
      ).toHaveLength(2);
      expect(screen.getByText(/私密内容会离开本地保护/u)).toBeVisible();
      expect(screen.queryByText(/私密正文及其直接分析记录会写入导出文件/u)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "下载项目包" }));
      expect(await screen.findByText(/格式：墨影项目包/u)).toHaveTextContent(
        "文件：版本一致性.inkshadow.json",
      );

      const downloaded = createObjectUrl.mock.calls[0]?.[0];
      expect(downloaded).toBeInstanceOf(Blob);
      if (downloaded instanceof Blob) {
        const bytes = new Uint8Array(await downloaded.arrayBuffer());
        const bundle = JSON.parse(new TextDecoder().decode(bytes)) as {
          readonly manifest: { readonly generator: { readonly version: string } };
        };
        const information = await runtime.getRuntimeInformation();
        expect(bundle.manifest.generator.version).toBe(information.appVersion);
      }
      expect(click).toHaveBeenCalledOnce();
    } finally {
      restoreProperty(URL, "createObjectURL", originalCreate);
      restoreProperty(URL, "revokeObjectURL", originalRevoke);
    }
  });

  it("shows verified, cancelled, and unknown native Markdown write outcomes", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const runtime = Object.freeze({ ...development, mode: "tauri" as const });
    const created = await runtime.useCases.createProject.execute({ name: "原生回执长篇" });
    if (!created.ok) {
      throw created.error;
    }
    tauriMocks.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "native_choose_export_destination") {
        return Promise.resolve({
          ticket: "c".repeat(64),
          fileName: "原生回执长篇-定稿.md",
        });
      }
      if (command === "native_write_export_artifact") {
        const request = (args as { readonly request: { readonly expectedByteLength: number } })
          .request;
        return Promise.resolve({
          format: "markdown",
          fileName: "原生回执长篇-定稿.md",
          path: "D:\\作品\\原生回执长篇-定稿.md",
          byteLength: request.expectedByteLength,
          status: "success",
          verified: true,
        });
      }
      return Promise.reject(new Error("unexpected native command"));
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <RuntimeProvider runtime={runtime}>
          <DataTransferPanel />
        </RuntimeProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("option", { name: "原生回执长篇" });
    await user.click(screen.getByRole("button", { name: "保存 Markdown" }));
    expect(await screen.findByText(/状态：已写入并从磁盘回读核验/u)).toHaveTextContent(
      "位置：D:\\作品\\原生回执长篇-定稿.md",
    );
    expect(screen.getByText(/格式：Markdown/u)).toHaveTextContent("文件：原生回执长篇-定稿.md");
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
    expect(anchorClick).not.toHaveBeenCalled();

    view.unmount();
    render(
      <MemoryRouter>
        <RuntimeProvider runtime={runtime}>
          <DataTransferPanel />
        </RuntimeProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/状态：已写入并从磁盘回读核验/u)).toHaveTextContent(
      "原生回执长篇-定稿.md",
    );
    expect(screen.getByText("上次导出完成")).toBeVisible();
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);

    tauriMocks.invoke.mockReset().mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "保存 Markdown" }));
    expect(await screen.findByText("已取消保存")).toBeVisible();
    expect(screen.getByText(/状态：已取消，写入 0 B/u)).toHaveTextContent("位置：未选择保存位置");
    expect(tauriMocks.invoke).toHaveBeenCalledOnce();
    expect(anchorClick).not.toHaveBeenCalled();

    tauriMocks.invoke
      .mockReset()
      .mockResolvedValueOnce({
        ticket: "d".repeat(64),
        fileName: "原生回执长篇-待确认.md",
      })
      .mockRejectedValueOnce({
        code: "EXPORT_SAVE_OUTCOME_UNKNOWN",
        message: "D:\\private\\must-not-leak.md",
      });
    await user.click(screen.getByRole("button", { name: "保存 Markdown" }));
    expect(await screen.findByText("保存结果待确认")).toBeVisible();
    const unknownNotice = screen.getByText(/状态：保存结果不明确/u);
    expect(unknownNotice).toHaveTextContent("文件可能已写入");
    expect(unknownNotice).toHaveTextContent("位置：保存位置已隐藏（写入结果不明确）");
    expect(unknownNotice).toHaveTextContent("待写入内容：");
    expect(unknownNotice).not.toHaveTextContent("private");
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(2);
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it("excludes private chapters by default and refuses a project package that would lose privacy", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "隐私导出" });
    if (!created.ok) throw created.error;
    const publicChapter = await runtime.useCases.createChapter.execute({
      projectId: created.value.id,
      title: "公开章",
      content: "可以进入普通导出的正文。",
    });
    const privateChapter = await runtime.useCases.createChapter.execute({
      projectId: created.value.id,
      title: "私密章",
      content: "PRIVATE_CHAPTER_MUST_REQUIRE_OPT_IN",
    });
    if (!publicChapter.ok || !privateChapter.ok) throw new Error("测试章节创建失败");
    const privacy = await runtime.useCases.setChapterPrivacy.execute({
      chapterId: privateChapter.value.chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: privateChapter.value.chapter.privacyRevision,
    });
    if (!privacy.ok) throw privacy.error;

    const blobs: Blob[] = [];
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((artifact: Blob) => {
        blobs.push(artifact);
        return `blob:inkshadow-private-${String(blobs.length)}`;
      }),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <RuntimeProvider runtime={runtime}>
            <DataTransferPanel />
          </RuntimeProvider>
        </MemoryRouter>,
      );

      await screen.findByRole("option", { name: "隐私导出" });
      const includePrivate = screen.getByRole("checkbox", { name: /包含私密章节/u });
      expect(includePrivate).not.toBeChecked();
      await user.click(screen.getByRole("button", { name: "下载项目包" }));
      expect(await screen.findByText(/排除 1 个私密章节/u)).toBeVisible();

      const safeBundle = await readPortableBundle(blobs[0]);
      expect(safeBundle.content.chapters.map(({ title }) => title)).toEqual(["公开章"]);
      expect(JSON.stringify(safeBundle)).not.toContain("PRIVATE_CHAPTER_MUST_REQUIRE_OPT_IN");

      await user.click(includePrivate);
      await user.click(screen.getByRole("button", { name: "下载项目包" }));
      expect(await screen.findByText(/项目包不能保存私密标记.*本次未导出/u)).toBeVisible();
      expect(blobs).toHaveLength(1);
      expect(click).toHaveBeenCalledOnce();

      await user.click(screen.getByRole("button", { name: "下载 Markdown" }));
      await waitFor(() => expect(blobs).toHaveLength(2));
      expect(await blobs[1]?.text()).toContain("PRIVATE_CHAPTER_MUST_REQUIRE_OPT_IN");
      expect(click).toHaveBeenCalledTimes(2);
    } finally {
      restoreProperty(URL, "createObjectURL", originalCreate);
      restoreProperty(URL, "revokeObjectURL", originalRevoke);
    }
  });

  it("generates and downloads a project as a real DOCX package", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "雾港交付稿" });
    if (!created.ok) {
      throw created.error;
    }
    const createObjectUrl = vi.fn((artifact: Blob | MediaSource) => {
      void artifact;
      return "blob:inkshadow-docx";
    });
    const revokeObjectUrl = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <RuntimeProvider runtime={runtime}>
            <DataTransferPanel />
          </RuntimeProvider>
        </MemoryRouter>,
      );

      await screen.findByRole("option", { name: "雾港交付稿" });
      await user.click(screen.getByRole("button", { name: "下载 DOCX" }));

      await screen.findByText(/文件：雾港交付稿\.docx/u);
      expect(click).toHaveBeenCalledOnce();
      const downloaded = createObjectUrl.mock.calls[0]?.[0];
      expect(downloaded).toBeInstanceOf(Blob);
      if (downloaded instanceof Blob) {
        expect(downloaded.type).toBe(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        expect(downloaded.size).toBeGreaterThan(0);
      }
    } finally {
      restoreProperty(URL, "createObjectURL", originalCreate);
      restoreProperty(URL, "revokeObjectURL", originalRevoke);
    }
  });

  it("generates and downloads a project as a real EPUB package", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "雾港电子书" });
    if (!created.ok) {
      throw created.error;
    }
    const createObjectUrl = vi.fn((artifact: Blob | MediaSource) => {
      void artifact;
      return "blob:inkshadow-epub";
    });
    const revokeObjectUrl = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    let suggestedFilename = "";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      suggestedFilename = this.download;
    });

    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <RuntimeProvider runtime={runtime}>
            <DataTransferPanel />
          </RuntimeProvider>
        </MemoryRouter>,
      );

      await screen.findByRole("option", { name: "雾港电子书" });
      await user.click(screen.getByRole("button", { name: "下载 EPUB" }));

      await screen.findByText(/文件：雾港电子书\.epub/u);
      expect(click).toHaveBeenCalledOnce();
      expect(suggestedFilename).toBe("雾港电子书.epub");
      const downloaded = createObjectUrl.mock.calls[0]?.[0];
      expect(downloaded).toBeInstanceOf(Blob);
      if (downloaded instanceof Blob) {
        expect(downloaded.type).toBe("application/epub+zip");
        const bytes = new Uint8Array(await downloaded.arrayBuffer());
        expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
        expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe("mimetype");
      }
    } finally {
      restoreProperty(URL, "createObjectURL", originalCreate);
      restoreProperty(URL, "revokeObjectURL", originalRevoke);
    }
  });

  it("rasterizes Chinese locally and downloads a validated image-based PDF", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "雾港定稿" });
    if (!created.ok) {
      throw created.error;
    }
    const createObjectUrl = vi.fn((artifact: Blob | MediaSource) => {
      void artifact;
      return "blob:inkshadow-pdf";
    });
    const revokeObjectUrl = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const originalGetContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    const originalToBlob = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toBlob");
    const fillText = vi.fn();
    const drawingContext = createPdfCanvasContextFixture(fillText);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => drawingContext),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => {
        const jpeg = createPdfJpegFixture();
        callback(new Blob([jpeg.buffer as ArrayBuffer], { type: "image/jpeg" }));
      }),
    });
    let suggestedFilename = "";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      suggestedFilename = this.download;
    });

    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <RuntimeProvider runtime={runtime}>
            <DataTransferPanel />
          </RuntimeProvider>
        </MemoryRouter>,
      );

      await screen.findByRole("option", { name: "雾港定稿" });
      await user.click(screen.getByRole("button", { name: "下载 PDF" }));

      await screen.findByText(/文件：雾港定稿\.pdf.*内容：1 页图像型 PDF/u);
      expect(click).toHaveBeenCalledOnce();
      expect(suggestedFilename).toBe("雾港定稿.pdf");
      expect(fillText).toHaveBeenCalledWith("雾港定稿", expect.any(Number), expect.any(Number));
      const downloaded = createObjectUrl.mock.calls[0]?.[0];
      expect(downloaded).toBeInstanceOf(Blob);
      if (downloaded instanceof Blob) {
        expect(downloaded.type).toBe("application/pdf");
        const bytes = new Uint8Array(await downloaded.arrayBuffer());
        expect([...bytes.subarray(0, 8)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
        expect(new TextDecoder("windows-1252").decode(bytes)).toContain(
          "/Subject <FEFF0049006D006100670065002D00620061007300650064",
        );
      }
    } finally {
      restoreProperty(URL, "createObjectURL", originalCreate);
      restoreProperty(URL, "revokeObjectURL", originalRevoke);
      restorePrototypeProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
      restorePrototypeProperty(HTMLCanvasElement.prototype, "toBlob", originalToBlob);
    }
  });
});

async function readPortableBundle(blob: Blob | undefined): Promise<{
  readonly content: {
    readonly chapters: readonly Readonly<{ readonly title: string; readonly markdown: string }>[];
  };
}> {
  if (blob === undefined) throw new Error("没有捕获到导出的 Bundle。");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return JSON.parse(new TextDecoder().decode(bytes)) as {
    readonly content: {
      readonly chapters: readonly Readonly<{ readonly title: string; readonly markdown: string }>[];
    };
  };
}

function restoreProperty(
  target: typeof URL,
  property: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property);
  } else {
    Object.defineProperty(target, property, descriptor);
  }
}

function restorePrototypeProperty(
  target: HTMLCanvasElement,
  property: "getContext" | "toBlob",
  descriptor: PropertyDescriptor | undefined,
): void;
function restorePrototypeProperty(
  target: typeof HTMLCanvasElement.prototype,
  property: "getContext" | "toBlob",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property);
  } else {
    Object.defineProperty(target, property, descriptor);
  }
}

function createPdfCanvasContextFixture(
  fillText: ReturnType<typeof vi.fn>,
): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    fillRect: vi.fn(),
    fillText,
    lineTo: vi.fn(),
    measureText: vi.fn((value: string) => ({ width: Array.from(value).length * 20 })),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function createPdfJpegFixture(): Uint8Array {
  const width = 1_240;
  const height = 1_754;
  const components = 3;
  const componentTable = Array.from({ length: components }, (_value, index) => [
    index + 1,
    0x11,
    0,
  ]).flat();
  const frameLength = 8 + componentTable.length;
  const scanComponents = Array.from({ length: components }, (_value, index) => [
    index + 1,
    0,
  ]).flat();
  const scanLength = 6 + scanComponents.length;
  const quantizationTable = Array.from({ length: 64 }, () => 1);
  const singleCodeLengths = [1, ...Array.from({ length: 15 }, () => 0)];
  const huffmanTables = [0, ...singleCodeLengths, 0, 0x10, ...singleCodeLengths, 0];
  const huffmanLength = 2 + huffmanTables.length;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xdb,
    0,
    67,
    0,
    ...quantizationTable,
    0xff,
    0xc4,
    (huffmanLength >> 8) & 0xff,
    huffmanLength & 0xff,
    ...huffmanTables,
    0xff,
    0xc0,
    (frameLength >> 8) & 0xff,
    frameLength & 0xff,
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    components,
    ...componentTable,
    0xff,
    0xda,
    (scanLength >> 8) & 0xff,
    scanLength & 0xff,
    components,
    ...scanComponents,
    0,
    63,
    0,
    0x20,
    0x11,
    0x22,
    0xff,
    0xd9,
  ]);
}

function createDocxFixture(paragraphs: readonly string[]): Uint8Array {
  return createStoredZip([
    [
      "[Content_Types].xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        "</Types>",
      ].join(""),
    ],
    [
      "_rels/.rels",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
        "</Relationships>",
      ].join(""),
    ],
    [
      "word/document.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        ...paragraphs.map(
          (paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`,
        ),
        "</w:body></w:document>",
      ].join(""),
    ],
  ]);
}

function createStoredZip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const contentBytes = encoder.encode(content);
    const checksum = crc32(contentBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, contentBytes.length, true);
    localView.setUint32(22, contentBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, contentBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, contentBytes.length, true);
    centralView.setUint32(24, contentBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + contentBytes.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return concatenateBytes([...localParts, ...centralParts, end]);
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
