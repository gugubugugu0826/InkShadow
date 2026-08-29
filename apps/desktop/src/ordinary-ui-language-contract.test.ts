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
    expect(editor).toContain("服务商没有提供可计算的单价，实际费用请以服务商账单为准。");
    expect(editor).not.toContain("内容额度");
    expect(editor).not.toContain("金额标记为 pricing_unavailable");
    expect(editor).not.toContain("金额标记为\n                  pricing_unavailable");
    expect(editor).toMatch(
      /action: "shorten" as const,\s*label: "缩写",\s*instruction:\s*"在不改变事实、原意和叙事视角的前提下，缩写选中内容/u,
    );
    expect(editor).toMatch(
      /selectionWritingActions\.map\(\(action\) => \([\s\S]*?<Button[\s\S]*?>\s*\{action\.label\}\s*<\/Button>/u,
    );
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
  it("keeps implementation terminology out of ordinary model and creation flows", () => {
    const quickCreationSources = [
      "src/components/quick-ai-connection-drawer.tsx",
      "src/infrastructure/quick-model-connection-service.ts",
    ].map((file) => readFileSync(path.join(process.cwd(), file), "utf8"));
    const ordinarySources = [
      "src/components/consistency-investigation-panel.tsx",
      "src/components/causal-fact-authoring-panel.tsx",
      "src/components/command-palette.tsx",
      "src/components/data-transfer-panel.tsx",
      "src/components/generation-progress-panel.tsx",
      "src/components/model-hub-selectable-catalog-browser.tsx",
      "src/components/quick-ai-connection-drawer.tsx",
      "src/components/story-planning-panel.tsx",
      "src/components/writing-preferences-panel.tsx",
      "src/infrastructure/consistency-investigation-service.ts",
      "src/infrastructure/creative-opening-service.ts",
      "src/infrastructure/model-hub-provider-registry.ts",
      "src/infrastructure/model-hub-readiness.ts",
      "src/infrastructure/model-hub-task-capability-probe-disclosure.ts",
      "src/infrastructure/model-hub-task-recommendation.ts",
      "src/infrastructure/quick-model-connection-service.ts",
      "src/infrastructure/ui-error.ts",
      "src/pages/editor-page.tsx",
      "src/pages/fine-tuning-governance-page.tsx",
      "src/pages/idea-journey-page.tsx",
      "src/pages/project-checks-page.tsx",
      "src/pages/settings-page.tsx",
      "src/pages/story-governance-page.tsx",
      "src/pages/task-center-page.tsx",
      "src/pages/usage-center-page.tsx",
    ].map((file) => readFileSync(path.join(process.cwd(), file), "utf8"));
    const combined = ordinarySources.join("\n");

    expect(quickCreationSources.join("\n")).not.toContain("模型目录");

    expect(combined).not.toMatch(
      /Endpoint ID|Workspace ID|Base URL|认证 Header|Header 值|固定能力验证|固定探针|发送边界|AI 连接与分工|当前分工|自定义分工|旧版兼容分工|自动分工|任务路由事务|JSON 探针|翻译探针|原因码|整理上下文|构建向量索引|候选正文|可编辑候选|待导入候选|剧情规划分工|安全预检|发送前预检/u,
    );
    expect(combined).not.toMatch(
      /结果需要核对|支持编号|方法预算单位|内容额度|精确原文位置|不可变版本|审计事件|基础配置完整|查看故事方向发送信息|拆解章节场景|比较 AI 建议|候选调用|调用预留/u,
    );
    expect(combined).not.toMatch(/\bPOV\b/u);
    expect(combined).toContain("私密章节只在本机处理。没有可用的本地 AI 时，本次生成不会开始。");
  });
});
