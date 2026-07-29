import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudClientError } from "@inkshadow/cloud-client";
import { CONTRACT_SCHEMA_VERSION, type CloudAiUsageSummaryResponse } from "@inkshadow/contracts";

import type { CloudAiUsageRuntimePort } from "../infrastructure/cloud-ai-usage-service";
import type { DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { StudioUsagePage } from "./studio-usage-page";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const RESERVATION_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const EVENT_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const NOW = "2026-07-28T08:00:00.000Z";

afterEach(() => {
  setOnline(true);
});

describe("StudioUsagePage", () => {
  it("shows warnings, reclaimed leases, price metadata and saves real team/project budget revisions", async () => {
    setOnline(true);
    const user = userEvent.setup();
    const service = createService();
    renderPage(service, `/teams/${TEAM_ID}/usage?projectId=${PROJECT_ID}`);

    expect((await screen.findAllByText("已达到 80% 预警线")).length).toBeGreaterThan(0);
    expect(screen.getByText("已回收过期并发占位")).toBeInTheDocument();
    expect(screen.getAllByText("aud-2026-07").length).toBeGreaterThan(0);
    expect(screen.getByText("最近用量账本")).toBeInTheDocument();
    expect(
      screen.getByText("本次读取回收了 1 个过期租约，额度已归还到其创建月份。"),
    ).toBeInTheDocument();
    expect(screen.getByText(/InkShadow 内部的 token 与价格元数据额度账本/u)).toBeInTheDocument();
    expect(
      screen.getByText("实际收费以模型供应商账单为准；当前版本尚未实现供应商侧权威账单对账。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("内部额度按预约时锁定的服务端价格快照计算，不代表供应商最终账单。"),
    ).toBeInTheDocument();

    const monthly = screen.getByLabelText(/^月度额度（币种单位）/u);
    await user.clear(monthly);
    await user.type(monthly, "120");
    await user.click(screen.getByRole("button", { name: "保存团队预算" }));
    await waitFor(() => {
      expect(service.updateTeamBudget).toHaveBeenCalledWith(
        TEAM_ID,
        expect.objectContaining({
          expectedRevision: 1,
          monthlyLimitMicrounits: 120_000_000,
          maximumConcurrentRuns: 5,
        }),
      );
    });

    const projectConcurrency = screen.getByLabelText(/^项目最大并发（可留空）/u);
    await user.clear(projectConcurrency);
    await user.type(projectConcurrency, "1");
    await user.click(screen.getByRole("button", { name: "保存项目覆盖" }));
    await waitFor(() => {
      expect(service.updateProjectBudget).toHaveBeenCalledWith(
        TEAM_ID,
        PROJECT_ID,
        expect.objectContaining({
          expectedRevision: 1,
          maximumConcurrentRuns: 1,
        }),
      );
    });
    expect(screen.getByText(/不接收正文、提示词/u)).toBeInTheDocument();
  });

  it("renders capability-controlled budget scopes as read-only without dead save actions", async () => {
    setOnline(true);
    const service = createService({
      getSummary: vi.fn().mockResolvedValue({
        ...SUMMARY,
        capabilities: {
          manageTeamBudget: false,
          manageProjectBudget: false,
          consume: true,
        },
      }),
    });
    renderPage(service, `/teams/${TEAM_ID}/usage?projectId=${PROJECT_ID}`);

    expect(await screen.findByText("团队预算为只读")).toBeInTheDocument();
    expect(screen.getByText("项目预算为只读")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存团队预算" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存项目覆盖" })).not.toBeInTheDocument();
    expect(service.updateTeamBudget).not.toHaveBeenCalled();
    expect(service.updateProjectBudget).not.toHaveBeenCalled();
  });

  it("fails closed while offline and explicitly keeps local editing available", () => {
    setOnline(false);
    const service = createService();
    renderPage(service, `/teams/${TEAM_ID}/usage`);

    expect(screen.getByText("离线时无法读取云端用量")).toBeInTheDocument();
    expect(screen.getByText(/本地正文和现有草稿仍可继续编辑/u)).toBeInTheDocument();
    expect(service.getSummary).not.toHaveBeenCalled();
  });

  it("shows a feature-limited state when no native cloud usage runtime exists", () => {
    setOnline(true);
    renderPage(null, `/teams/${TEAM_ID}/usage`);

    expect(screen.getByText("AI 用量云服务未配置")).toBeInTheDocument();
    expect(screen.getByText(/预算操作保持关闭/u)).toBeInTheDocument();
  });

  it("maps server authorization denial to a forbidden state", async () => {
    setOnline(true);
    const service = createService({
      getSummary: vi.fn().mockRejectedValue(
        new CloudClientError({
          code: "ACCESS_FORBIDDEN",
          message: "The current role cannot read billing metadata.",
          status: 403,
          requestId: REQUEST_ID,
          retryable: false,
        }),
      ),
    });
    renderPage(service, `/teams/${TEAM_ID}/usage?projectId=${PROJECT_ID}`);

    expect(await screen.findByText("无权查看此用量范围")).toBeInTheDocument();
    expect(screen.getByText(/本地正文和离线编辑不受影响/u)).toBeInTheDocument();
  });
});

