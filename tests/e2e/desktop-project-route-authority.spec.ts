import { expect, test, type Page } from "@playwright/test";

import { switchFreshInstallToProfessionalMode } from "./support/writing-experience";

interface ProjectFixture {
  readonly id: string;
  readonly name: string;
  readonly chapterId: string;
  readonly chapterTitle: string;
}

const PROJECT_AREAS = ["", "/outline", "/story", "/checks"] as const;

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

test("keeps full project identity through rapid four-area navigation, history, and refresh", async ({
  browserName,
  page,
}) => {
  test.setTimeout(90_000);
  expect(browserName).toBe("chromium");

  const first = await createProjectWithChapter(page, "快速导航甲", "甲项目唯一章节");
  await page.getByRole("link", { name: "作品库", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "项目" })).toBeVisible();
  const current = await createProjectWithChapter(page, "快速导航乙", "乙项目唯一章节");

  for (const suffix of PROJECT_AREAS) {
    const firstRoute = `/#/projects/${first.id}${suffix}`;
    const currentRoute = `/#/projects/${current.id}${suffix}`;

    // Hash navigation resolves before repository reads finish, so the second legal navigation
    // exercises the same stale-result window as a user switching projects quickly.
    await page.goto(firstRoute);
    await page.goto(currentRoute);
    await expectProjectArea(page, current, suffix);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(firstRoute)}$`, "u"));
    await expectProjectArea(page, first, suffix);

    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(currentRoute)}$`, "u"));
    await expectProjectArea(page, current, suffix);

    await page.reload();
    await expectProjectArea(page, current, suffix);
  }
});

async function createProjectWithChapter(
  page: Page,
  name: string,
  chapterTitle: string,
): Promise<ProjectFixture> {
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const projectDialog = page.getByRole("dialog", { name: "新建项目" });
  await projectDialog.getByRole("textbox", { name: "项目名称" }).fill(name);
  await projectDialog.getByRole("button", { name: "创建项目" }).click();

  const card = page.locator(".ink-card").filter({
    has: page.getByRole("heading", { level: 2, name }),
  });
  await expect(card).toHaveCount(1);
  const projectHref = await card
    .getByRole("link", { name: "打开", exact: true })
    .getAttribute("href");
  const projectId = /^#?\/projects\/([^/]+)$/u.exec(projectHref ?? "")?.[1];
  if (projectId === undefined) throw new Error("无法读取测试项目的完整标识。");

  await card.getByRole("link", { name: "打开", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await page.getByRole("button", { name: "新建章节" }).first().click();
  const chapterDialog = page.getByRole("dialog", { name: "新建章节" });
  await chapterDialog.getByRole("textbox", { name: "章节标题" }).fill(chapterTitle);
  await chapterDialog.getByRole("button", { name: "创建章节" }).click();
  await page
    .getByLabel(chapterTitle)
    .getByRole("link", { name: `继续写第 1 章《${chapterTitle}》`, exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: chapterTitle })).toBeVisible();

  const routeMatch = /#\/projects\/([^/]+)\/chapters\/([^/?#]+)/u.exec(page.url());
  if (routeMatch?.[1] !== projectId || routeMatch[2] === undefined) {
    throw new Error("编辑器地址没有保留项目与章节的完整标识。");
  }
  return Object.freeze({ id: projectId, name, chapterId: routeMatch[2], chapterTitle });
}

async function expectProjectArea(
  page: Page,
  project: ProjectFixture,
  suffix: (typeof PROJECT_AREAS)[number],
): Promise<void> {
  if (suffix === "/checks") {
    await expect(page.getByRole("heading", { level: 1, name: "检查" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "章节" })).toHaveValue(project.chapterId);
  } else {
    await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();
  }
  await expect(page.getByText(/支持编号：UI-/u)).toHaveCount(0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
