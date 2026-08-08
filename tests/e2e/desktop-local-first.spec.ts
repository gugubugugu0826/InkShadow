import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const DEVELOPMENT_DATABASE_KEY = "inkshadow.development.database.v1";

test.beforeEach(async ({ page }) => {
  await page.goto("/#/projects");
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
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
  await page.getByRole("button", { name: "比较 AI 建议" }).click();
  const candidateReview = page.getByRole("dialog", { name: "比较 AI 建议与正文" });
  await candidateReview.getByRole("button", { name: "插入光标并创建版本", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toHaveValue(
    `${stableBody}\n\n【本地演示候选】暮色沿着窗棂缓慢下沉，人物在未说出口的决定前停了一瞬。`,
  );
  const assistant = page.getByRole("complementary", { name: "AI 创作助手" });
  await expect(assistant.getByRole("button", { name: "继续创作" })).toBeVisible();

  await page.getByRole("button", { name: "版本历史" }).click();
  const versionDialog = page.getByRole("dialog", { name: "版本历史" });
  await expect(versionDialog.getByText("版本 3", { exact: true })).toBeVisible();
  await expect(versionDialog.getByText("接受 AI 建议", { exact: true })).toBeVisible();
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
  await createProject(page, "导入导出验收长篇");
  await page.getByRole("link", { name: "打开", exact: true }).click();
  await createChapter(page, "第一章");
  const exportBody = "这是用于导出校验的正文。";
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
  await page.getByRole("link", { name: "设置", exact: true }).click();

  const markdownDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Markdown" }).click();
  const markdownDownload = await markdownDownloadPromise;
  expect(markdownDownload.suggestedFilename()).toBe("导入导出验收长篇.md");
  const markdownPath = await markdownDownload.path();
  if (markdownPath === null) {
    throw new Error("Playwright did not expose the Markdown download.");
  }
  const markdown = await readFile(markdownPath, "utf8");
  expect(markdown).toContain("# 导入导出验收长篇");
  expect(markdown).toContain("这是用于导出校验的正文。");

  const docxDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 DOCX" }).click();
  const docxDownload = await docxDownloadPromise;
  expect(docxDownload.suggestedFilename()).toBe("导入导出验收长篇.docx");
  const docxPath = await docxDownload.path();
  if (docxPath === null) {
    throw new Error("Playwright did not expose the DOCX download.");
  }
  const docx = await readFile(docxPath);
  expect(docx.byteLength).toBeGreaterThan(1_000);
  expect([...docx.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

  const pdfDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  const pdfDownload = await pdfDownloadPromise;
  expect(pdfDownload.suggestedFilename()).toBe("导入导出验收长篇.pdf");
  const pdfPath = await pdfDownload.path();
  if (pdfPath === null) {
    throw new Error("Playwright did not expose the PDF download.");
  }
  const pdf = await readFile(pdfPath);
  expect(pdf.byteLength).toBeGreaterThan(1_000);
  expect([...pdf.subarray(0, 8)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  expect(pdf.subarray(-6).toString("ascii")).toBe("%%EOF\n");
  await expectPdfReaderCanOpenImageOnlyA4Document(pdf);
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
  await expect(pdfIssue).toContainText("PDF_TEXT_UNAVAILABLE");

  const bundleDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Bundle" }).click();
  const bundleDownload = await bundleDownloadPromise;
  expect(bundleDownload.suggestedFilename()).toBe("导入导出验收长篇.inkshadow.json");
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
  await expect(page.getByText("MARKDOWN_RAW_HTML_ESCAPED")).toBeVisible();

  await page.getByRole("textbox", { name: "导入为项目名称" }).fill("安全导入验收长篇");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByText(/已写入 1 个章节/u)).toBeVisible();

  const diagnosticsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载脱敏诊断包" }).click();
  const diagnosticsDownload = await diagnosticsDownloadPromise;
  expect(diagnosticsDownload.suggestedFilename()).toMatch(/^InkShadow-diagnostics-/u);
  const diagnosticsPath = await diagnosticsDownload.path();
  if (diagnosticsPath === null) {
    throw new Error("Playwright did not expose the diagnostic download.");
  }
  const diagnostics = await readFile(diagnosticsPath, "utf8");
  expect(diagnostics).toContain('"credentialsIncluded": false');
  expect(diagnostics).not.toContain("这是用于导出校验的正文。");
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