function renderPage(service: CloudAiUsageRuntimePort | null, initialEntry: string) {
  const runtime = { cloudAiUsage: service } as unknown as DesktopRuntime;
  return render(
    <RuntimeProvider runtime={runtime}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/teams/:teamId/usage" element={<StudioUsagePage />} />
        </Routes>
      </MemoryRouter>
    </RuntimeProvider>,
  );
}

function createService(overrides: Partial<CloudAiUsageRuntimePort> = {}) {
  const teamBudget = SUMMARY.teamBudget;
  const projectBudget = SUMMARY.projectBudget;
  if (teamBudget === null) {
    throw new Error("expected team budget fixture");
  }
  if (projectBudget === null) {
    throw new Error("expected project budget fixture");
  }

  return {
    getSummary: vi.fn<CloudAiUsageRuntimePort["getSummary"]>(() => Promise.resolve(SUMMARY)),
    listEvents: vi.fn<CloudAiUsageRuntimePort["listEvents"]>(() =>
      Promise.resolve({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        tenantId: TENANT_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        events: [
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            eventId: EVENT_ID,
            tenantId: TENANT_ID,
            teamId: TEAM_ID,
            projectId: PROJECT_ID,
            membershipId: MEMBERSHIP_ID,
            reservationId: RESERVATION_ID,
            requestId: REQUEST_ID,
            eventType: "lease_expired",
            purpose: "content_generation",
            inputTokens: 500,
            outputTokens: 100,
            costMicrounits: 700,
            currency: "AUD",
            priceVersion: "aud-2026-07",
            modelIdentifier: "openai/gpt-5",
            createdAt: NOW,
          },
        ],
        nextCursor: null,
      }),
    ),
    updateTeamBudget: vi.fn<CloudAiUsageRuntimePort["updateTeamBudget"]>(() =>
      Promise.resolve({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        budget: teamBudget,
      }),
    ),
    updateProjectBudget: vi.fn<CloudAiUsageRuntimePort["updateProjectBudget"]>(() =>
      Promise.resolve({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        budget: projectBudget,
      }),
    ),
    reserve: vi.fn<CloudAiUsageRuntimePort["reserve"]>(),
    settle: vi.fn<CloudAiUsageRuntimePort["settle"]>(),
    cancel: vi.fn<CloudAiUsageRuntimePort["cancel"]>(),
    ...overrides,
  } satisfies CloudAiUsageRuntimePort;
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value,
  });
}

const SUMMARY: CloudAiUsageSummaryResponse = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  requestId: REQUEST_ID,
  tenantId: TENANT_ID,
  teamId: TEAM_ID,
  periodStart: "2026-07-01",
  currency: "AUD",
  priceVersion: "aud-2026-07",
  teamBudget: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    currency: "AUD",
    monthlyLimitMicrounits: 100_000_000,
    warningThresholdBasisPoints: 8_000,
    hardCap: true,
    priceVersion: "aud-2026-07",
    inputMicrounitsPerMillionTokens: 1_000_000,
    outputMicrounitsPerMillionTokens: 2_000_000,
    maximumConcurrentRuns: 5,
    revision: 1,
    updatedByMembershipId: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  projectBudget: {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    monthlyLimitMicrounits: 90_000_000,
    maximumConcurrentRuns: 2,
    revision: 1,
    updatedByMembershipId: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
  },
  team: bucket("team", null, 100_000_000),
  project: bucket("project", PROJECT_ID, 90_000_000),
  leaseExpiredCount: 1,
  activeLeaseCount: 2,
  maximumConcurrentRuns: 5,
  activeProjectLeaseCount: 1,
  projectMaximumConcurrentRuns: 2,
  effectiveMaximumConcurrentRuns: 2,
  concurrencyHardCapReached: false,
  capabilities: {
    manageTeamBudget: true,
    manageProjectBudget: true,
    consume: true,
  },
  serverTime: NOW,
};

function bucket(
  scope: "team" | "project",
  projectId: string | null,
  monthlyLimitMicrounits: number,
) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scope,
    projectId,
    monthlyLimitMicrounits,
    settledMicrounits: 70_000_000,
    reservedMicrounits: 10_000_000,
    remainingMicrounits: monthlyLimitMicrounits - 80_000_000,
    settledInputTokens: 1_000,
    settledOutputTokens: 500,
    reservedInputTokens: 100,
    reservedOutputTokens: 50,
    status: "warning" as const,
    updatedAt: NOW,
  };
}
