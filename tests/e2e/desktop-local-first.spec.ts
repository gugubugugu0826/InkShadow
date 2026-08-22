import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { switchFreshInstallToProfessionalMode } from "./support/writing-experience";

const DEVELOPMENT_DATABASE_KEY = "inkshadow.development.database.v1";

test.beforeEach(async ({ page }) => {
  await page.goto("/#/start");
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await switchFreshInstallToProfessionalMode(page);
  await page.goto("/#/projects");
  await expect(page.getByRole("heading", { level: 1, name: "项目" })).toBeVisible();
  await expect(
    page.getByText("仅开发环境：当前数据只保存在此浏览器中，不代表桌面正式版的持久化能力。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("登录");
});

test("manages a project through rename, archive, trash, and restore", async ({ page }) => {
  await createProject(page, "生命周期验收长篇");

  await page.getByRole("button", { name: "重命名" }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名项目" });
  await renameDialog.getByRole("textbox", { name: "项目名称" }).fill("生命周期验收长篇·修订");
  await renameDialog.getByRole("button", { name: "保存名称" }).click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "生命周期验收长篇·修订",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "归档" }).click();
  await page.getByRole("tab", { name: "已归档" }).click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "生命周期验收长篇·修订",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复编辑" }).click();

  await page.getByRole("tab", { name: "进行中" }).click();
  await page.getByRole("button", { name: "移到回收站" }).click();
  await page
    .getByRole("dialog", { name: /移到回收站/u })
    .getByRole("button", { name: "移到回收站", exact: true })
    .click();
  await page.getByRole("tab", { name: "回收站" }).click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "生命周期验收长篇·修订",
    }),
  ).toBeVisible();
  const trashPanel = page.getByRole("tabpanel", { name: "回收站" });
  await expect(trashPanel.getByText("可恢复至", { exact: false })).toBeVisible();
  await trashPanel.getByRole("button", { name: "恢复", exact: true }).click();

  await page.getByRole("tab", { name: "进行中" }).click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "生命周期验收长篇·修订",
    }),
  ).toBeVisible();
});

