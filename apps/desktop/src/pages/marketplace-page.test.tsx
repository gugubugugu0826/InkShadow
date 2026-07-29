import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import type {
  InstalledMarketplaceArtifact,
  MarketplaceRuntime,
  MarketplaceRuntimeSnapshot,
} from "../infrastructure/marketplace-runtime.js";
import { MarketplacePage } from "./marketplace-page.js";

const ARTIFACT_ID = "0198b666-0000-7000-8000-000000000001";
const VERSION_ID = "0198b666-0000-7000-8000-000000000002";
const ACCOUNT_ID = "0198b666-0000-7000-8000-000000000003";
const NOW = "2026-07-29T07:00:00.000Z";

describe("MarketplacePage", () => {
  it("explains the default-off state while keeping installed copies visible", async () => {
    const installed = installedFixture();
    const fake = fakeRuntime({
      catalog: [],
      installed: [installed],
      remoteState: "disabled",
      remoteError: null,
    });
    render(<MarketplacePage runtime={fake.runtime} />);
    expect(await screen.findByText(/社区市场当前未启用。不会连接市场服务/)).toBeInTheDocument();
    expect(screen.getByText("The Vanished City")).toBeInTheDocument();
    expect(screen.getByText(/市场关闭、离线或源模板下架时仍可使用/)).toBeInTheDocument();
    expect(fake.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("supports search, category metadata and verified-install actions", async () => {
    const artifact = installedFixture().artifact;
    let installed: readonly InstalledMarketplaceArtifact[] = [];
    const initial: MarketplaceRuntimeSnapshot = {
      catalog: [artifact],
      installed,
      remoteState: "ready",
      remoteError: null,
    };
    const fake = fakeRuntime(initial);
    fake.install.mockImplementation(() => {
      const value = installedFixture();
      installed = [value];
      return Promise.resolve(value);
    });
    fake.snapshot.mockImplementation(() => Promise.resolve({ ...initial, installed }));
    const report = vi.fn();
    render(<MarketplacePage runtime={fake.runtime} onReportRequested={report} />);

    expect(await screen.findByRole("heading", { name: "The Vanished City" })).toBeInTheDocument();
    expect(screen.getByText("CC BY 4.0")).toBeInTheDocument();
    expect(screen.getByText("Ink Cartographer")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "搜索" }), "not present");
    expect(screen.getByText("没有符合当前筛选条件的模板。")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "搜索" }));
    await user.click(screen.getByRole("button", { name: "安装" }));
    expect(fake.install).toHaveBeenCalledWith(ARTIFACT_ID, VERSION_ID);
    expect(await screen.findByText(/本地副本；市场关闭/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "举报" }));
    expect(report).toHaveBeenCalledWith(artifact);
  });

  it("shows an offline boundary without hiding installed work", async () => {
    const fake = fakeRuntime({
      catalog: [],
      installed: [installedFixture()],
      remoteState: "offline",
      remoteError: null,
    });
    render(<MarketplacePage runtime={fake.runtime} />);
    expect(await screen.findByText(/当前离线。在线目录和新安装暂不可用/)).toBeInTheDocument();
    expect(screen.getByText("The Vanished City")).toBeInTheDocument();
  });
});

function fakeRuntime(initialSnapshot: MarketplaceRuntimeSnapshot) {
  const refreshCatalog = vi.fn<MarketplaceRuntime["refreshCatalog"]>(() =>
    Promise.resolve(initialSnapshot),
  );
  const snapshot = vi.fn<MarketplaceRuntime["snapshot"]>(() => Promise.resolve(initialSnapshot));
  const install = vi.fn<MarketplaceRuntime["install"]>(() =>
    Promise.reject(new Error("Unexpected marketplace install.")),
  );
  const uninstall = vi.fn<MarketplaceRuntime["uninstall"]>(() => Promise.resolve());
  const runtime = {
    refreshCatalog,
    snapshot,
    install,
    uninstall,
  } as unknown as MarketplaceRuntime;
  return { install, refreshCatalog, runtime, snapshot, uninstall };
}

function installedFixture(): InstalledMarketplaceArtifact {
  const artifact = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    authorAccountId: ACCOUNT_ID,
    authorDisplayName: "Ink Cartographer",
    kind: "story_template" as const,
    title: "The Vanished City",
    summary: "A structured story seed for mystery adventures.",
    tags: ["adventure", "mystery"],
    license: "cc-by-4.0" as const,
    state: "published" as const,
    revision: 2,
    latestVersionNumber: 1,
    pendingVersionId: null,
    publishedVersionId: VERSION_ID,
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
    quarantinedAt: null,
    withdrawnAt: null,
    retentionUntil: null,
  };
  const version = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    semanticVersion: "1.0.0",
    state: "published" as const,
    contentDigestSha256: "a".repeat(64),
    authorSigningKeyFingerprintSha256: "b".repeat(64),
    contentBytes: 256,
    createdAt: NOW,
    submittedAt: NOW,
    reviewedAt: NOW,
    publishedAt: NOW,
    quarantinedAt: null,
    withdrawnAt: null,
    retentionUntil: null,
  };
  return {
    artifact,
    authorPublicKeySpki: "A".repeat(60),
    authorSignature: "B".repeat(86),
    content: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      format: "inkshadow.marketplace.structured-artifact.v1",
      sections: [
        {
          sectionId: "story_seed",
          title: "Story seed",
          items: [
            {
              itemId: "premise",
              kind: "text",
              label: "Premise",
              value: "A cartographer discovers a city erased from every map.",
            },
          ],
        },
      ],
    },
    contentDigestSha256: version.contentDigestSha256,
    installedAt: NOW,
    version,
  };
}
