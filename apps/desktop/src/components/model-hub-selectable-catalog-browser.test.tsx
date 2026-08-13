import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  projectSelectableModelCatalog,
  type SelectableModelCatalogPublicEntry,
} from "../infrastructure/selectable-model-catalog-registry";
import {
  ModelHubSelectableCatalogBrowser,
  type ModelHubSelectableCatalogConnectedModel,
  type ModelHubSelectableCatalogSelection,
} from "./model-hub-selectable-catalog-browser";

const CURRENT = "2026-08-13T12:00:00.000Z";

describe("ModelHubSelectableCatalogBrowser", () => {
  it("groups ordinary choices by region, keeps connected rows first, and de-duplicates them", () => {
    const candidates = officialCandidates("deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.6-sol");
    render(
      <ModelHubSelectableCatalogBrowser
        defaultExpanded
        connectedModels={[
          connectedModel({
            catalogEntryId: "local-qwen",
            providerKind: "ollama",
            providerModelId: "qwen-local:14b",
            displayName: "Qwen Local 14B",
            regionGroup: "LOCAL",
            lifecycle: "not_provided",
            appSupport: "verified_in_app",
          }),
          connectedModel({
            catalogEntryId: "deepseek-flash",
            providerKind: "deepseek",
            providerModelId: "deepseek-v4-flash",
            displayName: "DeepSeek V4 Flash（账户可用）",
            regionGroup: "DOMESTIC",
            lifecycle: "stable",
          }),
        ]}
        officialCandidates={candidates}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getAllByRole("heading", { level: 4 }).map(({ textContent }) => textContent),
    ).toEqual(["国内", "海外", "本地"]);
    const domestic = screen.getByRole("region", { name: "国内" });
    const domesticButtons = within(domestic).getAllByRole("button");
    expect(domesticButtons[0]).toHaveAccessibleName(/DeepSeek V4 Flash（账户可用）/u);
    expect(domesticButtons[1]).toHaveAccessibleName(/DeepSeek V4 Pro/u);
    expect(
      within(domestic).queryByText("DeepSeek V4 Flash", { exact: true }),
    ).not.toBeInTheDocument();

    expect(screen.getByText("Ollama · 本地")).toBeInTheDocument();
    expect(screen.getByText("已通过应用验证")).toBeInTheDocument();
    expect(screen.getByText("生命周期未提供")).toBeInTheDocument();
    expect(screen.getByText("OpenAI · 海外")).toBeInTheDocument();
    expect(screen.getByText("共 4 个结果，其中 2 个已连接")).toBeInTheDocument();
  });

  it("searches model names, providers, raw tags, and ordinary tag labels", async () => {
    const user = userEvent.setup();
    render(
      <ModelHubSelectableCatalogBrowser
        defaultExpanded
        connectedModels={[
          connectedModel({
            catalogEntryId: "local-writer",
            providerKind: "ollama",
            providerModelId: "writer-local",
            displayName: "本地写作模型",
            regionGroup: "LOCAL",
            tags: ["text_generation"],
          }),
        ]}
        officialCandidates={officialCandidates("gpt-5.6-sol", "gemini-embedding-2", "gpt-image-2")}
        onSelect={vi.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "搜索模型、供应商或用途" });

    await user.type(search, "gpt-5.6-sol");
    expect(screen.getByRole("button", { name: /GPT-5.6 Sol/u })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gemini Embedding 2/u })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "google gemini");
    expect(screen.getByRole("button", { name: /Gemini Embedding 2/u })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /GPT-5.6 Sol/u })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "embedding");
    expect(screen.getByRole("button", { name: /Gemini Embedding 2/u })).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "图像生成");
    expect(screen.getByRole("button", { name: /GPT Image 2/u })).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "不存在的模型");
    expect(screen.getByText("没有匹配的模型，请尝试其他名称或用途。")).toBeInTheDocument();
    expect(screen.getByText("共 0 个结果，其中 0 个已连接")).toBeInTheDocument();
  });

  it("uses native keyboard controls and reports the exact selected source", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(selection: ModelHubSelectableCatalogSelection) => void>();
    const connected = connectedModel({
      catalogEntryId: "keyboard-connected",
      providerKind: "deepseek",
      providerModelId: "keyboard-writer",
      displayName: "Keyboard Writer",
      regionGroup: "DOMESTIC",
    });
    render(
      <ModelHubSelectableCatalogBrowser
        connectedModels={[connected]}
        officialCandidates={officialCandidates("gpt-5.6-sol")}
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    await user.tab();
    const disclosure = screen.getByText("浏览全部可选模型").closest("summary");
    expect(disclosure).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    await user.tab();
    const firstChoice = screen.getByRole("button", { name: /Keyboard Writer/u });
    expect(firstChoice).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenNthCalledWith(1, { source: "connected", model: connected });

    await user.tab();
    const secondChoice = screen.getByRole("button", { name: /GPT-5.6 Sol/u });
    expect(secondChoice).toHaveFocus();
    await user.keyboard(" ");
    const expectedOfficial = officialCandidates("gpt-5.6-sol")[0];
    expect(onSelect).toHaveBeenNthCalledWith(2, {
      source: "official_candidate",
      model: expectedOfficial,
    });
  });

  it("never renders expert source, TTL, URL, or unrelated internal fields", () => {
    const expert = projectSelectableModelCatalog(CURRENT, { expert: true }).find(
      ({ modelId }) => modelId === "gpt-5.6-sol",
    );
    if (expert === undefined) throw new Error("Missing fixture model");
    const candidateWithExtraInternalData = {
      ...expert,
      internalScore: 9_999,
      internalRankingReason: "secret ranking",
    } as SelectableModelCatalogPublicEntry;

    const { container } = render(
      <ModelHubSelectableCatalogBrowser
        defaultExpanded
        connectedModels={[]}
        officialCandidates={[candidateWithExtraInternalData]}
        onSelect={vi.fn()}
      />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain(expert.officialSource.url);
    expect(container.textContent).not.toContain(expert.officialSource.expiresAt);
    expect(container.textContent).not.toContain(expert.officialSource.updatedAt);
    expect(container.textContent).not.toContain("secret ranking");
    expect(container.textContent).not.toContain("9999");
  });
});

function connectedModel(
  overrides: Partial<ModelHubSelectableCatalogConnectedModel> = {},
): ModelHubSelectableCatalogConnectedModel {
  return {
    catalogEntryId: "connected-model",
    providerKind: "ollama",
    providerModelId: "local-model",
    displayName: "Local Model",
    regionGroup: "LOCAL",
    tags: [],
    lifecycle: "not_provided",
    appSupport: "verification_required",
    ...overrides,
  };
}

function officialCandidates(
  ...modelIds: readonly string[]
): readonly SelectableModelCatalogPublicEntry[] {
  const requested = new Set(modelIds);
  const found = projectSelectableModelCatalog(CURRENT).filter(({ modelId }) =>
    modelId === null ? false : requested.has(modelId),
  );
  if (found.length !== requested.size) {
    throw new Error(`Missing official fixture: ${modelIds.join(", ")}`);
  }
  return found;
}
