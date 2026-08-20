import {
  expect,
  test,
  type Browser,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";

import {
  captureVisualEvidence,
  startVisualEvidenceRun,
  type VisualViewportProfile,
} from "./support/visual-evidence";
import { expectDirectModeAuthorizationDisclosure } from "./support/writing-experience";

const BASE_URL = "http://127.0.0.1:1420";
const APPEARANCE_STORAGE_KEY = "inkshadow.appearance.preference.v1";
const LONG_CANDIDATE_DRAFT_UNIT = "长篇候选内容用于验证固定动作区。";
const LONG_CANDIDATE_DRAFT_LENGTHS = [5_000, 10_681, 20_000, 50_000] as const;
const LONG_CANDIDATE_DRAFT_LENGTH = LONG_CANDIDATE_DRAFT_LENGTHS.at(-1) ?? 50_000;
const TARGET_PROFILES: readonly VisualViewportProfile[] = [
  viewportProfile("1440x900", 1440, 900),
  viewportProfile("1280x720", 1280, 720),
  viewportProfile("1024x640", 1024, 640),
  viewportProfile("800x600", 800, 600),
  {
    id: "equivalent-200pct-720x450",
    kind: "equivalent_200_percent",
    expectedCssViewport: { width: 720, height: 450 },
    emulatedPhysicalViewport: { width: 1440, height: 900 },
  },
] as const;
const STANDARD_PROFILE = TARGET_PROFILES[0];

test.beforeAll(async () => {
  await startVisualEvidenceRun();
});

test("records light and dark static Chromium evidence without claiming real Windows DPI", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(360_000);
  expect(browserName).toBe("chromium");
  for (const surface of ["light", "dark"] as const) {
    await captureSurfaceMatrix(browser, surface);
  }
});

