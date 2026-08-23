import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("ordinary UI language contract", () => {
  it("uses natural Chinese for selected story materials and unavailable pricing", () => {
    const continuation = readFileSync(
      path.join(process.cwd(), "src/infrastructure/continuation-generation-disclosure.ts"),
      "utf8",
    );
    const rewrite = readFileSync(
      path.join(process.cwd(), "src/infrastructure/selection-rewrite-service.ts"),
      "utf8",
    );
    const editor = readFileSync(path.join(process.cwd(), "src/pages/editor-page.tsx"), "utf8");

    expect(continuation).toContain("本次挑选的故事资料");
    expect(rewrite).toContain("本次挑选的故事资料");
    expect(continuation).not.toContain("上下文编译明确列出的必要故事资料");
    expect(rewrite).not.toContain("本次上下文编译明确选中的");
    expect(editor).toContain("服务商未提供费用信息");
    expect(editor).not.toContain("金额标记为 pricing_unavailable");
    expect(editor).not.toContain("金额标记为\n                  pricing_unavailable");
    expect(editor).toMatch(/>\s*缩写\s*<\/Button>/u);
    expect(editor).toContain("在不改变事实、原意和叙事视角的前提下，缩写选中内容");
  });
  it("uses natural Chinese capacity units in ordinary pages", () => {
    const ordinarySources = [
      "src/components/data-transfer-panel.tsx",
      "src/components/story-settings-tools.tsx",
      "src/infrastructure/browser-pdf-page-rasterizer.ts",
      "src/infrastructure/export-artifact-download.ts",
      "src/pages/fine-tuning-governance-page.tsx",
      "src/pages/secure-update-card.tsx",
      "src/pages/settings-page.tsx",
    ].map((file) => readFileSync(path.join(process.cwd(), file), "utf8"));
    const combined = ordinarySources.join("\n");

    expect(combined).not.toMatch(/\b(?:KB|MB|KiB|MiB|GiB)\b/u);
    expect(combined).toContain("5 兆字节");
    expect(combined).toContain("50 兆字节");
    expect(combined).toContain("64 兆字节");
  });
});
