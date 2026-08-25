import { expect, test, type Page } from "@playwright/test";

import { switchFreshInstallToProfessionalMode } from "./support/writing-experience";

test.use({
  hasTouch: true,
  viewport: { width: 1280, height: 800 },
});

test.beforeEach(async ({ page }) => {
  await page.goto("/#/start");
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await switchFreshInstallToProfessionalMode(page);
  await page.goto("/#/projects");
  await expect(page.getByRole("heading", { level: 1, name: "项目" })).toBeVisible();
});

test("opens character details and story evidence with every standard activation path", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await createProject(page, "设定证据浏览器验收");
  page.setDefaultTimeout(10_000);
  const projectHref = await page
    .getByRole("link", { name: "打开", exact: true })
    .getAttribute("href");
  const projectId = /^#\/projects\/([^/]+)$/u.exec(projectHref ?? "")?.[1];
  if (projectId === undefined) {
    throw new Error("无法从作品库读取测试项目标识。");
  }

  await page.getByRole("link", { name: "打开", exact: true }).click();
  await createChapter(page, "原文证据");
  const sourceText = "周望是钟楼的管理员。";
  await page.getByRole("textbox", { name: "章节正文" }).fill(sourceText);
  await expect(page.getByRole("button", { name: "已保存到本地" })).toBeVisible({ timeout: 5_000 });

  await page.goto(`/#/projects/${projectId}/story`);
  await expect(page.getByRole("heading", { level: 2, name: "人物", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加第一个人物" }).click();
  const addCharacterDialog = page.getByRole("dialog", { name: "添加故事设定" });
  await addCharacterDialog.getByRole("textbox", { name: "内容" }).fill("林舟是旧城钟楼的守钟人。");
  await addCharacterDialog.getByRole("button", { name: "确认保存" }).click();

  const characterDetailButton = page.getByRole("button", { name: "查看人物详情" });
  await expect(characterDetailButton).toHaveAttribute("aria-expanded", "false");
  const characterDetailId = await characterDetailButton.getAttribute("aria-controls");
  expect(characterDetailId).not.toBeNull();

  await characterDetailButton.click();
  await expect(page.locator('button[aria-controls="story-character-detail"]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator(`#${characterDetailId ?? "missing"}`)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "人物身份" }).locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(characterDetailButton).toHaveAttribute("aria-expanded", "false");
  await expect(characterDetailButton).toBeFocused();

  await characterDetailButton.press("Enter");
  await expect(page.getByRole("dialog", { name: "人物身份" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(characterDetailButton).toBeFocused();

  await characterDetailButton.press("Space");
  await expect(page.getByRole("dialog", { name: "人物身份" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(characterDetailButton).toBeFocused();

  await characterDetailButton.tap();
  await expect(page.getByRole("dialog", { name: "人物身份" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(characterDetailButton).toBeFocused();

  await characterDetailButton.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("人物详情入口不是按钮。");
    button.blur();
    button.click();
  });
  const programmaticallyOpenedCharacterDialog = page.getByRole("dialog", { name: "人物身份" });
  await expect(programmaticallyOpenedCharacterDialog).toBeVisible();
  await expect(programmaticallyOpenedCharacterDialog.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(characterDetailButton).toBeFocused();

  await page.goto("/#/settings#writing-experience");
  await page.getByRole("button", { name: "直接写作" }).click();
  const authorization = page.getByRole("dialog", { name: "启用直接模式前，请确认一次" });
  if ((await authorization.count()) > 0) {
    await authorization.getByRole("button", { name: "同意并启用直接模式" }).click();
  }
  await expect(page.getByRole("heading", { level: 2, name: "写作方式" })).toBeVisible();
  await expect(page.getByText("当前使用简洁的直接写作界面。", { exact: true })).toBeVisible();

  await page.goto(`/#/projects/${projectId}/story`);
  await expect(page.getByRole("heading", { level: 2, name: "当前设定" })).toBeVisible();
  await page.getByRole("button", { name: "添加设定" }).click();
  const createDialog = page.getByRole("dialog", { name: "添加设定" });
  await createDialog.getByRole("textbox", { name: "内容" }).fill("旧城钟楼每天午夜倒转一次。");
  await createDialog.getByRole("button", { name: "保存设定" }).click();

  const evidenceItem = page.getByText("旧城钟楼每天午夜倒转一次。", { exact: true }).locator("..");
  const evidenceButton = evidenceItem.getByRole("button", { name: "查看证据" });
  await expect(evidenceButton).toHaveAttribute("aria-expanded", "false");
  const regionId = await evidenceButton.getAttribute("aria-controls");
  expect(regionId).not.toBeNull();

  await evidenceButton.click();
  const collapseEvidenceButton = evidenceItem.getByRole("button", { name: "收起证据" });
  await expect(collapseEvidenceButton).toHaveAttribute("aria-expanded", "true");
  await expect(collapseEvidenceButton).toBeFocused();
  const evidenceRegion = evidenceItem.getByRole("region", { name: "证据" });
  await expect(evidenceRegion).toHaveAttribute("id", regionId ?? "");
  await expect(evidenceRegion).toBeVisible();

  await collapseEvidenceButton.press("Enter");
  const reopenedEvidenceButton = evidenceItem.getByRole("button", { name: "查看证据" });
  await expect(reopenedEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(reopenedEvidenceButton).toBeFocused();
  await expect(evidenceRegion).toHaveCount(0);

  await reopenedEvidenceButton.tap();
  await expect(evidenceItem.getByRole("button", { name: "收起证据" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(evidenceItem.getByRole("region", { name: "证据" })).toBeVisible();

  await evidenceItem.getByRole("button", { name: "收起证据" }).tap();
  await expect(reopenedEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(reopenedEvidenceButton).toBeFocused();

  await reopenedEvidenceButton.press("Space");
  await expect(evidenceItem.getByRole("region", { name: "证据" })).toBeVisible();
  await evidenceItem.getByRole("button", { name: "收起证据" }).press("Space");
  await expect(reopenedEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(reopenedEvidenceButton).toBeFocused();

  await reopenedEvidenceButton.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("证据入口不是按钮。");
    button.blur();
    button.click();
  });
  await expect(evidenceItem.getByRole("region", { name: "证据" })).toBeVisible();
  await expect(evidenceItem.getByRole("button", { name: "收起证据" })).toBeFocused();
  await evidenceItem.getByRole("button", { name: "收起证据" }).evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("证据入口不是按钮。");
    button.click();
  });
  await expect(reopenedEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(reopenedEvidenceButton).toBeFocused();

  await page.getByRole("button", { name: "添加设定" }).click();
  const pendingDialog = page.getByRole("dialog", { name: "添加设定" });
  await pendingDialog.getByRole("textbox", { name: "内容" }).fill(sourceText);
  await pendingDialog.getByRole("button", { name: "保存设定" }).click();
  await stageLatestFormalFactAsDirectLocalDraft(page, projectId, sourceText);
  await page.reload();

  const pendingSection = page
    .getByRole("heading", { name: "待确认设定", level: 2 })
    .locator("xpath=ancestor::section[1]");
  const originalEvidenceButton = pendingSection.getByRole("button", {
    name: /(?:查看|收起)原文依据/u,
  });
  await originalEvidenceButton.press("Enter");
  await expect(originalEvidenceButton).toHaveAttribute("aria-expanded", "true");
  await expect(pendingSection.getByText("来源章节")).toBeVisible();
  await expect(pendingSection.getByText("《原文证据》")).toBeVisible();
  await expect(pendingSection.getByText("字符范围")).toBeVisible();
  await expect(pendingSection.getByText(/第 1 至 \d+ 个字符/u)).toBeVisible();
  await expect(pendingSection.getByText(sourceText).last()).toBeVisible();

  await originalEvidenceButton.press("Space");
  await expect(originalEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(originalEvidenceButton).toBeFocused();
  await originalEvidenceButton.tap();
  await expect(originalEvidenceButton).toHaveAttribute("aria-expanded", "true");
  await originalEvidenceButton.tap();
  await expect(originalEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(originalEvidenceButton).toBeFocused();

  await originalEvidenceButton.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("原文依据入口不是按钮。");
    button.blur();
    button.click();
  });
  await expect(originalEvidenceButton).toHaveAttribute("aria-expanded", "true");
  await expect(originalEvidenceButton).toBeFocused();
  await originalEvidenceButton.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("原文依据入口不是按钮。");
    button.click();
  });
  await expect(originalEvidenceButton).toHaveAttribute("aria-expanded", "false");
  await expect(originalEvidenceButton).toBeFocused();
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

async function stageLatestFormalFactAsDirectLocalDraft(
  page: Page,
  projectId: string,
  sourceText: string,
): Promise<void> {
  await page.evaluate(
    ({ expectedProjectId, expectedSourceText }) => {
      const chapterDatabase = JSON.parse(
        window.localStorage.getItem("inkshadow.development.database.v1") ?? "null",
      ) as {
        chapters?: { id: string; projectId: string; currentVersionId: string }[];
        versions?: { id: string; chapterId: string; content: string }[];
      } | null;
      const chapter = chapterDatabase?.chapters?.find(
        (candidate) => candidate.projectId === expectedProjectId,
      );
      const version = chapterDatabase?.versions?.find(
        (candidate) => candidate.id === chapter?.currentVersionId,
      );
      if (
        chapter === undefined ||
        version === undefined ||
        version.content !== expectedSourceText
      ) {
        throw new Error("找不到用于原文依据回归的权威章节版本。");
      }

      const factDatabase = JSON.parse(
        window.localStorage.getItem("inkshadow.development.story-facts.v1") ?? "null",
      ) as {
        facts?: Record<string, Record<string, unknown>>;
        revisions?: Record<string, { snapshot: Record<string, unknown> }[]>;
      } | null;
      const factEntry = Object.entries(factDatabase?.facts ?? {}).find(
        ([, fact]) =>
          fact.projectId === expectedProjectId && fact.contentText === expectedSourceText,
      );
      if (factEntry === undefined || factDatabase?.facts === undefined) {
        throw new Error("找不到用于原文依据回归的本地设定。");
      }
      const [factId, fact] = factEntry;
      Object.assign(fact, {
        structuredValue: {
          schemaVersion: "inkshadow.rebuildable-system-fact.v1",
          payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
        },
        source: {
          kind: "chapter_span",
          reference: "direct-local:inkshadow.direct-local-story-fact.v1:browser-evidence",
          chapterId: chapter.id,
          versionId: version.id,
          startOffset: 0,
          endOffset: expectedSourceText.length,
          sourceLength: expectedSourceText.length,
          excerpt: expectedSourceText,
        },
        status: "unconfirmed",
        origin: "system",
        userConfirmed: false,
        locked: false,
        deprecated: false,
        needsReview: true,
        confirmedByActorId: null,
        confirmedAt: null,
      });
      const firstRevision = factDatabase.revisions?.[factId]?.[0];
      if (firstRevision === undefined) throw new Error("找不到设定创建修订。");
      firstRevision.snapshot = structuredClone(fact);
      window.localStorage.setItem(
        "inkshadow.development.story-facts.v1",
        JSON.stringify(factDatabase),
      );
    },
    { expectedProjectId: projectId, expectedSourceText: sourceText },
  );
}