async function captureSurfaceMatrix(browser: Browser, surface: "light" | "dark"): Promise<void> {
  const context = await browser.newContext({
    viewport: STANDARD_PROFILE.expectedCssViewport,
    colorScheme: surface,
    locale: "zh-CN",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  try {
    await openFreshDirectStart(page, surface);
    const authorization = await expectDirectModeAuthorizationDisclosure(page);
    await captureVisualEvidence(page, {
      name: `${surface}-direct-first-authorization-1440x900`,
      state: "首次直接模式仅授权确定性本地整理；未触发 Provider",
      surfaceSelector: "html",
      viewportProfile: STANDARD_PROFILE,
      captureSession: cdp,
    });
    await authorization.getByRole("button", { name: "同意并启用直接模式" }).click();
    await expect(authorization).toBeHidden();

    await captureDirectStartMatrix(page, cdp, surface);
    const editorUrl = await openProfessionalSampleEditor(page, cdp);
    const projectId = projectIdFromEditorUrl(editorUrl);
    await openLongCandidateReview(page);
    await captureLongCandidateMatrix(page, cdp, surface);
    await saveCloseAndApplyEditedCandidate(page, cdp);
    await captureChecksMatrix(page, cdp, surface, projectId);
  } finally {
    await cdp.detach().catch(() => undefined);
    await context.close();
  }
}

async function openFreshDirectStart(page: Page, surface: "light" | "dark"): Promise<void> {
  await page.goto(`${BASE_URL}/#/start`);
  await page.evaluate(
    ({ appearanceKey, appearance }) => {
      window.localStorage.clear();
      window.localStorage.setItem(appearanceKey, appearance);
    },
    { appearanceKey: APPEARANCE_STORAGE_KEY, appearance: surface },
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-surface", surface);
  await expect(page.getByText("直接模式", { exact: true })).toBeVisible();
}

async function captureDirectStartMatrix(
  page: Page,
  cdp: CDPSession,
  surface: "light" | "dark",
): Promise<void> {
  for (const profile of TARGET_PROFILES) {
    await applyViewportProfile(page, cdp, profile);
    await page.goto(`${BASE_URL}/#/start`);
    await expect(page.getByText("直接模式", { exact: true })).toBeVisible();
    const startWriting = page.getByRole("link", { name: "开始写作" });
    await startWriting.scrollIntoViewIfNeeded();
    await expectMinimumTarget(startWriting);
    await expectNoHorizontalPageOverflow(page);
    await captureVisualEvidence(page, {
      name: `${surface}-direct-start-${profile.id}`,
      state: "已完成一次性本地整理授权的直接模式启动页",
      surfaceSelector: "html",
      viewportProfile: profile,
      captureSession: cdp,
    });
  }
}

async function openProfessionalSampleEditor(page: Page, cdp: CDPSession): Promise<string> {
  await applyViewportProfile(page, cdp, STANDARD_PROFILE);
  await page.goto(`${BASE_URL}/#/start`);
  await page.getByRole("button", { name: "使用专业模式" }).click();
  await expect(page.getByRole("link", { name: /从一个想法开始/u })).toBeVisible();
  await page.getByRole("button", { name: "体验示例作品" }).click();
  await expect(page.getByRole("textbox", { name: "章节正文" })).toBeVisible();
  return page.url();
}

async function openLongCandidateReview(page: Page): Promise<void> {
  const assistant = page.getByRole("complementary", { name: "AI 创作助手" });
  await expect(assistant).toBeVisible();
  await assistant.getByRole("button", { name: "生成示例建议" }).click();
  await expect(assistant.getByText("等待决定", { exact: true })).toBeVisible();
  await assistant.getByRole("button", { name: "比较建议" }).click();

  const review = page.getByRole("dialog", { name: "比较建议与正文" });
  await expect(review).toBeVisible();
  const editor = review.locator("textarea").first();
  for (const characterCount of LONG_CANDIDATE_DRAFT_LENGTHS) {
    const longDraft = LONG_CANDIDATE_DRAFT_UNIT.repeat(
      Math.ceil(characterCount / LONG_CANDIDATE_DRAFT_UNIT.length),
    ).slice(0, characterCount);
    expect(longDraft).toHaveLength(characterCount);
    await editor.fill(longDraft);
    await expect(editor).toHaveValue(longDraft);
    await expect(
      review.getByText(`${characterCount.toLocaleString("zh-CN")} 字符`, { exact: true }),
    ).toBeVisible();
  }
}

async function captureLongCandidateMatrix(
  page: Page,
  cdp: CDPSession,
  surface: "light" | "dark",
): Promise<void> {
  const review = page.getByRole("dialog", { name: "比较建议与正文" });
  for (const profile of TARGET_PROFILES) {
    await applyViewportProfile(page, cdp, profile);
    await expect(review).toBeVisible();
    const content = review.locator(".ink-overlay__content");
    const scrollControl = review.getByRole("button", { name: /浏览.*建议内容/u });
    await scrollControl.focus();
    await expect(scrollControl).toBeFocused();
    await scrollControl.press("Home");
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0);
    await scrollControl.press("PageDown");
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await scrollControl.press("End");
    const endScrollTop = await content.evaluate((element) => element.scrollTop);
    expect(endScrollTop).toBeGreaterThan(0);
    await scrollControl.press("PageUp");
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeLessThan(endScrollTop);
    await scrollControl.hover();
    const beforeWheel = await content.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeWheel);
    const textareaMetrics = await review.locator("textarea").evaluateAll((elements) =>
      elements.map((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        styleHeight: element.style.height,
      })),
    );
    expect(textareaMetrics).toHaveLength(1);
    expect(
      textareaMetrics[0]?.scrollHeight,
      `Textarea must defer scrolling to the Candidate main region: ${JSON.stringify(textareaMetrics[0])}`,
    ).toBeLessThanOrEqual((textareaMetrics[0]?.clientHeight ?? 0) + 1);
    const footer = review.locator(".ink-overlay__footer");
    await expect(footer).toBeVisible();
    await expectInViewport(footer, page);
    await expectMinimumTarget(review.getByRole("button", { name: "取消" }));
    await expectMinimumTarget(review.getByRole("button", { name: "放弃" }));
    await expectMinimumTarget(review.getByRole("button", { name: "使用这版" }));
    const finalDecision = review.getByRole("button", { name: "使用这版" });
    await finalDecision.focus();
    await page.keyboard.press("Tab");
    await expect(review.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Shift+Tab");
    await expect(finalDecision).toBeFocused();
    if (profile.expectedCssViewport.width <= 720) {
      const actionRows = await footer
        .locator("button")
        .evaluateAll((buttons) =>
          Array.from(
            new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))),
          ),
        );
      expect(
        actionRows.length,
        "Compact Candidate decision buttons must wrap into reachable rows",
      ).toBeGreaterThan(1);
    }
    await expectNoHorizontalOverflow(review);
    await expectNoHorizontalPageOverflow(page);
    await captureVisualEvidence(page, {
      name: `${surface}-long-candidate-fixed-actions-${profile.id}`,
      state: `专业模式 Candidate 比较；临时建议草稿 ${String(LONG_CANDIDATE_DRAFT_LENGTH)} 字符；固定动作区可达`,
      surfaceSelector: "html",
      viewportProfile: profile,
      captureSession: cdp,
    });
  }
}