test("autosaves, recovers a crash draft, and isolates AI candidates", async ({ browser, page }) => {
  await createProject(page, "编辑器验收长篇");
  await page.getByRole("link", { name: "打开", exact: true }).click();
  await createChapter(page, "第一章 风起");

  const editor = page.getByRole("textbox", { name: "章节正文" });
  const stableBody = "雨落在旧城的瓦面上。沈砚推开窗，远处灯塔正一明一灭。";
  await editor.fill(stableBody);
  await expect(page.getByRole("button", { name: "已保存到本地" })).toBeVisible({ timeout: 5_000 });

  await page.reload();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toHaveValue(stableBody);

  await page.getByRole("button", { name: "生成示例建议" }).click();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toHaveValue(stableBody);
  await expect(
    page.getByText(/当前使用本机示例帮助检查流程，不会联网；只有你接受后/u),
  ).toBeVisible();
  await expect(page.getByText("等待决定", { exact: true })).toBeVisible();
  await page.getByText("费用与调用记录（高级）", { exact: true }).click();
  await expect(page.getByText("尝试上界累计估算", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "比较建议" }).click();
  const candidateReview = page.getByRole("dialog", { name: "比较建议与正文" });
  await candidateReview.getByRole("button", { name: "插入光标并创建版本", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toHaveValue(
    `${stableBody}\n\n【本地演示候选】暮色沿着窗棂缓慢下沉，人物在未说出口的决定前停了一瞬。`,
  );
  const assistant = page.getByRole("complementary", { name: "AI 创作助手" });
  await expect(assistant.getByRole("button", { name: "生成续写建议" })).toBeVisible();

  await page.getByRole("button", { name: "版本历史" }).click();
  const versionDialog = page.getByRole("dialog", { name: "版本历史" });
  await expect(versionDialog.getByText("版本 3", { exact: true })).toBeVisible();
  await expect(versionDialog.getByText("接受建议", { exact: true })).toBeVisible();
  await versionDialog.getByRole("button", { name: "关闭", exact: true }).last().click();

  const recoveryBody = `${await page
    .getByRole("textbox", { name: "章节正文" })
    .inputValue()}\n\n【未提交草稿】门外忽然传来三声轻叩。`;
  const editorUrl = page.url();
  await page.getByRole("textbox", { name: "章节正文" }).fill(recoveryBody);
  await expect
    .poll(
      async () =>
        inspectRecoveryPersistence(
          await page.evaluate(
            (storageKey) => window.localStorage.getItem(storageKey),
            DEVELOPMENT_DATABASE_KEY,
          ),
          recoveryBody,
        ),
      {
        message: "recovery draft should be durable before the autosave commit",
        intervals: [25, 50, 100],
      },
    )
    .toEqual({ draftPersisted: true, stableCommitted: false });

  const restartStorageState = await page.context().storageState();
  const editorOrigin = new URL(editorUrl).origin;
  const snapshottedDatabase =
    restartStorageState.origins
      .find(({ origin }) => origin === editorOrigin)
      ?.localStorage.find(({ name }) => name === DEVELOPMENT_DATABASE_KEY)?.value ?? null;
  expect(inspectRecoveryPersistence(snapshottedDatabase, recoveryBody)).toEqual({
    draftPersisted: true,
    stableCommitted: false,
  });

  const restartedContext = await browser.newContext({
    colorScheme: "dark",
    locale: "zh-CN",
    storageState: restartStorageState,
  });
  try {
    const recoveredPage = await restartedContext.newPage();
    await recoveredPage.goto(editorUrl);

    const recoveryDialog = recoveredPage.getByRole("dialog", {
      name: "发现未完成的本地草稿",
    });
    await expect(recoveryDialog).toBeVisible();
    await expect(recoveryDialog.getByRole("button", { name: "恢复草稿继续编辑" })).toBeVisible();
    await recoveryDialog.getByRole("button", { name: "恢复草稿继续编辑" }).click();
    await expect(
      recoveredPage.getByText("已载入恢复草稿；自动保存成功后会生成新的稳定版本。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(recoveredPage.getByRole("textbox", { name: "章节正文" })).toHaveValue(
      recoveryBody,
    );
    await recoveredPage.getByRole("button", { name: "保存正文" }).click();
    await expect(recoveredPage.getByRole("button", { name: "已保存到本地" })).toBeVisible();
  } finally {
    await restartedContext.close();
  }
});

test("imports into the first chapter and exports validated artifacts and diagnostics", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const projectTitle = "导入导出验收长篇";
  const publicTailMarker = "PUBLIC_LONG_EXPORT_TAIL_终";
  const privateMarker = "PRIVATE_CHAPTER_MUST_REQUIRE_OPT_IN";
  await createProject(page, projectTitle);
  await page.getByRole("link", { name: "打开", exact: true }).click();
  await createChapter(page, "第一章");
  const exportBody = `${"这是用于导出校验的长篇正文，包含中文标点与段落。\n\n".repeat(320)}${publicTailMarker}`;
  await page.getByRole("textbox", { name: "章节正文" }).fill(exportBody);
  await expect
    .poll(
      async () =>
        inspectRecoveryPersistence(
          await page.evaluate(
            (storageKey) => window.localStorage.getItem(storageKey),
            DEVELOPMENT_DATABASE_KEY,
          ),
          exportBody,
        ).stableCommitted,
      { message: "export body should be committed before opening settings" },
    )
    .toBe(true);

  const exportProjectId = projectIdFromEditorUrl(page.url());
  await page.goto(`/#/projects/${exportProjectId}`);
  await createChapter(page, "私密附录");
  await page.getByRole("textbox", { name: "章节正文" }).fill(privateMarker);
  await expect
    .poll(
      async () =>
        inspectRecoveryPersistence(
          await page.evaluate(
            (storageKey) => window.localStorage.getItem(storageKey),
            DEVELOPMENT_DATABASE_KEY,
          ),
          privateMarker,
        ).stableCommitted,
      { message: "private export fixture should be committed before changing privacy" },
    )
    .toBe(true);
  await page.getByRole("button", { name: "设为私密" }).click();
  const privacyDialog = page.getByRole("dialog", { name: "将本章设为私密章节？" });
  await privacyDialog.getByRole("button", { name: "确认仅限本地" }).click();
  await expect(page.getByText(/本章现已设为私密章节/u)).toBeVisible();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  const includePrivate = page.getByRole("checkbox", { name: "包含私密章节" });
  await expect(includePrivate).not.toBeChecked();

  const markdownDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Markdown" }).click();
  const markdownDownload = await markdownDownloadPromise;
  expect(markdownDownload.suggestedFilename()).toBe(`${projectTitle}.md`);
  const markdownPath = await markdownDownload.path();
  if (markdownPath === null) {
    throw new Error("Playwright did not expose the Markdown download.");
  }
  const markdown = await readFile(markdownPath, "utf8");
  expect(Buffer.byteLength(markdown, "utf8")).toBeGreaterThan(10_000);
  expect(markdown).toContain(`# ${projectTitle}`);
  expect(markdown).toContain(publicTailMarker);
  expect(markdown).not.toContain(privateMarker);
  await expect(page.getByText(new RegExp(`文件：${projectTitle}\\.md`, "u"))).toBeVisible();
  await expect(
    page.getByText(/状态：已请求浏览器下载；最终位置与写入结果无法由应用核验/u),
  ).toBeVisible();
  await expect(page.getByText(/排除 1 个私密章节/u)).toBeVisible();

  const epubDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 EPUB" }).click();
  const epubDownload = await epubDownloadPromise;
  expect(epubDownload.suggestedFilename()).toBe(`${projectTitle}.epub`);
  const epubPath = await epubDownload.path();
  if (epubPath === null) {
    throw new Error("Playwright did not expose the EPUB download.");
  }
  const epub = await readFile(epubPath);
  expect(epub.byteLength).toBeGreaterThan(1_000);
  const epubArchive = await loadZipArchive(epub);
  const epubPackage = await requiredZipText(epubArchive, "EPUB/package.opf");
  const epubChapter = await requiredZipText(epubArchive, "EPUB/chapter-00001.xhtml");
  expect(epubPackage).toContain(projectTitle);
  expect(epubChapter).toContain(publicTailMarker);
  expect(epubChapter).not.toContain(privateMarker);
  await expect(page.getByText(new RegExp(`文件：${projectTitle}\\.epub`, "u"))).toBeVisible();
  await expect(page.getByText(/排除 1 个私密章节/u)).toBeVisible();

  const docxDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 DOCX" }).click();
  const docxDownload = await docxDownloadPromise;
  expect(docxDownload.suggestedFilename()).toBe(`${projectTitle}.docx`);
  const docxPath = await docxDownload.path();
  if (docxPath === null) {
    throw new Error("Playwright did not expose the DOCX download.");
  }
  const docx = await readFile(docxPath);
  expect(docx.byteLength).toBeGreaterThan(1_000);
  expect([...docx.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  const docxArchive = await loadZipArchive(docx);
  expect(await requiredZipText(docxArchive, "docProps/core.xml")).toContain(projectTitle);
  const docxDocument = await requiredZipText(docxArchive, "word/document.xml");
  expect(docxDocument).toContain(publicTailMarker);
  expect(docxDocument).not.toContain(privateMarker);
  await expect(page.getByText(new RegExp(`文件：${projectTitle}\\.docx`, "u"))).toBeVisible();
  await expect(page.getByText(/排除 1 个私密章节/u)).toBeVisible();

  await includePrivate.check();
  const privateMarkdownDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Markdown" }).click();
  const privateMarkdownDownload = await privateMarkdownDownloadPromise;
  const privateMarkdownPath = await privateMarkdownDownload.path();
  if (privateMarkdownPath === null) {
    throw new Error("Playwright did not expose the explicitly authorized private export.");
  }
  expect(await readFile(privateMarkdownPath, "utf8")).toContain(privateMarker);
  await expect(page.getByText(new RegExp(`文件：${projectTitle}\\.md`, "u"))).toBeVisible();
  await includePrivate.uncheck();

  const pdfDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  const pdfDownload = await pdfDownloadPromise;
  expect(pdfDownload.suggestedFilename()).toBe(`${projectTitle}.pdf`);
  const pdfPath = await pdfDownload.path();
  if (pdfPath === null) {
    throw new Error("Playwright did not expose the PDF download.");
  }
  const pdf = await readFile(pdfPath);
  expect(pdf.byteLength).toBeGreaterThan(1_000);
  expect([...pdf.subarray(0, 8)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  expect(pdf.subarray(-6).toString("ascii")).toBe("%%EOF\n");
  expect(pdf.toString("latin1")).toContain(`/Title <${pdfUtf16Hex(projectTitle)}>`);
  await expectPdfReaderCanOpenImageOnlyA4Document(pdf);
  await expect(page.getByText(new RegExp(`文件：${projectTitle}\\.pdf`, "u"))).toBeVisible();
  await expect(page.getByText(/排除 1 个私密章节/u)).toBeVisible();
  if (process.env.INKSHADOW_PDF_QA_OUTPUT !== undefined) {
    await pdfDownload.saveAs(process.env.INKSHADOW_PDF_QA_OUTPUT);
  }

  // Exercise the production PDF.js Web Worker asset as well as the Node-side
  // structural reader above. The exported document is intentionally image-only,
  // so a safe import must finish parsing and report that OCR is required.
  await page.locator('input[type="file"]').setInputFiles({
    name: "图像型安全检查.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  const pdfIssue = page
    .getByRole("list", { name: "预检提示" })
    .getByRole("listitem")
    .filter({ hasText: "图像型安全检查.pdf" });
  await expect(pdfIssue).toContainText("PDF 没有可提取文本；扫描件与 OCR 暂不支持。");
  await expect(pdfIssue).not.toContainText("PDF_TEXT_UNAVAILABLE");

  const bundleDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载完整备份" }).click();
  const bundleDownload = await bundleDownloadPromise;
  expect(bundleDownload.suggestedFilename()).toBe(`${projectTitle}.inkshadow.json`);
  const bundlePath = await bundleDownload.path();
  if (bundlePath === null) {
    throw new Error("Playwright did not expose the Bundle download.");
  }
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
    manifest?: { format?: string };
  };
  expect(bundle.manifest?.format).toBe("inkshadow-portable-bundle");

  await page.locator('input[type="file"]').setInputFiles({
    name: "安全导入.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 第二章\n\n可预览正文。\n\n<script>alert('x')</script>\n", "utf8"),
  });
  await expect(page.getByText("预检通过，尚未写入项目", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "章节标题" })).toHaveValue("安全导入");
  await expect(page.getByRole("list", { name: "预检提示" })).toContainText(
    "原始 HTML 已转为普通文本。",
  );
  await expect(page.getByRole("list", { name: "预检提示" })).not.toContainText(
    "MARKDOWN_RAW_HTML_ESCAPED",
  );

  await page.getByRole("textbox", { name: "导入为项目名称" }).fill("安全导入验收长篇");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByText(/已写入 1 个章节/u)).toBeVisible();

  const diagnosticsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载脱敏诊断包" }).click();
  const diagnosticsDownload = await diagnosticsDownloadPromise;
  expect(diagnosticsDownload.suggestedFilename()).toMatch(/^墨影-诊断-\d{4}-\d{2}-\d{2}-/u);
  const diagnosticsPath = await diagnosticsDownload.path();
  if (diagnosticsPath === null) {
    throw new Error("Playwright did not expose the diagnostic download.");
  }
  const diagnostics = await readFile(diagnosticsPath, "utf8");
  expect(diagnostics).toContain('"credentialsIncluded": false');
  expect(diagnostics).not.toContain(publicTailMarker);
  expect(diagnostics).not.toContain("可预览正文。");

  await page.getByRole("link", { name: "打开第一章" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "安全导入" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toHaveValue(/可预览正文/u);

  await page.getByRole("link", { name: "作品库", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "导入导出验收长篇",
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "安全导入验收长篇",
    }),
  ).toHaveCount(1);
});

test("keeps sync disabled when the native credential boundary is unavailable", async ({ page }) => {
  await createProject(page, "同步安全验收长篇");
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("link", { name: "打开同步安全设置" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "同步安全" })).toBeVisible();
  await expect(page.getByText("同步默认关闭", { exact: true })).toBeVisible();
  await expect(page.getByText(/浏览器开发模式不会创建、模拟或保存设备私钥和恢复码/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "创建设备身份" })).toBeDisabled();
  await expect(page.locator('[data-sensitive="recovery-code"]')).toHaveCount(0);
});

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByRole("textbox", { name: "项目名称" }).fill(name);
  await dialog.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
}

async function createChapter(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "新建章节" }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建章节" });
  await dialog.getByRole("textbox", { name: "章节标题" }).fill(title);
  await dialog.getByRole("button", { name: "创建章节" }).click();
  await page.getByLabel(title).getByRole("link", { name: "继续写作", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

function projectIdFromEditorUrl(editorUrl: string): string {
  const match = /#\/projects\/([^/]+)\/chapters\//u.exec(editorUrl);
  if (match?.[1] === undefined) {
    throw new Error(`Could not read a project id from ${editorUrl}`);
  }
  return match[1];
}

function inspectRecoveryPersistence(
  serialized: string | null,
  expectedContent: string,
): Readonly<{
  draftPersisted: boolean;
  stableCommitted: boolean;
}> {
  if (serialized === null) {
    return { draftPersisted: false, stableCommitted: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { draftPersisted: false, stableCommitted: false };
  }
  if (!isRecord(parsed)) {
    return { draftPersisted: false, stableCommitted: false };
  }
  return {
    draftPersisted: hasStoredContent(parsed.drafts, expectedContent),
    stableCommitted: hasStoredContent(parsed.chapters, expectedContent),
  };
}

function hasStoredContent(value: unknown, expectedContent: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((item: unknown) => isRecord(item) && item.content === expectedContent)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

interface ZipArchive {
  file(name: string): { async(type: "string"): Promise<string> } | null;
}

async function loadZipArchive(bytes: Buffer): Promise<ZipArchive> {
  const requireFromImportExport = createRequire(
    path.resolve("packages/import-export/package.json"),
  );
  const modulePath = requireFromImportExport.resolve("jszip");
  const module = (await import(pathToFileURL(modulePath).href)) as {
    readonly default: { loadAsync(data: Uint8Array): Promise<ZipArchive> };
  };
  return module.default.loadAsync(new Uint8Array(bytes));
}

async function requiredZipText(archive: ZipArchive, name: string): Promise<string> {
  const entry = archive.file(name);
  if (entry === null) throw new Error(`Missing required archive entry: ${name}`);
  return entry.async("string");
}

function pdfUtf16Hex(value: string): string {
  let result = "FEFF";
  for (let index = 0; index < value.length; index += 1) {
    result += value.charCodeAt(index).toString(16).padStart(4, "0").toUpperCase();
  }
  return result;
}

interface PdfReaderPage {
  readonly view: readonly number[];
  getOperatorList(): Promise<{
    readonly fnArray: readonly number[];
  }>;
  cleanup(): void;
}

interface PdfReaderDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfReaderPage>;
  getJSActions(): Promise<unknown>;
  getAttachments(): Promise<unknown>;
  getFieldObjects(): Promise<unknown>;
  getOpenAction(): Promise<unknown>;
}

interface PdfReaderModule {
  readonly OPS: Readonly<Record<string, number>>;
  getDocument(options: {
    readonly data: Uint8Array;
    readonly disableFontFace: boolean;
    readonly isEvalSupported: boolean;
    readonly useSystemFonts: boolean;
  }): {
    readonly promise: Promise<PdfReaderDocument>;
    destroy(): Promise<void>;
  };
}

async function expectPdfReaderCanOpenImageOnlyA4Document(bytes: Buffer): Promise<void> {
  const requireFromImportExport = createRequire(
    path.resolve("packages/import-export/package.json"),
  );
  const modulePath = requireFromImportExport.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = (await import(pathToFileURL(modulePath).href)) as PdfReaderModule;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  try {
    const document = await loadingTask.promise;
    expect(document.numPages).toBeGreaterThan(0);
    expect(document.numPages).toBeLessThanOrEqual(1_000);
    const imageOperators = new Set(
      [
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageMaskXObject,
      ].filter((value): value is number => value !== undefined),
    );
    const textOperators = new Set(
      [
        pdfjs.OPS.showText,
        pdfjs.OPS.showSpacedText,
        pdfjs.OPS.nextLineShowText,
        pdfjs.OPS.nextLineSetSpacingShowText,
      ].filter((value): value is number => value !== undefined),
    );
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        expect(page.view).toHaveLength(4);
        expect(page.view[2]).toBeCloseTo(595.28, 2);
        expect(page.view[3]).toBeCloseTo(841.89, 2);
        const operators = await page.getOperatorList();
        expect(operators.fnArray.some((operator) => imageOperators.has(operator))).toBe(true);
        expect(operators.fnArray.some((operator) => textOperators.has(operator))).toBe(false);
      } finally {
        page.cleanup();
      }
    }
    await expect(document.getJSActions()).resolves.toBeNull();
    await expect(document.getAttachments()).resolves.toBeNull();
    await expect(document.getFieldObjects()).resolves.toBeNull();
    await expect(document.getOpenAction()).resolves.toBeNull();
  } finally {
    await loadingTask.destroy();
  }
}