async function saveCloseAndApplyEditedCandidate(page: Page, cdp: CDPSession): Promise<void> {
  await applyViewportProfile(page, cdp, STANDARD_PROFILE);
  const review = page.getByRole("dialog", { name: "比较建议与正文" });
  await review.getByRole("button", { name: "保存建议修改" }).click();
  await expect(review.getByText("修改已保存为建议", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: /浏览.*建议内容/u }).focus();
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  const reopen = page.getByRole("button", { name: "查看建议版本" });
  await expect(reopen).toBeFocused();
  await reopen.click();
  await expect(review).toBeVisible();
  await expect(review.locator("textarea")).toHaveValue(
    new RegExp(`^${LONG_CANDIDATE_DRAFT_UNIT.slice(0, 4)}`, "u"),
  );
  await review.getByRole("button", { name: "使用这版" }).click();
  await expect(review).toBeHidden();
  await expect
    .poll(() =>
      page
        .getByRole("textbox", { name: "章节正文" })
        .evaluate((element) => (element instanceof HTMLTextAreaElement ? element.value.length : 0)),
    )
    .toBeGreaterThanOrEqual(LONG_CANDIDATE_DRAFT_LENGTH);
}

async function captureChecksMatrix(
  page: Page,
  cdp: CDPSession,
  surface: "light" | "dark",
  projectId: string,
): Promise<void> {
  await page.goto(`${BASE_URL}/#/projects/${projectId}/checks`);
  await expect(page.getByRole("heading", { level: 1, name: "检查" })).toBeVisible();
  // The static browser runtime intentionally has no native Agent/Provider executor. This matrix
  // records the existing checks surface only; Tauri Agent visuals remain a separate real-app run.
  await expect(page.getByRole("heading", { name: "长篇一致性调查" })).toHaveCount(0);

  for (const profile of TARGET_PROFILES) {
    await applyViewportProfile(page, cdp, profile);
    const action = page.getByRole("button", { name: "检查本章" });
    await action.scrollIntoViewIfNeeded();
    await expectMinimumTarget(action);
    await expectNoHorizontalPageOverflow(page);
    await captureVisualEvidence(page, {
      name: `${surface}-checks-page-${profile.id}`,
      state: "静态 Chromium 的现有检查页；原生一致性调查 Agent 未运行且未伪造",
      surfaceSelector: "html",
      viewportProfile: profile,
      captureSession: cdp,
    });
  }
}

async function applyViewportProfile(
  page: Page,
  cdp: CDPSession,
  profile: VisualViewportProfile,
): Promise<void> {
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  if (profile.kind === "equivalent_200_percent") {
    const physical = profile.emulatedPhysicalViewport;
    if (physical === null) throw new Error("Equivalent 200% profile requires a physical viewport.");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: profile.expectedCssViewport.width,
      height: profile.expectedCssViewport.height,
      screenWidth: physical.width,
      screenHeight: physical.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } else {
    await page.setViewportSize(profile.expectedCssViewport);
  }
  await expect
    .poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
    .toEqual(profile.expectedCssViewport);
}

function viewportProfile(id: string, width: number, height: number): VisualViewportProfile {
  return {
    id,
    kind: "css_viewport",
    expectedCssViewport: { width, height },
    emulatedPhysicalViewport: null,
  };
}

function projectIdFromEditorUrl(editorUrl: string): string {
  const match = /#\/projects\/([^/]+)\/chapters\//u.exec(editorUrl);
  if (match?.[1] === undefined) throw new Error(`Could not read a project id from ${editorUrl}`);
  return match[1];
}

async function expectMinimumTarget(locator: Locator, minimum = 44): Promise<void> {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function expectInViewport(locator: Locator, page: Page): Promise<void> {
  const [bounds, viewport] = await Promise.all([
    locator.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    mainClientWidth: document.querySelector("main")?.clientWidth ?? 0,
    mainScrollWidth: document.querySelector("main")?.scrollWidth ?? 0,
  }));
  expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.documentClientWidth + 1);
  expect(dimensions.mainScrollWidth).toBeLessThanOrEqual(dimensions.mainClientWidth + 1);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const dimensions = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}
